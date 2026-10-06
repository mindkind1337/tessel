// The chat view of a terminal agent pane (pane menu > Switch to chat view):
// the agent keeps running in its terminal; its conversation file is shown as
// a chat over it, and what the chat sends is typed into that terminal. Nothing
// is stopped or started to switch between the two views.
//
// After Orca's terminal-pane native chat (use-terminal-pane-chat-state.ts,
// native-chat-availability.ts, use-native-chat-interactive-send.ts,
// native-chat-runtime-send.ts sendNativeChatAskAnswer, native-chat-send.ts,
// NativeChatResolvedView.tsx's optimistic message), MIT, Copyright (c) 2026
// Lovecast Inc. Rewritten for Tessel: messages go through Tessel's own
// delivery (deliver.js, which holds them during approvals or while you have
// a line typed in the terminal); only answers to a question card and the
// Allow / Deny / Stop keys are written here, and only when you click them.
// Pure: every effect goes through the functions given.
import { buildAskAnswerKeys, buildCodexAskAnswerKeys, hasAskAnswer, parseAskFromToolInput } from './orca/shared/native-chat-ask.js'
import { NATIVE_CHAT_QUESTION_STEP_MS, NATIVE_CHAT_SUBMIT_DELAY_MS } from './orca/shared/native-chat-answer-stepping.js'
import { getAgentSlashCommands } from './orca/shared/native-chat-slash-commands.js'
import { formatNativeChatFileReference } from './orca/shared/agent-image-paste.js'
import { commandMarkersAsMessages } from './orca/native-chat-command-marker.js'
import { fuzzyFilter } from '../../../shared/fuzzy.js'
import { PERMISSION_MODES } from '../../../shared/agentPermissionMode.js'
import { claudeContextWindow } from './terminalChatExtras.js'
import { t } from '../i18n'

// The agents whose terminal pane has a chat view (their transcript is read in
// src/main/chat/transcriptView.js). OpenCode keeps its own chat pane.
export const CHAT_VIEW_AGENTS = ['claude', 'openclaude', 'codex', 'cursor', 'antigravity']

// The keys the cards send: an approval's first option (Allow), and Escape
// (Deny, cancel a question, Stop a turn), as Orca's cards do.
export const KEY_ALLOW = '1'
export const KEY_ESCAPE = '\x1b'
// Cursor CLI: "y" runs what its approval prompt shows, Ctrl+C rejects it (its
// Escape and "n" ask what to do instead), and Ctrl+C stops a turn (it has no
// Escape for that). A second Ctrl+C within 2 s quits it: one at most every
// INTERRUPT_GAP_MS from the chat view.
export const KEY_CTRL_C = '\x03'
export const INTERRUPT_GAP_MS = 3000

// Antigravity (agy): Escape halts its turn (Ctrl+C would quit it), "y" and
// "n" answer its approval prompt (its confirm.yes / confirm.no keys).
// -> { stop, allow, deny }: the keys Stop, Allow and Deny type into the agent.
export function cardKeys(agentId) {
  if (agentId === 'cursor') return { stop: KEY_CTRL_C, allow: 'y', deny: KEY_CTRL_C }
  if (agentId === 'antigravity') return { stop: KEY_ESCAPE, allow: 'y', deny: 'n' }
  return { stop: KEY_ESCAPE, allow: KEY_ALLOW, deny: KEY_ESCAPE }
}

// May these keys be typed now? Never a Ctrl+C within INTERRUPT_GAP_MS of the
// last one (lastAt): Cursor would take the second as "quit".
export function keysAllowed(bytes, lastAt, now = Date.now()) {
  return !String(bytes || '').includes(KEY_CTRL_C) || !Number.isFinite(lastAt) || now - lastAt >= INTERRUPT_GAP_MS
}

