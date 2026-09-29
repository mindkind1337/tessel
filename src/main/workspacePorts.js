// Live ports of each workspace copy, like Orca's "Live Ports" (ported from
// Orca's src/main/ports/local-workspace-platform-port-scanner.ts,
// local-workspace-port-address.ts, local-workspace-port-attribution.ts and
// workspace-port-ownership.ts; Orca is MIT, Copyright (c) 2026 Lovecast Inc.).
//
// One scan = one listener listing (`netstat -ano -p tcp` on Windows, like
// Orca; `lsof` elsewhere) + one process listing (pid, parent, creation time,
// name, executable, command line). A listener belongs to a copy when its
// process runs under one of the copy's pane shells (Tessel knows each pane's
// shell pid), else, like Orca, when its command line names the copy's folder.
//
// Stop Process is destructive, so it trusts nothing cached: it runs its own
// listing started after the request, refuses when any part of it failed or
// the process cannot be identified (pid + creation time + name from that
// listing), never stops one of Tessel's own processes, re-checks the process
// and its port right before stopping it, and then stops that one pid only.
import { execFile } from 'child_process'
import path from 'path'
import os from 'os'
import { t } from './i18n'

const HTTP_PORTS = new Set([80, 3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888])
const HTTPS_PORTS = new Set([443, 8443])

// Orca: connectHostForBindHost.
export function connectHostForBindHost(host) {
  if (host === '*' || host === '0.0.0.0' || host === '::') return 'localhost'
  return host
}

// Orca: parseAddressWithPort.
export function parseAddressWithPort(value) {
  const trimmed = String(value || '')
    .trim()
    .replace(/\s+\(LISTEN\)$/i, '')
  const match = trimmed.match(/^\[([^\]]+)\]:(\d+)$/) || trimmed.match(/^(.+):(\d+)$/)
  if (!match) return null
  const port = Number.parseInt(match[2], 10)
  if (!validPort(port)) return null
  return { host: match[1], port }
}

function validPort(port) {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535
}

