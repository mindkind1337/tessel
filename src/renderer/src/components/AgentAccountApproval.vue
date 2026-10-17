<script setup>
// An agent asks to restart panes on another sign-in account (its account
// tools, src/main/agentAccounts.js and ../agentAccounts.js): the panes (name,
// project, where, the account each one is on now, what it is doing), the
// agent, the account they go to (email and plan) and Allow or Refuse.
// Nothing restarts before Allow; no answer in time counts as Refuse. The
// keyboard starts on Refuse: an Enter typed for something else never allows
// it. Laid out like the terminal tools' card (AgentCommandApproval.vue).
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { t } from '../i18n'
import { planInfo } from '../claudePlan'
import { planName } from '../hostAccounts'

const props = defineProps({
  // { kind: 'accounts', agentLabel, explanation, timeoutMs,
  //   account: { agent, agentName, email, login, unknown, plan, sub, where: [host label, '' for this PC] },
  //   panes: [{ id, name, project, host, from, state, self }], already: [{ id, name, project }] }
  card: { type: Object, required: true }
})
const emit = defineEmits(['answer'])
const refuseEl = ref(null)
const dialog = ref(null)
let previousFocus = null

const account = computed(() => props.card.account || {})
const panes = computed(() => (Array.isArray(props.card.panes) ? props.card.panes : []))
const already = computed(() => (Array.isArray(props.card.already) ? props.card.already : []))
const accountText = computed(() => account.value.email || (account.value.login ? `@${account.value.login}` : '') || t('app.agentAccounts.unknownAccount', 'an account with no name yet'))
// Its plan as Anthropic last reported it (a Claude account), else its login file's.
const planText = computed(() => {
  const a = account.value
  const info = a.agent === 'claude' ? planInfo(a.sub) : null
  return info ? info.title : planName(a.plan) || t('app.agentAccounts.planUnknown', 'plan not known')
})
const thisPc = () => t('app.agentAccounts.thisPc', 'this PC')
const whereText = computed(() => (Array.isArray(account.value.where) ? account.value.where : []).map((w) => (w ? t('app.agentAccounts.sshHost', 'SSH {{host}}', { host: w }) : thisPc())).join(', '))
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
const self = computed(() => panes.value.find((p) => p.self) || null)
const minutes = computed(() => Math.max(1, Math.round((Number(props.card.timeoutMs) || 120000) / 60000)))
function paneWhere(p) {
  return p.host ? t('app.agentAccounts.sshHost', 'SSH {{host}}', { host: p.host }) : thisPc()
}
// Its project, where it runs, the account it is on now.
function paneMeta(p) {
  return [p.project ? t('app.agentAccounts.inProject', 'project {{project}}', { project: p.project }) : '', paneWhere(p), p.from ? t('app.agentAccounts.from', 'now on {{account}}', { account: p.from }) : ''].filter(Boolean).join(' · ')
}
const selfText = computed(() => t('app.agentAccounts.self', '{{agent}} is in the list: it restarts last, once it has your answer.', { agent: props.card.agentLabel }))
const timeoutText = computed(() => t('app.agentAccounts.timeout', 'No answer in {{minutes}} min counts as Refuse.', { minutes: minutes.value }))
function stateText(p) {
  if (p.state === 'working') return t('app.agentAccounts.stateWorking', 'working now: its turn stops')
  if (p.state === 'approval') return t('app.agentAccounts.stateApproval', 'waiting for your approval: that question goes away')
  if (p.state === 'monitoring') return t('app.agentAccounts.stateMonitoring', 'background tasks running: they stop')
  return ''
}
const alreadyText = computed(() => t('app.agentAccounts.already', 'Already on this account, left as they are: {{names}}', { names: already.value.map((p) => p.name).join(', ') }))

function answer(allow) {
  emit('answer', { allow: allow === true })
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
  <div class="help-backdrop confirm-backdrop" data-test="agent-account-approval" @pointerdown.self="answer(false)">
    <div
      ref="dialog"
      class="help-card confirm-card aaa-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="aaa-title"
      @focusin.stop
      @keydown.escape.prevent.stop="answer(false)"
      @keydown.tab.stop="trapTab"
    >
      <h2 id="aaa-title" class="confirm-title">{{ title }}</h2>
      <p v-if="card.explanation" class="confirm-text aaa-line"><strong>{{ t('app.agentTerminal.explanation', 'Explanation') }}:</strong> {{ card.explanation }}</p>
      <dl class="confirm-details aaa-details" data-test="agent-account-target">
        <dt>{{ t('app.agentAccounts.account', 'Account') }}</dt>
        <dd>{{ accountText }} · {{ planText }}</dd>
        <dt>{{ t('app.agentAccounts.agent', 'Agent') }}</dt>
        <dd>{{ account.agentName }}</dd>
        <dt v-if="whereText">{{ t('app.agentAccounts.where', 'Signed in on') }}</dt>
        <dd v-if="whereText">{{ whereText }}</dd>
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
      <p class="confirm-text aaa-info">{{ timeoutText }}</p>
      <div class="confirm-actions">
        <button ref="refuseEl" class="confirm-btn" data-test="agent-account-refuse" @click="answer(false)">{{ t('app.agentAccounts.refuse', 'Refuse') }}</button>
        <button class="confirm-btn primary" data-test="agent-account-allow" @click="answer(true)">{{ t('app.agentAccounts.allow', 'Allow') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Wider than a confirmation: an email, a plan and a list of panes. */
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
</style>
