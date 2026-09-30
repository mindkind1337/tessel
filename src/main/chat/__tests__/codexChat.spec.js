// @vitest-environment node
// The Codex adapter against a fake app-server (fixtures/fake-codex.cjs, a node
// script speaking the recorded JSON-RPC protocol), plus the pure normalizer
// against lines recorded from codex-cli 0.158.0. The real codex is never run.
import { describe, it, expect, afterEach } from 'vitest'
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  createCodexChat,
  buildCodexArgs,
  codexPolicy,
  codexDecision,
  createCodexState,
  normalizeCodexNotification,
  permissionFromCodexRequest,
  rateLimitFromCodex,
  isCodexAuthError,
  manualPostureProblem,
  settleTurn,
  newTurn,
  elicitationAnswerable,
  permissionFromElicitation,
  MAX_LINE,
  MAX_APPROVALS,
  DEFAULT_TIMEOUTS
} from '../codexChat'

const FAKE = join(__dirname, 'fixtures', 'fake-codex.cjs')
const REAL = join(__dirname, 'fixtures', 'codex-real-frames.jsonl')
const open = []

function setup({ env: envExtra = {}, ...opts } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tessel-fake-codex-'))
  const logFile = join(dir, 'log.jsonl')
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FAKE_CODEX_LOG: logFile, ...envExtra }
  const chat = createCodexChat({ exe: process.execPath, exeArgs: [FAKE], cwd: dir, env, ...opts })
  const events = []
  const emit = chat.emit.bind(chat)
  chat.emit = (type, payload) => {
    events.push({ type, ...payload })
    return emit(type, payload)
  }
  open.push(chat)
  const readLog = () =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : []
  const sent = () => readLog().filter((r) => r.t === 'in').map((r) => r.m)
  const requests = (method) => sent().filter((m) => m.method === method)
  return { chat, events, readLog, sent, requests, dir }
}

async function waitFor(fn, ms = 5000, label = 'condition') {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label)
    await new Promise((r) => setTimeout(r, 5))
  }
}
const ofType = (events, type) => events.filter((e) => e.type === type)
const turnEnds = (events) => ofType(events, 'turnEnd')

describe('Codex skill catalog', () => {
  it('starts with no invented commands and queries skills/list on demand', async () => {
    const { chat, events, requests, dir } = setup()
    expect((await chat.start()).ok).toBe(true)
    expect(ofType(events, 'commands')).toEqual([{ type: 'commands', commands: [] }])
    expect(requests('skills/list')).toEqual([])
    const result = await chat.skills({ refresh: true })
    expect(result).toMatchObject({ ok: true, result: { skills: [expect.objectContaining({ name: 'review', providers: ['codex'], installed: true })] } })
    expect(requests('skills/list')[0].params).toEqual({ cwds: [dir], forceReload: true })
  })
  it.each(['skills-unavailable', 'skills-timeout'])('keeps the session usable when discovery is %s', async mode => {
    const { chat } = setup({ env: mode === 'skills-timeout' ? { FAKE_CODEX_IGNORE: 'skills/list' } : { FAKE_CODEX_MODE: mode }, timeouts: { catalog: 25 } })
    expect((await chat.start()).ok).toBe(true)
    expect(await chat.skills()).toEqual({ ok: false })
    expect(chat.running).toBe(true)
  })
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const YOLO = { approvalPolicy: 'never', sandbox: 'danger-full-access' }
const MANUAL = { approvalPolicy: 'on-request', sandbox: 'workspace-write' }

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => {})))
})

