// Memory and CPU of Tessel and its terminals, for the status bar's Resource
// Manager, ported from Orca's src/main/memory/collector.ts (MIT, Copyright
// (c) 2026 Lovecast Inc.): one host-wide process sweep (working set on
// Windows, RSS elsewhere), Tessel's own processes from app.getAppMetrics()
// (main, renderers, other), and every terminal's whole process tree, each
// process counted once.
import { execFile } from 'child_process'

// -> [{ pid, ppid, memory (bytes), privateMemory (bytes|undefined), ticks (100 ns, Windows) | pcpu }]
export function parseCimProcesses(stdout) {
  const out = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const [pid, ppid, ws, kernel, user, pageFile] = line.split('\t')
    const p = Number(pid)
    if (!Number.isInteger(p)) continue
    out.push({
      pid: p,
      ppid: Number(ppid) || 0,
      memory: Number(ws) || 0,
      privateMemory: Number.isFinite(Number(pageFile)) && pageFile !== '' ? Number(pageFile) * 1024 : undefined,
      ticks: (Number(kernel) || 0) + (Number(user) || 0)
    })
  }
  return out
}

export function parsePsProcesses(stdout) {
  const out = []
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)/.exec(line)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pcpu: Number(m[3]), memory: Number(m[4]) * 1024 })
  }
  return out
}

function sweep() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const script =
        'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,PageFileUsage | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.WorkingSetSize)`t$($_.KernelModeTime)`t$($_.UserModeTime)`t$($_.PageFileUsage)" }'
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
        resolve(err ? null : parseCimProcesses(stdout))
      )
    } else {
      execFile('ps', ['-eo', 'pid=,ppid=,pcpu=,rss='], { timeout: 15000, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) =>
        resolve(err ? null : parsePsProcesses(stdout))
      )
    }
  })
}

// Orca's collectSubtree: a process and all its descendants, none claimed twice.
export function collectSubtree(rootPid, childrenOf, claimed) {
  const out = []
  const stack = [rootPid]
  while (stack.length) {
    const pid = stack.pop()
    if (claimed.has(pid)) continue
    claimed.add(pid)
    out.push(pid)
    for (const c of childrenOf.get(pid) || []) stack.push(c)
  }
  return out
}

const sum = (list, f) => list.reduce((n, x) => n + (f(x) || 0), 0)

// procs: the sweep; appMetrics: app.getAppMetrics(); ptys: [{ id, pid }];
// hostPids: the terminal host; cpuOf(proc) -> percent.
export function buildSnapshot({ procs, appMetrics = [], ptys = [], hostPids = [], cpuOf = () => 0, platform = process.platform }) {
  const byPid = new Map()
  const childrenOf = new Map()
  for (const p of procs || []) {
    byPid.set(p.pid, p)
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, [])
    childrenOf.get(p.ppid).push(p.pid)
  }
  const claimed = new Set()
  const bucket = () => ({ memory: 0, cpu: 0, privateMemory: 0 })
  const app = { main: bucket(), renderer: bucket(), other: bucket() }
  let hasPrivate = false
  const addTo = (b, pid, fallback) => {
    const p = byPid.get(pid)
    b.memory += p ? p.memory : fallback?.memory || 0
    b.cpu += p ? cpuOf(p) : fallback?.cpu || 0
    if (p && p.privateMemory !== undefined) {
      b.privateMemory += p.privateMemory
      hasPrivate = true
    }
  }
  for (const m of appMetrics) {
    if (!m || !Number.isInteger(m.pid) || claimed.has(m.pid)) continue
    claimed.add(m.pid)
    const b = m.type === 'Browser' || m.type === 'browser' ? app.main : m.type === 'Tab' || m.type === 'renderer' || m.type === 'tab' ? app.renderer : app.other
    addTo(b, m.pid, { memory: (m.memory?.workingSetSize || 0) * 1024, cpu: m.cpu?.percentCPUUsage || 0 })
  }
  // The terminal host itself is Tessel's (not its terminals: those follow).
  for (const pid of hostPids) {
    if (claimed.has(pid) || !byPid.has(pid)) continue
    claimed.add(pid)
    addTo(app.other, pid)
  }
  const sessions = {}
  for (const t of ptys) {
    if (!t || !Number.isInteger(t.pid) || !byPid.has(t.pid)) continue
    const b = bucket()
    const pids = collectSubtree(t.pid, childrenOf, claimed)
    for (const pid of pids) addTo(b, pid)
    sessions[t.id] = { ...b, processCount: pids.length }
  }
  const appTotal = {
    memory: app.main.memory + app.renderer.memory + app.other.memory,
    cpu: app.main.cpu + app.renderer.cpu + app.other.cpu,
    privateMemory: app.main.privateMemory + app.renderer.privateMemory + app.other.privateMemory
  }
  const list = Object.values(sessions)
  return {
    app: { ...app, total: appTotal },
    sessions,
    totalMemory: appTotal.memory + sum(list, (s) => s.memory),
    totalCpu: appTotal.cpu + sum(list, (s) => s.cpu),
    totalPrivateMemory: hasPrivate ? appTotal.privateMemory + sum(list, (s) => s.privateMemory) : undefined,
    processMemoryMetric: platform === 'win32' ? 'working-set' : 'rss'
  }
}

export function createResourceCollector({ sweepFn = sweep, now = () => Date.now(), cpuCount = 1 } = {}) {
  let prev = new Map() // pid -> { ticks, at }
  let inFlight = null

  async function snapshot({ appMetrics = [], ptys = [], hostPids = [] } = {}) {
    if (inFlight) return inFlight
    inFlight = (async () => {
      const procs = await sweepFn()
      if (!procs) return { ok: false, error: 'Could not list the processes.' }
      const at = now()
      const next = new Map()
      // Windows: CPU from tick deltas between two sweeps (as Orca); ps gives %.
      const cpuOf = (p) => {
        if (p.pcpu !== undefined) return p.pcpu
        const was = prev.get(p.pid)
        if (!was || at <= was.at || p.ticks < was.ticks) return 0
        return ((p.ticks - was.ticks) / 1e4 / (at - was.at)) * 100
      }
      for (const p of procs) if (p.ticks !== undefined) next.set(p.pid, { ticks: p.ticks, at })
      const snap = buildSnapshot({ procs, appMetrics, ptys, hostPids, cpuOf })
      prev = next
      return { ok: true, at, cpuCount, ...snap }
    })()
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  return { snapshot }
}
