// Which agent CLI runs inside a shell pane (started by hand: `claude` typed in
// PowerShell, say), from the processes under the pane's shell. One process
// list per call, read with CIM (Windows) or ps (elsewhere).
import { execFile } from 'child_process'

// Executable names and runtime entrypoints are separate: an agent name in a
// prompt or another program's arguments is not an agent process.
const RULES = [
  {
    id: 'claude',
    re: /(^|[\\/])claude(\.exe)?$/i,
    script: /(^|[\\/])@anthropic-ai[\\/]claude-code[\\/]/i
  },
  { id: 'codex', re: /(^|[\\/])codex(\.exe)?$/i, script: /(^|[\\/])@openai[\\/]codex[\\/]/i },
  {
    id: 'gemini',
    re: /(^|[\\/])gemini(\.exe)?$/i,
    script: /(^|[\\/])@google[\\/]gemini-cli[\\/]/i
  },
  { id: 'qwen', re: /(^|[\\/])qwen(\.exe)?$/i, script: /(^|[\\/])@qwen-code[\\/]qwen-code[\\/]/i },
  { id: 'opencode', re: /(^|[\\/])opencode(\.exe)?$/i, script: /(^|[\\/])opencode-ai[\\/]/i },
  { id: 'copilot', re: /(^|[\\/])copilot(\.exe)?$/i, script: /(^|[\\/])@github[\\/]copilot[\\/]/i },
  {
    id: 'cline',
    re: /(^|[\\/])cline(\.exe)?$/i,
    script: /(^|[\\/])cline[\\/]bin[\\/]cline$|(^|[\\/])@cline[\\/]cli-[^\\/]+[\\/]/i
  },
  {
    id: 'amp',
    re: /(^|[\\/])amp(\.exe)?$/i,
    script:
      /(^|[\\/])@sourcegraph[\\/]amp[\\/]|(^|[\\/])@ampcode[\\/]cli[\\/]bin[\\/]amp(?:\.exe)?$/i
  },
  // Both Cursor and Grok ship an `agent.exe` alias. Only their distinctive
  // install paths identify that alias; Cursor.exe is the editor, not the CLI.
  {
    id: 'cursor',
    re: /(^|[\\/])cursor-agent(\.exe)?$|[\\/]cursor-agent[\\/](?:versions[\\/][^\\/]+[\\/])?agent(\.exe)?$/i
  },
  { id: 'grok', re: /(^|[\\/])grok(\.exe)?$|[\\/]\.grok[\\/]bin[\\/]agent(\.exe)?$/i },
  {
    id: 'pi',
    re: /(^|[\\/])pi(\.exe)?$/i,
    script:
      /(^|[\\/])@(?:mariozechner|earendil-works)[\\/]pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js$/i
  },
  {
    id: 'droid',
    re: /(^|[\\/])droid(\.exe)?$/i,
    script: /(^|[\\/])@factory[\\/]cli[\\/]bin[\\/]droid(?:\.exe)?$/i
  },
  {
    id: 'crush',
    re: /(^|[\\/])crush(\.exe)?$/i,
    script: /(^|[\\/])@charmland[\\/]crush[\\/]run-crush\.js$/i
  },
  { id: 'goose', re: /(^|[\\/])goose(\.exe)?$/i },
  {
    id: 'auggie',
    re: /(^|[\\/])auggie(\.exe)?$/i,
    script: /(^|[\\/])@augmentcode[\\/]auggie[\\/]augment\.mjs$/i
  },
  { id: 'kimi', re: /(^|[\\/])kimi(\.exe)?$/i },
  { id: 'aider', re: /(^|[\\/])aider(\.exe)?$/i }
]

export function agentOf(proc) {
  const name = String(proc.name || '')
  const cmd = String(proc.cmd || '')
  // Read only the executable and its first argument. A runtime's first
  // argument may be its script; flags, eval text and later arguments are not.
  const words = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while (words.length < 2 && (m = re.exec(cmd))) words.push(m[1] ?? m[2] ?? m[3])
  const executables = [name, words[0] || '']
  const runtime = /(^|[\\/])(?:node|nodejs|bun)(\.exe)?$/i.test(name || words[0] || '')
  const script = runtime && words[1] && !words[1].startsWith('-') ? words[1] : ''
  for (const r of RULES) {
    if (executables.some((w) => r.re.test(w)) || (script && r.script?.test(script))) return r.id
  }
  // Ollama: its menu (no arguments), a chat (run) or an agent it starts
  // (launch); not the server or a list.
  if (executables.some((w) => /(^|[\\/])ollama(\.exe)?$/i.test(w))) {
    const sub = words[1]
    if (!sub || sub === 'run' || sub === 'launch') return 'ollama'
  }
  return null
}

// procs: [{ pid, ppid, name, cmd }]; shells: { paneId: shellPid }.
// -> { paneId: agentId | null } — the nearest agent under each shell.
// commands (optional, filled): { paneId: its command line } (the model
// may be written in it). Ollama starting an agent (ollama launch claude):
// that agent, with Ollama's command line too.
export function agentsUnderShells(procs, shells, commands = {}) {
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
          commands[paneId] = String(p.cmd || '').replace(/\t/g, ' ')
          if (a === 'ollama') {
            const inner = agentBelow(p.pid, children)
            if (inner) {
              out[paneId] = inner.id
              commands[paneId] =
                String(inner.cmd || '').replace(/\t/g, ' ') + ' ' + commands[paneId]
            }
          }
          break
        }
      }
      level = level.flatMap((p) => children.get(p.pid) || [])
    }
  }
  return out
}

export function listProcesses() {
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
      execFile(
        'ps',
        ['-eo', 'pid=,ppid=,comm=,args='],
        { timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
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
        }
      )
    }
  })
}

// The first agent (other than Ollama) under a process.
function agentBelow(pid, children) {
  let level = children.get(pid) || []
  for (let depth = 0; depth < 4 && level.length; depth++) {
    for (const p of level) {
      const a = agentOf(p)
      if (a && a !== 'ollama') return { id: a, cmd: p.cmd }
    }
    level = level.flatMap((p) => children.get(p.pid) || [])
  }
  return null
}

// shells: { paneId: shellPid }
// -> { ok, agents: { paneId: agentId | null }, commands: { paneId: cmd } }
export async function detectAgents({ shells } = {}) {
  if (!shells || typeof shells !== 'object') return { ok: false, error: 'No panes.' }
  const procs = await listProcesses()
  if (!procs) return { ok: false, error: 'Could not list the processes.' }
  const commands = {}
  const agents = agentsUnderShells(procs, shells, commands)
  return { ok: true, agents, commands }
}
