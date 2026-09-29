// The chat pane's model: a pure reducer from the main process's renderer
// events (chat:event, see src/main/chat/sessions.js) to what the pane shows:
// the rows of the conversation, the session's status, its model and the
// rate limits. Rows are never mutated: a changed row is a new object, so a
// row component that got the same object skips its render (long chats).
// Tool summaries after Orca's native chat (src/shared/native-chat-tool-summary.ts,
// MIT, Copyright (c) 2026 Lovecast Inc.), much simplified.

import { approvalText, MAX_DETAIL } from '../../../shared/chatApproval'

export { MAX_DETAIL }
export const MAX_SUMMARY = 80
// An approval card ignores its answer keys this long after it appears.
export const KEY_GRACE_MS = 600

export function initialChatState() {
  return {
    rows: [],
    status: 'starting',
    error: '',
    model: '',
    sessionId: '',
    rateLimit: null,
    nextKey: 1
  }
}

// Status values of the contract; anything else is ignored.
// asleep: its process stopped after a while idle; the next message wakes it.
const STATES = new Set(['starting', 'idle', 'working', 'approval', 'asleep', 'ended', 'crashed', 'signin', 'untrusted'])
// The composer cannot send in these.
export const STOPPED_STATES = new Set(['ended', 'crashed', 'signin', 'untrusted'])
// No agent process runs in these (asleep included): nothing it started can
// still be running.
const NO_PROCESS_STATES = new Set([...STOPPED_STATES, 'asleep'])

export function isBusy(status) {
  return status === 'working' || status === 'approval'
}

// --- Helpers -----------------------------------------------------------------------------------

// Bearer tokens, key=value secrets, long hex or base64-like runs. Always
// before a text is cut: a cut secret would leave its start visible.
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

export function truncate(text, max = MAX_SUMMARY) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).find((l) => l.trim()) || ''
}

// The tool's input as an object when it is JSON (the contract sends clipped
// JSON text); anything else stays as it is.
export function parseInput(input) {
  if (input && typeof input === 'object') return input
  if (typeof input !== 'string') return input ?? null
  const s = input.trim()
  if (!s.startsWith('{') && !s.startsWith('[')) return input
  try {
    return JSON.parse(s)
  } catch {
    return input
  }
}

// A path relative to the session's folder when it is inside it.
export function shortPath(path, cwd = '') {
  const p = String(path || '')
  if (!cwd) return p
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = norm(cwd)
  const full = norm(p)
  if (full.toLowerCase().startsWith(base.toLowerCase() + '/')) return full.slice(base.length + 1)
  return p
}

const FILE_KEYS = ['file_path', 'filePath', 'notebook_path', 'path']
const PRIMARY_KEYS = ['command', 'cmd', 'pattern', 'query', 'url', 'description', 'prompt', 'subject', 'skill']

// One line for a tool call: "Read src/x.js", "Bash: npm test", "Grep TODO".
export function toolSummary(name, input, { cwd = '', max = MAX_SUMMARY } = {}) {
  const tool = String(name || '')
  const value = parseInput(input)
  // mcp__server__tool reads "server: tool".
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  const label = mcp ? `${mcp[1]}: ${mcp[2]}` : tool
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (tool === 'Bash' || tool === 'PowerShell') {
      const cmd = firstLine(value.command || value.cmd)
      return truncate(maskSecrets(cmd ? `${label}: ${cmd}` : label), max)
    }
    const isSearch = tool === 'Grep' || tool === 'Glob'
    if (!isSearch) {
      for (const k of FILE_KEYS) {
        if (typeof value[k] === 'string' && value[k]) return truncate(maskSecrets(`${label} ${shortPath(value[k], cwd)}`), max)
      }
    }
    for (const k of PRIMARY_KEYS) {
      if (typeof value[k] === 'string' && value[k].trim()) return truncate(maskSecrets(`${label} ${firstLine(value[k])}`), max)
    }
    return truncate(label, max)
  }
  if (typeof value === 'string' && value.trim()) return truncate(maskSecrets(`${label} ${firstLine(value)}`), max)
  return truncate(label, max)
}

// The input for the expanded row / the approval card: pretty JSON, clipped.
export function formatInput(input, max = MAX_DETAIL) {
  const value = parseInput(input)
  if (value == null) return ''
  let text
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? ''
    } catch {
      text = String(value)
    }
  }
  return truncate(text, max)
}

