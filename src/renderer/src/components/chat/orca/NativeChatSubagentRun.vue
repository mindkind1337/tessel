<script>
// After Orca's NativeChatSubagentRun.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { defineComponent } from 'vue'
import { useNow } from '../../../chat/orca/composables/use-now.js'
import { formatNativeChatDuration } from '../../../chat/orca/shared/native-chat-turn-status.js'

/** Leaf so the shared 1s clock re-renders only the digits, never the roster. */
const SubagentElapsed = defineComponent({
  name: 'SubagentElapsed',
  props: {
    startedAt: { type: Number, required: true },
    settledAt: { type: Number, default: null },
    counting: { type: Boolean, default: false }
  },
  setup(props) {
    const now = useNow(1_000, () => props.counting)
    return () => {
      const end = props.counting ? now.value : (props.settledAt ?? now.value)
      return formatNativeChatDuration(Math.max(0, (end - props.startedAt) / 1000))
    }
  }
})
</script>

<script setup>
/**
 * One spawn group: how many children are working, their settled verdict, and
 * the tokens they consumed. Deliberately flat — children are summarized here,
 * never nested into the transcript as turns of their own.
 *
 * Every state is drawn exactly as the journal recorded it. Turn state is NOT
 * consulted: `spawn_agent` children outlive the turn that spawned them and keep
 * reporting into this group long after a newer turn opened, so a turn boundary
 * is a fact about the turn and never evidence that contact with a child was
 * lost. Only a host can say that.
 *
 * Props: block ({ type: 'subagent-group', groupId, agents: [{ id, label, state,
 *   tokens?, startedAt?, settledAt? }] }).
 */
import { computed, ref } from 'vue'
import { Bot, ChevronRight } from 'lucide-vue-next'
import { t } from '../../../i18n'
import {
  normalizeSubagentState,
  summarizeSubagentGroup
} from '../../../chat/orca/shared/native-chat-subagent-summary.js'

const props = defineProps({
  block: { type: Object, required: true }
})

const open = ref(false)
const agents = computed(() => props.block.agents)
const summary = computed(() => summarizeSubagentGroup(agents.value))

/** Compact token counts: the row shows scale, not an exact ledger. */
function formatSubagentTokens(tokens) {
  if (tokens < 1_000) return String(Math.round(tokens))
  const scaled = tokens < 1_000_000 ? tokens / 1_000 : tokens / 1_000_000
  const suffix = tokens < 1_000_000 ? 'k' : 'M'
  return `${scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`
}

/** The group's one-line verdict. A single-child group reads as a bare word; any
 *  larger group always carries the count, because "working" alone would not say
 *  how many of the children it covers. `completed` never takes one: every child
 *  finishing is the whole group finishing. */
function subagentStateLabel(state, count, groupTotal) {
  if (state === 'completed') return t('chat.orca.subagents.state.completed', 'completed')
  if (groupTotal <= 1) {
    switch (state) {
      case 'working':
        return t('chat.orca.subagents.state.working', 'working')
      case 'idle':
        return t('chat.orca.subagents.state.idle', 'idle')
      case 'failed':
        return t('chat.orca.subagents.state.failed', 'failed')
      case 'stopped':
        return t('chat.orca.subagents.state.stopped', 'stopped')
      default:
        return t('chat.orca.subagents.state.unverifiable', 'unverifiable')
    }
  }
  const vars = { value0: count }
  switch (state) {
    case 'working':
      return t('chat.orca.subagents.state.workingCount', '{{value0}} working', vars)
    case 'idle':
      return t('chat.orca.subagents.state.idleCount', '{{value0}} idle', vars)
    case 'failed':
      return t('chat.orca.subagents.state.failedCount', '{{value0}} failed', vars)
    case 'stopped':
      return t('chat.orca.subagents.state.stoppedCount', '{{value0}} stopped', vars)
    default:
      return t('chat.orca.subagents.state.unverifiableCount', '{{value0}} unverifiable', vars)
  }
}

const working = computed(() => summary.value.working > 0)
const headline = computed(() => {
  const total = summary.value.total
  if (working.value) {
    return total === 1
      ? t('chat.orca.subagents.startedOne', 'Kicked off 1 subagent')
      : t('chat.orca.subagents.startedN', 'Kicked off {{value0}} subagents', { value0: total })
  }
  return total === 1
    ? t('chat.orca.subagents.ranOne', 'Ran 1 subagent')
    : t('chat.orca.subagents.ranN', 'Ran {{value0}} subagents', { value0: total })
})
const verdictState = computed(() => (working.value ? 'working' : (summary.value.settledState ?? 'idle')))
const verdict = computed(() =>
  working.value
    ? subagentStateLabel('working', summary.value.working, summary.value.total)
    : subagentStateLabel(verdictState.value, summary.value.settledCount, summary.value.total)
)
// A child that already failed must not wait for its siblings to be readable.
const alertState = computed(() => (working.value ? summary.value.adverseState : null))
const alert = computed(() =>
  alertState.value === null ? null : subagentStateLabel(alertState.value, summary.value.adverseCount, summary.value.total)
)
// A child settled by the reopen reads `unverifiable` with no terminal stamp: it
// stopped being observable at an unknown moment. Measuring to `now` would report
// the time since the host died as how long the child ran; a sibling's stamp is
// no better while a child's fate is still unknown.
const runLengthUnknown = computed(() =>
  agents.value.some(
    (agent) => normalizeSubagentState(agent.state) === 'unverifiable' && typeof agent.settledAt !== 'number'
  )
)
const clockStartedAt = computed(() =>
  !runLengthUnknown.value && (working.value || summary.value.settledAt !== null) ? summary.value.startedAt : null
)
const tokensText = computed(() =>
  summary.value.tokens !== null
    ? ` · ${t('chat.orca.subagents.tokens', '{{value0}} tokens', { value0: formatSubagentTokens(summary.value.tokens) })}`
    : ''
)
const rows = computed(() =>
  agents.value.map((agent) => {
    const state = normalizeSubagentState(agent.state)
    return {
      agent,
      state,
      detail: `${subagentStateLabel(state, 1, 1)}${typeof agent.tokens === 'number' ? ` · ${formatSubagentTokens(agent.tokens)}` : ''}`
    }
  })
)
</script>

