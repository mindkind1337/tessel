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
//   execFileOff(file, args, opts, callback)  child_process.execFile's
//     callback (err, stdout, stderr) with its output as text
//   spawnOff(file, args, opts)  a stand-in for child_process.spawn's child:
//     stdout / stderr ('data', setEncoding), stdin (write, end), kill(), and
//     its 'spawn', 'error', 'exit' and 'close' events
// When the worker cannot start (or dies), the program is started here as
// before: never a lost run. The worker is started on the first use and keeps
// the process running only while a program it started runs.
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
      execFile(m.file, m.args, m.opts, (err, stdout, stderr) => parentPort.postMessage({ id: m.id, t: 'done', err: errorOf(err), stdout, stderr }))
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

// deps (tests): createWorker() -> a worker_threads Worker; execFile / spawn
// (the fallbacks).
export function createSpawner({ createWorker = defaultWorker, execFile = nodeExecFile, spawn = nodeSpawn } = {}) {
  let worker = null
  let failed = false
  let nextId = 0
  const pending = new Map() // id -> handler(msg)
  // The worker keeps the process running only while a run is in flight, as
  // a child started here would (an idle worker never holds a quit back).
  function hold(id, handler) {
    pending.set(id, handler)
    if (pending.size === 1 && worker && typeof worker.ref === 'function') worker.ref()
  }
  function release(id) {
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
        // The runs in flight are told: an exec fails, a spawned child errors.
        for (const [id, h] of [...pending]) {
          pending.delete(id)
          h({ id, t: 'lost' })
        }
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

  function execFileOff(file, args, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts
      opts = {}
    }
    const plain = plainOptions(opts)
    const w = plain && ensure()
    if (!w) return execFile(file, args, opts, callback)
    const id = ++nextId
    hold(id, (msg) => {
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

  function spawnOff(file, args, opts) {
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
          // spawn() threw there (bad arguments): an 'error' here, a tick later.
          release(id)
          child.emit('error', rebuildError(msg.err))
          break
        case 'lost':
          if (!closed) {
            child.emit('error', Object.assign(new Error('the process starter stopped'), { code: 'ESPAWNWORKER' })) // i18n-ignore internal
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

  // The worker ended (the app quits): what runs there is told, as when it dies.
  function close() {
    const w = worker
    worker = null
    failed = true
    for (const [id, h] of [...pending]) {
      pending.delete(id)
      h({ id, t: 'lost' })
    }
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
