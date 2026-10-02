<script setup>
// A terminal agent's conversation as a chat, over its terminal pane, after
// Orca's transcript-view native chat (NativeChatResolvedView.tsx and its
// transcript watch, MIT, Copyright (c) 2026 Lovecast Inc.). The main process
// reads the agent's session file (src/main/chat/transcriptView.js) and sends
// it again while the agent writes; the chat's list shows it.
// Read-only (Grok, OMP): typing stays in the terminal, no composer.
// interactive (Claude Code, OpenClaude, Codex, Cursor, Antigravity: the pane's chat view): a
// composer whose messages are typed into the terminal (sendMessage, Tessel's
// delivery), Stop (Escape), and the card of what the agent waits for: its
// question (answered with its selector's keys) or its approval (Allow / Deny).
// The agent keeps running in its terminal under this view: nothing is
// restarted to show it or to go back (src/renderer/src/chat/terminalChatBridge.js).
// Props: agent, sessionId ('' = none known yet: waiting for it), agentName,
//   node, isVisible (the file is watched only while the view shows);
//   interactive: paneId, accountId (the main process finds the file in that
//   account's folder), working, waiting ({ approval, input, ask: the
//   question its hook gives, or null }),
//   disabledReason (why nothing can be sent now), sendMessage(text,
//   { images, command, onDelivered, onFailed, onQueued, onTyped }), writeKeys(bytes) (the
//   cards' keys); the full composer's (after Orca's bridge composer,
//   NativeChatComposer.tsx and NativeChatComposerActions.tsx): allowImages
//   (pasted, dropped, picked: Tessel's copies, whose paths are pasted into
//   the agent's input), slash commands (the agent's own, typed into it as
//   commands, with a "Ran /command" row), "@" files (listFiles() ->
//   relative paths), model and effort (sessionOptions { models, values },
//   setOption({ model } | { effort }) -> { ok, error }: the pane's own
//   model menu path; Codex changes them in its own picker, opened in the
//   terminal), the permission mode (permissionMode: the mode it is in;
//   modeBlocked(mode) -> '' or why it cannot be picked now;
//   setPermissionMode(mode) -> { ok, error }: Claude Code's and OpenClaude's
//   Shift+Tab, run by the pane; Codex changes it in its own /permissions
//   picker, opened in the terminal), the context ring (contextModel: the
//   model, for its context window: terminalChatExtras.js; screenContext:
//   what the agent's status line says of it, when its file never does) and voice typing
//   (dictate, dictationTitle); paneActions (the right-click menu's: split,
//   maximize, close; Paste goes into the composer, "Continue in a terminal"
//   shows the terminal), background ({ ids, listedAt }: what the agent's last
//   Stop listed, for the background-task dock), sendHeldReason() -> '' or why
//   a message sent from here still waits to be typed (shown on its card).
// A message waits for the end of the agent's turn (and anything else
// Tessel's delivery waits for) as a card above the composer, after Orca's
// queued-message cards (MIT, Copyright (c) 2026 Lovecast Inc.): edit, delete
// or send now through its delivery's controls (sendMessage's onQueued); it
// joins the transcript once it is typed (onTyped).
// The "/" menu also lists the agent's skills (transcriptView:skills), and
// scrolling up reads earlier lines of its file (transcriptView:earlier).
// Emits: close (back to the terminal).
// Exposed: focus() (the composer).
import { computed, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue'
import { MessageCircleQuestion, MessagesSquare, ShieldQuestion, SquareTerminal } from 'lucide-vue-next'
import './orca-tokens.css'
import NativeChatComposer from './NativeChatComposer.vue'
import NativeChatContextBanner from './NativeChatContextBanner.vue'
import NativeChatContextMenu from './NativeChatContextMenu.vue'
import NativeChatStructuredSessionStatus from './NativeChatStructuredSessionStatus.vue'
import NativeChatEmptyState from './NativeChatEmptyState.vue'
import NativeChatMessageList from './NativeChatMessageList.vue'
import NativeChatQuestionCard from './NativeChatQuestionCard.vue'
import NativeChatQueuedMessages from './NativeChatQueuedMessages.vue'
import { Button } from './ui/index.js'
import { createJournalAdapter } from '../../../chat/orca/adapter/journalAdapter.js'
import { reduceStructuredAgentSession, EMPTY_STRUCTURED_AGENT_SESSION } from '../../../chat/orca/shared/structured-agent-session-reducer.js'
import { projectStructuredAgentSessionMessages } from '../../../chat/orca/structured-agent-session-message-projection.js'
import { useNativeChatLinkActions } from '../../../chat/orca/composables/use-native-chat-link-actions.js'
import { useNativeChatSessionOptionCommand } from '../../../chat/orca/composables/use-native-chat-session-option-command.js'
import { useNativeChatWorkspaceFileDrop } from '../../../chat/orca/composables/use-native-chat-workspace-file-drop.js'
import { useStructuredAgentSessionContextUsage } from '../../../chat/orca/composables/use-structured-agent-session-context-usage.js'
import { appendCommandMarkerCache, readCommandMarkerCache } from '../../../chat/orca/native-chat-command-marker.js'
import { TESSEL_PERMISSION_MODES, permissionModeDescriptor, tesselSessionOptionSnapshot, tesselSessionOptionSurface } from './native-chat-session-option-pickers.js'
import {
  KEY_CTRL_C,
  KEY_ESCAPE,
  answerKeyGroups,
  askInTerminalFromEvents,
  bridgeSlashCommands,
  cardKeys,
  commandDelivery,
  composerAgent,
  hasModePicker,
  keysAllowed,
  ownModelPicker,
  isPastedImageCopy,
  mentionMatches,
  mergePendingSends,
  currentAsk,
  stepKeys,
  tagTesselTurns,
  waitingCard,
  withCommandMarkers,
  withContextWindow,
  screenContextUsage,
  compactCommand
} from '../../../chat/terminalChatBridge.js'
import { mergeCommandMarkers, splitCommandTurns, terminalBackgroundTasks } from '../../../chat/terminalChatExtras.js'
import { t } from '../../../i18n'
import { useNativeChatFontScale } from '../../../chat/orca/composables/use-native-chat-font-scale.js'

const props = defineProps({
  agent: { type: String, required: true },
  sessionId: { type: String, default: '' },
  agentName: { type: String, default: '' },
  // The pane the view covers (its folder bounds the file links).
  node: { type: Object, default: null },
  isVisible: { type: Boolean, default: true },
  // The selected pane: Ctrl+= / Ctrl+- / Ctrl+0 zoom this chat only.
  isActive: { type: Boolean, default: false },
  interactive: { type: Boolean, default: false },
  paneId: { type: String, default: '' },
  accountId: { type: String, default: undefined },
  working: { type: Boolean, default: false },
  waiting: { type: Object, default: () => ({}) },
  disabledReason: { type: String, default: '' },
  sendMessage: { type: Function, default: undefined },
  writeKeys: { type: Function, default: undefined },
  // The full composer (interactive).
  allowImages: { type: Boolean, default: false },
  sessionOptions: { type: Object, default: null },
  setOption: { type: Function, default: undefined },
  listFiles: { type: Function, default: undefined },
  contextModel: { type: String, default: '' },
  // What the agent's status line says of its context ({ usedTokens,
  // windowTokens } or null), for an agent whose file never says it (Cursor).
  screenContext: { type: Object, default: null },
  // The next message the agent suggests on its screen (Claude Code's greyed
  // prompt suggestion): the composer's placeholder, Tab takes it.
  promptSuggestion: { type: String, default: '' },
  // The permission mode picker (interactive).
  permissionMode: { type: String, default: '' },
  modeBlocked: { type: Function, default: undefined },
  setPermissionMode: { type: Function, default: undefined },
  dictate: { type: Function, default: undefined },
  dictationTitle: { type: String, default: undefined },
  // The right-click menu, the background-task dock, held messages (interactive).
  paneActions: { type: Object, default: null },
  background: { type: Object, default: null },
  sendHeldReason: { type: Function, default: undefined }
})
const emit = defineEmits(['close'])

// A session file appears with the agent's first message: looked for again
// meanwhile, while the view shows.
const RETRY_MS = 3000
// A message the agent took but whose turn the file never showed (it may show
// it in another form) stops being shown as sent after this long.
const SENT_SHOWN_MS = 2 * 60 * 1000

const rootRef = ref(null)
const composerRef = ref(null)
const phase = ref('loading') // loading | ready | missing | error
const state = shallowRef(EMPTY_STRUCTURED_AGENT_SESSION)
const truncated = ref(false)
const draft = ref('')
// What the file says (Tessel's own lines marked), and what was sent from
// here and is not in it yet (shown as sent meanwhile).
const fileEvents = shallowRef([])
const pendingSends = shallowRef([])
// The slash commands the file shows ("Ran /x" rows, not your messages), its
// background tasks, whether earlier lines can still be read.
const fileCommands = shallowRef([])
const fileBackground = shallowRef([])
const hasEarlier = ref(false)
const loadingEarlier = ref(false)
const olderGeneration = ref(0)
// Each message sent from here scrolls the list to it.
const sentSignal = ref(0)
let viewId = null
let opening = false
let off = null
let retry = null
let alive = true
let nextSend = 0
let answering = null
let answeredTimer = null

function api() {
  const a = typeof window !== 'undefined' && window.shellApi ? window.shellApi.transcriptView : null
  return a && typeof a.open === 'function' ? a : null
}

// The whole conversation again (the main process re-reads the file's tail),
// with the messages sent from here that it does not show yet.
function render() {
  const now = Date.now()
  // A message not typed yet is a card, not a row.
  const rows = (list) => list.filter((p) => p.typed || p.delivered)
  let merged = mergePendingSends(fileEvents.value, rows(pendingSends.value))
  const keep = pendingSends.value.filter((p) => !merged.done.includes(p.id) && !(p.delivered && now - p.at > SENT_SHOWN_MS))
  if (keep.length !== pendingSends.value.length) {
    pendingSends.value = keep
    merged = mergePendingSends(fileEvents.value, rows(keep))
  }
  const adapter = createJournalAdapter({ now: () => 0 })
  adapter.replay(merged.events)
  state.value = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, { type: 'event', event: adapter.snapshotEvent() }, 0)
}
// One read of the file: { events, more, background }.
function show(res) {
  const tagged = tagTesselTurns(withContextWindow((res && res.events) || [], props.contextModel, props.agent))
  const split = props.interactive ? splitCommandTurns(tagged) : { events: tagged, commands: [] }
  fileEvents.value = split.events
  fileCommands.value = split.commands
  fileBackground.value = res && Array.isArray(res.background) ? res.background : []
  hasEarlier.value = !!(res && res.more)
  render()
}

