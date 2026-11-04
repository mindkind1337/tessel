// Tessel's own tmux on an SSH host that has none, so a persistent pane there
// (sshHostBridge.js: "Keep sessions alive on the server", on by default)
// survives a lost connection all the same.
//
// Before a persistent pane opens on a host (index.js createSshPane), main asks
// the host what tmux it has (remoteFs.js queryTmux -> remoteShell.js
// __t_tmuxq): the system's tmux wins and nothing is sent; Tessel's copy in
// ~/.tessel-server/bin at the bundled version is reused; otherwise, for a
// Linux x86_64 or aarch64 host and when this build ships a copy for it
// (bundledTmux.js), the binary goes there over the Files session (installTmux
// -> __t_tmux: written under umask 077, checked against its sha256, run once
// with -V to prove the home folder may run it, renamed over bin/tmux). The
// pane's own probe (sshHostBridge.js TMUX_PROBE) then finds that copy.
//
// What a pane sees (sshMessages.js tmuxMissingText): nothing when tmux is
// there; the reason when the copy could not be put there (no copy for that
// kind of machine, a home folder mounted noexec, a checksum mismatch, a
// failed upload); that the next session will have it when the host was not
// connected yet (a first terminal: the copy goes there in the background) or
// the install took longer than TMUX_WAIT_MS.
import { tmuxArchFor } from './bundledTmux'

// A pane waits this long at most for the copy (a slow link: the pane opens
// plain meanwhile, the install goes on for the next one).
export const TMUX_WAIT_MS = 20_000
// A failed install (upload, checksum) is not tried again sooner than this.
const RETRY_MS = 60_000
export const MAX_TMUX_BYTES = 16 * 1024 * 1024

// What __t_tmuxq printed: `@sys tmux 3.4` (the system's), `@own tmux 3.5a`
// (Tessel's copy, when it runs), `@arch x86_64` (uname -m).
export function parseTmuxQuery(text) {
  const out = { system: null, own: null, arch: null }
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    const key = line.slice(0, sp)
    const value = line.slice(sp + 1).trim().slice(0, 80)
    if (key === '@sys' && value) out.system = value
    else if (key === '@own' && value) out.own = value
    else if (key === '@arch' && value) out.arch = value
  }
  return out
}

// "tmux 3.5a" -> "3.5a" (the bundle's VERSION form).
const versionOf = (v) => String(v || '').replace(/^tmux\s+/, '').trim()

// __t_tmux's exit codes.
function installFailure(rc) {
  if (rc === 0) return null
  if (rc === 83) return 'checksum'
  if (rc === 84) return 'noexec'
  if (rc === 98 || rc === 124) return 'upload'
  return 'failed'
}

// bundle: bundledTmux.js loadBundledTmux() (null: this build ships no copy).
// query(hostId) / install(hostId, { version, sha256, binary }) -> { rc, out,
// err } | { error } (remoteFs.js). connected(hostId): whether a request runs
// on the host without a sign-in (remoteFs.js connectedQuietly).
export function createTmuxInstaller({ bundle, query, install, connected, log = () => {}, timers = { setTimeout, clearTimeout }, now = Date.now, waitMs = TMUX_WAIT_MS }) {
  const settled = new Map() // hostId -> result that holds for the app run
  const running = new Map() // hostId -> Promise<result>
  const lastFailure = new Map() // hostId -> { at, result } (tried again after RETRY_MS)

  function settle(hostId, result) {
    settled.set(hostId, result)
    return result
  }

  async function work(hostId) {
    if (!bundle) return settle(hostId, { ok: false, reason: 'no-bundle' })
    const q = await query(hostId)
    if (!q || q.error) return { ok: false, reason: 'failed', detail: (q && q.error) || '' }
    if (q.rc !== 0) return { ok: false, reason: 'failed', detail: `query exit ${q.rc}` }
    const found = parseTmuxQuery(q.out)
    if (found.system) return settle(hostId, { ok: true, source: 'system', version: found.system })
    if (found.own && versionOf(found.own) === bundle.version) return settle(hostId, { ok: true, source: 'bundled', version: found.own })
    const arch = tmuxArchFor(found.arch)
    if (!arch || !bundle.file(arch)) return settle(hostId, { ok: false, reason: 'no-arch', arch: found.arch || '?' })
    const binary = bundle.read(arch)
    if (!binary) return settle(hostId, { ok: false, reason: 'failed', detail: 'the bundled copy is unreadable or corrupt' })
    const r = await install(hostId, { version: bundle.version, sha256: bundle.sha256(arch), binary })
    if (!r || r.error) return { ok: false, reason: 'upload', detail: (r && r.error) || '' }
    const failure = installFailure(r.rc)
    if (!failure) return settle(hostId, { ok: true, source: 'bundled', version: String(r.out || '').trim().slice(0, 80) || `tmux ${bundle.version}`, installed: true })
    const result = { ok: false, reason: failure, detail: `exit ${r.rc} ${String(r.err || '').slice(0, 300)}`.trim() }
    // A home folder that refuses to run programs, or a copy of the wrong
    // kind: the same tomorrow.
    return failure === 'noexec' ? settle(hostId, result) : result
  }

  // The tmux of this host, Tessel's copy put there when needed. -> Promise<
  // { ok: true, source: 'system' | 'bundled' } | { ok: false, reason, ... }>
  // One at a time per host; a lasting answer is kept for the app run.
  function ensure(hostId) {
    if (typeof hostId !== 'string' || !hostId) return Promise.resolve({ ok: false, reason: 'failed' })
    const kept = settled.get(hostId)
    if (kept) return Promise.resolve(kept)
    const busy = running.get(hostId)
    if (busy) return busy
    const last = lastFailure.get(hostId)
    if (last && now() - last.at < RETRY_MS) return Promise.resolve(last.result)
    const p = Promise.resolve()
      .then(() => work(hostId))
      .catch((err) => ({ ok: false, reason: 'failed', detail: (err && err.message) || '' }))
      .then((r) => {
        running.delete(hostId)
        if (r.ok) {
          lastFailure.delete(hostId)
          if (r.installed) log(`tessel's tmux put on ${hostId} (${r.version})`)
        } else {
          if (r.reason !== 'no-bundle') log(`tmux on ${hostId}: ${r.reason} ${r.detail || r.arch || ''}`.trim())
          if (!settled.has(hostId)) lastFailure.set(hostId, { at: now(), result: r })
        }
        return r
      })
    running.set(hostId, p)
    return p
  }

  // For a pane opening now on hostId: the answer when the host is connected
  // (waiting up to waitMs for the install), { ok: false, reason:
  // 'not-connected' } when it is not (nothing started: the caller starts the
  // install once the pane's own connection is up), { ok: false, reason:
  // 'slow' } past waitMs (the install goes on in the background).
  function forPane(hostId) {
    const kept = settled.get(hostId)
    if (kept) return Promise.resolve(kept)
    if (!running.has(hostId) && !connected(hostId)) return Promise.resolve({ ok: false, reason: 'not-connected' })
    let timer = null
    const late = new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve({ ok: false, reason: 'slow' }), waitMs)
    })
    return Promise.race([ensure(hostId), late]).finally(() => timers.clearTimeout(timer))
  }

  return {
    ensure,
    forPane,
    bundled: !!bundle,
    version: bundle ? bundle.version : null,
    forget: (hostId) => {
      settled.delete(hostId)
      lastFailure.delete(hostId)
    }
  }
}
