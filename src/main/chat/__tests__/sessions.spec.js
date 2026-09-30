// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createChatSessions, teamTurnText, teamMessageText, LIMITS } from '../sessions'
import { createAgentStateStore } from '../../agentStateStore'
import { guardIpc } from '../../ipcGuard'

const flush = () => new Promise((r) => setImmediate(r))

class FakeAdapter extends EventEmitter {
  constructor(opts, startResult) {
    super()
    this.opts = opts
    this.start = vi.fn(async () => startResult)
    this.send = vi.fn(async () => ({ ok: true }))
    this.interrupt = vi.fn(async () => ({ ok: true }))
    this.answerPermission = vi.fn(async () => ({ ok: true }))
    this.answerQuestion = vi.fn(async () => ({ ok: true }))
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

describe('question IPC and lifecycle', () => {
  const question = { requestId: 'question_fixture', questions: [{ id: 'q0', question: 'Which?', multiSelect: false, options: [{ id: 'o0', label: 'One' }, { id: 'o1', label: 'Two' }] }], status: 'pending' }
  const answers = [{ questionId: 'q0', optionIds: ['o0'] }]
  function wire(chat) {
    const handlers = {}
    chat.register({ handle: (name, fn) => { handlers[name] = q => fn({}, q) } })
    return handlers
  }
  it('validates in main, journals question/status, and exposes authoritative pending history', async () => {
    const chat = createChatSessions(deps), h = wire(chat)
    await openOk(chat)
    const a = adapters[0]
    a.emit('question', question)
    a.emit('question', question)
    expect(events('question')).toEqual([{ type: 'question', ...question }])
    expect(events('approval')).toEqual([])
    expect(chat.history({ paneId, tail: 1 }).questions).toEqual([{ type: 'question', ...question }])
    expect(createChatSessions(deps).history({ paneId }).questions).toEqual([])
    for (const bad of [null, { paneId: '../x', requestId: question.requestId, answers }, { paneId, requestId: 'bad id', answers }, { paneId, requestId: question.requestId, answers: [] }, { paneId, requestId: question.requestId, cancel: 'true' }, { paneId, requestId: question.requestId, cancel: true, answers }, { paneId, requestId: question.requestId, answers: [{ questionId: 'q0', optionIds: [], other: 'forged' }] }]) {
      expect(await h['chat:answer'](bad)).toMatchObject({ ok: false, code: 'invalid' })
    }
    expect(a.answerQuestion).not.toHaveBeenCalled()
    expect(await h['chat:answer']({ paneId, requestId: question.requestId, answers, updatedInput: { evil: true } })).toEqual({ ok: true })
    expect(a.answerQuestion).toHaveBeenCalledExactlyOnceWith(question.requestId, { answers })
    expect(a.answerPermission).not.toHaveBeenCalled()
    expect(last('questionStatus')).toEqual({ type: 'questionStatus', requestId: question.requestId, status: 'answered', answers })
    expect(chat.history({ paneId }).questions).toEqual([])
    expect(chat.history({ paneId }).events.map(e => e.event).filter(e => e.type === 'questionStatus')).toEqual(events('questionStatus'))
    expect(await chat.answer({ paneId, requestId: question.requestId, answers })).toMatchObject({ code: 'unknown' })
    await chat.close({ paneId })
  })
  it('protects answers with ipcGuard and refuses another pane', async () => {
    const registered = {}, ipc = { handle: (name, fn) => { registered[name] = fn } }
    guardIpc(ipc, { isTrustedSender: event => event.main === true })
    const chat = createChatSessions(deps)
    chat.register(ipc)
    await openOk(chat)
    adapters[0].emit('question', question)
    await openOk(chat, { paneId: 'pane-2' })
    const value = { paneId, requestId: question.requestId, answers }
    await expect(registered['chat:answer']({ main: false }, value)).rejects.toThrow(/refused/)
    expect(await registered['chat:answer']({ main: true }, { ...value, paneId: 'pane-2' })).toMatchObject({ code: 'unknown' })
    expect(adapters[0].answerQuestion).not.toHaveBeenCalled()
    expect(await registered['chat:answer']({ main: true }, value)).toEqual({ ok: true })
    await chat.closeAll()
  })
  it.each(['turnEnd', 'exit', 'close', 'interrupt', 'cancel'])('settles questions on %s without changing approvals or permissions', async how => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    a.emit('question', question)
    if (how === 'turnEnd') a.emit('turnEnd', { status: 'completed' })
    if (how === 'exit') a.emit('exit', { code: 0 })
    if (how === 'close') await chat.close({ paneId })
    if (how === 'interrupt') await chat.interrupt({ paneId })
    if (how === 'cancel') expect(await chat.answer({ paneId, requestId: question.requestId, cancel: true })).toEqual({ ok: true })
    expect(events('questionStatus')).toEqual([{ type: 'questionStatus', requestId: question.requestId, status: 'cancelled' }])
    expect(await chat.answer({ paneId, requestId: question.requestId, answers })).toMatchObject({ ok: false })
    expect(a.answerPermission).not.toHaveBeenCalled()
    expect(a.setPermissionMode).not.toHaveBeenCalled()
    await chat.close({ paneId })
  })
  it('refuses duplicate submissions and ignores a late success after turn end', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    let resolve
    a.answerQuestion.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    a.emit('question', question)
    const pending = chat.answer({ paneId, requestId: question.requestId, answers })
    expect(await chat.answer({ paneId, requestId: question.requestId, answers })).toMatchObject({ code: 'unknown' })
    a.emit('turnEnd', { status: 'completed' })
    resolve({ ok: true })
    await pending
    expect(events('questionStatus')).toEqual([{ type: 'questionStatus', requestId: question.requestId, status: 'cancelled' }])
    expect(a.answerQuestion).toHaveBeenCalledTimes(2)
    expect(a.answerQuestion).toHaveBeenLastCalledWith(question.requestId, { cancel: true })
    await chat.close({ paneId })
  })
  it('relays turn-end cancellations even when adapter turn ownership did not match', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    a.emit('question', question)
    a.emit('question', { ...question, requestId: 'question_second' })
    a.emit('turnEnd', { turnId: 'another-turn', status: 'completed' })
    expect(a.answerQuestion.mock.calls).toEqual([
      [question.requestId, { cancel: true }],
      ['question_second', { cancel: true }]
    ])
    expect(chat.history({ paneId }).questions).toEqual([])
    a.emit('questionStatus', { requestId: question.requestId, status: 'cancelled' })
    expect(events('questionStatus')).toHaveLength(2)
    await chat.close({ paneId })
  })
  it('does not sleep or send queued messages while waiting for a question', async () => {
    vi.useFakeTimers()
    try {
      const chat = createChatSessions(deps)
      expect((await chat.open({ paneId, cwd: tmp, permissions: 'manual', idleMinutes: 1 })).ok).toBe(true)
      const a = adapters[0]
      a.emit('question', question)
      await vi.advanceTimersByTimeAsync(120000)
      expect(a.close).not.toHaveBeenCalled()
      expect(chat.send({ paneId, text: 'Next' })).toMatchObject({ queued: true })
      expect(a.send).not.toHaveBeenCalled()
      expect(await chat.answer({ paneId, requestId: question.requestId, answers })).toEqual({ ok: true })
      expect(a.send).toHaveBeenCalledTimes(1)
      await chat.close({ paneId })
    } finally { vi.useRealTimers() }
  })
})

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

  it('a conversation too long (Claude): compacted, the message sent again once; failing that, one error with a way out', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    const r = await chat.send({ paneId, text: 'hello' })
    await flush()
    a.emit('accepted', { uuid: r.id })
    a.emit('apiError', { code: 'invalid_request', message: 'Prompt is too long' })
    a.emit('turnEnd', { status: 'failed', isError: true, result: 'Prompt is too long' })
    await flush()
    // Not the assistant's words, no error on the turn: one neutral notice, and /compact sent as a turn of its own.
    expect(events('assistant')).toEqual([])
    expect(last('turnEnd')).toEqual({ type: 'turnEnd', status: 'failed' })
    expect(last('notice')).toMatchObject({ kind: 'info', text: expect.stringContaining('compacting') })
    expect(a.send).toHaveBeenCalledTimes(2)
    expect(a.send.mock.calls[1][0]).toMatchObject({ text: '/compact' })
    expect(events('user')).toHaveLength(1)
    expect(last('status')).toMatchObject({ state: 'working' })
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    // The same message again (a new uuid, the same row).
    expect(a.send).toHaveBeenCalledTimes(3)
    expect(a.send.mock.calls[2][0]).toMatchObject({ text: 'hello' })
    expect(a.send.mock.calls[2][0].uuid).not.toBe(r.id)
    expect(last('userStatus')).toEqual({ type: 'userStatus', id: r.id, status: 'sent' })
    expect(events('turnEnd').filter((e) => e.error)).toEqual([])
    // Too long again: given up, once, with a way out; never a third try.
    a.emit('turnEnd', { status: 'failed', isError: true, result: 'Prompt is too long' })
    await flush()
    expect(a.send).toHaveBeenCalledTimes(3)
    expect(events('turnEnd').filter((e) => e.error)).toEqual([])
    expect(events('notice').filter((n) => n.kind === 'error')).toHaveLength(1)
    expect(last('notice')).toMatchObject({ kind: 'error', action: 'newConversation', text: expect.stringContaining('too long for Claude') })
    expect(last('userStatus')).toEqual({ type: 'userStatus', id: r.id, status: 'failed' })
    expect(last('status')).toMatchObject({ state: 'idle' })
    // The compaction failing: the same way out, at once.
    const r2 = await chat.send({ paneId, text: 'again' })
    await flush()
    a.emit('accepted', { uuid: r2.id })
    a.emit('turnEnd', { status: 'failed', isError: true, result: 'Prompt is too long' })
    await flush()
    expect(a.send.mock.calls[4][0]).toMatchObject({ text: '/compact' })
    a.emit('turnEnd', { status: 'failed', isError: true, result: 'Prompt is too long' })
    await flush()
    expect(a.send).toHaveBeenCalledTimes(5)
    expect(events('notice').filter((n) => n.action === 'newConversation')).toHaveLength(2)
    expect(events('turnEnd').filter((e) => e.error)).toEqual([])
  })

  it('a conversation too long (Codex): the adapter compacts, then the message goes again; another failure is said once', async () => {
    const chat = createChatSessions({ ...deps, resolveCodex: async () => ({ exe: 'C:\bin\codex.exe' }) })
    await openOk(chat, { agent: 'codex' })
    const a = adapters[0]
    a.compact = vi.fn(async () => ({ ok: true }))
    const r = await chat.send({ paneId, text: 'hello' })
    await flush()
    a.emit('accepted', { uuid: r.id })
    a.emit('turnEnd', { status: 'failed', error: { message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying." } })
    await flush()
    expect(a.compact).toHaveBeenCalledTimes(1)
    expect(last('notice')).toMatchObject({ kind: 'info' })
    await flush()
    // Not before the agent says it is done.
    expect(a.send).toHaveBeenCalledTimes(1)
    expect(last('status')).toMatchObject({ state: 'working' })
    a.emit('compacted', {})
    await flush()
    expect(a.send).toHaveBeenCalledTimes(2)
    expect(a.send.mock.calls[1][0]).toMatchObject({ text: 'hello' })
    a.emit('accepted', { uuid: a.send.mock.calls[1][0].uuid })
    a.emit('turnEnd', { status: 'failed', error: { message: 'content filter' } })
    await flush()
    // The turn's end carries the error: no notice with the same words.
    expect(last('turnEnd')).toMatchObject({ status: 'failed', error: 'content filter' })
    expect(events('notice').filter((n) => n.text.includes('content filter'))).toEqual([])
    // The compaction turn failing (Codex): the way out at once.
    a.compact = vi.fn(async () => ({ ok: true }))
    const r3 = await chat.send({ paneId, text: 'third' })
    await flush()
    a.emit('accepted', { uuid: r3.id })
    a.emit('turnEnd', { status: 'failed', error: { message: 'maximum context length exceeded' } })
    await flush()
    await flush()
    a.emit('turnEnd', { status: 'failed', error: { message: 'compaction failed' } })
    await flush()
    expect(last('notice')).toMatchObject({ kind: 'error', action: 'newConversation', detail: 'compaction failed' })
    expect(a.send).toHaveBeenCalledTimes(3)
    // No compaction offered by the adapter: the way out at once.
    delete a.compact
    const r2 = await chat.send({ paneId, text: 'more' })
    await flush()
    a.emit('accepted', { uuid: r2.id })
    a.emit('turnEnd', { status: 'failed', error: { message: 'context_length_exceeded' } })
    await flush()
    expect(last('notice')).toMatchObject({ kind: 'error', action: 'newConversation', text: expect.stringContaining('Codex') })
    expect(last('status')).toMatchObject({ state: 'idle' })
  })

  it('OpenCode working: queued, then sent in order after the turn, one turn each', async () => {
    deps.resolveOpencode = vi.fn(async () => ({ exe: 'C:\\bin\\opencode.exe', exeArgs: [] }))
    startResult = { ok: true, pid: 3, info: { sessionId: 'ses_queue' } }
    const chat = createChatSessions(deps)
    await openOk(chat, { agent: 'opencode' })
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
    // Sent at once into the agent's own turn (as in a terminal).
    const steered = chat.send({ paneId, text: 'wait' })
    expect(steered).toMatchObject({ queued: false, steered: true })
    await flush()
    expect(adapters[0].send).toHaveBeenCalledWith({ uuid: steered.id, text: 'wait' })
    adapters[0].emit('accepted', { uuid: steered.id })
    adapters[0].emit('turnEnd', { status: 'completed' })
    await flush()
    expect(stateCalls.slice(0, 3)).toEqual([['UserPromptSubmit'], ['Stop'], ['observe', 'ScreenReady']])
    expect(adapters[0].send).toHaveBeenCalledTimes(1)
    expect(last('status')).toMatchObject({ state: 'idle' })
  })
})

describe('a message sent while a turn runs (steered)', () => {
  const userStatuses = (id) => events('userStatus').filter((e) => e.id === id).map((e) => e.status)
  const running = async (chat, extra) => {
    await openOk(chat, extra)
    const a = adapters[0]
    const first = chat.send({ paneId, text: 'one' })
    await flush()
    a.emit('state', { state: 'running' })
    a.emit('accepted', { uuid: first.id })
    return { a, first }
  }

  it('Claude: written at once, accepted into the running turn, one turn end, never sent again', async () => {
    const chat = createChatSessions(deps)
    const { a, first } = await running(chat)
    stateCalls.length = 0
    const second = chat.send({ paneId, text: 'two' })
    expect(second).toEqual({ ok: true, id: second.id, queued: false, steered: true })
    expect(events('user').map((u) => [u.text, u.status])).toEqual([['one', 'sent'], ['two', 'sent']])
    await flush()
    expect(a.send).toHaveBeenCalledTimes(2)
    expect(a.send.mock.calls[1][0]).toEqual({ uuid: second.id, text: 'two' })
    expect(last('status')).toMatchObject({ state: 'working' })
    a.emit('accepted', { uuid: second.id })
    expect(userStatuses(second.id)).toEqual(['accepted'])
    a.emit('turnEnd', { status: 'completed', userMessageUuids: [first.id, second.id] })
    await flush()
    expect(events('turnEnd')).toHaveLength(1)
    expect(userStatuses(first.id)).toEqual(['accepted'])
    expect(userStatuses(second.id)).toEqual(['accepted'])
    expect(a.send).toHaveBeenCalledTimes(2)
    expect(stateCalls).toEqual([['Stop'], ['observe', 'ScreenReady']])
    expect(last('status')).toMatchObject({ state: 'idle' })
  })

  it('accepted by the turn end\'s list when the agent never echoed it', async () => {
    const chat = createChatSessions(deps)
    const { a, first } = await running(chat)
    const second = chat.send({ paneId, text: 'two' })
    await flush()
    a.emit('turnEnd', { status: 'completed', userMessageUuids: [first.id, second.id] })
    await flush()
    expect(userStatuses(second.id)).toEqual(['accepted'])
    expect(last('status')).toMatchObject({ state: 'idle' })
  })

  it('run by the agent after the turn: the chat stays working for it, team messages wait, then go', async () => {
    const chat = createChatSessions(deps)
    const { a } = await running(chat)
    const second = chat.send({ paneId, text: 'two' })
    await flush()
    chat.sendTeam({ paneId, messages: [{ id: 'm1', from: '#2', text: 'team' }] })
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    // Not failed, not sent again, nothing else sent meanwhile.
    expect(userStatuses(second.id)).toEqual([])
    expect(a.send).toHaveBeenCalledTimes(2)
    expect(events('status').filter((e) => e.state === 'idle')).toHaveLength(1) // the open's only
    expect(last('status')).toMatchObject({ state: 'working' })
    stateCalls.length = 0
    a.emit('state', { state: 'running' })
    a.emit('accepted', { uuid: second.id })
    expect(userStatuses(second.id)).toEqual(['accepted'])
    await flush()
    expect(stateCalls[0]).toEqual(['UserPromptSubmit'])
    a.emit('turnEnd', { status: 'completed', userMessageUuids: [second.id] })
    await flush()
    expect(events('turnEnd')).toHaveLength(2)
    expect(a.send).toHaveBeenCalledTimes(3)
    expect(a.send.mock.calls[2][0].text).toContain('team')
  })

  it('never started by the agent: failed after the wait, the queue goes on; a late start still shows', async () => {
    const chat = createChatSessions({ ...deps, steerWaitMs: 20 })
    const { a } = await running(chat)
    const second = chat.send({ paneId, text: 'two' })
    await flush()
    chat.sendTeam({ paneId, messages: [{ id: 'm1', from: '#2', text: 'team' }] })
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    expect(last('status')).toMatchObject({ state: 'working' })
    await new Promise((r) => setTimeout(r, 60))
    expect(userStatuses(second.id)).toEqual(['failed'])
    // The team batch went once the wait was over.
    expect(a.send).toHaveBeenCalledTimes(3)
    a.emit('accepted', { uuid: a.send.mock.calls[2][0].uuid })
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    expect(last('status')).toMatchObject({ state: 'idle' })
    // Taken after all: its row says so, and the chat shows the turn.
    a.emit('accepted', { uuid: second.id })
    expect(userStatuses(second.id)).toEqual(['failed', 'accepted'])
    expect(last('status')).toMatchObject({ state: 'working' })
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    expect(last('status')).toMatchObject({ state: 'idle' })
    expect(a.send).toHaveBeenCalledTimes(3)
  })

  it('a write that fails: that message fails, the running turn goes on, nothing queued or resent', async () => {
    const chat = createChatSessions(deps)
    const { a } = await running(chat)
    a.send.mockResolvedValueOnce({ ok: false, error: 'stdin closed' })
    const second = chat.send({ paneId, text: 'two' })
    await flush()
    expect(userStatuses(second.id)).toEqual(['failed'])
    expect(last('status')).toMatchObject({ state: 'working' })
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    expect(a.send).toHaveBeenCalledTimes(2)
    expect(last('status')).toMatchObject({ state: 'idle' })
  })

  it('Codex steers too; OpenCode, a "/command", an approval and a compaction still queue', async () => {
    deps.resolveCodex = vi.fn(async () => ({ exe: 'C:\\bin\\codex.exe', exeArgs: [] }))
    let chat = createChatSessions(deps)
    let r = await running(chat, { agent: 'codex' })
    expect(chat.send({ paneId, text: 'steer me' })).toMatchObject({ queued: false, steered: true })
    // A command waits for the end of the turn (never folded into it).
    expect(chat.send({ paneId, text: '/compact' })).toMatchObject({ queued: true })
    // And what comes after a queued message waits behind it (order kept).
    expect(chat.send({ paneId, text: 'after the command' })).toMatchObject({ queued: true })
    await chat.close({ paneId })

    // An approval pending.
    adapters.length = 0
    chat = createChatSessions(deps)
    r = await running(chat)
    r.a.emit('permission', { requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' } })
    expect(chat.send({ paneId, text: 'meanwhile' })).toMatchObject({ queued: true })
    await chat.close({ paneId })

    // Compacting after "Prompt is too long": the resend goes first.
    adapters.length = 0
    chat = createChatSessions(deps)
    r = await running(chat)
    r.a.emit('turnEnd', { status: 'failed', isError: true, result: 'Prompt is too long' })
    await flush()
    expect(r.a.send.mock.calls.at(-1)[0].text).toBe('/compact')
    expect(chat.send({ paneId, text: 'while compacting' })).toMatchObject({ queued: true })
    await chat.close({ paneId })

    // OpenCode keeps its queue.
    adapters.length = 0
    deps.resolveOpencode = vi.fn(async () => ({ exe: 'C:\\bin\\opencode.exe', exeArgs: [] }))
    startResult = { ok: true, pid: 3, info: { sessionId: 'ses_q' } }
    chat = createChatSessions(deps)
    r = await running(chat, { agent: 'opencode' })
    expect(chat.send({ paneId, text: 'later' })).toMatchObject({ queued: true })
    expect(r.a.send).toHaveBeenCalledTimes(1)
  })

  it('too long after a steered message joined: the compaction resends both texts, once', async () => {
    const chat = createChatSessions(deps)
    const { a, first } = await running(chat)
    const second = chat.send({ paneId, text: 'two' })
    await flush()
    a.emit('accepted', { uuid: second.id })
    a.emit('turnEnd', { status: 'failed', isError: true, result: 'Prompt is too long' })
    await flush()
    expect(a.send.mock.calls.at(-1)[0].text).toBe('/compact')
    a.emit('turnEnd', { status: 'completed' })
    await flush()
    expect(a.send.mock.calls.at(-1)[0].text).toBe('one\n\ntwo')
    expect(userStatuses(first.id)).toEqual(['accepted', 'sent'])
    expect(a.send).toHaveBeenCalledTimes(4)
  })

  it('an exit before the agent took it fails it', async () => {
    const chat = createChatSessions(deps)
    const { a } = await running(chat)
    const second = chat.send({ paneId, text: 'two' })
    await flush()
    a.emit('exit', { code: 3, signal: null, stderrTail: '', crashed: true })
    await flush()
    expect(userStatuses(second.id)).toEqual(['failed'])
  })
})

describe('stream events', () => {
  it('journals full subagent snapshots and child provenance for replay', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    const roster = { groupId: 'turn', agents: [{ id: 'child', label: 'Inspect fixtures', state: 'working', startedAt: 1000 }] }
    const owner = { agentId: 'child', parentToolUseId: 'spawn' }
    a.emit('subagents', roster)
    a.emit('subagent', { phase: 'start', id: 'child', groupId: 'turn', status: 'working', startedAt: 1000 })
    a.emit('textDelta', { messageId: 'shared-id', text: 'Child', ...owner })
    a.emit('assistant', { messageId: 'shared-id', blocks: [{ type: 'text', text: 'Parent' }] })
    a.emit('assistant', { messageId: 'shared-id', ...owner, blocks: [{ type: 'text', text: 'Child' }, { type: 'thinking', text: 'Reading' }, { type: 'tool_use', id: 'child-tool', name: 'Read', input: { file_path: 'a' } }] })
    expect(events('assistant').map(e => e.text)).toEqual(['Parent', 'Child'])
    expect(last('assistantDelta')).toMatchObject(owner)
    expect(last('thinking')).toMatchObject(owner)
    expect(last('tool')).toMatchObject(owner)
    a.emit('toolResult', { toolUseId: 'child-tool', text: 'done', ...owner })
    expect(last('toolResult')).toMatchObject(owner)
    a.emit('assistant', { messageId: 'other', ...owner, blocks: [{ type: 'tool_use', id: 'pending-child-tool', name: 'Read', input: {} }] })
    a.emit('assistant', { messageId: 'p', blocks: [{ type: 'tool_use', id: 'pending-parent-tool', name: 'Read', input: {} }] })
    a.emit('turnEnd', { status: 'interrupted' })
    // The parent's open tool ends with its turn; a (background) child's stays open.
    expect(last('tool')).toMatchObject({ id: 'pending-parent-tool', status: 'error' })
    expect(events('tool').some(e => e.id === 'pending-child-tool' && e.status !== 'running')).toBe(false)
    // Its end closes it.
    a.emit('subagent', { phase: 'end', id: 'child', groupId: 'turn', status: 'stopped', startedAt: 1000 })
    expect(last('tool')).toMatchObject({ id: 'pending-child-tool', status: 'error', ...owner })
    a.emit('subagents', { ...roster, agents: [{ ...roster.agents[0], state: 'stopped', settledAt: 2000 }] })
    const stored = chat.history({ paneId }).events.map(row => row.event)
    expect(stored.filter(e => e.type === 'subagents')).toEqual(events('subagents'))
    expect(stored.find(e => e.type === 'subagent')).toMatchObject({ phase: 'start', id: 'child' })
    expect(stored.find(e => e.type === 'assistant' && e.agentId)).toMatchObject(owner)
    const reopened = createChatSessions(deps)
    expect(reopened.history({ paneId }).events.map(row => row.event).filter(e => e.type === 'subagents')).toEqual(events('subagents'))
  })

  it("keeps a background child's message open across the parent's turn end", async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    const owner = { agentId: 'bg', parentToolUseId: 'spawn' }
    a.emit('assistant', { messageId: 'c1', ...owner, blocks: [{ type: 'text', text: 'First' }] })
    a.emit('assistant', { messageId: 'p1', blocks: [{ type: 'text', text: 'Parent' }] })
    a.emit('turnEnd', { status: 'completed' })
    a.emit('assistant', { messageId: 'c1', ...owner, blocks: [{ type: 'text', text: 'Second' }] })
    a.emit('assistant', { messageId: 'p1', blocks: [{ type: 'text', text: 'Next turn' }] })
    expect(events('assistant').map(e => e.text)).toEqual(['First', 'Parent', 'First\n\nSecond', 'Next turn'])
  })

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

  it('hands the rate-limit windows to the usage indicator with the chat login folder only', async () => {
    const onRateLimit = vi.fn()
    const chat = createChatSessions(
      makeDeps({
        onRateLimit,
        env: { forPane: vi.fn(() => ({ Path: 'C:\\Windows', CLAUDE_CONFIG_DIR: 'C:\\fixture\\claude', SECRET_TOKEN: 'x' })) }
      })
    )
    await openOk(chat)
    adapters[0].emit('rateLimit', { status: 'allowed', fiveHour: { utilization: 0.5, resetsAt: 1 }, sevenDay: null })
    expect(onRateLimit).toHaveBeenCalledTimes(1)
    const arg = onRateLimit.mock.calls[0][0]
    expect(arg).toMatchObject({
      provider: 'claude',
      env: { CLAUDE_CONFIG_DIR: 'C:\\fixture\\claude' },
      rateLimit: { fiveHour: { utilization: 0.5, resetsAt: 1 }, sevenDay: null }
    })
    expect(Object.keys(arg.env)).toEqual(['CLAUDE_CONFIG_DIR'])
    expect(Number.isFinite(arg.since)).toBe(true)
    // A failing hook never breaks the chat.
    onRateLimit.mockImplementation(() => {
      throw new Error('boom')
    })
    adapters[0].emit('rateLimit', { fiveHour: { utilization: 0.6 } })
    expect(events('rateLimit')).toHaveLength(2)
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
    // The chat says what changed: one row each, journaled.
    expect(events('option')).toEqual([
      { type: 'option', option: 'model', value: 'opus', ok: true },
      { type: 'option', option: 'effort', value: 'max', ok: true }
    ])
    a.setEffort.mockResolvedValueOnce({ ok: false })
    expect((await chat.setOption({ paneId, effort: 'low' })).ok).toBe(false)
    expect(last('option')).toEqual({ type: 'option', option: 'effort', value: 'low', ok: false })
    expect(chat.history({ paneId }).events.map((e) => e.event.type)).toContain('option')
  })

  it('context usage: the newest facts, journaled at the end of a turn when they changed', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const a = adapters[0]
    chat.send({ paneId, text: 'hi' })
    a.emit('state', { state: 'running' })
    // Codex's token usage mid-turn: kept, not journaled yet.
    a.emit('usage', { total: { totalTokens: 900 }, last: { totalTokens: 300, inputTokens: 250, outputTokens: 50 }, contextWindow: 1000 })
    expect(events('contextUsage')).toEqual([])
    a.emit('turnEnd', { status: 'completed', userMessageUuids: [] })
    expect(events('contextUsage')).toEqual([{ type: 'contextUsage', usedTokens: 300, windowTokens: 1000 }])
    // Claude's comes after its turn's end: journaled at once; the same facts are not repeated.
    a.emit('contextUsage', { usedTokens: 300, windowTokens: null })
    a.emit('contextUsage', { usedTokens: 870, windowTokens: null })
    expect(events('contextUsage').at(-1)).toEqual({ type: 'contextUsage', usedTokens: 870, windowTokens: 1000 })
    expect(events('contextUsage')).toHaveLength(2)
    // A compaction: its row, and the usage unknown until the next response.
    a.emit('compacted', { trigger: 'manual', preTokens: 870 })
    expect(last('compacted')).toEqual({ type: 'compacted', trigger: 'manual', preTokens: 870 })
  })

  it('compact: Claude sends /compact; Codex and OpenCode ask their adapter; refused mid-turn or unsupported', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    expect(await chat.compact({ paneId })).toMatchObject({ ok: true })
    expect(adapters[0].send).toHaveBeenCalledWith(expect.objectContaining({ text: '/compact' }))

    const codex = createChatSessions({ ...deps, resolveCodex: async () => ({ exe: 'C:\\bin\\codex.exe' }) })
    await codex.open({ paneId: 'p2', agent: 'codex', cwd: tmp, permissions: 'manual' })
    await flush()
    const b = adapters.at(-1)
    expect(await codex.compact({ paneId: 'p2' })).toMatchObject({ ok: false, code: 'unsupported' })
    b.compact = vi.fn(async () => ({ ok: true }))
    expect(await codex.compact({ paneId: 'p2' })).toEqual({ ok: true })
    expect(b.compact).toHaveBeenCalledTimes(1)
    expect(last('notice')).toMatchObject({ kind: 'notice', text: 'Compacting the conversation…' })
    codex.send({ paneId: 'p2', text: 'go' })
    b.emit('state', { state: 'running' })
    expect(await codex.compact({ paneId: 'p2' })).toMatchObject({ ok: false, code: 'busy' })
    b.compact = vi.fn(async () => ({ ok: false, error: 'nope' }))
    b.emit('turnEnd', { status: 'completed', userMessageUuids: [] })
    expect(await codex.compact({ paneId: 'p2' })).toEqual({ ok: false, error: 'nope' })
    expect(await codex.compact({ paneId: 'nobody' })).toMatchObject({ ok: false, code: 'closed' })
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
  it.each(['cached', 'pending'])('removes revoked project metadata from %s discovery while retaining trusted cwd skills', async phase => {
    const projectDir = tmp, cwd = join(tmp, 'worktree')
    fs.mkdirSync(cwd)
    let trusted = true, finish
    deps.trust.isTrusted.mockImplementation(folder => folder !== projectDir || trusted)
    const skill = (base, name) => {
      const rootPath = join(base, '.claude', 'skills'), directoryPath = join(rootPath, name), skillFilePath = join(directoryPath, 'SKILL.md')
      return { id: skillFilePath, name, description: name, rootPath, directoryPath, skillFilePath, installed: true, providers: ['claude'], sourceKind: 'repo', updatedAt: null }
    }
    const skills = [skill(projectDir, 'revoked'), skill(cwd, 'retained')]
    const result = { skills, sources: skills.map(row => ({ id: row.rootPath, path: row.rootPath, sourceKind: 'repo', providers: ['claude'], owner: 'claude', exists: true })), scannedAt: 42 }
    const discoverSkills = vi.fn(() => phase === 'cached' ? Promise.resolve(result) : new Promise(resolve => { finish = resolve }))
    const chat = createChatSessions({ ...deps, discoverSkills }), h = wire(chat)
    await openOk(chat, { cwd, projectDir })
    const first = h['chat:skills']({ paneId })
    await flush()
    expect(discoverSkills).toHaveBeenCalledWith({ cwd, projectDir })
    if (phase === 'cached') expect((await first).result.skills).toHaveLength(2)
    trusted = false
    if (phase === 'pending') finish(result)
    const response = phase === 'pending' ? await first : await h['chat:skills']({ paneId })
    expect(response.result.skills.map(row => row.name)).toEqual(['retained'])
    expect(response.result.sources).toHaveLength(1)
    expect(JSON.stringify(response)).not.toContain(tmp)
    expect((await h['chat:skills']({ paneId })).result.skills.map(row => row.name)).toEqual(['retained'])
    expect(discoverSkills).toHaveBeenCalledTimes(1)
  })

  it('returns the checked cache when a global scan is busy, otherwise unavailable', async () => {
    const result = { skills: [], sources: [], scannedAt: 42 }
    const discoverSkills = vi.fn().mockResolvedValueOnce(result).mockRejectedValue(Object.assign(new Error('busy'), { code: 'SKILL_SCAN_BUSY' }))
    const chat = createChatSessions({ ...deps, discoverSkills }), h = wire(chat)
    await openOk(chat)
    expect(await h['chat:skills']({ paneId })).toEqual({ ok: true, result })
    expect(await h['chat:skills']({ paneId, refresh: true })).toEqual({ ok: true, result })
    await openOk(chat, { paneId: 'other-pane' })
    expect(await h['chat:skills']({ paneId: 'other-pane' })).toMatchObject({ ok: false })
  })

  it('discovers skills only for an approved existing pane, ignores caller paths, caches and refreshes', async () => {
    const result = { skills: [], sources: [], scannedAt: 42 }
    let finish
    const discoverSkills = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const chat = createChatSessions({ ...deps, discoverSkills })
    const h = wire(chat)
    expect(await h['chat:skills']({ paneId })).toMatchObject({ ok: false })
    await openOk(chat)
    const one = h['chat:skills']({ paneId, cwd: 'C:/other', home: 'C:/secret' })
    const two = h['chat:skills']({ paneId, refresh: true })
    await flush()
    expect(discoverSkills).toHaveBeenCalledTimes(1)
    expect(discoverSkills).toHaveBeenCalledWith({ cwd: tmp, projectDir: undefined })
    finish(result)
    expect(await one).toEqual({ ok: true, result })
    expect(await two).toEqual({ ok: true, result })
    await h['chat:skills']({ paneId })
    expect(discoverSkills).toHaveBeenCalledTimes(1)
    discoverSkills.mockResolvedValue(result)
    await h['chat:skills']({ paneId, refresh: true })
    expect(discoverSkills).toHaveBeenCalledTimes(2)
    deps.trust.isTrusted.mockReturnValue(false)
    expect(await h['chat:skills']({ paneId })).toMatchObject({ ok: false })
    expect(discoverSkills).toHaveBeenCalledTimes(2)
    expect(await h['chat:skills']({ paneId, refresh: 'yes' })).toMatchObject({ code: 'invalid' })
  })

  it('guards skill discovery with the same sender gate as other chat IPC', async () => {
    const registered = {}, ipc = { handle: (name, handler) => { registered[name] = handler } }
    guardIpc(ipc, { isTrustedSender: event => event.main === true })
    const discoverSkills = vi.fn(async () => ({ skills: [], sources: [], scannedAt: 42 }))
    const chat = createChatSessions({ ...deps, discoverSkills })
    chat.register(ipc)
    await openOk(chat)
    await expect(registered['chat:skills']({ main: false }, { paneId })).rejects.toThrow(/refused/)
    expect(discoverSkills).not.toHaveBeenCalled()
    expect(await registered['chat:skills']({ main: true }, { paneId })).toMatchObject({ ok: true })
  })

  it('retains commands in history even when a small tail excludes the original event', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    const commands = [{ name: 'review', kind: 'skill' }]
    adapters[0].emit('commands', { commands })
    adapters[0].emit('assistant', { messageId: 'after', blocks: [{ type: 'text', text: 'Reply' }] })
    expect(chat.history({ paneId, tail: 1 })).toMatchObject({ commands })
    expect(createChatSessions(deps).history({ paneId, tail: 1 })).toMatchObject({ commands })
  })

  function wire(chat) {
    const handlers = {}
    chat.register({ handle: (ch, fn) => (handlers[ch] = (q) => fn({}, q)) })
    return handlers
  }

  it('registers the chat channels', () => {
    const h = wire(createChatSessions(deps))
    expect(Object.keys(h).sort()).toEqual(
      ['chat:answer', 'chat:skills', 'chat:approvalInput', 'chat:approve', 'chat:close', 'chat:compact', 'chat:history', 'chat:historyOlder', 'chat:interrupt', 'chat:open', 'chat:send', 'chat:sendTeam', 'chat:setOption'].sort()
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
    // Steered into the running team turn at once.
    const u = chat.send({ paneId, text: 'after' })
    expect(u).toMatchObject({ queued: false, steered: true })
    await flush()
    expect(a.send).toHaveBeenLastCalledWith({ uuid: u.id, text: 'after' })
    stateCalls.length = 0
    a.emit('turnEnd', { status: 'failed', error: 'This content was flagged.' })
    await flush()
    expect(events('teamFailed')).toEqual([{ type: 'teamFailed', ids: ['m1'] }])
    expect(last('turnEnd')).toEqual({ type: 'turnEnd', status: 'failed', error: 'This content was flagged.' })
    // The turn's end carries the error (the window's one red notice): no notice with the same words.
    expect(events('notice').filter((n) => n.kind === 'error')).toEqual([])
    expect(stateCalls.slice(0, 3)).toEqual([['UserPromptSubmit'], ['StopFailure'], ['observe', 'ScreenReady']])
    // Codex dropped the steer with its failed turn: said at once, never sent again.
    expect(events('userStatus').filter((e) => e.id === u.id).map((e) => e.status)).toEqual(['failed'])
    expect(last('status')).toMatchObject({ state: 'idle' })
    expect(a.send).toHaveBeenCalledTimes(2)
    // A late echo still shows it taken, as a turn of its own.
    a.emit('accepted', { uuid: u.id })
    expect(events('userStatus').filter((e) => e.id === u.id).map((e) => e.status)).toEqual(['failed', 'accepted'])
    expect(last('status')).toMatchObject({ state: 'working' })
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

describe('idle stop', () => {
  const MIN = 60000
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
  afterEach(() => vi.useRealTimers())

  const turn = async (a, uuid) => {
    a.emit('accepted', { uuid })
    a.emit('turnEnd', { status: 'completed' })
    await flush()
  }
  const sleepNow = async (minutes) => {
    vi.advanceTimersByTime(minutes * MIN)
    await flush()
  }
  const ended = () => events('status').filter((s) => s.state === 'ended' || s.state === 'crashed')

  it('idle N minutes after a turn: the process stops, asleep, released, no ended', async () => {
    const chat = createChatSessions(deps)
    const r = await openOk(chat, { idleMinutes: 5 })
    const a = adapters[0]
    const u = chat.send({ paneId, text: 'hi' })
    await flush()
    await sleepNow(10) // a running turn is never stopped
    expect(a.close).not.toHaveBeenCalled()
    await turn(a, u.id)
    vi.advanceTimersByTime(5 * MIN - 1)
    await flush()
    expect(a.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await flush()
    expect(a.close).toHaveBeenCalledTimes(1)
    expect(a.close.mock.calls[0][0]).toBeUndefined() // graceful
    expect(last('status')).toMatchObject({ type: 'status', state: 'asleep', agent: 'claude', sessionId: r.sessionId })
    expect(last('status').launchToken).toBeUndefined()
    expect(ended()).toEqual([])
    expect(deps.state.unregister).toHaveBeenCalledWith(paneId, r.launchToken)
    expect(deps.team.revokeSecret).toHaveBeenCalledWith(paneId)
    expect(chat.list()).toEqual([expect.objectContaining({ paneId, status: 'asleep', sessionId: r.sessionId, launchToken: null })])
    const h = chat.history({ paneId })
    expect(h).toMatchObject({ open: false, asleep: true, live: { status: 'asleep', sessionId: r.sessionId, queued: 0 } })
    expect(h.events.at(-1).event).toMatchObject({ type: 'status', state: 'asleep' })
    // No process: nothing to interrupt.
    expect(await chat.interrupt({ paneId })).toMatchObject({ code: 'closed' })
  })

  it('30 minutes by default, counted from the open too', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat)
    await sleepNow(29)
    expect(adapters[0].close).not.toHaveBeenCalled()
    await sleepNow(1)
    expect(last('status').state).toBe('asleep')
  })

  it('any activity restarts the count', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat, { idleMinutes: 5 })
    const a = adapters[0]
    await sleepNow(4)
    chat.sendTeam({ paneId, messages: [{ id: 'm1', from: '#2', text: 'x' }] })
    await flush()
    await sleepNow(4)
    await turn(a, a.send.mock.calls[0][0].uuid)
    await sleepNow(4)
    a.emit('state', { state: 'running' }) // a turn of its own
    await sleepNow(4)
    a.emit('turnEnd', { status: 'completed' })
    await sleepNow(4)
    expect(a.close).not.toHaveBeenCalled()
    await sleepNow(1)
    expect(a.close).toHaveBeenCalledTimes(1)
  })

  it('a pending approval or a waiting team message blocks it; answering starts the count again', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat, { idleMinutes: 1 })
    const a = adapters[0]
    a.emit('permission', { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } })
    await sleepNow(60)
    expect(a.close).not.toHaveBeenCalled()
    expect(await chat.approve({ paneId, requestId: 'r1', decision: 'allow' })).toEqual({ ok: true })
    await sleepNow(1)
    expect(a.close).toHaveBeenCalledTimes(1)

    await chat.close({ paneId })
    await openOk(chat, { idleMinutes: 1 })
    const b = adapters[1]
    b.emit('permission', { requestId: 'r2', toolName: 'Bash', input: {} })
    chat.sendTeam({ paneId, messages: [{ id: 'm1', from: '#2', text: 'x' }] }) // waits for the approval
    b.emit('permissionCancelled', { requestId: 'r2' })
    await sleepNow(60)
    expect(b.close).not.toHaveBeenCalled()
  })

  it('0 = never', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat, { idleMinutes: 0 })
    await sleepNow(1440 * 3)
    expect(adapters[0].close).not.toHaveBeenCalled()
    expect(last('status').state).toBe('idle')
  })

  it('the old process exiting after the sleep is ignored (no crashed, still asleep)', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat, { idleMinutes: 1 })
    await sleepNow(1)
    adapters[0].emit('exit', { code: 3, signal: null, stderrTail: 'late', crashed: true })
    adapters[0].emit('turnEnd', { status: 'failed' })
    await flush()
    expect(ended()).toEqual([])
    expect(events('turnEnd')).toEqual([])
    expect(chat.list()[0].status).toBe('asleep')
  })

  it('a message while asleep waits and asks for a wake once; the open resumes the same conversation and sends them in order', async () => {
    const chat = createChatSessions(deps)
    const r = await openOk(chat, { idleMinutes: 1 })
    await sleepNow(1)
    const u1 = chat.send({ paneId, text: 'one' })
    expect(u1).toMatchObject({ ok: true, queued: true })
    expect(chat.sendTeam({ paneId, messages: [{ id: 'm1', from: '#2', text: 'team' }] })).toEqual({ ok: true, ids: ['m1'] })
    const u2 = chat.send({ paneId, text: 'two' })
    expect(events('wake')).toEqual([{ type: 'wake' }])
    expect(events('user').map((u) => u.status)).toEqual(['queued', 'queued', 'queued'])
    expect(chat.history({ paneId })).toMatchObject({ open: false, asleep: true, live: { queued: 3 } })
    // Another pane cannot take this conversation meanwhile.
    expect(await chat.open({ paneId: 'pane-2', cwd: tmp, permissions: 'manual', resumeId: r.sessionId })).toMatchObject({ code: 'busy' })
    deps.team.setSecret.mockClear()
    const r2 = await chat.open({ paneId, cwd: tmp, permissions: 'yolo', idleMinutes: 2 })
    await flush()
    expect(r2).toMatchObject({ ok: true, agent: 'claude', sessionId: r.sessionId })
    expect(r2.launchToken).not.toBe(r.launchToken)
    const b = adapters[1]
    expect(b.opts).toMatchObject({ resume: r.sessionId, permissionMode: 'bypassPermissions', cwd: tmp })
    expect(b.opts.sessionId).toBeUndefined()
    expect(deps.team.setSecret).toHaveBeenCalledWith(paneId, 'f'.repeat(64))
    expect(deps.state.register).toHaveBeenCalledTimes(2)
    expect(events('status').slice(-3).map((s) => s.state)).toEqual(['starting', 'idle', 'working'])
    // Users first, one turn each, then the team batch.
    expect(b.send.mock.calls[0][0]).toEqual({ uuid: u1.id, text: 'one' })
    expect(events('userStatus')).toContainEqual({ type: 'userStatus', id: u1.id, status: 'sent' })
    await turn(b, u1.id)
    expect(b.send.mock.calls[1][0]).toEqual({ uuid: u2.id, text: 'two' })
    await turn(b, u2.id)
    const teamTurn = b.send.mock.calls[2][0]
    expect(teamTurn.text).toBe(teamTurnText([{ from: '#2', text: 'team' }]))
    await turn(b, teamTurn.uuid)
    expect(events('teamAccepted')).toEqual([{ type: 'teamAccepted', ids: ['m1'] }])
    expect(chat.history({ paneId })).toMatchObject({ open: true, asleep: false })
    // Its own idle time now; a new sleep asks for a new wake.
    await sleepNow(2)
    expect(b.close).toHaveBeenCalledTimes(1)
    chat.send({ paneId, text: 'three' })
    expect(events('wake')).toHaveLength(2)
  })

  it('a wake refuses another conversation or agent; a message during the wake start still waits', async () => {
    const chat = createChatSessions(deps)
    const r = await openOk(chat, { idleMinutes: 1 })
    await sleepNow(1)
    const other = '0b8f3c2e-1111-4222-8333-944445555666'
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', resumeId: other })).toMatchObject({ ok: false, code: 'busy' })
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'codex' })).toMatchObject({ ok: false, code: 'busy' })
    expect(deps.createAdapter).toHaveBeenCalledTimes(1)
    let release
    const gate = new Promise((res) => (release = res))
    deps.resolveClaude.mockImplementationOnce(async () => {
      await gate
      return { exe: 'C:\\claude.exe' }
    })
    const waking = chat.open({ paneId, cwd: tmp, permissions: 'manual', resumeId: r.sessionId })
    await flush()
    const u = chat.send({ paneId, text: 'meanwhile' })
    expect(u).toMatchObject({ ok: true, queued: true })
    expect(events('wake')).toEqual([]) // already waking
    expect(chat.history({ paneId }).open).toBe(true)
    release()
    expect((await waking).sessionId).toBe(r.sessionId)
    await flush()
    expect(adapters[1].send).toHaveBeenCalledWith({ uuid: u.id, text: 'meanwhile' })
  })

  it('the wake waits for the old process to stop', async () => {
    let stopped
    const chat = createChatSessions({
      ...deps,
      createAdapter: (opts) => {
        const a = new FakeAdapter(opts, startResult)
        if (!adapters.length) a.close = vi.fn(() => new Promise((res) => (stopped = res)))
        adapters.push(a)
        return a
      }
    })
    await openOk(chat, { idleMinutes: 1 })
    await sleepNow(1)
    const waking = chat.open({ paneId, cwd: tmp, permissions: 'manual' })
    await flush()
    expect(adapters).toHaveLength(1)
    stopped()
    expect((await waking).ok).toBe(true)
    expect(adapters).toHaveLength(2)
  })

  it('a failed wake fails what waited, as a failed open', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat, { idleMinutes: 1 })
    await sleepNow(1)
    const u = chat.send({ paneId, text: 'one' })
    chat.sendTeam({ paneId, messages: [{ id: 'm1', from: '#2', text: 'x' }] })
    startResult = { ok: false, code: 'exit', error: 'boom' }
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual' })).toMatchObject({ ok: false, code: 'failed', detail: 'boom' })
    expect(events('userStatus')).toContainEqual({ type: 'userStatus', id: u.id, status: 'failed' })
    expect(events('teamFailed')).toEqual([{ type: 'teamFailed', ids: ['m1'] }])
    expect(last('status')).toMatchObject({ state: 'crashed' })
    expect(chat.list()).toEqual([])
    expect(chat.history({ paneId })).toMatchObject({ open: false, asleep: false, live: null })
    expect(chat.send({ paneId, text: 'x' })).toMatchObject({ ok: false, code: 'closed' })
  })

  it('close while asleep: dropped, ended once, waiting messages failed', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat, { idleMinutes: 1 })
    await sleepNow(1)
    const u = chat.send({ paneId, text: 'one' })
    expect(await chat.close({ paneId })).toEqual({ ok: true })
    expect(adapters[0].close).toHaveBeenCalledTimes(1) // the sleep's only
    expect(events('status').filter((s) => s.state === 'ended')).toHaveLength(1)
    expect(events('userStatus')).toContainEqual({ type: 'userStatus', id: u.id, status: 'failed' })
    expect(chat.list()).toEqual([])
    expect(chat.history({ paneId })).toMatchObject({ open: false, asleep: false })
  })

  it('a model chosen while asleep is used by the wake', async () => {
    const chat = createChatSessions(deps)
    await openOk(chat, { idleMinutes: 1, model: 'sonnet' })
    await sleepNow(1)
    expect(await chat.setOption({ paneId, model: 'opus' })).toMatchObject({ ok: true, model: 'opus' })
    await chat.open({ paneId, cwd: tmp, permissions: 'manual' })
    expect(adapters[1].opts.model).toBe('opus')
  })

  it('idleMinutes is checked (open and IPC)', async () => {
    const chat = createChatSessions(deps)
    const handlers = {}
    chat.register({ handle: (ch, fn) => (handlers[ch] = (q) => fn({}, q)) })
    for (const bad of [-1, 1441, 1.5, '5', NaN, true])
      expect(await handlers['chat:open']({ paneId, cwd: tmp, permissions: 'manual', idleMinutes: bad })).toMatchObject({ ok: false, code: 'invalid' })
    for (const bad of [-1, 1441, 2.5, '5'])
      expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', idleMinutes: bad })).toMatchObject({ ok: false, code: 'invalid' })
    expect(deps.createAdapter).not.toHaveBeenCalled()
    expect((await handlers['chat:open']({ paneId, cwd: tmp, permissions: 'manual', idleMinutes: 1440 })).ok).toBe(true)
    await chat.close({ paneId })
    expect((await handlers['chat:open']({ paneId, cwd: tmp, permissions: 'manual', idleMinutes: 0 })).ok).toBe(true)
  })
})

