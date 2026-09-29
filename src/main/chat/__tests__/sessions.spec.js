// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createChatSessions, teamTurnText, teamMessageText, LIMITS } from '../sessions'
import { createAgentStateStore } from '../../agentStateStore'

const flush = () => new Promise((r) => setImmediate(r))

class FakeAdapter extends EventEmitter {
  constructor(opts, startResult) {
    super()
    this.opts = opts
    this.start = vi.fn(async () => startResult)
    this.send = vi.fn(async () => ({ ok: true }))
    this.interrupt = vi.fn(async () => ({ ok: true }))
    this.answerPermission = vi.fn(async () => ({ ok: true }))
    this.setModel = vi.fn(async () => ({ ok: true }))
    this.setEffort = vi.fn(async () => ({ ok: true }))
    this.setPermissionMode = vi.fn(async () => ({ ok: true }))
    this.close = vi.fn(async () => {
      this.emit('exit', { code: 0, signal: null, stderrTail: '', crashed: false })
    })
  }
}

let tmp, deps, adapters, stateCalls, startResult, sent
const paneId = 'pane-1'

function makeDeps(extra = {}) {
  stateCalls = []
  const state = {
    register: vi.fn(async (r) => stateCalls.push(['register', r.provider])),
    unregister: vi.fn(async () => stateCalls.push(['unregister'])),
    recordChatEvent: vi.fn(async (_p, _t, name, x = {}) =>
      stateCalls.push([name, ...(x.notificationType ? [x.notificationType] : []), ...(x.toolId ? [x.toolId] : [])])
    ),
    observe: vi.fn(async (_p, _t, name) => stateCalls.push(['observe', name]))
  }
  return {
    dir: tmp,
    send: vi.fn((channel, payload) => sent.push({ channel, ...payload })),
    createAdapter: vi.fn((opts) => {
      const a = new FakeAdapter(opts, startResult)
      adapters.push(a)
      return a
    }),
    resolveClaude: vi.fn(async () => ({ exe: 'C:\\bin\\claude.exe', exeArgs: [] })),
    env: {
      forPane: vi.fn(() => ({
        Path: 'C:\\Windows',
        TESSEL_PANE_ID: 'someone-else',
        TESSEL_AGENT_PROVIDER: 'codex',
        TESSEL_AGENT_LAUNCH: 'x',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts'
      }))
    },
    team: { newSecret: vi.fn(() => 'f'.repeat(64)), setSecret: vi.fn(), revokeSecret: vi.fn() },
    state,
    trust: { isTrusted: vi.fn(() => true), ask: vi.fn(async () => true), trust: vi.fn(() => true) },
    ...extra
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-chat-sessions-'))
  adapters = []
  sent = []
  startResult = { ok: true, pid: 1, info: {} }
  deps = makeDeps()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const events = (type) => sent.filter((e) => !type || e.event.type === type).map((e) => e.event)
const last = (type) => events(type).at(-1)
const openOk = async (chat, extra = {}) => {
  const r = await chat.open({ paneId, cwd: tmp, permissions: 'manual', ...extra })
  expect(r.ok).toBe(true)
  await flush()
  return r
}

describe('open', () => {
  it('refuses an untrusted folder without asking, and starts nothing', async () => {
    deps.trust.isTrusted.mockReturnValue(false)
    const chat = createChatSessions(deps)
    const r = await chat.open({ paneId, cwd: tmp, permissions: 'manual' })
    expect(r).toMatchObject({ ok: false, code: 'untrusted' })
    expect(deps.trust.ask).not.toHaveBeenCalled()
    expect(deps.createAdapter).not.toHaveBeenCalled()
    expect(last('status')).toMatchObject({ state: 'untrusted' })
  })

  it('asks when told to: yes starts, no refuses', async () => {
    deps.trust.isTrusted.mockReturnValue(false)
    deps.trust.ask.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const chat = createChatSessions(deps)
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', askTrust: true })).toMatchObject({ code: 'untrusted' })
    expect((await chat.open({ paneId, cwd: tmp, permissions: 'manual', askTrust: true })).ok).toBe(true)
    expect(deps.trust.ask).toHaveBeenCalledWith(tmp)
  })

  it('passes the caller trust roots (a worktree of a trusted project)', async () => {
    const trustRoots = vi.fn(() => ['C:\\proj'])
    const chat = createChatSessions({ ...deps, trustRoots })
    await openOk(chat)
    expect(deps.trust.isTrusted).toHaveBeenCalledWith(tmp, ['C:\\proj'])
    // Not a worker: said so to the trust roots.
    expect(trustRoots).toHaveBeenCalledWith(tmp, { worker: false })
  })

  it('a worker open says so to the trust roots (only a worker may inherit its copy\'s project)', async () => {
    const trustRoots = vi.fn(() => [])
    const chat = createChatSessions({ ...deps, trustRoots })
    const h = {}
    chat.register({ handle: (ch, fn) => (h[ch] = (q) => fn({}, q)) })
    expect((await h['chat:open']({ paneId, cwd: tmp, permissions: 'manual', worker: true })).ok).toBe(true)
    expect(trustRoots).toHaveBeenCalledWith(tmp, { worker: true })
    expect((await h['chat:open']({ paneId: 'p2', cwd: tmp, permissions: 'manual', worker: 'yes' })).ok).toBe(true)
    expect(trustRoots).toHaveBeenLastCalledWith(tmp, { worker: false })
  })

  it('maxPermissions manual: a yolo or permissive request starts in default, never bypass or auto', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat, { permissions: 'yolo', maxPermissions: 'manual' })
    expect(adapters[0].opts.permissionMode).toBe('default')
    await openOk(chat, { paneId: 'p2', permissionMode: 'auto', maxPermissions: 'manual' })
    expect(adapters[1].opts.permissionMode).toBe('default')
    await openOk(chat, { paneId: 'p3', permissionMode: 'plan', maxPermissions: 'manual' })
    expect(adapters[2].opts.permissionMode).toBe('plan')
    // Codex: yolo becomes manual.
    const codex = createChatSessions({ ...deps, resolveCodex: async () => ({ exe: 'C:\\bin\\codex.exe' }) })
    await openOk(codex, { paneId: 'p4', agent: 'codex', permissions: 'yolo', maxPermissions: 'manual' })
    expect(adapters[3].opts.permissions).toBe('manual')
    expect((await chat.open({ paneId: 'p5', cwd: tmp, permissions: 'manual', maxPermissions: 'yolo' })).code).toBe('invalid')
  })

  it('maxPermissions manual holds on later mode switches too', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat, { maxPermissions: 'manual' })
    const a = adapters[0]
    expect(await chat.setOption({ paneId, permissionMode: 'auto' })).toMatchObject({ ok: false, permissions: 'manual' })
    expect(await chat.setOption({ paneId, permissionMode: 'bypassPermissions' })).toMatchObject({ ok: false, permissions: 'manual' })
    expect(a.setPermissionMode).not.toHaveBeenCalled()
    expect(await chat.setOption({ paneId, permissionMode: 'acceptEdits' })).toMatchObject({ ok: true, permissionMode: 'acceptEdits', permissions: 'manual' })
    // Uncapped: auto is allowed, and a yolo chat switched down reports manual.
    const free = createChatSessions(deps)
    await openOk(free, { paneId: 'p2', permissions: 'yolo' })
    expect(await free.setOption({ paneId: 'p2', permissionMode: 'auto' })).toMatchObject({ ok: true, permissions: 'manual' })
    expect(await free.setOption({ paneId: 'p2', permissionMode: 'bypassPermissions' })).toMatchObject({ ok: true, permissions: 'yolo' })
  })

  it('no Claude found', async () => {
    deps.resolveClaude.mockResolvedValue(null)
    const chat = createChatSessions(deps)
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual' })).toMatchObject({ ok: false, code: 'no-claude' })
    expect(deps.team.newSecret).not.toHaveBeenCalled()
  })

  it('not signed in: status signin, secret revoked, no agent status registered', async () => {
    startResult = { ok: false, code: 'signin', error: 'tokenSource none' }
    const chat = createChatSessions(deps)
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual' })).toMatchObject({ ok: false, code: 'signin' })
    expect(deps.team.setSecret).toHaveBeenCalled()
    expect(deps.team.revokeSecret).toHaveBeenCalledWith(paneId)
    expect(deps.state.register).not.toHaveBeenCalled()
    expect(last('status')).toMatchObject({ state: 'signin' })
    expect(chat.list()).toEqual([])
    // A later open can start again.
    startResult = { ok: true }
    expect((await chat.open({ paneId, cwd: tmp, permissions: 'manual' })).ok).toBe(true)
  })

  it('other start failures report crashed', async () => {
    startResult = { ok: false, code: 'exit', error: 'boom' }
    const chat = createChatSessions(deps)
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual' })).toMatchObject({ ok: false, code: 'failed', error: 'Claude Code stopped while starting.', detail: 'boom' })
    expect(last('status')).toMatchObject({ state: 'crashed', error: 'Claude Code stopped while starting.', detail: 'boom' })
    startResult = { ok: false, code: 'failed', error: 'x' }
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual' })).toMatchObject({ ok: false, code: 'failed', error: 'The agent could not start.' })
  })

  it('success: own env, secret, agent status, launch token in the result and status', async () => {
    const chat = createChatSessions(deps)
    const r = await openOk(chat, { model: 'sonnet', effort: 'high', projectDir: tmp })
    expect(r).toEqual({ ok: true, agent: 'claude', sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/), launchToken: expect.stringMatching(/^[0-9a-f]{32}$/), model: 'sonnet' })
    const o = adapters[0].opts
    expect(o).toMatchObject({ exe: 'C:\\bin\\claude.exe', exeArgs: [], cwd: tmp, sessionId: r.sessionId, model: 'sonnet', effort: 'high', permissionMode: 'default' })
    expect(o.resume).toBeUndefined()
    expect(o.agent).toBe('claude')
    expect(o.permissions).toBeUndefined()
    expect(o.env).toMatchObject({ TESSEL_PANE_ID: paneId, TESSEL_TEAM_SECRET: 'f'.repeat(64), TESSEL_CHAT: '1', TESSEL_PROJECT_DIR: tmp, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' })
    expect(Object.keys(o.env).filter((k) => /^TESSEL_AGENT_|^CLAUDECODE$|^CLAUDE_CODE_ENTRYPOINT$/i.test(k))).toEqual([])
    expect(deps.team.setSecret).toHaveBeenCalledWith(paneId, 'f'.repeat(64))
    expect(deps.state.register).toHaveBeenCalledWith(expect.objectContaining({ paneId, provider: 'claude', launchToken: r.launchToken }))
    expect(stateCalls).toEqual([['register', 'claude'], ['SessionStart'], ['observe', 'ScreenReady']])
    expect(last('status')).toMatchObject({ state: 'idle', sessionId: r.sessionId, launchToken: r.launchToken, model: 'sonnet' })
    expect(deps.env.forPane).toHaveBeenCalledWith(expect.objectContaining({ paneId, projectDir: tmp }))
  })

  it('permission modes, resume and PATH from the resolver', async () => {
    deps.resolveClaude.mockResolvedValue({ exe: 'C:\\node.exe', exeArgs: ['C:\\cli.js'], pathEnv: 'C:\\bin' })
    const chat = createChatSessions(deps)
    await openOk(chat, { permissions: 'yolo', permissionMode: 'plan' })
    expect(adapters[0].opts).toMatchObject({ permissionMode: 'bypassPermissions', exeArgs: ['C:\\cli.js'] })
    expect(adapters[0].opts.env.PATH).toBe('C:\\bin')
    await chat.close({ paneId })
    const resumeId = '0b8f3c2e-1111-4222-8333-944445555666'
    const r = await openOk(chat, { permissionMode: 'plan', resumeId })
    expect(adapters[1].opts).toMatchObject({ permissionMode: 'plan', resume: resumeId })
    expect(adapters[1].opts.sessionId).toBeUndefined()
    expect(r.sessionId).toBe(resumeId)
    await chat.close({ paneId })
    await openOk(chat, { permissionMode: 'bypassPermissions' })
    expect(adapters[2].opts.permissionMode).toBe('default')
    // The modes a user's own --permission-mode may give (App.vue reads them too).
    for (const mode of ['auto', 'dontAsk', 'acceptEdits']) {
      await chat.close({ paneId })
      await openOk(chat, { permissionMode: mode })
      expect(adapters.at(-1).opts.permissionMode).toBe(mode)
    }
  })

  it('opening a live pane again is harmless (while starting too): one process', async () => {
    let release
    const gate = new Promise((r) => (release = r))
    deps.resolveClaude.mockImplementation(async () => {
      await gate
      return { exe: 'C:\\claude.exe' }
    })
    const chat = createChatSessions(deps)
    const a = chat.open({ paneId, cwd: tmp, permissions: 'manual' })
    const b = chat.open({ paneId, cwd: tmp, permissions: 'manual' })
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(rb).toEqual(ra)
    const rc = await chat.open({ paneId, cwd: tmp, permissions: 'manual' })
    expect(rc).toEqual(ra)
    expect(deps.createAdapter).toHaveBeenCalledTimes(1)
  })

  it('a conversation already open in another pane is busy', async () => {
    const chat = createChatSessions(deps)
    const r = await openOk(chat)
    expect(await chat.open({ paneId: 'pane-2', cwd: tmp, permissions: 'manual', resumeId: r.sessionId })).toMatchObject({ code: 'busy' })
  })

  it('rejects bad options', async () => {
    const chat = createChatSessions(deps)
    for (const bad of [
      { paneId: '..' },
      { cwd: 'relative' },
      { cwd: join(tmp, 'missing') },
      { projectDir: 'rel' },
      { resumeId: 'not-a-uuid' },
      { model: '--dangerously-skip-permissions' },
      { model: 'a b' },
      { effort: 'x'.repeat(61) },
      { permissions: 'all' },
      { permissionMode: 'yolo' },
      { agent: 'gemini' },
      { agent: 'codex', resumeId: '-x' },
      { agent: 'codex', resumeId: 'thread 1' }
    ])
      expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', ...bad })).toMatchObject({ ok: false, code: 'invalid' })
    expect(deps.createAdapter).not.toHaveBeenCalled()
  })
})

