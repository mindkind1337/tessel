<script setup>
// An agent asks to restart panes on another sign-in account (its account
// tools, src/main/agentAccounts.js and ../agentAccounts.js): who asks (its
// pane, project and machine), the account they go to (email, the sign-in:
// this PC's own, added in Tessel or a folder on an SSH host, its
// organization and plan), the agent, the panes (a summary by project, then
// each one: name, project, where, the account it is on now, what it is
// doing), what the agent says, and Refuse, Don't ask again from this agent,
// or Allow. Nothing restarts before Allow; no answer in time counts as
// Refuse. The keyboard starts on Refuse, and Allow is armed only a moment
// after the card shows (approvalArming.js): a click or an Enter meant for
// something else never allows it. Laid out like the terminal tools' card
// (AgentCommandApproval.vue).
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { t } from '../i18n'
import { planInfo } from '../claudePlan'
import { planName } from '../hostAccounts'
import { useApprovalArming, ARM_MS } from './approvalArming'

const props = defineProps({
  // { kind: 'accounts', agentLabel, explanation, timeoutMs,
  //   requester: { label, project, host },
  //   account: { agent, agentName, email, login, unknown },
  //   signIns: [{ id, kind, where, scope, org, plan, sub }],
  //   panes: [{ id, name, project, host, from, state, self }],
  //   projects: [{ name, count }], already: [{ id, name, project }] }
  card: { type: Object, required: true },
  // How long Allow stays unusable once shown (tests: 0).
  armMs: { type: Number, default: ARM_MS }
})
const emit = defineEmits(['answer'])
const refuseEl = ref(null)
const dialog = ref(null)
let previousFocus = null
const { armed, press, mayAllow } = useApprovalArming(props.armMs)

const account = computed(() => props.card.account || {})
const panes = computed(() => (Array.isArray(props.card.panes) ? props.card.panes : []))
const already = computed(() => (Array.isArray(props.card.already) ? props.card.already : []))
const signIns = computed(() => (Array.isArray(props.card.signIns) ? props.card.signIns : []))
const projects = computed(() => (Array.isArray(props.card.projects) ? props.card.projects : []))
const accountText = computed(() => account.value.email || (account.value.login ? `@${account.value.login}` : '') || t('app.agentAccounts.unknownAccount', 'an account with no name yet'))
const thisPc = () => t('app.agentAccounts.thisPc', 'this PC')
const hostText = (host) => (host ? t('app.agentAccounts.sshHost', 'SSH {{host}}', { host }) : thisPc())
// Which sign-in: this PC's own, added in Tessel, a folder on an SSH host.
function kindText(s) {
  if (s.kind === 'pc') return s.scope === 'tessel' ? t('app.agentAccounts.kindAdded', 'added in Tessel, on this PC') : t('app.agentAccounts.kindSystem', 'this PC’s own sign-in')
  if (s.scope === 'tessel') return t('app.agentAccounts.kindFolder', 'an account folder made by Tessel on SSH {{host}}', { host: s.where })
  if (s.scope === 'env') return t('app.agentAccounts.kindEnv', 'the login shell’s folder on SSH {{host}}', { host: s.where })
  return t('app.agentAccounts.kindHost', 'SSH {{host}}’s own sign-in', { host: s.where })
}
// Its plan as Anthropic last reported it (a Claude sign-in), else its login file's.
function planText(s) {
  const info = account.value.agent === 'claude' ? planInfo(s.sub) : null
  return info ? info.title : planName(s.plan) || t('app.agentAccounts.planUnknown', 'plan not known')
}
const signInLines = computed(() => signIns.value.map((s) => [kindText(s), s.org ? t('app.agentAccounts.org', 'organization {{org}}', { org: s.org }) : '', planText(s)].filter(Boolean).join(' · ')))
const requesterText = computed(() => {
  const r = props.card.requester || {}
  const parts = [t('app.agentAccounts.askedBy', 'Asked by agent pane “{{name}}”', { name: r.label || props.card.agentLabel })]
  if (r.project) parts.push(t('app.agentAccounts.inProject', 'project {{project}}', { project: r.project }))
  parts.push(hostText(r.host))
  return parts.join(' · ')
})
const title = computed(() =>
  panes.value.length === 1
    ? t('app.agentAccounts.titleOne', '{{agent}} wants to restart a pane on another account', { agent: props.card.agentLabel })
    : t('app.agentAccounts.title', '{{agent}} wants to restart {{count}} panes on another account', { agent: props.card.agentLabel, count: panes.value.length })
)
const resumeText = computed(() =>
  account.value.agent === 'claude'
    ? t('app.agentAccounts.resumeClaude', 'Each pane restarts in place on this account, its conversation resumed.')
    : t('app.agentAccounts.resumeOther', 'Each pane restarts in place on this account, in a new conversation: a {{agent}} conversation stays with its account.', { agent: account.value.agentName || account.value.agent || '' })
)
const projectsText = computed(() => projects.value.map((p) => t('app.agentAccounts.projectCount', '{{project}} ({{count}})', { project: p.name || t('app.agentAccounts.noProject', 'no project'), count: p.count })).join(', '))
const self = computed(() => panes.value.find((p) => p.self) || null)
// Its project, where it runs, the account it is on now.
function paneMeta(p) {
  return [p.project ? t('app.agentAccounts.inProject', 'project {{project}}', { project: p.project }) : '', hostText(p.host), p.from ? t('app.agentAccounts.from', 'now on {{account}}', { account: p.from }) : ''].filter(Boolean).join(' · ')
}
function stateText(p) {
  if (p.state === 'working') return t('app.agentAccounts.stateWorking', 'working now: its turn stops')
  if (p.state === 'approval') return t('app.agentAccounts.stateApproval', 'waiting for your approval: that question goes away')
  if (p.state === 'monitoring') return t('app.agentAccounts.stateMonitoring', 'background tasks running: they stop')
  return ''
}
const saysText = computed(() => t('app.agentAccounts.says', 'The agent says: “{{text}}”', { text: props.card.explanation }))
const selfText = computed(() => t('app.agentAccounts.self', '{{agent}} is in the list: it restarts last, once it has your answer.', { agent: props.card.agentLabel }))
const alreadyText = computed(() => t('app.agentAccounts.already', 'Already on this account, left as they are: {{names}}', { names: already.value.map((p) => p.name).join(', ') }))
const timeoutText = computed(() => {
  const ms = Number(props.card.timeoutMs) || 120000
  return ms >= 60000
    ? t('app.agentAccounts.timeout', 'No answer in {{minutes}} min counts as Refuse.', { minutes: Math.round(ms / 60000) })
    : t('app.agentAccounts.timeoutSeconds', 'No answer in {{seconds}} s counts as Refuse.', { seconds: Math.round(ms / 1000) })
})

