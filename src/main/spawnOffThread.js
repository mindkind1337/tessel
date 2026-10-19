// Programs started from a worker thread, never from the main process's own.
//
// Why: starting a program blocks the thread that starts it until the system
// has created the process (libuv's uv_spawn is synchronous; on Windows that is
// CreateProcess, the PATH search before it, and the antivirus scan of the
// program). Usually a few milliseconds, but seconds while the PC is busy or on
// a program's first start: on 2026-10-17..19 the log named
// `app:inputLanguages` (only a powershell.exe start) holding the main process
// 2.8 s, `scm:status` (git) 7.2 s, `git:worktrees` 1.7 s and
// `agents:probeModels` (Muse's binary) 7.1 s. While it is held, nothing else
// runs: the window, the built-in browser and the terminals all wait.
//
// Here the start happens in a worker thread (its own event loop waits, the
// main process goes on); the output comes back by message. Two forms:
//   execFileOff(file, [args], [opts], callback)  child_process.execFile's
//     callback (err, stdout, stderr) with its output as text
//   spawnOff(file, [args], [opts])  a stand-in for child_process.spawn's
//     child, only this much of it: pid, exitCode, killed, kill(signal),
//     ref() / unref() (no-ops), stdout / stderr ('data' events, setEncoding),
//     stdin (write, end, its 'error'), and the child's 'spawn', 'error',
//     'exit' and 'close' events. No pipe(), send() or other stdio streams:
//     a caller needing more uses child_process.spawn.
// When the worker cannot start, or the options cannot cross to it (a signal,
// a Buffer encoding...), the program is started here as before. A worker that
// dies mid-run fails the runs in flight (an exec's callback gets the code
// ESPAWNWORKER, a child 'error' then 'close') and the programs it started are
// killed, never left running unseen. The worker is started on the first use
// and keeps the process running only while a program it started runs.
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'child_process'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import { Worker, SHARE_ENV } from 'worker_threads'

// The worker's code, run as a script (no file to find in the app's archive).
// Messages in: { id, op: 'exec' | 'spawn', file, args, opts } and, for a
// spawned child, { id, op: 'stdin' | 'end' | 'kill', data | signal }.
const WORKER_SOURCE = `
const { parentPort } = require('worker_threads')
const { execFile, spawn } = require('child_process')
const children = new Map()
const errorOf = (err) => err && { message: String(err.message || err), code: err.code, killed: !!err.killed, signal: err.signal || null, errno: err.errno, syscall: err.syscall, path: err.path }
parentPort.on('message', (m) => {
  if (!m || typeof m !== 'object') return
  if (m.op === 'exec') {
    try {
      const c = execFile(m.file, m.args, m.opts, (err, stdout, stderr) => parentPort.postMessage({ id: m.id, t: 'done', err: errorOf(err), stdout, stderr }))
      // Its pid: killed by the main process if this worker dies first.
      if (c && c.pid) parentPort.postMessage({ id: m.id, t: 'pid', pid: c.pid })
    } catch (err) {
      parentPort.postMessage({ id: m.id, t: 'done', err: errorOf(err), thrown: true, stdout: '', stderr: '' })
    }
    return
  }
  if (m.op === 'spawn') {
    let child
    try {
      child = spawn(m.file, m.args, m.opts)
    } catch (err) {
      parentPort.postMessage({ id: m.id, t: 'thrown', err: errorOf(err) })
      return
    }
    children.set(m.id, child)
    const send = (msg) => parentPort.postMessage({ id: m.id, ...msg })
    child.on('spawn', () => send({ t: 'spawn', pid: child.pid }))
    child.on('error', (err) => send({ t: 'error', err: errorOf(err) }))
    child.on('exit', (code, signal) => send({ t: 'exit', code, signal }))
    child.on('close', (code, signal) => {
      children.delete(m.id)
      send({ t: 'close', code, signal })
    })
    if (child.stdout) child.stdout.on('data', (d) => send({ t: 'out', d }))
    if (child.stderr) child.stderr.on('data', (d) => send({ t: 'err', d }))
    if (child.stdin) child.stdin.on('error', (err) => send({ t: 'stdinError', err: errorOf(err) }))
    return
  }
  const child = children.get(m.id)
  if (!child) return
  try {
    if (m.op === 'stdin' && child.stdin) child.stdin.write(m.data)
    else if (m.op === 'end' && child.stdin) child.stdin.end(m.data)
    else if (m.op === 'kill') child.kill(m.signal)
  } catch {
    /* gone meanwhile */
  }
})
`