describe('delivery', () => {
  it('idle: sent at once; accepted then turn end feed the agent status', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    stateCalls.length = 0
    const r = chat.send({ paneId, text: 'hello' })
    expect(r).toMatchObject({ ok: true, queued: false })
    await flush()
    const a = adapters[0]
    expect(a.send).toHaveBeenCalledWith({ uuid: r.id, text: 'hello' })
    expect(last('user')).toMatchObject({ id: r.id, text: 'hello', origin: 'user', status: 'sent' })
    expect(last('status')).toMatchObject({ state: 'working' })
    a.emit('state', { state: 'running' })
    a.emit('accepted', { uuid: r.id })
    expect(last('userStatus')).toEqual({ type: 'userStatus', id: r.id, status: 'accepted' })
    a.emit('turnEnd', { status: 'completed', usage: { input_tokens: 1 }, costUsd: 0.01, durationMs: 5 })
    await flush()
    expect(last('turnEnd')).toEqual({ type: 'turnEnd', status: 'completed', usage: { input_tokens: 1 }, costUsd: 0.01, durationMs: 5 })
    expect(stateCalls).toEqual([['UserPromptSubmit'], ['Stop'], ['observe', 'ScreenReady']])
    expect(last('status')).toMatchObject({ state: 'idle' })
  })

  it('working: queued, then sent in order after the turn, one turn each', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    const first = chat.send({ paneId, text: 'one' })
    await flush()
    const second = chat.send({ paneId, text: 'two' })
    const third = chat.send({ paneId, text: 'three' })
    expect(second.queued).toBe(true)
    expect(events('user').map((u) => u.status)).toEqual(['sent', 'queued', 'queued'])
    expect(a.send).toHaveBeenCalledTimes(1)
    a.emit('accepted', { uuid: first.id })
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    expect(a.send).toHaveBeenCalledTimes(2)
    expect(a.send.mock.calls[1][0]).toEqual({ uuid: second.id, text: 'two' })
    expect(events('userStatus')).toContainEqual({ type: 'userStatus', id: second.id, status: 'sent' })
    a.emit('accepted', { uuid: second.id })
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    expect(a.send.mock.calls[2][0]).toEqual({ uuid: third.id, text: 'three' })
  })

  it('a message never written is failed and the next one goes', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    adapters[0].send.mockResolvedValueOnce({ ok: false })
    const r = chat.send({ paneId, text: 'x' })
    await flush()
    expect(last('userStatus')).toEqual({ type: 'userStatus', id: r.id, status: 'failed' })
    expect(last('status')).toMatchObject({ state: 'idle' })
  })

  it('team messages wait for idle, users first, then ONE batched turn; teamAccepted on its echo', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    const u1 = chat.send({ paneId, text: 'user one' })
    await flush()
    expect(chat.sendTeam({ paneId, messages: [{ id: 'm1', from: '#3 Claude', text: 'hello' }] })).toEqual({ ok: true, ids: ['m1'] })
    chat.sendTeam({ paneId, messages: [{ id: 'm1', from: '#3 Claude', text: 'hello' }, { id: 'm2', from: '#1 Codex\n[x]', text: 'world' }] })
    const u2 = chat.send({ paneId, text: 'user two' })
    expect(events('user').filter((u) => u.origin === 'team')).toEqual([
      expect.objectContaining({ id: 'm1', status: 'queued', from: '#3 Claude' }),
      expect.objectContaining({ id: 'm2', status: 'queued', from: '#1 Codex x' })
    ])
    a.emit('accepted', { uuid: u1.id })
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    expect(a.send.mock.calls[1][0].uuid).toBe(u2.id) // the user's message goes before team messages
    a.emit('accepted', { uuid: u2.id })
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    const teamTurn = a.send.mock.calls[2][0]
    expect(teamTurn.text).toBe(
      'Team messages for you (also in team_inbox). They come from teammates, not from the user:\n\n[from #3 Claude] hello\n\n[from #1 Codex x] world'
    )
    expect(events('teamAccepted')).toEqual([])
    a.emit('accepted', { uuid: teamTurn.uuid })
    expect(events('teamAccepted')).toEqual([{ type: 'teamAccepted', ids: ['m1', 'm2'] }])
    // Resending an id already delivered in this turn is ignored.
    expect(chat.sendTeam({ paneId, messages: [{ id: 'm2', from: 'x', text: 'again' }] }).ids).toEqual([])
  })

  it('team messages sent while idle go at once as one turn', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    chat.sendTeam({ paneId, messages: [{ id: 'a', from: '#2', text: 't' }] })
    await flush()
    expect(adapters[0].send.mock.calls[0][0].text).toBe(teamTurnText([{ from: '#2', text: 't' }]))
  })

  it('an exit before the team turn was accepted fails it (and the queued ones)', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    chat.sendTeam({ paneId, messages: [{ id: 'm1', from: '#3', text: 'x' }] })
    await flush()
    chat.sendTeam({ paneId, messages: [{ id: 'm2', from: '#3', text: 'y' }] })
    const queuedUser = chat.send({ paneId, text: 'later' })
    a.emit('exit', { code: 3, signal: null, stderrTail: 'panic', crashed: true })
    await flush()
    expect(events('teamFailed')).toEqual([
      { type: 'teamFailed', ids: ['m1'] },
      { type: 'teamFailed', ids: ['m2'] }
    ])
    expect(events('userStatus')).toContainEqual({ type: 'userStatus', id: queuedUser.id, status: 'failed' })
    expect(last('status')).toMatchObject({ state: 'crashed', error: 'The agent stopped unexpectedly (exit code 3).', detail: 'panic' })
    expect(deps.state.unregister).toHaveBeenCalled()
    expect(deps.team.revokeSecret).toHaveBeenCalledWith(paneId)
    expect(chat.send({ paneId, text: 'x' })).toMatchObject({ ok: false, code: 'closed' })
  })

  it('a turn the agent starts by itself shows working and ends idle', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    stateCalls.length = 0
    adapters[0].emit('state', { state: 'running' })
    expect(last('status')).toMatchObject({ state: 'working' })
    const queued = chat.send({ paneId, text: 'wait' })
    expect(queued.queued).toBe(true)
    adapters[0].emit('turnEnd', { status: 'completed' })
    await flush()
    expect(stateCalls.slice(0, 3)).toEqual([['UserPromptSubmit'], ['Stop'], ['observe', 'ScreenReady']])
    expect(adapters[0].send).toHaveBeenCalledWith({ uuid: queued.id, text: 'wait' })
  })
})

