// Live ports of each workspace copy, like Orca's "Live Ports" (ported from
// Orca's src/main/ports/local-workspace-platform-port-scanner.ts,
// local-workspace-port-address.ts, local-workspace-port-attribution.ts and
// workspace-port-ownership.ts; Orca is MIT, Copyright (c) 2026 Lovecast Inc.).
//
// One scan = one listener listing (`netstat -ano -p tcp` on Windows, like
// Orca; `lsof` elsewhere) + one process listing (the same one agent
// detection uses). A listener belongs to a copy when its process runs under
// one of the copy's pane shells (Tessel knows each pane's shell pid), else,
// like Orca, when its command line names the copy's folder.
import { execFile } from 'child_process'
import path from 'path'
import os from 'os'
import { listProcesses } from './agentDetect'

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
  const bracketed = trimmed.match(/^\[([^\]]+)\]:(\d+)$/)
  if (bracketed) return { host: bracketed[1], port: Number.parseInt(bracketed[2], 10) }
  const match = trimmed.match(/^(.+):(\d+)$/)
  if (!match) return null
  const port = Number.parseInt(match[2], 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
  return { host: match[1], port }
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

// Scans share their raw data for a few seconds (the sidebar and the status
// bar ask at the same time); one listing each at most.
export function createPortScanner({ listeners = runListeners, processes = listProcesses, now = () => Date.now(), ttlMs = 4000 } = {}) {
  let cache = null // { at, raw, procs }
  let inFlight = null

  async function snapshot(fresh = false) {
    if (!fresh && cache && now() - cache.at < ttlMs) return cache
    if (inFlight) return inFlight
    inFlight = (async () => {
      const [raw, procs] = await Promise.all([listeners(), processes()])
      if (!raw) throw new Error('Could not list the listening ports.')
      cache = { at: now(), raw, procs: procs || [] }
      return cache
    })()
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
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

  // Orca's killWorkspacePort: a fresh scan proves the pid still owns that
  // port in one of the copies before it is stopped.
  async function kill({ probes, pid, port } = {}, { killer = (p) => process.kill(p, 'SIGTERM'), selfPids = [process.pid] } = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(port)) return { ok: false, reason: 'Invalid process or port.' }
    const res = await scan({ probes }, { fresh: true })
    if (!res.ok) return { ok: false, reason: res.unavailableReason || 'Workspace port scan failed.' }
    const found = Object.values(res.ports)
      .flat()
      .find((p) => p.pid === pid && p.port === port)
    if (!found) return { ok: false, reason: 'The port is no longer listening.' }
    if (selfPids.includes(pid) || found.processName === 'Electron' || /^tessel(\.exe)?$/i.test(found.processName || ''))
      return { ok: false, reason: 'Tessel cannot stop its own process.' }
    try {
      killer(pid)
      cache = null
      return { ok: true }
    } catch (e) {
      if (e && e.code === 'ESRCH') return { ok: true }
      return { ok: false, reason: (e && e.message) || 'Failed to stop the process.' }
    }
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
