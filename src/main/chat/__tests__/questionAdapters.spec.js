// @vitest-environment node
// In-memory stdio fixtures: no real agent, credentials, network or shell.
import { afterEach, describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'stream'
import { randomUUID } from 'crypto'
import { createClaudeChat } from '../claudeChat.js'
import { createCodexChat } from '../codexChat.js'

const open = []
afterEach(async () => {
  for (const chat of open.splice(0)) await chat.close()
})
const flush = () => new Promise((resolve) => setImmediate(resolve))
const fixture = [
  {
    question: 'Which format?',
    header: 'Format',
    multiSelect: false,
    options: [
      { label: 'Short', description: 'Summary' },
      { label: 'Long', description: 'Full answer' }
    ]
  }
]

async function setup(provider) {
  const child = new EventEmitter(),
    sent = [],
    events = []
  child.pid = 101
  child.exitCode = null
  child.signalCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const frame = (value) => child.stdout.write(JSON.stringify(value) + '\n')
  const finish = () => {
    child.exitCode = 0
    child.emit('close', 0, null)
  }
  child.stdin = new Writable({
    write(chunk, _encoding, cb) {
      const value = JSON.parse(chunk.toString())
      sent.push(value)
      cb()
      queueMicrotask(() => {
        if (value.type === 'control_request')
          frame({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: value.request_id,
              response: { account: { tokenSource: 'claude.ai' } }
            }
          })
        if (value.method && value.id != null) {
          const result =
            value.method === 'thread/start'
              ? {
                  thread: { id: 'thread-fixture' },
                  model: 'fixture',
                  approvalPolicy: 'on-request',
                  sandbox: { type: 'workspaceWrite' }
                }
              : {}
          frame({ id: value.id, result })
        }
      })
    },
    final(cb) {
      cb()
      finish()
    }
  })
  const opts = {
    exe: 'fixture',
    env: {},
    spawn: () => child,
    timeouts: { exitFlush: 1, idleSettle: 10 }
  }
  const chat =
    provider === 'claude'
      ? createClaudeChat({ ...opts, sessionId: randomUUID() })
      : createCodexChat({ ...opts, probeAccount: false })
  const original = chat.emit.bind(chat)
  chat.emit = (type, payload) => {
    events.push({ type, ...payload })
    return original(type, payload)
  }
  open.push(chat)
  expect((await chat.start()).ok).toBe(true)
  const ask = (extra = {}, rawId = 'request-1') => {
    frame(
      provider === 'claude'
        ? {
            type: 'control_request',
            request_id: rawId,
            request: {
              subtype: 'can_use_tool',
              tool_name: 'AskUserQuestion',
              input: { questions: fixture, ...extra }
            }
          }
        : {
            method: 'item/tool/requestUserInput',
            id: rawId,
            params: {
              threadId: 'thread-fixture',
              turnId: 'turn-1',
              itemId: 'item-1',
              questions: fixture.map((q) => ({
                ...q,
                id: 'format',
                isOther: false,
                isSecret: false
              })),
              isBlocking: true,
              ...extra
            }
          }
    )
    return events.filter((e) => e.type === 'question').at(-1)
  }
  const replies = () =>
    sent.filter((e) =>
      provider === 'claude' ? e.type === 'control_response' : e.id != null && !e.method
    )
  const end = () =>
    frame(
      provider === 'claude'
        ? {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'done',
            session_id: chat.sessionId
          }
        : {
            method: 'turn/completed',
            params: { threadId: 'thread-fixture', turn: { id: 'turn-1', status: 'completed' } }
          }
    )
  const startTurn = () => {
    if (provider === 'codex')
      frame({
        method: 'turn/started',
        params: { threadId: 'thread-fixture', turn: { id: 'turn-1' } }
      })
  }
  return { chat, frame, ask, events, replies, end, startTurn, finish }
}