describe('stream events', () => {
  it('maps text, thinking, tools and results; subagent text stays out', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    a.emit('textDelta', { messageId: 'm1', index: 0, text: 'Hel' })
    a.emit('textDelta', { messageId: null, text: 'sub', parentToolUseId: 't0' })
    a.emit('assistant', { messageId: 'm1', blocks: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls  -la' } }] })
    a.emit('assistant', { messageId: 'm2', parentToolUseId: 't0', blocks: [{ type: 'text', text: 'inside' }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a' } }] })
    a.emit('toolResult', { toolUseId: 't1', isError: false, text: 'out' })
    a.emit('rateLimit', { status: 'allowed', fiveHour: { utilization: 0.5, resetsAt: 1 }, sevenDay: null })
    expect(events().filter((e) => e.type !== 'status')).toEqual([
      { type: 'assistantDelta', messageId: 'm1', text: 'Hel' },
      { type: 'thinking', messageId: 'm1', text: 'hmm' },
      { type: 'assistant', messageId: 'm1', text: 'Hello' },
      { type: 'tool', id: 't1', name: 'Bash', summary: 'ls -la', input: { command: 'ls  -la' }, status: 'running' },
      { type: 'tool', id: 't2', name: 'Read', summary: 'a', input: { file_path: 'a' }, status: 'running', parentToolUseId: 't0' },
      { type: 'toolResult', id: 't1', isError: false, text: 'out' },
      { type: 'rateLimit', fiveHour: { utilization: 0.5, resetsAt: 1 } }
    ])
    a.emit('turnEnd', { status: 'failed', result: 'API error' })
    expect(events('tool').at(-1)).toEqual({ type: 'tool', id: 't2', status: 'error' })
    expect(last('turnEnd')).toMatchObject({ status: 'failed', error: 'API error' })
  })
})

describe('one frame per block', () => {
  it('merges the blocks of a message', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    a.emit('assistant', { messageId: 'm1', blocks: [{ type: 'thinking', text: 'plan' }] })
    a.emit('assistant', { messageId: 'm1', blocks: [{ type: 'text', text: 'First.' }] })
    a.emit('assistant', { messageId: 'm1', blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] })
    a.emit('assistant', { messageId: 'm1', blocks: [{ type: 'text', text: 'Second.' }] })
    expect(events('assistant')).toEqual([
      { type: 'assistant', messageId: 'm1', text: 'First.' },
      { type: 'assistant', messageId: 'm1', text: 'First.\n\nSecond.' }
    ])
    expect(events('thinking')).toEqual([{ type: 'thinking', messageId: 'm1', text: 'plan' }])
    expect(events('tool')).toHaveLength(1)
  })
})

describe('approvals', () => {
  async function withPermission(chat, requestId = 'req-1') {
    await openOk(chat)
    const a = adapters[0]
    const u = chat.send({ paneId, text: 'do it' })
    await flush()
    a.emit('accepted', { uuid: u.id })
    await flush()
    stateCalls.length = 0
    a.emit('permission', { requestId, toolName: 'Bash', displayName: 'Bash', input: { command: 'rm x' }, description: 'Remove', suggestions: [], toolUseId: 'toolu_9' })
    await flush()
    return a
  }

  it('pending approval feeds the status; allow answers once', async () => {
    const chat = createChatSessions(deps)
    const a = await withPermission(chat)
    expect(last('approval')).toEqual({
      type: 'approval',
      requestId: 'req-1',
      toolName: 'Bash',
      displayName: 'Bash',
      input: { command: 'rm x' },
      detail: 'rm x',
      hidden: 0,
      sessionRules: [],
      description: 'Remove',
      status: 'pending'
    })
    expect(last('status')).toMatchObject({ state: 'approval' })
    expect(stateCalls).toEqual([['PermissionRequest', 'toolu_9'], ['Notification', 'permission_prompt', 'toolu_9']])
    expect(await chat.approve({ paneId, requestId: 'req-1', decision: 'allow' })).toEqual({ ok: true })
    expect(a.answerPermission).toHaveBeenCalledWith('req-1', { behavior: 'allow', session: false })
    expect(last('approvalStatus')).toEqual({ type: 'approvalStatus', requestId: 'req-1', status: 'allowed' })
    expect(last('status')).toMatchObject({ state: 'working' })
    await flush()
    expect(stateCalls.at(-1)).toEqual(['PostToolUse', 'toolu_9'])
    expect(await chat.approve({ paneId, requestId: 'req-1', decision: 'allow' })).toMatchObject({ ok: false, code: 'unknown' })
    expect(await chat.approve({ paneId, requestId: 'nope', decision: 'deny' })).toMatchObject({ ok: false, code: 'unknown' })
    expect(a.answerPermission).toHaveBeenCalledTimes(1)
  })

  it('allow for the session, and deny with the default or given message', async () => {
    const chat = createChatSessions(deps)
    const a = await withPermission(chat)
    await chat.approve({ paneId, requestId: 'req-1', decision: 'allowSession' })
    expect(a.answerPermission).toHaveBeenLastCalledWith('req-1', { behavior: 'allow', session: true })
    expect(last('approvalStatus').status).toBe('allowedSession')
    a.emit('permission', { requestId: 'req-2', toolName: 'Write', input: {} })
    await chat.approve({ paneId, requestId: 'req-2', decision: 'deny' })
    expect(a.answerPermission).toHaveBeenLastCalledWith('req-2', { behavior: 'deny', session: false, message: 'The user denied this.' })
    a.emit('permission', { requestId: 'req-3', toolName: 'Write', input: {} })
    await chat.approve({ paneId, requestId: 'req-3', decision: 'deny', message: 'Use the other file.' })
    expect(a.answerPermission).toHaveBeenLastCalledWith('req-3', { behavior: 'deny', session: false, message: 'Use the other file.' })
    expect(last('approvalStatus')).toEqual({ type: 'approvalStatus', requestId: 'req-3', status: 'denied' })
  })

  it('a failed answer can be tried again; a cancelled request cannot be answered', async () => {
    const chat = createChatSessions(deps)
    const a = await withPermission(chat)
    a.answerPermission.mockResolvedValueOnce({ ok: false, error: 'stdin closed' })
    expect(await chat.approve({ paneId, requestId: 'req-1', decision: 'allow' })).toMatchObject({ ok: false })
    a.emit('permissionCancelled', { requestId: 'req-1' })
    expect(last('approvalStatus')).toEqual({ type: 'approvalStatus', requestId: 'req-1', status: 'cancelled' })
    expect(await chat.approve({ paneId, requestId: 'req-1', decision: 'allow' })).toMatchObject({ ok: false, code: 'unknown' })
  })

  it('a long input: the card gets its start and the hidden count; Allow waits until the whole input was fetched', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    const command = 'echo safe && ' + 'x'.repeat(20000) + ' && rm -rf C:\\'
    a.emit('permission', { requestId: 'big', toolName: 'Bash', input: { command }, sessionRules: [{ kind: 'rule', tool: 'Bash', content: 'echo:*' }] })
    const ev = last('approval')
    expect(ev.detail).toBe(command.slice(0, 8000))
    expect(ev.hidden).toBe(command.length - 8000)
    expect(ev.sessionRules).toEqual([{ kind: 'rule', tool: 'Bash', content: 'echo:*' }])
    // Not seen: allow is refused (deny is not).
    expect(await chat.approve({ paneId, requestId: 'big', decision: 'allow' })).toMatchObject({ ok: false, code: 'unseen' })
    expect(await chat.approve({ paneId, requestId: 'big', decision: 'allowSession' })).toMatchObject({ ok: false, code: 'unseen' })
    expect(a.answerPermission).not.toHaveBeenCalled()
    expect(chat.approvalInput({ paneId, requestId: 'nope' })).toMatchObject({ ok: false, code: 'unknown' })
    expect(chat.approvalInput({ paneId, requestId: 'big' })).toEqual({ ok: true, input: { command } })
    expect(await chat.approve({ paneId, requestId: 'big', decision: 'allow' })).toEqual({ ok: true })
    // Answered: the input is no longer kept.
    expect(chat.approvalInput({ paneId, requestId: 'big' })).toMatchObject({ ok: false })
    // The journal keeps the preview and its count whole.
    const stored = chat.history({ paneId }).events.find((e) => e.event.type === 'approval').event
    expect(stored.detail).toBe(command.slice(0, 8000))
    expect(stored.hidden).toBe(command.length - 8000)
  })

  it('a short input can be denied or allowed at once', async () => {
    const chat = createChatSessions(deps)
    const a = await withPermission(chat)
    a.emit('permission', { requestId: 'req-2', toolName: 'Bash', input: { command: 'x'.repeat(9000) } })
    expect(await chat.approve({ paneId, requestId: 'req-2', decision: 'deny' })).toEqual({ ok: true })
    expect(await chat.approve({ paneId, requestId: 'req-1', decision: 'allow' })).toEqual({ ok: true })
  })

  it('queued messages wait while an approval is pending', async () => {
    const chat = createChatSessions(deps)
    const a = await withPermission(chat)
    expect(chat.send({ paneId, text: 'meanwhile' }).queued).toBe(true)
    await chat.approve({ paneId, requestId: 'req-1', decision: 'allow' })
    expect(a.send).toHaveBeenCalledTimes(1) // the turn is still running
  })
})

describe('interrupt, close, exit', () => {
  it('interrupt keeps queued messages; they go after the interrupted turn', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    const u = chat.send({ paneId, text: 'long' })
    await flush()
    a.emit('accepted', { uuid: u.id })
    const q = chat.send({ paneId, text: 'next' })
    await flush()
    stateCalls.length = 0
    expect(await chat.interrupt({ paneId })).toEqual({ ok: true })
    expect(a.interrupt).toHaveBeenCalled()
    a.emit('turnEnd', { status: 'interrupted' })
    await flush()
    expect(stateCalls.slice(0, 2)).toEqual([['Interrupt'], ['observe', 'ScreenReady']])
    expect(a.send).toHaveBeenLastCalledWith({ uuid: q.id, text: 'next' })
  })

  it('exit code 1 after an interrupted turn is an end, not a crash', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    a.emit('state', { state: 'running' })
    a.emit('turnEnd', { status: 'interrupted' })
    a.emit('exit', { code: 1, signal: null, stderrTail: '' })
    expect(last('status')).toMatchObject({ state: 'ended' })
  })

  it('close ends the process, its status and its secret', async () => {
    const chat = createChatSessions(deps)
    const r = await openOk(chat)
    expect(await chat.close({ paneId })).toEqual({ ok: true })
    await flush()
    expect(adapters[0].close).toHaveBeenCalled()
    expect(deps.state.unregister).toHaveBeenCalledWith(paneId, r.launchToken)
    expect(deps.team.revokeSecret).toHaveBeenCalledWith(paneId)
    expect(events('status').filter((s) => s.state === 'ended')).toHaveLength(1)
    expect(chat.list()).toEqual([])
    expect(await chat.close({ paneId })).toEqual({ ok: true })
  })

  it('closeAll (Tessel quits) closes every chat, killing at once', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    await chat.open({ paneId: 'pane-2', cwd: tmp, permissions: 'manual' })
    await chat.closeAll()
    expect(adapters.every((a) => a.close.mock.calls.length === 1)).toBe(true)
    expect(adapters.every((a) => a.close.mock.calls[0][0]?.kill === true)).toBe(true)
    expect(chat.list()).toEqual([])
  })

  it('a pane closed for good (forget) loses its journal; a plain close keeps it', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    chat.send({ paneId, text: 'hi' })
    const folder = join(tmp, 'chats', paneId)
    await chat.close({ paneId })
    expect(adapters[0].close.mock.calls[0][0]).toBeUndefined()
    expect(fs.existsSync(join(folder, 'journal.jsonl'))).toBe(true)
    await openOk(chat)
    await chat.close({ paneId, forget: true })
    expect(fs.existsSync(folder)).toBe(false)
    // Opened again later: a fresh journal from seq 1.
    sent = []
    await openOk(chat)
    expect(sent[0].seq).toBe(1)
    expect(fs.existsSync(join(folder, 'journal.jsonl'))).toBe(true)
    // A pane with no running chat (never started, or untrusted) is deleted too.
    await chat.close({ paneId })
    await chat.close({ paneId, forget: true })
    expect(fs.existsSync(folder)).toBe(false)
  })

  it('close while starting: nothing is left running or registered', async () => {
    let release
    const gate = new Promise((r) => (release = r))
    const chat = createChatSessions({
      ...deps,
      createAdapter: (opts) => {
        const a = new FakeAdapter(opts, null)
        a.start = vi.fn(async () => {
          await gate
          return { ok: false, code: 'exit', error: 'killed' }
        })
        a.close = vi.fn(async () => release())
        adapters.push(a)
        return a
      }
    })
    const opening = chat.open({ paneId, cwd: tmp, permissions: 'manual' })
    await flush()
    await chat.close({ paneId })
    expect((await opening).ok).toBe(false)
    expect(deps.state.register).not.toHaveBeenCalled()
    expect(events('status').map((s) => s.state)).toEqual(['starting', 'ended'])
    expect(chat.list()).toEqual([])
  })

  it('setOption', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    expect(await chat.setOption({ paneId, model: 'opus', effort: 'max' })).toEqual({ ok: true, model: 'opus', effort: 'max', permissionMode: 'default', permissions: 'manual' })
    expect(a.setModel).toHaveBeenCalledWith('opus')
    expect(a.setEffort).toHaveBeenCalledWith('max')
    expect(last('status')).toMatchObject({ model: 'opus' })
    expect((await chat.setOption({ paneId, permissionMode: 'bypassPermissions' })).ok).toBe(false)
    expect(a.setPermissionMode).not.toHaveBeenCalled()
  })
})

