// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'module'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import net from 'net'
import { join, resolve } from 'path'
import { parseClaudeHead as pcClaudeHead, parseCodexHead as pcCodexHead } from '../../agentSessions'

const require = createRequire(import.meta.url)
const SHIM = resolve(__dirname, '../tessel-shim.cjs')
const shim = require(SHIM)
const ABS = '/home/u/.tessel-server/bin/tessel-shim.cjs'
const TOKEN = 'ab'.repeat(32)

describe('helloLine', () => {
  it('is one JSON line in the v1 shape', () => {
    const line = shim.helloLine({ pane: 'p1', token: TOKEN, kind: 'hook', args: ['claude', 'Stop'] })
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({ v: 1, pane: 'p1', token: TOKEN, kind: 'hook', args: ['claude', 'Stop'] })
  })
  it('refuses what breaks the limits', () => {
    expect(shim.helloLine({ pane: 'p', token: 'short', kind: 'mcp' })).toBe(null)
    expect(shim.helloLine({ pane: 'p', token: TOKEN, kind: 'other' })).toBe(null)
    expect(shim.helloLine({ pane: 'p', token: TOKEN, kind: 'hook', args: Array(17).fill('a') })).toBe(null)
    expect(shim.helloLine({ pane: 'p', token: TOKEN, kind: 'hook', args: ['x'.repeat(257)] })).toBe(null)
    expect(shim.helloLine({ pane: 'x'.repeat(9000), token: TOKEN, kind: 'mcp' })).toBe(null)
  })
})

describe('mergeClaudeJson', () => {
  it('adds the server to a fresh config', () => {
    const r = shim.mergeClaudeJson({}, ABS)
    expect(r.changed).toBe(true)
    expect(r.value.mcpServers['tessel-team']).toEqual({ type: 'stdio', command: 'node', args: [ABS, 'mcp'] })
  })
  it('keeps the other servers and settings, and is idempotent', () => {
    const cfg = { numStartups: 3, mcpServers: { mine: { command: 'x' }, 'tessel-team': { command: 'old' } } }
    const r = shim.mergeClaudeJson(cfg, ABS)
    expect(r.value.numStartups).toBe(3)
    expect(r.value.mcpServers.mine).toEqual({ command: 'x' })
    expect(r.value.mcpServers['tessel-team'].args).toEqual([ABS, 'mcp'])
    expect(shim.mergeClaudeJson(r.value, ABS).changed).toBe(false)
  })
})

describe('mergeHooks', () => {
  it('adds every event to a fresh file', () => {
    const r = shim.mergeHooks({}, shim.CLAUDE_HOOK_EVENTS, 'claude', ABS)
    expect(r.changed).toBe(true)
    expect(Object.keys(r.value.hooks)).toEqual(shim.CLAUDE_HOOK_EVENTS)
    expect(r.value.hooks.Stop).toEqual([{ matcher: '', hooks: [{ type: 'command', command: `node '${ABS}' hook claude Stop` }] }])
  })
  it('keeps the user entries, replaces an older Tessel one, and is idempotent', () => {
    const user = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-lint' }] }
    const mixed = { matcher: '', hooks: [{ type: 'command', command: 'echo hi' }, { type: 'command', command: 'node "/old/tessel-shim.cjs" hook codex Stop' }] }
    const settings = { theme: 'x', hooks: { Stop: [user, mixed], Custom: [{ hooks: [{ command: 'keep' }] }] } }
    const r = shim.mergeHooks(settings, shim.CODEX_HOOK_EVENTS, 'codex', ABS)
    expect(r.value.theme).toBe('x')
    expect(r.value.hooks.Custom).toEqual(settings.hooks.Custom)
    expect(r.value.hooks.Stop).toEqual([
      user,
      { matcher: '', hooks: [{ type: 'command', command: 'echo hi' }] },
      { matcher: '', hooks: [{ type: 'command', command: `node '${ABS}' hook codex Stop` }] }
    ])
    expect(Object.keys(r.value.hooks)).toEqual(expect.arrayContaining(shim.CODEX_HOOK_EVENTS))
    expect(shim.mergeHooks(r.value, shim.CODEX_HOOK_EVENTS, 'codex', ABS).changed).toBe(false)
  })
})

