// Claude Code stream-json frames -> the chat adapter's normalized events.
// Pure (no I/O), so it is tested against lines recorded from the real CLI
// (2.1.284, see __tests__/fixtures/claude-real-frames.jsonl).
//
// Control frames (control_request / control_response / control_cancel_request)
// are the adapter's business (they need answers); everything else goes
// through normalizeFrame(frame, state) -> [{ type, ...payload }].

import { createClaudeSubagents, observeClaudeSubagents } from './claudeSubagents.js'
import { createClaudeBackground, observeClaudeBackground } from './claudeBackgroundTasks.js'
export const TOOL_OUTPUT_MAX_BYTES = 8 * 1024

// The state the normalizer keeps between frames of one process.
export function createFrameState({ now = Date.now } = {}) {
  return {
    streamMessageId: null, // stream_event message_start id, for text deltas
    sent: new Set(), // uuids of our user messages (the adapter adds them)
    accepted: new Set(), // uuids already reported accepted (once each)
    interruptRequested: false, // set by the adapter when it sends interrupt
    sessionId: null,
    subagents: createClaudeSubagents(now),
    // Its background work (claudeBackgroundTasks.js).
    background: createClaudeBackground(),
    // The context window (after the reference's claude-context-facts): what
    // the newest main-thread response read (its input, cache reads and
    // writes), the window its result reports, and the models that name it.
    contextTokens: null,
    contextWindow: null,
    initModel: null,
    responseModel: null
  }
}

const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

// What a main-thread response read: the live context size; null for the
// all-zero usage the CLI stamps on rows it makes up.
export function contextTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return null
  const n = positive(usage.input_tokens) + positive(usage.cache_creation_input_tokens) + positive(usage.cache_read_input_tokens)
  return n > 0 ? n : null
}

// "claude-opus-5[1m]" and "Claude-Opus-5" name the same model.
const baseModel = (m) => String(m || '').replace(/\[[^\]]*\]$/, '').trim().toLowerCase()

// The main thread's window from a result's per-model usage (which also counts
// sub-agents and side calls): the entry of the model that answered, else the
// init's, else the largest (after the reference's claudeContextWindowFromResult).
// The answer to get_context_usage ({ totalTokens, rawMaxTokens | maxTokens }):
// { usedTokens, windowTokens }, or null when unusable (after the reference's
// claudeContextReportFromControl).
export function contextFromControl(value) {
  if (!value || typeof value !== 'object') return null
  const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v) : null)
  const used = count(value.totalTokens)
  const window = count(value.rawMaxTokens) || count(value.maxTokens)
  if (used === null || !window) return null
  return { usedTokens: used, windowTokens: window }
}

export function contextWindowFromResult(modelUsage, { initModel = null, responseModel = null } = {}) {
  if (!modelUsage || typeof modelUsage !== 'object') return null
  const entries = []
  for (const [key, u] of Object.entries(modelUsage)) {
    const window = u && typeof u === 'object' ? positive(u.contextWindow) : 0
    if (!window) continue
    const bases = [baseModel(key)]
    if (typeof u.canonicalModel === 'string') bases.push(baseModel(u.canonicalModel))
    entries.push({ key, window, bases })
  }
  if (!entries.length) return null
  // An init older than a response of another model names a model the session left.
  const init = initModel && responseModel && baseModel(initModel) !== baseModel(responseModel) ? null : initModel
  const name = baseModel(responseModel || init)
  let pool = entries
  const named = name ? entries.filter((e) => e.bases.includes(name)) : []
  if (named.length) pool = named
  // Responses drop "[1m]": only the init's exact key tells a 1M window apart.
  const exact = entries.filter((e) => e.key === init)
  if (exact.length) pool = exact
  return pool.reduce((best, e) => Math.max(best, e.window), 0) || null
}

// Text over maxBytes (UTF-8) is cut, never in the middle of a character,
// and ends with ' … (N more bytes)'.
export function clipText(text, maxBytes = TOOL_OUTPUT_MAX_BYTES) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  let kept = buf.subarray(0, maxBytes).toString('utf8')
  // A cut multi-byte character decodes as U+FFFD at the end: drop it.
  if (kept.endsWith('�') && !s.startsWith(kept)) kept = kept.slice(0, -1)
  const more = buf.length - Buffer.byteLength(kept, 'utf8')
  return `${kept} … (${more} more bytes)`
}

