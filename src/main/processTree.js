// Waiting for the real end of a terminal's processes (its shell and every
// program started under it), used before an agent update retries an install
// whose files those programs held.
//
// Why not the terminal host's word: it forgets a terminal as soon as it is
// asked to stop it, and on ConPTY force-kills it only 1.5 s later; node-pty's
// exit event only covers the shell, and a program started under it (the
// agent CLI, its node child) can outlive the shell and keep its files open.
// So the whole tree is recorded before the stop (each process by PID and
// creation time: a PID Windows reuses for another program is never taken for
// the old one), and then each is checked until it is really gone.
// Programs are started from a worker thread (spawnOffThread.js): a start
// blocks the thread that makes it, seconds on a busy PC.
import { execFileOff as execFile, spawnOff as spawn } from './spawnOffThread'

// -> [{ pid, ppid, created }] (created: creation time, a number comparable
// between two listings; null when unknown), or null when it cannot list.
export function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const script =
        'Get-CimInstance Win32_Process | ForEach-Object { $c = 0; if ($_.CreationDate) { $c = $_.CreationDate.ToFileTimeUtc() }; "$($_.ProcessId) $($_.ParentProcessId) $c" }'
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve(null)
          resolve(
            String(stdout)
              .split(/\r?\n/)
              .map((line) => line.trim().split(/\s+/).map(Number))
              .filter((f) => f.length === 3 && f.every(Number.isFinite))
              .map(([pid, ppid, created]) => ({ pid, ppid, created: created || null }))
          )
        }
      )
    } else {
      execFile('ps', ['-eo', 'pid=,ppid=,lstart='], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null)
        resolve(
          String(stdout)
            .split('\n')
            .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
            .filter(Boolean)
            .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), created: Date.parse(m[3]) || null }))
        )
      })
    }
  })
}

// The processes of these trees: the roots and everything started under them.
// roots: [{ pid, created? }] (created given: only the process started then).
// A child counts only if it started after its parent: Windows keeps the PID
// of a dead parent, which a newer unrelated process may have taken since.
// -> [{ pid, created }]
export function treeOf(procs, roots) {
  const byPid = new Map()
  const children = new Map()
  for (const p of Array.isArray(procs) ? procs : []) {
    byPid.set(p.pid, p)
    if (p.ppid === p.pid) continue
    if (!children.has(p.ppid)) children.set(p.ppid, [])
    children.get(p.ppid).push(p)
  }
  const out = new Map()
  const queue = []
  for (const r of roots || []) {
    const p = byPid.get(r.pid)
    if (!p) continue
    if (r.created && p.created && r.created !== p.created) continue // another program now
    if (!out.has(p.pid)) {
      out.set(p.pid, { pid: p.pid, created: p.created || null })
      queue.push(p)
    }
  }
  while (queue.length) {
    const parent = queue.shift()
    for (const c of children.get(parent.pid) || []) {
      if (out.has(c.pid)) continue
      if (parent.created && c.created && c.created < parent.created) continue
      out.set(c.pid, { pid: c.pid, created: c.created || null })
      queue.push(c)
    }
  }
  return [...out.values()]
}

// Whether a PID runs (any program: the creation time is checked by `verify`).
export function pidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM' // runs, but not ours to signal
  }
}

// Of these processes, those still running as the same program (same PID and
// creation time), plus any started under them since. A listing that fails
// keeps them all (never taken for gone without proof).
export async function stillRunning(entries, list = listProcesses) {
  if (!entries.length) return []
  const procs = await list()
  if (!procs) return entries
  return treeOf(procs, entries)
}

