<script setup>
// The agent asks before running a tool: its name, why, the command or input
// (plain text), and Allow / Allow for this session / Deny (with an optional
// reason). Y / A / N answer while the card has the focus (not in its first
// moments, so typing meant for the composer never answers it). A decided or
// cancelled card stays in the chat, disabled, with what was decided.
// An input too long to show says how much is hidden: Allow waits until the
// whole input was shown (the whole input is what runs), and the keys do
// nothing on that card. "Allow for this session" lists what it adds.
// After Orca's NativeChatApprovalCard.tsx (MIT, Copyright (c) 2026
// Lovecast Inc.), written for Vue.
import { computed, onMounted, ref, watch } from 'vue'
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
  fetchInput: { type: Function, default: null }
})

const cardEl = ref(null)
const reason = ref('')
const showReason = ref(false)
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
const allowDisabled = computed(() => disabled.value || unseen.value)
const detail = computed(() => {
  if (fullText.value != null) return fullText.value
  if (typeof props.row.detail === 'string') return props.row.detail
  return approvalDetail(props.row.toolName, props.row.input)
})
const hiddenText = computed(() => t('chat.approval.hidden', '{{count}} characters hidden', { count: hidden.value }))
const rules = computed(() => (Array.isArray(props.row.sessionRules) ? props.row.sessionRules : []))
function ruleText(r) {
  if (r.kind === 'mode') return t('chat.approval.ruleMode', 'Switch this session to the {{mode}} mode', { mode: r.mode })
  if (r.kind === 'directories') return t('chat.approval.ruleDirs', 'Give access to {{dirs}}', { dirs: r.directories.join(', ') })
  return r.content ? `${r.tool}(${r.content})` : r.tool
}
const title = computed(() => t('chat.approval.title', 'Allow {{tool}}?', { tool: props.row.displayName || props.row.toolName }))
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
  }
)

async function showAll() {
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
  else fullText.value = approvalText(parseInput(input))
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
  const decision = k === 'y' ? 'allow' : k === 'a' ? 'allowSession' : k === 'n' ? 'deny' : null
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
  if (props.autoFocus && pending.value && cardEl.value && !typingElsewhere()) cardEl.value.focus({ preventScroll: true })
})

defineExpose({ focus: () => cardEl.value && cardEl.value.focus() })
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
    <pre v-if="detail" class="chat-approval-detail">{{ detail }}</pre>
    <div v-if="hidden > 0 && fullText == null" class="chat-approval-hidden" data-test="chat-approval-hidden">
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
      <button v-if="!showReason" type="button" class="chat-link" :disabled="disabled" @click="showReason = true">
        {{ t('chat.approval.addReason', 'Add a reason') }}
      </button>
      <input
        v-else
        v-model="reason"
        class="chat-approval-reason"
        data-test="chat-approve-reason"
        :disabled="disabled"
        :placeholder="t('chat.approval.reasonPlaceholder', 'Why? (sent with Deny)')"
        :aria-label="t('chat.approval.reason', 'Reason')"
        @keydown.enter.prevent="decide('deny')"
      />
    </div>
    <div v-if="pending" class="chat-approval-rules" data-test="chat-approval-rules">
      <template v-if="rules.length">
        <span>{{ t('chat.approval.rulesTitle', 'Allow for this session also allows:') }}</span>
        <ul>
          <li v-for="(r, i) in rules" :key="i">{{ ruleText(r) }}</li>
        </ul>
      </template>
      <span v-else>{{ t('chat.approval.noRules', 'Allow for this session adds no rule here: the same as Allow.') }}</span>
    </div>
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
