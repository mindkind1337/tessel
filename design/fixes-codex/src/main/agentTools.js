// Main-process helpers for multi-agent work: git worktrees (give an agent its
// own copy of the repo on its own branch) and MCP server management for Claude
// Code and Codex. The pure helpers are exported for unit tests.
import { execFile, spawn } from 'child_process'
import { cleanEnv } from './cleanEnv'
import { join, dirname, basename } from 'path'
import os from 'os'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// MCP server names: letters, digits, dash and underscore only. Keeps names safe
// to pass on a command line and valid as a TOML key for Codex.
export function isValidServerName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name)
}

// Split a command line into words, honoring double and single quotes:
//   npx -y "@scope/pkg" "C:\My Folder"  ->  ['npx', '-y', '@scope/pkg', 'C:\My Folder']
export function splitCommandLine(line) {
  const out = []
  let cur = ''
  let quote = null
  let has = false
  for (const ch of String(line || '')) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
    }
  }
  if (has || cur) out.push(cur)
  return out
}

// On Windows, npx/npm/pnpm/yarn are .cmd shims that an agent can't launch
// directly; wrap them in `cmd /c` (what Claude Code's docs recommend).
const CMD_SHIMS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bunx'])
export function windowsSafeCommand(words, platform = process.platform) {
  if (platform !== 'win32' || !words.length) return words
  const first = words[0].toLowerCase().replace(/\.cmd$/, '')
  if (CMD_SHIMS.has(first)) return ['cmd', '/c', ...words]
  return words
}

