// Which agent CLI runs inside a shell pane (started by hand: `claude` typed in
// PowerShell, say), from the processes under the pane's shell. One process
// list per call, read with CIM (Windows) or ps (elsewhere).
import { execFile } from 'child_process'
import { t } from './i18n'

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
  // Kimi Code's launcher runs as `kimi-code`.
  { id: 'kimi', re: /(^|[\\/])kimi(-code)?(\.exe)?$/i },
  { id: 'aider', re: /(^|[\\/])aider(\.exe)?$/i },
  // The other agents' command names (and their aliases), after Orca's
  // src/shared/tui-agent-config.ts and agent-process-recognition.ts, MIT,
  // Copyright (c) 2026 Lovecast Inc. An npm install runs the same name as a
  // script under node_modules (npmBin below).
  { id: 'openclaude', ...named('openclaude') },
  { id: 'antigravity', ...named('agy') },
  { id: 'kilo', ...named('kilo', /(^|[\\/])@kilocode[\\/]cli[\\/]/i) },
  // Kiro's installer ships `kiro-cli`, not `kiro`.
  { id: 'kiro', ...named('kiro-cli') },
  // Continue's CLI is `cn` (`continue` is a shell keyword).
  { id: 'continue', ...named('cn', /(^|[\\/])@continuedev[\\/]cli[\\/]/i) },
  { id: 'codebuff', ...named('codebuff') },
  { id: 'vibe', ...named('vibe', 'mistral-vibe') },
  { id: 'rovo', ...named('rovo') },
  { id: 'hermes', ...named('hermes') },
  { id: 'devin', ...named('devin') },
  // TRAE CN's CLI: `traecli` (the unrelated trae-agent also installs `trae-cli`).
  { id: 'trae', ...named('traecli') },
  // ZCode names its process `zcode-cli`; its npm bin is dist/zcode.cjs.
  { id: 'zcode', ...named('zcode', 'zcode-cli', /(^|[\\/])@zcode[\\/]cli[\\/]/i) },
  { id: 'autohand', ...named('autohand') },
  // The full name: its `cmd` alias is Windows' own cmd.exe.
  { id: 'commandcode', ...named('command-code') },
  { id: 'openclaw', ...named('openclaw') },
  { id: 'ante', ...named('ante') },
  { id: 'omp', ...named('omp') },
  // The `muse` launcher runs a versioned `muse-bin-<version>` binary.
  { id: 'muse', re: /(^|[\\/])muse(-bin-[^\\/]+)?(\.exe)?$/i, script: npmBin('muse') },
  { id: 'opencode2', ...named('opencode2') },
  { id: 'mimocode', ...named('mimo') },
  {
    id: 'primeagent',
    re: exe('prime-agent'),
    // Its npm shim runs a generic bundled cli.js: only the package path says which.
    script: /(^|[\\/])node_modules[\\/]prime-agent[\\/]dist[\\/]bundle[\\/]cli\.js$|(^|[\\/])node_modules[\\/](?:.+[\\/])?prime-agent$/i
  },
  // Qoder CLI, Freebuff and DeepSeek Harness, after Orca's
  // src/shared/agent-process-recognition.ts and dsh-launch-command.ts, MIT,
  // Copyright (c) 2026 Lovecast Inc.
  // Qoder's launcher runs a versioned `qodercli-<version>` binary.
  {
    id: 'qoder',
    re: /(^|[\\/])qodercli(-\d[^\\/]*)?(\.exe)?$/i,
    script: /(^|[\\/])node_modules[\\/](?:.+[\\/])?qodercli$|(^|[\\/])@qoder-ai[\\/]qodercli[\\/]/i
  },
  // Its npm bin is a generic index.js: only the package folder says which.
  { id: 'freebuff', ...named('freebuff', /(^|[\\/])node_modules[\\/]freebuff[\\/]index\.js$/i) },
  // DeepSeek Harness: `dsh-tui` (alias `dst`) runs `dsh --profile dsh-tui`;
  // the same `dsh` also serves its web, headless and SDK profiles, which are
  // no agent pane.
  {
    id: 'dsh',
    re: /(^|[\\/])(?:dsh-tui|dst|dsh)(\.exe)?$/i,
    script: /(^|[\\/])@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$|(^|[\\/])@deepseek-harness-tui[\\/]dsh-tui[\\/]/i,
    reject: (cmd) => dshNotInteractive(cmd)
  }
]

