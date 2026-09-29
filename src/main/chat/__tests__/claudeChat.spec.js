// @vitest-environment node
// The adapter against a fake claude (fixtures/fake-claude.cjs, a node script
// speaking the recorded stream-json protocol). The real CLI is never run.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClaudeChat, buildClaudeArgs, killClaudeTree, DEFAULT_TIMEOUTS } from '../claudeChat'

const FAKE = join(__dirname, 'fixtures', 'fake-claude.cjs')
const open = []

function setup({ env: envExtra = {}, ...opts } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tessel-fake-claude-'))
  const logFile = join(dir, 'log.jsonl')
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FAKE_CLAUDE_LOG: logFile, ...envExtra }
  const chat = createClaudeChat({ exe: process.execPath, exeArgs: [FAKE], cwd: dir, env, sessionId: randomUUID(), ...opts })
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
  return { chat, events, readLog, sent, dir }
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

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => {})))
})

describe('claudeChat: start', () => {
  it('publishes commands again on resume and sends slash text unchanged', async () => {
    const { chat, events, sent } = setup({ sessionId: undefined, resume: randomUUID() })
    expect((await chat.start()).ok).toBe(true)
    expect(ofType(events, 'commands')).toEqual([{ type: 'commands', commands: [{ name: 'compact', kind: 'command', kindUnspecified: true, description: 'Compact the conversation' }] }])
    await chat.send({ text: '/compact preserve API details' })
    await waitFor(() => sent().some(frame => frame.type === 'user'))
    expect(sent().find(frame => frame.type === 'user').message.content).toEqual([{ type: 'text', text: '/compact preserve API details' }])
  })

  it('is ready on the initialize answer, without waiting for system/init', async () => {
    const { chat, events, sent } = setup()
    const r = await chat.start()
    expect(r.ok).toBe(true)
    expect(r.pid).toBeTypeOf('number')
    expect(r.info.auth).toEqual({ tokenSource: 'claude.ai', apiProvider: 'firstParty' })
    expect(r.info.models.map((m) => m.value)).toContain('haiku')
    expect(r.info.cliPid).toBe(r.pid)
    expect(ofType(events, 'init')).toEqual([]) // system/init only comes with a turn
    expect(sent()[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } })
    expect(chat.start()).toBe(chat.start()) // one start
  })

  it('send before start is refused', async () => {
    const { chat } = setup()
    expect(await chat.send({ uuid: randomUUID(), text: 'hi' })).toEqual({ ok: false, error: 'not running' })
  })

  it('not signed in (tokenSource none) -> code signin, authError, process closed', async () => {
    const { chat, events } = setup({ env: { FAKE_CLAUDE_MODE: 'signin' } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'signin' })
    expect(ofType(events, 'authError').length).toBe(1)
    await waitFor(() => ofType(events, 'exit').length, 5000, 'exit')
    expect(ofType(events, 'exit')[0].crashed).toBe(false)
  })

  it('"Not logged in" on stderr before any answer -> code signin', async () => {
    const { chat, events } = setup({ env: { FAKE_CLAUDE_MODE: 'signin-exit' } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'signin' })
    expect(r.error).toMatch(/Not logged in/)
    expect(ofType(events, 'authError').length).toBe(1)
  })

  it('exit before initialize -> code exit with the stderr text', async () => {
    const { chat, events } = setup({ env: { FAKE_CLAUDE_MODE: 'crash-start' } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'exit' })
    expect(r.error).toMatch(/could not start/)
    expect(ofType(events, 'exit')[0]).toMatchObject({ code: 2, crashed: true })
  })

  it('no initialize answer -> code timeout and the process is closed', async () => {
    const { chat, events } = setup({ env: { FAKE_CLAUDE_MODE: 'noinit' }, timeouts: { start: 200 } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'timeout' })
    await waitFor(() => ofType(events, 'exit').length, 5000, 'exit')
  })

  it('a missing executable -> code spawn', async () => {
    const chat = createClaudeChat({ exe: join(tmpdir(), 'no-such-claude-' + randomUUID() + '.exe'), cwd: tmpdir(), env: { PATH: process.env.PATH }, sessionId: randomUUID() })
    open.push(chat)
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'spawn' })
    expect(r.error).toMatch(/ENOENT/)
  })

  it('initial effort is applied after initialize, before the first turn', async () => {
    const { chat, sent } = setup({ effort: 'high' })
    expect((await chat.start()).ok).toBe(true)
    const reqs = sent().map((m) => m.request && m.request.subtype)
    expect(reqs).toEqual(['initialize', 'apply_flag_settings'])
    expect(sent()[1].request.settings).toEqual({ effortLevel: 'high' })
  })

  it('rejects bad options before spawning anything', () => {
    const base = { exe: process.execPath, env: {}, cwd: tmpdir() }
    expect(() => createClaudeChat({ ...base })).toThrow(/sessionId/)
    expect(() => createClaudeChat({ ...base, sessionId: randomUUID(), resume: randomUUID() })).toThrow(/sessionId/)
    expect(() => createClaudeChat({ ...base, resume: '--dangerously-skip-permissions' })).toThrow(/uuid/)
    expect(() => createClaudeChat({ ...base, sessionId: randomUUID(), model: '--foo' })).toThrow(/model/)
    expect(() => createClaudeChat({ ...base, sessionId: randomUUID(), permissionMode: 'yolo' })).toThrow(/permissionMode/)
    expect(() => createClaudeChat({ ...base, sessionId: randomUUID(), mcpConfig: '--x' })).toThrow(/mcpConfig/)
    expect(() => createClaudeChat({ ...base, exe: '', sessionId: randomUUID() })).toThrow(/exe/)
  })
})