// Parse "KEY=value" lines (blank lines and # comments ignored).
export function parseKeyValueLines(text, sep = '=') {
  const out = {}
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf(sep)
    if (i <= 0) throw new Error(`Expected KEY${sep}value, got "${line}"`)
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

// Quote a value as a PowerShell single-quoted literal.
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

// Claude Code keeps servers in ~/.claude.json: user scope at the top level,
// local scope per project path; project scope lives in <project>/.mcp.json.
export function claudeServersFromConfig(claudeJson, projectPath, projectMcpJson) {
  const out = []
  const push = (servers, scope) => {
    if (!servers || typeof servers !== 'object') return
    for (const [name, cfg] of Object.entries(servers)) out.push(describeServer(name, cfg, scope))
  }
  if (claudeJson) {
    push(claudeJson.mcpServers, 'user')
    if (projectPath && claudeJson.projects) {
      const want = normPath(projectPath)
      for (const [p, proj] of Object.entries(claudeJson.projects)) {
        if (normPath(p) === want) push(proj && proj.mcpServers, 'local')
      }
    }
  }
  if (projectMcpJson) push(projectMcpJson.mcpServers, 'project')
  return dedupe(out)
}

export function codexServersFromList(list) {
  if (!Array.isArray(list)) return []
  return list.map((s) => {
    const t = s.transport || {}
    const cfg =
      t.type === 'stdio' ? { command: t.command, args: t.args } : { type: 'http', url: t.url }
    return { ...describeServer(s.name, cfg, 'user'), enabled: s.enabled !== false }
  })
}

function describeServer(name, cfg = {}, scope) {
  const type = cfg.type === 'http' || cfg.type === 'sse' || cfg.url ? cfg.type || 'http' : 'stdio'
  const target =
    type === 'stdio' ? [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' ') : cfg.url || ''
  // Never expose env values or headers (they are usually secrets).
  return { name, scope, type, target }
}

function normPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function dedupe(list) {
  const seen = new Set()
  return list.filter((s) => {
    const k = `${s.scope}:${s.name}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function slugify(text) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  )
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

export function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: opts.timeout || 60000,
        env: cleanEnv(process.env),
        ...opts
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err ? err.message : null
        })
      }
    )
  })
}

// Run an agent CLI through PowerShell so .cmd/.ps1 shims resolve, with PATH
// re-read from the registry (so a PATH change takes effect without restarting
// Tessel). Arguments are passed as single-quoted literals.
function runAgentCli(exe, args, cwd) {
  if (process.platform !== 'win32') return run(exe, args, { cwd })
  const script = [
    '$ErrorActionPreference = "Continue"',
    "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    `& ${psQuote(exe)} ${args.map(psQuote).join(' ')}`,
    'exit $LASTEXITCODE'
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
    timeout: 90000
  })
}

function cliError(res, fallback) {
  const text = (res.stderr || res.stdout || res.error || '').trim()
  const line = text.split(/\r?\n/).filter(Boolean).slice(-3).join(' ')
  return line || fallback
}

// ---------------------------------------------------------------------------
// Git worktrees
// ---------------------------------------------------------------------------

export async function gitInfo(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return { isRepo: false }
  const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])
  if (!top.ok)
    return {
      isRepo: false,
      error: top.error && /ENOENT/.test(top.error) ? 'Git is not installed' : null
    }
  const root = top.stdout.trim()
  const br = await run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const head = await run('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'])
  return { isRepo: true, root, branch: br.ok ? br.stdout.trim() : null, hasCommits: head.ok }
}

// Parse `git status --porcelain=v1 --branch` into what a pane header shows:
//   ## main...origin/main [ahead 2, behind 1]
//    M src/a.js
//   ?? new.txt
// -> { branch: 'main', ahead: 2, behind: 1, changed: 2 }
export function parseGitStatus(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter(Boolean)
  let branch = null
  let ahead = 0
  let behind = 0
  let changed = 0
  for (const line of lines) {
    if (!line.startsWith('## ')) {
      changed++
      continue
    }
    const head = line.slice(3)
    const initial = /^No commits yet on (.+)$/.exec(head)
    if (initial) {
      branch = initial[1]
      continue
    }
    if (/^HEAD \(no branch\)/.test(head)) {
      branch = 'detached'
      continue
    }
    branch = head.split(/\.\.\.|\s/)[0] || null
    const a = /ahead (\d+)/.exec(head)
    const b = /behind (\d+)/.exec(head)
    if (a) ahead = Number(a[1])
    if (b) behind = Number(b[1])
  }
  return { branch, ahead, behind, changed }
}

// Branch and working-tree state of the repo containing `cwd`, for pane headers.
export async function gitStatus(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return { isRepo: false }
  const res = await run('git', ['-C', cwd, 'status', '--porcelain=v1', '--branch'], {
    timeout: 8000
  })
  if (!res.ok) return { isRepo: false }
  return { isRepo: true, ...parseGitStatus(res.stdout) }
}

// Create <repo>.worktrees/<name> on a new branch agent/<name> from HEAD.
export async function createWorktree(cwd, label) {
  const info = await gitInfo(cwd)
  if (!info.isRepo) return { ok: false, error: 'The workspace folder is not a git repository.' }
  if (!info.hasCommits)
    return {
      ok: false,
      error: 'The repository has no commits yet. Make a first commit, then try again.'
    }
  const base = join(dirname(info.root), `${basename(info.root)}.worktrees`)
  const slug = slugify(label)
  let n = 1
  let name = slug
  const branchExists = async (b) =>
    (await run('git', ['-C', info.root, 'show-ref', '--verify', '--quiet', `refs/heads/${b}`])).ok
  while (fs.existsSync(join(base, name)) || (await branchExists(`agent/${name}`))) {
    n += 1
    name = `${slug}-${n}`
  }
  const path = join(base, name)
  const branch = `agent/${name}`
  fs.mkdirSync(base, { recursive: true })
  const res = await run('git', ['-C', info.root, 'worktree', 'add', '-b', branch, path, 'HEAD'])
  if (!res.ok) return { ok: false, error: cliError(res, 'git worktree add failed') }
  return { ok: true, path, branch, baseBranch: info.branch, root: info.root }
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export async function listMcp(cwd) {
  const claudeJson = readJson(join(os.homedir(), '.claude.json'))
  const projectMcp = cwd ? readJson(join(cwd, '.mcp.json')) : null
  const claude = claudeServersFromConfig(claudeJson, cwd, projectMcp)

  let codex = []
  let codexError = null
  const res = await runAgentCli('codex', ['mcp', 'list', '--json'], cwd)
  if (res.ok) {
    try {
      const start = res.stdout.indexOf('[')
      codex = codexServersFromList(JSON.parse(res.stdout.slice(start)))
    } catch {
      codexError = 'Could not read the Codex server list.'
    }
  } else {
    codexError = /not recognized|CommandNotFound/i.test(res.stderr + res.stdout)
      ? 'Codex is not installed.'
      : cliError(res, 'Could not list Codex servers.')
  }
  return { claude, codex, codexError }
}

// spec: { agent: 'claude'|'codex', name, transport: 'stdio'|'http',
//         commandLine, url, env: 'K=V lines', headers: 'Name: value lines',
//         scope: 'user'|'project', cwd }
export async function addMcp(spec) {
  const { agent, name, transport, cwd } = spec || {}
  if (!isValidServerName(name)) {
    return { ok: false, error: 'Use letters, digits, - or _ for the name (no spaces).' }
  }
  let env
  let headers
  try {
    env = parseKeyValueLines(spec.env)
    headers = parseKeyValueLines(spec.headers, ':')
  } catch (err) {
    return { ok: false, error: err.message }
  }

  const args = ['mcp', 'add']
  if (agent === 'claude') {
    const scope = spec.scope === 'project' ? 'project' : 'user'
    if (scope === 'project' && !cwd) {
      return { ok: false, error: 'Set a project folder on the workspace to use project scope.' }
    }
    args.push('-s', scope)
    if (transport === 'http') {
      if (!/^https?:\/\//i.test(spec.url || ''))
        return { ok: false, error: 'Enter a URL starting with http:// or https://' }
      // -H takes several values, so it goes after the name and URL.
      args.push('--transport', 'http', name, spec.url)
      for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`)
    } else {
      const words = windowsSafeCommand(splitCommandLine(spec.commandLine))
      if (!words.length) return { ok: false, error: 'Enter the command that starts the server.' }
      // -e takes several values, so it goes after the name; `--` ends it.
      args.push(name)
      for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`)
      args.push('--', ...words)
    }
    const res = await runAgentCli('claude', args, scope === 'project' ? cwd : null)
    return res.ok ? { ok: true } : { ok: false, error: cliError(res, 'claude mcp add failed') }
  }

  if (agent === 'codex') {
    args.push(name)
    if (transport === 'http') {
      if (!/^https?:\/\//i.test(spec.url || ''))
        return { ok: false, error: 'Enter a URL starting with http:// or https://' }
      args.push('--url', spec.url)
      if (spec.bearerEnvVar) args.push('--bearer-token-env-var', spec.bearerEnvVar)
    } else {
      const words = windowsSafeCommand(splitCommandLine(spec.commandLine))
      if (!words.length) return { ok: false, error: 'Enter the command that starts the server.' }
      for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`)
      args.push('--', ...words)
    }
    const res = await runAgentCli('codex', args, cwd)
    return res.ok ? { ok: true } : { ok: false, error: cliError(res, 'codex mcp add failed') }
  }
  return { ok: false, error: 'Unknown agent.' }
}

