<script setup>
// The right side panel (after Orca's): one panel, a tab bar at its top —
// Dashboard (every agent of every project), Files (the explorer), Changes
// (source control), Tasks (the task board), Agents (the agent session
// history). At the right end of the bar: + (a browser page, a terminal, a
// chat) and Fullscreen (the panel over the whole workspace; Esc restores it).
// A tab is created the first time it is shown, then kept (its folders,
// search and scroll stay as they were) while the panel is open.
import { reactive, ref, watch, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import ExplorerPanel from './ExplorerPanel.vue'
import { refreshStatus, statusOf, changeCount, rootKey } from '../scmState'
import ChangesPanel from './ChangesPanel.vue'
import TaskBoard from './TaskBoard.vue'
import SessionHistoryPanel from './SessionHistoryPanel.vue'
import AgentDashboard from './AgentDashboard.vue'
import AgentSessionHistoryIcon from './AgentSessionHistoryIcon.vue'
import RemoteBadge from './project/RemoteBadge.vue'
import { remoteHostsState } from '../remoteHosts'
import { t } from '../i18n'
import { Files, GitBranch, ListChecks, LayoutDashboard, Maximize2, Minimize2, Plus, Globe, SquareTerminal, MessageSquare } from 'lucide-vue-next'

const SIDE_TABS = ['dashboard', 'files', 'changes', 'tasks', 'history']

const props = defineProps({
  tab: { type: String, default: 'tasks' },
  root: { type: String, default: null },
  canInsert: { type: Boolean, default: false },
  agentPanes: { type: Array, default: () => [] },
  workspaceId: { type: String, default: null },
  // sessionId -> paneId: the past conversations open in a pane (Agents tab).
  openSessionIds: { type: Object, default: () => ({}) },
  // A project on a remote host: { hostId, host, path }. Its root is then an
  // ssh://… path: Files and Changes read it over SSH (src/main/remoteFs.js),
  // under a small badge naming the host.
  remote: { type: Object, default: null },
  // The Dashboard tab: App's sidebarProjects (every project, its panes) and
  // its clock (the "Working 4m" times).
  projects: { type: Array, default: () => [] },
  now: { type: Number, default: () => Date.now() },
  // The panel over the whole workspace (App keeps it, not saved).
  fullscreen: { type: Boolean, default: false }
})
const emit = defineEmits([
  'update:tab',
  'close',
  'open',
  'open-editor',
  'open-external',
  'terminal-here',
  'insert-path',
  'toast',
  'new-task',
  'focus-pane',
  'review',
  'open-diff',
  'create-pr',
  // A past conversation to reopen in a new pane: { agent, id, cwd, accountId }.
  'resume-session',
  // Dashboard: put these idle agents to sleep (App's sleepPanes).
  'sleep',
  'update:fullscreen',
  // The + menu: 'browser' | 'terminal' | 'chat'.
  'quick-add'
])

// Labels are translated where shown (the language can change while open).
// Icon tabs like Orca's top activity bar (right-sidebar-top-activity-bar.tsx,
// activity-bar-buttons.tsx): Files, Source Control (git branch), Tasks; the
// name is in the tooltip.
const TABS = [
  { id: 'dashboard', key: 'agentDashboard.tab', label: 'Dashboard', shortcut: '', icon: LayoutDashboard },
  { id: 'files', key: 'explorer.side.files', label: 'Files', shortcut: 'Ctrl+Shift+X', icon: Files },
  { id: 'changes', key: 'explorer.side.changes', label: 'Changes', shortcut: 'Ctrl+Shift+G', icon: GitBranch },
  { id: 'tasks', key: 'explorer.side.tasks', label: 'Tasks', shortcut: 'Ctrl+Shift+K', icon: ListChecks },
  { id: 'history', key: 'explorer.side.history', label: 'Agent Session History', shortcut: '', icon: AgentSessionHistoryIcon } // i18n-ignore
]
const tabLabel = (tab) => t(tab.key, tab.label)
const shown = reactive({})
watch(
  () => props.tab,
  (t) => {
    if (SIDE_TABS.includes(t)) shown[t] = true
  },
  { immediate: true }
)
const current = () => (SIDE_TABS.includes(props.tab) ? props.tab : 'tasks')

// The count on the Changes tab (like a source control badge): the project's
// changed files, read again as its files change.
const changes = computed(() => {
  const s = statusOf(props.root)
  return s && s.data ? changeCount(s.data) : 0
})
const badge = computed(() => (changes.value > 99 ? '99+' : String(changes.value)))
const explorer = () => window.shellApi && window.shellApi.explorer
let stop = null
let timer = 0
function reload() {
  if (props.root && window.shellApi && window.shellApi.scm) refreshStatus(props.root)
}
watch(
  () => props.root,
  (r) => {
    if (r && explorer()) explorer().watch(r)
    reload()
  }
)
// A remote project whose host was not connected (Files / Changes refused,
// the badge offers Connect): once it is (Connect, or a terminal signed in on
// the host), Files and Changes read it again from scratch.
const remoteRev = ref(0)
watch(
  () => !!(props.remote && remoteHostsState.needsConnect[props.remote.hostId]),
  (needs, before) => {
    if (before && !needs && props.remote) {
      remoteRev.value++
      reload()
    }
  }
)
onMounted(() => {
  if (props.root && explorer()) explorer().watch(props.root)
  reload()
  if (explorer() && explorer().onChanged)
    stop = explorer().onChanged((r) => {
      if (!props.root || rootKey(r) !== rootKey(props.root)) return
      clearTimeout(timer)
      timer = setTimeout(reload, 250)
    })
})
// --- Fullscreen and the + menu ---------------------------------------------
function setFullscreen(on) {
  if (!!on !== props.fullscreen) emit('update:fullscreen', !!on)
}
// A pane brought to the front from the panel: fullscreen would hide it.
function focusPane(id) {
  setFullscreen(false)
  emit('focus-pane', id)
}
const addMenu = reactive({ open: false, top: 0, right: 0 })
const addBtn = ref(null)
const addMenuEl = ref(null)
const rootEl = ref(null)
// Esc restores the panel, unless something used the key already (a search
// box, a menu) or the keyboard is elsewhere (a pane, a dialog).
function onKey(e) {
  if (e.key !== 'Escape' || !props.fullscreen || e.defaultPrevented || addMenu.open) return
  const target = e.target
  const inPanel = !!rootEl.value && target instanceof Node && rootEl.value.contains(target)
  if (!inPanel && target !== document.body && target !== document.documentElement) return
  e.preventDefault()
  setFullscreen(false)
}
const ADD_ITEMS = [
  { id: 'browser', key: 'sidePanelAdd.browser', label: 'Browser page', icon: Globe }, // i18n-ignore
  { id: 'terminal', key: 'sidePanelAdd.terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'chat', key: 'sidePanelAdd.chat', label: 'Claude agent (chat)', icon: MessageSquare } // i18n-ignore
]
function closeAddMenu() {
  addMenu.open = false
}
function toggleAddMenu() {
  if (addMenu.open) return closeAddMenu()
  const r = addBtn.value ? addBtn.value.getBoundingClientRect() : { bottom: 40, right: window.innerWidth }
  addMenu.top = Math.round(r.bottom + 4)
  addMenu.right = Math.max(4, Math.round(window.innerWidth - r.right))
  addMenu.open = true
  nextTick(() => {
    const first = addMenuEl.value && addMenuEl.value.querySelector('button')
    if (first) first.focus()
  })
}
function pickAdd(id) {
  closeAddMenu()
  setFullscreen(false)
  emit('quick-add', id)
}
function onMenuKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    closeAddMenu()
    if (addBtn.value) addBtn.value.focus()
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const items = [...addMenuEl.value.querySelectorAll('button')]
  const i = items.indexOf(document.activeElement)
  const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
  items[next].focus()
}
function onPointerDown(e) {
  if (!addMenu.open) return
  const target = e.target
  if (addMenuEl.value && addMenuEl.value.contains(target)) return
  if (addBtn.value && addBtn.value.contains(target)) return
  closeAddMenu()
}
window.addEventListener('keydown', onKey)
window.addEventListener('pointerdown', onPointerDown, true)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerdown', onPointerDown, true)
  if (stop) stop()
  clearTimeout(timer)
  if (explorer()) explorer().unwatch()
})
</script>

