// A fake `claude -p --input-format stream-json --output-format stream-json`
// for the adapter tests. Frames are shaped like those recorded from Claude
// Code 2.1.284 (claude-real-frames.jsonl next to this file).
//
// Environment:
//   FAKE_CLAUDE_LOG    file: every stdin frame, argv, env marker, stdin end (JSON lines)
//   FAKE_CLAUDE_MODE   signin      initialize answers account.tokenSource 'none' (the real
//                                  CLI's "not signed in", as Orca reads it)
//                      signin-exit stderr "Not logged in · Please run /login", exit 1, no answer
//                      crash-start stderr + exit 2 before any answer
//                      noinit      never answers initialize
//                      hang        ignores stdin end (only a kill stops it)
//   FAKE_CLAUDE_IGNORE comma list of control subtypes never answered (timeouts)
//   FAKE_CLAUDE_CRLF=1 lines end with \r\n
//   FAKE_CLAUDE_GARBAGE=1 a malformed line before every frame
//   FAKE_CLAUDE_DELAY  ms between frames of a turn (default 2)
//
// Message keywords (in the user text):
//   PERMISSION  Bash tool_use -> can_use_tool; waits for the answer (allow: runs; deny:
//               tool_result error + permission_denials)
//   CANCELPERM  can_use_tool, then control_cancel_request 30 ms later; turn ends
//   SLOW        200 text deltas, 10 ms apart (to interrupt or send mid-turn)
//   BIGTOOL     a Read tool_result of 20000 bytes
//   AUTHFAIL    api_retry authentication_failed + assistant error + failed result (guessed shape)
//   DIALOG      sends request_user_dialog, logs the answer
//   UNKNOWNREQ  sends a hook_callback control_request, logs the answer
//   CRASH       stderr "fatal: simulated crash" + exit 2
'use strict'
const fs = require('fs')
const crypto = require('crypto')

const LOG = process.env.FAKE_CLAUDE_LOG
const MODE = process.env.FAKE_CLAUDE_MODE || ''
const IGNORE = new Set((process.env.FAKE_CLAUDE_IGNORE || '').split(',').filter(Boolean))
const EOL = process.env.FAKE_CLAUDE_CRLF === '1' ? '\r\n' : '\n'
const GARBAGE = process.env.FAKE_CLAUDE_GARBAGE === '1'
const DELAY = Number(process.env.FAKE_CLAUDE_DELAY || 2)

function log(rec) {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify(rec) + '\n')
}
log({ t: 'argv', argv: process.argv.slice(2) })
log({ t: 'env', emit: process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS || null, marker: process.env.FAKE_MARKER || null })

const argv = process.argv.slice(2)
const argAfter = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : null
}
const SID = argAfter('--session-id') || argAfter('--resume') || crypto.randomUUID()
let model = argAfter('--model') || 'claude-haiku-4-5-20251001'
let permissionMode = argAfter('--permission-mode') || 'default'

const uuid = () => crypto.randomUUID()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function out(frame) {
  if (GARBAGE) process.stdout.write('this is not json {' + EOL)
  process.stdout.write(JSON.stringify(frame) + EOL)
}

if (MODE === 'crash-start') {
  process.stderr.write('fatal: could not start (simulated)\n')
  process.exit(2)
}
if (MODE === 'signin-exit') {
  process.stderr.write('Not logged in · Please run /login\n')
  process.exit(1)
}

// ---------- control requests of the fake to the adapter ----------
const waiting = new Map() // request_id -> resolve(response)
function askAdapter(request) {
  const request_id = uuid()
  return {
    request_id,
    answer: new Promise((resolve) => {
      waiting.set(request_id, resolve)
      out({ type: 'control_request', request_id, request })
    })
  }
}

// ---------- turns ----------
let running = null // { uuid, aborted }
const queue = []
let lastInterrupted = false

function state(s) {
  out({ type: 'system', subtype: 'session_state_changed', state: s, uuid: uuid(), session_id: SID })
}
function lifecycle(cmd, s) {
  out({ type: 'command_lifecycle', command_uuid: cmd, state: s, uuid: uuid(), session_id: SID })
}
function streamEvent(event) {
  out({ type: 'stream_event', event, session_id: SID, parent_tool_use_id: null, uuid: uuid() })
}
function assistant(msgId, content, extra = {}) {
  out({ type: 'assistant', message: { model, id: msgId, type: 'message', role: 'assistant', content, stop_reason: null, usage: { input_tokens: 3, output_tokens: 2 } }, parent_tool_use_id: null, session_id: SID, uuid: uuid(), ...extra })
}
function toolResult(toolUseId, content, isError) {
  out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }] }, parent_tool_use_id: null, session_id: SID, uuid: uuid(), timestamp: new Date().toISOString() })
}
function result(turn, fields) {
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 42,
    duration_api_ms: 30,
    num_turns: 1,
    result: '',
    stop_reason: 'end_turn',
    session_id: SID,
    total_cost_usd: 0.0012,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 5 },
    modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, costUSD: 0.0012, contextWindow: 200000 } },
    permission_denials: [],
    terminal_reason: 'completed',
    uuid: uuid(),
    user_message_uuid: turn.uuid,
    user_message_uuids: [turn.uuid],
    queued_turn_count: queue.length,
    ...fields
  })
}
function textMessage(text) {
  const id = 'msg_' + uuid().replace(/-/g, '').slice(0, 20)
  streamEvent({ type: 'message_start', message: { model, id, type: 'message', role: 'assistant', content: [] } })
  streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  return id
}