function stopRetry() {
  if (retry) clearTimeout(retry)
  retry = null
}
function openArgs() {
  if (!props.interactive) return { agent: props.agent, sessionId: props.sessionId }
  return { agent: props.agent, sessionId: props.sessionId, paneId: props.paneId, ...(props.accountId !== undefined ? { accountId: props.accountId } : {}) }
}
async function openView() {
  stopRetry()
  const a = api()
  if (!a || viewId || opening) {
    if (!a) phase.value = 'error'
    return
  }
  // No conversation known yet (a new Codex finds its id after its first
  // message): waiting for it.
  if (!props.sessionId) {
    phase.value = 'missing'
    return
  }
  const asked = props.sessionId
  let res
  opening = true
  try {
    res = await a.open(openArgs())
  } catch {
    res = { ok: false, code: 'error' }
  } finally {
    opening = false
  }
  if (!alive || !props.isVisible || asked !== props.sessionId) {
    if (res && res.ok) a.close({ viewId: res.viewId })
    // Another conversation meanwhile: that one is opened now.
    if (alive && props.isVisible) openView()
    return
  }
  if (!res || !res.ok) {
    phase.value = res && res.code === 'missing' ? 'missing' : 'error'
    if (phase.value === 'missing') retry = setTimeout(openView, RETRY_MS)
    return
  }
  viewId = res.viewId
  viewOpen.value = true
  truncated.value = !!res.truncated
  show(res)
  phase.value = 'ready'
}
// Scrolled up: the lines before those shown, read from the same file
// (bounded in the main process). -> 'applied' | 'unchanged' | 'failed'
async function loadEarlier() {
  const a = api()
  if (!a || typeof a.earlier !== 'function' || !viewId || loadingEarlier.value || !hasEarlier.value) return 'unchanged'
  const asked = viewId
  loadingEarlier.value = true
  let res
  try {
    res = await a.earlier({ viewId })
  } catch {
    res = null
  } finally {
    loadingEarlier.value = false
  }
  if (!alive || asked !== viewId) return 'unchanged'
  if (!res || !res.ok) return 'failed'
  truncated.value = !!res.truncated
  show(res)
  if (!res.added) return 'unchanged'
  olderGeneration.value++
  return 'applied'
}
function closeView() {
  stopRetry()
  const a = api()
  if (a && viewId) a.close({ viewId })
  viewId = null
  viewOpen.value = false
}

