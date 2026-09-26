// Which agent CLI runs inside a shell pane (started by hand: `claude` typed in
// PowerShell, say), from the processes under the pane's shell. One process
// list per call, read with CIM (Windows) or ps (elsewhere).
import { execFile } from 'child_process'

// The first rule that matches a process (its name or command line) names it.
const RULES = [
  { id: 'claude', re: /(^|[\\/])claude(\.exe)?$|@anthropic-ai[\\/]claude-code/i },
  { id: 'codex', re: /(^|[\\/])codex(\.exe)?$|@openai[\\/]codex/i },
  { id: 'gemini', re: /@google[\\/]gemini-cli|(^|[\\/])gemini(\.exe)?$/i },
  { id: 'qwen', re: /@qwen-code[\\/]|(^|[\\/])qwen(\.exe)?$/i },
  { id: 'opencode', re: /opencode-ai|(^|[\\/])opencode(\.exe)?$/i },
  { id: 'copilot', re: /@github[\\/]copilot|(^|[\\/])copilot(\.exe)?$/i },
  { id: 'cline', re: /@cline[\\/]cli-|(^|[\\/])cline(\.exe)?$/i },
  { id: 'amp', re: /@sourcegraph[\\/]amp|(^|[\\/])amp(\.exe)?$/i },
  { id: 'aider', re: /(^|[\\/])aider(\.exe)?$/i }
]

export function agentOf(proc) {
  const name = String(proc.name || '')
  const cmd = String(proc.cmd || '')
  // The program itself, then (for node / an npm shim) the script it runs:
  // only the first two words, never the arguments ("git commit -m 'ask
  // claude'" is not Claude).
  const words = [name]
  const re = /"([^"]*)"|(\S+)/g
  let m
  while (words.length < 3 && (m = re.exec(cmd))) words.push(m[1] !== undefined ? m[1] : m[2])
  for (const r of RULES) if (words.some((w) => r.re.test(w))) return r.id
  return null
}

// procs: [{ pid, ppid, name, cmd }]; shells: { paneId: shellPid }.
// -> { paneId: agentId | null } — the nearest agent under each shell.
export function agentsUnderShells(procs, shells) {
  const children = new Map()
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, [])
    children.get(p.ppid).push(p)
  }
  const out = {}
  for (const [paneId, pid] of Object.entries(shells || {})) {
    out[paneId] = null
    if (!Number.isInteger(pid)) continue
    // Breadth first: the agent closest to the shell (not a tool it runs).
    let level = children.get(pid) || []
    for (let depth = 0; depth < 6 && level.length && !out[paneId]; depth++) {
      for (const p of level) {
        const a = agentOf(p)
        if (a) {
          out[paneId] = a
          break
        }
      }
      level = level.flatMap((p) => children.get(p.pid) || [])
    }
  }
  return out
}

function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const script =
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)" }'
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve(null)
          resolve(
            String(stdout)
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => {
                const [pid, ppid, name, ...cmd] = line.split('\t')
                return { pid: Number(pid), ppid: Number(ppid), name, cmd: cmd.join('\t') }
              })
          )
        }
      )
    } else {
      execFile('ps', ['-eo', 'pid=,ppid=,comm=,args='], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null)
        resolve(
          String(stdout)
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line)
              return m ? { pid: Number(m[1]), ppid: Number(m[2]), name: m[3], cmd: m[4] } : null
            })
            .filter(Boolean)
        )
      })
    }
  })
}

// shells: { paneId: shellPid } -> { ok, agents: { paneId: agentId | null } }
export async function detectAgents({ shells } = {}) {
  if (!shells || typeof shells !== 'object') return { ok: false, error: 'No panes.' }
  const procs = await listProcesses()
  if (!procs) return { ok: false, error: 'Could not list the processes.' }
  return { ok: true, agents: agentsUnderShells(procs, shells) }
}