async function runTurn(msg) {
  const text = ((msg.message && msg.message.content) || []).map((b) => b.text || '').join('')
  const turn = { uuid: msg.uuid, aborted: false }
  running = turn
  lastInterrupted = false
  lifecycle(msg.uuid, 'started')
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: SID, tools: ['Bash', 'Read', 'Write'], mcp_servers: [], model, permissionMode, apiKeySource: 'none', claude_code_version: '2.1.284-fake', capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'], uuid: uuid() })
  out({ type: 'system', subtype: 'status', status: 'requesting', session_id: SID, uuid: uuid() })
  await sleep(DELAY)
  out({ type: 'user', message: msg.message, session_id: SID, parent_tool_use_id: null, uuid: msg.uuid, timestamp: new Date().toISOString(), isReplay: true })
  const step = async () => {
    await sleep(DELAY)
    return !turn.aborted
  }

  if (text.includes('CRASH')) {
    process.stderr.write('fatal: simulated crash\n')
    process.exit(2)
  }

  if (text.includes('DIALOG') || text.includes('UNKNOWNREQ')) {
    const req = text.includes('DIALOG') ? { subtype: 'request_user_dialog', dialog_kind: 'something' } : { subtype: 'hook_callback', callback_id: 'x' }
    const { answer } = askAdapter(req)
    log({ t: 'answer', subtype: req.subtype, response: await answer })
  }

  if (text.includes('AUTHFAIL')) {
    out({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 0, retry_delay_ms: 0, error_status: 401, error: 'authentication_failed', session_id: SID, uuid: uuid() })
    const id = 'msg_auth'
    assistant(id, [{ type: 'text', text: 'Not logged in · Please run /login' }], { error: 'authentication_failed' })
    return endTurn(turn, { is_error: true, result: 'Not logged in · Please run /login', terminal_reason: 'completed' })
  }

  if (text.includes('PERMISSION') || text.includes('CANCELPERM')) {
    const msgId = 'msg_perm'
    const toolUseId = 'toolu_' + uuid().replace(/-/g, '').slice(0, 20)
    const input = { command: 'node -e "console.log(6*7)"', description: 'Run Node.js command to output 6*7' }
    streamEvent({ type: 'message_start', message: { model, id: msgId, type: 'message', role: 'assistant', content: [] } })
    assistant(msgId, [{ type: 'tool_use', id: toolUseId, name: 'Bash', input, caller: { type: 'direct' } }])
    if (!(await step())) return
    state('requires_action')
    const ask = askAdapter({
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      display_name: 'Bash',
      input,
      description: input.description,
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: input.command }], behavior: 'allow', destination: 'localSettings' }],
      decision_reason: 'This command requires approval',
      decision_reason_type: 'other',
      tool_use_id: toolUseId
    })
    if (text.includes('CANCELPERM')) {
      await sleep(30)
      waiting.delete(ask.request_id)
      out({ type: 'control_cancel_request', request_id: ask.request_id })
      state('running')
      return endTurn(turn, { result: 'cancelled the tool' })
    }
    const answer = await ask.answer
    log({ t: 'answer', subtype: 'can_use_tool', response: answer })
    if (turn.aborted) return
    state('running')
    const body = (answer && answer.response) || {}
    if (body.behavior === 'allow') {
      toolResult(toolUseId, `ran: ${body.updatedInput && body.updatedInput.command}`, false)
      const id = textMessage()
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The command output is 42.' } })
      assistant(id, [{ type: 'text', text: 'The command output is 42.' }])
      return endTurn(turn, { result: 'The command output is 42.' })
    }
    toolResult(toolUseId, String(body.message || 'denied'), true)
    return endTurn(turn, { result: 'The tool was denied.', permission_denials: [{ tool_name: 'Bash', tool_use_id: toolUseId, tool_input: input }] })
  }

  if (text.includes('BIGTOOL')) {
    const toolUseId = 'toolu_big'
    assistant('msg_big', [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: 'big.txt' } }])
    await step()
    toolResult(toolUseId, [{ type: 'text', text: 'x'.repeat(20000) }], false)
  }

  const reply = text.includes('SLOW') ? null : `Reply to: ${text.slice(0, 40)}`
  const id = textMessage()
  const pieces = reply ? [reply.slice(0, 5), reply.slice(5)] : Array.from({ length: 200 }, (_, i) => `${i + 1} `)
  for (const p of pieces) {
    if (text.includes('SLOW')) await sleep(10)
    else if (!(await step())) return
    if (turn.aborted) return
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } })
  }
  const full = pieces.join('')
  assistant(id, [{ type: 'text', text: full }])
  streamEvent({ type: 'content_block_stop', index: 0 })
  streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
  streamEvent({ type: 'message_stop' })
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1790685600, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1790685600 }, seven_day: { utilization: 0.38, resetsAt: 1791082800 } } }, uuid: uuid(), session_id: SID })
  return endTurn(turn, { result: full })
}