// Wait until every process in `entries` has ended.
//   alive(entries) -> those still running (cheap check, may keep a PID
//     another program took since)
//   verify(entries) -> those really still running (exact, slower)
//   force(entries): end them (called once, after forceAfterMs)
// -> { ok: true } when all ended, else { ok: false, left } at timeoutMs.
export async function waitForExit({
  entries,
  alive = async (list) => list.filter((e) => pidRunning(e.pid)),
  verify = stillRunning,
  force = null,
  timeoutMs = 15000,
  intervalMs = 250,
  forceAfterMs = 3000,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
}) {
  let left = Array.isArray(entries) ? entries : []
  const start = now()
  let forced = !force
  for (;;) {
    left = await alive(left)
    if (!left.length) return { ok: true, left: [] }
    const spent = now() - start
    if (spent >= timeoutMs) {
      left = await verify(left)
      return left.length ? { ok: false, left } : { ok: true, left: [] }
    }
    if (!forced && spent >= forceAfterMs) {
      forced = true
      left = await verify(left)
      if (!left.length) return { ok: true, left: [] }
      await force(left)
    }
    await sleep(intervalMs)
  }
}

// End these processes (already checked to be the ones recorded).
export function killPids(entries) {
  for (const e of entries) {
    try {
      process.kill(e.pid, 'SIGKILL')
    } catch {
      /* gone meanwhile */
    }
  }
}