describe('earlier history of a resumed conversation', () => {
  const id = '0b8f3c2e-1111-4222-8333-944445555666'
  const line = (r) => JSON.stringify(r)
  function claudeFolder() {
    const home = join(tmp, 'claude-home')
    fs.mkdirSync(join(home, 'projects', 'C--p'), { recursive: true })
    fs.writeFileSync(
      join(home, 'projects', 'C--p', `${id}.jsonl`),
      [
        line({ type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00.000Z', message: { content: 'Earlier prompt' } }),
        line({ type: 'assistant', uuid: 'a1', timestamp: '2026-09-01T10:00:05.000Z', message: { id: 'm1', content: [{ type: 'text', text: 'Earlier answer' }] } })
      ].join('\n') + '\n'
    )
    return home
  }

  it('is journaled once, before the chat starts, and sent as one history event', async () => {
    const home = claudeFolder()
    const transcriptHome = vi.fn(() => home)
    deps = makeDeps({ transcriptHome })
    const chat = createChatSessions(deps)
    await openOk(chat, { resumeId: id })
    expect(transcriptHome).toHaveBeenCalledWith('claude', expect.any(Object))
    const batches = events('history')
    expect(batches).toHaveLength(1)
    const imported = batches[0].events.map((x) => x.event)
    expect(imported.map((e) => e.type)).toEqual(['notice', 'user', 'assistant', 'turnEnd'])
    expect(imported.every((e) => e.imported)).toBe(true)
    expect(imported[0].at).toBe(Date.parse('2026-09-01T10:00:00.000Z'))
    // Never sent one by one (no turn-end reminder for these).
    expect(events('turnEnd')).toHaveLength(0)
    const seqs = batches[0].events.map((x) => x.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    // The journal holds them, in order, before the live status.
    const stored = chat.history({ paneId }).events.map((row) => row.event.type)
    expect(stored.indexOf('user')).toBeLessThan(stored.lastIndexOf('status'))
    expect(chat.history({ paneId }).events.find((row) => row.event.type === 'assistant').event).toMatchObject({ text: 'Earlier answer', at: Date.parse('2026-09-01T10:00:05.000Z') })
    // Opened again (a reload, Tessel restarted): the journal has it, the file is not read again.
    await chat.close({ paneId })
    sent = []
    const again = createChatSessions(deps)
    await openOk(again, { resumeId: id })
    expect(events('history')).toHaveLength(0)
    expect(again.history({ paneId }).events.filter((row) => row.event.type === 'user')).toHaveLength(1)
  })

  it('reads nothing without a resume id, without an allowed folder, or when the file is missing', async () => {
    const home = claudeFolder()
    deps = makeDeps({ transcriptHome: vi.fn(() => home) })
    let chat = createChatSessions(deps)
    await openOk(chat)
    expect(events('history')).toHaveLength(0)
    await chat.close({ paneId, forget: true })

    deps = makeDeps({ transcriptHome: vi.fn(() => null) })
    chat = createChatSessions(deps)
    await openOk(chat, { resumeId: id })
    expect(events('history')).toHaveLength(0)
    await chat.close({ paneId, forget: true })

    deps = makeDeps({ transcriptHome: vi.fn(() => join(tmp, 'empty-home')) })
    chat = createChatSessions(deps)
    await openOk(chat, { resumeId: '9b8f3c2e-1111-4222-8333-944445555666' })
    expect(events('history')).toHaveLength(0)
    expect(adapters.at(-1).start).toHaveBeenCalled()
  })

  it('a reader that throws never stops the chat', async () => {
    deps = makeDeps({ transcriptHome: () => tmp, readHistory: () => { throw new Error('boom') } })
    const chat = createChatSessions(deps)
    await openOk(chat, { resumeId: id })
    expect(events('history')).toHaveLength(0)
  })
})

describe('older pages than the journal holds', () => {
  const id = '0b8f3c2e-1111-4222-8333-944445555666'
  it('asks the reader with the session, its folder and the time the journal starts; the cursor goes back as it came; nothing is journaled', async () => {
    const readOlder = vi.fn(() => ({ ok: true, events: [{ type: 'user', id: 'hist-old', text: 'Older', status: 'accepted', imported: true, at: 5 }], cursor: 1234, done: false }))
    deps = makeDeps({ transcriptHome: () => tmp, readHistory: () => ({ ok: true, truncated: true, events: [{ type: 'user', id: 'hist-u', text: 'Recent', status: 'accepted', imported: true, at: 1000 }] }), readOlder })
    const chat = createChatSessions(deps)
    await openOk(chat, { resumeId: id })
    expect(chat.history({ paneId }).older).toBe(true)
    const before = chat.history({ paneId }).events.length
    const first = await chat.historyOlder({ paneId })
    expect(first).toEqual({ ok: true, events: [expect.objectContaining({ text: 'Older' })], cursor: { k: 'file', n: 1234 }, done: false })
    expect(readOlder).toHaveBeenLastCalledWith(expect.objectContaining({ agent: 'claude', sessionId: id, home: tmp, before: null, beforeAt: 1000 }))
    readOlder.mockReturnValueOnce({ ok: true, events: [], cursor: null, done: true })
    expect(await chat.historyOlder({ paneId, cursor: first.cursor })).toEqual({ ok: true, events: [], cursor: null, done: true })
    expect(readOlder).toHaveBeenLastCalledWith(expect.objectContaining({ before: 1234, beforeAt: null }))
    expect(chat.history({ paneId }).events.length).toBe(before)
    // A cursor that is not ours (a path, another source) reads nothing.
    for (const bad of [{ k: 'file', n: 'C:/x' }, { k: 'opencode', n: 3 }, { k: 'file', n: -1 }, 'C:/x']) {
      readOlder.mockClear()
      expect((await chat.historyOlder({ paneId, cursor: bad })).ok).toBe(false)
      expect(readOlder).not.toHaveBeenCalled()
    }
  })

  it('no session, no folder or no conversation id: nothing older to ask for', async () => {
    deps = makeDeps({ transcriptHome: () => null })
    const chat = createChatSessions(deps)
    expect(await chat.historyOlder({ paneId })).toEqual({ ok: false, code: 'closed' })
    await openOk(chat, { resumeId: id })
    expect(chat.history({ paneId }).older).toBe(false)
    expect(await chat.historyOlder({ paneId })).toEqual({ ok: false, code: 'closed' })
  })
})

describe('opencode', () => {
  const sid = 'ses_f106568edffeX593nuABwvaO1O'
  beforeEach(() => {
    deps.resolveOpencode = vi.fn(async () => ({ exe: 'C:\npm\node_modules\opencode-ai\bin\opencode.exe', exeArgs: [], pathEnv: 'C:\npm' }))
    deps.env.forPane.mockReturnValue({
      Path: 'C:\Windows',
      TESSEL_PANE_ID: 'someone-else',
      OPENCODE_SERVER_PASSWORD: 'inherited',
      OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}',
      OPENCODE_PERMISSION: '"allow"',
      OPENCODE_AUTO_SHARE: '1',
      OPENCODE_CONFIG: 'C:\cfg\opencode.json',
      OPENCODE_API_KEY: 'zen',
      ANTHROPIC_API_KEY: 'a',
      ORCA_PANE: 'x',
      CLAUDECODE: '1'
    })
    startResult = { ok: true, pid: 3, info: { sessionId: sid, version: '1.18.33', model: 'opencode/nemotron-3.5-lightning-free' } }
  })

  it('a new session: provider/model, its id from the start, a clean environment', async () => {
    const chat = createChatSessions(deps)
    const r = await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'opencode', model: 'opencode/nemotron-3.5-lightning-free', effort: 'low' })
    expect(r).toMatchObject({ ok: true, agent: 'opencode', sessionId: sid, model: 'opencode/nemotron-3.5-lightning-free' })
    const o = adapters[0].opts
    expect(o).toMatchObject({ agent: 'opencode', exe: 'C:\npm\node_modules\opencode-ai\bin\opencode.exe', cwd: tmp, model: 'opencode/nemotron-3.5-lightning-free', effort: 'low', permissions: 'manual' })
    for (const k of ['sessionId', 'resume', 'threadId', 'permissionMode']) expect(o[k]).toBeUndefined()
    expect(o.env).toMatchObject({ TESSEL_PANE_ID: paneId, TESSEL_CHAT: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_CONFIG: 'C:\cfg\opencode.json', OPENCODE_API_KEY: 'zen', ANTHROPIC_API_KEY: 'a' })
    for (const k of ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION', 'OPENCODE_AUTO_SHARE', 'ORCA_PANE', 'CLAUDECODE', 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS']) expect(o.env[k]).toBeUndefined()
    expect(stateCalls[0]).toEqual(['register', 'opencode'])
    expect(chat.history({ paneId }).meta).toMatchObject({ sessionId: sid, agent: 'opencode' })
  })

  it('resume passes the session id; Plan is its plan agent', async () => {
    const chat = createChatSessions(deps)
    await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'opencode', resumeId: sid, permissionMode: 'plan' })
    expect(adapters[0].opts).toMatchObject({ sessionId: sid, permissions: 'manual', permissionMode: 'plan' })
  })

  it('validates OpenCode ids and models', async () => {
    const chat = createChatSessions(deps)
    for (const bad of [
      { resumeId: '01a0ec89-63d4-7980-80ae-d21e469ea231' },
      { resumeId: 'ses_short' },
      { model: 'nemotron' },
      { model: 'a/b/c' },
      { model: '--x/y' },
      { model: 'opencode/has space' }
    ])
      expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'opencode', ...bad })).toMatchObject({ ok: false, code: 'invalid' })
    // A provider/model is not a Claude model.
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', model: 'opencode/x' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(deps.createAdapter).not.toHaveBeenCalled()
  })

  it('no OpenCode found, start failures speak of OpenCode', async () => {
    deps.resolveOpencode.mockResolvedValue(null)
    const chat = createChatSessions(deps)
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'opencode' })).toMatchObject({ ok: false, code: 'no-opencode', error: 'OpenCode was not found. Install it, then try again.' })
    deps.resolveOpencode.mockResolvedValue({ exe: 'C:\oc.exe' })
    startResult = { ok: false, code: 'posture', error: 'agent general: edit allow' }
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'opencode' })).toMatchObject({ code: 'failed', error: expect.stringMatching(/OpenCode did not confirm the Manual permissions/), detail: 'agent general: edit allow' })
    startResult = { ok: false, code: 'auth', error: 'answered 200' }
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'opencode' })).toMatchObject({ error: 'OpenCode answered without its password: the chat was not opened.' })
    startResult = { ok: false, code: 'version', error: 'old' }
    expect(await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'opencode' })).toMatchObject({ error: expect.stringMatching(/older than 1\.18\.33/) })
  })

  it('options: provider/model, Manual / Plan / Yolo only', async () => {
    const chat = createChatSessions(deps)
    await chat.open({ paneId, cwd: tmp, permissions: 'yolo', agent: 'opencode' })
    const a = adapters[0]
    expect(await chat.setOption({ paneId, model: 'openrouter/anthropic:claude' })).toMatchObject({ ok: true, model: 'openrouter/anthropic:claude' })
    expect(await chat.setOption({ paneId, model: 'nemotron' })).toMatchObject({ ok: false })
    expect(await chat.setOption({ paneId, permissionMode: 'acceptEdits' })).toMatchObject({ ok: false })
    expect(await chat.setOption({ paneId, permissionMode: 'plan' })).toMatchObject({ ok: true })
    expect(await chat.setOption({ paneId, permissionMode: 'bypassPermissions' })).toMatchObject({ ok: true })
    expect(a.setPermissionMode.mock.calls.map((c) => c[0])).toEqual(['plan', 'bypassPermissions'])
  })

  it('clips the session rules a card shows', async () => {
    const chat = createChatSessions(deps)
    await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'opencode' })
    await flush()
    const many = Array.from({ length: 60 }, (_, i) => ({ kind: 'rule', tool: 'bash', content: 'x'.repeat(10000) + i }))
    adapters[0].emit('permission', { requestId: 'oc_perm_1', toolName: 'Bash', input: { command: 'ls' }, choices: ['accept', 'acceptForSession', 'decline'], sessionRules: many })
    const ev = last('approval')
    expect(ev.sessionRules).toHaveLength(50)
    expect(ev.sessionRules[0].content.length).toBeLessThan(10000)
  })

  it('a failed turn is said plainly', async () => {
    const chat = createChatSessions(deps)
    await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'opencode' })
    await flush()
    adapters[0].emit('turnEnd', { status: 'failed', result: 'Upstream request failed' })
    expect(last('turnEnd')).toMatchObject({ status: 'failed', error: 'Upstream request failed' })
    expect(events('notice').filter((n) => n.kind === 'error')).toEqual([])
    // No text of its own: said plainly, once.
    adapters[0].emit('turnEnd', { status: 'failed' })
    expect(last('notice')).toMatchObject({ kind: 'error', text: 'The turn failed.' })
  })
})