// The command an approval is about: Bash's command, else the input.
export function approvalDetail(toolName, input) {
  return truncate(approvalText(parseInput(input)), MAX_DETAIL)
}

// "Allow for this session" adds these (checked by the main process): rules
// ({ kind:'rule', tool, content }), a mode ({ kind:'mode', mode }) or folders
// ({ kind:'directories', directories }). Anything else is not kept.
export function sessionRuleList(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const r of list.slice(0, 50)) {
    if (!r || typeof r !== 'object') continue
    if (r.kind === 'rule' && typeof r.tool === 'string') out.push({ kind: 'rule', tool: r.tool, content: typeof r.content === 'string' ? r.content : '' })
    else if (r.kind === 'mode' && typeof r.mode === 'string') out.push({ kind: 'mode', mode: r.mode })
    else if (r.kind === 'directories' && Array.isArray(r.directories))
      out.push({ kind: 'directories', directories: r.directories.filter((d) => typeof d === 'string') })
  }
  return out
}

// "5 h: 42% · 7 d: 10%" parts ({ label, pct }); utilization is 0..1 (or 0..100).
export function rateLimitParts(rateLimit) {
  if (!rateLimit) return []
  const out = []
  const pct = (w) => {
    const u = Number(w && w.utilization)
    if (!Number.isFinite(u)) return null
    return Math.round(Math.min(100, Math.max(0, u <= 1 ? u * 100 : u)))
  }
  const five = pct(rateLimit.fiveHour)
  const seven = pct(rateLimit.sevenDay)
  if (five != null) out.push({ id: 'fiveHour', pct: five, resetsAt: rateLimit.fiveHour.resetsAt || null })
  if (seven != null) out.push({ id: 'sevenDay', pct: seven, resetsAt: rateLimit.sevenDay.resetsAt || null })
  return out
}

// --- Reducer -----------------------------------------------------------------------------------

const CHILD_TEXT = new Set(['assistantDelta', 'assistant', 'thinking'])

function findLast(rows, pred) {
  for (let i = rows.length - 1; i >= 0; i--) if (pred(rows[i])) return i
  return -1
}

function withRow(state, index, patch) {
  const rows = state.rows.slice()
  rows[index] = { ...rows[index], ...patch }
  return { ...state, rows }
}

function append(state, row) {
  const key = `${row.kind}:${state.nextKey}` // i18n-ignore
  return { ...state, rows: [...state.rows, { ...row, key }], nextKey: state.nextKey + 1 }
}

// The streamed text of a message block ends (final text, a turn end).
function closeStreaming(rows) {
  let changed = false
  const out = rows.map((r) => {
    if (r.kind === 'assistant' && r.streaming) {
      changed = true
      return { ...r, streaming: false }
    }
    return r
  })
  return changed ? out : rows
}

// The agent's process is gone: its streams close, a tool still running is
// 'stopped' (neither done nor failed: nobody knows) and a question still
// waiting is 'cancelled'. Untouched rows keep their object.
function closeOpen(rows) {
  const closed = closeStreaming(rows)
  let changed = false
  const out = closed.map((r) => {
    if (r.kind === 'tool' && r.status === 'running') {
      changed = true
      return { ...r, status: 'stopped' }
    }
    if (r.kind === 'approval' && r.status === 'pending') {
      changed = true
      return { ...r, status: 'cancelled' }
    }
    return r
  })
  return changed ? out : closed
}

const USER_STATUSES = new Set(['queued', 'sent', 'accepted', 'failed'])
const APPROVAL_STATUSES = new Set(['pending', 'allowed', 'allowedSession', 'denied', 'cancelled'])