describe('claudeChat: command line', () => {
  it('buildClaudeArgs: default, bypass, resume, model, mcp config', () => {
    const sid = randomUUID()
    expect(buildClaudeArgs({ sessionId: sid })).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default', '--session-id', sid
    ])
    const bypass = buildClaudeArgs({ resume: sid, permissionMode: 'bypassPermissions', model: 'sonnet', mcpConfig: 'C:\\x\\mcp.json', exeArgs: ['fake.cjs'] })
    expect(bypass[0]).toBe('fake.cjs')
    expect(bypass).toContain('--dangerously-skip-permissions')
    expect(bypass.slice(bypass.indexOf('--permission-mode'), bypass.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'bypassPermissions'])
    expect(bypass.slice(-6)).toEqual(['--model', 'sonnet', '--resume', sid, '--mcp-config', 'C:\\x\\mcp.json'])
    expect(bypass).not.toContain('--session-id')
    expect(buildClaudeArgs({ sessionId: sid, permissionMode: 'acceptEdits' })).not.toContain('--dangerously-skip-permissions')
  })

  it('spawns without a shell, hidden, with the session-state env and the exact args', async () => {
    const calls = []
    const spy = (exe, args, options) => {
      calls.push({ exe, args, options })
      return nodeSpawn(exe, args, options)
    }
    const sid = randomUUID()
    const { chat, readLog } = setup({ spawn: spy, sessionId: sid, permissionMode: 'bypassPermissions', model: 'haiku', env: { FAKE_MARKER: 'm1' } })
    expect((await chat.start()).ok).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0].exe).toBe(process.execPath)
    expect(calls[0].options).toMatchObject({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    expect(calls[0].options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1')
    const log = readLog()
    const argv = log.find((r) => r.t === 'argv').argv
    expect(argv).toEqual(calls[0].args.slice(1))
    expect(argv).toContain('--dangerously-skip-permissions')
    expect(argv.slice(-4)).toEqual(['--model', 'haiku', '--session-id', sid])
    expect(log.find((r) => r.t === 'env')).toMatchObject({ emit: '1', marker: 'm1' })
  })

  it('resume passes --resume and keeps the id for user frames', async () => {
    const sid = randomUUID()
    const { chat, sent } = setup({ sessionId: undefined, resume: sid })
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'hello' })
    expect(sent().find((m) => m.type === 'user').session_id).toBe(sid)
    expect(chat.sessionId).toBe(sid)
  })
})