onMounted(() => {
  const a = api()
  if (a && typeof a.onEvent === 'function') {
    const unsubscribe = a.onEvent((msg) => {
      if (!msg || msg.viewId !== viewId || !viewId) return
      if (msg.ok) {
        truncated.value = !!msg.truncated
        show(msg)
        phase.value = 'ready'
      }
    })
    if (typeof unsubscribe === 'function') off = unsubscribe
  }
  if (props.isVisible) openView()
})
onBeforeUnmount(() => {
  alive = false
  closeView()
  if (answering) answering.cancel()
  clearTimeout(answeredTimer)
  if (off) off()
})
// Watched only while it shows.
watch(
  () => props.isVisible,
  (visible) => {
    if (visible) openView()
    else closeView()
  }
)
// Another conversation in the pane (/clear, /resume, its id found later).
watch(
  () => props.sessionId,
  () => {
    closeView()
    fileEvents.value = []
    fileCommands.value = []
    fileBackground.value = []
    hasEarlier.value = false
    phase.value = 'loading'
    render()
    if (props.isVisible) openView()
  }
)

// The composer's key (its draft, images and markers are kept per pane).
const composerKey = computed(() => `terminal-chat-${props.paneId}`) // i18n-ignore
// "Ran /compact" rows of the commands sent from here (this conversation's).
const markerScope = () => ({ paneKey: composerKey.value, agent: props.agent, sessionId: props.sessionId || '' })
const markers = shallowRef(props.interactive ? readCommandMarkerCache(markerScope()) : [])
watch(
  () => props.sessionId,
  () => {
    markers.value = props.interactive ? readCommandMarkerCache(markerScope()) : []
  }
)
// The file's commands (each run once) and those sent from here it lacks yet.
const allMarkers = computed(() => mergeCommandMarkers(markers.value, fileCommands.value))
const messages = computed(() => withCommandMarkers(projectStructuredAgentSessionMessages(state.value.items, [], state.value.submissions), allMarkers.value))
const session = computed(() => ({
  messages: messages.value,
  status: messages.value.length ? 'ready' : 'empty',
  sessionId: props.sessionId,
  agent: props.agent,
  hasMore: hasEarlier.value,
  loadingEarlier: loadingEarlier.value,
  olderHistoryGeneration: olderGeneration.value,
  loadEarlier,
  readPhase: 'ready'
}))
const fileLinkContext = computed(() => {
  const n = props.node
  const folder = n && (n.startDir || n.cwd || n.projectDir)
  return folder ? { worktreeId: n.id, worktreePath: folder, roots: [folder, n.projectDir].filter(Boolean) } : null
})
const { onLinkClick } = useNativeChatLinkActions(fileLinkContext, rootRef, () => ({ isVisible: props.isVisible }))
// Its own text size (Ctrl+= / Ctrl+- / Ctrl+0, Ctrl+wheel) while it is the
// selected pane, kept per pane: never the terminals' size, never another chat's.
// Also while the keyboard is in it (its composer): the pane may not be the
// selected one yet, and the app's own zoom leaves typing fields alone.
const hasFocus = ref(false)
function onFocusIn() {
  hasFocus.value = true
}
function onFocusOut(event) {
  if (!rootRef.value || !rootRef.value.contains(event.relatedTarget)) hasFocus.value = false
}
const fontScale = useNativeChatFontScale(
  () => props.interactive && props.isVisible && (props.isActive || hasFocus.value),
  () => ({ target: rootRef.value, storageKey: props.paneId ? `tessel.chat.fontScale.${props.paneId}` : undefined }) // i18n-ignore
)
provide('nativeChatFileLinkContext', fileLinkContext)

// ---- Interactive (the pane's chat view) ---------------------------------------

