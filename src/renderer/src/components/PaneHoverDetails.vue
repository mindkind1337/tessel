<script setup>
// What a pane header's hover card shows, laid out like the sidebar's agent
// card (AgentHoverDetails, after Orca's worktree details hover; MIT,
// Copyright (c) 2026 Lovecast Inc.): the pane's name as the heading, the
// agent (or shell) with its icon, its model and conversation under it, its
// state with the dot, its team and a muted hint. It
// replaces the header title's native tooltip.
import { computed } from 'vue'
import { Users, SquareTerminal, Cpu, MessageSquareText, GitBranch } from 'lucide-vue-next'
import BrandIcon from './BrandIcon.vue'
import AgentStateDot from './sidebar/AgentStateDot.vue'
import { t } from '../i18n'

const props = defineProps({
  // Built by TerminalPane: { heading, agentName, iconKind, accent, model,
  // conversation, branch, state: { dot, label } | null, stateDetail, warn,
  // yolo, team: { name, lead } | null, session }
  info: { type: Object, required: true }
})

const modelLine = computed(() => (props.info.model ? t('pane.model.title', 'Model: {{model}}', { model: props.info.model }) : ''))
const branchLine = computed(() =>
  props.info.branch ? t('pane.title.branch', 'Branch: {{branch}} (separate copy)', { branch: props.info.branch }) : ''
)
const teamLine = computed(() => {
  const team = props.info.team
  if (!team) return ''
  return team.lead ? t('sidebar.hover.teamLead', '{{team}} (lead)', { team: team.name }) : team.name
})
const sessionLine = computed(() => (props.info.session ? t('pane.status.session', 'Session {{id}}', { id: props.info.session }) : ''))
</script>

<template>
  <div class="hc-body" data-pane-hover-details="" role="group" :aria-label="info.agentName ? `${info.heading} (${info.agentName})` : info.heading">
    <div class="hc-identity">
      <div class="hc-title hc-title-row" data-hover-heading="">
        <BrandIcon :kind="info.iconKind" :accent="info.accent" :label="info.agentName || null" :size="14" />
        <span v-text="info.heading"></span>
      </div>
      <div v-if="modelLine" class="hc-agent hc-model" data-hover-model="">
        <Cpu :size="12" aria-hidden="true" />
        <span v-text="modelLine"></span>
      </div>
      <div v-if="info.conversation" class="hc-agent" data-hover-conversation="">
        <MessageSquareText :size="12" aria-hidden="true" />
        <span v-text="info.conversation"></span>
      </div>
      <div v-if="branchLine" class="hc-agent hc-branch-line">
        <GitBranch :size="12" aria-hidden="true" />
        <span v-text="branchLine"></span>
      </div>
    </div>

    <template v-if="info.state">
      <div class="hc-status" data-hover-state="">
        <AgentStateDot :state="info.state.dot" :tooltip="false" />
        <span class="hc-status-label" v-text="info.state.label"></span>
      </div>
      <div v-if="info.stateDetail" class="hc-detail" v-text="info.stateDetail"></div>
    </template>
    <div v-if="info.warn" class="hc-warn" v-text="info.warn"></div>
    <div v-if="info.yolo" class="hc-warn" v-text="info.yolo"></div>

    <section v-if="teamLine" class="hc-section" data-hover-team="">
      <div class="hc-section-title">
        <Users :size="12" aria-hidden="true" />
        <span>{{ t('sidebar.hover.team', 'Team') }}</span>
      </div>
      <div class="hc-section-body hc-strong" v-text="teamLine"></div>
    </section>

    <div v-if="sessionLine" class="hc-footer" data-hover-pane="">
      <SquareTerminal :size="12" aria-hidden="true" />
      <span v-if="sessionLine" class="hc-session" v-text="sessionLine"></span>
    </div>
    <div class="hc-hint" data-hover-hint="">
      {{ t('pane.title.hint', 'Double-click to rename. Drag the header to move the pane. More in the … menu') }}
    </div>
  </div>
</template>
