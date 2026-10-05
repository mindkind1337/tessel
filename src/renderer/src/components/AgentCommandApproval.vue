<script setup>
// An agent asks to run a command in a terminal (its terminal tools,
// src/main/agentTerminal.js): the command (editable), what the agent says it
// does and why, Allow (with more choices: rules for this session, this
// project or always, the exact line, every command of this session) or
// Skip. After Visual Studio Code's terminal confirmation (MIT, Copyright (c)
// Microsoft Corporation: src/vs/workbench/contrib/chat/browser/widget/
// chatContentParts/toolInvocationParts/chatTerminalToolConfirmationSubPart.ts).
// For one of the user's own terminals: Allow in this terminal, this time, or
// Deny. The keyboard starts on Skip: an Enter typed for something else never
// allows a command.
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { t } from '../i18n'

const props = defineProps({
  // { kind: 'command' | 'pane' | 'send', command, explanation, goal, info,
  //   disclaimers, actions, own, userTerminal, send, agentLabel, name, where, folder }
  card: { type: Object, required: true }
})
const emit = defineEmits(['answer', 'configure'])
const text = ref(String(props.card.command || ''))
const menuOpen = ref(false)
const skipEl = ref(null)
const dialog = ref(null)
let previousFocus = null

// A card for a whole terminal or host (allowed once, or until Tessel restarts).
const whole = computed(() => ['pane', 'read', 'host'].includes(props.card.kind))
const editable = computed(() => props.card.kind !== 'send' && !props.card.send && props.card.kind !== 'read' && props.card.kind !== 'host')
const shown = computed(() => props.card.kind !== 'read' && props.card.kind !== 'host')
const title = computed(() => {
  const c = props.card
  if (c.kind === 'read') return t('app.agentTerminal.readTitle', '{{agent}} wants to read the terminal "{{name}}" ({{where}})', { agent: c.agentLabel, name: c.name, where: c.where })
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
  props.card.kind === 'read'
    ? t('app.agentTerminal.readText', 'It will read what this terminal shows and its scrollback, which may hold passwords, keys or other secrets you typed or printed. Allowing it for this terminal lets it read it again until Tessel restarts.')
    : props.card.kind === 'host'
      ? t('app.agentTerminal.hostText', 'It is not the host of your project: Tessel opens a terminal there with your account, already signed in. Each command still asks you, and the rules of your project do not apply there.')
      : props.card.send
        ? t('app.agentTerminal.keysText', 'It will press these keys there:')
        : t('app.agentTerminal.paneText', 'It will type this command there and press Enter, with your rights on {{where}}. Allowing it in this terminal lets it type more commands there until Tessel restarts.', { where: props.card.where })
)
const allowWholeLabel = computed(() =>
  props.card.kind === 'read'
    ? t('app.agentTerminal.allowRead', 'Allow reading this terminal')
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

function answer(value) {
  menuOpen.value = false
  if (!value) return emit('answer', { allow: false })
  const edited = editable.value && text.value.trim() && text.value !== props.card.command ? text.value : null
  emit('answer', { allow: true, command: edited, action: value.action || null, remember: value.remember || 'once' })
}

onMounted(() => {
  previousFocus = document.activeElement
  nextTick(() => skipEl.value?.focus())
})
onUnmounted(() => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
function trapTab(event) {
  const items = [...(dialog.value?.querySelectorAll('button:not(:disabled), textarea') || [])]
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
  <div class="help-backdrop confirm-backdrop" data-test="agent-command-approval" @pointerdown.self="answer(false)">
    <div
      ref="dialog"
      class="help-card confirm-card aca-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="aca-title"
      @focusin.stop
      @keydown.escape.prevent.stop="menuOpen ? (menuOpen = false) : answer(false)"
      @keydown.tab.stop="trapTab"
    >
      <h2 id="aca-title" class="confirm-title">{{ title }}</h2>
      <p v-if="card.explanation" class="confirm-text aca-line"><strong>{{ t('app.agentTerminal.explanation', 'Explanation') }}:</strong> {{ card.explanation }}</p>
      <p v-if="card.goal" class="confirm-text aca-line"><strong>{{ t('app.agentTerminal.goal', 'Goal') }}:</strong> {{ card.goal }}</p>
      <p v-if="whole" class="confirm-text aca-line">
        {{ paneText }}
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
      <pre v-else-if="shown" class="confirm-code" data-test="agent-command-text">{{ card.command }}</pre>
      <p v-if="shown && lineCount > 1" class="confirm-text aca-warn" data-test="agent-command-lines">{{ linesText }}</p>
      <dl v-if="card.folder" class="confirm-details">
        <dt>{{ t('app.agentTerminal.folder', 'Folder') }}</dt>
        <dd>{{ card.folder }}</dd>
      </dl>
      <p v-if="card.info" class="confirm-text aca-info" data-test="agent-command-info">{{ card.info }}</p>
      <p v-for="(d, i) in disclaimers" :key="i" class="confirm-text aca-warn">{{ d }}</p>
      <div class="confirm-actions">
        <button ref="skipEl" class="confirm-btn" data-test="agent-command-skip" @click="answer(false)">
          {{ whole ? t('app.agentTerminal.deny', 'Deny') : t('app.agentTerminal.skip', 'Skip') }}
        </button>
        <template v-if="whole">
          <button class="confirm-btn" data-test="agent-command-once" @click="answer({ remember: 'once' })">{{ t('app.agentTerminal.allowOnce', 'Allow this time') }}</button>
          <button class="confirm-btn primary danger" data-test="agent-command-allow" @click="answer({ remember: 'pane' })">{{ allowWholeLabel }}</button>
        </template>
        <div v-else class="aca-split">
          <button class="confirm-btn primary" data-test="agent-command-allow" @click="answer({ remember: 'once' })">{{ t('app.agentTerminal.allow', 'Allow') }}</button>
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
            <button v-for="(a, i) in actions" :key="i" role="menuitem" class="aca-item" @click="answer({ action: a, remember: 'once' })">{{ actionLabel(a) }}</button>
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