describe('claudeChat: turns', () => {
  it('send -> queued, accepted once, deltas, assistant, turnEnd completed', async () => {
    const { chat, events, sent } = setup()
    await chat.start()
    const uuid = randomUUID()
    expect(await chat.send({ uuid, text: 'hello there' })).toEqual({ ok: true, uuid })
    await waitFor(() => turnEnds(events).length === 1, 5000, 'turnEnd')
    expect(sent().find((m) => m.type === 'user')).toEqual({
      type: 'user',
      uuid,
      session_id: chat.sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] }
    })
    expect(ofType(events, 'queued')).toEqual([{ type: 'queued', uuid }])
    expect(ofType(events, 'accepted')).toEqual([{ type: 'accepted', uuid }]) // started + echo -> once
    const init = ofType(events, 'init')[0]
    expect(init).toMatchObject({ sessionId: chat.sessionId, permissionMode: 'default', version: '2.1.284-fake' })
    const deltas = ofType(events, 'textDelta')
    expect(deltas.map((d) => d.text).join('')).toBe('Reply to: hello there')
    const asst = ofType(events, 'assistant')[0]
    expect(asst.blocks).toEqual([{ type: 'text', text: 'Reply to: hello there' }])
    expect(deltas[0].messageId).toBe(asst.messageId)
    const end = turnEnds(events)[0]
    expect(end).toMatchObject({ status: 'completed', result: 'Reply to: hello there', isError: false, costUsd: 0.0012, userMessageUuids: [uuid] })
    expect(end.usage.output_tokens).toBe(5)
    expect(ofType(events, 'rateLimit')[0]).toMatchObject({ status: 'allowed', fiveHour: { utilization: 0.25 } })
    await waitFor(() => ofType(events, 'state').some((s) => s.state === 'idle'), 2000, 'idle')
    expect(ofType(events, 'state')[0].state).toBe('running')
    // accepted comes before the first delta, the turn end after the assistant text
    const idx = (t) => events.findIndex((e) => e.type === t)
    expect(idx('queued')).toBeLessThan(idx('accepted'))
    expect(idx('accepted')).toBeLessThan(idx('textDelta'))
    expect(idx('assistant')).toBeLessThan(idx('turnEnd'))
  })

  it('two turns on one process', async () => {
    const { chat, events } = setup()
    const { pid } = await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'one' })
    await waitFor(() => turnEnds(events).length === 1)
    await chat.send({ uuid: randomUUID(), text: 'two' })
    await waitFor(() => turnEnds(events).length === 2)
    expect(turnEnds(events).map((e) => e.result)).toEqual(['Reply to: one', 'Reply to: two'])
    expect(ofType(events, 'init').length).toBe(2)
    expect(chat.pid).toBe(pid)
    expect(chat.running).toBe(true)
  })

  it('a message sent mid-turn is queued and runs as the next turn', async () => {
    const { chat, events } = setup()
    await chat.start()
    const a = randomUUID()
    const b = randomUUID()
    await chat.send({ uuid: a, text: 'SLOW count' })
    await waitFor(() => ofType(events, 'textDelta').length > 3, 5000, 'first deltas')
    await chat.send({ uuid: b, text: 'and then this' })
    await waitFor(() => ofType(events, 'queued').some((q) => q.uuid === b), 2000, 'queued b')
    expect(turnEnds(events).length).toBe(0)
    expect(ofType(events, 'accepted').map((e) => e.uuid)).toEqual([a])
    await waitFor(() => turnEnds(events).length === 2, 10000, 'two turn ends')
    const [first, second] = turnEnds(events)
    expect(first.userMessageUuids).toEqual([a])
    expect(second).toMatchObject({ status: 'completed', result: 'Reply to: and then this', userMessageUuids: [b] })
    const acceptedB = events.findIndex((e) => e.type === 'accepted' && e.uuid === b)
    expect(acceptedB).toBeGreaterThan(events.indexOf(first))
  })

  it('interrupt -> turnEnd interrupted; process stays usable; exit 1 on close is not a crash', async () => {
    const { chat, events, sent } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'SLOW long answer' })
    await waitFor(() => ofType(events, 'textDelta').length > 2, 5000, 'deltas')
    expect(await chat.interrupt()).toEqual({ ok: true, stillQueued: [] })
    await waitFor(() => turnEnds(events).length === 1, 5000, 'turnEnd')
    expect(turnEnds(events)[0]).toMatchObject({ status: 'interrupted', isError: true, terminalReason: 'aborted_streaming' })
    expect(sent().some((m) => m.type === 'control_request' && m.request.subtype === 'interrupt')).toBe(true)
    await chat.send({ uuid: randomUUID(), text: 'again' })
    await waitFor(() => turnEnds(events).length === 2)
    expect(turnEnds(events)[1].status).toBe('completed')
    // interrupt the last turn, then close: the CLI exits 1 then
    await chat.send({ uuid: randomUUID(), text: 'SLOW again' })
    await waitFor(() => ofType(events, 'textDelta').length > 40, 5000)
    await chat.interrupt()
    await waitFor(() => turnEnds(events).length === 3)
    await chat.close()
    expect(ofType(events, 'exit')[0]).toMatchObject({ code: 1, crashed: false })
  })

  it('tool output is clipped to 8 KB', async () => {
    const { chat, events } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'BIGTOOL please' })
    await waitFor(() => turnEnds(events).length === 1)
    const tr = ofType(events, 'toolResult')[0]
    expect(tr).toMatchObject({ toolUseId: 'toolu_big', isError: false })
    expect(tr.text).toBe('x'.repeat(8192) + ' … (11808 more bytes)')
    expect(ofType(events, 'assistant')[0].blocks[0]).toMatchObject({ type: 'tool_use', name: 'Read', input: { file_path: 'big.txt' } })
  })

  it('malformed lines are ignored and CRLF line ends are tolerated', async () => {
    const { chat, events } = setup({ env: { FAKE_CLAUDE_CRLF: '1', FAKE_CLAUDE_GARBAGE: '1' } })
    expect((await chat.start()).ok).toBe(true)
    await chat.send({ uuid: randomUUID(), text: 'crlf' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(turnEnds(events)[0]).toMatchObject({ status: 'completed', result: 'Reply to: crlf' })
    expect(ofType(events, 'textDelta').map((d) => d.text).join('')).toBe('Reply to: crlf')
  })

  it('an authentication failure during a turn -> authError and a failed turn', async () => {
    const { chat, events } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'AUTHFAIL' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(ofType(events, 'authError').length).toBeGreaterThanOrEqual(1)
    expect(turnEnds(events)[0]).toMatchObject({ status: 'failed', isError: true })
  })
})