// A terminal agent Tessel started (not one detected in a shell). On an SSH
// host: Claude Code and Codex, whose files there are read over the
// connection (src/main/chat/remoteTranscripts.js).
export const REMOTE_CHAT_VIEW_AGENTS = ['claude', 'codex']
export function canShowChatView(node) {
  if (!node || node.kind !== 'agent' || node.detected || !CHAT_VIEW_AGENTS.includes(node.agentId)) return false
  return !node.remoteHostId || REMOTE_CHAT_VIEW_AGENTS.includes(node.agentId)
}

// The composer's slash commands and question keys follow Claude Code's for
// OpenClaude (its fork).
export const composerAgent = (agentId) => (agentId === 'codex' || agentId === 'cursor' || agentId === 'antigravity' ? agentId : 'claude')

// Agents that change their model in their own picker (typed into the
// terminal, then shown there), not in the chat view's.
export const ownModelPicker = (agentId) => agentId === 'codex' || agentId === 'cursor'
// Antigravity is not one of them: its "/model <id>" switches at once, so the
// chat view's own picker types it (agentSessionOptions.js).
// Agents whose permission mode the chat view's picker changes (Cursor's
// Shift+Tab cycles its Agent / Plan / Ask modes instead: none; Antigravity
// changes its permissions in its own /permissions panel).
export const hasModePicker = (agentId) => agentId === 'claude' || agentId === 'openclaude' || agentId === 'codex'

const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ask_user_question', 'askUserQuestion', 'request_user_input'])

// The question the agent asked last and has had no answer to yet: its tool
// call (AskUserQuestion, Codex's request_user_input) with no result after it
// and no prompt of yours since. -> { id, prompt } | null. A turn the reader
// closed itself (the end of the file) is not an answer: only a real result is.
export function pendingAskFromEvents(events) {
  let pending = null
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue
    if (e.type === 'user' && e.origin !== 'team') pending = null
    else if (e.type === 'turnEnd' && e.status === 'interrupted') pending = null
    else if (e.type === 'tool' && e.name && QUESTION_TOOLS.has(e.name) && e.status === 'running') {
      const prompt = parseAskFromToolInput(e.name, e.input)
      pending = prompt ? { id: String(e.id), prompt } : null
    } else if (e.type === 'toolResult' && pending && String(e.id) === pending.id) pending = null
  }
  return pending
}

// The question the agent's hook says it waits on (the pane's state, from
// src/shared/agentAsk.js): shown at once, before its file has it (Codex writes
// its rollout late). Its tool id is the file's tool call id, so the card stays
// the same one when the file catches up. -> { id, prompt } | null
export function liveAskFromState(ask) {
  if (!ask || typeof ask !== 'object' || !QUESTION_TOOLS.has(ask.toolName)) return null
  const prompt = parseAskFromToolInput(ask.toolName, { questions: ask.questions })
  return prompt ? { id: typeof ask.toolId === 'string' && ask.toolId ? ask.toolId : 'live-ask', prompt } : null
}

// The question the card shows: the hook's (live) first, else the one the
// file shows unanswered.
export function currentAsk(hookAsk, events) {
  return liveAskFromState(hookAsk) || pendingAskFromEvents(events)
}

// Antigravity asks with its ask_question tool, a selector of its own answered
// in its terminal: true while its file shows such a call with no result yet
// (and no prompt of yours or interruption since).
export function askInTerminalFromEvents(agentId, events) {
  if (agentId !== 'antigravity') return false
  let open = null
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue
    if ((e.type === 'user' && e.origin !== 'team') || e.type === 'turnEnd') open = null
    else if (e.type === 'tool' && e.name === 'ask_question' && e.status === 'running') open = String(e.id)
    else if ((e.type === 'toolResult' || (e.type === 'tool' && !e.name)) && open !== null && String(e.id) === open) open = null
  }
  return open !== null
}

