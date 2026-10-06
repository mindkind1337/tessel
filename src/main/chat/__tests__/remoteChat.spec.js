// @vitest-environment node
// Chats on an SSH host: the remoteSpawn adapter (remoteProcess.js), the
// claude / codex adapters over it, and the session manager's remote path.
// No SSH anywhere: the transport is a fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { adaptRemoteChild, remoteSpawnFor, cleanRemoteEnv, validRemotePath, provideRemoteSpawn, remoteSpawnAvailable, currentRemoteSpawn } from '../remoteProcess'
import { createClaudeChat } from '../claudeChat'
import { codexUserInput } from '../codexChat'
import { createChatSessions, remoteFolder, remoteAgentEnv } from '../sessions'
import { trustKey } from '../chatTrust'

const flush = () => new Promise((r) => setImmediate(r))
const SID = '11111111-2222-4333-8444-555555555555'
const HOST = 'ssh-box1'

// A transport child: what remoteSpawn returns (stdin with a 1-arg write, like
// sshRemote's channel child).
function fakeRaw() {
  const raw = new EventEmitter()
  raw.stdout = new PassThrough()
  raw.stderr = new PassThrough()
  raw.written = []
  raw.stdin = Object.assign(new EventEmitter(), {
    write(d) {
      raw.written.push(String(d))
      return true
    },
    end: vi.fn()
  })
  raw.kill = vi.fn(() => true)
  return raw
}

describe('remoteProcess', () => {
  afterEach(() => provideRemoteSpawn(null))

  it('says when no transport is there, and uses one handed in', () => {
    expect(currentRemoteSpawn()).toBe(null)
    expect(remoteSpawnAvailable()).toBe(false)
    const fn = vi.fn()
    provideRemoteSpawn(fn)
    expect(remoteSpawnAvailable()).toBe(true)
    expect(currentRemoteSpawn()).toBe(fn)
  })

  it('refuses a bad host, a Windows or relative path, and an unavailable transport', () => {
    expect(() => remoteSpawnFor({ hostId: 'box', cwd: '/home/me' })).toThrow()
    expect(() => remoteSpawnFor({ hostId: HOST, cwd: 'C:\\code' })).toThrow()
    expect(() => remoteSpawnFor({ hostId: HOST, cwd: 'code' })).toThrow()
    const spawn = remoteSpawnFor({ hostId: HOST, cwd: '/home/me/app', spawnRemote: null })
    expect(() => spawn('/usr/bin/claude', [])).toThrow(expect.objectContaining({ code: 'remote-unavailable' }))
    expect(validRemotePath('~/app')).toBe(true)
    expect(validRemotePath('/a\nb')).toBe(false)
  })

  it('passes the remote values through, never the adapter\'s local options', () => {
    const raw = fakeRaw()
    const spawnRemote = vi.fn(() => raw)
    const spawn = remoteSpawnFor({ hostId: HOST, cwd: '/home/me/app', env: { A: '1', 'BAD NAME': 'x', B: 'a\nb', C: 3 }, spawnRemote })
    spawn('/home/me/.local/bin/claude', ['-p', '--resume', SID], { cwd: 'C:\\local', env: { PATH: 'C:\\Windows' } })
    expect(spawnRemote).toHaveBeenCalledWith({ hostId: HOST, command: '/home/me/.local/bin/claude', args: ['-p', '--resume', SID], cwd: '/home/me/app', env: { A: '1' } })
    expect(cleanRemoteEnv({ OK_1: 'v', '1X': 'v' })).toEqual({ OK_1: 'v' })
  })

  it('adapts the child: streams with setEncoding, write callbacks, exit then close, kill', async () => {
    const raw = fakeRaw()
    const child = adaptRemoteChild(raw)
    child.stdout.setEncoding('utf8')
    const got = []
    child.stdout.on('data', (d) => got.push(d))
    raw.stdout.write('{"a":1}\n')
    const cb = vi.fn()
    child.stdin.write('hello\n', cb)
    await flush()
    expect(cb).toHaveBeenCalledWith(null)
    expect(raw.written).toEqual(['hello\n'])
    expect(got.join('')).toBe('{"a":1}\n')
    const order = []
    child.on('exit', (code) => order.push(['exit', code]))
    child.on('close', () => order.push(['close']))
    child.kill('SIGTERM')
    expect(raw.kill).toHaveBeenCalledWith('SIGTERM')
    raw.emit('exit', 0, null)
    await flush()
    expect(order).toEqual([['exit', 0], ['close']])
    expect(child.exitCode).toBe(0)
    expect(child.disconnected).toBe(false)
    const late = vi.fn()
    child.stdin.write('x', late)
    await flush()
    expect(late.mock.calls[0][0]).toBeInstanceOf(Error)
  })

  it('tells a lost connection apart (event, signal or error code)', async () => {
    for (const lose of [(r) => r.emit('disconnected'), (r) => r.emit('exit', null, 'disconnected'), (r) => r.emit('error', Object.assign(new Error('x'), { code: 'lost' }))]) {
      const raw = fakeRaw()
      raw.pid = 7
      const child = adaptRemoteChild(raw)
      const exits = []
      child.on('exit', (...a) => exits.push(a))
      lose(raw)
      expect(child.disconnected).toBe(true)
      expect(exits.length).toBe(1)
    }
  })
})

