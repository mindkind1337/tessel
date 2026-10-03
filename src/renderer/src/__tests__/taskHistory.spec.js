// The finished tasks' history (taskHistory.js): a record when a card enters
// Done, kept after the card is deleted, figures kept once read.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { setTasks, addTask, updateTask, removeTask, tasks } from '../taskBoardStore'
import { taskHistory, setTaskHistory, setHistoryDescriber, backfillHistory, noteCost, needsCost, periodsOf, workTime, MAX_HISTORY, SETTLE_MS } from '../taskHistory'

const T0 = Date.parse('2026-10-01T10:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  setTasks([])
  setTaskHistory([])
  setHistoryDescriber(() => ({ agentName: 'Ada', agentKind: 'claude', project: 'Tessel' }))
})
afterEach(() => {
  setHistoryDescriber(null)
  vi.useRealTimers()
})

describe('task history records', () => {
  it('a card entering Done gets a record: who, where, its work time', () => {
    const c = addTask({ title: 'Fix it', wsId: 'ws1' })
    updateTask(c.id, { column: 'doing', paneId: 'p1' })
    vi.setSystemTime(T0 + 60000)
    updateTask(c.id, { column: 'review' })
    vi.setSystemTime(T0 + 90000)
    updateTask(c.id, { column: 'doing' })
    vi.setSystemTime(T0 + 120000)
    updateTask(c.id, { column: 'done' })
    expect(taskHistory).toHaveLength(1)
    const r = taskHistory[0]
    expect(r).toMatchObject({ id: c.id, title: 'Fix it', wsId: 'ws1', paneId: 'p1', agentName: 'Ada', agentKind: 'claude', project: 'Tessel', startedAt: T0, doneAt: T0 + 120000 })
    expect(r.workPeriods).toHaveLength(2)
    expect(r.durationMs).toBe(90000)
  })

  it('taken back out of Done: no record; renamed while done: the new title', () => {
    const c = addTask({ title: 'A' })
    updateTask(c.id, { column: 'done' })
    updateTask(c.id, { title: 'B' })
    expect(taskHistory[0].title).toBe('B')
    updateTask(c.id, { column: 'doing' })
    expect(taskHistory).toHaveLength(0)
  })

  it('a deleted card keeps its record', () => {
    const c = addTask({ title: 'A' })
    updateTask(c.id, { column: 'done' })
    removeTask(c.id)
    expect(tasks).toHaveLength(0)
    expect(taskHistory.map((r) => r.id)).toEqual([c.id])
  })

  it('done again: one record, the figures read before kept until read again', () => {
    const c = addTask({ title: 'A' })
    updateTask(c.id, { column: 'done' })
    noteCost(c.id, { status: 'ok', inputTokens: 5, outputTokens: 1, usd: 0.5, known: true, models: [] })
    updateTask(c.id, { column: 'review' })
    expect(taskHistory).toHaveLength(0)
    updateTask(c.id, { column: 'done' })
    expect(taskHistory).toHaveLength(1)
    expect(needsCost(taskHistory[0])).toBe(true)
  })

  it('done cards with no record are recorded on load (backfill), oldest first', () => {
    setTasks([
      { id: 'b', title: 'B', column: 'done', doneAt: T0 + 2, startedAt: T0 },
      { id: 'a', title: 'A', column: 'done', doneAt: T0 + 1 },
      { id: 'c', title: 'C', column: 'todo' }
    ])
    expect(backfillHistory(tasks)).toBe(2)
    expect(taskHistory.map((r) => r.id)).toEqual(['a', 'b'])
    expect(taskHistory[1]).toMatchObject({ agentName: 'Ada', durationMs: 2 })
    expect(backfillHistory(tasks)).toBe(0)
  })

  it('keeps at most MAX_HISTORY records (the oldest go)', () => {
    setTaskHistory(Array.from({ length: MAX_HISTORY + 3 }, (_, i) => ({ id: 'h' + i, title: 't', doneAt: i + 1 })))
    expect(taskHistory).toHaveLength(MAX_HISTORY)
    expect(taskHistory[0].id).toBe('h3')
  })

  it('a saved history is cleaned: bad records and duplicates dropped, figures compacted', () => {
    setTaskHistory([
      null,
      { title: 'no id' },
      {
        id: 'x',
        title: 'X',
        doneAt: 5,
        workPeriods: [{ start: 1, end: 3 }, { nope: 1 }],
        cost: { status: 'ok', inputTokens: 10.4, models: [{ model: 'm', inputTokens: 3 }], subagents: [{ id: 's1' }, { id: 's2' }] }
      },
      { id: 'x', title: 'dup' }
    ])
    expect(taskHistory).toHaveLength(1)
    expect(taskHistory[0].durationMs).toBe(2)
    expect(taskHistory[0].cost).toMatchObject({ status: 'ok', inputTokens: 10, subagents: 2 })
    expect(taskHistory[0].cost.models[0]).toMatchObject({ model: 'm', inputTokens: 3 })
  })
})

describe('figures', () => {
  it('final once read long enough after the card was done; an unreadable read keeps the earlier figures', () => {
    setTaskHistory([{ id: 'x', title: 'X', doneAt: T0 }])
    const r = taskHistory[0]
    expect(needsCost(r)).toBe(true)
    noteCost('x', { status: 'ok', inputTokens: 10, outputTokens: 5, usd: 1, known: true }, T0 + 1000)
    expect(needsCost(r)).toBe(true)
    noteCost('x', { status: 'unavailable', reason: 'missing-file' }, T0 + SETTLE_MS)
    expect(r.cost).toMatchObject({ status: 'ok', usd: 1 })
    expect(needsCost(r)).toBe(false)
  })

  it('a partial read is never final', () => {
    setTaskHistory([{ id: 'x', title: 'X', doneAt: T0 }])
    noteCost('x', { status: 'ok', partial: true }, T0 + SETTLE_MS * 2)
    expect(needsCost(taskHistory[0])).toBe(true)
  })
})

describe('work periods', () => {
  it('an open period ends when the card was done; an old card uses startedAt', () => {
    expect(periodsOf({ workPeriods: [{ start: 10, end: null, paneId: 'p' }], doneAt: 50 })).toEqual([{ start: 10, end: 50, paneId: 'p' }])
    expect(periodsOf({ startedAt: 10, doneAt: 40, paneId: 'q' })).toEqual([{ start: 10, end: 40, paneId: 'q' }])
    expect(workTime([{ start: 0, end: 10 }, { start: 20, end: 25 }])).toBe(15)
  })
})
