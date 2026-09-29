// A fake `codex app-server` for the adapter tests: JSON-RPC over JSONL on
// stdio, frames shaped like those recorded from codex-cli 0.158.0
// (codex-real-frames.jsonl next to this file).
//
// Environment:
//   FAKE_CODEX_LOG     file: argv, every stdin message, answers to our server requests, stdin end
//   FAKE_CODEX_MODE    signin          account/read answers no account (requiresOpenaiAuth)
//                      signin-exit     stderr "Not logged in. Run codex login", exit 1, no answer
//                      crash-start     stderr + exit 2 before any answer
//                      noinit          never answers initialize
//                      hang            ignores stdin end (only a kill stops it)
//                      resume-32602    thread/resume with excludeTurns -> -32602
//                      resume-other    thread/resume answers another thread id
//                      resume-norollout thread/resume -> -32600 "no rollout found for thread id X"
//                      noaccount-read  account/read -> -32601 (older server)
//                      posture-missing thread/start and thread/resume answers carry no approvalPolicy
//                      posture-danger  thread answers report dangerFullAccess whatever was asked
//                      posture-drift   thread/settings/updated reports never + dangerFullAccess
//   FAKE_CODEX_IGNORE  comma list of methods never answered (timeouts)
//   FAKE_CODEX_CRLF=1  lines end with \r\n
//   FAKE_CODEX_GARBAGE=1 a malformed line before every frame
//   FAKE_CODEX_DELAY   ms between frames of a turn (default 2)
//
// Message keywords (in the user text):
//   APPROVE     commandExecution + requestApproval offering acceptForSession; waits for the
//               answer (accept*: runs -> completed item; decline/cancel: item declined)
//   APPROVE1    the same with the recorded availableDecisions (no acceptForSession, no decline)
//   EDIT        fileChange + item/fileChange/requestApproval
//   FILTER      error notification willRetry:false, thread idle, NO turn/completed
//   RETRY       error willRetry:true, then the turn goes on normally
//   AUTHFAIL    error 401 willRetry:false, then turn/completed failed (duplicate end)
//   SILENTIDLE  thread idle and nothing else (no turn/completed, no error)
//   SLOW        200 deltas 10 ms apart (to interrupt or steer)
//   TOOLS       reasoning, a 20000-byte command output, an MCP call, a web search, and an
//               agent message delta of another thread (to be ignored)
//   SERVERREQS  every other server request kind; answers logged
//   MCPASK      mcpServer/elicitation/request (a yes/no tool approval); waits for the answer
//   FOREIGN     a command approval of another thread (answer logged), then a normal reply
//   LONGLINE    a 9 MB line with no line end, then (separately) a valid-looking frame and \n
//   SPLIT       the reply's delta frame written in two halves
//   ENDWHILEASK an approval of this turn and one of another turn, then the turn ends (failed)
//               while both wait; the answer to this turn's one is logged
//   MANYASK     51 command approvals at once; the answer to the last one is logged
//   CRASH       ANSI-coloured stderr + exit 2
'use strict'
const fs = require('fs')
const crypto = require('crypto')

const LOG = process.env.FAKE_CODEX_LOG
const MODE = process.env.FAKE_CODEX_MODE || ''
const IGNORE = new Set((process.env.FAKE_CODEX_IGNORE || '').split(',').filter(Boolean))
const EOL = process.env.FAKE_CODEX_CRLF === '1' ? '\r\n' : '\n'
const GARBAGE = process.env.FAKE_CODEX_GARBAGE === '1'
const DELAY = Number(process.env.FAKE_CODEX_DELAY || 2)

function log(rec) {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify(rec) + '\n')
}
log({ t: 'argv', argv: process.argv.slice(2) })
log({ t: 'env', marker: process.env.FAKE_MARKER || null })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const uuid = () => crypto.randomUUID()
const CWD = process.cwd()