describe('mergeCodexToml', () => {
  it('writes the table in a fresh file', () => {
    const r = shim.mergeCodexToml('', ABS)
    expect(r.changed).toBe(true)
    expect(r.text).toBe(
      '[mcp_servers.tessel-team]\ncommand = "node"\nargs = ["/home/u/.tessel-server/bin/tessel-shim.cjs", "mcp"]\n' +
        'env_vars = ["TESSEL_PANE_ID", "TESSEL_REMOTE_SOCK", "TESSEL_REMOTE_TOKEN", "TESSEL_AGENT_PROVIDER"]\n' +
        'default_tools_approval_mode = "approve"\n'
    )
  })
  it('replaces only its own table (and sub-tables), and is idempotent', () => {
    const text = 'model = "o3"\n\n[mcp_servers.tessel-team]\ncommand = "old"\n\n[mcp_servers.tessel-team.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "x"\n'
    const r = shim.mergeCodexToml(text, ABS)
    expect(r.changed).toBe(true)
    expect(r.text).toContain('model = "o3"')
    expect(r.text).toContain('[mcp_servers.other]\ncommand = "x"')
    expect(r.text).not.toContain('"old"')
    expect(r.text).not.toContain('tessel-team.env')
    expect(r.text.match(/\[mcp_servers\.tessel-team\]/g)).toHaveLength(1)
    expect(shim.mergeCodexToml(r.text, ABS).changed).toBe(false)
  })
})

describe('mergeCodexToml, other forms', () => {
  it('refuses a tessel-team set as an inline table or dotted keys', () => {
    expect(shim.mergeCodexToml('[mcp_servers]\ntessel-team = { command = "x" }\n', ABS).error).toBeTruthy()
    expect(shim.mergeCodexToml('mcp_servers.tessel-team.command = "x"\n', ABS).error).toBeTruthy()
    expect(shim.mergeCodexToml('[mcp_servers]\nother = { command = "x" }\n', ABS).changed).toBe(true)
    expect(shim.mergeCodexToml('[profiles.a]\ntessel-team = 1\n', ABS).changed).toBe(true)
  })
})

describe('mergeClaudeJson, fields added by Claude Code', () => {
  it('counts as set when type, command and args match', () => {
    const cfg = { mcpServers: { 'tessel-team': { ...shim.claudeServer(ABS), env: {} } } }
    expect(shim.mergeClaudeJson(cfg, ABS).changed).toBe(false)
  })
})

