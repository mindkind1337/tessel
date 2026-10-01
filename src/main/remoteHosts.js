// Remote hosts over SSH, like Orca's SSH targets (MIT, Copyright (c) 2026
// Lovecast Inc.: src/main/ssh/ssh-target-registry.ts, ssh-config-parser.ts
// sshConfigHostsToTargets, src/main/ipc/ssh-target-crud-handlers.ts).
//
// Phase 1: hosts detected in ~/.ssh/config or added by hand, and terminal
// panes that run Windows' OpenSSH client (ssh.exe) on them through Tessel's
// usual terminal host. The argv is built here from the saved host (never a
// command line from the renderer). Passwords, passphrases and host key
// questions come through OpenSSH's askpass channel to a dialog (sshAskpass.js)
// and the answer goes back to ssh only. Nothing secret is stored, and ssh's
// own host key checking is left as it is.
//
// Now: most hosts use Tessel's ssh2 client instead (ssh/: one connection per
// host in the terminal host, shared by its terminals and its Files session;
// the same dialog; host keys checked against known_hosts and Tessel's own
// store). ssh.exe stays for hosts that need it (sshResolve.js says which);
// sshArgsFor() also feeds `ssh -G` there.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { loadUserSshConfigDetailed } from './sshConfig'
import { readJsonSafe, writeJsonSafe } from './safeJson'
import { t } from './i18n'

export const DEFAULT_SSH_PORT = 22
const STORE_FILE = 'remote-hosts.json'
const MAX_TARGETS = 500
const TEST_TIMEOUT_MS = 20000

// --- Validation -----------------------------------------------------------------
// Every value that reaches ssh.exe's argv is checked: no control characters,
// no leading "-" (it would be read as an option), sane characters and lengths.
const CONTROL = /[\u0000-\u001f\u007f]/
const HOST_RE = /^[\p{L}\p{N}_.:%[\]-]{1,253}$/u
const USER_RE = /^[\p{L}\p{N}_.$@\\-]{1,64}$/u
const JUMP_RE = /^[\p{L}\p{N}_.@:,%[\]-]{1,512}$/u

export function isValidHost(v) {
  return typeof v === 'string' && HOST_RE.test(v) && !v.startsWith('-')
}
export function isValidUser(v) {
  return typeof v === 'string' && USER_RE.test(v) && !v.startsWith('-')
}
export function isValidPort(v) {
  return Number.isInteger(v) && v >= 1 && v <= 65535
}
export function isValidJumpHost(v) {
  return typeof v === 'string' && JUMP_RE.test(v) && !v.startsWith('-')
}
function isValidPath(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 1024 && !CONTROL.test(v) && !v.startsWith('-')
}
function isValidCommand(v) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= 2048 && !CONTROL.test(v)
}
function cleanLabel(v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : ''
}

// A target from the renderer or the store -> a clean target, or { error }.
// The error is a code the interface turns into words.
export function sanitizeTarget(input, { id } = {}) {
  const src = input && typeof input === 'object' ? input : {}
  const host = typeof src.host === 'string' ? src.host.trim() : ''
  if (!host) return { error: 'host-required' }
  if (!isValidHost(host)) return { error: 'host-invalid' }
  const configHost = typeof src.configHost === 'string' && src.configHost.trim() ? src.configHost.trim() : host
  if (!isValidHost(configHost)) return { error: 'host-invalid' }
  const port = src.port === undefined || src.port === null || src.port === '' ? DEFAULT_SSH_PORT : Number(src.port)
  if (!isValidPort(port)) return { error: 'port-invalid' }
  const username = typeof src.username === 'string' ? src.username.trim() : ''
  if (username && !isValidUser(username)) return { error: 'user-invalid' }
  const identityFile = typeof src.identityFile === 'string' ? src.identityFile.trim() : ''
  if (identityFile && !isValidPath(identityFile)) return { error: 'identity-invalid' }
  const jumpHost = typeof src.jumpHost === 'string' ? src.jumpHost.trim() : ''
  if (jumpHost && !isValidJumpHost(jumpHost)) return { error: 'jump-invalid' }
  const proxyCommand = typeof src.proxyCommand === 'string' ? src.proxyCommand.trim() : ''
  if (proxyCommand && !isValidCommand(proxyCommand)) return { error: 'proxy-invalid' }
  const target = {
    id: id || (typeof src.id === 'string' && /^ssh-[\w-]{1,60}$/.test(src.id) ? src.id : newTargetId()),
    label: cleanLabel(src.label) || (username ? `${username}@${host}` : configHost),
    configHost,
    host,
    port,
    username,
    source: src.source === 'ssh-config' ? 'ssh-config' : 'manual'
  }
  if (identityFile) target.identityFile = identityFile
  if (jumpHost) target.jumpHost = jumpHost
  if (proxyCommand) target.proxyCommand = proxyCommand
  return { target }
}