const asBuffer = (d) => (Buffer.isBuffer(d) ? d : d instanceof Uint8Array ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : Buffer.from(String(d)))

function rebuildError(e, file, args) {
  if (!e) return null
  const err = new Error(e.message)
  for (const k of ['code', 'killed', 'signal', 'errno', 'syscall', 'path']) if (e[k] !== undefined) err[k] = e[k]
  if (file !== undefined) err.cmd = [file, ...(args || [])].join(' ')
  return err
}

// Only what crosses to the worker as is: plain options (no streams, signals
// or functions); anything else is started here, as before.
const PLAIN = new Set(['cwd', 'env', 'timeout', 'maxBuffer', 'killSignal', 'windowsHide', 'windowsVerbatimArguments', 'shell', 'encoding', 'stdio', 'detached', 'argv0'])
function plainOptions(opts) {
  if (opts == null) return {}
  if (typeof opts !== 'object') return null
  for (const [k, v] of Object.entries(opts)) {
    if (!PLAIN.has(k)) return null
    if (k === 'encoding' && v !== 'utf8' && v !== 'utf-8') return null // text only (a Buffer would come back a Uint8Array)
    if (k === 'stdio' && !(typeof v === 'string' || (Array.isArray(v) && v.every((s) => s == null || typeof s === 'string')))) return null
  }
  return opts
}