<template>
  <div ref="rootEl" class="side-panel">
    <div class="side-tabs" role="tablist" :aria-label="t('explorer.side.panel', 'Side panel')">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        class="side-tab"
        :class="{ on: current() === tab.id }"
        role="tab"
        :aria-selected="current() === tab.id"
        :title="tabLabel(tab) + (tab.shortcut ? ` (${tab.shortcut})` : '')"
        :aria-label="tabLabel(tab)"
        :data-test="'side-tab-' + tab.id"
        @click="emit('update:tab', tab.id)"
      >
        <component :is="tab.icon" :size="16" aria-hidden="true" />
        <span
          v-if="tab.id === 'changes' && changes > 0"
          class="side-tab-badge"
          :title="
            changes === 1
              ? t('explorer.side.changedFiles', '{{count}} changed file', { count: changes })
              : t('explorer.side.changedFiles', '{{count}} changed files', { count: changes })
          "
          data-test="changes-badge"
          >{{ badge }}</span
        >
      </button>
      <span class="side-tabs-fill"></span>
      <button
        ref="addBtn"
        type="button"
        class="side-tab-action"
        :class="{ on: addMenu.open }"
        :title="t('sidePanelAdd.title', 'Open a browser page, a terminal or a chat')"
        :aria-label="t('sidePanelAdd.aria', 'New')"
        aria-haspopup="menu"
        :aria-expanded="addMenu.open"
        data-test="side-add"
        @click="toggleAddMenu"
      >
        <Plus :size="15" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="side-tab-action"
        :class="{ on: fullscreen }"
        :title="fullscreen ? t('sidePanelAdd.exitFullscreen', 'Exit fullscreen (Esc)') : t('sidePanelAdd.fullscreen', 'Fullscreen')"
        :aria-label="fullscreen ? t('sidePanelAdd.exitFullscreen', 'Exit fullscreen (Esc)') : t('sidePanelAdd.fullscreen', 'Fullscreen')"
        :aria-pressed="fullscreen"
        data-test="side-fullscreen"
        @click="setFullscreen(!fullscreen)"
      >
        <Minimize2 v-if="fullscreen" :size="14" aria-hidden="true" />
        <Maximize2 v-else :size="14" aria-hidden="true" />
      </button>
    </div>
    <Teleport to="body">
      <div
        v-if="addMenu.open"
        ref="addMenuEl"
        class="ctx-menu side-add-menu"
        role="menu"
        :style="{ top: addMenu.top + 'px', right: addMenu.right + 'px' }"
        data-test="side-add-menu"
        @keydown="onMenuKey"
      >
        <button
          v-for="item in ADD_ITEMS"
          :key="item.id"
          type="button"
          class="ctx-menu-item"
          role="menuitem"
          :data-test="'side-add-' + item.id"
          @click="pickAdd(item.id)"
        >
          <component :is="item.icon" :size="14" aria-hidden="true" />
          <span>{{ t(item.key, item.label) }}</span>
        </button>
      </div>
    </Teleport>
    <div class="side-body">
      <RemoteBadge
        v-if="remote && (current() === 'files' || current() === 'changes')"
        :host-id="remote.hostId"
        :host="remote.host"
        :path="remote.path"
      />
      <AgentDashboard
        v-if="shown.dashboard"
        v-show="current() === 'dashboard'"
        :projects="projects"
        :now="now"
        @focus-pane="focusPane"
        @sleep="(ids) => emit('sleep', ids)"
      />
      <ExplorerPanel
        v-if="shown.files"
        :key="'files:' + remoteRev"
        v-show="current() === 'files'"
        :root="root"
        :can-insert="canInsert"
        @open="(file, arg) => emit('open', file, arg)"
        @open-editor="(file) => emit('open-editor', file)"
        @open-external="(file) => emit('open-external', file)"
        @terminal-here="(dir) => emit('terminal-here', dir)"
        @insert-path="(text) => emit('insert-path', text)"
        @toast="(t) => emit('toast', t)"
        @close="emit('close')"
      />
      <ChangesPanel
        v-if="shown.changes"
        :key="'changes:' + remoteRev"
        v-show="current() === 'changes'"
        :root="root"
        :workspace-id="workspaceId"
        @open="(file) => emit('open', file)"
        @open-diff="(req) => emit('open-diff', req)"
        @create-pr="(q) => emit('create-pr', q)"
        @toast="(t) => emit('toast', t)"
        @review="(id) => emit('review', id)"
      />
      <TaskBoard
        v-if="shown.tasks"
        v-show="current() === 'tasks'"
        :agent-panes="agentPanes"
        :workspace-id="workspaceId"
        @new-task="emit('new-task')"
        @focus-pane="focusPane"
        @review="(id) => emit('review', id)"
      />
      <SessionHistoryPanel
        v-if="shown.history"
        v-show="current() === 'history'"
        :cwd="remote ? null : root"
        :open-ids="openSessionIds"
        :active="current() === 'history'"
        @resume="(s) => emit('resume-session', s)"
        @focus-pane="focusPane"
        @open-editor="(file) => emit('open-editor', file)"
        @toast="(t) => emit('toast', t)"
      />
    </div>
  </div>
</template>