describe('install', () => {
  let home
  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-shim-home-'))
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = { PATH: '' }

  it('skips agents that are not installed', () => {
    const r = shim.install({ home, shimPath: ABS, env })
    expect(r.ok).toBe(true)
    expect(r.skipped).toEqual(['claude', 'codex'])
    expect(fs.readdirSync(home)).toEqual([])
  })

  it('sets up both agents once, keeps a backup once, and keeps the user entries', () => {
    fs.writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } } }))
    fs.mkdirSync(join(home, '.codex'))
    fs.writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o3"\n')
    const r = shim.install({ home, shimPath: ABS, env })
    expect(r.errors).toEqual([])
    expect(r.changed).toHaveLength(4)
    const cfg = JSON.parse(fs.readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(cfg.mcpServers.mine).toEqual({ command: 'x' })
    expect(cfg.mcpServers['tessel-team'].args).toEqual([ABS, 'mcp'])
    expect(JSON.parse(fs.readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks.SessionEnd).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).hooks.Interrupt).toHaveLength(1)
    expect(fs.readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toMatch(/^model = "o3"\n\n\[mcp_servers\.tessel-team\]/)
    // backups of the files that existed, and only those
    expect(fs.readFileSync(join(home, '.claude.json.tessel-bak'), 'utf8')).toContain('"mine"')
    expect(fs.readFileSync(join(home, '.codex', 'config.toml.tessel-bak'), 'utf8')).toBe('model = "o3"\n')
    expect(fs.existsSync(join(home, '.claude', 'settings.json.tessel-bak'))).toBe(false)
    // no temporary file left
    for (const dir of [home, join(home, '.claude'), join(home, '.codex')]) expect(fs.readdirSync(dir).filter((f) => f.includes('tessel-tmp'))).toEqual([])

    const again = shim.install({ home, shimPath: ABS, env })
    expect(again.changed).toEqual([])
    expect(again.unchanged).toHaveLength(4)

    // another shim path: updated, the first backup stays as it was
    const r3 = shim.install({ home, shimPath: '/other/tessel-shim.cjs', env })
    expect(r3.changed).toHaveLength(4)
    expect(fs.readFileSync(join(home, '.claude.json.tessel-bak'), 'utf8')).not.toContain('tessel-team')
    expect(JSON.parse(fs.readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks.Stop).toHaveLength(1)
  })

  it('writes the absolute node given with --node in every config', () => {
    const node = '/home/u/.nvm/versions/node/v22.1.0/bin/node'
    fs.writeFileSync(join(home, '.claude.json'), '{}')
    fs.mkdirSync(join(home, '.codex'))
    const r = shim.install({ home, shimPath: ABS, env, node })
    expect(r.errors).toEqual([])
    expect(JSON.parse(fs.readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers['tessel-team'].command).toBe(node)
    expect(JSON.parse(fs.readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks.Stop[0].hooks[0].command).toBe(`'${node}' '${ABS}' hook claude Stop`)
    expect(JSON.parse(fs.readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).hooks.Stop[0].hooks[0].command).toBe(`'${node}' '${ABS}' hook codex Stop`)
    expect(fs.readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toContain(`command = "${node}"`)
    // the same again: nothing to do; back to a plain node: updated
    expect(shim.install({ home, shimPath: ABS, env, node }).changed).toEqual([])
    expect(shim.install({ home, shimPath: ABS, env }).changed).toHaveLength(4)
  })

  it('refuses a node or shim path it cannot quote safely, touching nothing', () => {
    fs.writeFileSync(join(home, '.claude.json'), '{}')
    for (const [shimPath, node] of [
      [ABS, 'node'],
      [ABS, "/opt/it's/node"],
      [ABS, '/opt/node\n'],
      [ABS, '/opt/"node"'],
      ["/home/o'brien/tessel-shim.cjs", undefined],
      ['relative/tessel-shim.cjs', undefined]
    ]) {
      const r = shim.install({ home, shimPath, env, node })
      expect(r.ok).toBe(false)
      expect(r.changed).toEqual([])
    }
    expect(fs.readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{}')
  })

  it.skipIf(process.platform === 'win32')('writes through a symlinked config', () => {
    const real = join(home, 'dotfiles-claude.json')
    fs.writeFileSync(real, '{}')
    fs.symlinkSync(real, join(home, '.claude.json'))
    expect(shim.install({ home, shimPath: ABS, env }).errors).toEqual([])
    expect(fs.lstatSync(join(home, '.claude.json')).isSymbolicLink()).toBe(true)
    expect(JSON.parse(fs.readFileSync(real, 'utf8')).mcpServers['tessel-team']).toBeTruthy()
  })

  it('leaves a file it cannot read as JSON alone', () => {
    fs.writeFileSync(join(home, '.claude.json'), '{ broken')
    const r = shim.install({ home, shimPath: ABS, env })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('.claude.json')
    expect(fs.readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{ broken')
  })
})

// A fake Tessel on a Unix socket (named pipe on Windows), the shim run for real.
describe('round trip', () => {
  let server
  let sock
  let seen
  const sockPath = () =>
    process.platform === 'win32' ? `\\\\.\\pipe\\tessel-shim-test-${process.pid}-${Date.now()}` : join(fs.mkdtempSync(join(os.tmpdir(), 'tsh-')), 's.sock')

  beforeEach(async () => {
    seen = []
    sock = sockPath()
    server = net.createServer({ allowHalfOpen: true }, (c) => {
      let buf = Buffer.alloc(0)
      let hello = null
      c.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        if (!hello) {
          const nl = buf.indexOf(10)
          if (nl < 0) return
          hello = JSON.parse(buf.subarray(0, nl).toString())
          buf = buf.subarray(nl + 1)
          seen.push(hello)
          if (hello.token !== TOKEN) return c.end('{"ok":false,"error":"bad-token"}\n')
          c.write('{"ok":true}\n')
        }
        if (hello.kind === 'mcp' && buf.length) {
          c.write(buf.toString().toUpperCase())
          buf = Buffer.alloc(0)
        }
      })
      c.on('end', () => {
        if (hello && hello.kind === 'hook' && hello.token === TOKEN) {
          const input = buf.toString()
          c.end(JSON.stringify({ exit: 2, stdout: Buffer.from(`out:${input}`).toString('base64'), stderr: Buffer.from('warn').toString('base64') }) + '\n')
        } else c.end()
      })
      c.on('error', () => {})
    })
    await new Promise((r) => server.listen(sock, r))
  })
  afterEach(async () => {
    await new Promise((r) => server.close(r))
  })

  const run = (args, { input = '', env = {}, keepOpen = false } = {}) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [SHIM, ...args], {
        env: { PATH: process.env.PATH, TESSEL_PANE_ID: 'pane-7', TESSEL_REMOTE_SOCK: sock, TESSEL_REMOTE_TOKEN: TOKEN, ...env },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => {
        out += d
        if (keepOpen && out.includes('\n')) child.stdin.end()
      })
      child.stderr.on('data', (d) => (err += d))
      child.on('exit', (code) => done({ code, out, err }))
      child.stdin.write(input)
      if (!keepOpen) child.stdin.end()
    })

  // Windows named pipes have no half-close (end() closes both ways): the
  // server could not answer after the hook's input. Unix sockets only.
  it.skipIf(process.platform === 'win32')('hook: stdin in, stdout, stderr and the exit code out', async () => {
    const r = await run(['hook', 'claude', 'Stop'], { input: '{"hook_event_name":"Stop"}' })
    expect(r).toEqual({ code: 2, out: 'out:{"hook_event_name":"Stop"}', err: 'warn' })
    expect(seen).toEqual([{ v: 1, pane: 'pane-7', token: TOKEN, kind: 'hook', args: ['claude', 'Stop'] }])
  })

  it('hook: Tessel unreachable or refusing -> exit 0, quietly', async () => {
    expect(await run(['hook', 'claude', 'Stop'], { input: '{}', env: { TESSEL_REMOTE_SOCK: sock + '-nope' } })).toEqual({ code: 0, out: '', err: '' })
    expect(await run(['hook', 'claude', 'Stop'], { input: '{}', env: { TESSEL_REMOTE_TOKEN: 'cd'.repeat(32) } })).toEqual({ code: 0, out: '', err: '' })
    expect(await run(['hook', 'codex', 'Stop'], { input: '{}', env: { TESSEL_REMOTE_SOCK: '' } })).toEqual({ code: 0, out: '', err: '' })
  })

  it('mcp: a two-way stream', async () => {
    const r = await run(['mcp'], { input: '{"jsonrpc":"2.0"}\n', keepOpen: true })
    expect(r.code).toBe(0)
    expect(r.out).toBe('{"JSONRPC":"2.0"}\n')
    expect(seen[0]).toMatchObject({ kind: 'mcp', args: [] })
  })

  // What an MCP client sends first; the shim answers each request in order.
  const session =
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
      { jsonrpc: '2.0', id: 4, method: 'resources/list' }
    ]
      .map((m) => JSON.stringify(m))
      .join('\n') + '\nnot json\n'
  const answers = (out) => out.trim().split('\n').map((l) => JSON.parse(l))

  it('mcp outside a Tessel pane (VS Code, plain ssh): a valid server without tools, quietly', async () => {
    const r = await run(['mcp'], { input: session, env: { TESSEL_REMOTE_SOCK: '', TESSEL_REMOTE_TOKEN: '', TESSEL_PANE_ID: '' } })
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(answers(r.out)).toEqual([
      { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'tessel-team', version: shim.VERSION } } },
      { jsonrpc: '2.0', id: 2, result: { tools: [] } },
      { jsonrpc: '2.0', id: 3, result: {} },
      { jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'Method not found: resources/list' } }
    ])
    expect(seen).toEqual([])
  })

  it('mcp with Tessel closed or refusing: the same empty server, the reason only in its instructions', async () => {
    for (const env of [{ TESSEL_REMOTE_SOCK: sock + '-nope' }, { TESSEL_REMOTE_TOKEN: 'cd'.repeat(32) }]) {
      const r = await run(['mcp'], { input: session, env })
      expect(r.code).toBe(0)
      expect(r.err).toBe('')
      const [init, list] = answers(r.out)
      expect(init.result.serverInfo.name).toBe('tessel-team')
      expect(init.result.instructions).toMatch(/not reachable/)
      expect(list.result).toEqual({ tools: [] })
    }
    expect(seen.map((h) => h.token)).toEqual(['cd'.repeat(32)])
  })

  it('version', async () => {
    expect((await run(['version'])).out).toBe(`${shim.VERSION}\n`)
  })
})

