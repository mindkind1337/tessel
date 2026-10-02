<script setup>
// Left sidebar: the workspaces, then "Sessions": every pane of the current one
// with its state, grouped by team. A workspace is a project: its folder, its
// panes and agents. The sidebar only renders and emits intents: App owns the state.
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import BrandIcon from './BrandIcon.vue'

const props = defineProps({
  // [{ id, name, paneCount, agents: [agentId...], members: [{ id, num, title,
  //   agentId, accent, state, reset, held, active }], busy, needsYou, folder, cwd }]
  items: { type: Array, required: true },
  currentId: { type: String, default: null },
  collapsed: { type: Boolean, default: false },
  width: { type: Number, default: 216 },
  // Every pane of the current workspace, for "Sessions": [{ id, num, title,
  //   kind, agentId, shellId, accent, state, reset, held, active }]
  sessions: { type: Array, default: () => [] },
  // Teams (groups of agents): [{ id, name, color }]; a session's `team` is an id.
  teams: { type: Array, default: () => [] }
})

const emit = defineEmits([
  'focus-pane',
  'message-ws',
  'notes-ws',
  'create-team',
  'new-task',
  'add-to-team',
  'rename-team',
  'disband-team',
  'set-lead',
  'message-team',
  'activity',
  'folder',
  'select',
  'create',
  'rename',
  'remove',
  'toggle',
  'resize',
  'resize-end'
])

// --- Drag the right edge to resize -------------------------------------------
const MIN_WIDTH = 160
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 216
const COLLAPSE_BELOW = 110 // dragging this far left collapses the sidebar
const navEl = ref(null)
const resizing = ref(false)

// Double-click detection lives here: preventDefault on pointerdown (needed so a
// drag doesn't select text) suppresses the browser's own dblclick event.
let lastDown = 0

function startResize(e) {
  if (e.button !== 0) return
  e.preventDefault()
  const now = Date.now()
  if (now - lastDown < 400) {
    lastDown = 0
    resetWidth()
    return
  }
  lastDown = now
  const left = navEl.value ? navEl.value.getBoundingClientRect().left : 0
  resizing.value = true
  document.body.classList.add('ws-resizing')
  let wantsCollapse = false
  const startWidth = props.width

  const move = (ev) => {
    const raw = ev.clientX - left
    if (props.collapsed) {
      // Dragging out of the collapsed rail re-expands it.
      if (raw > COLLAPSE_BELOW) emit('toggle')
      return
    }
    wantsCollapse = raw < COLLAPSE_BELOW
    const w = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw)))
    emit('resize', w)
  }
  const up = () => {
    resizing.value = false
    document.body.classList.remove('ws-resizing')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (wantsCollapse && !props.collapsed) {
      // Collapse, but remember the width it had before this drag.
      emit('resize', startWidth)
      emit('toggle')
    }
    emit('resize-end')
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function resetWidth() {
  if (props.collapsed) emit('toggle')
  emit('resize', DEFAULT_WIDTH)
  emit('resize-end')
}

const editingId = ref(null)
const draft = ref('')
const inputEls = {}

function startRename(item) {
  editingId.value = item.id
  draft.value = item.name
  nextTick(() => {
    const el = inputEls[item.id]
    if (el) el.select()
  })
}

function commitRename() {
  if (!editingId.value) return
  const name = draft.value.trim()
  if (name) emit('rename', editingId.value, name)
  editingId.value = null
}

function cancelRename() {
  editingId.value = null
}

function initials(name) {
  const words = (name || '?').trim().split(/\s+/)
  const s = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)
  return s.toUpperCase()
}

// Distinct agent kinds in a workspace, for the little logo row.
function uniqueAgents(list) {
  return [...new Set(list)].slice(0, 4)
}

const STATE_TEXT = {
  approval: 'Asks your approval',
  limited: 'Usage limit',
  working: 'Working',
  waiting: 'Done, waiting for you',
  ready: 'Ready'
}

function stateText(m) {
  if (m.kind && m.kind !== 'agent') return 'Terminal'
  if (m.review && m.leadReview === 'pending') return `Lead reviewing: ${m.task}`
  if (m.review && m.leadReview === 'approved') return `Approved by lead: ${m.task}`
  if (m.review) return `Ready for review: ${m.task}`
  if (m.typingHold) return 'Message waits until you send your text'
  if (m.held) return 'Message waits for your approval'
  if (m.track) return m.track.text
  if (m.state === 'limited' && m.reset) return `Usage limit · ${m.reset}`
  return STATE_TEXT[m.state]
}


