<script setup>
// An agent asks to run a command in a terminal (its terminal tools,
// src/main/agentTerminal.js): the command (editable), what the agent says it
// does and why, Allow (with more choices: rules for this session, this
// project or always, the exact line, every command of this session) or
// Skip. After Visual Studio Code's terminal confirmation (MIT, Copyright (c)
// Microsoft Corporation: src/vs/workbench/contrib/chat/browser/widget/
// chatContentParts/toolInvocationParts/chatTerminalToolConfirmationSubPart.ts).
// For one of the user's own terminals: Allow in this terminal, this time, or
// Deny. The keyboard starts on Skip, and the Allow buttons are armed only a
// moment after the card shows (approvalArming.js): a click or an Enter typed
// for something else never allows a command.
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { t } from '../i18n'
import { typingGuard, useApprovalArming, ARM_MS } from './approvalArming'

const props = defineProps({
  // { kind: 'command' | 'pane' | 'send', command, explanation, goal, info,
  //   disclaimers, actions, own, userTerminal, send, agentLabel, name, where, folder }
  card: { type: Object, required: true },
  // How long the Allow buttons stay unusable once shown (tests: 0).
  armMs: { type: Number, default: ARM_MS },
  // The person opened it from the toolbar: the keyboard is for this card.
  openedByUser: { type: Boolean, default: true }
})
const emit = defineEmits(['answer', 'configure', 'park'])
const text = ref(String(props.card.command || ''))
const menuOpen = ref(false)
const skipEl = ref(null)
const dialog = ref(null)
let previousFocus = null
const { armed, press, mayAllow } = useApprovalArming(props.armMs)