export function chatReducer(state, event, { cwd = '' } = {}) {
  if (!event || typeof event !== 'object') return state
  const s = state || initialChatState()
  // A sub-agent's own text (agentId) is not the agent's answer: until the
  // pane groups sub-agents, it stays out of the conversation (and of a
  // worker's transcript) instead of reading as the main agent's reply.
  if (event.agentId && CHILD_TEXT.has(event.type)) return s
  switch (event.type) {
    case 'status': {
      if (!STATES.has(event.state)) return s
      const next = { ...s, status: event.state }
      if (event.model) next.model = String(event.model)
      if (event.sessionId) next.sessionId = String(event.sessionId)
      next.error = event.error ? String(event.error) : STOPPED_STATES.has(event.state) ? s.error : ''
      // A stopped process leaves nothing open: no stream, no running tool,
      // no question waiting.
      if (NO_PROCESS_STATES.has(event.state)) next.rows = closeOpen(s.rows)
      return next
    }

    case 'user': {
      if (event.id == null) return s
      const id = String(event.id)
      const row = {
        kind: 'user',
        id,
        text: String(event.text ?? ''),
        origin: event.origin === 'team' ? 'team' : 'user',
        from: event.from != null ? String(event.from) : '',
        status: USER_STATUSES.has(event.status) ? event.status : 'sent',
        at: event.at || null
      }
      const i = findLast(s.rows, (r) => r.kind === 'user' && r.id === id)
      if (i >= 0) return withRow(s, i, { ...row, key: s.rows[i].key })
      return append(s, row)
    }

    case 'userStatus': {
      const id = String(event.id)
      const i = findLast(s.rows, (r) => r.kind === 'user' && r.id === id)
      if (i < 0 || !USER_STATUSES.has(event.status) || s.rows[i].status === event.status) return s
      return withRow(s, i, { status: event.status })
    }

    case 'teamAccepted': {
      const ids = new Set((event.ids || []).map(String))
      if (!ids.size) return s
      let changed = false
      const rows = s.rows.map((r) => {
        if (r.kind === 'user' && ids.has(r.id) && r.status !== 'accepted') {
          changed = true
          return { ...r, status: 'accepted' }
        }
        return r
      })
      return changed ? { ...s, rows } : s
    }

    // Team messages the agent did not take (its turn failed or it stopped):
    // Tessel keeps them and delivers them again, so their rows are 'failed'
    // (shown as not delivered yet), never lost.
    case 'teamFailed': {
      const ids = new Set((event.ids || []).map(String))
      if (!ids.size) return s
      let changed = false
      const rows = s.rows.map((r) => {
        if (r.kind === 'user' && r.origin === 'team' && ids.has(r.id) && r.status !== 'failed') {
          changed = true
          return { ...r, status: 'failed' }
        }
        return r
      })
      return changed ? { ...s, rows } : s
    }

    case 'assistantDelta': {
      const text = String(event.text ?? '')
      if (!text) return s
      const messageId = String(event.messageId ?? '')
      const last = s.rows[s.rows.length - 1]
      // Appended to the block being streamed; a block after a tool is a new row.
      if (last && last.kind === 'assistant' && last.streaming && last.messageId === messageId)
        return withRow(s, s.rows.length - 1, { text: last.text + text })
      return append(s, { kind: 'assistant', messageId, text, streaming: true })
    }

    case 'assistant': {
      const messageId = String(event.messageId ?? '')
      const text = String(event.text ?? '')
      const i = findLast(s.rows, (r) => r.kind === 'assistant' && r.streaming && r.messageId === messageId)
      if (i >= 0) return withRow(s, i, { text: text || s.rows[i].text, streaming: false })
      if (!text.trim()) return s
      // The same final text again (a replayed history): nothing new.
      if (findLast(s.rows, (r) => r.kind === 'assistant' && r.messageId === messageId && r.text === text) >= 0) return s
      return append(s, { kind: 'assistant', messageId, text, streaming: false })
    }

    case 'thinking': {
      const messageId = String(event.messageId ?? '')
      const text = String(event.text ?? '')
      if (!text.trim()) return s
      const i = findLast(s.rows, (r) => r.kind === 'thinking' && r.messageId === messageId)
      if (i >= 0 && (s.rows[i].text === text || i === s.rows.length - 1)) {
        return s.rows[i].text === text ? s : withRow(s, i, { text })
      }
      return append(s, { kind: 'thinking', messageId, text })
    }

    case 'tool': {
      if (event.id == null) return s
      const id = String(event.id)
      const name = String(event.name || '')
      const patch = {
        name,
        summary: event.summary ? truncate(maskSecrets(event.summary)) : toolSummary(name, event.input, { cwd }),
        input: event.input ?? null,
        status: ['running', 'done', 'error'].includes(event.status) ? event.status : 'running'
      }
      const i = findLast(s.rows, (r) => r.kind === 'tool' && r.id === id)
      if (i >= 0) {
        // A result already in keeps its status.
        if (s.rows[i].result) delete patch.status
        return withRow(s, i, patch)
      }
      return append(s, { kind: 'tool', id, result: null, ...patch })
    }

    case 'toolResult': {
      if (event.id == null) return s
      const id = String(event.id)
      const result = { text: String(event.text ?? ''), isError: !!event.isError }
      const status = result.isError ? 'error' : 'done'
      const i = findLast(s.rows, (r) => r.kind === 'tool' && r.id === id)
      if (i >= 0) return withRow(s, i, { result, status })
      return append(s, { kind: 'tool', id, name: '', summary: '', input: null, result, status })
    }

    case 'approval': {
      if (event.requestId == null) return s
      const requestId = String(event.requestId)
      const row = {
        kind: 'approval',
        requestId,
        toolName: String(event.toolName || ''),
        displayName: String(event.displayName || event.toolName || ''),
        input: event.input ?? null,
        description: String(event.description || ''),
        // The decisions the agent offers (Codex: availableDecisions); null = all.
        sessionAllowed: sessionAllowedBy(event.choices),
        status: APPROVAL_STATUSES.has(event.status) ? event.status : 'pending',
        // The main process's preview: its first characters and how many it
        // does not show (the card fetches them before Allow).
        detail: typeof event.detail === 'string' ? event.detail : null,
        hidden: Number.isSafeInteger(event.hidden) && event.hidden > 0 ? event.hidden : 0,
        sessionRules: sessionRuleList(event.sessionRules)
      }
      const i = findLast(s.rows, (r) => r.kind === 'approval' && r.requestId === requestId)
      if (i >= 0) return withRow(s, i, row)
      return append(s, row)
    }

    case 'approvalStatus': {
      const requestId = String(event.requestId)
      const i = findLast(s.rows, (r) => r.kind === 'approval' && r.requestId === requestId)
      if (i < 0 || !APPROVAL_STATUSES.has(event.status)) return s
      return withRow(s, i, { status: event.status })
    }

    case 'turnEnd': {
      // Whatever the turn left open is over: streams, running tools, questions.
      // A tool cut by an interruption is 'stopped', not failed.
      const toolEnd = event.status === 'completed' ? 'done' : event.status === 'interrupted' ? 'stopped' : 'error'
      const rows = closeStreaming(s.rows).map((r) => {
        if (r.kind === 'tool' && r.status === 'running') return { ...r, status: toolEnd }
        if (r.kind === 'approval' && r.status === 'pending') return { ...r, status: 'cancelled' }
        return r
      })
      const next = append({ ...s, rows }, {
        kind: 'turn',
        status: ['completed', 'interrupted', 'failed'].includes(event.status) ? event.status : 'completed',
        durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
        costUsd: Number.isFinite(event.costUsd) ? event.costUsd : null,
        error: event.error ? String(event.error) : ''
      })
      if (isBusy(s.status)) next.status = 'idle'
      return next
    }

    case 'notice': {
      const text = String(event.text ?? '')
      if (!text) return s
      return append(s, { kind: 'notice', level: event.kind === 'error' ? 'error' : 'info', text })
    }

    case 'rateLimit': {
      const rateLimit = {}
      if (event.fiveHour) rateLimit.fiveHour = event.fiveHour
      if (event.sevenDay) rateLimit.sevenDay = event.sevenDay
      return { ...s, rateLimit: Object.keys(rateLimit).length ? rateLimit : s.rateLimit }
    }

    default:
      return s
  }
}

// Many events at once (a history).
export function reduceAll(state, events, opts) {
  let s = state || initialChatState()
  for (const ev of events || []) s = chatReducer(s, ev && ev.event && !ev.type ? ev.event : ev, opts)
  return s
}

// The pending approval the pane should answer first (oldest), or null.
export function pendingApproval(state) {
  return (state.rows || []).find((r) => r.kind === 'approval' && r.status === 'pending') || null
}

// "Allow for this session" is offered unless the agent's own list of
// decisions leaves it out (Codex's availableDecisions without
// acceptForSession). No list (Claude): offered.
export function sessionAllowedBy(choices) {
  if (!Array.isArray(choices) || !choices.length) return true
  return choices.some((c) => c === 'acceptForSession' || (c && typeof c === 'object' && 'acceptForSession' in c))
}