// A `dsh` command line that runs something else than its interactive
// profile: a non-interactive --profile, the `plugin` or `web` subcommand, or a
// config dump. Only the launcher's own leading words are read (what follows
// belongs to the app: a session id, a prompt). `dsh-tui` / `dst` always are.
const DSH_OTHER_PROFILES = new Set(['web', 'headless', 'sdk', 'sdk-minimal', 'acp', 'desktop'])
const DSH_DUMPS = new Set(['--dump-config', '--dump-default-config', '--dump-config-schema'])
const DSH_VALUE_FLAGS = new Set(['--profile', '--from-default-profile', '--patch'])
const DSH_FLAGS = new Set(['-V', '--version', '-h', '--help', ...DSH_DUMPS])
export function dshNotInteractive(cmd) {
  const tokens = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while (tokens.length < 64 && (m = re.exec(String(cmd || '')))) tokens.push(m[1] ?? m[2] ?? m[3])
  const base = (t) =>
    (String(t || '').split(/[\\/]/).pop() || '').toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|js|mjs|cjs)$/, '')
  if (['dsh-tui', 'dst'].includes(base(tokens[0])) || ['dsh-tui', 'dst'].includes(base(tokens[1]))) return false
  if (/(^|[\\/])@deepseek-harness-tui[\\/]dsh-tui[\\/]/i.test(tokens[1] || '')) return false
  const launcher = (t) => DSH_FLAGS.has(t) || DSH_VALUE_FLAGS.has(t.split('=', 1)[0])
  let i = 1
  // Leading words before its flags: a runtime's script path, or a subcommand.
  for (; i < tokens.length && !launcher(tokens[i]); i++) {
    if (tokens[i] === 'plugin' || tokens[i] === 'web') return true
    if (!tokens[i].startsWith('-') && i > 1) return false
  }
  let profile = null
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (DSH_DUMPS.has(t)) return true
    if (!launcher(t)) break
    if (profile === null && t.startsWith('--profile=')) profile = t.slice(10)
    else if (profile === null && t === '--profile') profile = tokens[i + 1] ?? null
    if (DSH_VALUE_FLAGS.has(t)) i++
  }
  return profile !== null && DSH_OTHER_PROFILES.has(profile)
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
// The executable itself: name(.exe), nothing more.
function exe(...names) {
  return new RegExp(`(^|[\\\\/])(?:${names.map(escape).join('|')})(\\.exe)?$`, 'i')
}
// A runtime's script named like the command (no extension), inside
// node_modules: how an npm install starts it.
function npmBin(...names) {
  return new RegExp(`(^|[\\\\/])node_modules[\\\\/](?:.+[\\\\/])?(?:${names.map(escape).join('|')})$`, 'i')
}
// names: its command names; a RegExp among them: its npm package's folder too.
function named(...names) {
  const words = names.filter((n) => typeof n === 'string')
  const packages = names.filter((n) => n instanceof RegExp)
  const bin = npmBin(...words)
  return {
    re: exe(...words),
    script: packages.length ? new RegExp([bin, ...packages].map((r) => r.source).join('|'), 'i') : bin
  }
}

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
    if (executables.some((w) => r.re.test(w)) || (script && r.script?.test(script))) {
      if (r.reject && r.reject(cmd)) continue
      return r.id
    }
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
  if (!shells || typeof shells !== 'object') return { ok: false, error: t('main.agents.noPanes', 'No panes.') }
  const procs = await listProcesses()
  if (!procs) return { ok: false, error: t('main.agents.listProcesses', 'Could not list the processes.') }
  const commands = {}
  const agents = agentsUnderShells(procs, shells, commands)
  return { ok: true, agents, commands }
}
