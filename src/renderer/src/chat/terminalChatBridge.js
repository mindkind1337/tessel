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
export const CHAT_VIEW_AGENTS = ['claude', 'openclaude', 'codex']

// The keys the cards send: an approval's first option (Allow), and Escape
// (Deny, cancel a question, Stop a turn), as Orca's cards do.
export const KEY_ALLOW = '1'
export const KEY_ESCAPE = '\x1b'

// A terminal agent Tessel started on this computer (not one detected in a
// shell, not on an SSH host).
export function canShowChatView(node) {
  return !!node && node.kind === 'agent' && CHAT_VIEW_AGENTS.includes(node.agentId) && !node.remoteHostId && !node.detected
}

// The composer's slash commands and question keys follow Claude Code's for
// OpenClaude (its fork).
export const composerAgent = (agentId) => (agentId === 'codex' ? 'codex' : 'claude')

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

// What you sent from the chat stays shown (as sent) until the agent's file
// has it: the same text, or (once Tessel saw the agent take it) the next
// prompt of yours after it, whatever the file made of it (a long paste may be
// shown shortened). pending: [{ id, text, at, delivered }] in sending order.
// -> { events: the conversation plus the messages not in it yet, done: ids
// of the pending messages now in the file }
export function mergePendingSends(events, pending) {
  const list = Array.isArray(events) ? events : []
  const prompts = list.filter((e) => e && e.type === 'user' && e.origin !== 'team')
  const used = new Set()
  const done = []
  const shown = []
  for (const p of Array.isArray(pending) ? pending : []) {
    const after = prompts.filter((e) => !used.has(e) && (!Number.isFinite(e.at) || e.at >= p.at - MATCH_SLACK_MS))
    let hit = after.find((e) => norm(e.text) === norm(p.text))
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
  if (!prompt || !hasAskAnswer(prompt, selections)) return []
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
// images is always a message (a command never drops its images).
// -> null | 'paste' | 'type'
export function commandDelivery(agentId, text, imageCount = 0) {
  const body = String(text || '').trim()
  if (imageCount > 0 || !/^\/[A-Za-z][\w:.-]*(?:\s|$)/.test(body) || /[\r\n]/.test(body)) return null
  return composerAgent(agentId) === 'codex' ? 'type' : 'paste'
}

// The image files the composer may name to the agent: Tessel's own copies
// (%TEMP%\tessel-paste\chat\img_<24 hex>.<png|jpg|gif|webp>), nothing else.
const IMAGE_COPY = /^(?:[A-Za-z]:[\\/]|\/)(?:[^\\/\0\r\n"<>|?*]+[\\/])*tessel-paste[\\/]chat[\\/]img_[0-9a-f]{24}\.(?:png|jpg|gif|webp)$/i
export function isPastedImageCopy(path) {
  return typeof path === 'string' && path.length <= 1024 && IMAGE_COPY.test(path) && !/[\\/]\.\.?[\\/]/.test(path)
}

// The "/" menu: the agent's own commands (its TUI runs them), with model and
// effort first where the chat view offers their pickers.
export function bridgeSlashCommands(agentId, { options = [] } = {}) {
  const agent = composerAgent(agentId)
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