// tool_result content: a string, or blocks ({type:'text'} / {type:'image'} …).
export function toolResultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  return content
    .map((b) => {
      if (!b || typeof b !== 'object') return ''
      if (b.type === 'text') return String(b.text ?? '')
      if (b.type === 'image') return '[image]'
      return `[${String(b.type || 'content')}]`
    })
    .join('\n')
}

// Wording the CLI uses when it has no usable credentials. Only a hint for
// frames whose shape does not say it (a result text, stderr before exit).
const AUTH_TEXT = /not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication[_ ]failed|401 unauthorized|credit balance is too low/i
export function isAuthErrorText(text) {
  return typeof text === 'string' && AUTH_TEXT.test(text)
}

// The initialize response says who the CLI signed in as. tokenSource 'none'
// (and no API key either) is the CLI's own "not signed in".
export function initializeAuthProblem(response) {
  const account = response && typeof response.account === 'object' && response.account ? response.account : null
  if (!account) return false
  const none = (v) => v == null || v === 'none' || v === ''
  return account.tokenSource === 'none' && none(account.apiKeySource)
}

// "Allow for this session": the CLI's suggestions, stored for the session only.
// A suggestion's own destination (localSettings writes the project's
// .claude/settings.local.json) is never kept. Only what the approval card can
// show is kept (sessionRuleItems): allow rules, a mode other than bypass, and
// folders to add; anything else (replace/remove rules or folders, a rule or a
// path too long to show) is dropped, so the card shows all that is added.
const MAX_SUGGESTIONS = 20
const MAX_RULES = 20
const MAX_RULE_TEXT = 2000
const MAX_DIR = 4096
const SESSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk']
const showable = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max

export function sessionPermissions(suggestions) {
  if (!Array.isArray(suggestions)) return []
  const out = []
  for (const s of suggestions) {
    if (out.length >= MAX_SUGGESTIONS) break
    if (!s || typeof s !== 'object' || typeof s.type !== 'string') continue
    if (s.type === 'addRules') {
      if (s.behavior !== 'allow' || !Array.isArray(s.rules)) continue
      const rules = s.rules
        .filter((r) => r && typeof r === 'object' && showable(r.toolName, 200) && (r.ruleContent == null || showable(r.ruleContent, MAX_RULE_TEXT)))
        .slice(0, MAX_RULES)
        .map((r) => (r.ruleContent == null ? { toolName: r.toolName } : { toolName: r.toolName, ruleContent: r.ruleContent }))
      if (rules.length) out.push({ type: 'addRules', behavior: 'allow', rules, destination: 'session' })
    } else if (s.type === 'setMode') {
      if (SESSION_MODES.includes(s.mode)) out.push({ type: 'setMode', mode: s.mode, destination: 'session' })
    } else if (s.type === 'addDirectories') {
      const directories = Array.isArray(s.directories) ? s.directories.filter((d) => showable(d, MAX_DIR)).slice(0, MAX_RULES) : []
      if (directories.length) out.push({ type: 'addDirectories', directories, destination: 'session' })
    }
  }
  return out
}

// What the card shows for sessionPermissions(...): one item per rule, mode
// or folder list.
export function sessionRuleItems(perms) {
  const out = []
  for (const p of Array.isArray(perms) ? perms : []) {
    if (p.type === 'addRules') for (const r of p.rules) out.push({ kind: 'rule', tool: r.toolName, content: r.ruleContent ?? '' })
    else if (p.type === 'setMode') out.push({ kind: 'mode', mode: p.mode })
    else if (p.type === 'addDirectories') out.push({ kind: 'directories', directories: [...p.directories] })
  }
  return out
}

export function permissionFromRequest(requestId, r) {
  return {
    requestId,
    toolName: typeof r.tool_name === 'string' ? r.tool_name : '',
    displayName: typeof r.display_name === 'string' ? r.display_name : typeof r.tool_name === 'string' ? r.tool_name : '',
    input: r.input && typeof r.input === 'object' ? r.input : {},
    description: typeof r.description === 'string' ? r.description : '',
    suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
    // What "Allow for this session" adds, for the card (the same filter as the answer).
    sessionRules: sessionRuleItems(sessionPermissions(r.permission_suggestions)),
    toolUseId: typeof r.tool_use_id === 'string' ? r.tool_use_id : null,
    reason: typeof r.decision_reason === 'string' ? r.decision_reason : ''
  }
}