// Never two Ctrl+C close together (Cursor quits on the second: terminalChatBridge.js).
let lastCtrlCAt = null
function keys(bytes) {
  if (!props.writeKeys || !keysAllowed(bytes, lastCtrlCAt)) return
  if (bytes.includes(KEY_CTRL_C)) lastCtrlCAt = Date.now()
  props.writeKeys(bytes)
}
// A slash command, typed into the agent as one (Codex key by key), with its
// "Ran /command" row; nothing is watched for it.
function sendCommand(text, how = commandDelivery(props.agent, text) || 'paste') {
  if (!props.sendMessage || props.disabledReason) return { ok: false, error: props.disabledReason || undefined }
  const command = String(text || '').trim()
  props.sendMessage(command, { command: how })
  markers.value = appendCommandMarkerCache(markerScope(), command)
  sentSignal.value++
  return { ok: true }
}
// The images' files (Tessel's copies of what was pasted, dropped or picked),
// from their ids; only those copies are ever named to the agent.
async function imagePaths(ids) {
  const a = typeof window !== 'undefined' && window.shellApi && window.shellApi.chat
  const failed = { ok: false, error: t('chat.orca.composer.imageFailed', 'The image could not be attached.') }
  if (!a || typeof a.imagePaths !== 'function') return failed
  let res
  try {
    // The composer saved them under its own key (its attachment scope).
    res = await a.imagePaths({ paneId: composerKey.value, ids })
  } catch {
    return failed
  }
  if (!res || !res.ok || !Array.isArray(res.paths)) return { ok: false, error: (res && res.error) || failed.error }
  const paths = res.paths.filter(isPastedImageCopy)
  return paths.length === ids.length ? { ok: true, paths } : failed
}
// (text, { images }) -> { ok }: a command is typed as one; a message (its
// images' paths pasted first) is typed into the terminal by Tessel's
// delivery (it waits while the agent asks for approval or a line is typed in
// the terminal) and shown as sent until the agent's file has it.
async function send(text, opts = {}) {
  const body = String(text || '')
  const ids = Array.isArray(opts && opts.images) ? opts.images.filter((id) => typeof id === 'string') : []
  if (!body.trim() && !ids.length) return { ok: false }
  if (props.disabledReason) return { ok: false, error: props.disabledReason }
  if (!props.sendMessage) return { ok: false }
  const how = commandDelivery(props.agent, body, ids.length)
  if (how) return sendCommand(body, how)
  let images = []
  if (ids.length) {
    const res = await imagePaths(ids)
    if (!res.ok) return res
    images = res.paths
  }
  if (!alive || props.disabledReason) return { ok: false, error: props.disabledReason || undefined }
  const id = ++nextSend
  const shown = body.trim() ? body : t('chat.orca.terminalChat.imageOnly', '(image)')
  const userRows = () => fileEvents.value.filter((e) => e && e.type === 'user' && e.origin !== 'team').length
  pendingSends.value = [...pendingSends.value, { id, text: shown, at: Date.now(), delivered: false, typed: false, controls: null, imageCount: ids.length, seen: userRows() }]
  render()
  sentSignal.value++
  watchHeld()
  const update = (patch) => {
    pendingSends.value = pendingSends.value.map((p) => (p.id === id ? { ...p, ...patch } : p))
    render()
  }
  props.sendMessage(body, {
    ...(images.length ? { images } : {}),
    onQueued: (controls) => update({ controls }),
    // Typed now: a row from here, timed and placed from now (it may have waited).
    onTyped: () => update({ typed: true, at: Date.now(), seen: userRows() }),
    onDelivered: () => update({ delivered: true }),
    onFailed: () => {
      pendingSends.value = pendingSends.value.filter((p) => p.id !== id)
      render()
    }
  })
  return { ok: true }
}

// A message Tessel's delivery holds (a line typed in the terminal, an
// approval to answer first) shows as waiting, with why, until it is typed:
// asked every second while one is not typed yet.
const HELD_POLL_MS = 1000
const heldReason = ref('')
let heldTimer = null
function checkHeld() {
  const waiting = pendingSends.value.some((p) => !p.typed && !p.delivered)
  let why = ''
  if (waiting && typeof props.sendHeldReason === 'function') {
    try {
      why = props.sendHeldReason() || ''
    } catch {
      why = ''
    }
  }
  heldReason.value = typeof why === 'string' ? why : ''
  if (!waiting || !alive) {
    clearInterval(heldTimer)
    heldTimer = null
  }
}
function watchHeld() {
  if (heldTimer || typeof props.sendHeldReason !== 'function') return
  heldTimer = setInterval(checkHeld, HELD_POLL_MS)
  checkHeld()
}
onBeforeUnmount(() => clearInterval(heldTimer))
// The cards: what was sent from here and is not typed yet, with why it waits.
const queuedCards = computed(() => {
  const caption = heldReason.value || (props.working ? t('chat.orca.queued.untilTurnEnd', 'Typed when the turn ends') : '')
  return pendingSends.value
    .filter((p) => !p.typed && !p.delivered)
    .map((p) => ({ id: String(p.id), text: p.text, ...(p.imageCount ? { imageCount: p.imageCount } : {}), ...(caption ? { caption } : {}) }))
})
// Why a card's action failed, under the composer for a few seconds.
const queuedNotice = ref(null)
let noticeTimer = null
function setComposerNotice(text) {
  queuedNotice.value = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (queuedNotice.value = null), 6000)
}
onBeforeUnmount(() => clearTimeout(noticeTimer))
const pendingById = (id) => pendingSends.value.find((p) => String(p.id) === id) || null
// A card's action through its delivery's controls; already typed: said.
function queuedAction(id, run) {
  const p = pendingById(id)
  const res = p && p.controls ? run(p) : { ok: false }
  if (!res || res.ok === false) setComposerNotice(res && res.code === 'gone' ? t('chat.orca.queued.gone', 'This message is already being sent.') : t('chat.orca.queued.failed', 'The waiting message could not be changed.'))
  return res
}
function onQueuedRemove(id) {
  return queuedAction(id, (p) => {
    const res = p.controls.remove()
    if (res && res.ok) {
      pendingSends.value = pendingSends.value.filter((x) => x !== p)
      render()
    }
    return res
  })
}
function onQueuedEdit(id, text) {
  return queuedAction(id, (p) => {
    const res = p.controls.edit(text)
    if (res && res.ok) pendingSends.value = pendingSends.value.map((x) => (x === p ? { ...x, text } : x))
    return res
  })
}
function onQueuedSendNow(id) {
  return queuedAction(id, (p) => p.controls.sendNow())
}

