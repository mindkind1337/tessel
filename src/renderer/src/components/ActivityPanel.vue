<script setup>
// Activity of the agents: what needs you now, one line per agent, and a
// timeline of messages, approvals, limits, team changes and journal entries.
// Numbers come from summarize() (src/shared/activity.js); they help unblock
// and review work, they do not rank agents.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { summarize, cardsFor, parseJournal, formatDuration } from '../../../shared/activity'
import { t, intlLocale } from '../i18n'

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
  { value: '24h', ms: 24 * 3600 * 1000 },
  { value: '7d', ms: 7 * 24 * 3600 * 1000 },
  { value: '30d', ms: 30 * 24 * 3600 * 1000 }
]
function periodText(value) {
  if (value === '24h') return t('activity.period.24h', '24 h')
  if (value === '7d') return t('activity.period.7d', '7 days')
  return t('activity.period.30d', '30 days')
}
const TYPES = ['task', 'message', 'team-chat', 'approval', 'limit', 'team', 'journal'].map((value) => ({ value }))
// The filter buttons (plural) and the kind of one event (singular).
function typeLabel(value) {
  return {
    task: t('activity.type.tasks', 'Tasks'),
    message: t('activity.type.messages', 'Messages'),
    'team-chat': t('activity.type.betweenAgents', 'Between agents'),
    approval: t('activity.type.approvals', 'Approvals'),
    limit: t('activity.type.limits', 'Limits'),
    team: t('activity.type.team', 'Team'),
    journal: t('activity.type.notes', 'Notes')
  }[value]
}
function kindLabel(kind) {
  return (
    {
      task: t('activity.kind.task', 'Task'),
      message: t('activity.kind.message', 'Message'),
      approval: t('activity.kind.approval', 'Approval'),
      limit: t('activity.kind.limit', 'Limit'),
      team: t('activity.kind.team', 'Team'),
      journal: t('activity.kind.note', 'Note')
    }[kind.replace(/-end$/, '')] || kind
  )
}
function stateText(state) {
  return (
    {
      working: t('activity.state.working', 'Working'),
      idle: t('activity.state.idle', 'Idle'),
      approval: t('activity.state.approval', 'Needs your approval'),
      limited: t('activity.state.limited', 'Usage limit'),
      sleeping: t('activity.state.sleeping', 'Asleep'),
      closed: t('activity.state.closed', 'Closed')
    }[state] || state
  )
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
const typeFilter = ref(new Set(TYPES.map((x) => x.value)))
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
    const kind = x.kind === 'message' && x.scope === 'team-chat' ? 'team-chat' : x.kind.replace(/-end$/, '')
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
  typeFilter.value = new Set(TYPES.map((x) => x.value))
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
  const time = d.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return time
  return `${d.toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' })} ${time}`
}