function out(frame) {
  if (GARBAGE) process.stdout.write('this is not json {' + EOL)
  process.stdout.write(JSON.stringify(frame) + EOL)
}
const notify = (method, params) => out({ method, params, emittedAtMs: Date.now() })

if (MODE === 'crash-start') {
  process.stderr.write('\u001b[31mERROR\u001b[0m fatal: could not start (simulated)\n')
  process.exit(2)
}
if (MODE === 'signin-exit') {
  process.stderr.write('Error: Not logged in. Run `codex login` first.\n')
  process.exit(1)
}

let threadId = null
let model = 'gpt-6-fake'
let usageTotal = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }

function threadObj(id) {
  return {
    id,
    sessionId: id,
    preview: '',
    ephemeral: false,
    historyMode: 'paginated',
    modelProvider: 'openai',
    model,
    status: { type: 'idle' },
    path: `C:\\fake\\.codex\\sessions\\rollout-${id}.jsonl`,
    cwd: CWD,
    cliVersion: '0.158.0-fake',
    source: 'vscode',
    turns: []
  }
}
function threadResponse(id, p) {
  if (MODE === 'posture-missing') {
    const r = threadResponseFull(id, p)
    delete r.approvalPolicy
    return r
  }
  if (MODE === 'posture-danger') return { ...threadResponseFull(id, p), sandbox: { type: 'dangerFullAccess' } }
  return threadResponseFull(id, p)
}
function threadResponseFull(id, p) {
  return {
    thread: threadObj(id),
    model,
    modelProvider: 'openai',
    serviceTier: 'priority',
    cwd: CWD,
    approvalPolicy: p.approvalPolicy ?? 'never',
    approvalsReviewer: p.approvalsReviewer ?? 'user',
    sandbox: p.sandbox === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false } : p.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'dangerFullAccess' },
    reasoningEffort: 'medium'
  }
}
function mcpStartup() {
  for (const name of ['tessel-team', 'node_repl']) notify('mcpServer/startupStatus/updated', { threadId, name, status: 'starting', error: null, failureReason: null })
  for (const name of ['tessel-team', 'node_repl']) notify('mcpServer/startupStatus/updated', { threadId, name, status: 'ready', error: null, failureReason: null })
}

// ---------- server requests to the adapter ----------
let serverReqN = 0
const waiting = new Map() // id -> resolve(message)
function askAdapter(method, params) {
  const id = serverReqN++
  return {
    id,
    answer: new Promise((resolve) => {
      waiting.set(id, resolve)
      out({ method, id, params })
    })
  }
}

// ---------- turns ----------
let running = null // { id, aborted, steers: [], pendingReqs: Set }
let lastTurnText = ''

function turnShape(id, status, extra = {}) {
  return { id, items: [], itemsView: 'notLoaded', status, error: null, startedAt: null, completedAt: null, durationMs: null, ...extra }
}
function item(method, it, turn) {
  notify(method, { item: it, threadId, turnId: turn.id, [method === 'item/started' ? 'startedAtMs' : 'completedAtMs']: Date.now() })
}
function userEcho(turn, clientId, text) {
  const it = { type: 'userMessage', id: uuid(), clientId, content: [{ type: 'text', text, text_elements: [] }] }
  item('item/started', it, turn)
  item('item/completed', it, turn)
}
function agentMessage(turn, text, pieces) {
  const id = 'msg_' + uuid().replace(/-/g, '')
  item('item/started', { type: 'agentMessage', id, text: '', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }, turn)
  return {
    id,
    delta: (d) => notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: id, delta: d }),
    done: (full) => item('item/completed', { type: 'agentMessage', id, text: full, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }, turn)
  }
}
function usageAndLimits(turn) {
  const last = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 }
  usageTotal = Object.fromEntries(Object.keys(usageTotal).map((k) => [k, usageTotal[k] + last[k]]))
  notify('thread/tokenUsage/updated', { threadId, turnId: turn.id, tokenUsage: { total: usageTotal, last, modelContextWindow: 258400 } })
  notify('account/rateLimits/updated', {
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1791226944 },
      secondary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1790690000 },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      planType: 'plus',
      rateLimitReachedType: null
    }
  })
}
function status(type) {
  notify('thread/status/changed', { threadId, status: type === 'active' ? { type: 'active', activeFlags: [] } : { type } })
}
function complete(turn, st, extra = {}) {
  if (running === turn) running = null
  status('idle')
  notify('turn/completed', { threadId, turn: turnShape(turn.id, st, { durationMs: 42, ...extra }) })
  afterTurn()
}

