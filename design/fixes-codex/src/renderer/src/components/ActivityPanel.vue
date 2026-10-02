<script setup>
// Activity of the agents: what needs you now, one line per agent, and a
// timeline of messages, approvals, limits, team changes and journal entries.
// Numbers come from summarize() (src/shared/activity.js); they help unblock
// and review work, they do not rank agents.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { summarize, cardsFor, parseJournal, formatDuration } from '../../../shared/activity'

const props = defineProps({
  events: { type: Array, required: true },
  // Agents open now: { [paneId]: { state, title, agentId } }
  live: { type: Object, default: () => ({}) },
  // Scope picker: [{ value, label, wsId, teamId, notesDir }]
  scopes: { type: Array, default: () => [] },
  scope: { type: String, default: 'workspace' }
})
const emit = defineEmits(['close', 'focus-pane', 'update:scope'])

const PERIODS = [
  { value: '24h', label: '24 h', ms: 24 * 3600 * 1000 },
  { value: '7d', label: '7 days', ms: 7 * 24 * 3600 * 1000 },
  { value: '30d', label: '30 days', ms: 30 * 24 * 3600 * 1000 }
]
const TYPES = [
  { value: 'task', label: 'Tasks' },
  { value: 'message', label: 'Messages' },
  { value: 'approval', label: 'Approvals' },
  { value: 'limit', label: 'Limits' },
  { value: 'team', label: 'Team' },
  { value: 'journal', label: 'Notes' }
]
const STATE = {
  working: 'Working',
  idle: 'Idle',
  approval: 'Needs your approval',
  limited: 'Usage limit',
  closed: 'Closed'
}

const period = ref('7d')
const openRows = ref(new Set()) // timeline rows shown in full

function toggleRow(key) {
  const next = new Set(openRows.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openRows.value = next
}

const rowKey = (x) => x.key
const agentFilter = ref('')
const typeFilter = ref(new Set(TYPES.map((t) => t.value)))
const stateFilter = ref(null) // from the cards: 'approval' | 'working'
const journal = ref([])
const now = ref(Date.now())
const cardEl = ref(null)
let clock = null

const current = computed(() => props.scopes.find((s) => s.value === props.scope) || props.scopes[0])

async function loadJournal() {
  journal.value = []
  const dir = current.value && current.value.notesDir
  if (!dir || !window.shellApi.readProjectNotes) return
  try {
    journal.value = parseJournal(await window.shellApi.readProjectNotes(dir))
  } catch {
    journal.value = []
  }
}

// Esc closes the view wherever the focus is (another dialog may have taken it).
function onKey(e) {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault()
    emit('close')
  }
}

onMounted(() => {
  // Focus the dialog, so Tab starts inside it.
  if (cardEl.value) cardEl.value.focus()
  window.addEventListener('keydown', onKey)
  loadJournal()
  clock = setInterval(() => (now.value = Date.now()), 15000)
})
watch(() => props.scope, loadJournal)
onBeforeUnmount(() => {
  clearInterval(clock)
  window.removeEventListener('keydown', onKey)
})

const summary = computed(() => {
  const ms = PERIODS.find((p) => p.value === period.value).ms
  const scope = current.value || {}
  return summarize(props.events, {
    now: now.value,
    from: now.value - ms,
    wsId: scope.wsId || null,
    teamId: scope.teamId || null,
    live: props.live,
    journal: journal.value
  })
})

const cards = computed(() =>
  cardsFor(summary.value.rows.filter((r) => !agentFilter.value || r.paneId === agentFilter.value))
)

const rows = computed(() =>
  summary.value.rows.filter(
    (r) =>
      (!agentFilter.value || r.paneId === agentFilter.value) &&
      (!stateFilter.value || (r.open && r.state === stateFilter.value))
  )
)

const timeline = computed(() =>
  summary.value.timeline.filter((x) => {
    const kind = x.kind.replace(/-end$/, '')
    if (!typeFilter.value.has(kind)) return false
    if (agentFilter.value && x.paneId !== agentFilter.value) return false
    return true
  })
)

const filtered = computed(
  () => !!agentFilter.value || !!stateFilter.value || typeFilter.value.size < TYPES.length
)

function clearFilters() {
  agentFilter.value = ''
  stateFilter.value = null
  typeFilter.value = new Set(TYPES.map((t) => t.value))
}

function toggleType(v) {
  const next = new Set(typeFilter.value)
  if (next.has(v)) next.delete(v)
  else next.add(v)
  typeFilter.value = next
}

function pickState(s) {
  stateFilter.value = stateFilter.value === s ? null : s
}

