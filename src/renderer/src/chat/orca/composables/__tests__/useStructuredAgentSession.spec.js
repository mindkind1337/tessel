import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useStructuredAgentSession } from '../useStructuredAgentSession'

function setup(history, extra = {}) {
  let listener = null
  const api = {
    history: vi.fn(async () => history),
    onEvent: vi.fn((cb) => {
      listener = cb
      return () => (listener = null)
    }),
    send: vi.fn(async () => ({ ok: true, id: 'u9' })),
    interrupt: vi.fn(async () => ({ ok: true })),
    approve: vi.fn(async () => ({ ok: true })),
    ...extra
  }
  let session
  const Comp = defineComponent({
    setup() {
      session = useStructuredAgentSession({ paneId: 'p1', api })
      return () => h('div')
    }
  })
  const wrapper = mount(Comp)
  return { api, wrapper, session: () => session, emit: (event, seq, paneId = 'p1') => listener && listener({ paneId, seq, event }) }
}

describe('useStructuredAgentSession (Tessel engine)', () => {
  it('ignores an old history response after the conversation is reset', async () => {
    let finish
    const { session, api, emit, wrapper } = setup({ ok: true, seq: 0, events: [] })
    const s = session()
    api.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const previous = s.load()
    s.reset()
    await s.load()
    emit({ type: 'assistant', messageId: 'new', text: 'new conversation' }, 1)
    finish({ ok: true, seq: 50, events: [{ seq: 50, event: { type: 'assistant', messageId: 'old', text: 'old conversation' } }] })
    expect(await previous).toMatchObject({ ok: false, code: 'stale' })
    expect(s.messages.value.map(message => message.blocks[0].text)).toEqual(['new conversation'])
    emit({ type: 'assistant', messageId: 'new2', text: 'still live' }, 2)
    expect(s.messages.value).toHaveLength(2)
    wrapper.unmount()
  })

  it('ignores an older-page response from the previous conversation', async () => {
    let finish
    const { session, api, wrapper } = setup({ ok: true, seq: 0, events: [], older: true }, {
      historyOlder: () => new Promise(resolve => { finish = resolve })
    })
    const s = session()
    await s.load()
    const pending = s.loadOlder()
    s.reset()
    api.history.mockResolvedValue({ ok: true, seq: 0, events: [], older: false })
    await s.load()
    finish({ ok: true, events: [{ type: 'assistant', messageId: 'old', text: 'old page' }], cursor: { k: 'file', n: 10 }, done: false })
    expect(await pending).toBe('unchanged')
    expect(s.messages.value).toEqual([])
    expect(s.hasOlder.value).toBe(false)
    expect(s.loadingOlder.value).toBe(false)
    wrapper.unmount()
  })
  it('redraws from the journal, then follows live events once (seq)', async () => {
    const { session, emit } = setup({
      ok: true,
      seq: 2,
      open: true,
      events: [
        { seq: 1, event: { type: 'user', id: 'u1', text: 'hi', status: 'accepted' } },
        { seq: 2, event: { type: 'assistant', messageId: 'm1', text: 'hello' } }
      ]
    })
    // A live event before the journal is read waits.
    emit({ type: 'turnEnd', status: 'completed' }, 3)
    const s = session()
    await s.load()
    expect(s.messages.value.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(s.turnId.value).toBeNull()
    expect(s.meta.open).toBe(true)
    // Already applied (seq 3), or from another pane: ignored.
    emit({ type: 'assistant', messageId: 'm2', text: 'dup' }, 3)
    emit({ type: 'assistant', messageId: 'm3', text: 'other' }, 9, 'p2')
    emit({ type: 'user', id: 'u2', text: 'next', status: 'accepted' }, 4)
    await nextTick()
    expect(s.messages.value.map((m) => m.blocks[0].text)).toEqual(['hi', 'hello', 'next'])
    expect(s.isWorking.value).toBe(true)
  })

  it('a pending approval is a prompt; responding maps the option to Tessel decisions', async () => {
    const { session, emit, api } = setup({ ok: true, seq: 0, events: [] })
    const s = session()
    await s.load()
    emit({ type: 'user', id: 'u1', text: 'go', status: 'accepted' }, 1)
    emit({ type: 'approval', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, status: 'pending' }, 2)
    expect(s.prompts.value.length).toBe(1)
    await s.respond(s.prompts.value[0], { kind: 'option', optionId: 'allowSession' })
    expect(api.approve).toHaveBeenCalledWith({ paneId: 'p1', requestId: 'r1', decision: 'allowSession' })
    await s.respond(s.prompts.value[0], { kind: 'option', optionId: 'deny' }, { message: 'no' })
    expect(api.approve).toHaveBeenLastCalledWith({ paneId: 'p1', requestId: 'r1', decision: 'deny', message: 'no' })
    expect(await s.respond(s.prompts.value[0], { kind: 'option', optionId: 'weird' })).toBeNull()
  })

  it("the journal's write times date the redrawn rows; an unconfirmed delivery is listed by message id", async () => {
    const { session, emit } = setup({
      ok: true,
      seq: 2,
      events: [
        { seq: 1, at: 1000, event: { type: 'user', id: 'u1', text: 'hi', status: 'accepted' } },
        { seq: 2, at: 2000, event: { type: 'assistant', messageId: 'm1', text: 'hello' } }
      ]
    })
    const s = session()
    await s.load()
    expect(s.messages.value.map((m) => m.timestamp)).toEqual([1000, 2000])
    emit({ type: 'user', id: 'u2', text: 'lost', status: 'sent' }, 3)
    emit({ type: 'userStatus', id: 'u2', status: 'failed' }, 4)
    await nextTick()
    const failed = [...s.failedDeliveryMessageIds.value]
    expect(failed.length).toBe(1)
    expect(s.messages.value.find((m) => failed.includes(m.id)).blocks[0].text).toBe('lost')
  })

  it('the "/" catalog: from the history, then each live snapshot; skills come from the engine or fail', async () => {
    const skills = vi.fn(async () => ({ ok: true, result: { skills: [{ id: 's1', name: 'review' }], sources: [], scannedAt: 1 } }))
    const { session, emit, api } = setup({ ok: true, seq: 0, events: [], commands: [{ name: 'compact', kind: 'command' }] }, { skills })
    const s = session()
    expect(s.sessionCommands.value).toBeUndefined()
    await s.load()
    expect(s.sessionCommands.value).toEqual([{ name: 'compact', kind: 'command' }])
    emit({ type: 'commands', commands: [] }, 1)
    await nextTick()
    expect(s.sessionCommands.value).toEqual([])
    expect(await s.discoverSkills({ refresh: true })).toMatchObject({ skills: [{ name: 'review' }] })
    expect(api.skills).toHaveBeenCalledWith({ paneId: 'p1', refresh: true })
    skills.mockResolvedValueOnce({ ok: false, error: 'untrusted' })
    await expect(s.discoverSkills()).rejects.toThrow('untrusted')
  })

  it('send and cancel go to the IPC; a failed history is an error state', async () => {
    const { session, api } = setup({ ok: false, error: 'boom' })
    const s = session()
    await s.load()
    expect(s.status.value).toBe('error')
    expect(s.error.value).toBe('boom')
    await s.send('text')
    expect(api.send).toHaveBeenCalledWith({ paneId: 'p1', text: 'text' })
    await s.cancel()
    expect(api.interrupt).toHaveBeenCalledWith({ paneId: 'p1' })
  })

  it('an imported history (one event holding many) is drawn once, in order, and never announced', async () => {
    const onLive = vi.fn()
    let listener = null
    const api = { history: vi.fn(async () => ({ ok: true, seq: 1, events: [{ seq: 1, event: { type: 'status', state: 'starting' } }] })), onEvent: (cb) => ((listener = cb), () => {}) }
    let session
    mount(defineComponent({ setup() { session = useStructuredAgentSession({ paneId: 'p1', api, onLive }); return () => h('div') } }))
    await session.load()
    const at = Date.parse('2026-09-01T10:00:00.000Z')
    listener({ paneId: 'p1', seq: 5, event: { type: 'history', events: [
      { seq: 1, event: { type: 'user', id: 'old', text: 'already there', status: 'accepted' } },
      { seq: 2, event: { type: 'notice', kind: 'info', text: 'Earlier conversation', imported: true, at } },
      { seq: 3, event: { type: 'user', id: 'hist-u1', text: 'Earlier prompt', status: 'accepted', imported: true, at } },
      { seq: 4, event: { type: 'assistant', messageId: 'hist-m1', text: 'Earlier answer', imported: true, at: at + 5000 } },
      { seq: 5, event: { type: 'turnEnd', status: 'completed', imported: true, at: at + 6000 } }
    ] } })
    await nextTick()
    expect(onLive).not.toHaveBeenCalled()
    expect(session.messages.value.map((m) => m.blocks[0].text)).toEqual(['Earlier conversation', 'Earlier prompt', 'Earlier answer'])
    expect(session.turnId.value).toBeNull()
    // Its seqs count: a live event already in it is not applied twice.
    listener({ paneId: 'p1', seq: 4, event: { type: 'assistant', messageId: 'dup', text: 'dup' } })
    await nextTick()
    expect(session.messages.value).toHaveLength(3)
  })
})

describe('useStructuredAgentSession: questions', () => {
  const ask = (id) => ({ type: 'question', requestId: id, status: 'pending', questions: [{ id: 'q0', question: 'Which?', multiSelect: false, options: [{ id: 'o0', label: 'A' }] }] })
  it('answers and cancels through chat.answer; after a reload only the questions the main process still holds stay open', async () => {
    const answer = vi.fn(async () => ({ ok: true }))
    const { session, api } = setup({ ok: true, seq: 3, events: [{ seq: 1, event: { type: 'user', id: 'u1', text: 'go', status: 'accepted' } }, { seq: 2, event: ask('question_old') }, { seq: 3, event: ask('question_live') }], questions: [ask('question_live'), ask('question_tail')] }, { answer })
    const s = session()
    await s.load()
    const ids = s.prompts.value.map((p) => p.body.tessel.requestId)
    expect(ids.sort()).toEqual(['question_live', 'question_tail'])
    const live = s.prompts.value.find((p) => p.body.tessel.requestId === 'question_live')
    await s.respond(live, { kind: 'answers', answers: [{ questionId: 'q0', optionIds: ['o0'] }] })
    expect(api.answer).toHaveBeenCalledWith({ paneId: 'p1', requestId: 'question_live', answers: [{ questionId: 'q0', optionIds: ['o0'] }] })
    await s.respond(live, { kind: 'cancel' })
    expect(api.answer).toHaveBeenLastCalledWith({ paneId: 'p1', requestId: 'question_live', cancel: true })
    expect(await s.respond(live, { kind: 'option', optionId: 'allow' })).toBeNull()
  })
})

describe('useStructuredAgentSession: older history', () => {
  const recent = { ok: true, seq: 1, older: true, events: [{ seq: 1, at: 5000, event: { type: 'user', id: 'hist-u9', text: 'recent', status: 'accepted', imported: true, at: 5000 } }] }
  it('loads pages before what is shown, with the cursor it was given, until there is no more', async () => {
    const historyOlder = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, events: [{ type: 'user', id: 'hist-u2', text: 'older', status: 'accepted', at: 2000 }], cursor: { k: 'file', n: 77 }, done: false })
      .mockResolvedValueOnce({ ok: true, events: [], cursor: { k: 'file', n: 50 }, done: false })
      .mockResolvedValueOnce({ ok: true, events: [{ type: 'user', id: 'hist-u1', text: 'oldest', status: 'accepted', at: 1000 }], cursor: null, done: true })
    const { session, api } = setup(recent, { historyOlder })
    const s = session()
    expect(s.hasOlder.value).toBe(false)
    await s.load()
    expect(s.hasOlder.value).toBe(true)
    expect(await s.loadOlder()).toBe('applied')
    expect(api.historyOlder).toHaveBeenLastCalledWith({ paneId: 'p1' })
    expect(s.olderHistoryGeneration.value).toBe(1)
    expect(s.messages.value.map((m) => m.blocks[0].text)).toEqual(['older', 'recent'])
    // An empty page with more behind it: the next one in the same call.
    expect(await s.loadOlder()).toBe('applied')
    expect(api.historyOlder).toHaveBeenNthCalledWith(2, { paneId: 'p1', cursor: { k: 'file', n: 77 } })
    expect(api.historyOlder).toHaveBeenNthCalledWith(3, { paneId: 'p1', cursor: { k: 'file', n: 50 } })
    expect(s.messages.value.map((m) => m.blocks[0].text)).toEqual(['oldest', 'older', 'recent'])
    expect(s.hasOlder.value).toBe(false)
    expect(await s.loadOlder()).toBe('unchanged')
    expect(api.historyOlder).toHaveBeenCalledTimes(3)
  })

  it('a failed page says so and can be asked again; a chat that closed has nothing older', async () => {
    const historyOlder = vi.fn().mockResolvedValueOnce({ ok: false, code: 'missing' }).mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce({ ok: false, code: 'closed' })
    const { session } = setup(recent, { historyOlder })
    const s = session()
    await s.load()
    expect(await s.loadOlder()).toBe('failed')
    expect(s.hasOlder.value).toBe(true)
    expect(await s.loadOlder()).toBe('failed')
    expect(await s.loadOlder()).toBe('failed')
    expect(s.hasOlder.value).toBe(false)
    expect(s.loadingOlder.value).toBe(false)
  })
})