// One line for a task event: what happened to it and who did it.
function taskLine(x) {
  const task = `“${x.task}”`
  const you = t('activity.you', 'You')
  const lead = (name) => t('activity.lead', '{{name}} (lead)', { name })
  switch (x.action) {
    // Cards the agents put on the team board and move themselves.
    case 'added':
      return {
        who: x.by || x.title,
        text: t('activity.task.added', 'put {{task}} on the board', { task }),
        note: t('activity.task.addedFor', 'for {{agent}}', { agent: x.title })
      }
    case 'moved':
      return { who: x.by || x.title, text: t('activity.task.moved', 'moved {{task}} to {{column}}', { task, column: x.detail }), note: '' }
    case 'review':
      return {
        who: x.title,
        text: t('activity.task.finished', 'finished the task {{task}}', { task }),
        note: x.detail || t('activity.task.readyForReview', 'ready for your review')
      }
    case 'approved':
      return { who: lead(x.by || t('activity.theLead', 'The lead')), text: t('activity.task.approved', 'approved {{task}}', { task }), note: x.detail }
    case 'changes':
      return {
        who: x.by ? lead(x.by) : you,
        text: t('activity.task.changes', 'asked {{agent}} for changes to {{task}}', { agent: x.title, task }),
        note: x.detail
      }
    case 'resolve':
      return {
        who: you,
        text: t('activity.task.resolve', 'asked {{agent}} to resolve the conflicts of {{task}}', { agent: x.title, task }),
        note: x.detail
      }
    case 'merged':
      return { who: you, text: t('activity.task.merged', 'merged {{task}}', { task }), note: x.detail }
    case 'discarded':
      return { who: you, text: t('activity.task.discarded', 'discarded {{task}}', { task }), note: x.detail }
    case 'done':
      return { who: you, text: t('activity.task.done', 'marked {{task}} as done', { task }), note: '' }
    // Orchestration: a report, a decision asked and given, a card free to start.
    case 'reported':
      return { who: x.by || x.title, text: t('activity.task.reported', 'reported {{task}}: {{report}}', { task, report: x.detail }), note: '' }
    case 'gate':
      return { who: x.by || x.title, text: t('activity.task.gate', 'asks your decision on {{task}}', { task }), note: x.detail }
    case 'decided':
      return { who: you, text: t('activity.task.decided', 'decided on {{task}}', { task }), note: x.detail }
    // Coordinator and workers.
    case 'worker-requested':
      return { who: x.by || x.title, text: t('activity.task.workerRequested', 'asked for a worker on {{task}}', { task }), note: x.detail }
    case 'worker-allowed':
      return { who: you, text: t('activity.task.workerAllowed', 'allowed the worker for {{task}}', { task }), note: '' }
    case 'worker-started':
      return {
        who: x.title,
        text: t('activity.task.workerStarted', 'started as a worker on {{task}}', { task }),
        note: x.by ? t('activity.task.workerOf', 'worker of {{coordinator}}', { coordinator: x.by }) : x.detail
      }
    case 'worker-refused':
      return { who: you, text: t('activity.task.workerRefused', 'refused the worker for {{task}}', { task }), note: '' }
    case 'worker-stopped':
      return { who: x.by || 'Tessel', text: t('activity.task.workerStopped', 'ended the worker on {{task}}', { task }), note: x.detail }
    case 'worker-released':
      return { who: x.by || x.title, text: t('activity.task.workerReleased', 'released the worker on {{task}}', { task }), note: '' }
    case 'worker-failed':
      return { who: 'Tessel', text: t('activity.task.workerFailed', 'could not start the worker for {{task}}', { task }), note: x.detail }
    case 'ready':
      return {
        who: x.title,
        text: t('activity.task.canStart', 'can start {{task}}', { task }),
        note: t('activity.task.depsDone', 'the cards it waited for are done')
      }
    default:
      return {
        who: x.title,
        text: t('activity.task.started', 'started the task {{task}}', { task }),
        note: x.branch ? t('activity.task.branch', 'branch {{branch}}', { branch: x.branch }) : ''
      }
  }
}

function describe(x) {
  switch (x.kind) {
    case 'message': {
      // Between agents, through the team tools (not typed anywhere).
      if (x.scope === 'team-chat')
        return {
          who: x.from || t('activity.anAgent', 'An agent'),
          text: `→ ${x.title}: “${x.preview}”`,
          note: x.status === 'read' ? t('activity.msg.read', 'read') : t('activity.msg.notRead', 'not read yet')
        }
      const who =
        x.source === 'tessel'
          ? 'Tessel'
          : x.source === 'lead'
            ? t('activity.lead', '{{name}} (lead)', { name: x.from || t('activity.theLead', 'The lead') })
            : x.source === 'agent'
              ? x.from || t('activity.anAgent', 'An agent')
              : t('activity.you', 'You')
      const to =
        x.scope === 'team'
          ? t('activity.msg.toTeam', ' (team)')
          : x.scope === 'workspace'
            ? t('activity.msg.toAll', ' (all agents)')
            : ''
      const how =
        x.status === 'held'
          ? t('activity.msg.held', 'held until the approval prompt was answered')
          : x.status === 'skipped'
            ? t('activity.msg.skipped', 'not sent: usage limit')
            : x.status === 'unconfirmed'
              ? t('activity.msg.unconfirmed', 'pasted, but not seen taken: check the input box')
              : t('activity.msg.sent', 'sent')
      return { who, text: `→ ${x.title}${to}: “${x.preview}”`, note: how }
    }
    case 'task':
      return taskLine(x)
    case 'approval':
      return { who: x.title, text: t('activity.approval.asked', 'asked for your approval'), note: '' }
    case 'approval-end':
      return {
        who: x.title,
        text: t('activity.approval.answered', 'approval answered'),
        note: t('activity.approval.waited', 'waited {{duration}}', { duration: formatDuration(x.waited) })
      }
    case 'limit':
      return {
        who: x.title,
        text: t('activity.limit.hit', 'hit its usage limit'),
        note: x.reset ? t('activity.limit.resets', 'resets {{reset}}', { reset: x.reset }) : ''
      }
    case 'limit-end':
      return { who: x.title, text: t('activity.limit.end', 'working again after its usage limit'), note: '' }
    case 'team': {
      const v = { name: x.name, detail: x.detail }
      const what = {
        created: x.detail
          ? t('activity.team.createdWith', 'created team “{{name}}” with {{detail}}', v)
          : t('activity.team.created', 'created team “{{name}}”', v),
        joined: t('activity.team.joined', '{{detail}} joined “{{name}}”', v),
        renamed: t('activity.team.renamed', 'renamed team “{{detail}}” to “{{name}}”', v),
        left: t('activity.team.left', '{{detail}} left “{{name}}”', v),
        closed: t('activity.team.closed', '{{detail}} was closed and left “{{name}}”', v),
        ungrouped: t('activity.team.ungrouped', 'ungrouped team “{{name}}”', v),
        lead: t('activity.team.lead', '{{detail}} now leads “{{name}}”', v),
        'lead-removed': t('activity.team.leadRemoved', '“{{name}}” has no lead any more', v)
      }[x.action]
      return { who: t('activity.team.who', 'Team'), text: what || x.action, note: '' }
    }
    case 'journal':
      return { who: x.author, text: t('activity.journal.wrote', 'wrote in the notes: “{{preview}}”', { preview: x.preview }), note: '' }
    default:
      return { who: '', text: x.kind, note: '' }
  }
}

