import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import * as cli from '../tessel'
import * as server from '../../main/cliServer'
import { createAskpassPipeHost } from '../../main/askpassPipeHost'
import { buildAskpass, findCsc } from '../../../scripts/build-askpass.mjs'

const {
  EXIT,
  NotRunning,
  buildRequest,
  formatStatus,
  formatUsage,
  parseArgs,
  readRuntime,
  resolveTarget,
  run,
  sendRequest,
  setLocale,
  startTessel,
  tr
} = cli

beforeEach(() => setLocale('en'))

describe('the command and the app agree on the protocol', () => {
  it('same constants', () => {
    for (const k of ['CLI_PROTOCOL', 'MAX_REQUEST_BYTES', 'MAX_REPLY_BYTES', 'RUNTIME_FILE', 'TOKEN_FILE']) expect(cli[k]).toBe(server[k])
  })

  it('the command is self-contained (bundled alone, unpacked)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'tessel.js'), 'utf8')
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    expect(imports.every((m) => m.startsWith('node:'))).toBe(true)
  })
})

describe('parseArgs', () => {
  it('reads commands, values and flags', () => {
    expect(parseArgs(['new', '--agent', 'claude', '--model=opus', '--json'])).toEqual({
      cmd: 'new',
      args: [],
      opts: { agent: 'claude', model: 'opus', json: true }
    })
    expect(parseArgs(['task', 'add', 'Fix', 'it', '--note', 'why'])).toEqual({ cmd: 'task', args: ['add', 'Fix', 'it'], opts: { note: 'why' } })
    expect(parseArgs(['--no-start', 'status']).opts.start).toBe(false)
    expect(parseArgs(['-h']).opts.help).toBe(true)
    expect(parseArgs(['task', 'add', '--', '--not-an-option']).args).toEqual(['add', '--not-an-option'])
  })

  it('refuses unknown options and missing values', () => {
    expect(() => parseArgs(['--yolo'])).toThrow(/Unknown option/)
    expect(() => parseArgs(['new', '--agent'])).toThrow(/needs a value/)
  })
})

describe('buildRequest', () => {
  const cwd = 'C:\\work\\proj'
  const exists = (p) => ['C:\\work\\proj', 'C:\\work\\proj\\src\\a.js', 'C:\\work\\other'].includes(p)

  it('tessel . and tessel <folder> open a project; auto-start allowed', () => {
    expect(buildRequest(parseArgs(['.']), cwd, exists)).toEqual({ method: 'open', params: { path: 'C:\\work\\proj' }, autoStart: true })
    expect(buildRequest(parseArgs(['..\\other']), cwd, exists).params.path).toBe('C:\\work\\other')
    expect(buildRequest(parseArgs(['open']), cwd, exists).params.path).toBe('C:\\work\\proj')
  })

  it('a file with :line:col', () => {
    expect(buildRequest(parseArgs(['open', 'src\\a.js:12:3']), cwd, exists).params).toEqual({ path: 'C:\\work\\proj\\src\\a.js', line: 12, col: 3 })
    expect(buildRequest(parseArgs(['src\\a.js', '--line', '7']), cwd, exists).params).toEqual({ path: 'C:\\work\\proj\\src\\a.js', line: 7 })
    expect(() => buildRequest(parseArgs(['open', 'nope.js']), cwd, exists)).toThrow(/Not found/)
    expect(() => buildRequest(parseArgs(['src\\a.js', '--line', 'x']), cwd, exists)).toThrow(/--line/)
  })

  it('new sends the folder you are in', () => {
    expect(buildRequest(parseArgs(['new', '--agent', 'codex', '--model', 'gpt-5']), cwd, exists)).toEqual({
      method: 'new',
      params: { cwd, agent: 'codex', model: 'gpt-5' },
      autoStart: true
    })
  })

  it('task add and the read-only commands do not start Tessel by themselves', () => {
    expect(buildRequest(parseArgs(['task', 'add', 'Write', 'docs', '--note', 'n']), cwd, exists)).toEqual({
      method: 'task.add',
      params: { title: 'Write docs', cwd, note: 'n' },
      autoStart: false
    })
    expect(buildRequest(parseArgs(['status']), cwd, exists).autoStart).toBe(false)
    expect(buildRequest(parseArgs(['usage']), cwd, exists).autoStart).toBe(false)
    expect(() => buildRequest(parseArgs(['task', 'add']), cwd, exists)).toThrow(/title/)
    expect(() => buildRequest(parseArgs(['task', 'rm', 'x']), cwd, exists)).toThrow(/Unknown command/)
    expect(() => buildRequest(parseArgs(['frobnicate']), cwd, exists)).toThrow(/Unknown command/)
  })

  it('nothing types into a terminal: no such command exists', () => {
    for (const c of ['send', 'write', 'type', 'worker', 'orchestration', 'approve']) {
      expect(() => buildRequest(parseArgs([c, 'x']), cwd, () => false)).toThrow(/Unknown command/)
    }
  })
})

