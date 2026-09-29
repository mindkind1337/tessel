<script setup>
// The agent asks before running a tool: its name, why, the command or input
// (plain text), and Allow / Allow for this session / Deny (with an optional
// reason). Y / A / N answer while the card has the focus (not in its first
// moments, so typing meant for the composer never answers it). A decided or
// cancelled card stays in the chat, disabled, with what was decided.
// An input too long to show says how much is hidden: Allow waits until the
// whole input was shown (the whole input is what runs), and the keys do
// nothing on that card. "Allow for this session" says what it adds (Claude:
// its rules; Codex: it stops asking for the same request).
// A new request is announced once to screen readers (a polite live region)
// unless the card took the focus; Alt+A (isFocusApprovalKey, handled by the
// pane) moves the focus to it, the only way it takes the focus while typing.
// After Orca's NativeChatApprovalCard.tsx (MIT, Copyright (c) 2026
// Lovecast Inc.), written for Vue.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ShieldQuestion, Check, X } from 'lucide-vue-next'
import { approvalDetail, parseInput, KEY_GRACE_MS } from '../../chat/chatModel'
import { approvalText } from '../../../../shared/chatApproval'
import { t } from '../../i18n'

const props = defineProps({
  row: { type: Object, required: true },
  // Take the focus when it appears (the pane is active, nothing typed).
  autoFocus: { type: Boolean, default: false },
  // ({ requestId, decision, message }) -> Promise<boolean>: false = not sent.
  answer: { type: Function, required: true },
  // ({ requestId }) -> Promise<input | null>: the whole input of a request
  // whose card shows only its start.
  fetchInput: { type: Function, default: null },
  // The pane's agent ('claude' | 'codex'): what "Allow for this session"
  // does, and who asks in the announcement.
  agentId: { type: String, default: null },
  // The pane's folder: where a Codex change with no details may write beyond.
  cwd: { type: String, default: '' }
})

const cardEl = ref(null)
const detailEl = ref(null)
const reasonEl = ref(null)
const reason = ref('')
const showReason = ref(false)
// Changes unknown (Codex): Allow waits for an explicit "yes, without seeing them".
const acceptUnknown = ref(false)
// The screen-reader announcement of a new request (a polite live region).
const liveText = ref('')
let liveTimer = null
// Answer sent, waiting for the main process to confirm it.
const sending = ref(false)
// The whole input's text, once fetched ("Show all").
const fullText = ref(null)
const loadingFull = ref(false)
const fullFailed = ref(false)
let shownAt = Date.now()

const pending = computed(() => props.row.status === 'pending')
const disabled = computed(() => !pending.value || sending.value)
const hidden = computed(() => (Number.isSafeInteger(props.row.hidden) && props.row.hidden > 0 ? props.row.hidden : 0))
// Characters of the input not seen yet: Allow waits for them.
const unseen = computed(() => hidden.value > 0 && fullText.value == null)
const detail = computed(() => {
  if (fullText.value != null) return fullText.value
  if (typeof props.row.detail === 'string') return props.row.detail
  return approvalDetail(props.row.toolName, props.row.input)
})
// A Codex file approval whose changes are unknown: nothing says what it
// writes. The main process counts it hidden (Allow waits for the whole
// request), and seeing it is not enough: the warning stays, and Allow also
// waits for an explicit "allow without seeing the changes".
const changesUnknown = computed(() => !!(props.row.input && typeof props.row.input === 'object' && props.row.input.changesUnknown === true))
const allowDisabled = computed(() => disabled.value || unseen.value || (changesUnknown.value && !acceptUnknown.value))
// The folder the change may write in: the root Codex asks for, if any.
const grantRoot = computed(() => {
  const g = props.row.input && typeof props.row.input === 'object' ? props.row.input.grantRoot : null
  return typeof g === 'string' ? g : ''
})
const scopeText = computed(() => {
  if (grantRoot.value) return t('chat.approval.scopeGrantRoot', 'Codex also asks to write anywhere in {{dir}} for the rest of this session.', { dir: grantRoot.value })
  if (props.cwd) return t('chat.approval.scopeUnknownIn', 'Allow applies it wherever Codex writes, possibly outside {{dir}}.', { dir: props.cwd })
  return t('chat.approval.scopeUnknown', 'Allow applies it wherever Codex writes.')
})
const hiddenText = computed(() => t('chat.approval.hidden', '{{count}} characters hidden', { count: hidden.value }))
// An MCP tool of the user's Codex config: it runs outside Codex's sandbox.
const mcp = computed(() => props.row.toolName === 'MCP')
const rules = computed(() => (Array.isArray(props.row.sessionRules) ? props.row.sessionRules : []))
// The pane says which agent asks; before it did, Codex's request ids said it.
const agent = computed(() => {
  if (props.agentId === 'claude' || props.agentId === 'codex') return props.agentId
  return /^codex_/.test(String(props.row.requestId || '')) ? 'codex' : null
})
// Codex's "for this session" (acceptForSession) adds no rule: Codex itself
// stops asking for the same command, or for changes to the same files.
const codexSessionText = computed(() =>
  props.row.toolName === 'Edit'
    ? t('chat.approval.codexSessionFiles', 'Allow for this session: Codex stops asking to change these files until the session ends.')
    : t('chat.approval.codexSessionCommand', 'Allow for this session: Codex stops asking to run this same command until the session ends.')
)
function ruleText(r) {
  if (r.kind === 'mode') return t('chat.approval.ruleMode', 'Switch this session to the {{mode}} mode', { mode: r.mode })
  if (r.kind === 'directories') return t('chat.approval.ruleDirs', 'Give access to {{dirs}}', { dirs: r.directories.join(', ') })
  return r.content ? `${r.tool}(${r.content})` : r.tool
}
const toolLabel = computed(() => props.row.displayName || props.row.toolName)
const title = computed(() => t('chat.approval.title', 'Allow {{tool}}?', { tool: toolLabel.value }))
function announceText() {
  const tool = toolLabel.value
  if (agent.value) return t('chat.approval.announce', '{{agent}} asks to run {{tool}}', { agent: agent.value === 'codex' ? 'Codex' : 'Claude', tool })
  return t('chat.approval.announceAgent', 'The agent asks to run {{tool}}', { tool })
}
const decidedText = computed(() => {
  switch (props.row.status) {
    case 'allowed':
      return t('chat.approval.allowed', 'Allowed')
    case 'allowedSession':
      return t('chat.approval.allowedSession', 'Allowed for this session')
    case 'denied':
      return t('chat.approval.denied', 'Denied')
    case 'cancelled':
      return t('chat.approval.cancelled', 'No longer needed')
    default:
      return ''
  }
})