describe('codexChat: start', () => {
  it('new thread: initialize, initialized, account/read, thread/start with the policy', async () => {
    const { chat, sent, dir } = setup({ permissions: 'manual' })
    const r = await chat.start()
    expect(r.ok).toBe(true)
    expect(r.pid).toBeTypeOf('number')
    expect(r.info).toMatchObject({ model: 'gpt-6-fake', cliVersion: '0.158.0-fake', codexHome: 'C:\\fake\\.codex', resumed: false, sandbox: 'workspaceWrite', approvalPolicy: 'on-request' })
    expect(r.info.auth).toEqual({ type: 'chatgpt', planType: 'plus' }) // never the email
    expect(JSON.stringify(r.info)).not.toContain('example.com')
    expect(chat.threadId).toBe(r.info.threadId)
    expect(chat.sessionId).toBe(r.info.threadId)
    const msgs = sent()
    expect(msgs.map((m) => m.method)).toEqual(['initialize', 'initialized', 'account/read', 'thread/start'])
    expect(msgs[0]).toEqual({ method: 'initialize', id: 1, params: { clientInfo: { name: 'tessel', title: 'Tessel', version: '0.0.0' }, capabilities: { experimentalApi: true } } })
    expect(msgs[1]).toEqual({ method: 'initialized' })
    expect(msgs.filter((m) => m.id !== undefined).map((m) => m.id)).toEqual([1, 2, 3])
    expect(msgs[3].params).toMatchObject({ cwd: dir, ...MANUAL, approvalsReviewer: 'user' })
    expect(chat.start()).toBe(chat.start())
  })

  it('yolo passes never + danger-full-access; the model goes on thread/start', async () => {
    const { chat, requests } = setup({ permissions: 'yolo', model: 'gpt-6-mini' })
    const r = await chat.start()
    expect(r.info.model).toBe('gpt-6-mini')
    expect(requests('thread/start')[0].params).toMatchObject({ ...YOLO, model: 'gpt-6-mini' })
  })

  it('resume: thread/resume with excludeTurns and the policy, same thread id', async () => {
    const tid = randomUUID()
    const { chat, requests } = setup({ threadId: tid, permissions: 'yolo' })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: true, info: { threadId: tid, resumed: true } })
    expect(requests('thread/resume')).toHaveLength(1)
    expect(requests('thread/resume')[0].params).toMatchObject({ threadId: tid, excludeTurns: true, ...YOLO })
    expect(requests('thread/start')).toHaveLength(0)
  })

  it('resume: -32602 -> retried without excludeTurns, policy still explicit', async () => {
    const tid = randomUUID()
    const { chat, requests } = setup({ threadId: tid, env: { FAKE_CODEX_MODE: 'resume-32602' } })
    expect((await chat.start()).ok).toBe(true)
    const [a, b] = requests('thread/resume')
    expect(a.params.excludeTurns).toBe(true)
    expect(b.params).not.toHaveProperty('excludeTurns')
    expect(b.params).toMatchObject({ threadId: tid, ...MANUAL })
  })

  it('resume answering another thread id is an error (a fork, not this chat)', async () => {
    const { chat, events } = setup({ threadId: randomUUID(), env: { FAKE_CODEX_MODE: 'resume-other' } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'failed' })
    expect(r.error).toMatch(/instead of/)
    await waitFor(() => ofType(events, 'exit').length, 5000, 'exit')
  })

  it('resume of a never-used thread (no rollout) -> a new thread, reported as superseding', async () => {
    const tid = randomUUID()
    const { chat, requests } = setup({ threadId: tid, env: { FAKE_CODEX_MODE: 'resume-norollout' } })
    const r = await chat.start()
    expect(r.ok).toBe(true)
    expect(r.info.supersededThreadId).toBe(tid)
    expect(r.info.threadId).not.toBe(tid)
    expect(requests('thread/start')[0].params).toMatchObject(MANUAL)
  })

  it('not signed in (account/read: no account) -> code signin, authError, closed', async () => {
    const { chat, events } = setup({ env: { FAKE_CODEX_MODE: 'signin' } })
    expect(await chat.start()).toMatchObject({ ok: false, code: 'signin' })
    expect(ofType(events, 'authError')).toHaveLength(1)
    await waitFor(() => ofType(events, 'exit').length, 5000, 'exit')
    expect(ofType(events, 'exit')[0].crashed).toBe(false)
  })

  it('account/read unsupported -> the start goes on', async () => {
    const { chat } = setup({ env: { FAKE_CODEX_MODE: 'noaccount-read' } })
    const r = await chat.start()
    expect(r.ok).toBe(true)
    expect(r.info.auth).toBe(null)
  })

  it('"Not logged in" on stderr before any answer -> code signin', async () => {
    const { chat, events } = setup({ env: { FAKE_CODEX_MODE: 'signin-exit' } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'signin' })
    expect(r.error).toMatch(/Not logged in/)
    expect(ofType(events, 'authError')).toHaveLength(1)
  })

  it('exit before initialize -> code exit with the (ANSI-free) stderr text', async () => {
    const { chat, events } = setup({ env: { FAKE_CODEX_MODE: 'crash-start' } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'exit' })
    expect(r.error).toMatch(/could not start/)
    expect(r.error).not.toContain('\u001b')
    expect(ofType(events, 'exit')[0]).toMatchObject({ code: 2, crashed: true })
  })

  it('no initialize answer -> code timeout and the process is closed', async () => {
    const { chat, events } = setup({ env: { FAKE_CODEX_MODE: 'noinit' }, timeouts: { start: 200 } })
    expect(await chat.start()).toMatchObject({ ok: false, code: 'timeout' })
    await waitFor(() => ofType(events, 'exit').length, 5000, 'exit')
  })

  it('a missing executable -> code spawn', async () => {
    const chat = createCodexChat({ exe: join(tmpdir(), 'no-such-codex-' + randomUUID() + '.exe'), cwd: tmpdir(), env: { PATH: process.env.PATH } })
    open.push(chat)
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'spawn' })
    expect(r.error).toMatch(/ENOENT/)
  })

  it('spawns [...exeArgs, app-server] without a shell, hidden, with the given env', async () => {
    const calls = []
    const spy = (exe, args, options) => {
      calls.push({ exe, args, options })
      return nodeSpawn(exe, args, options)
    }
    const { chat, readLog } = setup({ spawn: spy, env: { FAKE_MARKER: 'm1' } })
    expect((await chat.start()).ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual([FAKE, 'app-server'])
    expect(calls[0].options).toMatchObject({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    expect(readLog().find((r) => r.t === 'argv').argv).toEqual(['app-server'])
    expect(readLog().find((r) => r.t === 'env').marker).toBe('m1')
    expect(buildCodexArgs({ exeArgs: ['x.js'] })).toEqual(['x.js', 'app-server'])
  })

  it('rejects bad options before spawning anything', () => {
    const base = { exe: process.execPath, env: {}, cwd: tmpdir() }
    expect(() => createCodexChat({ ...base, exe: '' })).toThrow(/exe/)
    expect(() => createCodexChat({ ...base, env: null })).toThrow(/env/)
    expect(() => createCodexChat({ ...base, threadId: '--x' })).toThrow(/threadId/)
    expect(() => createCodexChat({ ...base, model: '--foo' })).toThrow(/model/)
    expect(() => createCodexChat({ ...base, effort: '-c' })).toThrow(/effort/)
    expect(() => createCodexChat({ ...base, permissions: 'bypassPermissions' })).toThrow(/permissions/)
    expect(() => createCodexChat({ ...base, exeArgs: [1] })).toThrow(/exeArgs/)
  })
})

describe('codexChat: turns', () => {
  it('send -> queued, accepted once, deltas, assistant, usage, rate limit, turnEnd, idle', async () => {
    const { chat, events, requests } = setup({ effort: 'low' })
    await chat.start()
    expect(await chat.send({ uuid: 'bad', text: '   ' })).toEqual({ ok: false, error: 'empty' })
    const uuid = randomUUID()
    expect(await chat.send({ uuid, text: 'hello there' })).toEqual({ ok: true, uuid })
    await waitFor(() => turnEnds(events).length === 1, 5000, 'turnEnd')
    const ts = requests('turn/start')[0].params
    expect(ts).toEqual({
      threadId: chat.threadId,
      clientUserMessageId: uuid,
      input: [{ type: 'text', text: 'hello there', text_elements: [] }],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      effort: 'low'
    })
    expect(ofType(events, 'queued')).toEqual([{ type: 'queued', uuid }])
    expect(ofType(events, 'accepted')).toEqual([{ type: 'accepted', uuid }]) // started + completed echo -> once
    expect(ofType(events, 'init')[0]).toMatchObject({ sessionId: chat.threadId, model: 'gpt-6-fake', permissionMode: 'default', version: '0.158.0-fake' })
    expect(ofType(events, 'init')[0].mcpServers).toEqual([{ name: 'tessel-team', status: 'ready' }, { name: 'node_repl', status: 'ready' }])
    const deltas = ofType(events, 'textDelta')
    expect(deltas.map((d) => d.text).join('')).toBe('Reply to: hello there')
    const asst = ofType(events, 'assistant')[0]
    expect(asst.blocks).toEqual([{ type: 'text', text: 'Reply to: hello there' }])
    expect(deltas[0].messageId).toBe(asst.messageId)
    const end = turnEnds(events)[0]
    expect(end).toMatchObject({ status: 'completed', result: 'Reply to: hello there', isError: false, userMessageUuids: [uuid], durationMs: 42 })
    expect(end.usage).toMatchObject({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40, context_window: 258400 })
    expect(ofType(events, 'rateLimit')[0]).toMatchObject({ status: 'allowed', fiveHour: { utilization: 0.04, resetsAt: 1790690000 }, sevenDay: { utilization: 0.27, resetsAt: 1791226944 } })
    const states = ofType(events, 'state').map((s) => s.state)
    expect(states).toEqual(['running', 'idle'])
    const idx = (t) => events.findIndex((e) => e.type === t)
    expect(idx('accepted')).toBeLessThan(idx('textDelta'))
    expect(idx('assistant')).toBeLessThan(idx('turnEnd'))
  })

  it('compact: thread/compact/start, a turn of its own that says the context was compacted once', async () => {
    const { chat, events, requests } = setup()
    await chat.start()
    expect(await chat.compact()).toEqual({ ok: true })
    expect(requests('thread/compact/start')[0].params).toEqual({ threadId: chat.threadId })
    await waitFor(() => turnEnds(events).length === 1, 5000, 'turnEnd')
    expect(ofType(events, 'compacted')).toEqual([{ type: 'compacted' }])
    expect(turnEnds(events)[0]).toMatchObject({ status: 'completed' })
  })

  it('two turns; each turn/start carries the policy; per-turn usage; model/effort set for the next turn', async () => {
    const { chat, events, requests } = setup({ permissions: 'yolo' })
    const { pid } = await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'one' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(await chat.setModel('gpt-6-mini')).toEqual({ ok: true })
    expect(await chat.setEffort('high')).toEqual({ ok: true })
    expect((await chat.setModel('--x')).ok).toBe(false)
    expect((await chat.setEffort('')).ok).toBe(false)
    await chat.send({ uuid: randomUUID(), text: 'two' })
    await waitFor(() => turnEnds(events).length === 2)
    expect(turnEnds(events).map((e) => e.result)).toEqual(['Reply to: one', 'Reply to: two'])
    expect(turnEnds(events)[1].usage.input_tokens).toBe(100) // this turn's, not the thread's total
    const [a, b] = requests('turn/start').map((m) => m.params)
    expect(a).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })
    expect(a).not.toHaveProperty('model')
    expect(b).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, model: 'gpt-6-mini', effort: 'high' })
    expect(ofType(events, 'init')[1]).toMatchObject({ model: 'gpt-6-mini', permissionMode: 'bypassPermissions' })
    expect(chat.pid).toBe(pid)
    expect(chat.running).toBe(true)
  })

  it('setPermissionMode switches the posture of the next turns (both ways)', async () => {
    const { chat, events, requests } = setup({ permissions: 'yolo' })
    await chat.start()
    expect(await chat.setPermissionMode('default')).toEqual({ ok: true, response: { mode: 'default' } })
    await chat.send({ uuid: randomUUID(), text: 'a' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(await chat.setPermissionMode('bypassPermissions')).toEqual({ ok: true, response: { mode: 'bypassPermissions' } })
    await chat.send({ uuid: randomUUID(), text: 'b' })
    await waitFor(() => turnEnds(events).length === 2)
    expect((await chat.setPermissionMode('dontAsk')).ok).toBe(false)
    const [a, b] = requests('turn/start').map((m) => m.params)
    expect(a).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } })
    expect(b).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })
    expect(chat.permissions).toBe('yolo')
  })

  it('a message sent mid-turn goes as turn/steer and joins the running turn', async () => {
    const { chat, events, requests } = setup()
    await chat.start()
    const a = randomUUID()
    const b = randomUUID()
    await chat.send({ uuid: a, text: 'SLOW count' })
    await waitFor(() => ofType(events, 'textDelta').length > 3, 5000, 'first deltas')
    expect(turnEnds(events)).toHaveLength(0)
    expect(await chat.send({ uuid: b, text: 'STEER also say banana' })).toEqual({ ok: true, uuid: b, steered: true })
    await waitFor(() => turnEnds(events).length === 1, 10000, 'turn end')
    const steer = requests('turn/steer')[0].params
    expect(steer).toMatchObject({ threadId: chat.threadId, clientUserMessageId: b, input: [{ type: 'text', text: 'STEER also say banana', text_elements: [] }] })
    expect(typeof steer.expectedTurnId).toBe('string')
    expect(requests('turn/start')).toHaveLength(1)
    expect(ofType(events, 'queued').map((e) => e.uuid)).toEqual([a, b])
    expect(ofType(events, 'accepted').map((e) => e.uuid)).toEqual([a, b])
    const end = turnEnds(events)[0]
    expect(end.userMessageUuids).toEqual([a, b])
    expect(end.result).toMatch(/steered: STEER also say banana/)
    expect(ofType(events, 'state').filter((s) => s.state === 'running')).toHaveLength(1)
  })

  it('interrupt -> turn/interrupt with the turn id, turnEnd interrupted; usable afterwards', async () => {
    const { chat, events, requests } = setup()
    await chat.start()
    expect(await chat.interrupt()).toEqual({ ok: true, stillQueued: [] }) // nothing running
    expect(requests('turn/interrupt')).toHaveLength(0)
    await chat.send({ uuid: randomUUID(), text: 'SLOW long answer' })
    await waitFor(() => ofType(events, 'textDelta').length > 2, 5000, 'deltas')
    expect(await chat.interrupt()).toEqual({ ok: true, stillQueued: [] })
    await waitFor(() => turnEnds(events).length === 1, 5000, 'turnEnd')
    expect(turnEnds(events)[0]).toMatchObject({ status: 'interrupted', isError: true })
    const ti = requests('turn/interrupt')[0].params
    expect(ti).toEqual({ threadId: chat.threadId, turnId: turnEnds(events)[0].turnId })
    await chat.send({ uuid: randomUUID(), text: 'again' })
    await waitFor(() => turnEnds(events).length === 2)
    expect(turnEnds(events)[1].status).toBe('completed')
    await chat.close()
    expect(ofType(events, 'exit')[0]).toMatchObject({ code: 0, crashed: false })
  })

  it('tools: Bash / mcp / WebSearch tool_use + clipped results, thinking; another thread ignored', async () => {
    const { chat, events } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'TOOLS please' })
    await waitFor(() => turnEnds(events).length === 1)
    const uses = ofType(events, 'assistant').flatMap((e) => e.blocks).filter((b) => b.type === 'tool_use')
    expect(uses.map((u) => u.name)).toEqual(['Bash', 'mcp:tessel-team.team_tasks', 'WebSearch'])
    expect(uses[0]).toMatchObject({ id: 'exec-big', input: { command: 'type big.txt' } })
    expect(uses[0].input.rawCommand).toMatch(/powershell\.exe/)
    expect(uses[1].input).toEqual({ me: '#2' })
    expect(uses[2].input).toEqual({ query: 'codex app-server' })
    const results = ofType(events, 'toolResult')
    expect(results.map((r) => r.toolUseId)).toEqual(['exec-big', 'mcp-1', 'ws-1'])
    expect(results[0]).toMatchObject({ isError: false })
    expect(results[0].text).toBe('x'.repeat(8192) + ' … (11808 more bytes)')
    expect(results[1]).toMatchObject({ isError: false, text: '[] no tasks' })
    expect(results[2].text).toBe('codex app-server (2 results)')
    const thinking = ofType(events, 'assistant').flatMap((e) => e.blocks).filter((b) => b.type === 'thinking')
    expect(thinking).toEqual([{ type: 'thinking', text: '**Planning** the work' }])
    expect(ofType(events, 'textDelta').some((d) => d.text === 'NOT MINE')).toBe(false)
  })

  it('malformed lines are ignored and CRLF line ends are tolerated', async () => {
    const { chat, events } = setup({ env: { FAKE_CODEX_CRLF: '1', FAKE_CODEX_GARBAGE: '1' } })
    expect((await chat.start()).ok).toBe(true)
    await chat.send({ uuid: randomUUID(), text: 'crlf' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(turnEnds(events)[0]).toMatchObject({ status: 'completed', result: 'Reply to: crlf' })
  })

  it('an error with willRetry:false ends the turn at once (no turn/completed needed)', async () => {
    const { chat, events } = setup()
    await chat.start()
    const uuid = randomUUID()
    await chat.send({ uuid, text: 'FILTER this' })
    await waitFor(() => turnEnds(events).length === 1, 3000, 'turnEnd')
    expect(turnEnds(events)[0]).toMatchObject({ status: 'failed', isError: true, result: 'This request was flagged by the content filter.', userMessageUuids: [uuid] })
    expect(ofType(events, 'state').map((s) => s.state)).toEqual(['running', 'idle'])
    // the next turn works
    await chat.send({ uuid: randomUUID(), text: 'after' })
    await waitFor(() => turnEnds(events).length === 2)
    expect(turnEnds(events)[1].status).toBe('completed')
  })

  it('an auth failure in a turn -> authError and ONE failed turnEnd (turn/completed after the error ignored)', async () => {
    const { chat, events } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'AUTHFAIL' })
    await waitFor(() => turnEnds(events).length === 1)
    await sleep(100)
    expect(turnEnds(events)).toHaveLength(1)
    expect(turnEnds(events)[0]).toMatchObject({ status: 'failed', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } } })
    expect(ofType(events, 'authError').length).toBeGreaterThanOrEqual(1)
  })

  it('a retried error does not end the turn', async () => {
    const { chat, events } = setup({ timeouts: { idleSettle: 30 } })
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'RETRY once' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(turnEnds(events)[0]).toMatchObject({ status: 'completed', result: 'Reply to: RETRY once' })
    expect(ofType(events, 'retry')).toHaveLength(1)
  })

  it('thread idle with no turn/completed settles the turn after idleSettle', async () => {
    const { chat, events } = setup({ timeouts: { idleSettle: 150 } })
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'SILENTIDLE' })
    await sleep(60)
    expect(turnEnds(events)).toHaveLength(0) // idle alone is not the end (it precedes turn/completed)
    await waitFor(() => turnEnds(events).length === 1, 3000, 'settled')
    expect(turnEnds(events)[0].status).toBe('completed')
    expect(DEFAULT_TIMEOUTS.idleSettle).toBeGreaterThanOrEqual(1000)
  })
})