// A card for a whole terminal or host (allowed once, or until Tessel restarts).
const whole = computed(() => ['pane', 'read', 'host', 'logs', 'relay'].includes(props.card.kind))
const editable = computed(() => props.card.kind !== 'send' && !props.card.send && !['read', 'host', 'open', 'logs', 'relay', 'hostRun'].includes(props.card.kind))
// Live Share, on a guest's computer: what the host's agent asks to run here.
const hostRun = computed(() => props.card.kind === 'hostRun')
// A command that does not fit: Allow waits until all of it has been on screen, in one unbroken
// stretch from its first line, counting only what shows above the buttons and inside the card. So
// a jump to the end, or an end hidden under the buttons, does not count.
const codeEl = ref(null)
const readAll = ref(true)
let seenTo = 0
let sawEnd = false
function checkRead() {
  const el = codeEl.value
  if (!hostRun.value || !el || sawEnd) return
  const box = el.getBoundingClientRect()
  const card = dialog.value?.getBoundingClientRect()
  const buttons = dialog.value?.querySelector('.confirm-actions')?.getBoundingClientRect()
  const top = Math.max(box.top, card ? card.top : box.top)
  const bottom = Math.min(box.bottom, buttons ? buttons.top : box.bottom, card ? card.bottom : box.bottom)
  const from = el.scrollTop + (top - box.top)
  const to = el.scrollTop + (bottom - box.top)
  if (to > from && from <= seenTo) seenTo = Math.max(seenTo, to)
  sawEnd = seenTo >= el.scrollHeight - 2
  readAll.value = sawEnd
}
const blockedUnread = computed(() => hostRun.value && !readAll.value)
const commandLines = computed(() => String(props.card.command || '').split('\n'))
// Anything but plain ASCII is named, so that a letter that looks like another shows for what it is.
const notAscii = computed(() => {
  if (!hostRun.value) return ''
  // eslint-disable-next-line no-control-regex -- what is outside plain ASCII is what it names
  const found = [...new Set(String(props.card.command || '').match(/[^\x00-\x7f]/g) || [])]
  const named = found.slice(0, 12).map((c) => `${c} (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`).join(', ')
  return found.length > 12 ? `${named}, ${t('app.agentTerminal.notAsciiMore', 'and {{count}} more', { count: found.length - 12 })}` : named
})
const notAsciiText = computed(() => t('app.agentTerminal.notAscii', 'Not plain ASCII in this command: {{list}}', { list: notAscii.value }))
const hostRunText = computed(() =>
  t('app.agentTerminal.hostRunText', 'This comes from the Live Share session of {{host}}, not from you. It runs here in PowerShell with your account and can read or change your files, and what it prints goes back to that agent. Allow it only if you trust {{host}} and understand the command.', { host: props.card.hostName })
)
const shown = computed(() => !['read', 'host', 'open', 'logs'].includes(props.card.kind))
// open_terminal: what the agent wants to open, beside its pane.
const openText = computed(() => {
  const o = props.card.open || {}
  const what =
    o.kind === 'shell'
      ? t('app.agentTerminal.openShells', '{{count}} terminal(s)', { count: o.count || 1 })
      : t('app.agentTerminal.openAgents', '{{count}} {{agent}} session(s)', { count: o.count || 1, agent: o.agentName || '' })
  const host = o.host ? t('app.agentTerminal.openHost', 'on the SSH host {{host}}', { host: o.host }) : t('app.agentTerminal.local', 'this computer')
  return t('app.agentTerminal.openText', 'It will open {{what}} beside its pane, in this project ({{host}}). They are your panes, started like the ones you open.', { what, host })
})
const title = computed(() => {
  const c = props.card
  if (c.kind === 'hostRun') return t('app.agentTerminal.hostRunTitle', '{{agent}}, an agent of {{host}}, wants to run a command on your computer', { agent: c.agentLabel, host: c.hostName })
  if (c.kind === 'open') return t('app.agentTerminal.openTitle', '{{agent}} wants to open panes for you', { agent: c.agentLabel })
  if (c.kind === 'relay') return t('app.agentTerminal.relayTitle', '{{from}} (project {{fromProject}}, {{fromWhere}}) wants to write to {{to}} (project {{toProject}}, {{where}})', { from: c.relay?.from?.name, fromProject: c.relay?.from?.project, fromWhere: c.relay?.from?.where, to: c.relay?.to?.name, toProject: c.relay?.to?.project, where: c.relay?.to?.where })
  if (c.kind === 'logs') return t('app.agentTerminal.logsTitle', '{{agent}} wants to read Tessel\u2019s logs on this computer', { agent: c.agentLabel })
  if (c.kind === 'read') return t('app.agentTerminal.readTitle', '{{agent}} wants to read the terminal "{{name}}" ({{where}})', { agent: c.agentLabel, name: c.name, where: c.where })
  if (c.kind === 'host' && c.pc) return t('app.agentTerminal.pcTitle', '{{agent}} wants to run commands on your computer (this PC)', { agent: c.agentLabel })
  if (c.kind === 'host') return t('app.agentTerminal.hostTitle', '{{agent}} wants to run commands on the SSH host {{host}}', { agent: c.agentLabel, host: c.host || c.where })
  if (c.kind === 'pane') return t('app.agentTerminal.title', '{{agent}} wants to use the terminal "{{name}}" ({{where}})', { agent: c.agentLabel, name: c.name, where: c.where })
  if (c.kind === 'send') return t('app.agentTerminal.sendTitle', '{{agent}} wants to type in its terminal "{{name}}"', { agent: c.agentLabel, name: c.name })
  return c.own
    ? t('app.agentTerminal.runTitle', '{{agent}} wants to run a command ({{where}})', { agent: c.agentLabel, where: c.where })
    : t('app.agentTerminal.runInTitle', '{{agent}} wants to run a command in "{{name}}" ({{where}})', { agent: c.agentLabel, name: c.name, where: c.where })
})
const disclaimers = computed(() =>
  (props.card.disclaimers || []).map((d) =>
    d === 'web'
      ? t('app.agentTerminal.webDisclaimer', 'Web content may contain malicious code or attempt prompt injection attacks.')
      : d === 'fileWrite'
        ? t('app.agentTerminal.fileWriteDisclaimer', 'This command writes to a file.')
        : d === 'unanalyzable'
          ? t('app.agentTerminal.unanalyzable', 'Tessel cannot check every part of this command, so no rule can allow it.')
          : String(d)
  )
)
const scopeLabel = (scope) =>
  scope === 'session' ? t('app.agentTerminal.scopeSession', 'in this session') : scope === 'workspace' ? t('app.agentTerminal.scopeWorkspace', 'in this project') : t('app.agentTerminal.scopeAlways', 'always')