describe.each(['claude', 'codex'])('%s questions over stdio', (provider) => {
  it('waits, sends the documented reply, and does not route the question to approvals', async () => {
    const s = await setup(provider)
    const question = s.ask()
    expect(question).toMatchObject({ status: 'pending', questions: [{ multiSelect: false }] })
    expect(s.replies()).toEqual([])
    expect(s.events.filter((e) => e.type === 'permission')).toEqual([])
    const answers = [{ questionId: question.questions[0].id, optionIds: ['o1'] }]
    expect(await s.chat.answerPermission(question.requestId, { behavior: 'allow' })).toMatchObject({
      ok: false
    })
    expect(await s.chat.answerQuestion(question.requestId, { answers })).toEqual({ ok: true })
    if (provider === 'claude')
      expect(s.replies()).toEqual([
        {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'request-1',
            response: {
              behavior: 'allow',
              updatedInput: { questions: fixture, answers: { 'Which format?': 'Long' } }
            }
          }
        }
      ])
    else
      expect(s.replies()).toEqual([
        { id: 'request-1', result: { answers: { format: { answers: ['Long'] } } } }
      ])
    expect(s.events.filter((e) => e.type === 'questionStatus')).toEqual([
      { type: 'questionStatus', requestId: question.requestId, status: 'answered', answers }
    ])
  })
  it.each(['cancel', 'turnEnd', 'interrupt', 'close', 'exit', 'resolved'])(
    'cancels on %s and refuses a late answer',
    async (reason) => {
      const s = await setup(provider)
      s.startTurn()
      const question = s.ask()
      if (reason === 'cancel')
        expect(await s.chat.answerQuestion(question.requestId, { cancel: true })).toEqual({
          ok: true
        })
      if (reason === 'turnEnd') s.end()
      if (reason === 'interrupt') await s.chat.interrupt()
      if (reason === 'close') await s.chat.close()
      if (reason === 'exit') s.finish()
      if (reason === 'resolved')
        s.frame(
          provider === 'claude'
            ? { type: 'control_cancel_request', request_id: 'request-1' }
            : {
                method: 'serverRequest/resolved',
                params: { requestId: 'request-1', threadId: 'thread-fixture' }
              }
        )
      await flush()
      expect(s.events.filter((e) => e.type === 'questionStatus')).toEqual([
        { type: 'questionStatus', requestId: question.requestId, status: 'cancelled' }
      ])
      expect(
        await s.chat.answerQuestion(question.requestId, {
          answers: [{ questionId: question.questions[0].id, optionIds: ['o0'] }]
        })
      ).toMatchObject({ ok: false })
      expect(s.replies()).toHaveLength(['exit', 'resolved'].includes(reason) ? 0 : 1)
      if (s.replies().length) {
        if (provider === 'claude')
          expect(s.replies()[0].response.response).toMatchObject({ behavior: 'deny' })
        else expect(s.replies()[0].result).toEqual({ answers: {} })
      }
    }
  )
  it('refuses malformed and secret input without displaying an unanswerable card', async () => {
    const s = await setup(provider)
    s.ask({ questions: [] })
    s.ask({ questions: [{ ...fixture[0], id: 'secret', isSecret: true }] }, 'secret-request')
    expect(s.events.filter((e) => e.type === 'question')).toEqual([])
    expect(s.replies()).toHaveLength(2)
  })
})

it('Codex refuses foreign/settled turns and stays waiting through an idle status', async () => {
  const s = await setup('codex')
  s.startTurn()
  s.ask({ threadId: 'foreign' }, 0)
  s.ask({ turnId: 'foreign-turn' }, 1)
  expect(s.events.filter((e) => e.type === 'question')).toEqual([])
  const question = s.ask({}, 2)
  s.frame({
    method: 'thread/status/changed',
    params: { threadId: 'thread-fixture', status: { type: 'idle' } }
  })
  await new Promise((r) => setTimeout(r, 30))
  expect(s.events.filter((e) => e.type === 'turnEnd')).toEqual([])
  expect(s.events.filter((e) => e.type === 'questionStatus')).toEqual([])
  s.end()
  s.ask({}, 3)
  expect(s.events.filter((e) => e.type === 'question')).toHaveLength(1)
  expect(s.events.find((e) => e.type === 'questionStatus')).toMatchObject({
    requestId: question.requestId,
    status: 'cancelled'
  })
})

it('Codex systemError still fails the turn and cancels its question without turn/completed', async () => {
  const s = await setup('codex')
  s.startTurn()
  const question = s.ask()
  s.frame({
    method: 'thread/status/changed',
    params: { threadId: 'thread-fixture', status: { type: 'systemError' } }
  })
  await new Promise((r) => setTimeout(r, 30))
  expect(s.events.find((e) => e.type === 'turnEnd')).toMatchObject({ status: 'failed' })
  expect(s.events.find((e) => e.type === 'questionStatus')).toMatchObject({
    requestId: question.requestId,
    status: 'cancelled'
  })
})
