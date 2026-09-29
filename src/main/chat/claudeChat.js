// One Claude Code chat: a long-lived `claude -p` process speaking stream-json
// on stdio (no Agent SDK), with normalized events for the session manager.
// Protocol as recorded from Claude Code 2.1.284 (plan section 9.1):
// - ready = the initialize control_response (system/init only comes with
//   each turn, so waiting for it would hang);
// - a turn ends with `result` (then session_state_changed idle);
// - delivery proof = command_lifecycle started or the replay echo (isReplay).
import { EventEmitter } from 'events'
import { spawn as nodeSpawn } from 'child_process'
import { randomUUID } from 'crypto'
import { listProcesses, treeOf, killPids } from '../processTree'
import { createFrameState, normalizeFrame, permissionFromRequest, sessionPermissions, initializeAuthProblem, isAuthErrorText } from './claudeFrames'

// The CLI's --permission-mode values (auto and dontAsk too: a user's own
// arguments may ask for them).
export const PERMISSION_MODES = ['default', 'bypassPermissions', 'acceptEdits', 'plan', 'auto', 'dontAsk']
// quitKill: how long a kill on quit waits for the exit before giving up.
export const DEFAULT_TIMEOUTS = { start: 30000, control: 30000, close: 3000, exitFlush: 1000, quitKill: 1500 }
const STDERR_TAIL = 8 * 1024
const MAX_LINE = 64 * 1024 * 1024 // a line longer than this is dropped (runaway output)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Model / effort names: plain words ("sonnet", "claude-opus-5-5[1m]"), never a flag.
const NAME = /^[A-Za-z0-9][\w.:[\]/-]{0,99}$/

// The command line (argument array, never through a shell).
export function buildClaudeArgs({ exeArgs = [], permissionMode = 'default', model, sessionId, resume, mcpConfig } = {}) {
  const mode = PERMISSION_MODES.includes(permissionMode) ? permissionMode : 'default'
  const args = [
    ...exeArgs,
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', mode
  ]
  if (mode === 'bypassPermissions') args.push('--dangerously-skip-permissions')
  if (model) args.push('--model', model)
  if (sessionId) args.push('--session-id', sessionId)
  else args.push('--resume', resume)
  if (mcpConfig) args.push('--mcp-config', mcpConfig)
  return args
}

function checkOptions(opts) {
  if (!opts || typeof opts.exe !== 'string' || !opts.exe) throw new TypeError('claudeChat: exe is required')
  if (!opts.env || typeof opts.env !== 'object') throw new TypeError('claudeChat: env is required')
  if (opts.exeArgs != null && (!Array.isArray(opts.exeArgs) || !opts.exeArgs.every((a) => typeof a === 'string'))) throw new TypeError('claudeChat: exeArgs must be strings')
  if (!!opts.sessionId === !!opts.resume) throw new TypeError('claudeChat: exactly one of sessionId / resume')
  const id = opts.sessionId || opts.resume
  if (typeof id !== 'string' || !UUID.test(id)) throw new TypeError('claudeChat: session id must be a uuid')
  if (opts.model != null && (typeof opts.model !== 'string' || !NAME.test(opts.model))) throw new TypeError('claudeChat: bad model')
  if (opts.effort != null && (typeof opts.effort !== 'string' || !NAME.test(opts.effort))) throw new TypeError('claudeChat: bad effort')
  if (opts.permissionMode != null && !PERMISSION_MODES.includes(opts.permissionMode)) throw new TypeError('claudeChat: bad permissionMode')
  if (opts.mcpConfig != null && (typeof opts.mcpConfig !== 'string' || opts.mcpConfig.startsWith('-'))) throw new TypeError('claudeChat: bad mcpConfig')
}