describe('resolveTarget', () => {
  it('prefers the path as it is when it exists', () => {
    expect(resolveTarget('C:\\a:1', 'C:\\', (p) => p === 'C:\\a:1')).toEqual({ path: 'C:\\a:1', line: null, col: null })
  })
})

describe('readRuntime', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-cli-rt-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('needs a live pid, a well-formed pipe and token', () => {
    const pipe = '\\\\.\\pipe\\tessel-cli-' + 'f'.repeat(32)
    fs.writeFileSync(path.join(dir, 'cli-runtime.json'), JSON.stringify({ pipe, pid: 77, locale: 'fr' }))
    fs.writeFileSync(path.join(dir, 'cli.token'), 'c'.repeat(64))
    expect(readRuntime(dir, { alive: () => true })).toMatchObject({ pipe, token: 'c'.repeat(64), locale: 'fr' })
    expect(readRuntime(dir, { alive: () => false })).toBeNull()
    fs.writeFileSync(path.join(dir, 'cli-runtime.json'), JSON.stringify({ pipe: '\\\\.\\pipe\\evil', pid: 77 }))
    expect(readRuntime(dir, { alive: () => true })).toBeNull()
  })
})

describe('run', () => {
  const runtime = { pipe: 'p', token: 't', pid: 1, locale: 'en', appVersion: '1.5.0' }
  const io = () => {
    const o = { out: [], err: [] }
    o.deps = { out: (s) => o.out.push(s), err: (s) => o.err.push(s), cwd: 'C:\\w', env: {}, exists: () => true }
    return o
  }

  it('status when Tessel is not running: a clear message, exit 3, nothing started', async () => {
    const o = io()
    const start = vi.fn()
    const code = await run(['status'], { ...o.deps, read: () => null, start })
    expect(code).toBe(EXIT.notRunning)
    expect(o.err.join('\n')).toMatch(/Tessel is not running.*--start/)
    expect(start).not.toHaveBeenCalled()
  })

  it('open starts Tessel when it is not running, then sends', async () => {
    const o = io()
    const start = vi.fn(async () => runtime)
    const send = vi.fn(async () => ({ ok: true, result: { kind: 'folder', project: 'w' } }))
    const code = await run(['.'], { ...o.deps, read: () => null, start, send })
    expect(code).toBe(EXIT.ok)
    expect(start).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(runtime, 'open', { path: 'C:\\w' })
    expect(o.out).toEqual(['Opened the project w.'])
  })

  it('--no-start keeps it closed', async () => {
    const o = io()
    const start = vi.fn()
    expect(await run(['focus', '--no-start'], { ...o.deps, read: () => null, start })).toBe(EXIT.notRunning)
    expect(start).not.toHaveBeenCalled()
  })

  it('a refused token asks to register the command again', async () => {
    const o = io()
    const send = async () => ({ ok: false, error: { code: 'unauthorized', message: 'x' } })
    expect(await run(['status'], { ...o.deps, read: () => runtime, send })).toBe(EXIT.failed)
    expect(o.err[0]).toMatch(/register it again/)
  })

  it('follows Tessel’s language', async () => {
    const o = io()
    await run(['focus'], { ...o.deps, read: () => ({ ...runtime, locale: 'fr' }), send: async () => ({ ok: true, result: {} }) })
    expect(o.out).toEqual(['Tessel est au premier plan.'])
  })

  it('--json prints the result', async () => {
    const o = io()
    await run(['status', '--json'], { ...o.deps, read: () => runtime, send: async () => ({ ok: true, result: { projects: [] } }) })
    expect(JSON.parse(o.out[0])).toEqual({ projects: [] })
  })

  it('help and usage errors', async () => {
    const o = io()
    expect(await run([], { ...o.deps, read: () => null })).toBe(EXIT.ok)
    expect(o.out[0]).toMatch(/Usage: tessel/)
    expect(await run(['--bogus'], { ...o.deps, read: () => null })).toBe(EXIT.usage)
  })
})

