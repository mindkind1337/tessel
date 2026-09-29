<script setup>
// What an agent row's hover card shows, laid out like Orca's worktree details
// hover (sidebar/WorktreeCardMeta.tsx, WorktreeCardHoverIdentityHeader.tsx,
// WorktreeCardDetailSection.tsx; MIT, Copyright (c) 2026 Lovecast Inc.): the
// task as the heading, the agent under it, its state with the dot, then
// Tessel's own sections (team, pane) with Orca's section header and inset
// body. It replaces the row's native tooltip.
import { computed } from 'vue'
import { Users, SquareTerminal, Bot, MousePointerClick, Cpu } from 'lucide-vue-next'
import { paneModels } from '../../paneModels'
import BrandIcon from '../BrandIcon.vue'
import AgentStateDot from './AgentStateDot.vue'
import { agentStateLabel } from '../../sidebarModel'
import { t } from '../../i18n'

const props = defineProps({
  row: { type: Object, required: true },
  teamLabel: { type: String, default: '' },
  pickHint: { type: String, default: '' },
  childCount: { type: Number, default: 0 },
  runningCount: { type: Number, default: 0 }
})

const heading = computed(() => props.row.subline || props.row.primary || props.row.title)
// The model the agent's pane header finds (TerminalPane writes paneModels).
const modelLine = computed(() => {
  const model = props.row.kind === 'agent' ? paneModels[props.row.id] : ''
  return model ? t('pane.model.title', 'Model: {{model}}', { model }) : ''
})
const showAgentLine = computed(() => !!props.row.title && props.row.title !== heading.value)
const stateLabel = computed(() => {
  if (props.row.kind !== 'agent') return t('sidebar.row.terminal', 'Terminal')
  return props.row.sleeping ? t('sidebar.status.sleeping', 'Sleeping') : agentStateLabel(props.row.dotState)
})
const stateLine = computed(() =>
  props.row.time ? t('sidebar.hover.stateSince', '{{state}} · {{time}}', { state: stateLabel.value, time: props.row.time }) : stateLabel.value
)
const detail = computed(() => (props.row.secondary && props.row.secondary !== stateLabel.value ? props.row.secondary : ''))
const teamLine = computed(() => {
  if (!props.row.team) return ''
  const team = props.teamLabel || props.row.team
  return props.row.lead ? t('sidebar.hover.teamLead', '{{team}} (lead)', { team }) : team
})
// A worker started by a coordinator (orchestration).
const workerLine = computed(() => {
  const w = props.row.workerOf
  if (!w) return ''
  const coordinator = w.label || (w.num ? `#${w.num}` : '')
  if (w.status === 'done') return t('sidebar.hover.workerDone', 'Worker of {{coordinator}}: reported done', { coordinator })
  if (w.status === 'failed') return t('sidebar.hover.workerFailed', 'Worker of {{coordinator}}: reported failed', { coordinator })
  return t('sidebar.hover.workerOf', 'Worker of {{coordinator}}', { coordinator })
})
const unreadLine = computed(() => {
  const count = props.row.teamUnread || 0
  if (!count) return ''
  return count > 1
    ? t('sidebar.agentRow.unread', '{{count}} team messages this agent has not read yet (it reads them with its team tools)', { count })
    : t('sidebar.agentRow.unread', '{{count}} team message this agent has not read yet (it reads them with its team tools)', { count })
})
const paneLine = computed(() => (props.row.num ? t('sidebar.card.pane', 'Pane {{num}}', { num: props.row.num }) : ''))
const childLine = computed(() => {
  const count = props.childCount
  if (!count) return ''
  const total =
    count === 1
      ? t('sidebar.hover.subAgents', '{{count}} sub-agent', { count })
      : t('sidebar.hover.subAgents', '{{count}} sub-agents', { count })
  return props.runningCount ? t('sidebar.hover.subAgentsRunning', '{{total}} · {{running}} running', { total, running: props.runningCount }) : total
})
</script>

<template>
  <div class="hc-body" data-agent-hover-details="">
    <div class="hc-identity">
      <div class="hc-title">{{ heading }}</div>
      <div v-if="showAgentLine" class="hc-agent">
        <BrandIcon :kind="row.iconKind" :accent="row.accent" :label="null" :size="12" />
        <span>{{ row.title }}</span>
      </div>
      <div v-if="modelLine" class="hc-agent hc-model" data-hover-model="">
        <Cpu :size="12" aria-hidden="true" />
        <span v-text="modelLine"></span>
      </div>
    </div>

    <div class="hc-status">
      <AgentStateDot :state="row.dotState" :tooltip="false" />
      <span class="hc-status-label" v-text="stateLine"></span>
    </div>
    <div v-if="detail" class="hc-detail" v-text="detail"></div>
    <div v-if="row.toolsDown" class="hc-warn">
      {{ t('sidebar.agentRow.toolsDownHint', 'Its team tools (tessel-team) are not connected: it cannot read or send team messages. Restart it (right-click its pane, Restart).') }}
    </div>

    <section v-if="pickHint" class="hc-section">
      <div class="hc-section-title">
        <MousePointerClick :size="12" aria-hidden="true" />
        <span>{{ t('sidebar.hover.pick', 'Team pick') }}</span>
      </div>
      <div class="hc-section-body" v-text="pickHint"></div>
    </section>

    <section v-if="teamLine" class="hc-section" data-hover-team="">
      <div class="hc-section-title">
        <Users :size="12" aria-hidden="true" />
        <span>{{ t('sidebar.hover.team', 'Team') }}</span>
      </div>
      <div class="hc-section-body hc-lines">
        <div class="hc-strong" v-text="teamLine"></div>
        <div v-if="workerLine" class="hc-muted" data-hover-worker="" v-text="workerLine"></div>
        <div v-if="unreadLine" class="hc-muted" v-text="unreadLine"></div>
      </div>
    </section>

    <section v-if="childLine" class="hc-section">
      <div class="hc-section-title">
        <Bot :size="12" aria-hidden="true" />
        <span>{{ t('sidebar.hover.subAgentsTitle', 'Sub-agents') }}</span>
      </div>
      <div class="hc-section-body" v-text="childLine"></div>
    </section>

    <div v-if="paneLine" class="hc-footer">
      <SquareTerminal :size="12" aria-hidden="true" />
      <span v-text="paneLine"></span>
    </div>
  </div>
</template>