function windowOf(w) {
  if (!w || typeof w !== 'object') return null
  return {
    utilization: typeof w.utilization === 'number' ? w.utilization : null,
    resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null
  }
}

export function rateLimitFrom(info) {
  const i = info && typeof info === 'object' ? info : {}
  const w = i.unifiedWindows && typeof i.unifiedWindows === 'object' ? i.unifiedWindows : {}
  let fiveHour = windowOf(w.five_hour)
  let sevenDay = windowOf(w.seven_day)
  // Older frames carry one window only (rateLimitType + resetsAt).
  if (!fiveHour && i.rateLimitType === 'five_hour') fiveHour = { utilization: i.utilization ?? null, resetsAt: i.resetsAt ?? null }
  if (!sevenDay && i.rateLimitType === 'seven_day') sevenDay = { utilization: i.utilization ?? null, resetsAt: i.resetsAt ?? null }
  return { status: typeof i.status === 'string' ? i.status : null, fiveHour, sevenDay }
}

function assistantBlocks(content) {
  const out = []
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text })
    else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) out.push({ type: 'thinking', text: b.thinking })
    else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: String(b.id || ''), name: String(b.name || ''), input: b.input && typeof b.input === 'object' ? b.input : {} })
  }
  return out
}

function turnStatus(m, state) {
  const reason = typeof m.terminal_reason === 'string' ? m.terminal_reason : ''
  if (reason.startsWith('aborted')) return 'interrupted'
  if (state.interruptRequested && m.subtype !== 'success') return 'interrupted'
  if (m.subtype === 'success' && !m.is_error) return 'completed'
  return 'failed'
}

// Only our own messages: the CLI also marks its "<local-command-stdout>"
// frames (after set_model) isReplay.
function accept(state, uuid, out) {
  if (typeof uuid !== 'string' || !state.sent.has(uuid) || state.accepted.has(uuid)) return
  state.accepted.add(uuid)
  out.push({ type: 'accepted', uuid })
}

// One frame -> zero or more events.
export function normalizeFrame(m, state) {
  if (!m || typeof m !== 'object') return []
  const child = observeClaudeSubagents(m, state)
  // Child lifecycle/results must not settle or reconfigure the parent session.
  const events = m.parent_tool_use_id && (!['assistant', 'stream_event', 'user'].includes(m.type) || (m.type === 'user' && m.isReplay))
    ? [] : normalizeClaudeFrame(m, state)
  for (const event of events) {
    if (!child.agentId) continue
    event.agentId = child.agentId
    if (event.type === 'textDelta' && !event.messageId) event.messageId = child.childMessageId
  }
  const background = observeClaudeBackground(m, state.background)
  return [...child.out, ...events.filter(event => !m.parent_tool_use_id || ['assistant', 'textDelta', 'toolResult'].includes(event.type)), ...(background ? [background] : [])]
}

