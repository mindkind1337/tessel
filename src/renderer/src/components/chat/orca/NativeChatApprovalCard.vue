<script setup>
// After Orca's NativeChatApprovalCard.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// The agent asks before running a tool. The reference's look (a card with
// its title, a bounded scroller for the context, the options as buttons, an
// optional X that cancels the turn) and Tessel's protections, from
// components/chat/ChatApprovalCard.vue:
// - An input too long to show says how much is hidden: Allow (and "Allow for
//   this session") wait until "Show all" fetched the whole input (the whole
//   input is what runs), and the Y / A / N keys never answer that card.
// - A Codex change with no details (changesUnknown) keeps its warning even
//   once shown, and Allow also waits for an explicit "allow without seeing".
// - Keys answer only while the card has the focus, and not in its first
//   KEY_GRACE_MS (typing meant for the composer never answers it).
// - It takes the focus only when asked (shouldFocus) and nothing is being
//   typed elsewhere; otherwise a polite live region announces it once. The
//   pane's Alt+A (isFocusApprovalKey) calls focus(), the only way it takes
//   the focus from the composer.
// - "Allow for this session" only when the agent offers it, with what it
//   adds (Claude: its rules; Codex: it stops asking for the same request).
// - A decided or cancelled card stays, disabled, with what was decided.
//
// Props: item (the journal approval item), shouldFocus, agentId, cwd,
//   fetchInput(({ requestId }) -> input | null), onRespond / onCancel (bind
//   them with @respond / @cancel: the card awaits @respond's result, and
//   shows the X only when @cancel is bound), allowFileUriLinks.
// @respond(item, { kind: 'option', optionId }, { message }) -> must return
//   true or { ok: true } once the answer was taken; anything else brings the
//   buttons back. Emits: link-click (from a plan's markdown).
// Exposed: focus() -> true when the card has the focus.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, ShieldQuestion, X } from 'lucide-vue-next'
import { approvalDetail, parseInput, KEY_GRACE_MS } from '../../../chat/chatModel.js'
import { approvalText } from '../../../../../shared/chatApproval.js'
import { t } from '../../../i18n'
import { approvalAnswerSent, approvalRowFromItem } from './native-chat-approval-card.js'

// Lot 3's sanitizing markdown (a plan's body). Looked up so the card works
// before it lands: then the plan shows as plain text. TODO(lead): a plain
// `import ChatMarkdown from './ChatMarkdown.vue'` once it is there.
const markdownModules = import.meta.glob('./ChatMarkdown.vue', { eager: true, import: 'default' })
const ChatMarkdown = markdownModules['./ChatMarkdown.vue'] || null

const props = defineProps({
  item: { type: Object, required: true },
  shouldFocus: { type: Boolean, default: false },
  // The pane's agent ('claude' | 'codex' | 'opencode'): what "Allow for this session"
  // does, and who asks in the announcement.
  agentId: { type: String, default: null },
  // The pane's folder: where a Codex change with no details may write beyond.
  cwd: { type: String, default: '' },
  fetchInput: { type: Function, default: null },
  onRespond: { type: Function, default: null },
  onCancel: { type: Function, default: null },
  allowFileUriLinks: { type: Boolean, default: false }
})
const emit = defineEmits(['link-click'])

const row = computed(() => approvalRowFromItem(props.item))

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
// Answer sent, waiting for the resolution to come back.
const sending = ref(false)
// The whole input's text, once fetched ("Show all").
const fullText = ref(null)
const loadingFull = ref(false)
const fullFailed = ref(false)
let shownAt = Date.now()

