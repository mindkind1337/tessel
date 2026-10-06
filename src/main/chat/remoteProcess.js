// A chat agent on an SSH host: its process runs there (like VS Code
// Remote-SSH runs the Claude extension's CLI on the server), and the chat
// adapters (claudeChat.js, codexChat.js) talk to it exactly as to a local
// child, over stdio carried by the host's ssh2 connection.
//
// The transport is the remote agent part's (src/main/remoteAgent, see
// REMOTE_AGENTS.md):
//   remoteSpawn({ hostId, command, args, cwd, env })
//     -> child-like { stdin, stdout, stderr, on('exit'|'error'), kill(signal) }
// This file only looks it up and adapts what it returns to what the chat
// adapters expect of a child_process child (pid, exitCode, 'close', streams
// with setEncoding, a write callback). When no remoteSpawn is there yet,
// remoteSpawnAvailable() says so and the chat tells the user, never a crash.
//
// Rules held here:
// - command, args and cwd are remote POSIX values: never through Windows'
//   path functions; args are an array (never one shell string).
// - env holds only what the caller chose for the host (never this PC's
//   environment); the transport keeps it off the remote command line.
// - A dropped connection is told as 'disconnected' (child.disconnected and
//   the exit's payload), so the chat can show it and resume later.
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

const CONTROL = /[\u0000-\u001f\u007f]/
const HOST_ID = /^ssh-[\w-]{1,60}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
// Exit signals / error codes a transport may use for a lost connection.
const LOST = new Set(['disconnected', 'lost', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'])

// The transport's module, when it is there: src/main/remoteAgent/remoteSpawn.js
// exporting remoteSpawn (a glob, so a build without that file still works).
const found = import.meta.glob('../remoteAgent/remoteSpawn.js', { eager: true })
let provided = null

// index.js (or the transport itself) may hand it in: provideRemoteSpawn(fn).
export function provideRemoteSpawn(fn) {
  provided = typeof fn === 'function' ? fn : null
}

export function currentRemoteSpawn() {
  if (provided) return provided
  for (const mod of Object.values(found)) {
    if (mod && typeof mod.remoteSpawn === 'function') return mod.remoteSpawn
  }
  return null
}

export function remoteSpawnAvailable() {
  return !!currentRemoteSpawn()
}

export class RemoteUnavailableError extends Error {
  constructor() {
    super('remote spawn is not available') // i18n-ignore internal, the caller shows its own text
    this.code = 'remote-unavailable'
  }
}

// A remote POSIX absolute path (or "~", "~/…"), no control characters.
export function validRemotePath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 4096 && !CONTROL.test(p) && !p.includes('\\') && (p.startsWith('/') || p === '~' || p.startsWith('~/'))
}

// Only plain names and string values; nothing that would hide a newline.
export function cleanRemoteEnv(env) {
  const out = {}
  if (!env || typeof env !== 'object') return out
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k) || typeof v !== 'string' || v.length > 32 * 1024 || /[\u0000\r\n]/.test(v)) continue
    out[k] = v
  }
  return out
}

function lostReason(x) {
  if (!x) return false
  if (typeof x === 'string') return LOST.has(x)
  return LOST.has(x.code) || x.disconnected === true
}