export async function removeMcp({ agent, name, scope, cwd }) {
  if (!isValidServerName(name)) return { ok: false, error: 'Invalid server name.' }
  if (agent === 'claude') {
    const s = ['user', 'local', 'project'].includes(scope) ? scope : 'user'
    const res = await runAgentCli(
      'claude',
      ['mcp', 'remove', '-s', s, name],
      s === 'user' ? null : cwd
    )
    return res.ok ? { ok: true } : { ok: false, error: cliError(res, 'claude mcp remove failed') }
  }
  if (agent === 'codex') {
    const res = await runAgentCli('codex', ['mcp', 'remove', name], cwd)
    return res.ok ? { ok: true } : { ok: false, error: cliError(res, 'codex mcp remove failed') }
  }
  return { ok: false, error: 'Unknown agent.' }
}

// ---------------------------------------------------------------------------
// Full server config (main process only: it can contain secrets), connection
// test and copy between agents.
// ---------------------------------------------------------------------------

// Normalize one agent's server entry to
// { transport: 'stdio'|'http', command, args, env, url, headers, bearerEnvVar }.
export function normalizeServerConfig(cfg = {}) {
  const t = cfg.transport && typeof cfg.transport === 'object' ? cfg.transport : cfg
  const isHttp = !!t.url || ['http', 'sse', 'streamable_http'].includes(t.type)
  if (isHttp) {
    return {
      transport: 'http',
      url: t.url || '',
      headers: { ...(t.headers || t.http_headers || {}) },
      bearerEnvVar: t.bearer_token_env_var || null
    }
  }
  return {
    transport: 'stdio',
    command: t.command || '',
    args: Array.isArray(t.args) ? t.args.map(String) : [],
    env: { ...(t.env || {}) }
  }
}