// Orca: dedupeRawPorts (0.0.0.0 and :: of one process are one row).
export function dedupeRawPorts(ports) {
  const seen = new Set()
  const out = []
  for (const p of ports) {
    const key = `${connectHostForBindHost(p.host)}:${p.port}:${p.pid ?? 'unknown'}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

// Orca: parseNetstatListeningOutput. `netstat -ano -p tcp` rows:
//   TCP    0.0.0.0:5173    0.0.0.0:0    LISTENING    1234
export function parseNetstatListening(output) {
  const ports = []
  for (const line of String(output || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/).slice(0, 6)
    if (fields[0]?.toUpperCase() !== 'TCP') continue
    const stateIndex = fields.findIndex((f) => f.toUpperCase() === 'LISTENING')
    if (stateIndex < 2) continue
    const parsed = parseAddressWithPort(fields[1])
    const pid = Number.parseInt(fields[stateIndex + 1] ?? '', 10)
    if (!parsed) continue
    ports.push({ ...parsed, pid: Number.isFinite(pid) ? pid : undefined })
  }
  return dedupeRawPorts(ports)
}

// Orca: parseLsofListeningOutput (`lsof -nP -iTCP -sTCP:LISTEN -F pcn`).
export function parseLsofListening(output) {
  const ports = []
  let pid
  let processName
  for (const line of String(output || '').split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const n = Number.parseInt(value, 10)
      pid = Number.isFinite(n) ? n : undefined
      processName = undefined
    } else if (tag === 'c') {
      processName = value
    } else if (tag === 'n') {
      const parsed = parseAddressWithPort(value)
      if (parsed) ports.push({ pid, processName, ...parsed })
    }
  }
  return dedupeRawPorts(ports)
}

function inferProtocol(port) {
  if (HTTPS_PORTS.has(port)) return 'https'
  if (HTTP_PORTS.has(port)) return 'http'
  return 'unknown'
}

function comparablePath(p) {
  const s = String(p || '')
  const resolved = s.startsWith('/') ? path.posix.resolve(s) : path.resolve(s)
  const normalized = resolved.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

// Orca: includesPathBoundary.
function includesPathBoundary(commandLine, normalizedPath) {
  let index = commandLine.indexOf(normalizedPath)
  while (index !== -1) {
    const before = index === 0 ? '' : commandLine[index - 1]
    const after = commandLine[index + normalizedPath.length] ?? ''
    if ((before === '' || /\s|["'=]/.test(before)) && (after === '' || /[\s"'/:]/.test(after))) return true
    index = commandLine.indexOf(normalizedPath, index + normalizedPath.length)
  }
  return false
}

// The copy a listening process belongs to.
// probes: [{ id, pids: [shell pid...], path }]; procs: [{ pid, ppid, name, cmd }].
// First the process tree: the listener or one of its ancestors is a pane
// shell of the copy. Then, like Orca on Windows (no cwd there), the copy
// whose folder its command line names (the deepest one).
export function ownerOf(pid, byPid, shellOwner, probes) {
  const seen = new Set()
  let cur = pid
  for (let depth = 0; depth < 32 && Number.isInteger(cur) && cur > 0 && !seen.has(cur); depth++) {
    seen.add(cur)
    if (shellOwner.has(cur)) return { id: shellOwner.get(cur), confidence: 'tree' }
    const p = byPid.get(cur)
    if (!p) break
    cur = p.ppid
  }
  const proc = byPid.get(pid)
  const cmd = proc && proc.cmd ? comparableText(proc.cmd) : ''
  if (!cmd) return null
  let best = null
  for (const probe of probes) {
    if (!probe.path) continue
    const np = comparablePath(probe.path)
    if (np.length < 4 || homeLike(np)) continue // never a drive root or the home folder
    if (includesPathBoundary(cmd, np) && (!best || np.length > best.len)) best = { id: probe.id, len: np.length }
  }
  return best ? { id: best.id, confidence: 'command' } : null
}

// The home folder or one above it: every program's path would match.
let homeCache = null
function homeLike(np) {
  if (homeCache === null) homeCache = comparablePath(os.homedir())
  return homeCache === np || homeCache.startsWith(np + '/')
}

function comparableText(s) {
  const n = String(s).replace(/\\/g, '/').replace(/\/+/g, '/')
  return process.platform === 'win32' ? n.toLowerCase() : n
}

// raw listeners + processes + probes -> { byProbe: { [probe id]: [port] },
// external: [port] } (Orca's workspace / external kinds), each port
// { id, kind, bindHost, connectHost, port, pid, processName, protocol }, sorted by port.
export function attributePorts(raw, procs, probes) {
  const byPid = new Map()
  for (const p of procs || []) byPid.set(p.pid, p)
  const shellOwner = new Map()
  for (const probe of probes || []) {
    for (const pid of probe.pids || []) if (Number.isInteger(pid) && pid > 0) shellOwner.set(pid, probe.id)
  }
  const out = {}
  for (const probe of probes || []) out[probe.id] = []
  const external = []
  for (const r of raw || []) {
    const owner = Number.isInteger(r.pid) && r.pid > 0 ? ownerOf(r.pid, byPid, shellOwner, probes || []) : null
    const proc = byPid.get(r.pid)
    const port = {
      id: `${r.host}:${r.port}:${r.pid ?? 'unknown'}`,
      bindHost: r.host,
      connectHost: connectHostForBindHost(r.host),
      port: r.port,
      pid: r.pid,
      processName: r.processName || (proc && proc.name) || undefined,
      protocol: inferProtocol(r.port)
    }
    if (owner && out[owner.id]) out[owner.id].push({ ...port, kind: 'workspace', confidence: owner.confidence })
    else external.push({ ...port, kind: 'external' })
  }
  const byPort = (a, b) => a.port - b.port || a.connectHost.localeCompare(b.connectHost)
  for (const list of Object.values(out)) list.sort(byPort)
  external.sort(byPort)
  return { byProbe: out, external }
}

function runListeners() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
        resolve(err ? null : parseNetstatListening(stdout))
      )
    } else {
      execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
        // lsof exits 1 when nothing listens.
        resolve(err && !stdout ? (err.code === 1 ? [] : null) : parseLsofListening(stdout))
      )
    }
  })
}

// The processes, for ports: [{ pid, ppid, created, name, exe, cmd }], or null
// when the listing failed. created: when the process started, as the system
// says it (Windows FILETIME in UTC, `ps` lstart elsewhere), '' when unknown;
// with the pid it tells a process from a later one that reused its pid.
const PS_ROW =
  "$c = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { '' }; " +
  '"$($_.ProcessId)`t$($_.ParentProcessId)`t$c`t$($_.Name)`t$($_.ExecutablePath)`t$($_.CommandLine)"'

export function parseWindowsProcesses(stdout) {
  const out = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!/^\d+\t/.test(line)) continue
    const [pid, ppid, created, name, exe, ...cmd] = line.split('\t')
    out.push({ pid: Number(pid), ppid: Number(ppid), created: created || '', name: name || '', exe: exe || '', cmd: cmd.join('\t') })
  }
  return out
}