// What the transport returned -> a child_process-like object.
export function adaptRemoteChild(raw) {
  const child = new EventEmitter()
  child.pid = typeof raw?.pid === 'number' && raw.pid > 0 ? raw.pid : null
  child.exitCode = null
  child.signalCode = null
  child.disconnected = false
  child.remote = true
  let done = false

  const pipeOut = (src) => {
    const out = new PassThrough()
    if (!src) {
      out.end()
      return out
    }
    src.on?.('data', (d) => {
      if (!out.destroyed) out.write(typeof d === 'string' ? Buffer.from(d, 'utf8') : d)
    })
    const end = () => {
      if (!out.writableEnded) out.end()
    }
    src.on?.('end', end)
    src.on?.('close', end)
    src.on?.('error', () => {})
    return out
  }
  child.stdout = pipeOut(raw?.stdout)
  child.stderr = pipeOut(raw?.stderr)

  const rawIn = raw?.stdin
  const stdin = new EventEmitter()
  stdin.destroyed = false
  stdin.writableEnded = false
  stdin.write = (data, cb) => {
    if (stdin.writableEnded || stdin.destroyed || done || !rawIn) {
      if (typeof cb === 'function') queueMicrotask(() => cb(new Error('stdin closed'))) // i18n-ignore internal
      return false
    }
    let called = false
    const finish = (err) => {
      if (called) return
      called = true
      if (typeof cb === 'function') cb(err || null)
    }
    try {
      // A transport's write may or may not take a callback: either way the
      // caller hears once.
      const r = rawIn.write.length >= 2 ? rawIn.write(data, finish) : rawIn.write(data)
      if (rawIn.write.length < 2) queueMicrotask(() => finish(r === false && rawIn.destroyed ? new Error('stdin closed') : null)) // i18n-ignore internal
      return r !== false
    } catch (err) {
      queueMicrotask(() => finish(err))
      return false
    }
  }
  stdin.end = () => {
    if (stdin.writableEnded) return
    stdin.writableEnded = true
    try {
      rawIn?.end?.()
    } catch {
      /* closed */
    }
  }
  rawIn?.on?.('error', (err) => stdin.emit('error', err))
  child.stdin = stdin

  function exited(code, signal) {
    if (done) return
    done = true
    if (lostReason(signal)) child.disconnected = true
    child.exitCode = typeof code === 'number' ? code : null
    child.signalCode = child.exitCode === null ? (typeof signal === 'string' && signal ? signal : 'SIGHUP') : null
    stdin.destroyed = true
    stdin.writableEnded = true
    child.emit('exit', child.exitCode, child.signalCode)
    // After the streams said what they had (as a local child's 'close').
    setImmediate(() => {
      if (!child.stdout.writableEnded) child.stdout.end()
      if (!child.stderr.writableEnded) child.stderr.end()
      child.emit('close', child.exitCode, child.signalCode)
    })
  }
  raw?.on?.('disconnected', () => {
    child.disconnected = true
    exited(null, 'disconnected')
  })
  raw?.on?.('exit', (code, signal) => exited(code, signal))
  raw?.on?.('error', (err) => {
    if (lostReason(err)) {
      child.disconnected = true
      if (child.pid) return exited(null, 'disconnected')
    }
    child.emit('error', err instanceof Error ? err : new Error(String(err)))
    // Never started: no exit will follow.
    if (!child.pid) exited(null, 'SIGTERM')
  })
  child.kill = (signal = 'SIGTERM') => {
    if (done) return false
    try {
      return raw?.kill?.(signal) !== false
    } catch {
      return false
    }
  }
  return child
}

// A spawn(exe, args, opts) for the chat adapters that starts the agent on
// `hostId` in `cwd` (a remote path) with `env` (already the host's).
// The adapter's own spawn options (cwd, env, stdio…) are ignored: the
// remote values are bound here.
export function remoteSpawnFor({ hostId, cwd, env = {}, spawnRemote = currentRemoteSpawn() } = {}) {
  if (typeof hostId !== 'string' || !HOST_ID.test(hostId)) throw new TypeError('remoteProcess: bad hostId')
  if (!validRemotePath(cwd)) throw new TypeError('remoteProcess: bad remote cwd')
  const cleanEnv = cleanRemoteEnv(env)
  return (command, args = []) => {
    if (typeof spawnRemote !== 'function') throw new RemoteUnavailableError()
    if (typeof command !== 'string' || !command || CONTROL.test(command)) throw new TypeError('remoteProcess: bad command')
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string' && !a.includes('\0'))) throw new TypeError('remoteProcess: bad args')
    const raw = spawnRemote({ hostId, command, args: [...args], cwd, env: { ...cleanEnv } })
    if (!raw || typeof raw !== 'object') throw new Error('remote spawn returned nothing') // i18n-ignore internal
    return adaptRemoteChild(raw)
  }
}

// Ends a remote agent: the transport ends the process there (no tree walk
// on this PC: the PIDs are the host's).
export async function killRemoteChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch {
    /* gone */
  }
}