function refuse(block = false) {
  emit('answer', block ? { allow: false, block: true } : { allow: false })
}
function allow(event) {
  if (!mayAllow(event)) return
  emit('answer', { allow: true })
}
onMounted(() => {
  previousFocus = document.activeElement
  nextTick(() => refuseEl.value?.focus())
})
onUnmounted(() => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
function trapTab(event) {
  const items = [...(dialog.value?.querySelectorAll('button:not(:disabled)') || [])]
  if (!items.length) return
  const i = items.indexOf(document.activeElement)
  if (event.shiftKey && i <= 0) {
    event.preventDefault()
    items.at(-1).focus()
  } else if (!event.shiftKey && i === items.length - 1) {
    event.preventDefault()
    items[0].focus()
  }
}
</script>

<template>
  <div class="help-backdrop confirm-backdrop" data-test="agent-account-approval" @pointerdown.self="refuse()">
    <div
      ref="dialog"
      class="help-card confirm-card aaa-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="aaa-title"
      @focusin.stop
      @keydown.escape.prevent.stop="refuse()"
      @keydown.tab.stop="trapTab"
    >
      <h2 id="aaa-title" class="confirm-title">{{ title }}</h2>
      <p class="confirm-text aaa-info" data-test="agent-account-requester">{{ requesterText }}</p>
      <dl class="confirm-details aaa-details" data-test="agent-account-target">
        <dt>{{ t('app.agentAccounts.account', 'Account') }}</dt>
        <dd>{{ accountText }}</dd>
        <template v-for="(line, i) in signInLines" :key="i">
          <dt>{{ t('app.agentAccounts.signIn', 'Sign-in') }}</dt>
          <dd>{{ line }}</dd>
        </template>
        <dt>{{ t('app.agentAccounts.agent', 'Agent') }}</dt>
        <dd>{{ account.agentName }}</dd>
        <dt v-if="projectsText">{{ t('app.agentAccounts.projects', 'Projects') }}</dt>
        <dd v-if="projectsText" data-test="agent-account-projects">{{ projectsText }}</dd>
      </dl>
      <p class="confirm-text aaa-line">{{ resumeText }}</p>
      <ul class="aaa-panes" data-test="agent-account-panes">
        <li v-for="p in panes" :key="p.id" class="aaa-pane">
          <span class="aaa-name">{{ p.name }}</span>
          <span class="aaa-meta">{{ paneMeta(p) }}</span>
          <span v-if="stateText(p)" class="aaa-warn">{{ stateText(p) }}</span>
        </li>
      </ul>
      <p v-if="self" class="confirm-text aaa-info">{{ selfText }}</p>
      <p v-if="already.length" class="confirm-text aaa-info">{{ alreadyText }}</p>
      <blockquote v-if="card.explanation" class="aaa-says" data-test="agent-account-says">{{ saysText }}</blockquote>
      <p class="confirm-text aaa-info">{{ timeoutText }}</p>
      <div class="confirm-actions">
        <button ref="refuseEl" class="confirm-btn" data-test="agent-account-refuse" @click="refuse()">{{ t('app.agentAccounts.refuse', 'Refuse') }}</button>
        <button class="confirm-btn" data-test="agent-account-block" @click="refuse(true)">{{ t('app.agentAccounts.block', 'Don’t ask again from this agent') }}</button>
        <button class="confirm-btn primary" data-test="agent-account-allow" :disabled="!armed" @pointerdown="press" @click="allow">{{ t('app.agentAccounts.allow', 'Allow') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Wider than a confirmation: an email, a sign-in and a list of panes. */
.aaa-card {
  width: min(560px, 92vw);
}
.aaa-details dd {
  word-break: normal;
  overflow-wrap: anywhere;
}
.aaa-line {
  margin: 4px 0;
}
.aaa-panes {
  margin: 6px 0;
  padding: 0;
  list-style: none;
  max-height: 40vh;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.aaa-pane {
  display: grid;
  gap: 1px;
  padding: 6px 10px;
}
.aaa-pane + .aaa-pane {
  border-top: 1px solid var(--border);
}
.aaa-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.aaa-meta {
  color: var(--text-dim);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.aaa-info {
  color: var(--text-dim);
  font-size: 12px;
}
.aaa-warn {
  color: var(--warning, #d29922);
  font-size: 12px;
}
/* What the agent says: its words, set apart from the facts above. */
.aaa-says {
  margin: 8px 0 4px;
  padding: 4px 10px;
  border-left: 3px solid var(--border-strong, var(--border));
  color: var(--text-dim);
  font-size: 12px;
  font-style: italic;
  overflow-wrap: anywhere;
}
</style>