// ---- Model and effort (the pane's model menu path) ----------------------------
const isCodex = computed(() => composerAgent(props.agent) === 'codex')
// Codex and Cursor change their model (and effort) in their own picker: typed
// (/model) and shown in their terminal, where you pick (after Orca's
// agent-picker options).
const ownPicker = computed(() => ownModelPicker(props.agent))
function openAgentPicker() {
  const res = sendCommand('/model', 'type')
  if (res.ok) emit('close')
  return res
}
const optionCommand = useNativeChatSessionOptionCommand({
  scopeKey: () => composerKey.value,
  node: () => props.node || {},
  agent: () => composerAgent(props.agent),
  isWorking: () => props.working,
  disabledReason: () => props.disabledReason,
  values: () => (props.sessionOptions && props.sessionOptions.values) || {},
  setOption: async (payload) => {
    // Cursor: a model switches through the pane (/model with its name); an
    // effort opens its own picker, shown in the terminal (Tab on the model).
    if (props.agent === 'cursor' && props.setOption) {
      const res = await props.setOption(payload)
      if (!res || !res.ok || !res.picker) return res || { ok: false }
      emit('close')
      return { ok: false, error: t('chat.orca.terminalChat.pickerOpened', "{{agent}}'s model picker is open in its terminal: Tab on the model changes its effort or Fast.", { agent: props.agentName || props.agent }) }
    }
    if (ownPicker.value) {
      openAgentPicker()
      return isCodex.value
        ? { ok: false, error: t('chat.orca.terminalChat.codexPicker', 'Codex changes its model and effort in its own picker: choose in its terminal.') }
        : { ok: false, error: t('chat.orca.terminalChat.ownPicker', '{{agent}} changes its model in its own picker: choose in its terminal.', { agent: props.agentName || props.agent }) }
    }
    return props.setOption ? props.setOption(payload) : { ok: false }
  },
  onError: () => {}
})
// The permission mode: the agent's own (Shift+Tab in Claude Code and
// OpenClaude, run by the pane; /permissions in Codex, its own picker opened in
// the terminal), with ChatPane's wording. Not during a turn: a key typed then
// could land in an approval prompt that opens meanwhile.
const modeDescriptor = computed(() => {
  if (!props.interactive || !hasModePicker(props.agent) || !props.permissionMode || (!props.setPermissionMode && !isCodex.value)) return null
  const agent = composerAgent(props.agent)
  return permissionModeDescriptor({
    agent,
    modes: TESSEL_PERMISSION_MODES[agent],
    current: props.permissionMode,
    modeBlocked: (mode) => (typeof props.modeBlocked === 'function' ? props.modeBlocked(mode) || '' : ''),
    settableWhileWorking: false
  })
})
function openPermissionsPicker() {
  const res = sendCommand('/permissions', 'type')
  if (res.ok) emit('close')
  return res
}
async function changePermissionMode(mode) {
  if (mode === props.permissionMode) return { ok: true }
  if (isCodex.value) {
    openPermissionsPicker()
    return { ok: false, error: t('chat.orca.terminalChat.codexPermissions', 'Codex changes its permissions in its own picker: choose in its terminal.') }
  }
  if (props.disabledReason) return { ok: false, error: props.disabledReason }
  return props.setPermissionMode ? props.setPermissionMode(mode) : { ok: false }
}
const modelSurface = computed(() => (props.sessionOptions && props.setOption ? tesselSessionOptionSurface(optionCommand.dispatch) : null))
const optionSnapshot = computed(() => [
  ...(props.sessionOptions
    ? tesselSessionOptionSnapshot({
        agent: composerAgent(props.agent),
        models: props.sessionOptions.models || [],
        values: optionCommand.confirmedValues.value,
        permissionModes: false
      })
    : []),
  ...(modeDescriptor.value ? [modeDescriptor.value] : [])
])
// The pickers' surface: the model and effort through the pane's model menu
// path, the permission mode through changePermissionMode.
const optionSurface = computed(() => {
  const models = modelSurface.value
  if (!modeDescriptor.value) return models
  const none = { ok: false, error: t('chat.orca.options.unsupported', 'This option is not available for this agent.') }
  return {
    setOption: (id, value) => (id === 'permissionMode' ? changePermissionMode(value) : models ? models.setOption(id, value) : Promise.resolve(none)),
    setOptions: async (values) => {
      const { permissionMode, ...rest } = values || {}
      if (Object.keys(rest).length) {
        const res = models ? await models.setOptions(rest) : none
        if (!res || res.ok === false || permissionMode === undefined) return res
      }
      return permissionMode === undefined ? { ok: true } : changePermissionMode(permissionMode)
    },
    invokeAction: models ? models.invokeAction : async () => none
  }
})
const optionIds = computed(() => optionSnapshot.value.map((o) => o.id))
const optionPickerRequest = ref(null)
// A bare "/model" or "/effort" (typed or picked): its picker here; Codex's
// own; an agent without a list here (OpenClaude) gets the command itself.
function onOptionCommand(name) {
  if (ownPicker.value && (name === 'model' || name === 'effort')) return openAgentPicker()
  if (optionIds.value.includes(name)) {
    const current = optionPickerRequest.value
    optionPickerRequest.value = { id: name, sequence: (current ? current.sequence : 0) + 1 }
    return { ok: true }
  }
  if (name === 'model' || name === 'effort') return sendCommand(`/${name}`)
  return { ok: false, error: t('chat.orca.options.unsupported', 'This option is not available for this agent.') }
}
// A typed "/model x", "/effort x" or "/permissionMode x".
function setOptionFromText(payload) {
  const [optionId] = Object.keys(payload || {})
  if (optionId === 'permissionMode') {
    const why = modeDescriptor.value ? '' : t('chat.orca.options.unsupported', 'This option is not available for this agent.')
    const choice = modeDescriptor.value && modeDescriptor.value.kind.choices.find((c) => c.value === payload[optionId])
    const blocked = why || (!choice ? t('chat.orca.options.unsupported', 'This option is not available for this agent.') : choice.disabledReason || '')
    return blocked ? Promise.resolve({ ok: false, error: blocked }) : Promise.resolve(changePermissionMode(payload[optionId]))
  }
  return optionCommand.dispatch({ optionId, value: payload[optionId] })
}
const slashCommands = computed(() => bridgeSlashCommands(props.agent, { options: optionIds.value }))