const periodLabel = computed(() => periodText(period.value))
const waitSub = computed(() =>
  cards.value.approvalWait.count
    ? t('activity.cards.medianOf', 'median of {{count}}, last {{period}}', {
        count: cards.value.approvalWait.count,
        period: periodLabel.value
      })
    : t('activity.cards.noneAnswered', 'none answered, last {{period}}', { period: periodLabel.value })
)
function ofOpenAgents(n) {
  return t('activity.cards.ofOpen', 'of {{count}} open agents', { count: n })
}
const messagesSub = computed(() =>
  t('activity.cards.heldSkipped', '{{held}} held · {{skipped}} not sent', {
    held: cards.value.messages.held,
    skipped: cards.value.messages.skipped
  })
)
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
        <span id="act-title">{{ t('activity.title', 'Activity') }}</span>
        <button class="tb-icon" :title="t('activity.closeEsc', 'Close (Esc)')" :aria-label="t('activity.close', 'Close')" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="act-filters">
        <label class="act-field">
          <span>{{ t('activity.scope', 'Scope') }}</span>
          <select
            class="act-select"
            :value="scope"
            @change="emit('update:scope', $event.target.value)"
          >
            <option v-for="s in scopes" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
        </label>
        <div class="act-seg" role="group" :aria-label="t('activity.periodLabel', 'Period')">
          <button
            v-for="p in PERIODS"
            :key="p.value"
            class="act-seg-btn"
            :class="{ on: period === p.value }"
            :aria-pressed="period === p.value"
            @click="period = p.value"
          >
            {{ periodText(p.value) }}
          </button>
        </div>
        <label class="act-field">
          <span>{{ t('activity.agent', 'Agent') }}</span>
          <select v-model="agentFilter" class="act-select">
            <option value="">{{ t('activity.allAgents', 'All agents') }}</option>
            <option v-for="r in summary.rows" :key="r.paneId" :value="r.paneId">
              {{ r.title }}{{ r.open ? '' : t('activity.closedSuffix', ' (closed)') }}
            </option>
          </select>
        </label>
      </div>

      <div v-if="summary.empty" class="act-empty">
        <p class="act-empty-title">{{ t('activity.emptyTitle', 'No activity yet') }}</p>
        <p>
          {{
            t(
              'activity.emptyHint',
              'Tessel starts counting from now: messages to the agents, approvals, usage limits and working time will show up here as they happen.'
            )
          }}
        </p>
      </div>

      <template v-else>
        <div class="act-cards">
          <button
            class="act-stat"
            :class="{ on: stateFilter === 'approval', alert: cards.needsApproval > 0 }"
            :title="t('activity.cards.approvalHint', 'Show the agents waiting for your approval')"
            @click="pickState('approval')"
          >
            <span class="act-stat-label">{{ t('activity.cards.approvalNow', 'Need your approval now') }}</span>
            <span class="act-stat-value">{{ cards.needsApproval }}</span>
            <span class="act-stat-sub">{{ ofOpenAgents(cards.openAgents) }}</span>
          </button>
          <button
            class="act-stat"
            :class="{ on: stateFilter === 'working' }"
            :title="t('activity.cards.workingHint', 'Show the agents working now')"
            @click="pickState('working')"
          >
            <span class="act-stat-label">{{ t('activity.cards.workingNow', 'Working now') }}</span>
            <span class="act-stat-value">{{ cards.working }}</span>
            <span class="act-stat-sub">{{ ofOpenAgents(cards.openAgents) }}</span>
          </button>
          <div class="act-stat static">
            <span class="act-stat-label">{{ t('activity.cards.approvalWait', 'Wait for your approval') }}</span>
            <span class="act-stat-value">{{
              cards.approvalWait.count ? formatDuration(cards.approvalWait.median) : '—'
            }}</span>
            <span class="act-stat-sub">{{ waitSub }}</span>
          </div>
          <div class="act-stat static">
            <span class="act-stat-label">{{ t('activity.cards.messages', 'Messages to agents') }}</span>
            <span class="act-stat-value">{{ cards.messages.received }}</span>
            <span class="act-stat-sub">{{ messagesSub }}</span>
          </div>
        </div>

        <div class="act-section-head">
          <span>{{ t('activity.agents', 'Agents') }}</span>
          <span class="act-count">{{ rows.length }}</span>
          <button v-if="filtered" class="act-link" @click="clearFilters">{{ t('activity.clearFilters', 'Clear filters') }}</button>
        </div>
        <div class="act-table-wrap">
          <table v-if="rows.length" class="act-table">
            <thead>
              <tr>
                <th scope="col">{{ t('activity.col.agent', 'Agent') }}</th>
                <th scope="col">{{ t('activity.col.now', 'Now') }}</th>
                <th scope="col" class="num" :title="t('activity.col.workingHint', 'Time in the Working state, this period')">{{ t('activity.col.working', 'Working') }}</th>
                <th scope="col" class="num" :title="t('activity.col.waitedHint', 'Times it waited for your approval, and for how long')">
                  {{ t('activity.col.waited', 'Waited on you') }}
                </th>
                <th scope="col" class="num">{{ t('activity.col.limits', 'Limits') }}</th>
                <th scope="col" class="num" :title="t('activity.col.messagesHint', 'Received · held · not sent')">{{ t('activity.col.messages', 'Messages') }}</th>
                <th scope="col" class="num" :title="t('activity.col.notesHint', 'Lines in the Journal of the project notes')">{{ t('activity.col.notes', 'Notes') }}</th>
                <th scope="col">{{ t('activity.col.last', 'Last activity') }}</th>
                <th scope="col"><span class="sr-only">{{ t('activity.open', 'Open') }}</span></th>
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
                    <span class="act-dot" aria-hidden="true"></span>{{ stateText(r.state) }}
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
                    {{ t('activity.open', 'Open') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="act-none">
            {{ t('activity.noAgentFiltered', 'No agent for these filters.') }} <button class="act-link" @click="clearFilters">{{ t('activity.clearFilters', 'Clear filters') }}</button>
          </p>
        </div>

        <div class="act-section-head">
          <span>{{ t('activity.timeline', 'Timeline') }}</span>
          <span class="act-count">{{ timeline.length }}</span>
          <div class="mcp-cats act-types" role="group" :aria-label="t('activity.eventTypes', 'Event types')">
            <button
              v-for="ty in TYPES"
              :key="ty.value"
              class="mcp-cat"
              :class="{ on: typeFilter.has(ty.value) }"
              :aria-pressed="typeFilter.has(ty.value)"
              @click="toggleType(ty.value)"
            >
              {{ typeLabel(ty.value) }}
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
            <span class="act-kind" :class="x.kind.replace(/-end$/, '')">{{ kindLabel(x.kind) }}</span>
            <span class="act-text">
              <strong>{{ describe(x).who }}</strong> {{ describe(x).text }}
              <span v-if="describe(x).note" class="act-dim"> · {{ describe(x).note }}</span>
            </span>
            <span v-if="openRows.has(rowKey(x))" class="act-full">{{ x.text || x.preview }}</span>
          </li>
        </ol>
        <p v-else class="act-none">
          {{ t('activity.noneFiltered', 'No activity for these filters.') }} <button class="act-link" @click="clearFilters">{{ t('activity.clearFilters', 'Clear filters') }}</button>
        </p>
      </template>
    </div>
  </div>
</template>