function normalizeClaudeFrame(m, state) {
  const out = []
  if (!m || typeof m !== 'object') return out
  const parentToolUseId = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : null
  switch (m.type) {
    case 'system': {
      if (m.subtype === 'init') {
        if (typeof m.session_id === 'string') state.sessionId = m.session_id
        if (!parentToolUseId && typeof m.model === 'string' && m.model) {
          state.initModel = m.model
          state.responseModel = null
        }
        out.push({
          type: 'init',
          sessionId: m.session_id ?? null,
          model: m.model ?? null,
          permissionMode: m.permissionMode ?? null,
          capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
          mcpServers: Array.isArray(m.mcp_servers) ? m.mcp_servers : [],
          tools: Array.isArray(m.tools) ? m.tools : [],
          version: m.claude_code_version ?? null
        })
      } else if (m.subtype === 'compact_boundary' && !parentToolUseId) {
        // The CLI compacted the conversation (/compact, or on its own): what
        // the context held is gone until the next response says it again.
        const meta = m.compact_metadata && typeof m.compact_metadata === 'object' ? m.compact_metadata : {}
        state.contextTokens = null
        out.push({
          type: 'compacted',
          ...(meta.trigger === 'manual' || meta.trigger === 'auto' ? { trigger: meta.trigger } : {}),
          ...(positive(meta.pre_tokens) ? { preTokens: meta.pre_tokens } : {})
        })
      } else if (m.subtype === 'session_state_changed') {
        if (['running', 'requires_action', 'idle'].includes(m.state)) out.push({ type: 'state', state: m.state })
      } else if (m.subtype === 'api_retry') {
        // Shape not recorded yet (docs: error category + HTTP status).
        if (m.error === 'authentication_failed' || m.error_status === 401 || isAuthErrorText(m.error)) {
          out.push({ type: 'authError', message: String(m.error || 'authentication_failed') })
        }
      }
      break
    }
    case 'command_lifecycle': {
      const uuid = m.command_uuid
      if (m.state === 'queued' && state.sent.has(uuid)) out.push({ type: 'queued', uuid })
      else if (m.state === 'started') accept(state, uuid, out)
      if (typeof uuid === 'string') out.push({ type: 'lifecycle', uuid, state: String(m.state || '') })
      break
    }
    case 'user': {
      if (m.isReplay) {
        accept(state, m.uuid, out)
        break
      }
      const content = m.message && m.message.content
      if (!Array.isArray(content)) break // "<local-command-stdout>…" after set_model
      for (const b of content) {
        if (b && b.type === 'tool_result') {
          out.push({
            type: 'toolResult',
            toolUseId: String(b.tool_use_id || ''),
            isError: b.is_error === true,
            text: clipText(toolResultText(b.content)),
            parentToolUseId
          })
        }
      }
      break
    }
    case 'stream_event': {
      const e = m.event || {}
      if (e.type === 'message_start' && e.message && typeof e.message.id === 'string') {
        if (!parentToolUseId) state.streamMessageId = e.message.id
      } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
        if (typeof e.delta.text === 'string' && e.delta.text) {
          out.push({ type: 'textDelta', messageId: parentToolUseId ? null : state.streamMessageId, index: e.index ?? 0, text: e.delta.text, parentToolUseId })
        }
      }
      break
    }
    case 'assistant': {
      const msg = m.message || {}
      if (m.error === 'authentication_failed') out.push({ type: 'authError', message: 'authentication_failed' })
      const blocks = assistantBlocks(msg.content)
      if (!parentToolUseId) {
        const used = contextTokensOf(msg.usage)
        if (used !== null) {
          state.contextTokens = used
          if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>') state.responseModel = msg.model
        }
      }
      // The API's own error, carried as an assistant frame (error:
      // 'invalid_request', the text "Prompt is too long"): not something the
      // assistant said. Once, as apiError; the result frame ends the turn.
      if (typeof m.error === 'string' && m.error) {
        out.push({ type: 'apiError', code: m.error, message: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), parentToolUseId })
        break
      }
      if (blocks.length) out.push({ type: 'assistant', messageId: msg.id ?? null, blocks, parentToolUseId })
      break
    }
    case 'result': {
      const status = turnStatus(m, state)
      state.interruptRequested = false
      const result = typeof m.result === 'string' ? m.result : ''
      if (m.is_error && isAuthErrorText(result)) out.push({ type: 'authError', message: result })
      out.push({
        type: 'turnEnd',
        status,
        result,
        isError: m.is_error === true,
        usage: m.usage ?? null,
        modelUsage: m.modelUsage ?? null,
        costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null,
        durationMs: typeof m.duration_ms === 'number' ? m.duration_ms : null,
        userMessageUuids: Array.isArray(m.user_message_uuids) ? m.user_message_uuids : [],
        terminalReason: m.terminal_reason ?? null,
        permissionDenials: Array.isArray(m.permission_denials) ? m.permission_denials : [],
        errors: Array.isArray(m.errors) ? m.errors : []
      })
      // After the turn's end: the context its last response read, in the
      // window its result reports (the session keeps the newest of each).
      const window = contextWindowFromResult(m.modelUsage, state)
      if (window) state.contextWindow = window
      if (state.contextTokens !== null || state.contextWindow) {
        out.push({ type: 'contextUsage', usedTokens: state.contextTokens, windowTokens: state.contextWindow })
      }
      break
    }
    case 'rate_limit_event': {
      out.push({ type: 'rateLimit', ...rateLimitFrom(m.rate_limit_info) })
      break
    }
    default:
      break // keep_alive, unknown frames
  }
  return out
}