describe('startTessel', () => {
  it('starts the installed app as from the Start menu (its folder, a clean environment), and waits for its pipe', async () => {
    const spawnImpl = vi.fn(() => ({ on() {}, unref() {} }))
    let reads = 0
    const rt = await startTessel(
      { TESSEL_CLI_APP: 'C:\\P\\Tessel.exe', ELECTRON_RUN_AS_NODE: '1', TESSEL_CLI_USER_DATA: 'u', PATH: 'x', NODE_OPTIONS: '--require evil', systemroot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' },
      'u',
      { spawnImpl, wait: async () => {}, read: () => (++reads > 2 ? { pipe: 'p' } : null) }
    )
    expect(rt).toEqual({ pipe: 'p' })
    const [file, args, opts] = spawnImpl.mock.calls[0]
    expect(file).toBe('C:\\P\\Tessel.exe')
    expect(args).toEqual([])
    expect(opts.env).toEqual({ SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me', TESSEL_STARTED_BY_CLI: '1' })
    expect(opts.cwd).toBe('C:\\P')
    expect(opts.detached).toBe(true)
  })

  it('the dev build is not started', async () => {
    await expect(startTessel({}, 'u')).rejects.toBeInstanceOf(NotRunning)
  })
})

describe('output', () => {
  it('status', () => {
    const text = formatStatus({
      version: '1.5.0',
      projects: [
        { name: 'tessel', path: 'C:\\Tessel', active: true, panes: [{ name: 'Ada', kind: 'agent', title: 'Claude Code', state: 'working', active: true }, { num: 2, kind: 'terminal', title: 'PowerShell' }] },
        { name: 'other', path: 'D:\\o', panes: [] }
      ]
    })
    expect(text).toContain('2 projects, 2 panes')
    expect(text).toContain('* tessel  C:\\Tessel')
    expect(text).toMatch(/Ada\s+agent\s+Claude Code {2}\[working\] {2}\(active\)/)
    expect(formatStatus({ projects: [] })).toBe('No project is open.')
  })

  it('usage', () => {
    const text = formatUsage({ agents: [{ id: 'claude', windows: [{ label: '5h', usedPct: 42.4 }] }, { id: 'codex', windows: [], error: 'No data' }] })
    expect(text).toContain('claude:')
    expect(text).toMatch(/5h\s+42%/)
    expect(text).toContain('codex: No data')
  })

  it('French words', () => {
    setLocale('fr-CA')
    expect(tr('Tessel is not running.')).toBe('Tessel n’est pas ouvert.')
  })
})

// End to end over a real local pipe: the app's server (with Node's net in
// place of the helper) and the command's client.
describe.runIf(process.platform === 'win32')('over a real pipe', () => {
  let dir
  let srv
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-cli-e2e-'))
  })
  afterEach(() => {
    if (srv) srv.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('answers with the token, refuses without it', async () => {
    const focus = vi.fn(async () => ({ focused: true }))
    srv = server.createCliServer({ userData: dir, netApi: net, handlers: { focus, ping: async () => ({ pong: 1 }) }, info: () => ({ locale: 'en' }) })
    expect(await srv.start()).toBe(true)
    const rt = readRuntime(dir)
    expect(rt).not.toBeNull()
    await expect(sendRequest(rt, 'ping', {})).resolves.toEqual({ ok: true, result: { pong: 1 } })
    const bad = await sendRequest({ ...rt, token: '0'.repeat(64) }, 'focus', {})
    expect(bad.error.code).toBe('unauthorized')
    expect(focus).not.toHaveBeenCalled()
    srv.stop()
    srv = null
    expect(readRuntime(dir)).toBeNull()
    await expect(sendRequest(rt, 'ping', {}, { timeoutMs: 3000 })).rejects.toBeInstanceOf(NotRunning)
  })
})

// As in the app: the pipe served by Tessel's helper (current user only).
describe.runIf(process.platform === 'win32' && !!findCsc())('over the helper’s pipe', () => {
  let dir
  let exe
  let srv
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-cli-helper-'))
    const res = buildAskpass(path.join(dir, 'tessel-askpass.exe'))
    exe = res.ok ? res.file : null
  }, 60_000)
  afterEach(() => {
    if (srv) srv.stop()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  })

  it('serves tessel-cli-… pipes and carries requests and answers', async () => {
    expect(exe).toBeTruthy()
    const task = vi.fn(async (p) => ({ id: 't', title: p.title, project: 'x' }))
    srv = server.createCliServer({ userData: dir, netApi: createAskpassPipeHost({ exePath: () => exe }), handlers: { 'task.add': task } })
    expect(await srv.start()).toBe(true)
    const rt = readRuntime(dir)
    const note = ['ligne 1', 'ligne 2'].join('\n')
    const ok = await sendRequest(rt, 'task.add', { title: 'Café ☕ docs', note })
    expect(ok).toEqual({ ok: true, result: { id: 't', title: 'Café ☕ docs', project: 'x' } })
    expect(task).toHaveBeenCalledWith({ title: 'Café ☕ docs', note, cwd: null })
    const bad = await sendRequest({ ...rt, token: '1'.repeat(64) }, 'task.add', { title: 'x' })
    expect(bad.error.code).toBe('unauthorized')
    expect(task).toHaveBeenCalledTimes(1)
  }, 30_000)
})