const pending = computed(() => row.value.status === 'pending')
const disabled = computed(() => !pending.value || sending.value)
const hidden = computed(() => row.value.hidden)
// Characters of the input not seen yet: Allow waits for them.
const unseen = computed(() => hidden.value > 0 && fullText.value == null)
const detail = computed(() => {
  if (fullText.value != null) return fullText.value
  if (typeof row.value.detail === 'string') return row.value.detail
  return row.value.tessel ? approvalDetail(row.value.toolName, row.value.input) : ''
})
const input = computed(() => (row.value.input && typeof row.value.input === 'object' ? row.value.input : null))
// A Codex file approval whose changes are unknown: nothing says what it
// writes. The main process counts it hidden (Allow waits for the whole
// request), and seeing it is not enough: the warning stays, and Allow also
// waits for an explicit "allow without seeing the changes".
const changesUnknown = computed(() => !!(input.value && input.value.changesUnknown === true))
const allowDisabled = computed(() => disabled.value || unseen.value || (changesUnknown.value && !acceptUnknown.value))
const grantRoot = computed(() => (input.value && typeof input.value.grantRoot === 'string' ? input.value.grantRoot : ''))
const scopeText = computed(() => {
  if (grantRoot.value) return t('chat.approval.scopeGrantRoot', 'Codex also asks to write anywhere in {{dir}} for the rest of this session.', { dir: grantRoot.value })
  if (props.cwd) return t('chat.approval.scopeUnknownIn', 'Allow applies it wherever Codex writes, possibly outside {{dir}}.', { dir: props.cwd })
  return t('chat.approval.scopeUnknown', 'Allow applies it wherever Codex writes.')
})
const hiddenText = computed(() => t('chat.approval.hidden', '{{count}} characters hidden', { count: hidden.value }))
// An MCP tool of the user's Codex config: it runs outside Codex's sandbox.
const mcp = computed(() => row.value.toolName === 'MCP')
// The pane says which agent asks; before it did, Codex's request ids said it.
const agent = computed(() => {
  if (props.agentId === 'claude' || props.agentId === 'codex' || props.agentId === 'opencode') return props.agentId
  return /^codex_/.test(row.value.requestId) ? 'codex' : null
})
// Codex's "for this session" (acceptForSession) adds no rule: Codex itself
// stops asking for the same command, or for changes to the same files.
const codexSessionText = computed(() =>
  row.value.toolName === 'Edit'
    ? t('chat.approval.codexSessionFiles', 'Allow for this session: Codex stops asking to change these files until the session ends.')
    : t('chat.approval.codexSessionCommand', 'Allow for this session: Codex stops asking to run this same command until the session ends.')
)
// OpenCode's "always": its server allows these patterns after every rule, for
// every agent (sub-agents too), until it restarts; Tessel restarts it when
// the chat goes back to Manual or Plan.
const opencodeSessionText = computed(() => t('chat.approval.opencodeSession', "Allow for this session: OpenCode then allows these patterns without asking, for every agent including sub-agents, until this chat's OpenCode restarts (switching to Manual or Plan restarts it). * means everything of that kind: every file, every command."))
function ruleText(r) {
  if (r.kind === 'mode') return t('chat.approval.ruleMode', 'Switch this session to the {{mode}} mode', { mode: r.mode })
  if (r.kind === 'directories') return t('chat.approval.ruleDirs', 'Give access to {{dirs}}', { dirs: r.directories.join(', ') })
  return r.content ? `${r.tool}(${r.content})` : r.tool
}
const toolLabel = computed(() => row.value.displayName || row.value.toolName)
// Tessel's requests: the card words the title (translated); the reference's
// own approvals bring theirs.
const title = computed(() => (row.value.tessel ? t('chat.approval.title', 'Allow {{tool}}?', { tool: toolLabel.value }) : row.value.title))
function announceText() {
  const tool = toolLabel.value || row.value.title
  if (agent.value) return t('chat.approval.announce', '{{agent}} asks to run {{tool}}', { agent: { codex: 'Codex', opencode: 'OpenCode' }[agent.value] || 'Claude', tool }) // i18n-ignore
  return t('chat.approval.announceAgent', 'The agent asks to run {{tool}}', { tool })
}
const decidedText = computed(() => {
  switch (row.value.status) {
    case 'allowed':
      return t('chat.approval.allowed', 'Allowed')
    case 'allowedSession':
      return t('chat.approval.allowedSession', 'Allowed for this session')
    case 'denied':
      return t('chat.approval.denied', 'Denied')
    case 'cancelled':
      return t('chat.approval.cancelled', 'No longer needed')
    default:
      return t('chat.orca.receipt.resolved', 'Resolved')
  }
})
const approved = computed(() => row.value.status === 'allowed' || row.value.status === 'allowedSession')
const hasContext = computed(
  () => !!(row.value.description || row.value.decisionReason || row.value.blockedPath || row.value.matchedAskRule || row.value.subject || detail.value)
)