<template>
  <div v-if="summary.total > 0">
    <button
      type="button"
      class="nc-subagent-run"
      :aria-expanded="open ? 'true' : 'false'"
      aria-live="polite"
      @click="open = !open"
    >
      <!-- The group's identity glyph, fixed across every state — a settling row
           must not appear to change identity. State rides on the dot. -->
      <span class="nc-subagent-run__glyph">
        <Bot aria-hidden="true" class="nc-subagent-run__bot" />
      </span>
      <!-- `pulsing` is separate from the state so a group that is still working
           can show a failed sibling's colour without losing its in-flight cue. -->
      <span
        aria-hidden="true"
        :class="['nc-subagent-dot', `nc-subagent-dot--${alertState ?? verdictState}`, { 'nc-animate-pulse': working }]"
      />
      <span :class="['nc-subagent-run__headline', { 'nc-subagent-run__headline--working': working }]">{{ headline }}</span>
      <span class="nc-subagent-run__meta">{{ verdict }}{{ alert === null ? '' : ` +${alert}` }}<span
          v-if="clockStartedAt !== null"
          :aria-hidden="working ? 'true' : undefined"
        >{{ ' · ' }}<SubagentElapsed
            :started-at="clockStartedAt"
            :settled-at="summary.settledAt"
            :counting="working" /></span>{{ tokensText }}</span>
      <ChevronRight
        :class="['nc-subagent-run__chevron', open ? 'nc-subagent-run__chevron--open' : 'nc-subagent-run__chevron--hover-reveal']"
      />
    </button>
    <ul v-if="open" class="nc-subagent-run__list">
      <li v-for="row in rows" :key="row.agent.id" class="nc-subagent-run__child">
        <span
          aria-hidden="true"
          :class="['nc-subagent-dot', `nc-subagent-dot--${row.state}`, { 'nc-animate-pulse': row.state === 'working' }]"
        />
        <code :class="['nc-subagent-run__label', { 'nc-subagent-run__label--idle': row.state === 'idle' }]">{{
          row.agent.label
        }}</code>
        <span class="nc-subagent-run__child-meta">{{ row.detail }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* group/subagent-run flex min-h-6 w-full items-center gap-1.5 rounded-md py-0.5 text-left text-sm leading-relaxed text-muted-foreground hover:bg-accent/20 */
.nc-subagent-run {
  box-sizing: border-box;
  display: flex;
  min-height: 24px;
  width: 100%;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 2px 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.625;
  text-align: left;
  color: var(--nc-muted-foreground);
  cursor: pointer;
}
.nc-subagent-run:hover {
  background: color-mix(in srgb, var(--nc-accent) 20%, transparent);
}
.nc-subagent-run:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--nc-ring) 70%, transparent);
}
.nc-subagent-run__glyph {
  display: flex;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  color: var(--nc-muted-foreground);
}
.nc-subagent-run__bot {
  width: 14px;
  height: 14px;
}
/* size-1.5 shrink-0 rounded-full */
.nc-subagent-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 9999px;
}
.nc-subagent-dot--working {
  background: color-mix(in srgb, var(--nc-foreground) 70%, transparent);
}
.nc-subagent-dot--idle {
  background: color-mix(in srgb, var(--nc-muted-foreground) 40%, transparent);
}
.nc-subagent-dot--completed {
  background: color-mix(in srgb, var(--nc-muted-foreground) 60%, transparent);
}
.nc-subagent-dot--failed {
  background: var(--nc-destructive);
}
.nc-subagent-dot--stopped,
.nc-subagent-dot--unverifiable {
  background: var(--nc-muted-foreground);
}
.nc-subagent-run__headline {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-subagent-run__headline--working {
  color: color-mix(in srgb, var(--nc-foreground) 85%, transparent);
}
.nc-subagent-run__meta,
.nc-subagent-run__child-meta {
  flex-shrink: 0;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  color: var(--nc-muted-foreground);
}
.nc-subagent-run__chevron {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--nc-muted-foreground);
  transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-subagent-run__chevron--open {
  transform: rotate(90deg);
  opacity: 1;
}
.nc-subagent-run__chevron--hover-reveal {
  opacity: 0;
}
.nc-subagent-run:hover .nc-subagent-run__chevron--hover-reveal {
  opacity: 1;
}
/* mt-1 space-y-0.5 */
.nc-subagent-run__list {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.nc-subagent-run__list > * + * {
  margin-top: 2px;
}
/* flex items-center gap-1.5 py-0.5 */
.nc-subagent-run__child {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.nc-subagent-run__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  color: color-mix(in srgb, var(--nc-foreground) 80%, transparent);
}
.nc-subagent-run__label--idle {
  color: color-mix(in srgb, var(--nc-muted-foreground) 70%, transparent);
}
</style>