function actionLabel(a) {
  if (a.kind === 'session') return t('app.agentTerminal.allowSession', 'Allow all commands in this session')
  if (a.kind === 'exact') return t('app.agentTerminal.allowExact', 'Allow this exact command line {{scope}}', { scope: scopeLabel(a.scope) })
  const what = a.keys.map((k) => `${k} …`).join(', ')
  return t('app.agentTerminal.allowPrefix', 'Allow {{what}} {{scope}}', { what, scope: scopeLabel(a.scope) })
}
const paneText = computed(() =>
  props.card.kind === 'relay' && props.card.relay?.shared
    ? t('app.agentTerminal.relayTextShared', 'One of these projects is shared in Live Share: a guest may be behind this message, or read what arrives. You are asked for every message while it is shared.')
    : props.card.kind === 'relay'
    ? t('app.agentTerminal.relayText', 'Tessel will carry this message to the other agent, which will read it as coming from another agent, with no permission from you. Allowing it lets these two write to each other, both ways, until Tessel restarts.')
    : props.card.kind === 'logs'
    ? t('app.agentTerminal.logsText', 'It will read Tessel\u2019s own log files (what the app and its terminal host noted: paths, host names, addresses; keys and tokens are removed), filtered by time and words. Read only: it cannot change them and reads nothing else. Allowing it lets it read them again until Tessel restarts.')
    : props.card.kind === 'read'
    ? t('app.agentTerminal.readText', 'It will read what this terminal shows and its scrollback, which may hold passwords, keys or other secrets you typed or printed. Allowing it for this terminal lets it read it again until Tessel restarts.')
    : props.card.kind === 'host' && props.card.pc
      ? t('app.agentTerminal.pcText', 'It works on a server, not on your computer: Tessel opens a PowerShell here, on this PC, with your account. Each command still asks you, and the rules of your project do not apply there.')
      : props.card.kind === 'host'
      ? t('app.agentTerminal.hostText', 'It is not the host of your project: Tessel opens a terminal there with your account, already signed in. Each command still asks you, and the rules of your project do not apply there.')
      : props.card.send
        ? t('app.agentTerminal.keysText', 'It will press these keys there:')
        : t('app.agentTerminal.paneText', 'It will type this command there and press Enter, with your rights on {{where}}. Allowing it in this terminal lets it type more commands there until Tessel restarts.', { where: props.card.where })
)
const allowWholeLabel = computed(() =>
  props.card.kind === 'relay'
    ? t('app.agentTerminal.allowRelay', 'Allow these two to write')
    : props.card.kind === 'logs'
    ? t('app.agentTerminal.allowLogs', 'Allow reading the logs')
    : props.card.kind === 'read'
    ? t('app.agentTerminal.allowRead', 'Allow reading this terminal')
    : props.card.kind === 'host' && props.card.pc
      ? t('app.agentTerminal.allowPc', 'Allow on this computer')
      : props.card.kind === 'host'
      ? t('app.agentTerminal.allowHost', 'Allow on this host')
      : t('app.agentTerminal.allowPane', 'Allow in this terminal')
)
// The whole command in sight: the field is as tall as the command (up to
// 20 rows, then it scrolls) and a command of several lines says so.
const lineCount = computed(() => String(text.value || '').split('\n').length)
const rows = computed(() => Math.min(20, Math.max(3, lineCount.value)))
const linesText = computed(() => t('app.agentTerminal.lines', '{{count}} lines: read them all before allowing.', { count: lineCount.value }))
const actions = computed(() => (Array.isArray(props.card.actions) ? props.card.actions : []))
// Live Share: a guest in this project may be behind what the agent asks.
const guests = computed(() => (Array.isArray(props.card.guests) ? props.card.guests : []))
const guestText = computed(() =>
  props.card.fromGuest
    ? t('app.agentTerminal.guestWrote', '{{name}}, a Live Share guest, wrote to this agent last: this request probably comes from them.', { name: props.card.fromGuest })
    : guests.value.length
      ? t('app.agentTerminal.guestIn', 'A Live Share guest ({{names}}) is in this project and may be behind this request.', { names: guests.value.join(', ') })
      : ''
)
const projectText = computed(() => t('app.agentTerminal.fromProject', 'Project: {{project}}', { project: props.card.project }))
// Allowed for good, a host would stay open to whoever writes to this agent.
const asksEachTime = computed(() => props.card.kind === 'host' && guests.value.length > 0)