// The options as buttons (the reference's order; the first is primary).
// The labels are data (English, used as ids): Tessel's are worded here.
const OPTION_TEST = { allow: 'chat-approve-allow', allowSession: 'chat-approve-session', deny: 'chat-approve-deny' }
function optionLabel(o) {
  if (!row.value.tessel) return o.label
  if (o.id === 'allow') return t('chat.approval.allow', 'Allow')
  if (o.id === 'allowSession') return t('chat.approval.allowSessionButton', 'Allow for this session')
  if (o.id === 'deny') return t('chat.approval.deny', 'Deny')
  return o.label
}
function optionHint(o) {
  if (!row.value.tessel) return undefined
  if (o.id === 'allow') return t('chat.approval.allowHint', 'Allow once (Y)')
  if (o.id === 'allowSession') return t('chat.approval.allowSessionHint', 'Allow this for the rest of the session (A)')
  if (o.id === 'deny') return t('chat.approval.denyHint', 'Deny (N)')
  return undefined
}
// Anything but Deny lets the tool run: it waits like Allow.
const isDeny = (id) => id === 'deny'
function optionDisabled(o) {
  return isDeny(o.id) ? disabled.value : allowDisabled.value
}
const canDeny = computed(() => row.value.options.some((o) => isDeny(o.id)))
const offered = (id) => row.value.options.some((o) => o.id === id)

