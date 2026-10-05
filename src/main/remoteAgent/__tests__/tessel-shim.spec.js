// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'module'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import net from 'net'
import { join, resolve } from 'path'

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
