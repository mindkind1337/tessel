// Claude Code stream-json frames -> the chat adapter's normalized events.
// Pure (no I/O), so it is tested against lines recorded from the real CLI
// (2.1.284, see __tests__/fixtures/claude-real-frames.jsonl).
//
// Control frames (control_request / control_response / control_cancel_request)
// are the adapter's business (they need answers); everything else goes
// through normalizeFrame(frame, state) -> [{ type, ...payload }].

export const TOOL_OUTPUT_MAX_BYTES = 8 * 1024

// The state the normalizer keeps between frames of one process.
export function createFrameState() {
  return {
    streamMessageId: null, // stream_event message_start id, for text deltas
    sent: new Set(), // uuids of our user messages (the adapter adds them)
    accepted: new Set(), // uuids already reported accepted (once each)
    interruptRequested: false, // set by the adapter when it sends interrupt
    sessionId: null
  }
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
// .claude/settings.local.json) is never kept.
export function sessionPermissions(suggestions) {
  if (!Array.isArray(suggestions)) return []
  return suggestions
    .filter((s) => s && typeof s === 'object' && typeof s.type === 'string')
    .map((s) => ({ ...s, destination: 'session' }))
}

export function permissionFromRequest(requestId, r) {
  return {
    requestId,
    toolName: typeof r.tool_name === 'string' ? r.tool_name : '',
    displayName: typeof r.display_name === 'string' ? r.display_name : typeof r.tool_name === 'string' ? r.tool_name : '',
    input: r.input && typeof r.input === 'object' ? r.input : {},
    description: typeof r.description === 'string' ? r.description : '',
    suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
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
  const out = []
  if (!m || typeof m !== 'object') return out
  const parentToolUseId = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : null
  switch (m.type) {
    case 'system': {
      if (m.subtype === 'init') {
        if (typeof m.session_id === 'string') state.sessionId = m.session_id
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
