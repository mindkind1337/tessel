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