watch(
  () => props.row.status,
  () => {
    sending.value = false
    // Answered or cancelled: nothing left to announce.
    if (!pending.value) liveText.value = ''
  }
)

// The whole input, fetched. `focus`: then the focus goes to the detail (the
// "Show all" button that had it is gone).
async function fetchAll(focus) {
  if (!props.fetchInput || loadingFull.value || !pending.value) return
  loadingFull.value = true
  fullFailed.value = false
  let input = null
  try {
    input = await props.fetchInput({ requestId: props.row.requestId })
  } catch {
    input = null
  }
  loadingFull.value = false
  if (input == null) fullFailed.value = true
  else {
    fullText.value = approvalText(parseInput(input))
    if (focus) {
      await nextTick()
      if (detailEl.value) detailEl.value.focus({ preventScroll: true })
    }
  }
}

function showAll() {
  return fetchAll(true)
}

// "Allow without seeing the changes": the main process still wants the whole
// request fetched first, so ticking it fetches it (the focus stays on the box).
function onAcceptUnknown(e) {
  acceptUnknown.value = !!e.target.checked
  if (acceptUnknown.value && unseen.value) fetchAll(false)
}

async function addReason() {
  showReason.value = true
  await nextTick()
  if (reasonEl.value) reasonEl.value.focus()
}

async function decide(decision) {
  if (disabled.value) return
  if (decision !== 'deny' && unseen.value) return
  sending.value = true
  const message = decision === 'deny' ? reason.value.trim() : ''
  let ok = false
  try {
    ok = await props.answer({ requestId: props.row.requestId, decision, message })
  } catch {
    ok = false
  }
  // Not sent: the buttons come back.
  if (ok === false) sending.value = false
}

function onKeydown(e) {
  if (disabled.value || e.ctrlKey || e.metaKey || e.altKey) return
  // No keys on a card whose input is not all shown, nor right after it appeared.
  if (hidden.value > 0 || Date.now() - shownAt < KEY_GRACE_MS) return
  // Typing a reason is not an answer.
  if (e.target && e.target.closest && e.target.closest('input, textarea')) return
  const k = e.key.toLowerCase()
  const decision = k === 'y' ? 'allow' : k === 'a' && props.row.sessionAllowed !== false ? 'allowSession' : k === 'n' ? 'deny' : null
  if (!decision) return
  e.preventDefault()
  e.stopPropagation()
  decide(decision)
}

// Something is being typed in (the composer): the focus stays there.
function typingElsewhere() {
  const el = typeof document !== 'undefined' ? document.activeElement : null
  return !!(el && el.matches && el.matches('textarea, input, [contenteditable=""], [contenteditable="true"]'))
}