// A program's whole tree stopped (its worker died: nobody else will).
function defaultKillPid(pid, execFile) {
  try {
    if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
    else process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

// execFile(file, [args], [options], [callback]) like Node: -> { args, opts, callback }.
function normalize(args, opts, callback) {
  if (!Array.isArray(args)) {
    if (typeof args === 'function') return { args: [], opts: {}, callback: args }
    if (args == null || typeof args === 'object') return normalize([], args, opts)
  }
  if (typeof opts === 'function') return { args: args || [], opts: {}, callback: opts }
  return { args: args || [], opts: opts == null ? {} : opts, callback }
}

// deps (tests): createWorker() -> a worker_threads Worker; execFile / spawn
// (the fallbacks); killPid(pid) (a program left by a dead worker).
export function createSpawner({ createWorker = defaultWorker, execFile = nodeExecFile, spawn = nodeSpawn, killPid = (pid) => defaultKillPid(pid, execFile) } = {}) {
  let worker = null
  let failed = false
  let nextId = 0
  const pending = new Map() // id -> handler(msg)
  const pids = new Map() // id -> the pid of the program that run started
  // The worker keeps the process running only while a run is in flight, as
  // a child started here would (an idle worker never holds a quit back).
  function hold(id, handler) {
    pending.set(id, handler)
    if (pending.size === 1 && worker && typeof worker.ref === 'function') worker.ref()
  }
  function release(id) {
    pids.delete(id)
    if (!pending.delete(id)) return
    if (!pending.size && worker && typeof worker.unref === 'function') worker.unref()
  }

  function ensure() {
    if (worker || failed) return worker
    try {
      const w = createWorker()
      w.on('message', (msg) => {
        const h = msg && pending.get(msg.id)
        if (h) h(msg)
      })
      const lost = () => {
        if (worker !== w) return
        worker = null
        abandon()
      }
      w.on('error', lost)
      w.on('exit', lost)
      if (typeof w.unref === 'function') w.unref()
      worker = w
    } catch {
      failed = true
      worker = null
    }
    return worker
  }

  // The runs in flight when the worker ends: their programs killed, each
  // told (an exec fails, a spawned child errors and closes).
  function abandon() {
    for (const [id, h] of [...pending]) {
      const pid = pids.get(id)
      pids.delete(id)
      pending.delete(id)
      if (pid) killPid(pid)
      h({ id, t: 'lost' })
    }
  }

  function execFileOff(file, argsIn, optsIn, callbackIn) {
    const { args, opts, callback: cb } = normalize(argsIn, optsIn, callbackIn)
    const callback = typeof cb === 'function' ? cb : () => {}
    const plain = plainOptions(opts)
    const w = plain && ensure()
    if (!w) return execFile(file, args, opts, callback)
    const id = ++nextId
    hold(id, (msg) => {
      if (msg.t === 'pid') {
        pids.set(id, msg.pid)
        return
      }
      release(id)
      if (msg.t === 'lost') {
        callback(Object.assign(new Error('the process starter stopped'), { code: 'ESPAWNWORKER' }), '', '') // i18n-ignore internal
        return
      }
      callback(rebuildError(msg.err, file, args), msg.stdout == null ? '' : msg.stdout, msg.stderr == null ? '' : msg.stderr)
    })
    try {
      w.postMessage({ id, op: 'exec', file, args: args || [], opts: { ...plain, ...(plain.env ? { env: { ...plain.env } } : {}) } })
    } catch {
      release(id)
      return execFile(file, args, opts, callback)
    }
    return undefined
  }

  function spawnOff(file, argsIn, optsIn) {
    const { args, opts } = normalize(argsIn, optsIn)
    const plain = plainOptions(opts)
    const w = plain && ensure()
    if (!w) return spawn(file, args, opts)
    const id = ++nextId
    const child = new EventEmitter()
    const stream = () => {
      const s = new EventEmitter()
      let decoder = null
      s.setEncoding = (enc) => {
        decoder = new StringDecoder(enc || 'utf8')
        return s
      }
      s.push = (d) => s.emit('data', decoder ? decoder.write(asBuffer(d)) : asBuffer(d))
      return s
    }
    const stdio = plain.stdio
    const piped = (i) => !stdio || stdio === 'pipe' || (Array.isArray(stdio) && (stdio[i] == null || stdio[i] === 'pipe'))
    child.stdout = piped(1) ? stream() : null
    child.stderr = piped(2) ? stream() : null
    child.stdin = null
    if (piped(0)) {
      const stdin = new EventEmitter()
      let ended = false
      stdin.write = (data) => {
        if (ended) return false
        w.postMessage({ id, op: 'stdin', data })
        return true
      }
      stdin.end = (data) => {
        if (ended) return stdin
        ended = true
        w.postMessage({ id, op: 'end', data })
        return stdin
      }
      child.stdin = stdin
    }
    child.pid = undefined
    child.exitCode = null
    child.killed = false
    // The worker holds the process while the child runs (see hold): nothing
    // to change per child.
    child.ref = () => child
    child.unref = () => child
    // An 'error' nobody listens to would throw in the main process: only
    // emitted to listeners where it is Tessel's own trouble.
    const failQuietly = (err) => {
      if (child.listenerCount('error')) child.emit('error', err)
    }
    child.kill = (signal) => {
      if (child.exitCode !== null) return false
      child.killed = true
      try {
        w.postMessage({ id, op: 'kill', signal })
      } catch {
        return false
      }
      return true
    }
    let closed = false
    hold(id, (msg) => {
      switch (msg.t) {
        case 'spawn':
          child.pid = msg.pid
          pids.set(id, msg.pid)
          child.emit('spawn')
          break
        case 'out':
          if (child.stdout) child.stdout.push(msg.d)
          break
        case 'err':
          if (child.stderr) child.stderr.push(msg.d)
          break
        case 'stdinError':
          if (child.stdin) child.stdin.emit('error', rebuildError(msg.err))
          break
        case 'error':
          child.emit('error', rebuildError(msg.err))
          break
        case 'exit':
          child.exitCode = msg.code
          child.emit('exit', msg.code, msg.signal)
          break
        case 'close':
          closed = true
          release(id)
          child.emit('close', msg.code, msg.signal)
          break
        case 'thrown':
          // spawn() threw there (bad arguments): an 'error' here, a tick
          // later, then 'close' (nothing else will come).
          release(id)
          closed = true
          failQuietly(rebuildError(msg.err))
          child.emit('close', null, null)
          break
        case 'lost':
          if (!closed) {
            closed = true
            failQuietly(Object.assign(new Error('the process starter stopped'), { code: 'ESPAWNWORKER' })) // i18n-ignore internal
            child.emit('close', null, null)
          }
          break
      }
    })
    try {
      w.postMessage({ id, op: 'spawn', file, args: args || [], opts: { ...plain, ...(plain.env ? { env: { ...plain.env } } : {}) } })
    } catch {
      release(id)
      return spawn(file, args, opts)
    }
    return child
  }

  // The worker ended on purpose: what runs there is stopped and told, as
  // when it dies.
  function close() {
    const w = worker
    worker = null
    failed = true
    abandon()
    if (w) {
      try {
        w.terminate()
      } catch {
        /* gone */
      }
    }
  }

  return { execFileOff, spawnOff, close }
}

function defaultWorker() {
  // SHARE_ENV: the worker sees this process's environment as it is now (a
  // PATH read again from the registry included).
  return new Worker(WORKER_SOURCE, { eval: true, env: SHARE_ENV, name: 'Tessel process starter' })
}

const shared = createSpawner()
export const execFileOff = shared.execFileOff
export const spawnOff = shared.spawnOff