describe('claudeChat: permissions', () => {
  async function askPermission(opts) {
    const s = setup(opts)
    await s.chat.start()
    await s.chat.send({ uuid: randomUUID(), text: 'PERMISSION run node' })
    const perm = await waitFor(() => ofType(s.events, 'permission')[0], 5000, 'permission')
    return { ...s, perm }
  }
  const answers = (sent) => sent().filter((m) => m.type === 'control_response')

  it('allow for the session: updatedInput echoed, suggestions rewritten to destination session', async () => {
    const { chat, events, sent, perm } = await askPermission()
    expect(perm).toMatchObject({ toolName: 'Bash', displayName: 'Bash', input: { command: 'node -e "console.log(6*7)"' }, reason: 'This command requires approval' })
    expect(perm.toolUseId).toMatch(/^toolu_/)
    expect(ofType(events, 'state').map((s) => s.state)).toContain('requires_action')
    expect(chat.pendingPermissions()).toEqual([perm.requestId])
    expect(await chat.answerPermission(perm.requestId, { behavior: 'allow', session: true })).toEqual({ ok: true })
    await waitFor(() => turnEnds(events).length === 1)
    const [answer] = answers(sent)
    expect(answer).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: perm.requestId,
        response: {
          behavior: 'allow',
          updatedInput: perm.input,
          updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'node -e "console.log(6*7)"' }], behavior: 'allow', destination: 'session' }]
        }
      }
    })
    expect(JSON.stringify(answer)).not.toContain('localSettings')
    expect(ofType(events, 'toolResult')[0]).toMatchObject({ isError: false, text: 'ran: node -e "console.log(6*7)"' })
    expect(turnEnds(events)[0]).toMatchObject({ status: 'completed', result: 'The command output is 42.' })
    // answered once; the CLI's echo of our answer is ignored
    expect(await chat.answerPermission(perm.requestId, { behavior: 'allow' })).toMatchObject({ ok: false })
    expect(chat.pendingPermissions()).toEqual([])
  })

  it('allow once sends no updatedPermissions', async () => {
    const { chat, events, sent, perm } = await askPermission()
    await chat.answerPermission(perm.requestId, { behavior: 'allow', session: false })
    await waitFor(() => turnEnds(events).length === 1)
    expect(answers(sent)[0].response.response).toEqual({ behavior: 'allow', updatedInput: perm.input })
  })

  it('deny -> deny body with the message, denied tool listed at the turn end', async () => {
    const { chat, events, sent, perm } = await askPermission()
    await chat.answerPermission(perm.requestId, { behavior: 'deny', message: 'Not now.' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(answers(sent)[0].response.response).toEqual({ behavior: 'deny', message: 'Not now.' })
    expect(ofType(events, 'toolResult')[0]).toMatchObject({ isError: true, text: 'Not now.' })
    expect(turnEnds(events)[0].permissionDenials.length).toBe(1)
  })

  it('deny without a message sends a default one; a bad decision is refused', async () => {
    const { chat, events, sent, perm } = await askPermission()
    expect(await chat.answerPermission(perm.requestId, { behavior: 'maybe' })).toMatchObject({ ok: false })
    await chat.answerPermission(perm.requestId, { behavior: 'deny' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(answers(sent)[0].response.response.message).toMatch(/denied/)
  })

  it('control_cancel_request -> permissionCancelled; a late answer is refused', async () => {
    const { chat, events } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'CANCELPERM' })
    const perm = await waitFor(() => ofType(events, 'permission')[0])
    await waitFor(() => ofType(events, 'permissionCancelled').length === 1)
    expect(ofType(events, 'permissionCancelled')[0]).toEqual({ type: 'permissionCancelled', requestId: perm.requestId })
    expect(await chat.answerPermission(perm.requestId, { behavior: 'allow' })).toMatchObject({ ok: false })
    await waitFor(() => turnEnds(events).length === 1)
  })

  it('interrupt while a permission is pending cancels it', async () => {
    const { chat, events, perm } = await askPermission()
    await chat.interrupt()
    await waitFor(() => turnEnds(events).length === 1)
    expect(ofType(events, 'permissionCancelled').map((e) => e.requestId)).toEqual([perm.requestId])
    expect(turnEnds(events)[0].status).toBe('interrupted')
  })
})