describe('opencode earlier history', () => {
  const sid = 'ses_f106568edffeX593nuABwvaO1O'
  const messages = [
    { info: { id: 'msg_1', role: 'user', sessionID: sid, time: { created: 5000 } }, parts: [{ type: 'text', text: 'hello' }] },
    { info: { id: 'msg_2', role: 'assistant', sessionID: sid, time: { created: 5100, completed: 5200 } }, parts: [{ type: 'text', text: 'hi there' }] }
  ]
  beforeEach(() => {
    deps.resolveOpencode = vi.fn(async () => ({ exe: 'C:\\oc.exe' }))
    startResult = { ok: true, pid: 3, info: { sessionId: sid } }
    deps.createAdapter = vi.fn((opts) => {
      const a = new FakeAdapter(opts, startResult)
      a.history = vi.fn(async () => ({ ok: true, messages, truncated: false }))
      adapters.push(a)
      return a
    })
  })

  it('a resumed chat shows its earlier turns once; a reload replays the journal', async () => {
    const chat = createChatSessions(deps)
    expect((await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'opencode', resumeId: sid })).ok).toBe(true)
    await flush()
    expect(adapters[0].history).toHaveBeenCalledTimes(1)
    const hist = sent.find((e) => e.event.type === 'history')
    const evs = hist.event.events.map((x) => x.event)
    expect(evs[0]).toMatchObject({ type: 'notice', kind: 'info', imported: true, text: 'Earlier conversation, from the history OpenCode keeps.', at: 5000 })
    expect(evs.slice(1).map((e) => [e.type, e.text || e.status])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi there'],
      ['turnEnd', 'completed']
    ])
    expect(chat.history({ paneId }).events.filter((e) => e.event.imported).length).toBe(4)
    await chat.close({ paneId })
    // Opened again on the same conversation: nothing fetched a second time.
    await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'opencode', resumeId: sid })
    await flush()
    expect(adapters[1].history).not.toHaveBeenCalled()
    expect(chat.history({ paneId }).events.filter((e) => e.event.imported).length).toBe(4)
  })

  it('a new conversation reads nothing', async () => {
    const chat = createChatSessions(deps)
    await chat.open({ paneId, cwd: tmp, permissions: 'manual', agent: 'opencode' })
    await flush()
    expect(adapters[0].history).not.toHaveBeenCalled()
  })
})
