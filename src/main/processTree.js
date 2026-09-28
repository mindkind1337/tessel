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
import { execFile } from 'child_process'

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