onMounted(() => {
  shownAt = Date.now()
  if (!pending.value) return
  if (props.autoFocus && cardEl.value && !typingElsewhere()) {
    cardEl.value.focus({ preventScroll: true })
    // The focus reads the card out: no announcement on top of it.
    if (cardEl.value.contains(document.activeElement)) return
  }
  // Filled once the (empty) live region is in the page, so it is announced.
  liveTimer = setTimeout(() => {
    liveTimer = null
    if (pending.value) liveText.value = announceText()
  }, 150)
})

onBeforeUnmount(() => {
  if (liveTimer) clearTimeout(liveTimer)
  liveTimer = null
})

// The pane's shortcut (isFocusApprovalKey) calls this: the user asked for it,
// so it takes the focus even from the composer. -> true when it did.
function focus() {
  const el = cardEl.value
  if (!el) return false
  el.focus({ preventScroll: true })
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  return document.activeElement === el
}

defineExpose({ focus })
</script>

<script>
// The key that moves the focus to the pane's pending approval card: Alt+A
// (by its character, not its place: A is where Q is on AZERTY). AltGr is
// Ctrl+Alt, so no character typed with it matches.
export function isFocusApprovalKey(e) {
  return !!e && e.altKey === true && !e.ctrlKey && !e.shiftKey && !e.metaKey && typeof e.key === 'string' && e.key.toLowerCase() === 'a'
}
</script>

<template>
  <div
    ref="cardEl"
    class="chat-approval"
    :class="['st-' + row.status, { pending }]"
    role="group"
    :aria-label="title"
    tabindex="-1"
    data-test="chat-approval"
    @keydown="onKeydown"
  >
    <div class="chat-approval-head">
      <ShieldQuestion :size="15" class="chat-approval-icon" aria-hidden="true" />
      <span class="chat-approval-title">{{ title }}</span>
      <span v-if="!pending" class="chat-approval-decided" data-test="chat-approval-decided">
        <Check v-if="row.status === 'allowed' || row.status === 'allowedSession'" :size="13" aria-hidden="true" />
        <X v-else :size="13" aria-hidden="true" />
        {{ decidedText }}
      </span>
    </div>
    <p v-if="row.description" class="chat-approval-desc">{{ row.description }}</p>
    <p v-if="mcp" class="chat-approval-warn" data-test="chat-approval-mcp">
      {{ t('chat.approval.mcpUnsandboxed', 'An MCP tool from your Codex config: it runs outside the sandbox, with your rights.') }}
    </p>
    <pre v-if="detail" ref="detailEl" class="chat-approval-detail" tabindex="-1" data-test="chat-approval-detail">{{ detail }}</pre>
    <!-- Codex changes with no details: stays until answered, whatever was shown. -->
    <div v-if="changesUnknown" class="chat-approval-hidden" data-test="chat-approval-hidden">
      <span data-test="chat-approval-unknown">{{ t('chat.approval.changesUnknown', 'Changes unknown: Codex did not say which files this changes.') }}</span>
      <span data-test="chat-approval-scope">{{ scopeText }}</span>
      <button v-if="pending && fetchInput && unseen" type="button" class="chat-link" data-test="chat-approval-show-all" :disabled="loadingFull" @click="showAll">
        {{ t('chat.approval.showAll', 'Show all') }}
      </button>
      <label v-if="pending" class="chat-approval-accept">
        <input type="checkbox" data-test="chat-approval-accept-unknown" :checked="acceptUnknown" :disabled="disabled" @change="onAcceptUnknown" />
        {{ t('chat.approval.acceptUnknown', 'Allow without seeing the changes') }}
      </label>
      <span v-if="pending && fullFailed">{{ t('chat.approval.fullFailed', 'The whole input could not be read.') }}</span>
    </div>
    <div v-else-if="unseen" class="chat-approval-hidden" data-test="chat-approval-hidden">
      <span>{{ hiddenText }}</span>
      <button v-if="pending && fetchInput" type="button" class="chat-link" data-test="chat-approval-show-all" :disabled="loadingFull" @click="showAll">
        {{ t('chat.approval.showAll', 'Show all') }}
      </button>
      <span v-if="pending">{{ fullFailed ? t('chat.approval.fullFailed', 'The whole input could not be read.') : t('chat.approval.seeAllFirst', 'Allow waits until you have seen it all.') }}</span>
    </div>
    <div v-if="pending" class="chat-approval-actions">
      <button type="button" class="chat-btn primary" data-test="chat-approve-allow" :disabled="allowDisabled" :title="t('chat.approval.allowHint', 'Allow once (Y)')" @click="decide('allow')">
        {{ t('chat.approval.allow', 'Allow') }}
      </button>
      <button
        v-if="row.sessionAllowed !== false"
        type="button"
        class="chat-btn"
        data-test="chat-approve-session"
        :disabled="allowDisabled"
        :title="t('chat.approval.allowSessionHint', 'Allow this for the rest of the session (A)')"
        @click="decide('allowSession')"
      >
        {{ t('chat.approval.allowSessionButton', 'Allow for this session') }}
      </button>
      <button type="button" class="chat-btn danger" data-test="chat-approve-deny" :disabled="disabled" :title="t('chat.approval.denyHint', 'Deny (N)')" @click="decide('deny')">
        {{ t('chat.approval.deny', 'Deny') }}
      </button>
      <button v-if="!showReason" type="button" class="chat-link" data-test="chat-approve-add-reason" :disabled="disabled" @click="addReason">
        {{ t('chat.approval.addReason', 'Add a reason') }}
      </button>
      <input
        v-else
        ref="reasonEl"
        v-model="reason"
        class="chat-approval-reason"
        data-test="chat-approve-reason"
        :disabled="disabled"
        :placeholder="t('chat.approval.reasonPlaceholder', 'Why? (sent with Deny)')"
        :aria-label="t('chat.approval.reason', 'Reason')"
        @keydown.enter.prevent="decide('deny')"
      />
    </div>
    <!-- What "Allow for this session" does: nothing to say when it is not offered. -->
    <div v-if="pending && row.sessionAllowed !== false" class="chat-approval-rules" data-test="chat-approval-rules">
      <span v-if="agent === 'codex'" data-test="chat-approval-codex-session">{{ codexSessionText }}</span>
      <template v-else-if="rules.length">
        <span>{{ t('chat.approval.rulesTitle', 'Allow for this session also allows:') }}</span>
        <ul>
          <li v-for="(r, i) in rules" :key="i">{{ ruleText(r) }}</li>
        </ul>
      </template>
      <span v-else>{{ t('chat.approval.noRules', 'Allow for this session adds no rule here: the same as Allow.') }}</span>
    </div>
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-test="chat-approval-live">{{ liveText }}</span>
  </div>