describe('history and seq', () => {
  it('every event has an increasing seq; history returns the journal and whether it is live', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    chat.send({ paneId, text: 'hi' })
    await flush()
    const seqs = sent.map((e) => e.seq)
    expect(seqs).toEqual(seqs.map((_, i) => i + 1))
    expect(sent.every((e) => e.channel === 'chat:event' && e.paneId === paneId)).toBe(true)
    const h = chat.history({ paneId })
    expect(h).toMatchObject({ ok: true, seq: seqs.at(-1), open: true })
    expect(h.events.map((e) => e.seq)).toEqual(seqs)
    expect(h.meta).toMatchObject({ agent: 'claude', cwd: tmp })
    await chat.close({ paneId })
    expect(chat.history({ paneId }).open).toBe(false)
    // A new manager (Tessel restarted) goes on from the journal's seq.
    const before = chat.history({ paneId }).seq
    sent = []
    const again = createChatSessions(makeDeps())
    await again.open({ paneId, cwd: tmp, permissions: 'manual' })
    expect(sent[0].seq).toBe(before + 1)
    expect(again.history({ paneId: '../x' })).toMatchObject({ ok: false, open: false })
  })

  it('a tail read returns only the last events (team_worker_read)', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    for (let i = 0; i < 30; i++) chat.send({ paneId, text: 'm' + i })
    await flush()
    const all = chat.history({ paneId }).events
    const tail = chat.history({ paneId, tail: 5 })
    expect(tail.events).toEqual(all.slice(-5))
    expect(tail.seq).toBe(all.at(-1).seq)
    const h = {}
    chat.register({ handle: (ch, fn) => (h[ch] = (q) => fn({}, q)) })
    expect((await h['chat:history']({ paneId, tail: 3 })).events).toEqual(all.slice(-3))
    for (const bad of [0, -1, 1.5, '3', LIMITS.historyTail + 1]) expect(await h['chat:history']({ paneId, tail: bad })).toMatchObject({ ok: false, code: 'invalid' })
  })
})