describe('claudeChat: controls', () => {
  it('setModel / setEffort / setPermissionMode write the recorded frames', async () => {
    const { chat, sent } = setup()
    await chat.start()
    expect(await chat.setModel('sonnet')).toMatchObject({ ok: true })
    expect(await chat.setEffort('low')).toMatchObject({ ok: true })
    expect(await chat.setPermissionMode('acceptEdits')).toEqual({ ok: true, response: { mode: 'acceptEdits' } })
    const reqs = sent().filter((m) => m.type === 'control_request').map((m) => m.request)
    expect(reqs.slice(1)).toEqual([
      { subtype: 'set_model', model: 'sonnet' },
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } },
      { subtype: 'set_permission_mode', mode: 'acceptEdits' }
    ])
    // request ids are unique
    const ids = sent().filter((m) => m.type === 'control_request').map((m) => m.request_id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('bad values are refused without writing', async () => {
    const { chat, sent } = setup()
    await chat.start()
    expect((await chat.setModel('--x')).ok).toBe(false)
    expect((await chat.setEffort('')).ok).toBe(false)
    expect((await chat.setPermissionMode('yolo')).ok).toBe(false)
    expect(sent().filter((m) => m.type === 'control_request').length).toBe(1)
  })

  it('the model set with set_model shows in the next init', async () => {
    const { chat, events } = setup()
    await chat.start()
    await chat.setModel('claude-sonnet-5-5')
    await chat.send({ uuid: randomUUID(), text: 'x' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(ofType(events, 'init')[0].model).toBe('claude-sonnet-5-5')
  })

  it('an unanswered control request times out (configurable; 30 s by default)', async () => {
    expect(DEFAULT_TIMEOUTS.control).toBe(30000)
    expect(DEFAULT_TIMEOUTS.start).toBe(30000)
    const { chat } = setup({ env: { FAKE_CLAUDE_IGNORE: 'set_model' }, timeouts: { control: 150 } })
    await chat.start()
    const t0 = Date.now()
    expect(await chat.setModel('sonnet')).toMatchObject({ ok: false, code: 'timeout' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140)
    expect(await chat.setEffort('low')).toMatchObject({ ok: true }) // still usable
  })

  it('requests from the CLI: request_user_dialog -> cancelled, unknown -> error', async () => {
    const { chat, events, readLog } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'DIALOG' })
    await waitFor(() => turnEnds(events).length === 1)
    await chat.send({ uuid: randomUUID(), text: 'UNKNOWNREQ' })
    await waitFor(() => turnEnds(events).length === 2)
    const got = readLog().filter((r) => r.t === 'answer')
    expect(got[0]).toMatchObject({ subtype: 'request_user_dialog', response: { subtype: 'success', response: { behavior: 'cancelled' } } })
    expect(got[1]).toMatchObject({ subtype: 'hook_callback', response: { subtype: 'error' } })
    expect(got[1].response.error).toMatch(/hook_callback/)
  })
})

describe('claudeChat: exit and close', () => {
  it('a crash -> exit event with the stderr tail; pending controls fail', async () => {
    const { chat, events } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'CRASH now' })
    const exit = await waitFor(() => ofType(events, 'exit')[0], 5000, 'exit')
    expect(exit).toMatchObject({ code: 2, crashed: true })
    expect(exit.stderrTail).toMatch(/simulated crash/)
    expect(ofType(events, 'stderr').map((e) => e.text).join('')).toMatch(/simulated crash/)
    expect(chat.running).toBe(false)
    expect(await chat.setModel('sonnet')).toMatchObject({ ok: false, code: 'exit' })
    expect(await chat.send({ uuid: randomUUID(), text: 'x' })).toMatchObject({ ok: false })
  })

  it('close() ends stdin and the CLI exits by itself', async () => {
    const { chat, events, readLog } = setup()
    await chat.start()
    await chat.send({ uuid: randomUUID(), text: 'hi' })
    await waitFor(() => turnEnds(events).length === 1)
    expect(await chat.close()).toEqual({ ok: true, killed: false })
    expect(readLog().some((r) => r.t === 'stdin-end')).toBe(true)
    expect(ofType(events, 'exit')[0]).toMatchObject({ code: 0, crashed: false })
    expect(await chat.close()).toEqual({ ok: true })
  })

  it('close() kills the tree when the CLI does not exit after stdin end', async () => {
    const { chat, events } = setup({ env: { FAKE_CLAUDE_MODE: 'hang' }, timeouts: { close: 200 } })
    await chat.start()
    const r = await chat.close()
    expect(r).toEqual({ ok: true, killed: true })
    expect(ofType(events, 'exit')[0].crashed).toBe(false)
  }, 30000)

  it('close({ kill: true }) (Tessel quits): the tree is killed at once, no 3 s grace', async () => {
    const killTree = vi.fn((c) => killClaudeTree(c))
    const { chat, events, readLog } = setup({ env: { FAKE_CLAUDE_MODE: 'hang' }, timeouts: { close: 20000 }, killTree })
    await chat.start()
    const t0 = Date.now()
    const r = await chat.close({ kill: true })
    expect(r).toEqual({ ok: true, killed: true })
    expect(killTree).toHaveBeenCalledTimes(1)
    expect(Date.now() - t0).toBeLessThan(DEFAULT_TIMEOUTS.close)
    expect(readLog().some((x) => x.t === 'stdin-end')).toBe(false)
    await waitFor(() => ofType(events, 'exit')[0], 5000, 'exit')
    expect(chat.running).toBe(false)
  }, 30000)

  it('close({ kill: true }) never hangs on a process that does not exit', async () => {
    // A kill that does nothing: close still returns after quitKill.
    const killTree = vi.fn(async () => {})
    const { chat } = setup({ env: { FAKE_CLAUDE_MODE: 'hang' }, timeouts: { quitKill: 100, close: 200 }, killTree })
    await chat.start()
    expect(await chat.close({ kill: true })).toEqual({ ok: true, killed: true })
    expect(chat.running).toBe(true)
    // The clean-up (afterEach) kills it for real.
    killTree.mockImplementation((c) => killClaudeTree(c))
  }, 30000)

  it('killClaudeTree: root through its handle, descendants from the checked listing', async () => {
    const killed = []
    const child = { pid: 100, exitCode: null, signalCode: null, kill: vi.fn(() => { child.exitCode = 1 }) }
    const tree = {
      listProcesses: async () => [
        { pid: 100, ppid: 1, created: 10 },
        { pid: 101, ppid: 100, created: 11 },
        { pid: 102, ppid: 100, created: 5 } // older than its "parent": a reused PID, not ours
      ],
      treeOf: (await import('../../processTree')).treeOf,
      killPids: (entries) => killed.push(...entries.map((e) => e.pid))
    }
    await killClaudeTree(child, tree)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(killed).toEqual([101])
    // Already exited: nothing is touched.
    const gone = { pid: 5, exitCode: 0, signalCode: null, kill: vi.fn() }
    await killClaudeTree(gone, { ...tree, listProcesses: vi.fn() })
    expect(gone.kill).not.toHaveBeenCalled()
    // Listing fails: the root alone.
    const lone = { pid: 7, exitCode: null, signalCode: null, kill: vi.fn() }
    const kp = vi.fn()
    await killClaudeTree(lone, { listProcesses: async () => null, treeOf: tree.treeOf, killPids: kp })
    expect(lone.kill).toHaveBeenCalled()
    expect(kp).not.toHaveBeenCalled()
  })

  it('the log option gets lines, never throws into the adapter', async () => {
    const lines = []
    const { chat } = setup({ log: (level, msg) => { lines.push([level, msg]); throw new Error('bad logger') } })
    expect((await chat.start()).ok).toBe(true)
    expect(lines.some(([, m]) => /spawned pid=/.test(m))).toBe(true)
  })
})
