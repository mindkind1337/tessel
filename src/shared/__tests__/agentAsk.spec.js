// @vitest-environment node
// The question an agent asks, kept from its hook: only the question
// structure, bounded, the same in the hook script and in the main process.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { join } from 'path'
import { ASK_LIMITS, nextAsk, sanitizeAsk, validAsk } from '../agentAsk'

const require = createRequire(import.meta.url)
const server = require(join(__dirname, '..', '..', 'main', 'teamMcp', 'server.cjs'))

const claudeInput = {
  questions: [
    {
      question: 'Which database?',
      header: 'DB',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: 'Relational', secret: 'PRIVATE-OPTION' },
        { label: 'SQLite' }
      ],
      extra: 'PRIVATE-QUESTION'
    }
  ],
  metadata: { source: 'PRIVATE-META' },
  answers: { 'Which database?': 'PRIVATE-ANSWER' }
}
const codexInput = {
  questions: [
    { id: 'color', header: 'Color', question: 'Red or blue?', isOther: true, options: [{ label: 'Red', description: 'Warm.' }, { label: 'Blue' }] }
  ]
}

describe('sanitizeAsk', () => {
  it.each([
    ['shared', sanitizeAsk],
    ['hook script', server.sanitizeAsk]
  ])('keeps only questions, headers, multiSelect and option labels/descriptions (%s)', (_, sanitize) => {
    const ask = sanitize(claudeInput)
    expect(ask).toEqual({
      questions: [
        {
          question: 'Which database?',
          header: 'DB',
          options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite' }]
        }
      ]
    })
    expect(JSON.stringify(ask)).not.toMatch(/PRIVATE/)
    expect(sanitize(codexInput)).toEqual({
      questions: [{ question: 'Red or blue?', header: 'Color', options: [{ label: 'Red', description: 'Warm.' }, { label: 'Blue' }] }]
    })
    expect(sanitize({ questions: [{ question: 'Pick', multiSelect: true, options: ['a', 'b'] }] })).toEqual({
      questions: [{ question: 'Pick', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }]
    })
    expect(sanitize(JSON.stringify(codexInput))).toEqual(sanitize(codexInput))
  })

  it.each([
    ['shared', sanitizeAsk],
    ['hook script', server.sanitizeAsk]
  ])('drops control characters except newline, and bidirectional overrides (%s)', (_, sanitize) => {
    const ask = sanitize({ questions: [{ question: 'a\u0000b\u0007c\r\nd\te\u001b[31m\u009bf‮g', options: [{ label: 'x\u0008y', description: 'p⁦q' }] }] })
    expect(ask.questions[0].question).toBe('abc\nde[31mfg')
    expect(ask.questions[0].options[0]).toEqual({ label: 'xy', description: 'pq' })
  })

  it.each([
    ['shared', sanitizeAsk],
    ['hook script', server.sanitizeAsk]
  ])('cuts texts at their limit and refuses counts or sizes over it (%s)', (_, sanitize) => {
    const long = sanitize({
      questions: [{ question: 'q'.repeat(5000), header: 'h'.repeat(500), options: [{ label: 'l'.repeat(900), description: 'd'.repeat(900) }] }]
    })
    expect(long.questions[0].question).toHaveLength(ASK_LIMITS.question)
    expect(long.questions[0].header).toHaveLength(ASK_LIMITS.header)
    expect(long.questions[0].options[0].label).toHaveLength(ASK_LIMITS.label)
    expect(long.questions[0].options[0].description).toHaveLength(ASK_LIMITS.description)
    // A cut list would shift the answer keys: no card at all.
    const q = (n) => ({ question: 'Q', options: Array.from({ length: n }, (_, i) => ({ label: `o${i}` })) })
    expect(sanitize({ questions: [q(ASK_LIMITS.options + 1)] })).toBeNull()
    expect(sanitize({ questions: Array.from({ length: ASK_LIMITS.questions + 1 }, () => q(2)) })).toBeNull()
    expect(sanitize({ questions: [] })).toBeNull()
    // Within every count, but over 16 KB once serialized.
    const big = { question: 'x'.repeat(1000), options: Array.from({ length: 8 }, () => ({ label: 'l'.repeat(200), description: 'd'.repeat(500) })) }
    expect(sanitize({ questions: [big, big, big, big] })).toBeNull()
    expect(sanitize({ questions: [big, big] })).not.toBeNull()
    // Never half of a character.
    const emoji = sanitize({ questions: [{ question: 'a' + '\u{1F600}'.repeat(600), options: [] }] })
    expect(/[\ud800-\udbff]$/.test(emoji.questions[0].question)).toBe(false)
  })

  it.each([
    ['shared', sanitizeAsk],
    ['hook script', server.sanitizeAsk]
  ])('refuses unknown shapes (%s)', (_, sanitize) => {
    for (const bad of [null, 'nope', '{bad', [], { questions: 'x' }, { questions: [null] }, { questions: [{ question: 'Q', options: [{ nolabel: 1 }] }] }, { questions: [{ options: [] }] }, { questions: [{ question: 'Q', options: 'a' }] }])
      expect(sanitize(bad)).toBeNull()
  })

  it('is the same in the hook script and the main process', () => {
    expect(server.ASK_LIMITS).toEqual({ ...ASK_LIMITS })
    for (const input of [claudeInput, codexInput, { questions: [{ question: 'é\u0001', options: ['a'] }] }])
      expect(server.sanitizeAsk(input)).toEqual(sanitizeAsk(input))
  })
})