describe('codexChat: approvals', () => {
  async function ask(text = 'APPROVE run node', opts = {}) {
    const s = setup(opts)
    await s.chat.start()
    await s.chat.send({ uuid: randomUUID(), text })
    const perm = await waitFor(() => ofType(s.events, 'permission')[0], 5000, 'permission')
    const answers = () => s.sent().filter((m) => m.id !== undefined && !m.method)
    return { ...s, perm, answers }
  }

  it('command approval -> permission event; allow once -> accept; answered once only', async () => {
    const { chat, events, perm, answers } = await ask()
    expect(perm).toMatchObject({
      toolName: 'Bash',
      displayName: 'Bash',
      input: { command: 'node -e "console.log(6*7)"' },
      description: 'Run node outside the sandbox?',
      suggestions: []
    })
    expect(perm.requestId).toMatch(/^[A-Za-z0-9._:-]{1,120}$/) // sessions.js validId
    expect(perm.input.rawCommand).toMatch(/powershell/)
    expect(perm.toolUseId).toMatch(/^exec-/)
    expect(perm.choices).toContain('acceptForSession')
    expect(chat.pendingPermissions()).toEqual([perm.requestId])
    expect(await chat.answerPermission(perm.requestId, { behavior: 'allow', session: false })).toEqual({ ok: true, decision: 'accept' })
    expect(await chat.answerPermission(perm.requestId, { behavior: 'allow' })).toMatchObject({ ok: false })
    await waitFor(() => turnEnds(events).length === 1)
    expect(answers()).toEqual([{ id: 0, result: { decision: 'accept' } }])
    expect(ofType(events, 'toolResult')[0]).toMatchObject({ toolUseId: perm.toolUseId, isError: false, text: '42\r\n' })
    expect(turnEnds(events)[0].result).toBe('The command output is 42.')
    expect(ofType(events, 'permissionCancelled')).toHaveLength(0) // resolved after our answer: nothing pending
  })

  it('allow for the session -> acceptForSession when offered', async () => {
    const { chat, events, perm, answers } = await ask()
    await chat.answerPermission(perm.requestId, { behavior: 'allow', session: true })
    await waitFor(() => turnEnds(events).length === 1)
    expect(answers()[0].result).toEqual({ decision: 'acceptForSession' })
  })

  it('allow for the session when not offered (recorded choices) -> accept', async () => {
    const { chat, events, perm, answers } = await ask('APPROVE1 run node')
    expect(perm.choices).toEqual(['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['node', '-e', 'console.log(6*7)'] } }, 'cancel'])
    await chat.answerPermission(perm.requestId, { behavior: 'allow', session: true })
    await waitFor(() => turnEnds(events).length === 1)
    expect(answers()[0].result).toEqual({ decision: 'accept' })
  })

  it('deny -> decline (even when not offered); the item ends declined', async () => {
    const { chat, events, perm, answers } = await ask('APPROVE1 run node')
    expect(await chat.answerPermission(perm.requestId, { behavior: 'maybe' })).toMatchObject({ ok: false })
    expect(await chat.answerPermission(perm.requestId, { behavior: 'deny', message: 'Not now.' })).toEqual({ ok: true, decision: 'decline' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(answers()[0].result).toEqual({ decision: 'decline' })
    expect(ofType(events, 'toolResult')[0]).toMatchObject({ isError: true, text: 'The command was declined.' })
  })

  it('file change approval -> Edit with the changes of its item', async () => {
    const { chat, events, perm, answers } = await ask('EDIT the file')
    expect(perm).toMatchObject({ toolName: 'Edit', displayName: 'Edit', description: 'Write a.txt?', toolUseId: 'patch-1' })
    expect(perm.input.file_path).toBe('C:\\w\\a.txt')
    expect(perm.input.changes[0]).toMatchObject({ path: 'C:\\w\\a.txt', kind: 'update' })
    expect(perm.choices).toEqual(['accept', 'acceptForSession', 'decline', 'cancel'])
    await chat.answerPermission(perm.requestId, { behavior: 'allow', session: true })
    await waitFor(() => turnEnds(events).length === 1)
    expect(answers()[0].result).toEqual({ decision: 'acceptForSession' })
    const use = ofType(events, 'assistant').flatMap((e) => e.blocks).find((b) => b.type === 'tool_use')
    expect(use).toMatchObject({ id: 'patch-1', name: 'Edit', input: { file_path: 'C:\\w\\a.txt' } })
    expect(ofType(events, 'toolResult')[0]).toMatchObject({ toolUseId: 'patch-1', isError: false, text: 'update C:\\w\\a.txt' })
  })

  it('interrupt while an approval is pending cancels it; a late answer is refused', async () => {
    const { chat, events, perm } = await ask()
    await chat.interrupt()
    await waitFor(() => turnEnds(events).length === 1)
    expect(turnEnds(events)[0].status).toBe('interrupted')
    expect(ofType(events, 'permissionCancelled').map((e) => e.requestId)).toEqual([perm.requestId])
    expect(await chat.answerPermission(perm.requestId, { behavior: 'allow' })).toMatchObject({ ok: false })
  })

  it('other server requests are answered automatically; questions wait for explicit cancellation', async () => {
    const { chat, events, readLog } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'SERVERREQS' })
    const question = await waitFor(() => ofType(events, 'question')[0])
    expect(await chat.answerQuestion(question.requestId, { cancel: true })).toEqual({ ok: true })
    await waitFor(() => turnEnds(events).length === 1)
    const got = Object.fromEntries(readLog().filter((r) => r.t === 'answer').map((r) => [r.method, r.response]))
    expect(got['item/tool/requestUserInput'].result).toEqual({ answers: {} })
    expect(got['mcpServer/elicitation/request'].result).toEqual({ action: 'decline', content: null, _meta: null })
    expect(got['item/permissions/requestApproval'].result).toEqual({ permissions: {}, scope: 'turn', strictAutoReview: true })
    expect(got['item/tool/call'].result).toEqual({ contentItems: [], success: false })
    expect(got.execCommandApproval.result).toEqual({ decision: 'abort' })
    expect(got.applyPatchApproval.result).toEqual({ decision: 'abort' })
    expect(got['account/chatgptAuthTokens/refresh'].error.code).toBe(-32001)
    expect(got['attestation/generate'].error.code).toBe(-32001)
    expect(got['some/unknown/request'].error).toMatchObject({ code: -32000 })
    expect(ofType(events, 'permission')).toHaveLength(0)
  })

  it('codexDecision / codexPolicy tables', () => {
    expect(codexDecision({ behavior: 'allow' })).toBe('accept')
    expect(codexDecision({ behavior: 'allow', session: true })).toBe('acceptForSession')
    expect(codexDecision({ behavior: 'allow', session: true }, ['accept', 'cancel'])).toBe('accept')
    expect(codexDecision({ behavior: 'deny' }, ['accept'])).toBe('decline')
    expect(codexDecision({ behavior: 'x' })).toBe(null)
    expect(codexPolicy('yolo')).toMatchObject({ ...YOLO, sandboxPolicy: { type: 'dangerFullAccess' } })
    expect(codexPolicy('manual')).toMatchObject({ ...MANUAL, sandboxPolicy: { type: 'workspaceWrite' } })
  })
})

describe('codexChat: requests, exit and close', () => {
  it('an unanswered request times out (configurable; 30 s by default)', async () => {
    expect(DEFAULT_TIMEOUTS.request).toBe(30000)
    expect(DEFAULT_TIMEOUTS.start).toBe(30000)
    const { chat, events } = setup({ env: { FAKE_CODEX_IGNORE: 'turn/start' }, timeouts: { request: 150 } })
    await chat.start()
    const t0 = Date.now()
    const r = await chat.send({ uuid: randomUUID(), text: 'x' })
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/timed out/)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140)
    expect(ofType(events, 'queued')).toHaveLength(0)
  })

  it('a crash -> exit event with the ANSI-free stderr tail; later calls fail', async () => {
    const { chat, events } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'CRASH now' })
    const exit = await waitFor(() => ofType(events, 'exit')[0], 5000, 'exit')
    expect(exit).toMatchObject({ code: 2, crashed: true })
    expect(exit.stderrTail).toMatch(/ERROR fatal: simulated crash/)
    expect(exit.stderrTail).not.toContain('\u001b')
    expect(chat.running).toBe(false)
    expect(await chat.send({ uuid: randomUUID(), text: 'x' })).toMatchObject({ ok: false })
    expect(await chat.interrupt()).toMatchObject({ ok: false })
  })

  it('close() ends stdin and app-server exits by itself', async () => {
    const { chat, events, readLog } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'hi' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(await chat.close()).toEqual({ ok: true, killed: false })
    expect(readLog().some((r) => r.t === 'stdin-end')).toBe(true)
    expect(ofType(events, 'exit')[0]).toMatchObject({ code: 0, crashed: false })
    expect(await chat.close()).toEqual({ ok: true })
  })

  it('close() kills the tree when app-server does not exit after stdin end', async () => {
    const killed = []
    const { chat, events } = setup({
      env: { FAKE_CODEX_MODE: 'hang' },
      timeouts: { close: 200 },
      killTree: async (child) => {
        killed.push(child.pid)
        child.kill('SIGKILL')
      }
    })
    const { pid } = await chat.start()
    expect(await chat.close()).toEqual({ ok: true, killed: true })
    expect(killed).toEqual([pid])
    expect(ofType(events, 'exit')[0].crashed).toBe(false)
  }, 30000)
})