</template>

<style scoped>
.chat-approval {
  margin: 4px 0;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface);
  outline: none;
}

.chat-approval.pending {
  border-color: color-mix(in srgb, var(--warn) 60%, var(--border-strong));
}

.chat-approval:focus-visible,
.chat-approval.pending:focus {
  box-shadow: 0 0 0 1px var(--warn);
}

.chat-approval:not(.pending) {
  opacity: 0.75;
}

.chat-approval-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.chat-approval-icon {
  flex: 0 0 auto;
  color: var(--warn);
}

.chat-approval-title {
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-approval-decided {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  color: var(--text-dim);
  font-size: 11.5px;
}

.st-denied .chat-approval-decided {
  color: var(--danger);
}

.st-allowed .chat-approval-decided,
.st-allowedSession .chat-approval-decided {
  color: var(--ok);
}

.chat-approval-desc {
  margin: 6px 0 0;
  color: var(--text-dim);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-approval-detail {
  max-height: 220px;
  margin: 6px 0 0;
  padding: 6px 8px;
  overflow: auto;
  border-radius: 5px;
  background: var(--surface-2);
  color: var(--text);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-approval-detail:focus-visible {
  outline: 1px solid var(--ui-accent);
}

.chat-approval-accept {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text);
  cursor: pointer;
}

.chat-approval-warn {
  margin: 6px 0 0;
  color: var(--warn);
  font-size: 11.5px;
}

.chat-approval-hidden {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
  color: var(--warn);
  font-size: 11.5px;
}

.chat-approval-rules {
  margin-top: 7px;
  color: var(--text-dim);
  font-size: 11.5px;
}

.chat-approval-rules ul {
  margin: 3px 0 0;
  padding-left: 18px;
}

.chat-approval-rules li {
  font-family: 'Cascadia Mono', Consolas, monospace;
  word-break: break-all;
}

.chat-approval-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 9px;
}

.chat-btn {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.chat-btn:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text-strong);
}

.chat-btn.primary {
  border-color: color-mix(in srgb, var(--ui-accent) 60%, transparent);
  background: color-mix(in srgb, var(--ui-accent) 22%, var(--surface-2));
  color: var(--text-strong);
}

.chat-btn.danger:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}

.chat-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.chat-link {
  padding: 0 4px;
  border: none;
  background: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  text-decoration: underline;
  cursor: pointer;
}

.chat-approval-reason {
  flex: 1 1 160px;
  min-width: 120px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  background: var(--term);
  color: var(--text);
  font: inherit;
  font-size: 12px;
}
</style>