describe('IPC', () => {
  function wire(chat) {
    const handlers = {}
    chat.register({ handle: (ch, fn) => (handlers[ch] = (q) => fn({}, q)) })
    return handlers
  }

  it('registers the chat channels', () => {
    const h = wire(createChatSessions(deps))
    expect(Object.keys(h).sort()).toEqual(
      ['chat:approvalInput', 'chat:approve', 'chat:close', 'chat:history', 'chat:interrupt', 'chat:open', 'chat:send', 'chat:sendTeam', 'chat:setOption'].sort()
    )
  })

  it('validates every argument', async () => {
    const chat = createChatSessions(deps)
    const h = wire(chat)
    await h['chat:open']({ paneId, cwd: tmp, permissions: 'manual' })
    const bad = { ok: false, code: 'invalid' }
    expect(await h['chat:send']({ paneId: 'a/b', text: 'x' })).toMatchObject(bad)
    expect(await h['chat:send']({ paneId, text: 'x'.repeat(LIMITS.text + 1) })).toMatchObject(bad)
    expect(await h['chat:send']({ paneId, text: '   ' })).toMatchObject(bad)
    expect(await h['chat:send'](null)).toMatchObject(bad)
    expect(await h['chat:approve']({ paneId, requestId: 'r', decision: 'always' })).toMatchObject(bad)
    expect(await h['chat:approve']({ paneId, requestId: 'r r', decision: 'allow' })).toMatchObject(bad)
    expect(await h['chat:setOption']({ paneId, model: '-x' })).toMatchObject(bad)
    expect(await h['chat:setOption']({ paneId, model: 'a;b' })).toMatchObject(bad)
    expect(await h['chat:setOption']({ paneId, permissionMode: 'yolo' })).toMatchObject(bad)
    expect(await h['chat:setOption']({ paneId })).toMatchObject(bad)
    const many = Array.from({ length: LIMITS.teamPerCall + 1 }, (_, i) => ({ id: `m${i}`, from: '#1', text: 't' }))
    expect(await h['chat:sendTeam']({ paneId, messages: many })).toMatchObject(bad)
    expect(await h['chat:sendTeam']({ paneId, messages: [{ id: 'bad id', text: 't' }] })).toMatchObject(bad)
    expect(await h['chat:approvalInput']({ paneId, requestId: 'r r' })).toMatchObject(bad)
    expect(await h['chat:approvalInput']({ paneId: '..', requestId: 'r' })).toMatchObject(bad)
    expect(await h['chat:open']({ paneId: 'p2', cwd: tmp, permissions: 'root' })).toMatchObject(bad)
    expect(await h['chat:open']({ paneId: 'p2', cwd: tmp, permissions: 'manual', model: '--foo' })).toMatchObject(bad)
    expect(await h['chat:history']({ paneId: '..' })).toMatchObject(bad)
    expect(await h['chat:interrupt']({ paneId: '' })).toMatchObject(bad)
    expect(await h['chat:close']({ paneId: 5 })).toMatchObject(bad)
    expect(adapters[0].send).not.toHaveBeenCalled()
  })

  it('never a command or a whole environment from the window; its variables go to paneEnv as for a terminal pane', async () => {
    const chat = createChatSessions(deps)
    const h = wire(chat)
    await h['chat:open']({ paneId, cwd: tmp, permissions: 'manual', accountEnv: { ACCOUNT: '1' }, extraEnv: { MINE: '2' }, unsetEnv: ['ANTHROPIC_API_KEY', 5], env: { EVIL: '1' }, exe: 'C:\\evil.exe' })
    const call = deps.env.forPane.mock.calls[0][0]
    expect(call).toMatchObject({ accountEnv: { ACCOUNT: '1' }, extraEnv: { MINE: '2' }, unsetEnv: ['ANTHROPIC_API_KEY'] })
    expect(call.env).toBeUndefined()
    expect(adapters[0].opts.exe).toBe('C:\\bin\\claude.exe')
    expect(adapters[0].opts.env.EVIL).toBeUndefined()
  })
})