export function parsePsProcesses(stdout) {
  const out = []
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s*(.*)$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), created: m[3].replace(/\s+/g, ' '), name: path.basename(m[4]), exe: '', cmd: m[5] })
  }
  return out
}

// pid: only that process ([] when it is not running); else all of them.
function runProcesses(pid) {
  const one = Number.isSafeInteger(pid) && pid > 0
  const opts = { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const filter = one ? ` -Filter "ProcessId=${pid}"` : ''
      const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process${filter} -ErrorAction Stop | ForEach-Object { ${PS_ROW} }`
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], opts, (err, stdout) => {
        if (err) return resolve(null)
        const list = parseWindowsProcesses(stdout)
        resolve(!one && !list.length ? null : list)
      })
    } else {
      const args = [...(one ? ['-p', String(pid)] : ['-e']), '-o', 'pid=,ppid=,lstart=,comm=,args=']
      execFile('ps', args, { ...opts, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
        // ps -p exits 1 when that process is not running.
        if (err && !(one && err.code === 1 && !String(stdout || '').trim())) return resolve(null)
        const list = parsePsProcesses(stdout)
        resolve(!one && !list.length ? null : list)
      })
    }
  })
}

function sameProcess(a, b) {
  return !!(a && b && a.pid === b.pid && a.created && String(a.created) === String(b.created) && String(a.name).toLowerCase() === String(b.name).toLowerCase())
}

function createdOrder(c) {
  const s = String(c || '')
  if (/^\d+$/.test(s)) return BigInt(s)
  const t = Date.parse(s)
  return Number.isFinite(t) ? BigInt(t) : null
}

function firstWord(cmd) {
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(String(cmd || ''))
  return m ? m[1] ?? m[2] ?? m[3] : ''
}

function isAbsolutePath(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

// Is this one of Tessel's own processes? selfPids: every Tessel process
// (main, renderers, GPU, utility, terminal host); terminalHostPids: the
// terminal host, whose children are the terminals' shells; shellPids: the
// pane shells. Its executable is Tessel's (selfExe) or lies in Tessel's
// folders (appRoots); or it runs under a Tessel process without a terminal
// in between (what a terminal runs is the user's).
export function isTesselProcess(target, byPid, { selfPids = [], terminalHostPids = [], shellPids = [], selfExe = '', appRoots = [] } = {}) {
  const valid = (n) => Number.isSafeInteger(n) && n > 0
  const self = new Set(selfPids.filter(valid))
  if (self.has(target.pid)) return true
  const exe = target.exe || firstWord(target.cmd)
  if (exe && isAbsolutePath(exe)) {
    const e = comparablePath(exe)
    if (selfExe && e === comparablePath(selfExe)) return true
    for (const root of appRoots) {
      if (!root) continue
      const r = comparablePath(root)
      if (e === r || e.startsWith(r + '/')) return true
    }
  }
  const shells = new Set(shellPids.filter(valid))
  const hosts = new Set(terminalHostPids.filter(valid))
  const seen = new Set([target.pid])
  let child = target
  for (let depth = 0; depth < 64; depth++) {
    if (shells.has(child.pid)) return false // a terminal's shell
    const ppid = child.ppid
    if (!valid(ppid) || seen.has(ppid)) return false
    const parent = byPid.get(ppid)
    // Windows keeps a dead parent's pid: a younger "parent" is not the parent.
    const pc = parent ? createdOrder(parent.created) : null
    const cc = createdOrder(child.created)
    if (pc !== null && cc !== null && pc > cc) return false
    if (hosts.has(ppid)) return false // a shell of the terminal host
    if (self.has(ppid)) return true
    if (!parent) return false
    seen.add(ppid)
    child = parent
  }
  return false
}

// Scans share their raw data for a few seconds (the sidebar and the status
// bar ask at the same time); one listing each at most.
// processInfo(pid) -> { ok: false } when the check failed, else { ok: true,
// proc } (proc undefined when that pid is not running).
export function createPortScanner({
  listeners = runListeners,
  processes,
  processInfo,
  now = () => Date.now(),
  ttlMs = 4000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
} = {}) {
  if (!processes) {
    processes = () => runProcesses()
    if (!processInfo) processInfo = async (pid) => {
      const list = await runProcesses(pid)
      return list ? { ok: true, proc: list.find((p) => p.pid === pid) } : { ok: false }
    }
  }
  if (!processInfo) processInfo = async (pid) => {
    const list = await processes()
    return list ? { ok: true, proc: list.find((p) => p.pid === pid) } : { ok: false }
  }
  let cache = null // { at, raw, procs }
  let inFlight = null

  function startScan() {
    const run = (async () => {
      const [raw, procs] = await Promise.all([listeners(), processes()])
      if (!raw) throw new Error(t('main.ports.listFailed', 'Could not list the listening ports.'))
      cache = { at: now(), raw, procs: procs || [] }
      return cache
    })()
    inFlight = run
    const clear = () => {
      if (inFlight === run) inFlight = null
    }
    run.then(clear, clear)
    return run
  }

  // Until no scan started earlier is still running.
  async function settled() {
    while (inFlight) await inFlight.catch(() => {})
  }

  // fresh: a listing started after this call (never one already running).
  async function snapshot(fresh = false) {
    if (!fresh) {
      if (cache && now() - cache.at < ttlMs) return cache
      if (inFlight) return inFlight
      return startScan()
    }
    await settled()
    return startScan()
  }

  // probes: [{ id, pids, path }] -> { ok, platform, scannedAt, ports: { [id]: [port] }, external: [port] }
  async function scan({ probes } = {}, opts = {}) {
    const list = sanitizeProbes(probes)
    try {
      const snap = await snapshot(!!opts.fresh)
      const { byProbe, external } = attributePorts(snap.raw, snap.procs, list)
      return { ok: true, platform: process.platform, scannedAt: snap.at, ports: byProbe, external }
    } catch (e) {
      return { ok: false, platform: process.platform, scannedAt: now(), ports: {}, external: [], unavailableReason: e.message }
    }
  }

  const refuse = (reason) => ({ ok: false, reason })
  const attempt = (fn, fallback) => Promise.resolve().then(fn).catch(() => fallback)

  // Orca's killWorkspacePort, stricter: its own listing, started after the
  // request, proves that this very process (pid, creation time, name) owns
  // that port in one of the copies and is not Tessel's; it is checked again
  // right before it is stopped, then only that pid is stopped (not its
  // tree: Windows keeps dead parents' pids, so a tree walk can reach
  // unrelated processes; a dev server's own helpers end with it).
  // -> { ok: true } | { ok: true, alreadyExited: true } | { ok: false, reason }
  async function kill({ probes, pid, port } = {}, opts = {}) {
    const { killer = (p) => process.kill(p), selfPids = [process.pid], terminalHostPids = [], selfExe = process.execPath, appRoots = [] } = opts
    if (!Number.isSafeInteger(pid) || pid <= 0 || !validPort(port)) return refuse(t('main.ports.invalid', 'Invalid process or port.'))
    const list = sanitizeProbes(probes)
    await settled()
    const procsLater = attempt(processes, null)
    const raw = await attempt(listeners, null)
    if (!raw) return refuse(t('main.ports.listFailedNothing', 'Could not list the listening ports, so nothing was stopped.'))
    if (!raw.some((r) => r.pid === pid && r.port === port)) return refuse(t('main.ports.notListening', 'The port is no longer listening.'))
    const procs = await procsLater
    if (!Array.isArray(procs)) return refuse(t('main.ports.processesFailed', 'Could not list the processes, so nothing was stopped.'))
    const byPid = new Map(procs.map((p) => [p.pid, p]))
    const target = byPid.get(pid)
    if (!target) return refuse(t('main.ports.processNotFound', 'Could not find that process, so nothing was stopped.'))
    const inCopy = Object.values(attributePorts(raw, procs, list).byProbe)
      .flat()
      .some((p) => p.pid === pid && p.port === port)
    if (!inCopy) return refuse(t('main.ports.notWorkspace', 'That port does not belong to a workspace, so nothing was stopped.'))
    const shellPids = list.flatMap((p) => p.pids)
    if (isTesselProcess(target, byPid, { selfPids, terminalHostPids, shellPids, selfExe, appRoots }))
      return refuse(t('main.ports.ownProcess', 'Tessel cannot stop its own process.'))
    if (!target.created || !target.name) return refuse(t('main.ports.unidentified', 'Could not identify that process, so nothing was stopped.'))

    // Right before stopping it: the same process, still on that port.
    const [again, info] = await Promise.all([attempt(listeners, null), attempt(() => processInfo(pid), null)])
    if (!again || !info || !info.ok) return refuse(t('main.ports.recheckFailed', 'Could not check the process again, so nothing was stopped.'))
    if (!info.proc) return refuse(t('main.ports.alreadyExited', 'The process has already exited.'))
    if (!sameProcess(info.proc, target)) return refuse(t('main.ports.pidReused', 'That process id now belongs to another process, so nothing was stopped.'))
    if (!again.some((r) => r.pid === pid && r.port === port)) return refuse(t('main.ports.notListening', 'The port is no longer listening.'))

    cache = null
    try {
      killer(pid)
    } catch (e) {
      if (e && e.code === 'ESRCH') return { ok: true, alreadyExited: true }
      if (e && e.code === 'EPERM') return refuse(t('main.ports.accessDenied', 'Access denied: the system would not let Tessel stop that process.'))
      return refuse((e && e.message) || t('main.ports.stopFailed', 'Failed to stop the process.'))
    }
    // Stopping is asynchronous: say it stopped only once it is gone.
    let unsure = false
    for (let i = 0; i < 15; i++) {
      const res = await attempt(() => processInfo(pid), null)
      if (res && res.ok) {
        if (!res.proc || !sameProcess(res.proc, target)) return { ok: true }
        unsure = false
      } else unsure = true
      await sleep(200)
    }
    return refuse(
      unsure ? t('main.ports.unconfirmed', 'Stop was requested, but Tessel could not confirm that the process exited.') : t('main.ports.stillRunning', 'Stop was requested, but the process is still running.')
    )
  }

  return { scan, kill }
}

export function sanitizeProbes(probes) {
  if (!Array.isArray(probes)) return []
  return probes.slice(0, 500).flatMap((p) => {
    if (!p || typeof p.id !== 'string' || p.id.length > 1000) return []
    const pids = Array.isArray(p.pids) ? p.pids.filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 200) : []
    const dir = typeof p.path === 'string' && p.path.length < 4000 ? p.path : null
    return [{ id: p.id, pids, path: dir }]
  })
}