describe('validAsk (main process, on a spooled event)', () => {
  const ask = sanitizeAsk(codexInput)
  const event = (extra = {}) => ({ event: 'PreToolUse', provider: 'codex', toolName: 'request_user_input', toolId: 'call_1', ask, ...extra })
  it('accepts only the canonical ask of a lead question tool from a chat-view agent', () => {
    expect(validAsk(event())).toEqual(ask)
    expect(validAsk(event({ event: 'PermissionRequest', provider: 'claude', toolName: 'AskUserQuestion' }))).toEqual(ask)
    expect(validAsk(event({ toolName: 'Bash' }))).toBeNull()
    expect(validAsk(event({ event: 'PostToolUse' }))).toBeNull()
    expect(validAsk(event({ agentId: 'child-1' }))).toBeNull()
    expect(validAsk(event({ provider: 'cursor' }))).toBeNull()
    // Anything the sanitizer would have changed or dropped: not shown.
    expect(validAsk(event({ ask: { questions: [{ ...ask.questions[0], id: 'color' }] } }))).toBeNull()
    expect(validAsk(event({ ask: { questions: [{ ...ask.questions[0], question: 'x\u0007' }] } }))).toBeNull()
    expect(validAsk(event({ ask: { questions: [{ ...ask.questions[0], question: 'x'.repeat(1001) }] } }))).toBeNull()
    expect(validAsk(event({ ask: JSON.stringify(ask) }))).toBeNull()
  })
})

describe('nextAsk (when a question card is forgotten)', () => {
  const ask = sanitizeAsk(claudeInput)
  const asked = nextAsk(null, { event: 'PreToolUse', provider: 'claude', toolName: 'AskUserQuestion', toolId: 'toolu_1', ask })
  it('keeps a question from its PreToolUse until its answer, a prompt or the end of the turn', () => {
    expect(asked).toEqual({ toolId: 'toolu_1', toolName: 'AskUserQuestion', questions: ask.questions })
    expect(nextAsk(asked, { event: 'Notification' })).toBe(asked)
    expect(nextAsk(asked, { event: 'PermissionRequest', toolName: 'AskUserQuestion', toolId: 'toolu_1' })).toBe(asked)
    expect(nextAsk(asked, { event: 'PostToolUse', toolId: 'toolu_other' })).toBe(asked)
    expect(nextAsk(asked, { event: 'Stop', agentId: 'child-1' })).toBe(asked)
    for (const e of [
      { event: 'PostToolUse', toolId: 'toolu_1' },
      { event: 'PostToolUseFailure', toolId: 'toolu_1' },
      { event: 'PostToolUse' },
      { event: 'PreToolUse', toolName: 'Bash', toolId: 'toolu_2' },
      { event: 'PreToolUse', toolName: 'AskUserQuestion', toolId: 'toolu_3' },
      { event: 'UserPromptSubmit' },
      { event: 'Stop' },
      { event: 'StopFailure' },
      { event: 'Interrupt' },
      { event: 'SessionStart' },
      { event: 'SessionEnd' }
    ])
      expect(nextAsk(asked, e)).toBeNull()
  })
  it('replaces it with a newer question', () => {
    const other = sanitizeAsk(codexInput)
    expect(nextAsk(asked, { event: 'PreToolUse', provider: 'claude', toolName: 'AskUserQuestion', toolId: 'toolu_9', ask: other })).toMatchObject({ toolId: 'toolu_9', questions: other.questions })
  })
})