async function fullConfig({ agent, name, scope, cwd }) {
  if (agent === 'claude') {
    let entry = null
    if (scope === 'project') {
      const mcp = cwd ? readJson(join(cwd, '.mcp.json')) : null
      entry = mcp && mcp.mcpServers && mcp.mcpServers[name]
    } else {
      const cj = readJson(join(os.homedir(), '.claude.json')) || {}
      if (scope === 'local' && cwd && cj.projects) {
        const want = normPath(cwd)
        for (const [p, proj] of Object.entries(cj.projects)) {
          if (normPath(p) === want && proj && proj.mcpServers && proj.mcpServers[name]) {
            entry = proj.mcpServers[name]
          }
        }
      } else {
        entry = cj.mcpServers && cj.mcpServers[name]
      }
    }
    return entry ? normalizeServerConfig(entry) : null
  }
  if (agent === 'codex') {
    const res = await runAgentCli('codex', ['mcp', 'list', '--json'], cwd)
    if (!res.ok) return null
    try {
      const list = JSON.parse(res.stdout.slice(res.stdout.indexOf('[')))
      const s = list.find((x) => x.name === name)
      return s ? normalizeServerConfig(s) : null
    } catch {
      return null
    }
  }
  return null
}

const MCP_INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'tessel', version: '1.0.0' }
  }
}

// Parse a JSON-RPC response from a JSON body or an SSE stream body.
export function parseRpcBody(text, id) {
  const candidates = []
  const trimmed = String(text || '').trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) candidates.push(trimmed)
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith('data:')) candidates.push(line.slice(5).trim())
  }
  for (const c of candidates) {
    try {
      const msg = JSON.parse(c)
      const list = Array.isArray(msg) ? msg : [msg]
      const hit = list.find((m) => m && m.id === id)
      if (hit) return hit
    } catch {
      /* not JSON */
    }
  }
  return null
}

async function testHttp(cfg, baseEnv) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...cfg.headers
  }
  if (cfg.bearerEnvVar && baseEnv[cfg.bearerEnvVar]) {
    headers.Authorization = `Bearer ${baseEnv[cfg.bearerEnvVar]}`
  }
  const post = async (body, extra = {}) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
      return await fetch(cfg.url, {
        method: 'POST',
        headers: { ...headers, ...extra },
        body: JSON.stringify(body),
        signal: ctrl.signal
      })
    } finally {
      clearTimeout(timer)
    }
  }
  let res
  try {
    res = await post(MCP_INIT)
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      error:
        err.name === 'AbortError'
          ? 'No answer after 20 seconds.'
          : `Could not reach the server: ${err.message}`
    }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: 'auth', error: 'The server is reachable but needs you to sign in.' }
  }
  if (!res.ok)
    return { ok: false, status: 'error', error: `The server answered HTTP ${res.status}.` }
  const init = parseRpcBody(await res.text(), 1)
  if (!init || !init.result) {
    return { ok: false, status: 'error', error: 'The server did not answer like an MCP server.' }
  }
  const server = init.result.serverInfo && init.result.serverInfo.name
  const session = res.headers.get('mcp-session-id')
  const extra = session ? { 'Mcp-Session-Id': session } : {}
  try {
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, extra)
    const toolsRes = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, extra)
    const tools = parseRpcBody(await toolsRes.text(), 2)
    return {
      ok: true,
      status: 'connected',
      server,
      tools: ((tools && tools.result && tools.result.tools) || []).map((t) => t.name)
    }
  } catch {
    return { ok: true, status: 'connected', server, tools: [] }
  }
}

function tail(text) {
  return String(text || '')
    .trim()
    .split(/\r?\n/)
    .slice(-4)
    .join('\n')
}