// A new request in the same card (the pane did not remount it): nothing of
// the last one carries over, above all not its fetched input.
function reset() {
  sending.value = false
  fullText.value = null
  loadingFull.value = false
  fullFailed.value = false
  acceptUnknown.value = false
  reason.value = ''
  showReason.value = false
  liveText.value = ''
  shownAt = Date.now()
}
watch(
  () => [row.value.requestId, row.value.itemId],
  (next, prev) => {
    if (next[0] === prev[0] && next[1] === prev[1]) return
    reset()
    announceSoon()
    focusIfAsked()
  }
)
watch(
  () => row.value.status,
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
  const requestId = row.value.requestId
  loadingFull.value = true
  fullFailed.value = false
  let fetched = null
  try {
    fetched = await props.fetchInput({ requestId })
  } catch {
    fetched = null
  }
  // Another request by now: this input is not its input.
  if (requestId !== row.value.requestId) return
  loadingFull.value = false
  if (fetched == null) fullFailed.value = true
  else {
    fullText.value = approvalText(parseInput(fetched))
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

async function choose(optionId) {
  if (disabled.value || !offered(optionId)) return
  if (!isDeny(optionId) && allowDisabled.value) return
  if (!props.onRespond) return
  sending.value = true
  const requestId = row.value.requestId
  const message = isDeny(optionId) ? reason.value.trim() : ''
  let result = null
  try {
    result = await props.onRespond(props.item, { kind: 'option', optionId }, { message })
  } catch {
    result = null
  }
  // Not taken: the buttons come back.
  if (!approvalAnswerSent(result) && requestId === row.value.requestId) sending.value = false
}

function cancel() {
  if (props.onCancel) props.onCancel()
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    // The reference: Escape cancels the turn while the card stands in for
    // the composer. Not from the reason field (that is typing).
    if (!props.onCancel || !pending.value || e.isComposing) return
    if (e.target && e.target.closest && e.target.closest('input, textarea')) return
    e.preventDefault()
    e.stopPropagation()
    cancel()
    return
  }
  if (disabled.value || e.ctrlKey || e.metaKey || e.altKey) return
  // No keys on a card whose input is not all shown, nor right after it appeared.
  if (hidden.value > 0 || Date.now() - shownAt < KEY_GRACE_MS) return
  // Typing a reason is not an answer.
  if (e.target && e.target.closest && e.target.closest('input, textarea')) return
  if (typeof e.key !== 'string') return
  const k = e.key.toLowerCase()
  const optionId = k === 'y' ? 'allow' : k === 'a' ? 'allowSession' : k === 'n' ? 'deny' : null
  if (!optionId || !offered(optionId)) return
  e.preventDefault()
  e.stopPropagation()
  choose(optionId)
}

// Something is being typed in (the composer): the focus stays there.
function typingElsewhere() {
  const el = typeof document !== 'undefined' ? document.activeElement : null
  return !!(el && el.matches && el.matches('textarea, input, select, [contenteditable=""], [contenteditable="true"]'))
}

// Takes the focus when asked and nothing is typed elsewhere. -> true when it did.
function focusIfAsked() {
  if (!props.shouldFocus || !pending.value || !cardEl.value || typingElsewhere()) return false
  cardEl.value.focus({ preventScroll: true })
  return cardEl.value.contains(document.activeElement)
}

// Filled once the (empty) live region is in the page, so it is announced;
// not when the card took the focus (the focus reads it out).
function announceSoon() {
  if (liveTimer) clearTimeout(liveTimer)
  liveTimer = null
  if (!pending.value) return
  liveTimer = setTimeout(() => {
    liveTimer = null
    const el = cardEl.value
    if (el && el.contains(document.activeElement)) return
    if (pending.value) liveText.value = announceText()
  }, 150)
}

onMounted(() => {
  shownAt = Date.now()
  if (!pending.value) return
  if (focusIfAsked()) return
  announceSoon()
})

// The reference focuses once when shouldFocus turns on (the pane became the
// focused one); Tessel's rule holds: never from the composer.
watch(
  () => props.shouldFocus,
  (on, was) => {
    if (on && !was) focusIfAsked()
  }
)

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

<template>
  <div class="nc-approval-shell">
    <div class="nc-approval-frame">
      <div
        ref="cardEl"
        data-native-chat-approval-card="true"
        data-test="chat-approval"
        :data-state="row.status"
        :data-request-id="row.requestId || undefined"
        role="group"
        :aria-label="title"
        tabindex="-1"
        class="nc-approval-card"
        :class="['st-' + row.status, { pending }]"
        @keydown="onKeydown"
      >
        <div class="nc-approval-head">
          <ShieldQuestion class="nc-approval-icon" aria-hidden="true" />
          <div class="nc-approval-title-wrap">
            <p class="nc-approval-title">{{ title }}</p>
          </div>
          <span v-if="!pending" class="nc-approval-decided" data-test="chat-approval-decided">
            <Check v-if="approved" class="nc-approval-decided-icon" aria-hidden="true" />
            <X v-else class="nc-approval-decided-icon" aria-hidden="true" />
            {{ decidedText }}
          </span>
          <button
            v-if="pending && onCancel"
            type="button"
            class="nc-approval-cancel"
            data-test="chat-approval-cancel"
            :aria-label="t('chat.orca.approval.cancel', 'Cancel')"
            @click="cancel"
          >
            <X class="nc-approval-cancel-icon" aria-hidden="true" />
          </button>
        </div>
        <p v-if="mcp" class="nc-approval-warn" data-test="chat-approval-mcp">
          {{ t('chat.approval.mcpUnsandboxed', 'An MCP tool from your Codex config: it runs outside the sandbox, with your rights.') }}
        </p>
        <div v-if="hasContext" data-native-chat-approval-content="true" tabindex="0" class="nc-approval-content nc-scrollbar-sleek">
          <p v-if="row.description" class="nc-approval-prose">{{ row.description }}</p>
          <p v-if="row.decisionReason" class="nc-approval-prose">
            <span class="nc-approval-key">{{ t('chat.orca.approval.reason', 'Reason') }}: </span>{{ row.decisionReason }}
          </p>
          <p v-if="row.blockedPath" class="nc-approval-line">
            <span class="nc-approval-key">{{ t('chat.orca.approval.blockedPath', 'Blocked path') }}: </span><span class="nc-approval-mono">{{ row.blockedPath }}</span>
          </p>
          <p v-if="row.matchedAskRule" class="nc-approval-line">
            <span class="nc-approval-key">{{ t('chat.orca.approval.askRule', 'Ask rule') }}: </span>{{ row.matchedAskRule.ruleContent ?? row.matchedAskRule.toolName
            }}<span class="nc-approval-source">{{ ' · ' }}{{ row.matchedAskRule.source }}</span>
          </p>
          <div v-if="row.subject" data-native-chat-approval-plan="true">
            <ChatMarkdown
              v-if="ChatMarkdown"
              :content="row.subject.text"
              variant="document"
              class="nc-approval-plan"
              :allow-file-uri-links="allowFileUriLinks"
              @link-click="(...args) => emit('link-click', ...args)"
            />
            <p v-else class="nc-approval-prose">{{ row.subject.text }}</p>
            <p v-if="row.subject.filePath" class="nc-approval-plan-file">
              <span class="nc-approval-key">{{ t('chat.orca.approval.plan.file', 'Plan file') }}: </span><span class="nc-approval-mono">{{ row.subject.filePath }}</span>
            </p>
          </div>
          <div
            v-else-if="detail"
            ref="detailEl"
            data-native-chat-approval-detail="true"
            data-test="chat-approval-detail"
            tabindex="-1"
            class="nc-approval-detail"
            >{{ detail }}</div
          >
        </div>
        <!-- Codex changes with no details: stays until answered, whatever was shown. -->
        <div v-if="changesUnknown" class="nc-approval-hidden" data-test="chat-approval-hidden">
          <span data-test="chat-approval-unknown">{{ t('chat.approval.changesUnknown', 'Changes unknown: Codex did not say which files this changes.') }}</span>
          <span data-test="chat-approval-scope">{{ scopeText }}</span>
          <button
            v-if="pending && fetchInput && unseen"
            type="button"
            class="nc-approval-link"
            data-test="chat-approval-show-all"
            :disabled="loadingFull"
            @click="showAll"
          >
            {{ t('chat.approval.showAll', 'Show all') }}
          </button>
          <label v-if="pending" class="nc-approval-accept">
            <input type="checkbox" data-test="chat-approval-accept-unknown" :checked="acceptUnknown" :disabled="disabled" @change="onAcceptUnknown" />
            {{ t('chat.approval.acceptUnknown', 'Allow without seeing the changes') }}
          </label>
          <span v-if="pending && fullFailed">{{ t('chat.approval.fullFailed', 'The whole input could not be read.') }}</span>
        </div>
        <div v-else-if="unseen" class="nc-approval-hidden" data-test="chat-approval-hidden">
          <span>{{ hiddenText }}</span>
          <button
            v-if="pending && fetchInput"
            type="button"
            class="nc-approval-link"
            data-test="chat-approval-show-all"
            :disabled="loadingFull"
            @click="showAll"
          >
            {{ t('chat.approval.showAll', 'Show all') }}
          </button>
          <span v-if="pending">{{
            fullFailed ? t('chat.approval.fullFailed', 'The whole input could not be read.') : t('chat.approval.seeAllFirst', 'Allow waits until you have seen it all.')
          }}</span>
        </div>
        <div v-if="pending" data-native-chat-approval-actions="true" class="nc-approval-actions">
          <button
            v-for="(o, i) in row.options"
            :key="`${o.label}-${i}`"
            type="button"
            class="nc-approval-option"
            :class="i === 0 ? 'nc-approval-option--primary' : 'nc-approval-option--secondary'"
            :data-test="OPTION_TEST[o.id] || 'chat-approve-option'"
            :data-option-id="o.id"
            :disabled="optionDisabled(o)"
            :title="optionHint(o)"
            @click="choose(o.id)"
          >
            {{ optionLabel(o) }}
          </button>
          <template v-if="canDeny">
            <button v-if="!showReason" type="button" class="nc-approval-link" data-test="chat-approve-add-reason" :disabled="disabled" @click="addReason">
              {{ t('chat.approval.addReason', 'Add a reason') }}
            </button>
            <input
              v-else
              ref="reasonEl"
              v-model="reason"
              class="nc-approval-reason"
              data-test="chat-approve-reason"
              :disabled="disabled"
              :placeholder="t('chat.approval.reasonPlaceholder', 'Why? (sent with Deny)')"
              :aria-label="t('chat.approval.reason', 'Reason')"
              @keydown.enter.prevent="choose('deny')"
            />
          </template>
        </div>
        <!-- What "Allow for this session" does: nothing to say when it is not offered. -->
        <div v-if="pending && row.tessel && row.sessionAllowed" class="nc-approval-rules" data-test="chat-approval-rules">
          <span v-if="agent === 'codex'" data-test="chat-approval-codex-session">{{ codexSessionText }}</span>
          <template v-else-if="agent === 'opencode' && row.sessionRules.length">
            <span data-test="chat-approval-opencode-session">{{ opencodeSessionText }}</span>
            <ul>
              <li v-for="(r, i) in row.sessionRules" :key="i">{{ ruleText(r) }}</li>
            </ul>
          </template>
          <template v-else-if="row.sessionRules.length">
            <span>{{ t('chat.approval.rulesTitle', 'Allow for this session also allows:') }}</span>
            <ul>
              <li v-for="(r, i) in row.sessionRules" :key="i">{{ ruleText(r) }}</li>
            </ul>
          </template>
          <span v-else>{{ t('chat.approval.noRules', 'Allow for this session adds no rule here: the same as Allow.') }}</span>
        </div>
        <span class="nc-approval-sr-only" role="status" aria-live="polite" aria-atomic="true" data-test="chat-approval-live">{{ liveText }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* min-h-0 shrink overflow-hidden bg-background */
.nc-approval-shell {
  min-height: 0;
  flex-shrink: 1;
  overflow: hidden;
  background: var(--nc-background);
}
/* mx-auto flex h-full min-h-0 max-h-full w-full max-w-4xl px-3 pt-2 pb-1 sm:px-4 */
.nc-approval-frame {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  max-width: 56rem;
  height: 100%;
  min-height: 0;
  max-height: 100%;
  margin: 0 auto;
  padding: 8px 12px 4px;
}
@media (min-width: 640px) {
  .nc-approval-frame {
    padding-right: 16px;
    padding-left: 16px;
  }
}
/* flex min-h-0 w-full flex-1 flex-col gap-2 overflow-hidden rounded-lg border
   border-input bg-card px-4 py-3 shadow-xs focus-visible:ring-2 ring-ring */
.nc-approval-card {
  box-sizing: border-box;
  display: flex;
  flex: 1 1 0%;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  padding: 12px 16px;
  border: 1px solid var(--nc-input);
  border-radius: 8px;
  background: var(--nc-card);
  color: var(--nc-card-foreground);
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  outline: none;
}
.nc-approval-card:focus-visible {
  box-shadow: 0 0 0 2px var(--nc-ring);
}
/* Tessel: a decided card stays, quieter. */
.nc-approval-card:not(.pending) {
  opacity: 0.75;
}
.nc-approval-head {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  gap: 8px;
}
.nc-approval-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--nc-muted-foreground);
}
.nc-approval-title-wrap {
  flex: 1 1 0%;
  min-width: 0;
}
/* line-clamp-2 break-words text-sm font-semibold text-foreground */
.nc-approval-title {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--nc-foreground);
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  overflow-wrap: break-word;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.nc-approval-decided {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  color: var(--nc-muted-foreground);
  font-size: 12px;
  line-height: 20px;
}
.st-denied .nc-approval-decided {
  color: var(--nc-destructive);
}
.st-allowed .nc-approval-decided,
.st-allowedSession .nc-approval-decided {
  color: var(--nc-status-success);
}
.nc-approval-decided-icon {
  width: 12px;
  height: 12px;
}
/* flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground
   transition-colors hover:bg-accent hover:text-accent-foreground */