// --- One message to every agent of a workspace -------------------------------
const messagingId = ref(null)
const messageDraft = ref('')
const messageEls = {}

function startMessage(wsId) {
  messagingId.value = messagingId.value === wsId ? null : wsId
  messageDraft.value = ''
  nextTick(() => {
    const el = messageEls[wsId]
    if (el) el.focus()
  })
}

function sendMessage() {
  const text = messageDraft.value.trim()
  const target = messagingId.value || ''
  if (text && target.startsWith('team:')) emit('message-team', target.slice(5), text)
  else if (text) emit('message-ws', target, text)
  messagingId.value = null
  messageDraft.value = ''
}

// --- Teams in "Sessions" -----------------------------------------------------
// Rows in display order: each team (header, then its members), then the
// sessions in no team.
const rows = computed(() => {
  const out = []
  const inTeam = new Set()
  for (const t of props.teams) {
    const members = props.sessions.filter((x) => x.team === t.id)
    if (!members.length) continue
    out.push({ key: 'team:' + t.id, type: 'team', team: t, count: members.length })
    for (const m of members) {
      inTeam.add(m.id)
      out.push({ key: m.id, type: 'session', s: m, team: t })
    }
  }
  for (const x of props.sessions) {
    if (!inTeam.has(x.id)) out.push({ key: x.id, type: 'session', s: x, team: null })
  }
  return out
})

// Tick agents, then group them into a new team ('new') or add them to a
// team (its id). Only agents in no team can be ticked: moving one to another
// team goes through "Leave" first, so no team changes by surprise.
const picking = ref(false) // false | 'new' | team id
const picked = ref([])
const pickTeam = computed(() =>
  picking.value && picking.value !== 'new' ? props.teams.find((t) => t.id === picking.value) || null : null
)

function startPicking(target = 'new') {
  picking.value = picking.value === target ? false : target
  picked.value = []
}

function cancelPicking() {
  picking.value = false
  picked.value = []
}

function canPick(x) {
  return x.kind === 'agent' && !x.team
}

// The agents of a team (in this workspace), for its menu.
function teamAgents(id) {
  return props.sessions.filter((s) => s.kind === 'agent' && s.team === id)
}

function teamName(id) {
  return props.teams.find((t) => t.id === id)?.name || 'a team'
}

function togglePicked(id) {
  picked.value = picked.value.includes(id)
    ? picked.value.filter((x) => x !== id)
    : [...picked.value, id]
}

function groupPicked() {
  if (picked.value.length) {
    if (pickTeam.value) emit('add-to-team', pickTeam.value.id, picked.value.slice())
    else emit('create-team', picked.value.slice())
  }
  picking.value = false
  picked.value = []
}

function onSession(x) {
  if (picking.value) {
    if (canPick(x)) togglePicked(x.id)
  } else emit('focus-pane', x.id)
}

// --- "⋯" menus (Sessions header, team rows) -----------------------------------
const menu = ref(null) // { kind: 'sessions' | 'team', team?, x, y }
const menuEl = ref(null)

function openMenu(e, kind, team = null) {
  const r = e.currentTarget.getBoundingClientRect()
  const open = menu.value && menu.value.kind === kind && menu.value.team?.id === team?.id
  menu.value = open ? null : { kind, team, x: Math.max(8, r.right - 220), y: r.bottom + 4 }
  // Near the bottom of the window, open upwards instead (measured once drawn).
  if (!open) {
    nextTick(() => {
      const el = menuEl.value
      if (!el || !menu.value) return
      const h = el.getBoundingClientRect().height
      if (r.bottom + 4 + h > window.innerHeight - 8) {
        menu.value = { ...menu.value, y: Math.max(8, r.top - 4 - h) }
      }
    })
  }
}

function closeMenu() {
  menu.value = null
}

// Run a menu action with the menu's team (read before the menu closes).
function pick(fn) {
  const team = menu.value && menu.value.team
  closeMenu()
  fn(team)
}

function onDocDown(e) {
  if (menu.value && menuEl.value && !menuEl.value.contains(e.target)) closeMenu()
}

function onDocKey(e) {
  if (e.key === 'Escape' && menu.value) closeMenu()
}

onMounted(() => {
  window.addEventListener('pointerdown', onDocDown, true)
  window.addEventListener('keydown', onDocKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocDown, true)
  window.removeEventListener('keydown', onDocKey)
})

// Rename a team in place.
const editingTeam = ref(null)
const teamDraft = ref('')
const teamInputEls = {}

function startTeamRename(t) {
  editingTeam.value = t.id
  teamDraft.value = t.name
  nextTick(() => {
    const el = teamInputEls[t.id]
    if (el) el.select()
  })
}