function testStdio(cfg, baseEnv, spawnFn) {
  return new Promise((resolve) => {
    const words = windowsSafeCommand(
      [cfg.command, ...cfg.args].filter((w) => w !== undefined && w !== '')
    )
    if (!words.length)
      return resolve({ ok: false, status: 'error', error: 'No command configured.' })
    let child
    try {
      child = spawnFn(words[0], words.slice(1), {
        env: { ...baseEnv, ...cfg.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      return resolve({ ok: false, status: 'error', error: err.message })
    }
    let out = ''
    let errText = ''
    let done = false
    let server = null
    let timer = null
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      if (process.platform === 'win32' && child.pid) {
        execFile(
          'taskkill',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true },
          () => {}
        )
      }
      resolve(result)
    }
    // npx may need to download the package the first time.
    timer = setTimeout(
      () =>
        finish({
          ok: false,
          status: 'error',
          error: 'No answer after 60 seconds.',
          log: tail(errText)
        }),
      60000
    )
    const send = (msg) => {
      try {
        child.stdin.write(JSON.stringify(msg) + '\n')
      } catch {
        /* closed */
      }
    }
    child.on('error', (err) =>
      finish({
        ok: false,
        status: 'error',
        error: err.code === 'ENOENT' ? `Command not found: ${words[0]}` : err.message
      })
    )
    child.on('exit', (code) =>
      finish({
        ok: false,
        status: 'error',
        error: `The server exited (code ${code}) before answering.`,
        log: tail(errText)
      })
    )
    child.stderr.on('data', (d) => {
      errText = (errText + d).slice(-4000)
    })
    child.stdout.on('data', (d) => {
      out += d
      let nl
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        if (!line.startsWith('{')) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1) {
          if (!msg.result)
            return finish({ ok: false, status: 'error', error: 'Initialize was refused.' })
          server = msg.result.serverInfo && msg.result.serverInfo.name
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (msg.id === 2) {
          finish({
            ok: true,
            status: 'connected',
            server,
            tools: ((msg.result && msg.result.tools) || []).map((t) => t.name)
          })
        }
      }
    })
    send(MCP_INIT)
  })
}

export async function testMcp(ref, baseEnv = process.env, spawnFn = spawn) {
  const cfg = await fullConfig(ref)
  if (!cfg) return { ok: false, status: 'error', error: 'Server not found in the configuration.' }
  const started = Date.now()
  const res =
    cfg.transport === 'http' ? await testHttp(cfg, baseEnv) : await testStdio(cfg, baseEnv, spawnFn)
  return { ...res, ms: Date.now() - started }
}

function quoteWord(w) {
  return /[\s"]/.test(w) ? `"${w.replace(/"/g, '')}"` : w
}

// Copy a server from one agent to the other, secrets included (they never
// leave the main process).
export async function copyMcp({ from, to, name, scope, cwd }) {
  const cfg = await fullConfig({ agent: from, name, scope, cwd })
  if (!cfg) return { ok: false, error: 'Server not found.' }
  const spec = { agent: to, name, scope: 'user', cwd }
  if (cfg.transport === 'http') {
    spec.transport = 'http'
    spec.url = cfg.url
    spec.headers = Object.entries(cfg.headers || {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
    if (cfg.bearerEnvVar) spec.bearerEnvVar = cfg.bearerEnvVar
  } else {
    spec.transport = 'stdio'
    spec.commandLine = [cfg.command, ...cfg.args].map(quoteWord).join(' ')
    spec.env = Object.entries(cfg.env || {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
  }
  const res = await addMcp(spec)
  const note =
    to === 'codex' && cfg.transport === 'http' && Object.keys(cfg.headers || {}).length
      ? 'Codex cannot store custom headers. Sign in with codex mcp login if the server asks.'
      : null
  return res.ok ? { ok: true, note } : res
}

// Keyboard-layout handle for an input method tip like '0C0C:00001009':
// low word = language id, high word = layout id (standard layouts only).
export function hklFromTip(tip) {
  const m = /^([0-9a-f]{4}):0000([0-9a-f]{4})$/i.exec(String(tip || ''))
  if (!m) return null
  return (parseInt(m[2], 16) * 0x10000 + parseInt(m[1], 16)) >>> 0
}