// ---- "@" files, context -----------------------------------------------------------
// The project's files, read when "@" is first typed (again after a minute).
const FILES_STALE_MS = 60 * 1000
const files = shallowRef(null)
let filesAt = 0
let filesLoading = false
async function loadFiles() {
  if (filesLoading || typeof props.listFiles !== 'function') return
  filesLoading = true
  try {
    const list = await props.listFiles()
    if (alive && Array.isArray(list)) {
      files.value = list
      filesAt = Date.now()
    }
  } catch {
    /* no list: the plain hint */
  } finally {
    filesLoading = false
  }
}
function mentionSuggest(query) {
  if (!files.value || Date.now() - filesAt > FILES_STALE_MS) void loadFiles()
  return files.value ? mentionMatches(files.value, query) : []
}
const fileContextUsage = useStructuredAgentSessionContextUsage(() => state.value.items, null)
const contextUsage = computed(() => fileContextUsage.value || screenContextUsage(props.screenContext))
// The low-context banner's Compact: the agent's own (/compact, Cursor's /summarize).
function compact() {
  return sendCommand(compactCommand(props.agent))
}

// ---- Skills, background tasks, the right-click menu -----------------------------
// The "/" menu's skills: the agent's own (its project's, by its open view;
// the user's; its account's), found by the main process.
const viewOpen = ref(false)
const skillsOptions = computed(() => {
  const a = api()
  if (!props.interactive || !a || typeof a.skills !== 'function') return undefined
  return {
    // Found again once its view is open (its project's folder is known then).
    contextKey: `${props.sessionId}:${viewOpen.value ? 'view' : 'none'}`, // i18n-ignore key
    discover: async ({ refresh } = {}) => {
      const res = await a.skills({
        agent: props.agent,
        ...(props.accountId !== undefined ? { accountId: props.accountId } : {}),
        ...(viewId ? { viewId } : {}),
        ...(refresh ? { refresh: true } : {})
      })
      if (!res || res.ok === false || !res.result) throw new Error((res && res.error) || t('chat.orca.skills.unavailable', 'Skill discovery is unavailable.'))
      return res.result
    }
  }
})
// The background work it still runs, from its file, less what its last Stop
// no longer listed (no Stop here: see terminalBackgroundTasks).
const backgroundTasks = computed(() =>
  terminalBackgroundTasks(fileBackground.value, {
    ids: props.background && Array.isArray(props.background.ids) ? props.background.ids : null,
    listedAt: props.background ? props.background.listedAt : null,
    working: props.working
  })
)
const contextMenuRef = shallowRef(null)
const menuActions = computed(() => ({
  ...(props.paneActions || {}),
  onPaste: () => composerRef.value && composerRef.value.pasteFromClipboard && composerRef.value.pasteFromClipboard(),
  onSwitchToTerminal: () => emit('close')
}))
function onContextMenu(event) {
  if (props.interactive && contextMenuRef.value) contextMenuRef.value.onContextMenu(event)
}
// A file dropped anywhere on the chat (its list or its composer), from the
// system or Tessel's file tree: an image is attached as a pasted one, another
// file's path goes into the draft (as in the chat pane). Taken here, never
// passed on to the terminal under it (which would type the paths into it).
const fileDrop = useNativeChatWorkspaceFileDrop(() => ({
  paneKey: composerKey.value,
  sessionId: props.sessionId,
  disabled: !props.interactive || !!props.disabledReason,
  attachResolvedPaths: (paths, connectionId, ownership) =>
    composerRef.value && composerRef.value.attachResolvedPaths ? composerRef.value.attachResolvedPaths(paths, connectionId, ownership) : false
}))
function onDragOverCapture(event) {
  if (props.interactive) fileDrop.onDragOverCapture(event)
}
function onDropCapture(event) {
  if (props.interactive) fileDrop.onDropCapture(event)
}
function onSelectionCapture() {
  if (contextMenuRef.value) contextMenuRef.value.rememberSelection()
}
function onPointerDownCapture(event) {
  if (event.button === 2) onSelectionCapture()
}

// Stop: the terminal's own key, Escape (Cursor: Ctrl+C), only while a turn runs.
function stop() {
  if (props.working) keys(cardKeys(props.agent).stop)
}

