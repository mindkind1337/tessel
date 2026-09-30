// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import {
  normalizeQuestions,
  validateQuestionAnswers,
  createQuestionRequests,
  providerAnswers,
  QUESTION_LIMITS
} from '../questions.js'

const source = (extra = {}) => [
  {
    question: 'Which format?',
    header: 'Format',
    multiSelect: false,
    options: [{ label: 'Short', description: 'A summary' }, { label: 'Long' }],
    ...extra
  }
]
const normalized = (extra) => normalizeQuestions(source(extra), 'claude')
const selection = [{ questionId: 'q0', optionIds: ['o1'] }]

describe('question boundary', () => {
  it('maps stable option ids back to provider labels without taking input from the renderer', () => {
    const qs = normalized()
    expect(qs[0]).toMatchObject({
      id: 'q0',
      freeTextQuestionId: 'q0',
      options: [
        { id: 'o0', label: 'Short' },
        { id: 'o1', label: 'Long' }
      ]
    })
    expect(validateQuestionAnswers(qs, selection)).toEqual(selection)
    expect(providerAnswers(qs, selection, 'claude')).toEqual({ 'Which format?': 'Long' })
    expect(providerAnswers(qs, selection, 'codex')).toEqual({ q0: { answers: ['Long'] } })
  })
  it('supports multi-select and bounded Unicode free text; duplicate labels still have distinct ids', () => {
    const qs = normalized({ multiSelect: true, options: [{ label: 'Same' }, { label: 'Same' }] })
    const value = [{ questionId: 'q0', optionIds: ['o0', 'o1'], other: '  Autre  ' }]
    const clean = validateQuestionAnswers(qs, value)
    expect(providerAnswers(qs, clean, 'claude')).toEqual({ 'Which format?': 'Same, Same, Autre' })
    expect(
      validateQuestionAnswers(qs, [{ questionId: 'q0', optionIds: [], other: 'é'.repeat(4096) }])
    ).not.toBeNull()
    expect(
      validateQuestionAnswers(qs, [{ questionId: 'q0', optionIds: [], other: 'é'.repeat(4097) }])
    ).toBeNull()
  })
  it.each([
    [],
    [{ questionId: 'wrong', optionIds: ['o0'] }],
    [{ questionId: 'q0', optionIds: ['fake'] }],
    [{ questionId: 'q0', optionIds: ['o0', 'o0'] }],
    [{ questionId: 'q0', optionIds: ['o0', 'o1'] }],
    [{ questionId: 'q0', optionIds: ['o0'], other: 'text' }],
    [{ questionId: 'q0', optionIds: [], other: '  ' }],
    [{ questionId: '__proto__', optionIds: [] }],
    [{ questionId: 'q0', optionIds: 'o0' }]
  ])('refuses forged/empty/multiple single selections: %j', (answers) => {
    expect(validateQuestionAnswers(normalized(), answers)).toBeNull()
  })
  it('requires every question exactly once and respects Codex isOther', () => {
    const qs = normalizeQuestions(
      [
        { ...source()[0], id: 'first', isOther: false },
        { ...source()[0], id: 'second', isOther: true }
      ],
      'codex'
    )
    expect(qs[0]).not.toHaveProperty('freeTextQuestionId')
    expect(qs[1].freeTextQuestionId).toBe('second')
    expect(validateQuestionAnswers(qs, [{ questionId: 'first', optionIds: ['o0'] }])).toBeNull()
    expect(
      validateQuestionAnswers(qs, [
        { questionId: 'first', optionIds: [], other: 'custom' },
        { questionId: 'second', optionIds: ['o0'] }
      ])
    ).toBeNull()
    expect(
      validateQuestionAnswers(qs, [
        { questionId: 'first', optionIds: ['o0'] },
        { questionId: 'second', optionIds: [], other: 'custom' }
      ])
    ).not.toBeNull()
    expect(
      validateQuestionAnswers(qs, [
        { questionId: 'first', optionIds: ['o0'] },
        { questionId: 'first', optionIds: ['o0'] }
      ])
    ).toBeNull()
    expect(
      normalizeQuestions([{ id: 'free', question: 'Explain', options: null }], 'codex')[0]
        .freeTextQuestionId
    ).toBe('free')
  })
  it('rejects oversized, malformed, duplicate-text Claude and secret questions', () => {
    for (const input of [
      null,
      [],
      Array(9).fill(source()[0]),
      source({ question: 'a'.repeat(2049) }),
      source({ question: 'é'.repeat(1025) }),
      source({ options: Array(33).fill({ label: 'A' }) }),
      source({ options: [{ label: 'a'.repeat(513) }] }),
      source({ options: [{ label: 'A', description: 'b'.repeat(2049) }] }),
      source({ isSecret: true }),
      source({ multiSelect: 'yes' }),
      [...source(), ...source()]
    ]) {
      expect(normalizeQuestions(input, 'claude')).toBeNull()
    }
    expect(normalizeQuestions(source({ id: '__proto__' }), 'codex')).toBeNull()
    expect(normalizeQuestions(source({ id: 'q', isSecret: 'true' }), 'codex')).toBeNull()
  })
})