function endTurn(turn, fields) {
  if (turn.aborted) return
  result(turn, fields)
  lifecycle(turn.uuid, 'completed')
  finishTurn()
}

function finishTurn() {
  running = null
  state('idle')
  const next = queue.shift()
  if (next) {
    state('running')
    runTurn(next)
  } else if (stdinEnded) exitSoon()
}

function interruptTurn() {
  const turn = running
  if (!turn) return
  turn.aborted = true
  lastInterrupted = true
  for (const [id, resolve] of waiting) {
    waiting.delete(id)
    out({ type: 'control_cancel_request', request_id: id })
    resolve(null)
  }
  out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null, session_id: SID, uuid: uuid() })
  result(turn, { subtype: 'error_during_execution', is_error: true, result: undefined, stop_reason: null, terminal_reason: 'aborted_streaming', errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'] })
  lifecycle(turn.uuid, 'cancelled')
  finishTurn()
}

// ---------- stdin ----------
function onControlRequest(m) {
  const r = m.request || {}
  if (IGNORE.has(r.subtype)) return
  const ok = (response) => out({ type: 'control_response', response: response === undefined ? { subtype: 'success', request_id: m.request_id } : { subtype: 'success', request_id: m.request_id, response } })
  switch (r.subtype) {
    case 'initialize':
      if (MODE === 'noinit') return
      out({ type: 'system', subtype: 'hook_started', hook_id: uuid(), hook_name: 'SessionStart:startup', hook_event: 'SessionStart', uuid: uuid(), session_id: SID })
      out({ type: 'system', subtype: 'hook_response', hook_id: uuid(), hook_name: 'SessionStart:startup', hook_event: 'SessionStart', output: '', stdout: '', stderr: '', exit_code: 0, outcome: 'success', uuid: uuid(), session_id: SID })
      return ok({
        commands: [{ name: 'compact', description: 'Compact the conversation' }],
        agents: [],
        models: [{ value: 'default', displayName: 'Default' }, { value: 'haiku', displayName: 'Haiku' }],
        account: MODE === 'signin' ? { apiProvider: 'firstParty', tokenSource: 'none' } : { apiProvider: 'firstParty', tokenSource: 'claude.ai' },
        pid: process.pid,
        current_permission_mode: permissionMode,
        session_state: 'idle',
        fast_mode_state: 'off'
      })
    case 'interrupt':
      ok({ still_queued: [] })
      return interruptTurn()
    case 'set_model':
      model = r.model
      out({ type: 'user', message: { role: 'user', content: `<local-command-stdout>Set model to \`${r.model}\`</local-command-stdout>` }, session_id: SID, parent_tool_use_id: null, uuid: uuid() })
      return ok()
    case 'set_permission_mode':
      permissionMode = r.mode
      return ok({ mode: r.mode })
    case 'apply_flag_settings':
      return ok()
    default:
      return out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `Unknown subtype: ${r.subtype}` } })
  }
}

function onLine(line) {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    log({ t: 'bad', line })
    return
  }
  log({ t: 'in', m })
  if (m.type === 'control_request') return onControlRequest(m)
  if (m.type === 'control_response') {
    const r = m.response || {}
    // The real CLI echoes the answer to its can_use_tool back (recorded).
    out(m)
    const resolve = waiting.get(r.request_id)
    if (resolve) {
      waiting.delete(r.request_id)
      resolve(r)
    }
    return
  }
  if (m.type === 'user') {
    if (!running) state('running')
    lifecycle(m.uuid, 'queued')
    if (running) queue.push(m)
    else runTurn(m)
  }
}

let stdinEnded = false
function exitSoon() {
  if (MODE === 'hang') return
  setTimeout(() => process.exit(lastInterrupted ? 1 : 0), 20)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, '')
    buf = buf.slice(i + 1)
    if (line.trim()) onLine(line)
  }
})
process.stdin.on('end', () => {
  log({ t: 'stdin-end' })
  stdinEnded = true
  if (MODE === 'hang') {
    setInterval(() => {}, 1000)
    return
  }
  if (!running) exitSoon()
})
