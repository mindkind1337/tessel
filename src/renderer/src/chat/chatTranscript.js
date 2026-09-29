// A chat worker's conversation as plain text, for its coordinator
// (team_worker_read): what a terminal worker's screen would show, no more.
// Built from the pane's history (chat:history events, src/main/chat/
// sessions.js) through the pane's own reducer: the user's and the team's
// messages, the agent's answers, one line per tool (its short summary, never
// its input or result), approvals, failed turns, notices and stops. Nothing
// else of an event (ids, launch tokens, session ids) is ever printed. Text
// for agents: English.
//
// A worker writes what it likes: every line of a message is prefixed (the
// agent's with "| ", the next lines of a user's or team message with ">   ",
// a notice's with its tag), so its text can never pass for a "> User:" line,
// an approval, or one of Tessel's own. Bidi and zero-width characters are
// removed. Commands are never shown (their program only), and what looks
// like a secret in a summary is masked.
import { chatReducer, initialChatState, toolSummary, parseInput, STOPPED_STATES } from './chatModel'
import { outputTail } from '../../../shared/orchestration'

export const MAX_MESSAGE = 2000 // characters kept of one message

// Terminal escapes and control characters out; new lines and tabs stay.
// eslint-disable-next-line no-control-regex
const CONTROL = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-_]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
// Direction overrides/isolates and zero-width characters: they can make a
// line read as something else.
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g

function clean(text, max = MAX_MESSAGE) {
  const s = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    .trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
const oneLine = (text, max) => clean(text, max).replace(/\s*\n\s*/g, ' ')

// head + the first line, then each other line after `cont`.
function block(head, text, cont) {
  return clean(text)
    .split('\n')
    .map((line, i) => (i === 0 ? head : cont) + line)
    .join('\n')
}

// Bearer tokens, key=value secrets, long hex or base64-like runs.
export function maskSecrets(text) {
  return String(text ?? '')
    .replace(/\b(bearer|basic|token)\s+[^\s"']+/gi, '$1 ***')
    .replace(
      /\b([\w.-]*(?:key|token|secret|password|passwd|pwd|auth|credential|signature)[\w.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;|,]+)/gi,
      (all, name, sep, value) => (/^\*+$/.test(value) ? all : `${name}${sep}***`)
    )
    .replace(/\b[a-f0-9]{24,}\b/gi, '***')
    .replace(/(?<![\w/\\.-])(?=[\w+=-]*\d)(?=[\w+=-]*[A-Za-z])[\w+=-]{32,}/g, '***')
}

// A command line: its program only (never its arguments, which may hold
// paths, text or secrets).
function commandHint(label, input, summary) {
  const value = parseInput(input)
  let cmd = value && typeof value === 'object' ? value.command || value.cmd : typeof value === 'string' ? value : ''
  if (Array.isArray(cmd)) cmd = cmd.join(' ')
  if (!cmd && typeof summary === 'string' && summary.startsWith(`${label}: `)) cmd = summary.slice(label.length + 2)
  const words = String(cmd || '')
    .trim()
    .replace(/^[&.\s]+/, '')
    .split(/\s+/)
  const first = (words[0] || '').replace(/^["']+|["']+$/g, '')
  const prog = first.split(/[\\/]/).pop()
  if (!prog || !/^[A-Za-z0-9._+-]{1,40}$/.test(prog)) return `${label}: (command hidden)` // i18n-ignore
  return words.length > 1 || /…$/.test(String(cmd)) ? `${label}: ${prog} … (arguments hidden)` : `${label}: ${prog}` // i18n-ignore
}

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell'])
function toolLine(name, input, summary) {
  const tool = String(name || '')
  const text = COMMAND_TOOLS.has(tool) ? commandHint(tool, input, summary) : summary || toolSummary(tool, input)
  return maskSecrets(oneLine(text, 200))
}

const STOPPED_LABEL = {
  ended: 'the chat ended',
  crashed: 'the agent stopped',
  signin: 'the agent is not signed in',
  untrusted: 'the folder is not approved'
}

function rowText(r) {
  switch (r.kind) {
    case 'user': {
      const who = r.origin === 'team' ? `Team message${r.from ? ` from ${oneLine(r.from, 80)}` : ''}` : 'User' // i18n-ignore
      const failed = r.status === 'failed' ? ' (not delivered)' : ''
      return block(`> ${who}${failed}: `, r.text, '>   ') // i18n-ignore
    }
    case 'assistant':
      return clean(r.text) ? block('| ', r.text, '| ') : ''
    case 'tool': {
      // The summary only: a tool's full input or result is never shown.
      const summary = toolLine(r.name, r.input, r.summary) || 'tool'
      return `▸ ${summary} (${r.status || 'running'})` // i18n-ignore
    }
    case 'approval': {
      const what = toolLine(r.toolName, r.input, '') || maskSecrets(oneLine(r.displayName, 80)) || 'a tool'
      return r.status === 'pending'
        ? `? Waiting for the user's approval: ${what}` // i18n-ignore
        : `? Approval ${r.status}: ${what}` // i18n-ignore
    }
    case 'turn':
      if (r.status === 'failed') return `[turn failed${r.error ? `: ${maskSecrets(oneLine(r.error, 500))}` : ''}]` // i18n-ignore
      if (r.status === 'interrupted') return '[turn interrupted]'
      return '[turn ended]'
    case 'notice': {
      const tag = `[${r.level === 'error' ? 'error' : 'notice'}] ` // i18n-ignore
      return block(tag, r.text, tag)
    }
    default:
      // Thinking and anything unknown stay out.
      return ''
  }
}

// events: the history ([{ seq, event }] or bare events). -> the last `lines`
// lines of the conversation ('' when there is none).
export function formatChatTranscript(events, lines = 60, { cwd = '' } = {}) {
  const list = Array.isArray(events) ? events : []
  // Rows as the pane shows them; a stop between them is a line of its own.
  let state = initialChatState()
  const stops = [] // { at: row index, text }
  for (const item of list) {
    const ev = item && item.event && !item.type ? item.event : item
    state = chatReducer(state, ev, { cwd })
    if (ev && ev.type === 'status' && STOPPED_STATES.has(ev.state)) {
      const why = ev.error ? `: ${maskSecrets(oneLine(ev.error, 300))}` : ''
      stops.push({ at: state.rows.length, text: `[stopped: ${STOPPED_LABEL[ev.state]}${why}]` }) // i18n-ignore
    }
  }
  const out = []
  let s = 0
  state.rows.forEach((r, i) => {
    while (s < stops.length && stops[s].at <= i) out.push(stops[s++].text)
    const text = rowText(r)
    if (text) out.push(text)
  })
  while (s < stops.length) out.push(stops[s++].text)
  return outputTail(out.join('\n'), lines)
}