// Kill the CLI and what it started. The root is ours for sure while Node has
// not seen it exit (libuv holds its process handle, so Windows cannot give the
// PID to another program); descendants come from a listing where a child
// counts only if it started after its parent (processTree.treeOf), so a
// reused PID is never killed. Listing fails -> the root alone (child.kill).
export async function killClaudeTree(child, tree = { listProcesses, treeOf, killPids }) {
  const alive = () => child && child.pid && child.exitCode === null && child.signalCode === null
  if (!alive()) return
  let descendants = []
  try {
    const procs = await tree.listProcesses()
    if (procs && alive()) descendants = tree.treeOf(procs, [{ pid: child.pid }]).filter((e) => e.pid !== child.pid)
  } catch {
    descendants = []
  }
  if (!alive()) return
  try {
    child.kill('SIGKILL')
  } catch {
    /* gone meanwhile */
  }
  if (descendants.length) tree.killPids(descendants)
}

export function createClaudeChat(opts) {
  checkOptions(opts)
  const {
    exe,
    exeArgs = [],
    cwd,
    env,
    sessionId = null,
    resume = null,
    model = null,
    effort = null,
    permissionMode = 'default',
    mcpConfig = null,
    spawn = nodeSpawn,
    now = Date.now, // for the start timing in info.startMs
    log = null,
    killTree = killClaudeTree
  } = opts
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts || {}) }
  const chat = new EventEmitter()
  const frames = createFrameState()
  frames.sessionId = sessionId || resume

  let child = null
  let startPromise = null
  let ready = false
  let exited = null // { code, signal } once the process is gone
  let finished = false
  let closing = false
  let lastTurnInterrupted = false
  let stderrTail = ''
  let reqN = 0
  const pending = new Map() // our control requests: id -> { resolve, timer, subtype }
  const permissions = new Map() // the CLI's can_use_tool: requestId -> { input, suggestions }

  function logAt(level, msg) {
    if (!log) return
    try {
      if (typeof log === 'function') log(level, `[claudeChat] ${msg}`)
      else if (typeof log[level] === 'function') log[level]('chat', `claude: ${msg}`)
    } catch {
      /* logging never breaks the chat */
    }
  }

  function emit(type, payload) {
    try {
      chat.emit(type, payload)
    } catch (err) {
      logAt('error', `listener for ${type} threw: ${err && err.message}`)
    }
  }

  function alive() {
    return !!child && !exited && !finished
  }

  // One JSON line to stdin; resolves true once written (write callback), false
  // when the pipe is closed.
  function writeFrame(obj) {
    return new Promise((resolve) => {
      if (!alive() || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return resolve(false)
      try {
        child.stdin.write(JSON.stringify(obj) + '\n', (err) => resolve(!err))
      } catch {
        resolve(false)
      }
    })
  }

  // A control request of ours -> { ok:true, response } | { ok:false, code, error }.
  function control(request, ms = timeouts.control) {
    if (!alive()) return Promise.resolve({ ok: false, code: 'exit', error: 'process not running' }) // i18n-ignore internal
    const requestId = `tessel_${++reqN}_${randomUUID().slice(0, 8)}`
    return new Promise((resolve) => {
      const entry = { subtype: request.subtype, resolve }
      entry.timer = setTimeout(() => {
        pending.delete(requestId)
        logAt('warn', `control ${request.subtype} timed out after ${ms} ms`)
        resolve({ ok: false, code: 'timeout', error: `${request.subtype} timed out` }) // i18n-ignore internal
      }, ms)
      pending.set(requestId, entry)
      writeFrame({ type: 'control_request', request_id: requestId, request }).then((ok) => {
        if (ok || !pending.has(requestId)) return
        clearTimeout(entry.timer)
        pending.delete(requestId)
        resolve({ ok: false, code: 'exit', error: 'stdin closed' }) // i18n-ignore internal
      })
    })
  }

  function answerControl(requestId, body) {
    return writeFrame({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: body } })
  }

  function answerControlError(requestId, error) {
    return writeFrame({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } })
  }

  function onControlResponse(m) {
    const r = m.response || {}
    const entry = pending.get(r.request_id)
    // Unknown ids: the CLI echoes our own answers to its can_use_tool back.
    if (!entry) return
    pending.delete(r.request_id)
    clearTimeout(entry.timer)
    if (r.subtype === 'success') entry.resolve({ ok: true, response: r.response ?? null })
    else entry.resolve({ ok: false, code: 'error', error: String(r.error || 'error') })
  }

  function onControlRequest(m) {
    const id = m.request_id
    const r = m.request || {}
    if (typeof id !== 'string') return
    if (r.subtype === 'can_use_tool') {
      const perm = permissionFromRequest(id, r)
      permissions.set(id, { input: perm.input, suggestions: perm.suggestions })
      emit('permission', perm)
    } else if (r.subtype === 'request_user_dialog') {
      // No dialog kind is supported here: the CLI takes "cancelled".
      answerControl(id, { behavior: 'cancelled' })
    } else {
      logAt('warn', `unsupported control_request ${r.subtype}`)
      answerControlError(id, `Unsupported control request: ${String(r.subtype)}`) // i18n-ignore sent to the CLI
    }
  }

  function onCancelRequest(m) {
    const id = m.request_id
    if (permissions.delete(id)) emit('permissionCancelled', { requestId: id })
  }

  function onFrame(m) {
    if (!m || typeof m !== 'object') return
    if (m.type === 'control_response') return onControlResponse(m)
    if (m.type === 'control_request') return onControlRequest(m)
    if (m.type === 'control_cancel_request') return onCancelRequest(m)
    for (const ev of normalizeFrame(m, frames)) {
      const { type, ...payload } = ev
      if (type === 'turnEnd') lastTurnInterrupted = payload.status === 'interrupted'
      emit(type, payload)
    }
  }

  function attachStdout(stream) {
    let buf = ''
    stream.setEncoding('utf8')
    stream.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (!line.trim()) continue
        let obj
        try {
          obj = JSON.parse(line)
        } catch {
          logAt('warn', `malformed stdout line ignored: ${line.slice(0, 120)}`)
          continue
        }
        onFrame(obj)
      }
      if (buf.length > MAX_LINE) {
        logAt('warn', `stdout line over ${MAX_LINE} bytes dropped`)
        buf = ''
      }
    })
    stream.on('error', () => {})
  }

  function attachStderr(stream) {
    stream.setEncoding('utf8')
    stream.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-STDERR_TAIL)
      emit('stderr', { text: String(d).slice(-4096) })
    })
    stream.on('error', () => {})
  }

  // Everything that waits on the process ends here, once.
  function finish(code, signal, error) {
    if (finished) return
    finished = true
    exited = exited || { code, signal }
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, code: 'exit', error: 'process exited' }) // i18n-ignore internal
    }
    pending.clear()
    for (const id of permissions.keys()) emit('permissionCancelled', { requestId: id })
    permissions.clear()
    // Code 1 after an interrupted last turn, or anything after our close, is a normal end.
    const normal = closing || code === 0 || (code === 1 && lastTurnInterrupted)
    logAt(normal ? 'info' : 'warn', `exited code=${code} signal=${signal}${error ? ' error=' + error : ''}`)
    emit('exit', { code, signal, stderrTail, crashed: !normal, error: error || null })
  }

  // -> { ok:true, pid, info } | { ok:false, code:'spawn'|'exit'|'timeout'|'signin'|'failed', error }
  function start() {
    if (startPromise) return startPromise
    startPromise = (async () => {
      const t0 = now()
      const args = buildClaudeArgs({ exeArgs, permissionMode, model, sessionId, resume, mcpConfig })
      const childEnv = { ...env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }
      let spawnError = null
      try {
        child = spawn(exe, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true })
      } catch (err) {
        finished = true
        return { ok: false, code: 'spawn', error: String((err && err.message) || err) }
      }
      logAt('info', `spawned pid=${child.pid} mode=${permissionMode} ${sessionId ? 'new' : 'resume'}`)
      const spawnFailed = new Promise((resolve) => {
        // 'on', not 'once': a later error (a failed kill) must not throw in main.
        child.on('error', (err) => {
          logAt('warn', `child error: ${err && err.message}`)
          if (spawnError) return
          spawnError = String((err && err.message) || err)
          // No pid: it never started, and 'close' may not follow.
          if (!child.pid) finish(null, null, spawnError)
          resolve()
        })
      })
      child.once('exit', (code, signal) => {
        exited = { code, signal }
        setTimeout(() => finish(code, signal), timeouts.exitFlush)
      })
      child.once('close', (code, signal) => finish(exited ? exited.code : code, exited ? exited.signal : signal))
      if (child.stdin) child.stdin.on('error', () => {}) // EPIPE after exit
      if (child.stdout) attachStdout(child.stdout)
      if (child.stderr) attachStderr(child.stderr)

      const exitWait = new Promise((resolve) => chat.once('exit', resolve))
      const init = control({ subtype: 'initialize' }, timeouts.start)
      let first = await Promise.race([init.then((r) => ({ kind: 'init', r })), exitWait.then(() => ({ kind: 'exit' })), spawnFailed.then(() => ({ kind: 'spawn' }))])
      // An error on a started process is not a start failure: keep waiting.
      if (first.kind === 'spawn' && child.pid) first = await Promise.race([init.then((r) => ({ kind: 'init', r })), exitWait.then(() => ({ kind: 'exit' }))])

      if (spawnError && !child.pid) return { ok: false, code: 'spawn', error: spawnError }
      const r = first.kind === 'init' ? first.r : { ok: false, code: 'exit' }
      if (!r.ok) {
        // 'exit': the process ended first; 'timeout': no answer; 'error': an error answer.
        if (r.code !== 'exit') await close()
        const tail = stderrTail.trim().slice(-2000)
        const errorAnswer = r.code === 'error' ? r.error : ''
        const signin = isAuthErrorText(errorAnswer) || isAuthErrorText(tail)
        if (signin) emit('authError', { message: (errorAnswer || tail).slice(-500) })
        const code = signin ? 'signin' : r.code === 'timeout' ? 'timeout' : r.code === 'error' ? 'failed' : 'exit'
        return { ok: false, code, error: errorAnswer || tail || String(r.error || code) }
      }
      const resp = r.response || {}
      if (initializeAuthProblem(resp)) {
        emit('authError', { message: 'tokenSource none' })
        await close()
        return { ok: false, code: 'signin', error: 'Claude is not signed in' } // i18n-ignore code 'signin' is what the caller shows
      }
      // Effort has no launch flag: applied before the first turn.
      if (effort) {
        const e = await setEffort(effort)
        if (!e.ok) logAt('warn', `initial effort ${effort} not applied: ${e.error}`)
      }
      ready = true
      const account = resp.account && typeof resp.account === 'object' ? resp.account : {}
      return {
        ok: true,
        pid: child.pid,
        info: {
          startMs: now() - t0,
          cliPid: resp.pid ?? null,
          models: Array.isArray(resp.models) ? resp.models : [],
          commands: Array.isArray(resp.commands) ? resp.commands.map((c) => ({ name: c.name, description: c.description })) : [],
          permissionMode: resp.current_permission_mode ?? null,
          sessionState: resp.session_state ?? null,
          fastModeState: resp.fast_mode_state ?? null,
          // Never the email / organization: only how the CLI is signed in.
          auth: { tokenSource: account.tokenSource ?? null, apiProvider: account.apiProvider ?? null }
        }
      }
    })()
    return startPromise
  }

  // A user message. Resolves once the line is written to stdin; delivery
  // shows later as 'queued' then 'accepted' for this uuid.
  async function send({ uuid, text } = {}) {
    if (!ready || !alive()) return { ok: false, error: 'not running' } // i18n-ignore internal
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty' }
    const id = typeof uuid === 'string' && uuid ? uuid : randomUUID()
    frames.sent.add(id) // before the write: 'queued' comes ~3 ms later
    const ok = await writeFrame({
      type: 'user',
      uuid: id,
      session_id: frames.sessionId || '',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] }
    })
    return ok ? { ok: true, uuid: id } : { ok: false, error: 'stdin closed' } // i18n-ignore internal
  }

  async function interrupt() {
    if (!alive()) return { ok: false, error: 'not running' } // i18n-ignore internal
    frames.interruptRequested = true
    const r = await control({ subtype: 'interrupt' })
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, stillQueued: (r.response && r.response.still_queued) || [] }
  }

  // decision: { behavior:'allow'|'deny', session:boolean, message? }
  async function answerPermission(requestId, decision = {}) {
    const p = permissions.get(requestId)
    if (!p) return { ok: false, error: 'unknown or answered request' } // i18n-ignore internal
    let body
    if (decision.behavior === 'allow') {
      body = { behavior: 'allow', updatedInput: p.input }
      if (decision.session) {
        const perms = sessionPermissions(p.suggestions)
        if (perms.length) body.updatedPermissions = perms
      }
    } else if (decision.behavior === 'deny') {
      const msg = typeof decision.message === 'string' && decision.message.trim() ? decision.message.trim() : 'The user denied this tool call.' // i18n-ignore sent to the agent
      body = { behavior: 'deny', message: msg }
    } else {
      return { ok: false, error: 'bad decision' } // i18n-ignore internal
    }
    permissions.delete(requestId)
    const ok = await answerControl(requestId, body)
    return ok ? { ok: true } : { ok: false, error: 'stdin closed' } // i18n-ignore internal
  }

  async function simpleControl(request) {
    const r = await control(request)
    return r.ok ? { ok: true, response: r.response } : { ok: false, code: r.code, error: r.error }
  }

  function setModel(name) {
    if (typeof name !== 'string' || !NAME.test(name)) return Promise.resolve({ ok: false, error: 'bad model' })
    return simpleControl({ subtype: 'set_model', model: name })
  }

  function setEffort(level) {
    if (typeof level !== 'string' || !NAME.test(level)) return Promise.resolve({ ok: false, error: 'bad effort' })
    return simpleControl({ subtype: 'apply_flag_settings', settings: { effortLevel: level } })
  }

  function setPermissionMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) return Promise.resolve({ ok: false, error: 'bad mode' })
    return simpleControl({ subtype: 'set_permission_mode', mode })
  }

  async function killNow() {
    try {
      await killTree(child)
    } catch (err) {
      logAt('error', `tree kill failed: ${err && err.message}`)
      try {
        child.kill()
      } catch {
        /* gone */
      }
    }
  }

  // End stdin (the CLI exits by itself), else kill the tree after timeouts.close.
  // { kill: true } (Tessel quits): the tree is killed at once, and the wait
  // for its exit is bounded (timeouts.quitKill) so quitting never hangs.
  async function close({ kill = false } = {}) {
    closing = true
    if (!child || finished) return { ok: true }
    const done = new Promise((resolve) => (finished ? resolve() : chat.once('exit', resolve)))
    let timer
    const within = (ms) => Promise.race([done.then(() => false), new Promise((r) => (timer = setTimeout(() => r(true), ms)))]).finally(() => clearTimeout(timer))
    if (kill) {
      logAt('info', 'quitting: killing the tree')
      await killNow()
      await within(timeouts.quitKill)
      return { ok: true, killed: true }
    }
    try {
      if (child.stdin && !child.stdin.writableEnded) child.stdin.end()
    } catch {
      /* already closed */
    }
    const timedOut = await within(timeouts.close)
    if (timedOut) {
      logAt('warn', `no exit ${timeouts.close} ms after stdin end, killing the tree`)
      await killNow()
      await done
    }
    return { ok: true, killed: timedOut }
  }

  Object.assign(chat, {
    start,
    send,
    interrupt,
    answerPermission,
    setModel,
    setEffort,
    setPermissionMode,
    close,
    pendingPermissions: () => [...permissions.keys()]
  })
  Object.defineProperties(chat, {
    pid: { get: () => (child ? child.pid : null) },
    sessionId: { get: () => frames.sessionId },
    running: { get: () => alive() }
  })
  return chat
}