describe('codex', () => {
  const thread = '01a0ec89-63d4-7980-80ae-d21e469ea231'
  const openCodex = async (chat, extra = {}) => {
    const r = await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'codex', ...extra })
    expect(r.ok).toBe(true)
    await flush()
    return r
  }
  beforeEach(() => {
    deps.resolveCodex = vi.fn(async () => ({ exe: 'C:\\bin\\codex.exe', exeArgs: ['app-server'], pathEnv: 'C:\\codex' }))
    deps.env.forPane.mockReturnValue({
      Path: 'C:\\Windows',
      TESSEL_PANE_ID: 'someone-else',
      CODEX_THREAD_ID: 'parent-thread',
      CODEX_SANDBOX: 'seatbelt',
      CODEX_MANAGED_BY_NPM: '1',
      CODEX_HOME: 'C:\\accounts\\work',
      CODEX_API_KEY: 'acct',
      OPENAI_API_KEY: 'k',
      CLAUDECODE: '1'
    })
    startResult = { ok: true, pid: 2, info: { threadId: thread, model: 'gpt-5.5' } }
  })

  it('a new thread: its id comes from the start, into the result, status and journal', async () => {
    const chat = createChatSessions(deps)
    const r = await openCodex(chat, { model: 'gpt-5.5', effort: 'high', projectDir: tmp })
    expect(r).toEqual({ ok: true, agent: 'codex', sessionId: thread, launchToken: expect.stringMatching(/^[0-9a-f]{32}$/), model: 'gpt-5.5' })
    expect(deps.resolveClaude).not.toHaveBeenCalled()
    const o = adapters[0].opts
    expect(o).toMatchObject({ agent: 'codex', exe: 'C:\\bin\\codex.exe', exeArgs: ['app-server'], cwd: tmp, model: 'gpt-5.5', effort: 'high', permissions: 'manual' })
    for (const k of ['threadId', 'sessionId', 'resume', 'permissionMode']) expect(o[k]).toBeUndefined()
    expect(o.env).toMatchObject({
      PATH: 'C:\\codex',
      TESSEL_PANE_ID: paneId,
      TESSEL_TEAM_SECRET: 'f'.repeat(64),
      TESSEL_CHAT: '1',
      TESSEL_PROJECT_DIR: tmp,
      CODEX_HOME: 'C:\\accounts\\work',
      CODEX_API_KEY: 'acct',
      OPENAI_API_KEY: 'k'
    })
    for (const k of ['CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_MANAGED_BY_NPM', 'CLAUDECODE', 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS']) expect(o.env[k]).toBeUndefined()
    expect(events('status').find((e) => e.state === 'starting')).toEqual({ type: 'status', state: 'starting', agent: 'codex' })
    expect(last('status')).toMatchObject({ state: 'idle', agent: 'codex', sessionId: thread, launchToken: r.launchToken })
    expect(stateCalls).toEqual([['register', 'codex'], ['SessionStart'], ['observe', 'ScreenReady']])
    expect(chat.history({ paneId })).toMatchObject({ meta: { sessionId: thread, agent: 'codex', cwd: tmp }, live: { agent: 'codex', sessionId: thread } })
    expect(chat.list()).toEqual([expect.objectContaining({ agent: 'codex', sessionId: thread })])
  })

  it('no thread id from the start: runs, but nothing to resume', async () => {
    startResult = { ok: true, pid: 2, info: {} }
    const chat = createChatSessions(deps)
    const r = await openCodex(chat)
    expect(r.sessionId).toBeNull()
    expect(chat.history({ paneId }).meta).toMatchObject({ sessionId: null, agent: 'codex' })
  })

  it('resume passes the thread id; the same thread in another pane is busy', async () => {
    const chat = createChatSessions(deps)
    const r = await openCodex(chat, { resumeId: thread, permissions: 'yolo' })
    expect(adapters[0].opts).toMatchObject({ threadId: thread, permissions: 'yolo' })
    expect(r.sessionId).toBe(thread)
    expect(events('status').find((e) => e.state === 'starting')).toMatchObject({ sessionId: thread })
    expect(await chat.open({ paneId: 'pane-2', cwd: tmp, permissions: 'manual', agent: 'codex', resumeId: thread })).toMatchObject({ code: 'busy' })
  })

  it('no Codex found', async () => {
    deps.resolveCodex.mockResolvedValue(null)
    const chat = createChatSessions(deps)
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'codex' })).toEqual({
      ok: false,
      code: 'no-codex',
      error: 'Codex was not found. Install it, then try again.'
    })
    expect(last('status')).toMatchObject({ state: 'crashed', agent: 'codex' })
    expect(deps.team.newSecret).not.toHaveBeenCalled()
    // A manager given no Codex resolver: the same.
    const noResolver = { ...deps }
    delete noResolver.resolveCodex
    expect(await createChatSessions(noResolver).open({ paneId: 'pane-2', cwd: tmp, permissions: 'manual', agent: 'codex' })).toMatchObject({ code: 'no-codex' })
  })

  it('start failures speak of Codex', async () => {
    startResult = { ok: false, code: 'signin', error: 'not logged in' }
    const chat = createChatSessions(deps)
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'codex' })).toMatchObject({
      code: 'signin',
      error: 'Codex is not signed in. Sign in to Codex, then try again.'
    })
    startResult = { ok: false, code: 'timeout', error: 'x' }
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'codex' })).toMatchObject({ code: 'failed', error: 'Codex did not answer in time.' })
  })

  it('permission mode: yolo <-> manual only, bypass only after a yolo launch', async () => {
    const chat = createChatSessions(deps)
    await openCodex(chat, { permissions: 'yolo' })
    const a = adapters[0]
    expect((await chat.setOption({ paneId, permissionMode: 'default' })).ok).toBe(true)
    expect(a.setPermissionMode).toHaveBeenLastCalledWith('default')
    expect((await chat.setOption({ paneId, permissionMode: 'bypassPermissions' })).ok).toBe(true)
    expect(a.setPermissionMode).toHaveBeenLastCalledWith('bypassPermissions')
    expect((await chat.setOption({ paneId, permissionMode: 'plan' })).ok).toBe(false)
    expect(a.setPermissionMode).toHaveBeenCalledTimes(2)
    await chat.close({ paneId })
    await openCodex(chat)
    expect((await chat.setOption({ paneId, permissionMode: 'bypassPermissions' })).ok).toBe(false)
    expect(adapters[1].setPermissionMode).not.toHaveBeenCalled()
  })

  it('approvals forward the offered choices; allow for the session only when offered', async () => {
    const chat = createChatSessions(deps)
    await openCodex(chat)
    const a = adapters[0]
    a.emit('state', { state: 'running' })
    a.emit('permission', { requestId: 'r1', toolName: 'shell', input: { command: 'ls' }, choices: ['accept', 'decline', 'cancel'] })
    expect(last('approval')).toMatchObject({ requestId: 'r1', choices: ['accept', 'decline', 'cancel'], status: 'pending' })
    expect(await chat.approve({ paneId, requestId: 'r1', decision: 'allowSession' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(a.answerPermission).not.toHaveBeenCalled()
    expect(await chat.approve({ paneId, requestId: 'r1', decision: 'allow' })).toEqual({ ok: true })
    const offered = ['accept', 'acceptForSession', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ls'] } }, 'decline']
    a.emit('permission', { requestId: 'r2', toolName: 'shell', input: {}, choices: offered })
    expect(last('approval').choices).toEqual(offered)
    expect(await chat.approve({ paneId, requestId: 'r2', decision: 'allowSession' })).toEqual({ ok: true })
    expect(a.answerPermission).toHaveBeenLastCalledWith('r2', { behavior: 'allow', session: true })
  })

  it('Manual posture not confirmed at start: its own message; changed mid-chat: a notice', async () => {
    startResult = { ok: false, code: 'posture', error: 'Codex did not apply the Manual permissions: approvalPolicy missing' }
    const chat = createChatSessions(deps)
    const r = await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'codex' })
    expect(r).toMatchObject({ ok: false, code: 'failed', detail: 'Codex did not apply the Manual permissions: approvalPolicy missing' })
    expect(r.error).toMatch(/Manual permissions/)
    startResult = { ok: true, pid: 2, info: { threadId: thread, model: 'gpt-5.5' } }
    await openCodex(chat)
    adapters[1].emit('postureError', { reason: 'approvalPolicy "never"' })
    await flush()
    expect(last('notice')).toMatchObject({ type: 'notice', kind: 'error' })
    expect(last('notice').text).toMatch(/no longer applied the Manual permissions/)
  })

  it('a Codex command approval: hidden counts the whole text (rawCommand, cwd), Allow waits for it', async () => {
    const chat = createChatSessions(deps)
    await openCodex(chat)
    const a = adapters[0]
    a.emit('state', { state: 'running' })
    const rawCommand = 'powershell -Command "echo hi; ' + 'x'.repeat(9000) + '; del C:\\*"'
    a.emit('permission', { requestId: 'rc', toolName: 'Bash', input: { command: 'echo hi', rawCommand, cwd: 'C:\\w' }, choices: ['accept', 'decline'] })
    const ev = last('approval')
    expect(ev.detail.startsWith('powershell -Command')).toBe(true)
    expect(ev.hidden).toBeGreaterThan(1000)
    expect(await chat.approve({ paneId, requestId: 'rc', decision: 'allow' })).toMatchObject({ ok: false, code: 'unseen' })
    a.emit('permission', { requestId: 'fu', toolName: 'Edit', input: { grantRoot: 'C:\\x', changesUnknown: true, file_path: '', changes: [] } })
    expect(last('approval').hidden).toBe(1)
    expect(await chat.approve({ paneId, requestId: 'fu', decision: 'allow' })).toMatchObject({ ok: false, code: 'unseen' })
    expect(chat.approvalInput({ paneId, requestId: 'fu' }).ok).toBe(true)
    expect(await chat.approve({ paneId, requestId: 'fu', decision: 'allow' })).toEqual({ ok: true })
  })

  it('a failed turn (no turn/completed): idle, a notice, the team batch released, the queue goes on', async () => {
    const chat = createChatSessions(deps)
    await openCodex(chat)
    const a = adapters[0]
    chat.sendTeam({ paneId, messages: [{ id: 'm1', from: '#3', text: 'x' }] })
    await flush()
    expect(a.send).toHaveBeenCalledTimes(1)
    const u = chat.send({ paneId, text: 'after' })
    expect(u.queued).toBe(true)
    stateCalls.length = 0
    a.emit('turnEnd', { status: 'failed', error: 'This content was flagged.' })
    await flush()
    expect(events('teamFailed')).toEqual([{ type: 'teamFailed', ids: ['m1'] }])
    expect(last('turnEnd')).toEqual({ type: 'turnEnd', status: 'failed', error: 'This content was flagged.' })
    expect(last('notice')).toEqual({ type: 'notice', kind: 'error', text: 'The turn failed: This content was flagged.' })
    expect(stateCalls.slice(0, 3)).toEqual([['UserPromptSubmit'], ['StopFailure'], ['observe', 'ScreenReady']])
    expect(a.send).toHaveBeenLastCalledWith({ uuid: u.id, text: 'after' })
    a.emit('accepted', { uuid: u.id })
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    expect(last('status')).toMatchObject({ state: 'idle' })
    // The released team message can come again.
    expect(chat.sendTeam({ paneId, messages: [{ id: 'm1', from: '#3', text: 'x' }] }).ids).toEqual(['m1'])
  })

  it('a Claude failed turn has no extra notice (its turn row shows the error)', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    adapters[0].emit('state', { state: 'running' })
    adapters[0].emit('turnEnd', { status: 'failed', result: 'API error' })
    expect(events('notice')).toEqual([])
  })

  it('a failed turn ends idle in the real status store', async () => {
    let tick = Date.now()
    const store = createAgentStateStore({ dir: join(tmp, 'status'), now: () => tick })
    const chat = createChatSessions({ ...deps, state: store, now: () => tick })
    const r = await openCodex(chat)
    const st = () => store.snapshot()[paneId]
    const until = (expected) => vi.waitFor(() => expect(st()).toMatchObject(expected), { timeout: 3000, interval: 5 })
    await until({ state: 'idle', provider: 'codex', launchToken: r.launchToken })
    const u = chat.send({ paneId, text: 'go' })
    await flush()
    tick++
    adapters[0].emit('accepted', { uuid: u.id })
    await until({ state: 'working', sessionId: thread })
    tick++
    adapters[0].emit('turnEnd', { status: 'failed', error: 'usage limit' })
    await until({ state: 'idle' })
    await chat.close({ paneId })
    await store.dispose()
  })
})