describe('codexChat: recorded frames (codex-cli 0.158.0)', () => {
  const frames = readFileSync(REAL, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const byLabel = (label) => frames.find((f) => f.label === label).m

  it('a recorded turn normalizes to the adapter events', () => {
    const start = byLabel('thread/start response (on-request, read-only)').result
    const state = createCodexState({ threadId: start.thread.id, model: start.model })
    const echo = byLabel('userMessage echo started (clientId = our id)')
    state.sent.add(echo.params.item.clientId)
    const events = []
    for (const f of frames) {
      if (f.dir !== 'in' || !f.m.method || f.m.id !== undefined) continue
      events.push(...normalizeCodexNotification(f.m.method, f.m.params, state))
      if (f.label === 'turn/completed completed') break
    }
    const types = events.map((e) => e.type)
    expect(types).toEqual(['state', 'init', 'accepted', 'textDelta', 'assistant', 'rateLimit', 'turnEnd', 'state'])
    expect(events[1]).toMatchObject({ sessionId: start.thread.id, model: 'gpt-6-astra', version: '0.158.0' })
    expect(events[2].uuid).toBe(echo.params.item.clientId)
    expect(events[3]).toMatchObject({ text: 'OK', messageId: events[4].messageId })
    expect(events[4].blocks).toEqual([{ type: 'text', text: 'OK' }])
    expect(events[6]).toMatchObject({ status: 'completed', result: 'OK', userMessageUuids: [echo.params.item.clientId], durationMs: 3338, usage: null })
    // the weekly window came as primary: sevenDay, no fiveHour
    expect(rateLimitFromCodex(byLabel('rateLimits (weekly window as primary)').params.rateLimits)).toEqual({ status: 'allowed', fiveHour: null, sevenDay: { utilization: 0.27, resetsAt: 1791226944 }, planType: 'prolite' })
  })

  it('a compaction (thread/compacted, or its contextCompaction item) is said once per turn', () => {
    const state = createCodexState({ threadId: 't1' })
    newTurn(state, 'turn-1')
    const item = (method) => normalizeCodexNotification(method, { threadId: 't1', turnId: 'turn-1', item: { type: 'contextCompaction', id: 'c1' } }, state)
    expect(item('item/started')).toEqual([])
    expect(item('item/completed')).toEqual([{ type: 'compacted' }])
    expect(normalizeCodexNotification('thread/compacted', { threadId: 't1', turnId: 'turn-1' }, state)).toEqual([])
    expect(normalizeCodexNotification('thread/compacted', { threadId: 't1', turnId: 'turn-2' }, state)).toEqual([{ type: 'compacted' }])
    // Another thread's (not a linked child) is not ours.
    expect(normalizeCodexNotification('thread/compacted', { threadId: 'other', turnId: 'turn-3' }, state)).toEqual([])
  })

  it('recorded command items, the approval request and the interrupted end', () => {
    const state = createCodexState({ threadId: '01a0ec89-63d4-7980-80ae-d21e469ea231' })
    const run = (label) => normalizeCodexNotification(byLabel(label).method, byLabel(label).params, state)
    state.turn = { id: byLabel('command started').params.turnId, started: true, settled: false, uuids: [], lastText: '', usageBase: null }
    const [use] = run('command started')
    expect(use.blocks[0]).toMatchObject({ type: 'tool_use', name: 'Bash', input: { command: 'node --version' } })
    expect(run('command output delta')).toEqual([])
    expect(run('command completed exit 0')).toEqual([{ type: 'toolResult', toolUseId: use.blocks[0].id, isError: false, text: 'v22.19.0\r\n', parentToolUseId: null }])
    run('command started (needs approval)')
    const req = byLabel('requestApproval (server request id 0)')
    const perm = permissionFromCodexRequest('codex_perm_1', req.method, req.params, state)
    expect(perm).toMatchObject({ toolName: 'Bash', input: { command: `node -e "require('fs').writeFileSync('out.txt','hi')"` }, toolUseId: req.params.itemId })
    expect(perm.description).toMatch(/sandbox blocked/)
    expect(perm.choices).toEqual(req.params.availableDecisions)
    expect(codexDecision({ behavior: 'deny' }, perm.choices)).toBe(byLabel('our reply: decline (not offered, accepted)').result.decision)
    const declined = run('command completed declined')
    expect(declined).toMatchObject([{ type: 'toolResult', isError: true, text: 'The command was declined.' }])
    // the redacted tokenUsage value is tolerated
    expect(run('tokenUsage (value redacted by the spike)')).toEqual([])
    // The interrupted turn is another turn of the recording: while the
    // command's turn is open its end only marks it ended.
    const endFrame = byLabel('turn/completed interrupted')
    const cmdTurn = state.turn
    expect(normalizeCodexNotification(endFrame.method, endFrame.params, { ...state, settledTurns: new Set() })).toEqual([])
    expect(cmdTurn.settled).toBe(false)
    state.turn = { id: endFrame.params.turn.id, started: true, settled: false, uuids: [], lastText: '', usageBase: null }
    const end = run('turn/completed interrupted')
    expect(end.map((e) => e.type)).toEqual(['turnEnd', 'state'])
    expect(end[0]).toMatchObject({ status: 'interrupted', durationMs: 2889 })
    // a duplicate end of the same turn is ignored
    expect(run('turn/completed interrupted')).toEqual([])
  })

  it('auth errors: codexErrorInfo unauthorized, HTTP 401, wording', () => {
    expect(isCodexAuthError({ message: 'x', codexErrorInfo: 'unauthorized' })).toBe(true)
    expect(isCodexAuthError({ message: 'x', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } } })).toBe(true)
    expect(isCodexAuthError({ message: 'Not logged in. Run codex login', codexErrorInfo: null })).toBe(true)
    expect(isCodexAuthError({ message: 'flagged', codexErrorInfo: 'other' })).toBe(false)
    expect(isCodexAuthError({ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 500 } } })).toBe(false)
  })
})