describe('pending question lifecycle', () => {
  it.each(['x'.repeat(257), 1.5, null, {}, '', Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid raw ids with a provider reply: %j',
    (rawId) => {
      const emit = vi.fn(),
        reply = vi.fn(async () => true)
      createQuestionRequests(emit).add({ rawId, questions: normalized(), reply })
      expect(reply).toHaveBeenCalledExactlyOnceWith(null)
      expect(emit).not.toHaveBeenCalled()
    }
  )
  function setup() {
    const emit = vi.fn(),
      reply = vi.fn(async () => true),
      tracker = createQuestionRequests(emit)
    const add = (rawId) => {
      tracker.add({ rawId, questions: normalized(), turnId: 'turn', reply })
      return emit.mock.calls.at(-1)?.[1]?.requestId
    }
    return { emit, reply, tracker, add }
  }
  it('waits for the user, rejects bad answers without consuming the question, then answers once', async () => {
    const { tracker, add, reply, emit } = setup()
    const requestId = add(0)
    expect(reply).not.toHaveBeenCalled()
    expect(await tracker.answer(requestId, { answers: [] })).toMatchObject({ code: 'invalid' })
    expect(await tracker.answer(requestId, { answers: selection })).toEqual({ ok: true })
    expect(await tracker.answer(requestId, { answers: selection })).toMatchObject({
      code: 'unknown'
    })
    add(0) // retransmission of the raw request must not display/reply twice
    expect(reply).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls.map((c) => c[0])).toEqual(['question', 'questionStatus'])
  })
  it('deduplicates concurrent clicks and lets cancellation win over an in-flight write', async () => {
    const { tracker, add, reply, emit } = setup()
    let finish
    reply.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r
        })
    )
    const requestId = add('r')
    const pending = tracker.answer(requestId, { answers: selection })
    expect(await tracker.answer(requestId, { answers: selection })).toMatchObject({
      code: 'unknown'
    })
    tracker.cancel(() => true, true)
    finish(true)
    expect(await pending).toMatchObject({ ok: false })
    expect(reply).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls.at(-1)).toEqual(['questionStatus', { requestId, status: 'cancelled' }])
  })
  it('cancels resolved raw ids without responding again and limits pending requests', () => {
    const { tracker, add, reply, emit } = setup()
    for (let i = 0; i < QUESTION_LIMITS.pending + 1; i++) add(i)
    expect(reply).toHaveBeenCalledTimes(1)
    tracker.cancelRaw(0)
    expect(reply).toHaveBeenCalledTimes(1)
    tracker.cancel((q) => q.turnId === 'turn', true)
    expect(tracker.size()).toBe(0)
    expect(emit.mock.calls.filter((c) => c[0] === 'questionStatus')).toHaveLength(8)
    expect(reply).toHaveBeenCalledTimes(8)
  })
  it('failed writes cancel instead of leaving a card that can only fail again', async () => {
    const { tracker, add, reply, emit } = setup()
    reply.mockRejectedValueOnce(new Error('closed'))
    const requestId = add('r')
    expect(await tracker.answer(requestId, { answers: selection })).toEqual({
      ok: false,
      code: 'failed'
    })
    expect(emit.mock.calls.at(-1)[1].status).toBe('cancelled')
    expect(tracker.size()).toBe(0)
  })
})

describe('OpenCode questions (question tool)', () => {
  const oc = (extra = {}) => [{ question: 'Which format?', header: 'Format', options: [{ label: 'Summary', description: 'Brief' }, { label: 'Full', description: 'All' }], ...extra }]
  it('positional ids, multiple and custom map to the normalized shape', () => {
    expect(normalizeQuestions(oc(), 'opencode')).toEqual([
      { id: 'q0', question: 'Which format?', header: 'Format', multiSelect: false, options: [{ id: 'o0', label: 'Summary', description: 'Brief' }, { id: 'o1', label: 'Full', description: 'All' }], freeTextQuestionId: 'q0' }
    ])
    expect(normalizeQuestions(oc({ multiple: true, custom: false }), 'opencode')[0]).toMatchObject({ multiSelect: true })
    expect(normalizeQuestions(oc({ custom: false }), 'opencode')[0].freeTextQuestionId).toBeUndefined()
    expect(normalizeQuestions(oc({ multiple: 'yes' }), 'opencode')).toBe(null)
    expect(normalizeQuestions(oc({ custom: 1 }), 'opencode')).toBe(null)
  })
  it('answers are one array of labels per question, in order', () => {
    const qs = normalizeQuestions([...oc(), { question: 'Why?', header: 'Why', options: [] }], 'opencode')
    const answers = [
      { questionId: 'q1', optionIds: [], other: 'Because' },
      { questionId: 'q0', optionIds: ['o1'] }
    ]
    expect(providerAnswers(qs, validateQuestionAnswers(qs, answers), 'opencode')).toEqual([['Full'], ['Because']])
  })
})