function newTargetId() {
  return `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// --- ~/.ssh/config -> targets (Orca's sshConfigHostsToTargets) --------------------
export function configHostsToTargets(hosts) {
  const out = []
  const seen = new Set()
  for (const entry of hosts || []) {
    if (seen.has(entry.host)) continue
    seen.add(entry.host)
    const { target } = sanitizeTarget({
      label: entry.host,
      configHost: entry.host,
      host: entry.hostname || entry.host,
      port: entry.port ?? DEFAULT_SSH_PORT,
      username: entry.user || '',
      identityFile: entry.identityFile,
      proxyCommand: entry.proxyCommand,
      jumpHost: entry.proxyJump,
      source: 'ssh-config'
    })
    // An entry with values ssh.exe could misread is not offered.
    if (target) out.push(target)
  }
  return out
}

// --- The ssh.exe command line -------------------------------------------------------
// argv (an array, never a shell string) for a terminal on `target`.
// - A host from ~/.ssh/config, untouched: reached by its alias alone, ssh
//   reads the rest (HostName, User, Port...) from the config itself.
// - A host edited or added in Tessel: its fields are passed explicitly. When
//   it still carries a config alias (only its label, user... were edited),
//   the alias keeps the config's other options but HostName and the port are
//   stated (Orca's appendUnclaimedAliasEndpoint), so ssh always dials the
//   host and port Tessel shows, never what the alias says.
export function sshArgsFor(target, { test = false } = {}) {
  const checked = sanitizeTarget(target, { id: target && target.id })
  if (checked.error) throw new Error(checked.error)
  const tg = checked.target
  const args = []
  if (test) args.push('-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10')
  if (tg.source !== 'ssh-config') {
    const viaAlias = tg.configHost !== tg.host
    // % would be read as a token in HostName (%h, %%): escaped.
    if (viaAlias) args.push('-o', `HostName=${tg.host.replace(/%/g, '%%')}`)
    if (viaAlias || tg.port !== DEFAULT_SSH_PORT) args.push('-p', String(tg.port))
    if (tg.username) args.push('-l', tg.username)
    if (tg.identityFile) args.push('-i', tg.identityFile)
    if (tg.jumpHost) args.push('-J', tg.jumpHost)
    if (tg.proxyCommand) args.push('-o', `ProxyCommand=${tg.proxyCommand}`)
  }
  args.push(tg.source === 'ssh-config' || tg.configHost !== tg.host ? tg.configHost : tg.host)
  if (test) args.push('exit')
  return args
}

// Windows' OpenSSH client: System32\OpenSSH first, then the PATH.
export function findSshExe({ env = process.env, exists = fs.existsSync } = {}) {
  const candidates = []
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  candidates.push(join(root, 'System32', 'OpenSSH', 'ssh.exe'))
  for (const dir of String(env.PATH || env.Path || '').split(';')) {
    if (dir.trim()) candidates.push(join(dir.trim().replace(/^"|"$/g, ''), 'ssh.exe'))
  }
  for (const c of candidates) {
    try {
      if (exists(c)) return c
    } catch {
      /* next */
    }
  }
  return null
}

// --- The service ------------------------------------------------------------------
// dir: Tessel's user data folder. home: where ~/.ssh lives (tests: a throwaway).
export function createRemoteHosts({
  dir,
  home = os.homedir(),
  fsApi = fs,
  runFile = execFile,
  sshExe = () => findSshExe(),
  onChange = () => {},
  now = () => Date.now()
} = {}) {
  const file = join(dir, STORE_FILE)
  let cached = null
  const panes = new Map() // paneId -> hostId
  const states = new Map() // hostId -> { status, error }
  const conns = new Map() // hostId -> status of its shared ssh2 connection
  const disconnecting = new Set()

  function load() {
    if (cached) return cached
    let data = null
    let readable = true
    try {
      data = readJsonSafe(file, (d) => d && typeof d === 'object' && Array.isArray(d.targets)).data
    } catch {
      // Locked or unreadable: shown empty now, read again next time (and
      // safeJson refuses to save over it meanwhile).
      readable = false
    }
    const targets = []
    for (const raw of (data && data.targets) || []) {
      const { target } = sanitizeTarget(raw, { id: typeof raw?.id === 'string' ? raw.id : undefined })
      if (target && !targets.some((x) => x.id === target.id)) targets.push(target)
    }
    const removed = Array.isArray(data && data.removed)
      ? data.removed.filter((r) => r && typeof r.configHost === 'string').slice(-200)
      : []
    const loaded = { targets, removed }
    if (readable) cached = loaded
    return loaded
  }

  function save(store) {
    fsApi.mkdirSync(dir, { recursive: true })
    writeJsonSafe(file, { version: 1, targets: store.targets, removed: store.removed })
  }

  function list() {
    return load().targets.map((x) => ({ ...x }))
  }

  // ~/.ssh/config -> saved targets (Orca's importConfig): new aliases are
  // added, config-sourced ones are refreshed, hand-made ones are left alone,
  // removed ones stay removed unless reAdopt (the explicit Import button).
  // Reads the config asynchronously; truncated: the parse hit its budget.
  async function importConfig({ reAdopt = false } = {}) {
    const { hosts, truncated } = await loadUserSshConfigDetailed({ home, fsApi })
    const store = load()
    if (reAdopt) store.removed = []
    const fromConfig = configHostsToTargets(hosts)
    const removed = new Set(store.removed.map((r) => r.configHost))
    const added = []
    let changed = reAdopt
    for (const cfg of fromConfig) {
      const existing = store.targets.find((x) => x.configHost === cfg.configHost)
      if (existing) {
        if (existing.source !== 'ssh-config') continue
        const fields = ['host', 'port', 'username', 'identityFile', 'proxyCommand', 'jumpHost']
        if (fields.some((f) => existing[f] !== cfg[f])) {
          for (const f of fields) {
            if (cfg[f] === undefined) delete existing[f]
            else existing[f] = cfg[f]
          }
          changed = true
        }
        continue
      }
      if (removed.has(cfg.configHost)) continue
      if (store.targets.length >= MAX_TARGETS) break
      store.targets.push(cfg)
      added.push({ ...cfg })
      changed = true
    }
    if (changed) save(store)
    return { targets: added, all: list(), truncated }
  }

  function add(input) {
    const store = load()
    const { target, error } = sanitizeTarget({ ...(input || {}), source: 'manual' }, { id: newTargetId() })
    if (error) return { ok: false, error }
    if (store.targets.length >= MAX_TARGETS) return { ok: false, error: 'too-many' }
    store.targets.push(target)
    store.removed = store.removed.filter((r) => r.configHost !== target.configHost)
    save(store)
    return { ok: true, target: { ...target } }
  }

  function update(id, updates) {
    const store = load()
    const i = store.targets.findIndex((x) => x.id === id)
    if (i < 0) return { ok: false, error: 'not-found' }
    // An edited host is the user's: a later config sync leaves it alone.
    const prev = store.targets[i]
    const merged = { ...prev, ...(updates || {}), source: 'manual' }
    // A new Host typed over an imported alias is a new destination, not the
    // alias any more: the alias is dropped (the host is connected to as
    // shown) and remembered as removed, so the next passive sync does not
    // bring the old entry back (Import does, on request).
    const prevAlias = prev.configHost !== prev.host ? prev.configHost : ''
    const newHost = typeof merged.host === 'string' ? merged.host.trim() : merged.host
    const hostEdited = prevAlias && newHost !== prev.host
    if (hostEdited && (merged.configHost === prevAlias || !merged.configHost)) merged.configHost = newHost
    const { target, error } = sanitizeTarget(merged, { id })
    if (error) return { ok: false, error }
    if (prevAlias && target.configHost !== prevAlias && !store.removed.some((r) => r.configHost === prevAlias)) {
      store.removed.push({ configHost: prevAlias, host: prev.host, port: prev.port, username: prev.username, removedAt: now() })
      store.removed = store.removed.slice(-200)
    }
    store.targets[i] = target
    save(store)
    return { ok: true, target: { ...target } }
  }

  function remove(id) {
    const store = load()
    const i = store.targets.findIndex((x) => x.id === id)
    if (i < 0) return { ok: false, error: 'not-found' }
    const [gone] = store.targets.splice(i, 1)
    store.removed.push({ configHost: gone.configHost, host: gone.host, port: gone.port, username: gone.username, removedAt: now() })
    store.removed = store.removed.slice(-200)
    save(store)
    states.delete(id)
    conns.delete(id)
    notify()
    return { ok: true }
  }

  function get(id) {
    return load().targets.find((x) => x.id === id) || null
  }

  // What pty:create runs for a pane on this host.
  function launchFor(id) {
    const target = get(id)
    if (!target) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    const exe = sshExe()
    if (!exe)
      return {
        ok: false,
        error: t('main.remote.noSsh', 'The OpenSSH client (ssh.exe) was not found. Install it from Windows Settings > Optional features.')
      }
    return { ok: true, file: exe, args: sshArgsFor(target), name: target.label, target: { ...target } }
  }

  // Test connection: ssh in batch mode (no prompts; an unknown or changed
  // host key fails, as ssh decides), runs `exit`.
  function test(id) {
    const target = get(id)
    if (!target) return Promise.resolve({ success: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') })
    const exe = sshExe()
    if (!exe)
      return Promise.resolve({
        success: false,
        error: t('main.remote.noSsh', 'The OpenSSH client (ssh.exe) was not found. Install it from Windows Settings > Optional features.')
      })
    const args = sshArgsFor(target, { test: true })
    return new Promise((resolve) => {
      runFile(exe, args, { timeout: TEST_TIMEOUT_MS, windowsHide: true, shell: false }, (err, _stdout, stderr) => {
        if (!err) return resolve({ success: true })
        const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        const detail = lines.length ? lines[lines.length - 1].slice(0, 400) : ''
        if (err.killed) return resolve({ success: false, error: t('main.remote.testTimeout', 'The connection test timed out.') })
        resolve({
          success: false,
          error: detail || t('main.remote.testExit', 'ssh exited with code {{code}}.', { code: err.code ?? '?' })
        })
      })
    })
  }

  // --- Live state: which hosts have a terminal open --------------------------
  function snapshot() {
    const out = {}
    // shared: the host's shared ssh2 connection is signed in, so a terminal
    // or the Files session opened now asks nothing (a restored pane waiting
    // for Connect starts by itself then).
    for (const [id, s] of states) out[id] = { ...s, panes: panesOf(id), ...(sharedConnected(id) ? { shared: true } : {}) }
    return out
  }
  function sharedConnected(hostId) {
    return conns.get(hostId) === 'connected'
  }
  function notify() {
    try {
      onChange(snapshot())
    } catch {
      /* the window may be gone */
    }
  }
  // A host's state from its panes: connected when one of them got through,
  // connecting while they all still wait (a password prompt, the network).
  function paneState(hostId) {
    const mine = [...panes.values()].filter((p) => p.hostId === hostId)
    return mine.some((p) => p.connected) ? 'connected' : 'connecting'
  }
  // The host's shared ssh2 connection (ssh/sshRemote.js): its panes follow
  // it (connected once it is signed in, connecting while it signs in or
  // reconnects); with no pane, the connection's own state shows (an idle
  // connection is still "connected" until it closes). error: in words.
  function connectionState(hostId, status, error = '') {
    if (!hostId || !get(hostId)) return
    conns.set(hostId, status)
    const mine = [...panes.values()].filter((p) => p.hostId === hostId)
    for (const p of mine) p.connected = status === 'connected'
    if (status === 'error') states.set(hostId, { status: 'error', error: String(error || '') })
    else if (mine.length) states.set(hostId, { status: status === 'connected' ? 'connected' : 'connecting' })
    else if (status === 'disconnected' && error) states.set(hostId, { status: 'disconnected', error: String(error) })
    else states.set(hostId, { status: status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : 'disconnected' })
    notify()
  }
  // connected: false for a new ssh pane (sshAskpass.js calls paneConnected
  // once ssh is through its login); a re-attached pane is connected already.
  function paneStarted(paneId, hostId, { connected = true, ssh2 = false } = {}) {
    if (!hostId) return
    // A pane on the shared ssh2 connection is connected when it is.
    if (ssh2) connected = conns.get(hostId) === 'connected'
    panes.set(paneId, { hostId, connected: !!connected, ssh2: !!ssh2 })
    states.set(hostId, { status: paneState(hostId) })
    notify()
  }
  function paneConnected(paneId) {
    const p = panes.get(paneId)
    if (!p || p.connected) return
    p.connected = true
    states.set(p.hostId, { status: 'connected' })
    notify()
  }
  // ssh asks something again (sshAskpass.js): back to Connecting.
  function paneConnecting(paneId) {
    const p = panes.get(paneId)
    if (!p || !p.connected) return
    p.connected = false
    states.set(p.hostId, { status: paneState(p.hostId) })
    notify()
  }
  // error: why an ssh2 terminal could not connect (in words), instead of
  // ssh.exe's exit code 255.
  function paneExited(paneId, exitCode, { error = '' } = {}) {
    const pane = panes.get(paneId)
    if (!pane) return
    const hostId = pane.hostId
    // Closed by the user (its pane closed): an ended session, not a failure.
    const closedByUser = !!pane.closing
    panes.delete(paneId)
    if ([...panes.values()].some((p) => p.hostId === hostId)) {
      states.set(hostId, { status: paneState(hostId) })
      return notify()
    }
    if (!get(hostId)) {
      // Removed meanwhile: nothing to show for it.
      states.delete(hostId)
      disconnecting.delete(hostId)
      return notify()
    }
    if (pane.ssh2) {
      // The connection's own state says it (connectionState); a terminal
      // that could not start says why.
      if (error && !disconnecting.has(hostId) && !closedByUser) states.set(hostId, { status: 'error', error: String(error) })
      else if (conns.get(hostId) === 'connected') states.set(hostId, { status: 'connected' })
      // A failed sign-in keeps showing its reason.
      else if (conns.get(hostId) !== 'error' || disconnecting.has(hostId) || closedByUser) states.set(hostId, { status: 'disconnected' })
      disconnecting.delete(hostId)
      return notify()
    }
    // 255: ssh itself failed (could not connect, authentication, host key).
    if (exitCode === 255 && !disconnecting.has(hostId) && !closedByUser) {
      states.set(hostId, {
        status: 'error',
        error: t('main.remote.sshFailed', 'ssh could not connect (exit code 255). See its terminal for details.')
      })
    } else states.set(hostId, { status: 'disconnected' })
    disconnecting.delete(hostId)
    notify()
  }
  // Its terminals, to end them (Disconnect).
  function panesOf(hostId) {
    return [...panes].filter(([, p]) => p.hostId === hostId).map(([id]) => id)
  }
  function markDisconnecting(hostId) {
    disconnecting.add(hostId)
  }
  // Its pane is being closed: however ssh ends, it is not an error.
  function paneClosing(paneId) {
    const pane = panes.get(paneId)
    if (pane) pane.closing = true
  }

  return { list, importConfig, add, update, remove, get, launchFor, test, snapshot, sharedConnected, paneStarted, paneConnected, paneConnecting, paneExited, panesOf, markDisconnecting, paneClosing, connectionState }
}

// IPC: remoteHosts:* (the renderer sends ids and form fields, never argv).
// ssh (optional, ssh/sshRemote.js): the shared ssh2 connections — Test signs
// in through them, Disconnect and Remove close them and forget the host's
// kept password / passphrases.
export function registerRemoteHosts({ ipcMain, service, killPane, ssh = null }) {
  const guard = (fn) => async (_evt, arg) => {
    try {
      return await fn(arg || {})
    } catch {
      return { ok: false, error: 'failed' }
    }
  }
  ipcMain.handle('remoteHosts:list', guard(() => ({ ok: true, targets: service.list(), states: service.snapshot() })))
  ipcMain.handle('remoteHosts:importConfig', guard(async ({ reAdopt }) => ({ ok: true, ...(await service.importConfig({ reAdopt: reAdopt === true })) })))
  ipcMain.handle('remoteHosts:add', guard(({ target }) => service.add(target)))
  ipcMain.handle('remoteHosts:update', guard(({ id, updates }) => service.update(String(id || ''), updates)))
  ipcMain.handle('remoteHosts:remove', guard(({ id }) => {
    const hostId = String(id || '')
    service.markDisconnecting(hostId)
    for (const p of service.panesOf(hostId)) killPane(p)
    if (ssh) ssh.disconnect(hostId)
    return service.remove(hostId)
  }))
  ipcMain.handle('remoteHosts:test', guard(async ({ id }) => {
    const hostId = String(id || '')
    const target = ssh ? service.get(hostId) : null
    if (target) {
      const mode = await ssh.modeFor(target)
      if (mode.mode === 'ssh2') return ssh.testConnection(hostId, mode.spec)
    }
    return service.test(hostId)
  }))
  ipcMain.handle('remoteHosts:disconnect', guard(({ id }) => {
    const hostId = String(id || '')
    service.markDisconnecting(hostId)
    const ids = service.panesOf(hostId)
    for (const p of ids) killPane(p)
    if (ssh) ssh.disconnect(hostId)
    return { ok: true, closed: ids.length }
  }))
}
