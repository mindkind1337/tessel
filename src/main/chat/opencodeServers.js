// The `opencode serve` processes the chat panes started, recorded by PID in
// a file of Tessel's (userData). `serve` never exits on its own: when Tessel
// crashes (no close, no quit), its servers would stay. At the next start,
// each recorded PID still running is stopped, but only when it still is
// OpenCode's server Tessel started: the image is opencode.exe AND its command
// line is `serve … --hostname 127.0.0.1` (a PID Windows gave to another
// program since is left alone). Never by image name alone.
import fs from 'fs'
import { dirname } from 'path'
import { execFile } from 'child_process'

const MAX = 256

function readPids(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(data?.pids) ? data.pids.filter((p) => Number.isSafeInteger(p) && p > 0).slice(0, MAX) : []
  } catch {
    return []
  }
}
function writePids(file, pids) {
  try {
    fs.mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, pids: [...new Set(pids)].slice(-MAX) }))
    fs.renameSync(tmp, file)
  } catch {
    /* a safety net only: the chat still runs */
  }
}

// -> { add(pid), remove(pid), list() }
export function createServerPidFile({ file }) {
  return {
    add: (pid) => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return
      writePids(file, [...readPids(file), pid])
    },
    remove: (pid) => {
      const left = readPids(file).filter((p) => p !== pid)
      writePids(file, left)
    },
    list: () => readPids(file)
  }
}

// Is this process one of our servers? name: its image name, commandLine: its
// command line (Win32_Process).
export function isOurServer({ name, commandLine } = {}) {
  if (typeof name !== 'string' || !/^opencode(\.exe)?$/i.test(name.trim())) return false
  const cmd = typeof commandLine === 'string' ? commandLine : ''
  return /(^|\s|")serve(\s|$)/.test(cmd) && /--hostname\s+127\.0\.0\.1(\s|$)/.test(cmd) && /--port\s+0(\s|$)/.test(cmd)
}

// pids -> [{ pid, name, commandLine }] of those still running (Windows).
export function describeProcesses(pids) {
  return new Promise((resolve) => {
    const list = (pids || []).filter((p) => Number.isSafeInteger(p) && p > 0)
    if (!list.length || process.platform !== 'win32') return resolve([])
    const filter = list.map((p) => `ProcessId=${p}`).join(' OR ')
    const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; commandLine = [string]$_.CommandLine } } | ConvertTo-Json -Compress`
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([])
      try {
        const data = JSON.parse(String(stdout).trim() || '[]')
        resolve((Array.isArray(data) ? data : [data]).filter((d) => d && Number.isSafeInteger(d.pid)))
      } catch {
        resolve([])
      }
    })
  })
}

// Its process tree, by PID.
export function killTreeByPid(pid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone */
      }
      return resolve()
    }
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, () => resolve())
  })
}

// At start: the servers a crashed Tessel left. -> the PIDs stopped.
export async function reapOpencodeServers({ file, describe = describeProcesses, kill = killTreeByPid, log = null } = {}) {
  const recorded = readPids(file)
  if (!recorded.length) return []
  let found = []
  try {
    found = await describe(recorded)
  } catch {
    found = []
  }
  const stopped = []
  for (const p of found) {
    if (!recorded.includes(p.pid) || !isOurServer(p)) {
      try {
        log?.info?.('chat', `opencode leftover ${p.pid} is not our server: left alone`)
      } catch {
        /* logging only */
      }
      continue
    }
    await kill(p.pid)
    stopped.push(p.pid)
  }
  // Only what was read here: a chat started meanwhile keeps its record.
  writePids(file, readPids(file).filter((p) => !recorded.includes(p)))
  return stopped
}