describe('team messages over IPC', () => {
  function wire(chat) {
    const handlers = {}
    chat.register({ handle: (ch, fn) => (handlers[ch] = (q) => fn({}, q)) })
    return handlers
  }

  it('the limit covers a full message with the window prefix', () => {
    const prefix = '(message msg-0123456789abcdef, reply to msg-0123456789abcdef) '
    expect(LIMITS.teamText).toBeGreaterThanOrEqual(6000 + prefix.length)
  })

  it('one bad message is skipped and a long one cut: the others still go (no whole-batch refusal)', async () => {
    const chat = createChatSessions(deps)
    const h = wire(chat)
    await h['chat:open']({ paneId, cwd: tmp, permissions: 'manual' })
    await flush()
    const long = 'y'.repeat(LIMITS.teamText + 500)
    const r = await h['chat:sendTeam']({
      paneId,
      messages: [
        { id: 'ok1', from: '#1', text: 'hello' },
        { id: 'bad id', from: '#1', text: 'skipped' },
        { id: 'empty', from: '#1', text: '   ' },
        { id: 'long', from: '#2', text: long }
      ]
    })
    expect(r).toEqual({ ok: true, ids: ['ok1', 'long'] })
    const text = adapters[0].send.mock.calls[0][0].text
    expect(text).toContain('hello')
    expect(text).toContain(teamMessageText(long))
    expect(teamMessageText(long)).toMatch(/message cut by Tessel: 500 more characters/)
    expect(teamMessageText('short')).toBe('short')
    // Nothing usable at all: refused.
    expect(await h['chat:sendTeam']({ paneId, messages: [{ id: 'bad id', text: 't' }] })).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('chat:trust is gone (trusting a folder always asks, from chat:open)', () => {
    const h = wire(createChatSessions(deps))
    expect(h['chat:trust']).toBeUndefined()
  })
})

describe('with the real agent status store', () => {
  it('idle -> working -> approval -> working -> idle', async () => {
    let tick = Date.now()
    const store = createAgentStateStore({ dir: join(tmp, 'status'), now: () => tick })
    const chat = createChatSessions({ ...deps, state: store, now: () => tick })
    const r = await openOk(chat)
    const st = () => store.snapshot()[paneId]
    const until = (expected) => vi.waitFor(() => expect(st()).toMatchObject(expected), { timeout: 3000, interval: 5 })
    await until({ state: 'idle', provider: 'claude', launchToken: r.launchToken })
    const a = adapters[0]
    const u = chat.send({ paneId, text: 'go' })
    await flush()
    tick++
    a.emit('accepted', { uuid: u.id })
    await until({ state: 'working', hookSeen: true, sessionId: r.sessionId })
    tick++
    a.emit('permission', { requestId: 'rq', toolName: 'Bash', input: {}, toolUseId: 'toolu_1' })
    await until({ state: 'approval' })
    tick++
    await chat.approve({ paneId, requestId: 'rq', decision: 'allow' })
    await until({ state: 'working' })
    tick++
    a.emit('turnEnd', { status: 'completed' })
    await until({ state: 'idle', reason: 'ready' })
    await chat.close({ paneId })
    await vi.waitFor(() => expect(st()).toBeUndefined(), { timeout: 3000, interval: 5 })
    await store.dispose()
  })
})