// Its hook's question first (shown at once), else the file's.
const ask = computed(() => (props.interactive ? currentAsk((props.waiting || {}).ask, fileEvents.value) : null))
// An approval answered here (Allow or Deny sent) shows no card until another
// one comes (its key: when the pane went into it), or after a while if the
// pane never left it (the key may not have landed): a second click would type
// into the agent's input.
const ANSWERED_HIDE_MS = 8000
const answeredApproval = ref(null) // the key of the approval answered
let answeredApprovalTimer = null
const approvalKey = () => String((props.waiting || {}).approvalKey ?? '')
function markApprovalAnswered() {
  answeredApproval.value = approvalKey()
  clearTimeout(answeredApprovalTimer)
  answeredApprovalTimer = setTimeout(() => (answeredApproval.value = null), ANSWERED_HIDE_MS)
}
watch(
  () => !!(props.waiting || {}).approval,
  (on) => {
    if (!on) answeredApproval.value = null
  }
)
onBeforeUnmount(() => clearTimeout(answeredApprovalTimer))
const card = computed(() => {
  if (!props.interactive || props.disabledReason) return null
  const w = props.waiting || {}
  // Antigravity's question (its own selector) shows from its file: answered in its terminal.
  const input = !!w.input || askInTerminalFromEvents(props.agent, fileEvents.value)
  const shown = waitingCard({ approval: !!w.approval, input, working: props.working }, ask.value)
  if (shown && shown.kind === 'approval' && answeredApproval.value !== null && answeredApproval.value === approvalKey()) return null
  return shown
})
const questionSending = ref(false)
function onQuestionAnswer(selections) {
  const c = card.value
  if (!c || c.kind !== 'question' || questionSending.value) return
  const groups = answerKeyGroups(props.agent, c.ask.prompt, selections)
  if (!groups.length) return
  questionSending.value = true
  answering = stepKeys(groups, keys)
  answeredTimer = setTimeout(() => {
    questionSending.value = false
    answering = null
  }, answering.settleAfterMs)
}
function onQuestionCancel() {
  if (answering) answering.cancel()
  answering = null
  clearTimeout(answeredTimer)
  questionSending.value = false
  keys(KEY_ESCAPE)
}
function approve() {
  if (!card.value || card.value.kind !== 'approval') return
  markApprovalAnswered()
  keys(cardKeys(props.agent).allow)
}
function deny() {
  if (!card.value || card.value.kind !== 'approval') return
  markApprovalAnswered()
  keys(cardKeys(props.agent).deny)
}
const fromAgent = computed(() => props.agentName || props.agent)
const questionHead = computed(() => t('chat.orca.question.from', '{{agent}} asks you', { agent: fromAgent.value }))
const approvalHead = computed(() => t('chat.orca.terminalChat.approvalTitle', '{{agent}} asks for your approval', { agent: fromAgent.value }))
const inTerminalHead = computed(() => t('chat.orca.terminalChat.answerInTerminal', '{{agent}} asks you something: answer it in its terminal.', { agent: fromAgent.value }))

defineExpose({
  focus: () => (composerRef.value && composerRef.value.focus ? composerRef.value.focus() : false)
})

const title = computed(() => t('chat.orca.transcriptView.title', 'Conversation of {{agent}}', { agent: props.agentName || props.agent }))
</script>

<template>
  <div
    ref="rootRef"
    class="nc-root nc-transcript-view"
    data-test="transcript-view"
    @pointerdown.capture="onPointerDownCapture"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
    @mouseup.capture="onSelectionCapture"
    @keyup.capture="onSelectionCapture"
    @contextmenu.capture="onContextMenu"
    @dragover.capture="onDragOverCapture"
    @drop.capture="onDropCapture"
  >
    <!-- The read-only view's bar. The chat view has none: the pane header
         already holds "Show terminal" (the user found the bar redundant). -->
    <div v-if="!interactive" class="nc-transcript-head">
      <MessagesSquare class="nc-transcript-icon" aria-hidden="true" />
      <span class="nc-transcript-title">{{ title }}</span>
      <span v-if="!interactive" class="nc-transcript-note">{{ t('chat.orca.transcriptView.readOnly', 'Read only: type in the terminal') }}</span>
      <span v-if="truncated" class="nc-transcript-note" data-test="transcript-view-truncated">{{ t('chat.orca.transcriptView.truncated', 'Latest part only') }}</span>
      <Button variant="ghost" size="sm" class="nc-transcript-back" data-test="transcript-view-close" @click="emit('close')">
        <SquareTerminal />
        {{ interactive ? t('chat.orca.terminalChat.showTerminal', 'Show terminal') : t('chat.orca.transcriptView.back', 'Back to terminal') }}
      </Button>
    </div>
    <div class="nc-transcript-body">
      <NativeChatEmptyState v-if="phase === 'loading'" kind="loading" />
      <div v-else-if="phase === 'missing' && !messages.length" class="nc-transcript-state" data-test="transcript-view-missing">
        <NativeChatEmptyState kind="empty" :agent="agent" />
        <p>
          {{
            interactive
              ? t('chat.orca.terminalChat.awaiting', 'Waiting for the conversation: it appears with the first message.')
              : t('chat.orca.transcriptView.missing', 'No conversation file yet: it appears with the first message.')
          }}
        </p>
      </div>
      <div v-else-if="phase === 'error'" class="nc-transcript-state" data-test="transcript-view-error">
        <NativeChatEmptyState kind="error" :message="t('chat.orca.transcriptView.error', 'The conversation could not be read.')" />
      </div>
      <NativeChatEmptyState v-else-if="!messages.length" kind="empty" :agent="agent" />
      <NativeChatMessageList
        v-else
        :session="session"
        :journal-items="state.items"
        :is-visible="isVisible"
        :font-scale="fontScale.scale.value"
        :is-working="interactive && working"
        :expand-signal="false"
        :show-live-turn-activity="false"
        :on-link-click="onLinkClick"
        :allow-file-uri-links="true"
        :scroll-to-latest-signal="sentSignal"
      />
    </div>
    <template v-if="interactive">
      <NativeChatStructuredSessionStatus
        :session-id="sessionId"
        :agent-label="fromAgent"
        :composer-error="queuedNotice"
        :is-visible="isVisible"
        :background-tasks="backgroundTasks"
        :stop-note="t('chat.orca.terminalChat.backgroundStop', 'To stop one, open its terminal: /tasks lists them there.')"
      />
      <div v-if="card && card.kind === 'question'" class="nc-term-card nc-term-question" data-test="terminal-chat-question">
        <p class="nc-term-card-head">
          <MessageCircleQuestion class="nc-term-card-icon" aria-hidden="true" />
          <span>{{ questionHead }}</span>
        </p>
        <NativeChatQuestionCard
          :key="card.ask.id"
          :prompt="card.ask.prompt"
          :allow-other="true"
          :is-submitting="questionSending"
          @answer="onQuestionAnswer"
          @cancel="onQuestionCancel"
        />
      </div>
      <div v-else-if="card && card.kind === 'approval'" class="nc-term-card nc-term-approval" data-test="terminal-chat-approval">
        <p class="nc-term-card-head">
          <ShieldQuestion class="nc-term-card-icon" aria-hidden="true" />
          <span>{{ approvalHead }}</span>
        </p>
        <p class="nc-term-card-note">{{ t('chat.orca.terminalChat.approvalNote', 'What it wants to do is shown in its terminal.') }}</p>
        <div class="nc-term-card-actions">
          <Button size="sm" data-test="terminal-chat-allow" @click="approve">{{ t('chat.orca.approval.allow', 'Allow') }}</Button>
          <Button size="sm" variant="outline" data-test="terminal-chat-deny" @click="deny">{{ t('chat.orca.approval.deny', 'Deny') }}</Button>
          <Button size="sm" variant="ghost" data-test="terminal-chat-see" @click="emit('close')">
            <SquareTerminal />
            {{ t('chat.orca.terminalChat.showTerminal', 'Show terminal') }}
          </Button>
        </div>
      </div>
      <div v-else-if="card && card.kind === 'terminal'" class="nc-term-card" data-test="terminal-chat-in-terminal">
        <p class="nc-term-card-head">
          <MessageCircleQuestion class="nc-term-card-icon" aria-hidden="true" />
          <span>{{ inTerminalHead }}</span>
        </p>
        <div class="nc-term-card-actions">
          <Button size="sm" variant="outline" @click="emit('close')">
            <SquareTerminal />
            {{ t('chat.orca.terminalChat.showTerminal', 'Show terminal') }}
          </Button>
        </div>
      </div>
      <NativeChatContextBanner
        :usage="contextUsage"
        :compact="compact"
        :busy="working || !!card"
        :disabled="!!disabledReason"
        :agent-name="fromAgent"
      />
      <NativeChatQueuedMessages
        :cards="queuedCards"
        :can-send-now="true"
        :send-now-title="t('chat.orca.queued.typeNowHint', 'Type it into the terminal now, without waiting for the end of the turn')"
        :send-now="onQueuedSendNow"
        :edit="onQueuedEdit"
        :remove="onQueuedRemove"
        :focus-composer="() => composerRef && composerRef.focus && composerRef.focus()"
      />
      <NativeChatComposer
        ref="composerRef"
        v-model="draft"
        :pane-key="composerKey"
        :prompt-suggestion="promptSuggestion"
        :agent="composerAgent(agent)"
        :agent-name="fromAgent"
        :is-working="working"
        :disabled-reason="disabledReason"
        :send="send"
        :allow-images="allowImages"
        :set-option="(sessionOptions && setOption) || modeDescriptor ? setOptionFromText : undefined"
        :on-option-command="onOptionCommand"
        :commands="slashCommands"
        :context-usage="contextUsage"
        :session-options-surface="optionSurface"
        :session-options-snapshot="optionSnapshot"
        :session-options-picker-request="optionPickerRequest"
        :mention-suggest="listFiles ? mentionSuggest : undefined"
        :dictate="dictate"
        :dictation-title="dictationTitle"
        :skills-options="skillsOptions"
        @interrupt="stop"
      />
      <NativeChatContextMenu ref="contextMenuRef" :root-el="rootRef" :enabled="isVisible" :actions="menuActions" />
    </template>
  </div>