describe('claudeChat over a remote child', () => {
  it('starts with the stream-json arguments, answers can_use_tool over stdio, and reports a disconnect', async () => {
    const raw = fakeRaw()
    raw.pid = 42
    const spawnRemote = vi.fn(() => raw)
    // The fake CLI: answers initialize; asks one permission.
    raw.stdin.write = (d) => {
      for (const line of String(d).split('\n').filter(Boolean)) {
        const m = JSON.parse(line)
        if (m.type === 'control_request' && m.request.subtype === 'initialize')
          raw.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [], models: [], account: { tokenSource: 'claude.ai' } } } }) + '\n')
        raw.written.push(m)
      }
      return true
    }
    const chat = createClaudeChat({
      exe: '/home/me/.local/bin/claude',
      cwd: '/home/me/app',
      env: { TESSEL_PANE_ID: 'p' },
      resume: SID,
      spawn: remoteSpawnFor({ hostId: HOST, cwd: '/home/me/app', env: { TESSEL_PANE_ID: 'p' }, spawnRemote }),
      killTree: async (c) => c.kill('SIGTERM'),
      timeouts: { start: 2000, control: 2000, exitFlush: 0 }
    })
    const r = await chat.start()
    expect(r.ok).toBe(true)
    const call = spawnRemote.mock.calls[0][0]
    expect(call.command).toBe('/home/me/.local/bin/claude')
    expect(call.cwd).toBe('/home/me/app')
    expect(call.args).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--resume', SID]))
    // Images go inline as base64 blocks.
    const sentOk = await chat.send({ text: 'look', images: [{ mime: 'image/png', base64: () => 'AAAA' }] })
    expect(sentOk.ok).toBe(true)
    const user = raw.written.find((m) => m.type === 'user')
    expect(user.message.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } })
    const perms = []
    chat.on('permission', (p) => perms.push(p))
    raw.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'perm1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } }) + '\n')
    await flush()
    expect(perms.length).toBe(1)
    await chat.answerPermission('perm1', { behavior: 'allow' })
    expect(raw.written.find((m) => m.type === 'control_response' && m.response.request_id === 'perm1').response.response.behavior).toBe('allow')
    const exit = new Promise((res) => chat.once('exit', res))
    raw.emit('disconnected')
    const e = await exit
    expect(e.disconnected).toBe(true)
    expect(e.crashed).toBe(false)
  })

  it('a missing transport is a start failure, never a throw', async () => {
    const chat = createClaudeChat({ exe: '/usr/bin/claude', cwd: '/srv', env: {}, sessionId: SID, spawn: remoteSpawnFor({ hostId: HOST, cwd: '/srv', spawnRemote: null }) })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'spawn' })
  })
})

describe('codex images on a host', () => {
  it('go inline as data URLs, never as this PC\'s paths', () => {
    const img = { path: 'C:\\Users\\me\\img.png', mime: 'image/png', base64: () => 'QUJD' }
    expect(codexUserInput('hi', [img])).toEqual([{ type: 'text', text: 'hi', text_elements: [] }, { type: 'localImage', path: img.path }])
    expect(codexUserInput('hi', [img], { inline: true })[1]).toEqual({ type: 'image', url: 'data:image/png;base64,QUJD' })
  })
})

describe('trust keys of host folders', () => {
  it('keep the case and the POSIX path', () => {
    expect(trustKey('ssh://ssh-box1/home/Me/App')).toBe('ssh://ssh-box1/home/Me/App')
    expect(trustKey('ssh://ssh-box1/home/Me/App\\src')).toBe('ssh://ssh-box1/home/Me/App/src')
    expect(trustKey('ssh://nothost/x')).toBe(null)
  })
})

// ---- the session manager ------------------------------------------------------