async function runTurn(turn, clientId, text) {
  const step = async (ms = DELAY) => {
    await sleep(ms)
    return !turn.aborted
  }
  status('active')
  notify('turn/started', { threadId, turn: turnShape(turn.id, 'inProgress', { startedAt: 1 }) })
  notify('hook/started', { threadId, turnId: turn.id, run: {} })
  notify('hook/completed', { threadId, turnId: turn.id, run: {} })
  if (!(await step())) return
  userEcho(turn, clientId, text)

  if (text.includes('CRASH')) {
    process.stderr.write('\u001b[2m2026-09-29T09:40:41Z\u001b[0m \u001b[31mERROR\u001b[0m fatal: simulated crash\n')
    process.exit(2)
  }

  if (text.includes('FILTER')) {
    await step()
    notify('error', { error: { message: 'This request was flagged by the content filter.', codexErrorInfo: 'other', additionalDetails: null }, willRetry: false, threadId, turnId: turn.id })
    running = null
    status('idle')
    afterTurn()
    return
  }

  if (text.includes('SILENTIDLE')) {
    await step()
    running = null
    status('idle')
    afterTurn()
    return
  }

  if (text.includes('AUTHFAIL')) {
    const error = { message: 'unexpected status 401 Unauthorized: Your authentication token has expired. Please log in again.', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null }
    notify('error', { error, willRetry: false, threadId, turnId: turn.id })
    return complete(turn, 'failed', { error })
  }

  if (text.includes('RETRY')) {
    notify('error', { error: { message: 'stream disconnected, retrying 1/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: null }, willRetry: true, threadId, turnId: turn.id })
    status('idle')
    if (!(await step(60))) return
    status('active')
  }

  if (text.includes('SERVERREQS')) {
    const reqs = [
      ['item/tool/requestUserInput', { threadId, turnId: turn.id, itemId: 'q1', questions: [{ id: 'q', header: 'H', question: 'Which?', options: null }], isBlocking: true, autoResolutionMs: null }],
      ['mcpServer/elicitation/request', { threadId, turnId: turn.id, serverName: 'x', message: 'give me', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }],
      ['item/permissions/requestApproval', { threadId, turnId: turn.id, itemId: 'p1', permissions: {} }],
      ['item/tool/call', { threadId, turnId: turn.id, callId: 'c1', tool: 'x', arguments: {} }],
      ['execCommandApproval', { conversationId: threadId, callId: 'e1', command: ['ls'], cwd: CWD }],
      ['applyPatchApproval', { conversationId: threadId, callId: 'a1', fileChanges: {} }],
      ['account/chatgptAuthTokens/refresh', {}],
      ['attestation/generate', {}],
      ['some/unknown/request', {}]
    ]
    for (const [method, params] of reqs) {
      const { answer } = askAdapter(method, params)
      const a = await answer
      log({ t: 'answer', method, response: a })
    }
  }

  if (text.includes('MCPASK')) {
    const ask = askAdapter('mcpServer/elicitation/request', { threadId, turnId: turn.id, serverName: 'files', mode: 'form', message: 'Allow the files server to run delete_all?', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call' } })
    turn.pendingReqs.add(ask.id)
    const a = await ask.answer
    turn.pendingReqs.delete(ask.id)
    log({ t: 'answer', method: 'mcpServer/elicitation/request', response: a })
    if (turn.aborted) return
  }

  if (text.includes('FOREIGN')) {
    const { answer } = askAdapter('item/commandExecution/requestApproval', { threadId: 'another-thread', turnId: 'x', itemId: 'exec-other', reason: 'sub-agent', command: 'rm -rf /', cwd: CWD })
    log({ t: 'answer', method: 'foreign-approval', response: await answer })
  }

  if (text.includes('LONGLINE')) {
    process.stdout.write('x'.repeat(9 * 1024 * 1024))
    await sleep(150)
    process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'smuggled', delta: 'SMUGGLED' } }) + EOL)
  }

  if (text.includes('SPLIT')) {
    const frame = JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'split', delta: 'HALVES' } }) + EOL
    process.stdout.write(frame.slice(0, 20))
    await sleep(30)
    process.stdout.write(frame.slice(20))
  }

  if (text.includes('ENDWHILEASK')) {
    const ask = (id, turnId) => askAdapter('item/commandExecution/requestApproval', { threadId, turnId, itemId: id, reason: 'r', command: `echo ${id}`, cwd: CWD })
    const mine = ask('exec-mine', turn.id)
    const other = ask('exec-other', 'turn-other')
    other.answer.then((a) => log({ t: 'answer', method: 'endwhileask-other', response: a }))
    await sleep(40)
    complete(turn, 'failed', { error: { message: 'ended while asking' } })
    log({ t: 'answer', method: 'endwhileask-mine', response: await mine.answer })
    return
  }

  if (text.includes('MANYASK')) {
    const asks = Array.from({ length: 51 }, (_, i) => askAdapter('item/commandExecution/requestApproval', { threadId, turnId: turn.id, itemId: `exec-many-${i}`, reason: 'r', command: `echo ${i}`, cwd: CWD }))
    log({ t: 'answer', method: 'many-last', response: await asks[50].answer })
    return
  }

  if (text.includes('TOOLS')) {
    item('item/started', { type: 'reasoning', id: 'rs_1', summary: [], content: [] }, turn)
    item('item/completed', { type: 'reasoning', id: 'rs_1', summary: ['**Planning** the work'], content: [] }, turn)
    const cmd = { type: 'commandExecution', id: 'exec-big', pluginId: null, scriptPath: null, command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'type big.txt\'', cwd: CWD, processId: '1', source: 'agent', status: 'inProgress', commandActions: [{ type: 'read', command: 'type big.txt', name: 'big.txt', path: 'big.txt' }], aggregatedOutput: null, exitCode: null, durationMs: null }
    item('item/started', cmd, turn)
    notify('item/commandExecution/outputDelta', { threadId, turnId: turn.id, itemId: 'exec-big', delta: 'xxxx' })
    item('item/completed', { ...cmd, status: 'completed', aggregatedOutput: 'x'.repeat(20000), exitCode: 0, durationMs: 5 }, turn)
    const mcp = { type: 'mcpToolCall', id: 'mcp-1', server: 'tessel-team', tool: 'team_tasks', status: 'inProgress', arguments: { me: '#2' }, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: true, result: null, error: null, durationMs: null }
    item('item/started', mcp, turn)
    item('item/completed', { ...mcp, status: 'completed', result: { content: [{ type: 'text', text: '[] no tasks' }], structuredContent: null, _meta: null }, durationMs: 3 }, turn)
    const ws = { type: 'webSearch', id: 'ws-1', query: 'codex app-server', action: { type: 'search', query: 'codex app-server' }, results: null }
    item('item/started', ws, turn)
    item('item/completed', { ...ws, results: [{}, {}] }, turn)
    notify('item/agentMessage/delta', { threadId: 'another-thread', turnId: 'x', itemId: 'msg_other', delta: 'NOT MINE' })
  }

  if (text.includes('APPROVE') || text.includes('EDIT')) {
    const edit = text.includes('EDIT')
    const itemId = edit ? 'patch-1' : 'exec-' + uuid()
    const command = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "node -e \\"console.log(6*7)\\""'
    const base = edit
      ? { type: 'fileChange', id: itemId, changes: [{ path: 'C:\\w\\a.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }], status: 'inProgress' }
      : { type: 'commandExecution', id: itemId, pluginId: null, scriptPath: null, command, cwd: CWD, processId: null, source: 'agent', status: 'inProgress', commandActions: [{ type: 'unknown', command: 'node -e "console.log(6*7)"' }], aggregatedOutput: null, exitCode: null, durationMs: null }
    item('item/started', base, turn)
    status('active')
    const params = edit
      ? { threadId, turnId: turn.id, itemId, startedAtMs: Date.now(), reason: 'Write a.txt?', grantRoot: null }
      : {
          kind: 'command',
          threadId,
          turnId: turn.id,
          itemId,
          startedAtMs: Date.now(),
          environmentId: 'local',
          reason: 'Run node outside the sandbox?',
          command,
          cwd: CWD,
          commandActions: base.commandActions,
          proposedExecpolicyAmendment: ['node', '-e', 'console.log(6*7)'],
          availableDecisions: text.includes('APPROVE1')
            ? ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['node', '-e', 'console.log(6*7)'] } }, 'cancel']
            : ['accept', 'acceptForSession', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['node', '-e', 'console.log(6*7)'] } }, 'decline', 'cancel']
        }
    const ask = askAdapter(edit ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', params)
    turn.pendingReqs.add(ask.id)
    const answer = await ask.answer
    turn.pendingReqs.delete(ask.id)
    log({ t: 'answer', method: 'approval', response: answer })
    if (turn.aborted) return
    notify('serverRequest/resolved', { threadId, requestId: ask.id })
    const decision = answer && answer.result && answer.result.decision
    const ok = decision === 'accept' || decision === 'acceptForSession'
    if (edit) item('item/completed', { ...base, status: ok ? 'completed' : 'declined' }, turn)
    else if (ok) {
      notify('item/commandExecution/outputDelta', { threadId, turnId: turn.id, itemId, delta: '42\r\n' })
      item('item/completed', { ...base, status: 'completed', aggregatedOutput: '42\r\n', exitCode: 0, durationMs: 80 }, turn)
    } else item('item/completed', { ...base, status: 'declined' }, turn)
    const reply = ok ? 'The command output is 42.' : 'The command was declined.'
    const m = agentMessage(turn, reply)
    m.delta(reply)
    m.done(reply)
    usageAndLimits(turn)
    lastTurnText = reply
    return complete(turn, 'completed')
  }

  const slow = text.includes('SLOW')
  const reply = slow ? null : `Reply to: ${text.slice(0, 40)}`
  const m = agentMessage(turn)
  const pieces = reply ? [reply.slice(0, 5), reply.slice(5)] : Array.from({ length: 200 }, (_, i) => `${i + 1} `)
  let full = ''
  for (const p of pieces) {
    if (!(await step(slow ? 10 : DELAY))) return
    m.delta(p)
    full += p
  }
  // A steer lands at the end of this turn's answer (recorded: same turn, no new turn/started).
  for (const s of turn.steers.splice(0)) {
    userEcho(turn, s.clientId, s.text)
    const extra = ` (steered: ${s.text.slice(0, 30)})`
    m.delta(extra)
    full += extra
  }
  m.done(full)
  usageAndLimits(turn)
  lastTurnText = full
  if (!(await step())) return
  complete(turn, 'completed')
}