</template>

<style scoped>
.nc-transcript-view {
  display: flex;
  height: 100%;
  min-height: 0;
  width: 100%;
  flex-direction: column;
  font-size: 14px;
}
.nc-transcript-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 12px;
  border-bottom: 1px solid var(--nc-border);
  background: color-mix(in srgb, var(--nc-muted) 60%, transparent);
  font-size: 12px;
}
.nc-transcript-icon {
  width: 14px;
  height: 14px;
  color: var(--nc-muted-foreground);
}
.nc-transcript-title {
  font-weight: 500;
  white-space: nowrap;
}
.nc-transcript-note {
  min-width: 0;
  overflow: hidden;
  color: var(--nc-muted-foreground);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-transcript-back {
  margin-left: auto;
}
.nc-transcript-body {
  display: flex;
  min-height: 0;
  flex: 1 1 0%;
  flex-direction: column;
}
.nc-transcript-state {
  display: flex;
  flex: 1 1 0%;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  overflow: hidden;
  color: var(--nc-muted-foreground);
  font-size: 12px;
  /* Narrow or short panes: the badge and title give way to the line alone. */
  container-type: size;
}
.nc-transcript-state p {
  max-width: 22rem;
  margin: 0;
  text-align: center;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
@container (max-width: 320px) {
  .nc-transcript-state :deep(.nc-empty) {
    display: none;
  }
}
@container (max-height: 220px) {
  .nc-transcript-state :deep(.nc-empty) {
    display: none;
  }
}
/* What the agent waits for: an accent line for its question, a warning line
   for its approval (as the chat pane sets them apart). */
.nc-term-card {
  flex-shrink: 0;
  padding: 6px 16px 8px;
  border-top: 2px solid color-mix(in srgb, var(--nc-muted-foreground) 50%, transparent);
  font-size: 12px;
}
.nc-term-question {
  padding: 0;
  border-top-color: color-mix(in srgb, var(--accent, #6aa0ff) 70%, transparent);
}
.nc-term-question .nc-term-card-head {
  padding: 0 16px;
}
.nc-term-approval {
  border-top-color: color-mix(in srgb, #e0a030 70%, transparent);
}
.nc-term-card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: 56rem;
  margin: 6px auto 0;
  font-weight: 500;
}
.nc-term-card-icon {
  width: 14px;
  height: 14px;
  color: var(--accent, #6aa0ff);
}
.nc-term-card-note {
  max-width: 56rem;
  margin: 4px auto 0;
  color: var(--nc-muted-foreground);
}
.nc-term-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 56rem;
  margin: 6px auto 0;
}
</style>
