// A chat worker's conversation as plain text, for its coordinator
// (team_worker_read): what a terminal worker's screen would show, no more.
// Built from the pane's history (chat:history events, src/main/chat/
// sessions.js) through the pane's own reducer: the user's and the team's
// messages, the agent's answers, one line per tool (its short summary, never
// its input or result), approvals, failed turns, notices and stops. Nothing
// else of an event (ids, launch tokens, session ids) is ever printed. Text
// for agents: English.
import { chatReducer, initialChatState, toolSummary, STOPPED_STATES } from './chatModel'
import { outputTail } from '../../../shared/orchestration'

export const MAX_MESSAGE = 2000 // characters kept of one message

// Terminal escapes and control characters out; new lines and tabs stay.
// eslint-disable-next-line no-control-regex
const CONTROL = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-_]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

function clean(text, max = MAX_MESSAGE) {
  const s = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
const oneLine = (text, max) => clean(text, max).replace(/\s*\n\s*/g, ' ')

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
      return `> ${who}${failed}: ${clean(r.text)}` // i18n-ignore
    }
    case 'assistant':
      return clean(r.text)
    case 'tool': {
      // The summary only: a tool's full input or result is never shown.
      const summary = oneLine(r.summary || toolSummary(r.name, null), 200) || 'tool'
      return `▸ ${summary} (${r.status || 'running'})` // i18n-ignore
    }
    case 'approval': {
      const what = oneLine(toolSummary(r.toolName, r.input), 200) || oneLine(r.displayName, 80) || 'a tool'
      return r.status === 'pending'
        ? `? Waiting for the user's approval: ${what}` // i18n-ignore
        : `? Approval ${r.status}: ${what}` // i18n-ignore
    }
    case 'turn':
      if (r.status === 'failed') return `[turn failed${r.error ? `: ${oneLine(r.error, 500)}` : ''}]` // i18n-ignore
      if (r.status === 'interrupted') return '[turn interrupted]'
      return '[turn ended]'
    case 'notice':
      return `[${r.level === 'error' ? 'error' : 'notice'}] ${clean(r.text)}` // i18n-ignore
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
      const why = ev.error ? `: ${oneLine(ev.error, 300)}` : ''
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