class FakeAdapter extends EventEmitter {
  constructor(opts, startResult) {
    super()
    this.opts = opts
    this.start = vi.fn(async () => startResult)
    this.send = vi.fn(async () => ({ ok: true }))
    this.close = vi.fn(async () => this.emit('exit', { code: 0, signal: null, stderrTail: '', crashed: false }))
  }
}

describe('chat sessions on an SSH host', () => {
  let tmp, adapters, sent, deps, remote
  const paneId = 'pane-r1'
  const cwd = `ssh://${HOST}/home/me/app`
  const events = (type) => sent.filter((e) => !type || e.event.type === type).map((e) => e.event)

  beforeEach(() => {
    tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-remote-chat-'))
    adapters = []
    sent = []
    remote = {
      available: vi.fn(() => true),
      spawnFor: vi.fn(() => vi.fn()),
      resolveAgent: vi.fn(async (agent) => ({ exe: agent === 'codex' ? '/usr/local/bin/codex' : '/home/me/.local/bin/claude' })),
      readAgentFile: vi.fn(async () => ({ ok: false, missing: true })),
      hostLabel: () => 'Box'
    }
    deps = {
      dir: tmp,
      send: vi.fn((channel, payload) => sent.push({ channel, ...payload })),
      createAdapter: vi.fn((opts) => {
        const a = new FakeAdapter(opts, { ok: true, pid: null, info: { threadId: 'thread-123456789' } })
        adapters.push(a)
        return a
      }),
      resolveClaude: vi.fn(async () => ({ exe: 'C:\\bin\\claude.exe' })),
      env: { forPane: vi.fn(() => ({ PATH: 'C:\\Windows', CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude' })) },
      team: { newSecret: vi.fn(() => 'f'.repeat(64)), setSecret: vi.fn(), revokeSecret: vi.fn() },
      state: { register: vi.fn(async () => {}), unregister: vi.fn(async () => {}), recordChatEvent: vi.fn(async () => {}), observe: vi.fn(async () => {}) },
      trust: { isTrusted: vi.fn(() => true), ask: vi.fn(async () => true) },
      onRateLimit: vi.fn(),
      remote
    }
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('parses host folders and builds the host env from Settings variables only', () => {
    expect(remoteFolder(`ssh://${HOST}/home/me/app\\src`)).toEqual({ hostId: HOST, path: '/home/me/app/src', root: `ssh://${HOST}/home/me/app/src` })
    expect(remoteFolder('C:\\code')).toBe(null)
    expect(remoteAgentEnv({ paneId: 'p', agent: 'claude', extraEnv: { PATH: 'C:\\x', FOO: 'bar', TESSEL_TEAM_SECRET: 'x' } })).toEqual({ FOO: 'bar', TESSEL_PANE_ID: 'p', TESSEL_AGENT_PROVIDER: 'claude' })
  })

  it('spawns Claude on the host in the host path, with the host env, never this PC\'s', async () => {
    const chat = createChatSessions(deps)
    const r = await chat.open({ paneId, cwd, projectDir: cwd, permissions: 'manual', envOpts: { extraEnv: { FOO: 'bar' }, accountEnv: { CLAUDE_CONFIG_DIR: 'C:\\acc' } } })
    expect(r.ok).toBe(true)
    expect(deps.resolveClaude).not.toHaveBeenCalled()
    expect(deps.env.forPane).not.toHaveBeenCalled()
    expect(remote.resolveAgent).toHaveBeenCalledWith('claude', HOST)
    expect(remote.spawnFor).toHaveBeenCalledWith({ hostId: HOST, cwd: '/home/me/app', env: { FOO: 'bar', TESSEL_PANE_ID: paneId, TESSEL_AGENT_PROVIDER: 'claude' } })
    const opts = adapters[0].opts
    expect(opts.exe).toBe('/home/me/.local/bin/claude')
    expect(opts.cwd).toBe('/home/me/app')
    expect(opts.remote).toBe(true)
    expect(typeof opts.spawn).toBe('function')
    expect(opts.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(deps.trust.isTrusted).toHaveBeenCalledWith(cwd, [])
    await chat.close({ paneId })
  })

  it('asks to trust the host folder, and refuses OpenCode and a project on another host', async () => {
    deps.trust.isTrusted = vi.fn(() => false)
    deps.trust.ask = vi.fn(async () => false)
    const chat = createChatSessions(deps)
    const r = await chat.open({ paneId, cwd, permissions: 'manual', askTrust: true })
    expect(r.code).toBe('untrusted')
    expect(deps.trust.ask).toHaveBeenCalledWith(cwd)
    expect((await chat.open({ paneId, cwd, agent: 'opencode', permissions: 'manual' })).code).toBe('invalid')
    expect((await chat.open({ paneId, cwd, projectDir: 'ssh://ssh-other/x', permissions: 'manual' })).code).toBe('invalid')
  })

  it('says so when the transport is not there, or the agent is missing on the host', async () => {
    remote.available = () => false
    const chat = createChatSessions(deps)
    const r = await chat.open({ paneId, cwd, permissions: 'manual' })
    expect(r.code).toBe('remote-unavailable')
    expect(events('status').at(-1)).toMatchObject({ state: 'crashed' })
    remote.available = () => true
    remote.resolveAgent = async () => null
    const r2 = await chat.open({ paneId, cwd, permissions: 'manual' })
    expect(r2.code).toBe('no-claude')
    expect(r2.error).toContain('Box')
    remote.resolveAgent = async () => ({ error: 'not connected' })
    expect((await chat.open({ paneId, cwd, permissions: 'manual' })).code).toBe('remote-unreachable')
  })

  it('resumes: earlier turns read from the host file; a never-written id starts again', async () => {
    const line = (o) => JSON.stringify(o)
    const file = [
      line({ type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'hello there' } }),
      line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:00:01Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi!' }] } })
    ].join('\n') + '\n'
    remote.readAgentFile = vi.fn(async (_h, q) => {
      const buf = Buffer.from(file)
      if (q.offset === null) return { ok: true, size: buf.length, data: buf.subarray(Math.max(0, buf.length - q.cap)) }
      return { ok: true, size: buf.length, data: buf.subarray(q.offset, q.offset + q.cap) }
    })
    const chat = createChatSessions(deps)
    const r = await chat.open({ paneId, cwd, resumeId: SID, permissions: 'manual' })
    expect(r.ok).toBe(true)
    expect(adapters[0].opts.resume).toBe(SID)
    const hist = events('history')[0]
    expect(hist.events.map((e) => e.event.type)).toEqual(expect.arrayContaining(['notice', 'user', 'assistant']))
    await chat.close({ paneId })

    remote.readAgentFile = vi.fn(async () => ({ ok: false, missing: true }))
    const chat2 = createChatSessions({ ...deps, dir: fs.mkdtempSync(join(tmp, 'b-')) })
    await chat2.open({ paneId: 'pane-r2', cwd, resumeId: SID, permissions: 'manual' })
    expect(adapters[1].opts.sessionId).toBe(SID)
    expect(adapters[1].opts.resume).toBeUndefined()
    await chat2.close({ paneId: 'pane-r2' })
  })

  it('Codex on a host: its thread, no folder pre-trust, inline images flag; limits never told', async () => {
    const preTrust = vi.fn()
    const chat = createChatSessions({ ...deps, preTrust })
    const r = await chat.open({ paneId, cwd, agent: 'codex', permissions: 'manual' })
    expect(r.ok).toBe(true)
    expect(preTrust).not.toHaveBeenCalled()
    expect(adapters[0].opts).toMatchObject({ exe: '/usr/local/bin/codex', cwd: '/home/me/app', remote: true })
    adapters[0].emit('rateLimit', { limits: [] })
    expect(deps.onRateLimit).not.toHaveBeenCalled()
    await chat.close({ paneId })
  })

  it('a lost connection: told in the chat, asleep, and the next message wakes it on the same conversation', async () => {
    const chat = createChatSessions(deps)
    await chat.open({ paneId, cwd, permissions: 'manual' })
    await flush()
    const sid = adapters[0].opts.sessionId
    adapters[0].emit('exit', { code: null, signal: 'disconnected', disconnected: true, crashed: false })
    expect(events('notice').at(-1)).toMatchObject({ kind: 'warning' })
    expect(events('status').at(-1)).toMatchObject({ state: 'asleep', reason: 'disconnected' })
    expect(events('status').some((e) => e.state === 'crashed')).toBe(false)
    const s = chat.send({ paneId, text: "still there?" })
    expect(s.ok).toBe(true)
    expect(events('wake').length).toBe(1)
    // The window opens it again (chat:open): the same conversation, resumed.
    remote.readAgentFile = vi.fn(async () => ({ ok: true, size: 0, data: Buffer.alloc(0) }))
    const r = await chat.open({ paneId, cwd, permissions: 'manual' })
    expect(r.ok).toBe(true)
    expect(adapters[1].opts.resume).toBe(sid)
    await chat.close({ paneId })
  })
})