describe('codexChat: security review fixes', () => {
  const frames = readFileSync(REAL, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const byLabel = (label) => frames.find((f) => f.label === label).m
  const answersOf = (readLog, method) => readLog().filter((r) => r.t === 'answer' && r.method === method)
  const quickKill = async (child) => child.kill('SIGKILL')

  // M1: the card shows what runs
  it('a command approval carries rawCommand, cwd and what widens it', () => {
    const req = byLabel('requestApproval (server request id 0)')
    const perm = permissionFromCodexRequest('p1', req.method, req.params, createCodexState({ threadId: req.params.threadId }))
    expect(perm.input.rawCommand).toBe(req.params.command)
    expect(perm.input.cwd).toBe(req.params.cwd)
    expect(perm.input.proposedExecpolicyAmendment).toEqual(req.params.proposedExecpolicyAmendment)
    const extra = permissionFromCodexRequest(
      'p2',
      'item/commandExecution/requestApproval',
      { command: 'curl x', cwd: 'C:\\w', additionalPermissions: { network: true }, networkApprovalContext: { host: 'h' } },
      createCodexState()
    )
    expect(extra.input).toMatchObject({ additionalPermissions: { network: true }, networkApprovalContext: { host: 'h' } })
  })

  // M2: the posture Codex applied
  it('manualPostureProblem: the recorded start answer and settings pass; anything else is named', () => {
    expect(manualPostureProblem(byLabel('thread/start response (on-request, read-only)').result, { strict: true })).toBe(null)
    expect(manualPostureProblem(byLabel('thread/settings/updated after turn/start').params.threadSettings)).toBe(null)
    expect(manualPostureProblem({ approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' }, approvalsReviewer: 'user' }, { strict: true })).toBe(null)
    expect(manualPostureProblem({ sandbox: { type: 'workspaceWrite' } }, { strict: true })).toMatch(/approvalPolicy missing/)
    expect(manualPostureProblem({ approvalPolicy: 'on-request' }, { strict: true })).toMatch(/sandbox missing/)
    expect(manualPostureProblem({ approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' } }, { strict: true })).toMatch(/approvalPolicy/)
    expect(manualPostureProblem({ approvalPolicy: { granular: {} }, sandbox: 'workspace-write' }, { strict: true })).toMatch(/approvalPolicy/)
    expect(manualPostureProblem({ approvalPolicy: 'on-request', sandbox: { type: 'dangerFullAccess' } }, { strict: true })).toMatch(/dangerFullAccess/)
    expect(manualPostureProblem({ approvalPolicy: 'on-request', sandbox: 'danger-full-access' }, { strict: true })).toMatch(/danger-full-access/)
    expect(manualPostureProblem({ approvalPolicy: 'on-request', sandbox: { type: 'externalSandbox' } }, { strict: true })).toMatch(/externalSandbox/)
    expect(manualPostureProblem({ approval_policy: 'never' })).toMatch(/approvalPolicy/)
    expect(manualPostureProblem({ sandbox_policy: { type: 'dangerFullAccess' } })).toMatch(/sandbox/)
    expect(manualPostureProblem({ sandboxPolicy: { type: 'dangerFullAccess' } })).toMatch(/sandbox/)
    expect(manualPostureProblem({ approvalsReviewer: 'auto_review' })).toMatch(/approvalsReviewer/)
    // settings updates: only the fields present are checked
    expect(manualPostureProblem({ model: 'x' })).toBe(null)
  })

  it('Manual refuses to open when the start answer has no approvalPolicy (unverified); Yolo opens', async () => {
    const { chat, events } = setup({ permissions: 'manual', env: { FAKE_CODEX_MODE: 'posture-missing' } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'posture' })
    expect(r.error).toMatch(/approvalPolicy missing/)
    await waitFor(() => ofType(events, 'exit').length === 1)
    expect(chat.running).toBe(false)
    const yolo = setup({ permissions: 'yolo', env: { FAKE_CODEX_MODE: 'posture-missing' } })
    expect((await yolo.chat.start()).ok).toBe(true)
  })

  it('Manual refuses to open when Codex reports full access', async () => {
    const { chat } = setup({ permissions: 'manual', env: { FAKE_CODEX_MODE: 'posture-danger' } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'posture' })
    expect(r.error).toMatch(/dangerFullAccess/)
  })

  it('Manual: thread/settings/updated with another posture -> postureError, interrupt, closed', async () => {
    const { chat, events } = setup({ permissions: 'manual', env: { FAKE_CODEX_MODE: 'posture-drift' }, killTree: quickKill })
    expect((await chat.start()).ok).toBe(true)
    await chat.send({ uuid: randomUUID(), text: 'SLOW' })
    const err = await waitFor(() => ofType(events, 'postureError')[0], 5000, 'postureError')
    expect(err.reason).toMatch(/approvalPolicy/)
    await waitFor(() => ofType(events, 'exit').length === 1, 5000, 'exit')
    expect(chat.running).toBe(false)
    expect(await chat.send({ uuid: randomUUID(), text: 'x' })).toMatchObject({ ok: false })
  })

  it('Yolo does not check the posture of settings updates', async () => {
    const { chat, events } = setup({ permissions: 'yolo', env: { FAKE_CODEX_MODE: 'posture-drift' } })
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'hi' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(ofType(events, 'postureError')).toHaveLength(0)
    expect(chat.running).toBe(true)
  })

  // M3: quitting kills at once
  it('close({ kill: true }) kills the tree at once, without the stdin-end wait', async () => {
    const killed = []
    const { chat, events } = setup({
      env: { FAKE_CODEX_MODE: 'hang' },
      timeouts: { close: 20000, quitKill: 3000 },
      killTree: async (child) => {
        killed.push(child.pid)
        child.kill('SIGKILL')
      }
    })
    const { pid } = await chat.start()
    const t0 = Date.now()
    expect(await chat.close({ kill: true })).toEqual({ ok: true, killed: true })
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(killed).toEqual([pid])
    expect(ofType(events, 'exit')).toHaveLength(1)
  }, 30000)

  // M4: MCP asks
  it('an MCP elicitation is an approval card: allow -> accept, content {}', async () => {
    const { chat, events, readLog } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'MCPASK' })
    const perm = await waitFor(() => ofType(events, 'permission')[0], 5000, 'permission')
    expect(perm).toMatchObject({ toolName: 'MCP', displayName: 'MCP files', choices: ['accept', 'decline'], description: 'Allow the files server to run delete_all?' })
    expect(perm.input).toMatchObject({ server: 'files', message: 'Allow the files server to run delete_all?', meta: { codex_approval_kind: 'mcp_tool_call' } })
    expect(await chat.answerPermission(perm.requestId, { behavior: 'allow', session: true })).toEqual({ ok: true, decision: 'accept' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(answersOf(readLog, 'mcpServer/elicitation/request')[0].response.result).toEqual({ action: 'accept', content: {}, _meta: null })
  })

  it('an MCP elicitation denied -> decline', async () => {
    const { chat, events, readLog } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'MCPASK' })
    const perm = await waitFor(() => ofType(events, 'permission')[0], 5000, 'permission')
    expect(await chat.answerPermission(perm.requestId, { behavior: 'deny' })).toEqual({ ok: true, decision: 'decline' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(answersOf(readLog, 'mcpServer/elicitation/request')[0].response.result).toEqual({ action: 'decline', content: null, _meta: null })
  })

  it('elicitations Tessel cannot answer (a form, a URL) are declined', () => {
    expect(elicitationAnswerable({ message: 'ok?', requestedSchema: { type: 'object', properties: {} } })).toBe(true)
    expect(elicitationAnswerable({ message: 'ok?' })).toBe(true)
    expect(elicitationAnswerable({ mode: 'url', url: 'https://x' })).toBe(false)
    expect(elicitationAnswerable({ requestedSchema: { properties: { a: {} }, required: ['a'] } })).toBe(false)
    expect(permissionFromElicitation('p', { serverName: 's', message: 'm' }).input).toEqual({ server: 's', message: 'm' })
  })

  // L1
  it('a file approval with no known changes says so, the new write root first', () => {
    const perm = permissionFromCodexRequest('p', 'item/fileChange/requestApproval', { threadId: 't', itemId: 'unknown', grantRoot: 'C:\\outside', reason: 'r' }, createCodexState({ threadId: 't' }))
    expect(Object.keys(perm.input).slice(0, 2)).toEqual(['grantRoot', 'changesUnknown'])
    expect(perm.input).toMatchObject({ grantRoot: 'C:\\outside', changesUnknown: true, changes: [] })
  })

  it("another thread's approval is declined, never shown", async () => {
    const { chat, events, readLog } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'FOREIGN' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(answersOf(readLog, 'foreign-approval')[0].response.result).toEqual({ decision: 'decline' })
    expect(ofType(events, 'permission')).toHaveLength(0)
  })

  // L2
  it("settleTurn: another turn's id only marks it ended; the open turn stays open", () => {
    const state = createCodexState({ threadId: 't' })
    const open = newTurn(state, 'turn-a')
    expect(settleTurn(state, 'completed', { turnId: 'turn-b' })).toEqual([])
    expect(state.turn).toBe(open)
    expect(open.settled).toBe(false)
    expect(state.settledTurns.has('turn-b')).toBe(true)
    expect(settleTurn(state, 'completed', { turnId: 'turn-b' })).toEqual([])
    expect(settleTurn(state, 'completed', { turnId: 'turn-a' }).map((e) => e.type)).toEqual(['turnEnd', 'state'])
    expect(open.settled).toBe(true)
  })

  it("a turn's end cancels its own approvals (answered decline), not another turn's", async () => {
    const { chat, events, readLog } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'ENDWHILEASK' })
    await waitFor(() => ofType(events, 'permission').length === 2)
    const [mine, other] = ofType(events, 'permission')
    await waitFor(() => turnEnds(events).length === 1)
    await waitFor(() => answersOf(readLog, 'endwhileask-mine').length === 1, 5000, 'decline of mine')
    expect(answersOf(readLog, 'endwhileask-mine')[0].response.result).toEqual({ decision: 'decline' })
    expect(ofType(events, 'permissionCancelled').map((e) => e.requestId)).toEqual([mine.requestId])
    expect(chat.pendingPermissions()).toEqual([other.requestId])
    expect(await chat.answerPermission(other.requestId, { behavior: 'deny' })).toMatchObject({ ok: true })
    await waitFor(() => answersOf(readLog, 'endwhileask-other').length === 1)
  })

  // L3
  it('switching to Manual during a Yolo turn interrupts it', async () => {
    const { chat, events, requests } = setup({ permissions: 'yolo' })
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'SLOW' })
    await waitFor(() => ofType(events, 'textDelta').length > 0)
    expect(await chat.setPermissionMode('default')).toEqual({ ok: true, response: { mode: 'default' }, interrupted: true })
    await waitFor(() => turnEnds(events).length === 1)
    expect(turnEnds(events)[0].status).toBe('interrupted')
    expect(requests('turn/interrupt')).toHaveLength(1)
  })

  it('a message is not steered into a turn started under another posture', async () => {
    const { chat, events, requests } = setup({ permissions: 'manual' })
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'SLOW' })
    await waitFor(() => ofType(events, 'textDelta').length > 0)
    expect(await chat.setPermissionMode('bypassPermissions')).toEqual({ ok: true, response: { mode: 'bypassPermissions' } })
    expect((await chat.send({ uuid: randomUUID(), text: 'more' })).ok).toBe(true)
    expect(requests('turn/steer')).toHaveLength(0)
    const starts = requests('turn/start').map((m) => m.params)
    expect(starts).toHaveLength(2)
    expect(starts[1]).toMatchObject({ approvalPolicy: 'never' })
  })

  // L4
  it('line limits: 8 MB; an over-long line is dropped up to its line end', async () => {
    expect(MAX_LINE).toBe(8 * 1024 * 1024)
    const { chat, events } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'LONGLINE' })
    await waitFor(() => turnEnds(events).length === 1, 10000)
    expect(ofType(events, 'textDelta').some((e) => e.text === 'SMUGGLED')).toBe(false)
    expect(turnEnds(events)[0].status).toBe('completed')
  }, 30000)

  it('a frame split across chunks is read once', async () => {
    const { chat, events } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'SPLIT' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(ofType(events, 'textDelta').filter((e) => e.text === 'HALVES')).toHaveLength(1)
  })

  it(`at most ${MAX_APPROVALS} approvals wait at once; more are declined`, async () => {
    const { chat, events, readLog } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'MANYASK' })
    await waitFor(() => answersOf(readLog, 'many-last').length === 1, 5000, 'decline of the 51st')
    expect(answersOf(readLog, 'many-last')[0].response.result).toEqual({ decision: 'decline' })
    expect(ofType(events, 'permission')).toHaveLength(MAX_APPROVALS)
  })
})