.nc-approval-cancel {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--nc-muted-foreground);
  cursor: pointer;
  transition: color 150ms, background-color 150ms;
}
.nc-approval-cancel:hover {
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
.nc-approval-cancel:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-approval-cancel-icon {
  width: 16px;
  height: 16px;
}
.nc-approval-warn {
  flex-shrink: 0;
  margin: 0;
  color: var(--nc-warning);
  font-size: 12px;
  line-height: 16px;
}
/* min-h-0 max-h-72 shrink space-y-2 overflow-auto text-xs text-muted-foreground
   focus-visible:ring-2 ring-inset ring-ring/70 */
.nc-approval-content {
  flex-shrink: 1;
  min-height: 0;
  max-height: 18rem;
  overflow: auto;
  color: var(--nc-muted-foreground);
  font-size: 12px;
  line-height: 16px;
}
.nc-approval-content > * + * {
  margin-top: 8px;
}
.nc-approval-content:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--nc-ring) 70%, transparent);
}
.nc-approval-prose {
  margin: 0;
  overflow-wrap: break-word;
  white-space: pre-wrap;
}
.nc-approval-line {
  margin: 0;
  overflow-wrap: break-word;
}
.nc-approval-key {
  color: color-mix(in srgb, var(--nc-foreground) 80%, transparent);
  font-weight: 500;
}
.nc-approval-source {
  color: color-mix(in srgb, var(--nc-muted-foreground) 80%, transparent);
}
.nc-approval-mono,
.nc-approval-detail {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
}
.nc-approval-plan {
  font-size: 14px;
  line-height: 20px;
}
.nc-approval-plan-file {
  margin: 8px 0 0;
  word-break: break-all;
}
/* whitespace-pre-wrap break-words font-mono */
.nc-approval-detail {
  overflow-wrap: break-word;
  white-space: pre-wrap;
  outline: none;
}
.nc-approval-detail:focus-visible {
  box-shadow: inset 0 0 0 1px var(--nc-ring);
}
/* Tessel: the hidden input, the unknown changes, the explicit yes. */
.nc-approval-hidden {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--nc-warning);
  font-size: 12px;
  line-height: 16px;
}
.nc-approval-accept {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--nc-foreground);
  cursor: pointer;
}
.nc-approval-link {
  padding: 0 4px;
  border: 0;
  background: none;
  color: var(--nc-muted-foreground);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.nc-approval-link:hover:not(:disabled) {
  color: var(--nc-foreground);
}
.nc-approval-link:disabled {
  opacity: 0.5;
  cursor: default;
}
/* flex shrink-0 flex-wrap gap-2 */
.nc-approval-actions {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
/* rounded-md px-4 py-1.5 text-sm font-semibold transition-colors focus-visible:ring-2 */
.nc-approval-option {
  padding: 6px 16px;
  border: 1px solid transparent;
  border-radius: 6px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  cursor: pointer;
  transition: color 150ms, background-color 150ms, border-color 150ms;
}
.nc-approval-option:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
/* bg-primary text-primary-foreground hover:bg-primary/90 */
.nc-approval-option--primary {
  background: var(--nc-primary);
  color: var(--nc-primary-foreground);
}
.nc-approval-option--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--nc-primary) 90%, transparent);
}
/* border border-border bg-background text-foreground hover:bg-accent */
.nc-approval-option--secondary {
  border-color: var(--nc-border);
  background: var(--nc-background);
  color: var(--nc-foreground);
}
.nc-approval-option--secondary:hover:not(:disabled) {
  background: var(--nc-accent);
}
.nc-approval-option:disabled {
  opacity: 0.5;
  cursor: default;
}
.nc-approval-reason {
  box-sizing: border-box;
  flex: 1 1 160px;
  min-width: 120px;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--nc-input);
  border-radius: 6px;
  background: var(--nc-background);
  color: var(--nc-foreground);
  font: inherit;
  font-size: 12px;
}
.nc-approval-reason:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-approval-rules {
  flex-shrink: 0;
  color: var(--nc-muted-foreground);
  font-size: 12px;
  line-height: 16px;
}
.nc-approval-rules ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.nc-approval-rules li {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  word-break: break-all;
}
.nc-approval-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