function when(t) {
  const d = new Date(t)
  const today = new Date(now.value)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return time
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

// One line for a task event: what happened to it and who did it.
function taskLine(x) {
  const t = `“${x.task}”`
  switch (x.action) {
    case 'review':
      return { who: x.title, text: `finished the task ${t}`, note: x.detail || 'ready for your review' }
    case 'approved':
      return { who: `${x.by || 'The lead'} (lead)`, text: `approved ${t}`, note: x.detail }
    case 'changes':
      return { who: x.by ? `${x.by} (lead)` : 'You', text: `asked ${x.title} for changes to ${t}`, note: x.detail }
    case 'resolve':
      return { who: 'You', text: `asked ${x.title} to resolve the conflicts of ${t}`, note: x.detail }
    case 'merged':
      return { who: 'You', text: `merged ${t}`, note: x.detail }
    case 'discarded':
      return { who: 'You', text: `discarded ${t}`, note: x.detail }
    case 'done':
      return { who: 'You', text: `marked ${t} as done`, note: '' }
    default:
      return { who: x.title, text: `started the task ${t}`, note: x.branch ? `branch ${x.branch}` : '' }
  }
}

function describe(x) {
  switch (x.kind) {
    case 'message': {
      const who = x.source === 'tessel' ? 'Tessel' : x.source === 'lead' ? `${x.from || 'The lead'} (lead)` : x.source === 'agent' ? x.from || 'An agent' : 'You'
      const to = x.scope === 'team' ? ' (team)' : x.scope === 'workspace' ? ' (all agents)' : ''
      const how =
        x.status === 'held'
          ? 'held until the approval prompt was answered'
          : x.status === 'skipped'
            ? 'not sent: usage limit'
            : x.status === 'unconfirmed'
              ? 'pasted, but not seen taken: check the input box'
              : 'sent'
      return { who, text: `→ ${x.title}${to}: “${x.preview}”`, note: how }
    }
    case 'task':
      return taskLine(x)
    case 'approval':
      return { who: x.title, text: 'asked for your approval', note: '' }
    case 'approval-end':
      return { who: x.title, text: 'approval answered', note: `waited ${formatDuration(x.waited)}` }
    case 'limit':
      return { who: x.title, text: 'hit its usage limit', note: x.reset ? `resets ${x.reset}` : '' }
    case 'limit-end':
      return { who: x.title, text: 'working again after its usage limit', note: '' }
    case 'team': {
      const what = {
        created: `created team “${x.name}”${x.detail ? ` with ${x.detail}` : ''}`,
        joined: `${x.detail} joined “${x.name}”`,
        renamed: `renamed team “${x.detail}” to “${x.name}”`,
        left: `${x.detail} left “${x.name}”`,
        closed: `${x.detail} was closed and left “${x.name}”`,
        ungrouped: `ungrouped team “${x.name}”`,
        lead: `${x.detail} now leads “${x.name}”`,
        'lead-removed': `“${x.name}” has no lead any more`
      }[x.action]
      return { who: 'Team', text: what || x.action, note: '' }
    }
    case 'journal':
      return { who: x.author, text: `wrote in the notes: “${x.preview}”`, note: '' }
    default:
      return { who: '', text: x.kind, note: '' }
  }
}

const periodLabel = computed(() => PERIODS.find((p) => p.value === period.value).label)
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="emit('close')">
    <div
      ref="cardEl"
      class="help-card act-card"
      role="dialog"
      aria-labelledby="act-title"
      tabindex="-1"
    >
      <div class="help-head">
        <span id="act-title">Activity</span>
        <button class="tb-icon" title="Close (Esc)" aria-label="Close" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="act-filters">
        <label class="act-field">
          <span>Scope</span>
          <select
            class="act-select"
            :value="scope"
            @change="emit('update:scope', $event.target.value)"
          >
            <option v-for="s in scopes" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
        </label>
        <div class="act-seg" role="group" aria-label="Period">
          <button
            v-for="p in PERIODS"
            :key="p.value"
            class="act-seg-btn"
            :class="{ on: period === p.value }"
            :aria-pressed="period === p.value"
            @click="period = p.value"
          >
            {{ p.label }}
          </button>
        </div>
        <label class="act-field">
          <span>Agent</span>
          <select v-model="agentFilter" class="act-select">
            <option value="">All agents</option>
            <option v-for="r in summary.rows" :key="r.paneId" :value="r.paneId">
              {{ r.title }}{{ r.open ? '' : ' (closed)' }}
            </option>
          </select>
        </label>
      </div>

      <div v-if="summary.empty" class="act-empty">
        <p class="act-empty-title">No activity yet</p>
        <p>
          Tessel starts counting from now: messages to the agents, approvals, usage limits and
          working time will show up here as they happen.
        </p>
      </div>

      <template v-else>
        <div class="act-cards">
          <button
            class="act-stat"
            :class="{ on: stateFilter === 'approval', alert: cards.needsApproval > 0 }"
            title="Show the agents waiting for your approval"
            @click="pickState('approval')"
          >
            <span class="act-stat-label">Need your approval now</span>
            <span class="act-stat-value">{{ cards.needsApproval }}</span>
            <span class="act-stat-sub">of {{ cards.openAgents }} open agents</span>
          </button>
          <button
            class="act-stat"
            :class="{ on: stateFilter === 'working' }"
            title="Show the agents working now"
            @click="pickState('working')"
          >
            <span class="act-stat-label">Working now</span>
            <span class="act-stat-value">{{ cards.working }}</span>
            <span class="act-stat-sub">of {{ cards.openAgents }} open agents</span>
          </button>
          <div class="act-stat static">
            <span class="act-stat-label">Wait for your approval</span>
            <span class="act-stat-value">{{
              cards.approvalWait.count ? formatDuration(cards.approvalWait.median) : '—'
            }}</span>
            <span class="act-stat-sub">{{
              cards.approvalWait.count
                ? `median of ${cards.approvalWait.count}, last ${periodLabel}`
                : `none answered, last ${periodLabel}`
            }}</span>
          </div>
          <div class="act-stat static">
            <span class="act-stat-label">Messages to agents</span>
            <span class="act-stat-value">{{ cards.messages.received }}</span>
            <span class="act-stat-sub"
              >{{ cards.messages.held }} held · {{ cards.messages.skipped }} not sent</span
            >
          </div>
        </div>

        <div class="act-section-head">
          <span>Agents</span>
          <span class="act-count">{{ rows.length }}</span>
          <button v-if="filtered" class="act-link" @click="clearFilters">Clear filters</button>
        </div>
        <div class="act-table-wrap">
          <table v-if="rows.length" class="act-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Now</th>
                <th scope="col" class="num" title="Time in the Working state, this period">Working</th>
                <th scope="col" class="num" title="Times it waited for your approval, and for how long">
                  Waited on you
                </th>
                <th scope="col" class="num">Limits</th>
                <th scope="col" class="num" title="Received · held · not sent">Messages</th>
                <th scope="col" class="num" title="Lines in the Journal of the project notes">Notes</th>
                <th scope="col">Last activity</th>
                <th scope="col"><span class="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.paneId" :class="{ closed: !r.open }">
                <td>
                  <span class="act-agent">
                    <BrandIcon :kind="r.agentId" :label="r.title" :size="14" />
                    {{ r.title }}
                  </span>
                </td>
                <td>
                  <span class="act-state" :class="r.state">
                    <span class="act-dot" aria-hidden="true"></span>{{ STATE[r.state] || r.state }}
                  </span>
                  <span v-if="r.since && r.open" class="act-dim"> · {{ formatDuration(now - r.since) }}</span>
                </td>
                <td class="num">{{ formatDuration(r.ms.working) }}</td>
                <td class="num">
                  {{ r.approvals }}<span v-if="r.ms.approval" class="act-dim"> · {{ formatDuration(r.ms.approval) }}</span>
                </td>
                <td class="num">{{ r.limits }}</td>
                <td class="num">
                  {{ r.received }}<span class="act-dim"> · {{ r.held }} · {{ r.skipped }}</span>
                </td>
                <td class="num">{{ r.journal }}</td>
                <td>{{ r.lastActivity ? when(r.lastActivity) : '—' }}</td>
                <td>
                  <button v-if="r.open" class="act-open" @click="emit('focus-pane', r.paneId)">
                    Open
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="act-none">
            No agent for these filters. <button class="act-link" @click="clearFilters">Clear filters</button>
          </p>
        </div>

        <div class="act-section-head">
          <span>Timeline</span>
          <span class="act-count">{{ timeline.length }}</span>
          <div class="mcp-cats act-types" role="group" aria-label="Event types">
            <button
              v-for="t in TYPES"
              :key="t.value"
              class="mcp-cat"
              :class="{ on: typeFilter.has(t.value) }"
              :aria-pressed="typeFilter.has(t.value)"
              @click="toggleType(t.value)"
            >
              {{ t.label }}
            </button>
          </div>
        </div>
        <ol v-if="timeline.length" class="act-timeline">
          <li
            v-for="x in timeline"
            :key="rowKey(x)"
            class="act-event"
            :class="[x.kind, { expandable: !!(x.text || x.preview), open: openRows.has(rowKey(x)) }]"
            :tabindex="x.text || x.preview ? 0 : -1"
            :aria-expanded="x.text || x.preview ? openRows.has(rowKey(x)) : undefined"
            @click="(x.text || x.preview) && toggleRow(rowKey(x))"
            @keydown.enter.prevent="(x.text || x.preview) && toggleRow(rowKey(x))"
          >
            <span class="act-time">{{ x.day && x.kind === 'journal' ? x.day : when(x.t) }}</span>
            <span class="act-kind" :class="x.kind.replace(/-end$/, '')">{{
              TYPES.find((t) => t.value === x.kind.replace(/-end$/, ''))?.label.replace(/s$/, '') || x.kind
            }}</span>
            <span class="act-text">
              <strong>{{ describe(x).who }}</strong> {{ describe(x).text }}
              <span v-if="describe(x).note" class="act-dim"> · {{ describe(x).note }}</span>
            </span>
            <span v-if="openRows.has(rowKey(x))" class="act-full">{{ x.text || x.preview }}</span>
          </li>
        </ol>
        <p v-else class="act-none">
          No activity for these filters. <button class="act-link" @click="clearFilters">Clear filters</button>
        </p>
      </template>
    </div>
  </div>
</template>