// -> [{ pid, ppid, name }] of every process, or null when it cannot list.
// --- The process list from a PowerShell kept open (Windows) ----------------------
// Closing a terminal (Settings' "Confirm before closing running terminals")
// and an agent's terminal commands asked Windows for its processes by
// starting a new PowerShell and querying WMI each time: about a second, a few
// when the PC is busy, and the pane waited before it closed. One PowerShell
// is kept open instead (closed after a quarter of an hour unused), reading
// Windows' process snapshot (CreateToolhelp32Snapshot): a few milliseconds a
// list. If it cannot start or answer, the one-time query is used.
const SNAPSHOT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class TesselProcs {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PE { public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint f, uint p);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string List() {
    var sb = new StringBuilder();
    IntPtr h = CreateToolhelp32Snapshot(2, 0);
    if (h == (IntPtr)(-1)) return "";
    try {
      var e = new PE(); e.dwSize = (uint)Marshal.SizeOf(typeof(PE));
      if (Process32FirstW(h, ref e)) { do { sb.Append(e.th32ProcessID).Append('\t').Append(e.th32ParentProcessID).Append('\t').Append(e.szExeFile).Append('\n'); } while (Process32NextW(h, ref e)); }
    } finally { CloseHandle(h); }
    return sb.ToString();
  }
}
'@
[Console]::Out.WriteLine('__TESSEL_READY__'); [Console]::Out.Flush()
while ($null -ne ($l = [Console]::In.ReadLine())) {
  if ($l -eq 'list') { [Console]::Out.Write([TesselProcs]::List()); [Console]::Out.WriteLine('__TESSEL_END__'); [Console]::Out.Flush() }
}
`
const READY = '__TESSEL_READY__'
const END = '__TESSEL_END__'

// -> { list(): Promise<[{ pid, ppid, name }] | null>, stop() }. One list at a
// time (the next waits for the one before); the PowerShell is started on the
// first list, and closed after idleMs unused, on a timeout or when stopped.
export function createSnapshotWorker({ spawnImpl = spawn, idleMs = 15 * 60 * 1000, startMs = 15000, answerMs = 5000 } = {}) {
  let child = null
  let buf = ''
  let waiter = null // { marker, resolve, timer }
  let started = null // Promise<boolean>
  let idle = null
  let chain = Promise.resolve()

  function stop() {
    clearTimeout(idle)
    idle = null
    const c = child
    child = null
    started = null
    buf = ''
    if (waiter) {
      clearTimeout(waiter.timer)
      const w = waiter
      waiter = null
      w.resolve(null)
    }
    if (c) {
      try {
        c.stdin.end()
      } catch {
        /* closed */
      }
      try {
        c.kill()
      } catch {
        /* gone */
      }
    }
  }
  // The next `marker` line's text before it, or null after ms.
  function until(marker, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (waiter && waiter.resolve === resolve) waiter = null
        resolve(null)
        stop()
      }, ms)
      waiter = { marker, resolve, timer }
      take()
    })
  }
  function take() {
    if (!waiter) return
    const i = buf.indexOf(waiter.marker)
    if (i < 0) return
    const text = buf.slice(0, i)
    const nl = buf.indexOf('\n', i)
    buf = nl < 0 ? '' : buf.slice(nl + 1)
    clearTimeout(waiter.timer)
    const w = waiter
    waiter = null
    w.resolve(text)
  }
  function start() {
    if (started) return started
    try {
      const encoded = Buffer.from(SNAPSHOT_SCRIPT, 'utf16le').toString('base64')
      child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      child = null
      return Promise.resolve(false)
    }
    const me = child
    me.stdout.setEncoding?.('utf8')
    me.stdout.on('data', (d) => {
      if (child !== me) return
      buf += String(d)
      take()
    })
    me.stdin.on?.('error', () => child === me && stop())
    me.on('error', () => child === me && stop())
    me.on('exit', () => child === me && stop())
    started = until(READY, startMs).then((t) => t !== null)
    return started
  }
  async function listOnce() {
    if (!(await start()) || !child) return null
    const p = until(END, answerMs)
    try {
      child.stdin.write('list\n')
    } catch {
      stop()
      return null
    }
    const text = await p
    clearTimeout(idle)
    idle = setTimeout(stop, idleMs)
    idle.unref?.()
    if (text === null) return null
    const procs = parseProcessNames(text)
    return procs.length ? procs : null
  }
  function list() {
    const run = chain.then(listOnce, listOnce)
    chain = run.catch(() => null)
    return run
  }
  return { list, stop }
}
let snapshotWorker = null
// Tessel quitting: the PowerShell kept open closes.
export function stopProcessSnapshots() {
  if (snapshotWorker) snapshotWorker.stop()
}

export async function listProcessNames() {
  if (process.platform === 'win32') {
    if (!snapshotWorker) snapshotWorker = createSnapshotWorker()
    const procs = await snapshotWorker.list().catch(() => null)
    if (procs) return procs
  }
  return listProcessNamesOnce()
}
// The one-time query (WMI on Windows, ps elsewhere).
function listProcessNamesOnce() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      execFile('ps', ['-eo', 'pid=,ppid=,comm='], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null)
        resolve(
          String(stdout)
            .split('\n')
            .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
            .filter(Boolean)
            .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3].trim().split('/').pop() }))
        )
      })
      return
    }
    const script =
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)" }'
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : parseProcessNames(stdout))
    )
  })
}

// "pid<TAB>ppid<TAB>name" lines -> [{ pid, ppid, name }].
export function parseProcessNames(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((f) => f.length >= 3 && /^\d+$/.test(f[0].trim()) && /^\d+$/.test(f[1].trim()))
    .map(([pid, ppid, ...name]) => ({ pid: Number(pid), ppid: Number(ppid), name: name.join('\t').trim() }))
}

// Helpers of the console itself, never "a program you run".
const CONSOLE_HELPERS = /^(conhost|openconsole|wslhost|winpty-agent)(\.exe)?$/i

// The programs running under a terminal's shell (Orca's "running terminal"
// check before closing it): the shell's children, minus console helpers. A
// launcher that starts the real shell under the same name (Git Bash's
// bin\bash.exe runs usr\bin\bash.exe) is looked through.
// -> [names] (empty: the shell is idle).
export function runningWork(procs, rootPid) {
  const list = Array.isArray(procs) ? procs : []
  const byParent = new Map()
  for (const p of list) {
    if (p.pid === p.ppid) continue
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, [])
    byParent.get(p.ppid).push(p)
  }
  const root = list.find((p) => p.pid === rootPid)
  let shell = root || { pid: rootPid, name: '' }
  for (let depth = 0; depth < 4; depth++) {
    const kids = (byParent.get(shell.pid) || []).filter((c) => !CONSOLE_HELPERS.test(c.name))
    if (kids.length === 1 && shell.name && kids[0].name.toLowerCase() === shell.name.toLowerCase()) {
      shell = kids[0]
      continue
    }
    return kids.map((c) => c.name)
  }
  return []
}