function commitTeamRename() {
  if (!editingTeam.value) return
  const name = teamDraft.value.trim()
  if (name) emit('rename-team', editingTeam.value, name)
  editingTeam.value = null
}

defineExpose({
  startRename: (id) => {
    const item = props.items.find((i) => i.id === id)
    if (item) startRename(item)
  },
  startMessage: (wsId) => {
    if (messagingId.value !== wsId) startMessage(wsId)
  }
})
</script>

<template>
  <nav
    ref="navEl"
    class="ws-sidebar"
    :class="{ collapsed, resizing }"
    :style="collapsed ? null : { flexBasis: width + 'px' }"
    aria-label="Workspaces"
  >
    <div class="ws-head">
      <span v-if="!collapsed" class="ws-head-title">Workspaces</span>
      <button
        v-if="!collapsed"
        class="ws-icon-btn ws-head-new"
        title="New workspace (Ctrl+Shift+N)"
        aria-label="New workspace"
        @click="emit('create')"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="ws-icon-btn"
        :title="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="emit('toggle')"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect
            x="1.5"
            y="2.5"
            width="13"
            height="11"
            rx="2"
            stroke="currentColor"
            stroke-width="1.3"
          />
          <path d="M6 2.5v11" stroke="currentColor" stroke-width="1.3" />
          <path
            :d="collapsed ? 'M9 6.5l1.6 1.5L9 9.5' : 'M10.6 6.5L9 8l1.6 1.5'"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <div class="ws-list">
      <template v-for="item in items" :key="item.id">
        <div
          class="ws-item"
          :class="{ current: item.id === currentId }"
          :data-ws-id="item.id"
          :title="collapsed ? item.name : 'Double-click to rename'"
          role="button"
          tabindex="0"
          @click="emit('select', item.id)"
          @keydown.enter="emit('select', item.id)"
          @dblclick="!collapsed && startRename(item)"
        >
          <span class="ws-badge">
            {{ initials(item.name) }}
            <span
              v-if="item.needsYou"
              class="ws-busy attention"
              title="An agent is waiting for you"
            ></span>
            <span v-else-if="item.busy" class="ws-busy" title="An agent is working"></span>
          </span>

          <template v-if="!collapsed">
            <div class="ws-body">
              <input
                v-if="editingId === item.id"
                :ref="(el) => (inputEls[item.id] = el)"
                v-model="draft"
                class="ws-input"
                @click.stop
                @dblclick.stop
                @blur="commitRename"
                @keydown.enter.prevent.stop="commitRename"
                @keydown.escape.prevent.stop="cancelRename"
              />
              <span v-else class="ws-name">{{ item.name }}</span>
              <span class="ws-meta">
                <BrandIcon v-for="a in uniqueAgents(item.agents)" :key="a" :kind="a" :size="11" />
                <span>{{ item.paneCount }} {{ item.paneCount === 1 ? 'pane' : 'panes' }}</span>
              </span>
              <span v-if="item.folder" class="ws-folder" :title="item.cwd">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.6H13c.7 0 1.2.5 1.2 1.2v6.3c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.2z"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linejoin="round"
                  />
                </svg>
                {{ item.folder }}
              </span>
            </div>

            <div class="ws-actions">
              <button class="ws-icon-btn small" title="Rename" @click.stop="startRename(item)">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M10.5 2.5l3 3L6 13H3v-3l7.5-7.5z"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
              <button
                class="ws-icon-btn small"
                :title="
                  item.cwd
                    ? `Project folder: ${item.cwd} (click to change)`
                    : 'Set a project folder: new panes start there'
                "
                @click.stop="emit('folder', item.id)"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.6H13c.7 0 1.2.5 1.2 1.2v6.3c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.2z"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
              <button
                class="ws-icon-btn small danger"
                title="Delete workspace"
                @click.stop="emit('remove', item.id)"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </div>
          </template>
        </div>

      </template>
    </div>

    <button
      v-if="collapsed"
      class="ws-new"
      title="New workspace (Ctrl+Shift+N)"
      aria-label="New workspace"
      @click="emit('create')"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
    </button>

    <!-- The current workspace's panes: agents and shells, with their state. -->
    <section v-if="!collapsed && sessions.length" class="ws-sessions" aria-label="Sessions">
      <div class="ws-head">
        <span class="ws-head-title">Sessions</span>
        <span class="ws-sessions-count">{{ sessions.length }}</span>
        <button
          class="ws-icon-btn ws-head-new"
          :class="{ on: menu && menu.kind === 'sessions' }"
          title="Teams, messages, notes and activity"
          aria-label="Session actions"
          aria-haspopup="menu"
          @click="openMenu($event, 'sessions')"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.3" />
              <circle cx="8" cy="8" r="1.3" />
              <circle cx="12.5" cy="8" r="1.3" />
            </svg>
        </button>
      </div>
      <div v-if="messagingId === currentId" class="ws-message">
        <textarea
          :ref="(el) => (messageEls[currentId] = el)"
          v-model="messageDraft"
          rows="3"
          placeholder="Message every agent of this workspace… (Enter to send, Shift+Enter for a new line)"
          @keydown.enter.exact.prevent="sendMessage"
          @keydown.escape.prevent.stop="messagingId = null"
        ></textarea>
        <div class="ws-message-actions">
          <button class="ws-message-cancel" @click="messagingId = null">Cancel</button>
          <button class="ws-message-send" :disabled="!messageDraft.trim()" @click="sendMessage">
            Send
          </button>
        </div>
      </div>
      <template v-for="r in rows" :key="r.key">
        <div
          v-if="r.type === 'team'"
          class="ws-team-row"
          :style="{ '--team': r.team.color }"
        >
          <span class="ws-team-dot"></span>
          <input
            v-if="editingTeam === r.team.id"
            :ref="(el) => (teamInputEls[r.team.id] = el)"
            v-model="teamDraft"
            class="ws-input"
            maxlength="40"
            @blur="commitTeamRename"
            @keydown.enter.prevent.stop="commitTeamRename"
            @keydown.escape.prevent.stop="editingTeam = null"
          />
          <span
            v-else
            class="ws-team-name"
            title="Double-click to rename"
            @dblclick="startTeamRename(r.team)"
            >{{ r.team.name }}</span
          >
          <span class="ws-team-count">{{ r.count }}</span>
          <button
            class="ws-icon-btn small ws-row-more"
            :class="{ on: menu && menu.team && menu.team.id === r.team.id }"
            :title="`${r.team.name}: message, add agents, activity, rename, ungroup`"
            aria-label="Team actions"
            aria-haspopup="menu"
            @click="openMenu($event, 'team', r.team)"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.3" />
              <circle cx="8" cy="8" r="1.3" />
              <circle cx="12.5" cy="8" r="1.3" />
            </svg>
          </button>
        </div>
        <div v-if="r.type === 'team' && messagingId === 'team:' + r.team.id" class="ws-message">
          <textarea
            :ref="(el) => (messageEls['team:' + r.team.id] = el)"
            v-model="messageDraft"
            rows="3"
            :placeholder="`Message every agent of ${r.team.name}… (Enter to send, Shift+Enter for a new line)`"
            @keydown.enter.exact.prevent="sendMessage"
            @keydown.escape.prevent.stop="messagingId = null"
          ></textarea>
          <div class="ws-message-actions">
            <button class="ws-message-cancel" @click="messagingId = null">Cancel</button>
            <button class="ws-message-send" :disabled="!messageDraft.trim()" @click="sendMessage">
              Send
            </button>
          </div>
        </div>
        <button
          v-if="r.type === 'session'"
          class="ws-session"
          :class="[
            r.s.state,
            {
              active: r.s.active && !picking,
              'in-team': !!r.team,
              picked: picked.includes(r.s.id),
              unpickable: picking && !canPick(r.s)
            }
          ]"
          :style="r.team ? { '--team': r.team.color } : null"
          :title="
            !picking
              ? `Go to pane ${r.s.num || ''}`
              : r.s.kind !== 'agent'
                ? 'Terminals cannot be in a team'
                : r.s.team
                  ? `Already in ${teamName(r.s.team)}. To move it, use Leave in its ⋯ menu first.`
                  : 'Tick to put it in the team'
          "
          @click="onSession(r.s)"
        >
          <span v-if="picking" class="ws-pick-box" :class="{ on: picked.includes(r.s.id) }"></span>
          <BrandIcon
            :kind="r.s.kind === 'agent' ? r.s.agentId : r.s.shellId"
            :accent="r.s.kind === 'agent' ? r.s.accent : null"
            :label="r.s.kind === 'agent' ? r.s.title : null"
            :size="14"
          />
          <span class="ws-session-body">
            <span class="ws-session-name"
              >{{ r.s.title }}<span v-if="r.s.lead" class="ws-lead-tag" title="Leads the team">lead</span></span
            >
            <span class="ws-session-state" :class="r.s.track ? 'track-' + r.s.track.level : ''" :title="r.s.track ? r.s.track.reason : ''">{{
              picking && r.s.kind === 'agent' && r.s.team ? `In ${teamName(r.s.team)}` : stateText(r.s)
            }}</span>
            <span
              v-if="r.s.teamUnread && !picking"
              class="ws-team-unread"
              title="Team messages this agent has not read yet (it reads them with its team tools)"
              >{{ r.s.teamUnread }} team message{{ r.s.teamUnread > 1 ? 's' : '' }} waiting</span
            >
            <span v-if="r.s.kind === 'agent' && !picking" class="ws-session-task" :class="{ none: !r.s.task }">{{
              r.s.task ? (r.s.track && r.s.track.onTask ? `${r.s.task} · ${r.s.track.onTask}` : r.s.task) : 'No linked task'
            }}</span>
          </span>
          <span class="ws-session-num">{{ r.s.num }}</span>
        </button>
      </template>
      <div v-if="picking" class="ws-pick-bar">
        <span>{{
          picked.length
            ? `${picked.length} selected`
            : sessions.some(canPick)
              ? pickTeam
                ? `Tick the agents to add to ${pickTeam.name}`
                : 'Tick the agents that work together'
              : 'Every agent here is already in a team. Use Leave in an agent’s ⋯ menu to free it.'
        }}</span>
        <div class="ws-message-actions">
          <button class="ws-message-cancel" @click="cancelPicking">Cancel</button>
          <button class="ws-message-send" :disabled="!picked.length" @click="groupPicked">
            {{ pickTeam ? `Add to ${pickTeam.name}` : 'Group as a team' }}
          </button>
        </div>
      </div>
    </section>

    <Teleport to="body">
      <div
        v-if="menu"
        ref="menuEl"
        class="ctx-menu ws-menu"
        role="menu"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @pointerdown.stop
      >
        <template v-if="menu.kind === 'sessions'">
          <button class="ctx-menu-item" role="menuitem" @click="pick(() => emit('new-task'))">
            New task…
          </button>
          <button
            class="ctx-menu-item"
            role="menuitem"
            :disabled="!sessions.some(canPick)"
            @click="pick(() => startPicking('new'))"
          >
            New team…
          </button>
          <button
            class="ctx-menu-item"
            role="menuitem"
            :disabled="!sessions.some((x) => x.kind === 'agent')"
            @click="pick(() => startMessage(currentId))"
          >
            Message all agents…
          </button>
          <div class="ctx-menu-sep"></div>
          <button class="ctx-menu-item" role="menuitem" @click="pick(() => emit('notes-ws', currentId))">
            Project notes
          </button>
          <button class="ctx-menu-item" role="menuitem" @click="pick(() => emit('activity', 'workspace'))">
            Activity
          </button>
        </template>
        <template v-else-if="menu.kind === 'team'">
          <div class="ctx-menu-label">{{ menu.team.name }}</div>
          <button
            class="ctx-menu-item"
            role="menuitem"
            @click="pick((t) => startMessage('team:' + t.id))"
          >
            Message the team…
          </button>
          <button
            class="ctx-menu-item"
            role="menuitem"
            :disabled="!sessions.some(canPick)"
            @click="pick((t) => startPicking(t.id))"
          >
            Add agents…
          </button>
          <button
            class="ctx-menu-item"
            role="menuitem"
            @click="pick((t) => emit('activity', 'team:' + t.id))"
          >
            Activity
          </button>
          <div class="ctx-menu-sep"></div>
          <template v-for="m in teamAgents(menu.team.id)" :key="m.id">
            <button
              v-if="!m.lead"
              class="ctx-menu-item"
              role="menuitem"
              title="The lead gives tasks to the team and reviews them before you merge"
              @click="pick((t) => emit('set-lead', t.id, m.id))"
            >
              Make #{{ m.num }} {{ m.title }} lead
            </button>
          </template>
          <button
            v-if="teamAgents(menu.team.id).some((m) => m.lead)"
            class="ctx-menu-item"
            role="menuitem"
            @click="pick((t) => emit('set-lead', t.id, null))"
          >
            No lead
          </button>
          <div class="ctx-menu-sep"></div>
          <button class="ctx-menu-item" role="menuitem" @click="pick((t) => startTeamRename(t))">
            Rename
          </button>
          <button
            class="ctx-menu-item danger"
            role="menuitem"
            @click="pick((t) => emit('disband-team', t.id))"
          >
            Ungroup
          </button>
        </template>
      </div>
    </Teleport>

    <div
      class="ws-resize"
      title="Drag to resize. Double-click to reset."
      @pointerdown="startResize"
    ></div>
  </nav>
</template>