describe('sessions', () => {
  let home
  const U = (n) => `${String(n).repeat(8)}-1111-4222-8333-${String(n).repeat(12)}`
  const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
  const at = (file, ms) => fs.utimesSync(file, new Date(ms), new Date(ms))
  const claudeFile = (id, rows, ms, folder = '-srv-app') => {
    const dir = join(home, '.claude', 'projects', folder)
    fs.mkdirSync(dir, { recursive: true })
    const file = join(dir, `${id}.jsonl`)
    fs.writeFileSync(file, jsonl(rows))
    at(file, ms)
    return file
  }
  const codexFile = (name, rows, ms) => {
    const dir = join(home, '.codex', 'sessions', '2026', '10', '05')
    fs.mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    fs.writeFileSync(file, jsonl(rows))
    at(file, ms)
    return file
  }
  const codexMeta = (id, cwd = '/srv/api') => ({ type: 'session_meta', timestamp: '2026-10-05T08:00:00.000Z', payload: { id, cwd, timestamp: '2026-10-05T08:00:00.000Z' } })
  const T = Date.UTC(2026, 9, 5, 12)

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-shim-sessions-'))
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))
  const list = (limit, env = {}) => shim.listSessions({ limit, home, env })

  it('parses heads exactly like agentSessions.js on the PC', () => {
    const claude = [
      'not json',
      { type: 'user', isMeta: true, cwd: '/srv/app', sessionId: U(1), timestamp: '2026-10-05T07:00:00.000Z', message: { content: 'meta' } },
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { content: [{ type: 'text', text: '  Fix the\n login   bug ' + 'x'.repeat(200) }] } }
    ]
    const summary = [{ type: 'summary', summary: 'A summary title', cwd: '/srv/b' }]
    const codex = [
      codexMeta(U(3)),
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Add the API route' } }
    ]
    for (const rows of [claude, summary, [{ cwd: '/x' }]]) expect(shim.parseClaudeHead(jsonl(rows))).toEqual(pcClaudeHead(jsonl(rows)))
    for (const rows of [codex, [{ type: 'other' }], [codexMeta('not-a-uuid')]]) expect(shim.parseCodexHead(jsonl(rows))).toEqual(pcCodexHead(jsonl(rows)))
    expect(shim.parseClaudeHead(jsonl(claude)).title).toHaveLength(120)
  })

  it('lists both agents newest first, at most <limit> each, in the contract shape', () => {
    claudeFile(U(1), [{ type: 'user', cwd: '/srv/app', timestamp: '2026-10-05T07:00:00.000Z', message: { content: 'First' } }], T - 3000)
    claudeFile(U(2), [{ type: 'user', cwd: '/srv/app', timestamp: '2026-10-05T09:00:00.000Z', message: { content: 'Second' } }], T - 1000, '-srv-other')
    claudeFile(U(4), [{ type: 'user', cwd: '/srv/app', message: { content: '<only injected>' } }], T) // no title: left out
    claudeFile('not-a-uuid', [{ type: 'user', cwd: '/x', message: { content: 'x' } }], T)
    codexFile('rollout-2026-10-05-a.jsonl', [codexMeta(U(3)), { type: 'event_msg', payload: { type: 'user_message', message: 'Codex task' } }], T - 2000)
    codexFile('other.jsonl', [codexMeta(U(5)), { type: 'event_msg', payload: { type: 'user_message', message: 'not a rollout' } }], T)
    expect(list(60)).toEqual({
      v: 1,
      sessions: [
        { agent: 'claude', id: U(2), cwd: '/srv/app', started: '2026-10-05T09:00:00.000Z', updated: T - 1000, title: 'Second' },
        { agent: 'codex', id: U(3), cwd: '/srv/api', started: '2026-10-05T08:00:00.000Z', updated: T - 2000, title: 'Codex task' },
        { agent: 'claude', id: U(1), cwd: '/srv/app', started: '2026-10-05T07:00:00.000Z', updated: T - 3000, title: 'First' }
      ]
    })
    expect(list(1).sessions.map((s) => [s.agent, s.id])).toEqual([
      ['claude', U(2)],
      ['codex', U(3)]
    ])
    // limit: 1..200, default 60
    expect(list('abc').sessions).toHaveLength(3)
    expect(list(0).sessions).toHaveLength(2)
  })

  it('reads CLAUDE_CONFIG_DIR and CODEX_HOME, and nothing there is no error', () => {
    expect(list(60)).toEqual({ v: 1, sessions: [] })
    const cfg = join(home, 'cfg')
    fs.mkdirSync(join(cfg, 'projects', 'p'), { recursive: true })
    fs.writeFileSync(join(cfg, 'projects', 'p', `${U(6)}.jsonl`), jsonl([{ type: 'user', cwd: '/a', message: { content: 'From the config dir' } }]))
    const cx = join(home, 'cx')
    fs.mkdirSync(join(cx, 'sessions', '2026', '10', '05'), { recursive: true })
    fs.writeFileSync(join(cx, 'sessions', '2026', '10', '05', 'rollout-x.jsonl'), jsonl([codexMeta(U(7)), { type: 'event_msg', payload: { type: 'user_message', message: 'From CODEX_HOME' } }]))
    const r = list(60, { CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: cx })
    expect(r.sessions.map((s) => s.title).sort()).toEqual(['From CODEX_HOME', 'From the config dir'])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('skips a file it cannot read', () => {
    const bad = claudeFile(U(8), [{ type: 'user', cwd: '/a', message: { content: 'Hidden' } }], T)
    claudeFile(U(9), [{ type: 'user', cwd: '/a', message: { content: 'Visible' } }], T - 1)
    fs.chmodSync(bad, 0)
    expect(list(60).sessions.map((s) => s.title)).toEqual(['Visible'])
  })

  it('the command prints one JSON line', async () => {
    claudeFile(U(1), [{ type: 'user', cwd: '/srv/app', message: { content: 'Hello' } }], T)
    const out = await new Promise((done) => {
      const child = spawn(process.execPath, [SHIM, 'sessions', '5'], { env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''
      child.stdout.on('data', (d) => (text += d))
      child.on('exit', (code) => done({ code, text }))
    })
    expect(out.code).toBe(0)
    expect(out.text.endsWith('\n')).toBe(true)
    expect(out.text.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(out.text).sessions.map((s) => s.title)).toEqual(['Hello'])
  })
})