// Tessel's own lines typed into the agent (team reminders, task notes: they
// start with "[Tessel]") are shown as Tessel's messages, not as yours.
export function tagTesselTurns(events) {
  return (Array.isArray(events) ? events : []).map((e) =>
    e && e.type === 'user' && typeof e.text === 'string' && /^\s*\[Tessel\]/.test(e.text)
      ? { ...e, origin: 'team', from: 'Tessel', text: e.text.replace(/^\s*\[Tessel\]\s*/, '') } // i18n-ignore product name
      : e
  )
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
// A sent message shows in the conversation file this long after (or before:
// the two clocks are the same, the times are rounded).
const MATCH_SLACK_MS = 5000
// Claude Code's own names for pasted pictures in a message's text.
const IMAGE_MARKER = /\[Image #\d+\]/
const IMAGE_MARKERS = /\[Image #\d+\]/g

// What you sent from the chat stays shown (as sent) until the agent's file
// has it: the same text, or (once Tessel saw the agent take it) the next
// prompt of yours after it, whatever the file made of it (a long paste may be
// shown shortened). pending: [{ id, text, at, delivered, seen }] in sending
// order (seen: how many prompts the file showed when it was sent, for a file
// without times: Cursor's).
// -> { events: the conversation plus the messages not in it yet, done: ids
// of the pending messages now in the file }
export function mergePendingSends(events, pending) {
  const list = Array.isArray(events) ? events : []
  const prompts = list.filter((e) => e && e.type === 'user' && e.origin !== 'team')
  const used = new Set()
  const done = []
  const shown = []
  for (const p of Array.isArray(pending) ? pending : []) {
    const after = prompts.filter(
      (e, i) => !used.has(e) && (Number.isFinite(e.at) ? e.at >= p.at - MATCH_SLACK_MS : !Number.isFinite(p.seen) || i >= p.seen)
    )
    // Sent with pictures: the file names them first ("[Image #1] hello"),
    // and a message of pictures only has nothing else (body: the text sent).
    const sent = norm(typeof p.body === 'string' ? p.body : p.text)
    const sameText = (e) => norm(e.text) === norm(p.text) || (p.imageCount > 0 && IMAGE_MARKER.test(e.text) && norm(String(e.text).replace(IMAGE_MARKERS, ' ')) === sent)
    let hit = after.find(sameText)
    if (!hit && p.delivered) hit = after[0]
    if (hit) {
      used.add(hit)
      done.push(p.id)
      continue
    }
    shown.push({ type: 'user', id: `pending-${p.id}`, text: p.text, origin: 'user', status: 'sent', at: p.at }) // i18n-ignore
  }
  return { events: shown.length ? [...list, ...shown] : list, done }
}

// A question card's answer as the keys the agent's selector expects (Codex's
// differs from Claude Code's), after Orca's buildAskAnswerKeys /
// buildCodexAskAnswerKeys. -> [{ raw } | { text }]
export function answerKeyGroups(agentId, prompt, selections) {
  // Cursor's and Antigravity's questions are answered in their terminal.
  if (agentId === 'cursor' || agentId === 'antigravity' || !prompt || !hasAskAnswer(prompt, selections)) return []
  return composerAgent(agentId) === 'codex' ? buildCodexAskAnswerKeys(prompt, selections) : buildAskAnswerKeys(prompt, selections)
}

// A typed answer's bytes: never a control sequence of its own (it could end
// the paste early or press keys); several lines as one bracketed paste.
export function groupBytes(group) {
  if (!group) return ''
  if (typeof group.raw === 'string') return group.raw
  const text = String(group.text || '').replace(/\x1b\[20[01]~/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  return /[\r\n]/.test(text) ? `\x1b[200~${text}\x1b[201~` : text
}

// The answer's keys one step apart (the selector moves on between them),
// after Orca's sendNativeChatAskAnswer. -> { cancel, settleAfterMs }
export function stepKeys(groups, write, { setTimer = setTimeout, clearTimer = clearTimeout, stepMs = NATIVE_CHAT_QUESTION_STEP_MS } = {}) {
  const list = Array.isArray(groups) ? groups.filter(Boolean) : []
  const timers = list.map((g, i) => setTimer(() => write(groupBytes(g)), i * stepMs))
  return {
    cancel: () => timers.forEach((t) => clearTimer(t)),
    settleAfterMs: list.length ? (list.length - 1) * stepMs + NATIVE_CHAT_SUBMIT_DELAY_MS : 0
  }
}

// What the card shows while the agent waits for you: its question, from its
// hook or its file (answered here), else its approval prompt (Allow / Deny
// here), else a question neither gives the options of (answer it in the
// terminal).
// state: { approval, input } from the pane (input: the hooks say a question
// tool waits). -> { kind: 'question', ask } | { kind: 'approval' } |
// { kind: 'terminal' } | null
export function waitingCard({ approval = false, input = false, working = false } = {}, ask = null) {
  if (ask && (input || !working)) return { kind: 'question', ask }
  if (input) return { kind: 'terminal' }
  if (approval) return { kind: 'approval' }
  return null
}

// ---- The composer (the full one, after Orca's bridge composer: images,
// slash commands, model and effort, @file) ------------------------------------

// What a sent text is: a slash command (one line starting with "/", typed
// into the agent as a command: Codex takes it key by key, Claude Code and
// OpenClaude as a paste; Enter, and no turn is watched for it) or a message
// (Tessel's delivery, which watches the agent take it). A message with
// images is always a message (a command never drops its images). Cursor, as
// Codex, takes it key by key (its "/" menu opens as it is typed).
// -> null | 'paste' | 'type'
export function commandDelivery(agentId, text, imageCount = 0) {
  const body = String(text || '').trim()
  if (imageCount > 0 || !/^\/[A-Za-z][\w:.-]*(?:\s|$)/.test(body) || /[\r\n]/.test(body)) return null
  const agent = composerAgent(agentId)
  return agent === 'codex' || agent === 'cursor' || agent === 'antigravity' ? 'type' : 'paste'
}

// Can its chat view attach images (each one's path pasted into its input)?
// Claude Code, OpenClaude and Codex turn a pasted image path into
// "[Image #N]"; Cursor takes the path in its prompt. Antigravity cannot:
// it reads the path as a text file and fails (CLI 1.2.14, also with
// "@file"), so its composer takes text only and says so.
export function chatViewTakesImages(agentId) {
  return ['claude', 'openclaude', 'codex', 'cursor'].includes(agentId)
}

// The image files the composer may name to the agent: Tessel's own copies
// (%TEMP%\tessel-paste\chat\img_<24 hex>.<png|jpg|gif|webp>), nothing else.
const IMAGE_COPY = /^(?:[A-Za-z]:[\\/]|\/)(?:[^\\/\0\r\n"<>|?*]+[\\/])*tessel-paste[\\/]chat[\\/]img_[0-9a-f]{24}\.(?:png|jpg|gif|webp)$/i
export function isPastedImageCopy(path) {
  return typeof path === 'string' && path.length <= 1024 && IMAGE_COPY.test(path) && !/[\\/]\.\.?[\\/]/.test(path)
}

// Cursor CLI's own commands (cursor.com/docs/cli/reference/slash-commands):
// the ones that make sense from a chat. /model opens its picker in the terminal.
const CURSOR_COMMANDS = [
  { name: 'model', get description() { return t('chat.orca.cursorCommands.model', 'Choose the model (in its terminal)') } },
  { name: 'plan', get description() { return t('chat.orca.copy.switch_to_plan_mode', 'Switch to Plan mode') } },
  { name: 'ask', get description() { return t('chat.orca.cursorCommands.ask', 'Toggle Ask mode (read-only questions)') } },
  { name: 'debug', get description() { return t('chat.orca.cursorCommands.debug', 'Toggle Debug mode') } },
  { name: 'run-everything', get description() { return t('chat.orca.cursorCommands.runEverything', 'Run commands without asking (on, off, status)') } },
  { name: 'summarize', get description() { return t('chat.orca.cursorCommands.summarize', 'Summarize the conversation to free context') } },
  { name: 'clear', get description() { return t('chat.orca.copy.start_a_new_chat', 'Start a new chat') } },
  { name: 'resume', get description() { return t('chat.orca.copy.resume_a_saved_chat', 'Resume a saved chat') } },
  { name: 'fork', get description() { return t('chat.orca.copy.fork_the_current_chat', 'Fork the current chat') } },
  { name: 'rewind', get description() { return t('chat.orca.cursorCommands.rewind', 'Go back to an earlier message') } },
  { name: 'rename', get description() { return t('chat.orca.copy.rename_the_current_thread', 'Rename the current thread') } },
  { name: 'mcp', get description() { return t('chat.orca.copy.list_configured_mcp_tools', 'List configured MCP tools') } },
  { name: 'help', get description() { return t('chat.orca.copy.show_available_commands', 'Show available commands') } }
]

// Antigravity CLI's own commands (antigravity.google/docs/cli/reference): the
// ones that make sense from a chat. /model opens the chat view's picker.
const ANTIGRAVITY_COMMANDS = [
  { name: 'model', get description() { return t('chat.orca.catalog.model', 'Choose the model') } },
  { name: 'planning', get description() { return t('chat.orca.agyCommands.planning', 'Turn on planning mode (a plan before the work)') } },
  { name: 'fast', get description() { return t('chat.orca.agyCommands.fast', 'Turn on fast mode (no plan first)') } },
  { name: 'clear', get description() { return t('chat.orca.copy.start_a_new_chat', 'Start a new chat') } },
  { name: 'resume', get description() { return t('chat.orca.copy.resume_a_saved_chat', 'Resume a saved chat') } },
  { name: 'fork', get description() { return t('chat.orca.copy.fork_the_current_chat', 'Fork the current chat') } },
  { name: 'rewind', get description() { return t('chat.orca.cursorCommands.rewind', 'Go back to an earlier message') } },
  { name: 'rename', get description() { return t('chat.orca.copy.rename_the_current_thread', 'Rename the current thread') } },
  { name: 'btw', get description() { return t('chat.orca.copy.start_a_side_conversation', 'Start a side conversation') } },
  { name: 'context', get description() { return t('chat.orca.agyCommands.context', 'Show the context use (in its terminal)') } },
  { name: 'add-dir', get description() { return t('chat.orca.agyCommands.addDir', 'Add a folder to its workspace') } },
  { name: 'skills', get description() { return t('chat.orca.copy.manage_and_use_skills', 'Manage and use skills') } },
  { name: 'mcp', get description() { return t('chat.orca.copy.list_configured_mcp_tools', 'List configured MCP tools') } },
  { name: 'usage', get description() { return t('chat.orca.agyCommands.usage', 'Show its model quota use') } },
  { name: 'help', get description() { return t('chat.orca.copy.show_available_commands', 'Show available commands') } }
]

// The "/" menu: the agent's own commands (its TUI runs them), with model and
// effort first where the chat view offers their pickers.
export function bridgeSlashCommands(agentId, { options = [] } = {}) {
  const agent = composerAgent(agentId)
  if (agent === 'cursor') return CURSOR_COMMANDS.map((c) => ({ name: c.name, kind: 'command', description: c.description }))
  if (agent === 'antigravity') return ANTIGRAVITY_COMMANDS.map((c) => ({ name: c.name, kind: 'command', description: c.description }))
  const own = getAgentSlashCommands(agent)
  const extra = []
  if (agent !== 'codex') {
    if (options.includes('model')) extra.push({ name: 'model', kind: 'command', description: t('chat.orca.catalog.model', 'Choose the model') })
    if (options.includes('effort')) extra.push({ name: 'effort', kind: 'command', description: t('chat.orca.catalog.effort', 'Choose reasoning effort') })
  }
  const seen = new Set(extra.map((c) => c.name))
  return [...extra, ...own.filter((c) => !seen.has(c.name)).map((c) => ({ name: c.name, kind: 'command', description: c.description }))]
}

// "Ran /compact" rows (Orca's command markers) among the messages: each after
// the last message shown before it was sent (at the end when no time is known).
export function withCommandMarkers(messages, markers) {
  const list = Array.isArray(messages) ? [...messages] : []
  for (const row of commandMarkersAsMessages(Array.isArray(markers) ? markers : [])) {
    // From the end: before every later message, after the first earlier one.
    let at = list.length
    for (let i = list.length - 1; i >= 0; i--) {
      const ts = list[i] && list[i].timestamp
      if (!Number.isFinite(ts) || ts <= 0) continue
      if (ts <= row.timestamp) {
        at = i + 1
        break
      }
      at = i
    }
    list.splice(at, 0, row)
  }
  return list
}

// The "@" menu: the project's files (files:list, relative paths) best first.
export function mentionMatches(files, query, limit = 8) {
  const list = Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f && !/[\r\n\0]/.test(f)) : []
  return fuzzyFilter(String(query || ''), list, limit)
}
// A picked file as the agent reads it after "@": quoted when it has a space.
export function mentionToken(path) {
  return formatNativeChatFileReference(String(path || '').replace(/\\/g, '/')).slice(1)
}

// The context ring: Claude Code's file never says the window; the model's
// known one is used (terminalChatExtras.js claudeContextWindow: 1M for
// "…[1m]", else 200k). Codex's file says its own.
export function withContextWindow(events, model, agent = 'claude') {
  const list = Array.isArray(events) ? events : []
  if (composerAgent(agent) === 'codex') return list
  return list.map((e) => {
    if (!e || e.type !== 'contextUsage' || e.windowTokens) return e
    const window = claudeContextWindow(model, e.usedTokens, agent)
    return window ? { ...e, windowTokens: window } : e
  })
}

// The context the agent's own status line shows (Cursor: its share of the
// window, read by the pane: cursorModels.js cursorContextOnScreen), for an
// agent whose file never says it -> the ring's usage, or null.
export function screenContextUsage(ctx) {
  const pos = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  const used = pos(ctx && ctx.usedTokens)
  const window = pos(ctx && ctx.windowTokens)
  if (!used || !window) return null
  return { usedTokens: used, windowTokens: window, percentage: Math.round((used / window) * 100), estimated: false, categories: [] }
}

// The command that compacts the agent's conversation (the low-context
// banner's Compact): Cursor's is /summarize, the others' /compact.
export function compactCommand(agent) {
  return composerAgent(agent) === 'cursor' ? '/summarize' : '/compact'
}

// ---- The permission mode (the composer's mode picker) ------------------------

// Claude Code's and OpenClaude's key to the next permission mode (Shift+Tab).
export const KEY_SHIFT_TAB = '\x1b[Z'
const MODES = new Set(PERMISSION_MODES)

// What the pane was launched with (its launch signature: command, arguments,
// variables). -> the arguments text, '' when unknown.
export function launchArgsOf(node) {
  if (!node || typeof node.launchSig !== 'string' || node.launchSig.length > 20000) return ''
  try {
    const sig = JSON.parse(node.launchSig)
    return Array.isArray(sig) && typeof sig[1] === 'string' ? sig[1] : ''
  } catch {
    return ''
  }
}

// The mode the agent started in, from how Tessel launched it (before its first
// hook says): Yolo (Settings > Agents, the pane menu, a Yolo folder: its
// skip-approvals flag), a --permission-mode of your own arguments, else default.
export function launchPermissionMode(node) {
  if (!node) return 'default'
  const args = launchArgsOf(node)
  if (composerAgent(node.agentId) === 'codex')
    return node.launchYolo || node.permissions === 'yolo' || /--dangerously-bypass-approvals-and-sandbox\b/.test(args) ? 'bypassPermissions' : 'default'
  const own = /--permission-mode[ =]["']?([A-Za-z]+)/.exec(args)
  if (own && MODES.has(own[1])) return own[1]
  return node.launchYolo || node.permissions === 'yolo' || /--dangerously-skip-permissions\b/.test(args) ? 'bypassPermissions' : 'default'
}

// Claude Code lets Shift+Tab reach Yolo (bypassPermissions) only in a session
// started able to use it: with --dangerously-skip-permissions, its
// --allow-dangerously-skip-permissions, or started in that mode.
export function canCycleToYolo(node) {
  if (!node || composerAgent(node.agentId) === 'codex') return false
  const args = launchArgsOf(node)
  return !!node.launchYolo || /--(?:allow-)?dangerously-skip-permissions\b/.test(args) || /--permission-mode[ =]["']?bypassPermissions\b/.test(args)
}

// The mode the picker shows: the latest of what the agent's hook said
// (hookMode, at hookAt) and what Tessel saw on its screen after switching it
// (localMode, at localAt); before either, the launch's.
export function shownPermissionMode({ hookMode = null, hookAt = 0, localMode = null, localAt = 0, launchMode = 'default' } = {}) {
  const hook = MODES.has(hookMode) ? hookMode : null
  const local = MODES.has(localMode) ? localMode : null
  if (hook && local) return localAt > hookAt ? local : hook
  return hook || local || (MODES.has(launchMode) ? launchMode : 'default')
}

// The mode Claude Code's footer shows ("⏵⏵ accept edits on (shift+tab to
// cycle)", "⏸ plan mode on"…; nothing in its default mode), read from the
// last lines of its screen. -> a mode ('default' when none is shown)
const SCREEN_MODES = [
  [/accept edits on\b/i, 'acceptEdits'],
  [/plan mode on\b/i, 'plan'],
  [/bypass permissions on\b/i, 'bypassPermissions'],
  [/auto mode on\b/i, 'auto'],
  [/don['’]t ask on\b/i, 'dontAsk']
]
export function permissionModeFromScreen(text, lines = 4) {
  const tail = String(text || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
  for (const line of tail.reverse()) {
    // The footer line starts with the mode (after its symbol), never in a message.
    if (!/^[^A-Za-z]{0,6}(?:accept edits|plan mode|bypass permissions|auto mode|don['’]t ask) on\b/i.test(line)) continue
    for (const [re, mode] of SCREEN_MODES) if (re.test(line)) return mode
  }
  return 'default'
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Shift+Tab, one press at a time, until the screen shows the target mode.
// read() -> the mode on screen now; press() sends one Shift+Tab; blocked() ->
// '' or why no key may be typed now (checked before each press). Stops at the
// target, after maxPresses, when a press changes nothing on screen within
// stepTimeoutMs, when the cycle comes back to where it started (the target is
// not in it), or after timeoutMs in all.
// -> { ok, mode (the last seen), presses, code?: 'blocked' | 'unconfirmed' |
// 'unavailable' | 'cap' | 'timeout', error? }
export async function stepToPermissionMode({
  target,
  read,
  press,
  blocked = () => '',
  maxPresses = 6,
  stepTimeoutMs = 1500,
  timeoutMs = 8000,
  pollMs = 80,
  sleep = wait,
  now = Date.now
} = {}) {
  const start = now()
  let seen = read()
  const first = seen
  let presses = 0
  while (seen !== target) {
    if (presses >= maxPresses) return { ok: false, code: 'cap', mode: seen, presses }
    if (now() - start >= timeoutMs) return { ok: false, code: 'timeout', mode: seen, presses }
    const why = blocked()
    if (why) return { ok: false, code: 'blocked', error: why, mode: seen, presses }
    press()
    presses++
    const pressedAt = now()
    let next = read()
    while (next === seen && now() - pressedAt < stepTimeoutMs) {
      await sleep(pollMs)
      next = read()
    }
    if (next === seen) return { ok: false, code: 'unconfirmed', mode: seen, presses }
    seen = next
    if (seen !== target && seen === first) return { ok: false, code: 'unavailable', mode: seen, presses }
  }
  return { ok: true, mode: seen, presses }
}