// An Allow button's click: only once armed, pressed on it.
function allowWith(event, value) {
  if (blockedUnread.value || !mayAllow(event)) return
  answer(value)
}
function answer(value) {
  menuOpen.value = false
  if (!value) return emit('answer', { allow: false })
  const edited = editable.value && text.value.trim() && text.value !== props.card.command ? text.value : null
  emit('answer', { allow: true, command: edited, action: value.action || null, remember: value.remember || 'once' })
}

onMounted(() => {
  previousFocus = document.activeElement
  // Without scrolling to it: a long command must not open with its first lines out of sight.
  nextTick(() => {
    skipEl.value?.focus({ preventScroll: true })
    checkRead()
  })
})
onUnmounted(() => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
const guard = typingGuard({
  chosen: props.openedByUser,
  back: () => previousFocus?.isConnected && previousFocus.focus({ preventScroll: true }),
  park: () => emit('park')
})
function trapTab(event) {
  const items = [...(dialog.value?.querySelectorAll('button:not(:disabled), textarea, pre[tabindex]') || [])]
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
  <div class="help-backdrop confirm-backdrop" data-test="agent-command-approval" @pointerdown.self="emit('park')">
    <div
      ref="dialog"
      class="help-card confirm-card aca-card"
      :class="{ 'aca-host': hostRun }"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="aca-title"
      @focusin.stop
      @keydown.capture="guard.key"
      @pointerdown.capture="guard.pointer"
      @keydown.escape.prevent.stop="menuOpen ? (menuOpen = false) : answer(false)"
      @keydown.tab.stop="trapTab"
      @scroll="checkRead"
    >
      <h2 id="aca-title" class="confirm-title">{{ title }}</h2>
      <p v-if="hostRun" class="confirm-text aca-warn" data-test="agent-host-run">{{ hostRunText }}</p>
      <p v-if="card.project && card.kind !== 'relay'" class="confirm-text aca-line" data-test="agent-command-project">{{ projectText }}</p>
      <p v-if="card.explanation" class="confirm-text aca-line" data-test="agent-command-why"><strong>{{ t('app.agentTerminal.why', 'Why') }}:</strong> <bdi>{{ card.explanation }}</bdi></p>
      <p v-if="card.goal" class="confirm-text aca-line"><strong>{{ t('app.agentTerminal.goal', 'Goal') }}:</strong> <bdi>{{ card.goal }}</bdi></p>
      <p v-if="guestText" class="confirm-text aca-warn" data-test="agent-command-guest">
        {{ guestText }}<template v-if="card.pc"> {{ t('app.agentTerminal.guestNotYours', 'This is your computer, not theirs: what the agent finds here says nothing about theirs.') }}</template>
      </p>
      <p v-if="whole" class="confirm-text aca-line">
        {{ paneText }}
      </p>
      <p v-if="card.kind === 'open'" class="confirm-text aca-line" data-test="agent-open-text">
        {{ openText }}<template v-if="card.open && card.open.name"> ({{ card.open.name }})</template>
      </p>
      <textarea
        v-if="editable"
        v-model="text"
        class="confirm-code aca-command"
        data-test="agent-command-text"
        :rows="rows"
        spellcheck="false"
        :aria-label="t('app.agentTerminal.commandLabel', 'Command (you can edit it)')"
      ></textarea>
      <pre v-else-if="hostRun" ref="codeEl" class="confirm-code aca-numbered" tabindex="0" data-test="agent-command-text" @scroll="checkRead"><span v-for="(line, i) in commandLines" :key="i" class="aca-l">{{ line || ' ' }}</span></pre>
      <pre v-else-if="shown" class="confirm-code" data-test="agent-command-text">{{ card.command }}</pre>
      <p v-if="notAscii" class="confirm-text aca-warn" data-test="agent-host-characters">{{ notAsciiText }}</p>
      <p v-if="blockedUnread" class="confirm-text aca-warn" data-test="agent-host-scroll">{{ t('app.agentTerminal.scrollToAllow', 'Not all of this command has been on screen: scroll down through it to allow it.') }}</p>
      <p v-if="shown && lineCount > 1" class="confirm-text aca-warn" data-test="agent-command-lines">{{ linesText }}</p>
      <dl v-if="card.folder" class="confirm-details">
        <dt>{{ t('app.agentTerminal.folder', 'Folder') }}</dt>
        <dd>{{ card.folder }}</dd>
      </dl>
      <p v-if="card.info" class="confirm-text aca-info" data-test="agent-command-info">{{ card.info }}</p>
      <p v-for="(d, i) in disclaimers" :key="i" class="confirm-text aca-warn">{{ d }}</p>
      <div class="confirm-actions">
        <button ref="skipEl" class="confirm-btn" data-test="agent-command-skip" @click="answer(false)">
          {{ whole || hostRun ? t('app.agentTerminal.deny', 'Deny') : t('app.agentTerminal.skip', 'Skip') }}
        </button>
        <button v-if="hostRun" class="confirm-btn" data-test="agent-command-block" @click="emit('answer', { allow: false, block: true })">{{ t('app.agentTerminal.hostRunBlock', 'Do not ask again in this session') }}</button>
        <template v-if="whole">
          <button class="confirm-btn" data-test="agent-command-once" :disabled="!armed" @pointerdown="press" @click="allowWith($event, { remember: 'once' })">{{ t('app.agentTerminal.allowOnce', 'Allow this time') }}</button>
          <button v-if="!asksEachTime" class="confirm-btn primary danger" data-test="agent-command-allow" :disabled="!armed" @pointerdown="press" @click="allowWith($event, { remember: 'pane' })">{{ allowWholeLabel }}</button>
        </template>
        <div v-else class="aca-split">
          <button class="confirm-btn primary" data-test="agent-command-allow" :disabled="!armed || blockedUnread" @pointerdown="press" @click="allowWith($event, { remember: 'once' })">{{ t('app.agentTerminal.allow', 'Allow') }}</button>
          <button
            v-if="actions.length"
            class="confirm-btn primary aca-more"
            data-test="agent-command-more"
            :aria-label="t('app.agentTerminal.more', 'More ways to allow')"
            :aria-expanded="menuOpen"
            @click="menuOpen = !menuOpen"
          >
            ▾
          </button>
          <div v-if="menuOpen" class="aca-menu" role="menu" data-test="agent-command-menu">
            <button v-for="(a, i) in actions" :key="i" role="menuitem" class="aca-item" :disabled="!armed" @pointerdown="press" @click="allowWith($event, { action: a, remember: 'once' })">{{ actionLabel(a) }}</button>
            <button role="menuitem" class="aca-item aca-configure" @click="(menuOpen = false), emit('configure')">{{ t('app.agentTerminal.configure', 'Configure auto approve…') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.aca-card {
  max-width: min(640px, 92vw);
}
.aca-line {
  margin: 4px 0;
}
.aca-command {
  width: 100%;
  max-height: 50vh;
  box-sizing: border-box;
  resize: vertical;
  min-height: 3.2em;
  font-family: var(--mono, 'Cascadia Mono', Consolas, monospace);
}
.aca-info {
  color: var(--text-dim);
  font-size: 12px;
}
/* A host's words cannot push the warning or the buttons away. */
.aca-host .aca-line {
  max-height: 6.5em;
  overflow: auto;
}
.aca-host .confirm-actions {
  position: sticky;
  bottom: -18px;
  margin-bottom: -18px;
  padding: 8px 0 18px;
  background: var(--surface);
}
/* Each real line has its number: a line break cannot pass for a long line wrapping. */
.aca-numbered {
  counter-reset: aca-line;
}
.aca-l {
  display: block;
  padding-left: 4ch;
  text-indent: -4ch;
  counter-increment: aca-line;
}
.aca-l::before {
  content: counter(aca-line);
  display: inline-block;
  width: 4ch;
  text-indent: 0;
  color: var(--text-dim);
  user-select: none;
}
.aca-warn {
  color: var(--warning, #d29922);
  font-size: 12px;
}
.aca-split {
  position: relative;
  display: inline-flex;
  gap: 1px;
}
.aca-more {
  padding: 0 8px;
}
.aca-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 4px);
  z-index: 5;
  display: grid;
  min-width: 280px;
  max-width: 80vw;
  padding: 4px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}
.aca-item {
  padding: 6px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.aca-item:hover,
.aca-item:focus-visible {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  outline: none;
}
.aca-configure {
  border-top: 1px solid var(--border);
  border-radius: 0 0 5px 5px;
  color: var(--text-dim);
}
</style>