function afterTurn() {
  if (stdinEnded) exitSoon()
}

function interruptTurn(turn) {
  turn.aborted = true
  for (const id of turn.pendingReqs) {
    waiting.delete(id)
    notify('serverRequest/resolved', { threadId, requestId: id })
  }
  turn.pendingReqs.clear()
  complete(turn, 'interrupted')
}

// ---------- requests from the adapter ----------
function onRequest(m) {
  const { id, method } = m
  const p = m.params || {}
  if (IGNORE.has(method)) return
  const ok = (result) => out({ id, result })
  const err = (code, message) => out({ id, error: { code, message } })
  switch (method) {
    case 'initialize':
      if (MODE === 'noinit') return
      notify('remoteControl/status/changed', { status: 'disabled', serverName: 'fake', installationId: 'x', environmentId: null })
      return ok({ userAgent: `${p.clientInfo && p.clientInfo.name}/0.158.0-fake (Windows; x86_64)`, codexHome: 'C:\\fake\\.codex', platformFamily: 'windows', platformOs: 'windows' })
    case 'account/read':
      if (MODE === 'noaccount-read') return err(-32601, 'method not found')
      if (MODE === 'signin') return ok({ account: null, requiresOpenaiAuth: true })
      return ok({ account: { type: 'chatgpt', email: 'someone@example.com', planType: 'plus' }, requiresOpenaiAuth: true })
    case 'thread/start':
      threadId = uuid()
      if (p.model) model = p.model
      notify('account/updated', { authMode: 'chatgpt', planType: 'plus' })
      ok(threadResponse(threadId, p))
      notify('thread/started', { thread: threadObj(threadId) })
      return mcpStartup()
    case 'thread/resume':
      if (MODE === 'resume-32602' && p.excludeTurns !== undefined) return err(-32602, 'Invalid params: unknown field `excludeTurns`')
      if (MODE === 'resume-norollout') return err(-32600, `no rollout found for thread id ${p.threadId}`)
      threadId = MODE === 'resume-other' ? uuid() : p.threadId
      if (p.model) model = p.model
      mcpStartup()
      status('idle')
      return ok(threadResponse(threadId, p))
    case 'turn/start': {
      if (running) {
        // Folded into the running turn (recorded): same id, echo later.
        running.steers.push({ clientId: p.clientUserMessageId, text: (p.input || []).map((i) => i.text || '').join('') })
        return ok({ turn: turnShape(running.id, 'inProgress') })
      }
      if (p.model) model = p.model
      const turn = { id: uuid(), aborted: false, steers: [], pendingReqs: new Set() }
      running = turn
      notify('thread/settings/updated', {
        threadId,
        threadSettings:
          MODE === 'posture-drift'
            ? { model, approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' }, effort: p.effort ?? null }
            : { model, approvalPolicy: p.approvalPolicy, approvalsReviewer: p.approvalsReviewer, sandboxPolicy: p.sandboxPolicy, effort: p.effort ?? null }
      })
      ok({ turn: turnShape(turn.id, 'inProgress') })
      runTurn(turn, p.clientUserMessageId, (p.input || []).map((i) => i.text || '').join(''))
      return
    }
    case 'turn/steer': {
      if (!running || running.id !== p.expectedTurnId) return err(-32600, `expected active turn id ${p.expectedTurnId} but found ${running ? running.id : 'none'}`)
      running.steers.push({ clientId: p.clientUserMessageId, text: (p.input || []).map((i) => i.text || '').join('') })
      return ok({ turnId: running.id })
    }
    case 'turn/interrupt': {
      const turn = running
      if (!turn || turn.id !== p.turnId) return err(-32600, 'no active turn to interrupt')
      setTimeout(() => {
        ok({})
        interruptTurn(turn)
      }, 20)
      return
    }
    default:
      return err(-32601, `method not found: ${method}`)
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
  if (typeof m.method === 'string' && m.id !== undefined) return onRequest(m)
  if (typeof m.method === 'string') return // notifications (initialized)
  if (m.id !== undefined) {
    const resolve = waiting.get(m.id)
    if (resolve) {
      waiting.delete(m.id)
      resolve(m)
    } else log({ t: 'late-answer', m })
  }
}

let stdinEnded = false
function exitSoon() {
  if (MODE === 'hang') return
  setTimeout(() => process.exit(0), 20)
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
  exitSoon()
})
