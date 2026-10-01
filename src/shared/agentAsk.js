// The question an agent asks you (Claude Code's AskUserQuestion, OpenClaude's,
// Codex's request_user_input), as its PreToolUse hook gives it: the chat view
// shows its card at once with the options, instead of waiting for the
// conversation file (Codex writes its rollout late).
//
// The one exception to "a hook keeps a tool's identity only": the question
// structure, bounded, nothing else of the tool's input and nothing of any
// other tool. src/main/teamMcp/server.cjs has its own copy of sanitizeAsk (it
// runs outside the application); the main process runs this one again on
// what it reads (agentStateStore.js), so a file that differs is not shown.
export const ASK_TOOLS = ['AskUserQuestion', 'request_user_input']
export const ASK_PROVIDERS = ['claude', 'openclaude', 'codex']
export const ASK_LIMITS = Object.freeze({
  questions: 4,
  options: 8,
  question: 1000,
  header: 200,
  label: 200,
  description: 500,
  bytes: 16 * 1024
})

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
// Control characters (newline kept), DEL, C1 and bidirectional overrides
// (they could make a card read differently from what was asked).
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g
function clean(value, max) {
  if (typeof value !== 'string') return ''
  let text = value.replace(CONTROL, '').slice(0, max)
  // Never half of a character cut at the limit.
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1)
  return text
}
const utf8Length = (text) => new TextEncoder().encode(text).length

// -> { questions: [{ question, header?, multiSelect?, options: [{ label,
// description? }] }] } | null. Anything over a count limit (questions,
// options) or of an unknown shape is no card at all: a cut list would shift
// the answer keys (they count the options). Texts over their limit are cut.
export function sanitizeAsk(input) {
  if (typeof input === 'string') {
    if (input.length > 4 * ASK_LIMITS.bytes) return null
    try {
      input = JSON.parse(input)
    } catch {
      return null
    }
  }
  if (!isObject(input) || !Array.isArray(input.questions)) return null
  const raw = input.questions
  if (!raw.length || raw.length > ASK_LIMITS.questions) return null
  const questions = []
  for (const q of raw) {
    if (!isObject(q)) return null
    const list = q.options === undefined || q.options === null ? [] : q.options
    if (!Array.isArray(list) || list.length > ASK_LIMITS.options) return null
    const out = { question: clean(q.question, ASK_LIMITS.question) }
    const header = clean(q.header, ASK_LIMITS.header)
    if (header) out.header = header
    if (q.multiSelect === true) out.multiSelect = true
    out.options = []
    for (const o of list) {
      const label = typeof o === 'string' ? o : isObject(o) && typeof o.label === 'string' ? o.label : null
      if (label === null) return null
      const option = { label: clean(label, ASK_LIMITS.label) }
      const description = isObject(o) ? clean(o.description, ASK_LIMITS.description) : ''
      if (description) option.description = description
      out.options.push(option)
    }
    if (!out.question && !out.options.length) return null
    questions.push(out)
  }
  const ask = { questions }
  return utf8Length(JSON.stringify(ask)) <= ASK_LIMITS.bytes ? ask : null
}

// The ask a spooled hook event may carry, checked again: only on a lead's
// PreToolUse / PermissionRequest of a question tool, from an agent with a
// chat view, and exactly what sanitizeAsk makes of it. -> the ask | null.
export function validAsk(event) {
  if (!isObject(event) || event.ask === undefined) return null
  if (!['PreToolUse', 'PermissionRequest'].includes(event.event)) return null
  if (!ASK_TOOLS.includes(event.toolName) || event.agentId || !ASK_PROVIDERS.includes(event.provider)) return null
  const ask = sanitizeAsk(event.ask)
  return ask && JSON.stringify(ask) === JSON.stringify(event.ask) ? ask : null
}

// The question shown for a pane after one of its lead's hook events (applied
// by the reducer). current, the result: { toolId, toolName, questions } |
// null. A new question replaces it; its answer (the tool's end), the next
// tool, a prompt, the end of the turn or of the session clears it; notices
// and sub-agents leave it.
const KEEPS = new Set(['Notification', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Elicitation', 'ElicitationResult'])
export function nextAsk(current, event) {
  if (!isObject(event) || event.agentId) return current || null
  const ask = validAsk(event)
  if (ask) return { toolId: event.toolId || null, toolName: event.toolName, questions: ask.questions }
  if (!current) return null
  if (KEEPS.has(event.event)) return current
  const sameTool = !!(event.toolId && current.toolId && event.toolId === current.toolId)
  // The permission check of the same question (no question of its own).
  if (['PreToolUse', 'PermissionRequest'].includes(event.event) && sameTool) return current
  // Another tool ending (run alongside) is not this question's answer.
  if (['PostToolUse', 'PostToolUseFailure'].includes(event.event) && event.toolId && current.toolId && !sameTool) return current
  return null
}
