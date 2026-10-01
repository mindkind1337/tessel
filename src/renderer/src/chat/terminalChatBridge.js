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

// What the card shows while the agent waits for you: a question read from its
// file (answered here), else its approval prompt (Allow / Deny here), else a
// question the file does not show yet (answer it in the terminal).
// state: { approval, input } from the pane (input: the hooks say a question
// tool waits). -> { kind: 'question', ask } | { kind: 'approval' } |
// { kind: 'terminal' } | null
export function waitingCard({ approval = false, input = false, working = false } = {}, ask = null) {
  if (ask && (input || !working)) return { kind: 'question', ask }
  if (input) return { kind: 'terminal' }
  if (approval) return { kind: 'approval' }
  return null
}
