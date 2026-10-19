import { describe, expect, it } from 'vitest'
import { parseLimitReset, resetZone, formatLimitReset } from '../limitReset'

// Mon Oct 19 2026, 10:30 in Toronto (EDT, UTC-4).
const NOW = Date.UTC(2026, 9, 19, 14, 30)
const TZ = 'America/Toronto'
const local = (y, mo, d, h, mi = 0) => new Date(y, mo, d, h, mi).getTime()

describe('parseLimitReset', () => {
  it('reads a clock time in the zone the agent names, today or tomorrow', () => {
    // Claude Code: "5-hour limit reached ∙ resets 3pm (America/Toronto)"
    expect(parseLimitReset('3pm', { now: NOW, timeZone: TZ })).toBe(Date.UTC(2026, 9, 19, 19, 0))
    expect(parseLimitReset('3pm (America/Toronto)', { now: NOW })).toBe(Date.UTC(2026, 9, 19, 19, 0))
    // Gone by: tomorrow's.
    expect(parseLimitReset('9am', { now: NOW, timeZone: TZ })).toBe(Date.UTC(2026, 9, 20, 13, 0))
    expect(parseLimitReset('8:47 PM', { now: NOW, timeZone: TZ })).toBe(Date.UTC(2026, 9, 20, 0, 47))
    expect(parseLimitReset('11 a.m.', { now: NOW, timeZone: TZ })).toBe(Date.UTC(2026, 9, 19, 15, 0))
    expect(parseLimitReset('15:00', { now: NOW, timeZone: TZ })).toBe(Date.UTC(2026, 9, 19, 19, 0))
  })

  it('a clock time with no zone is the computer’s own', () => {
    const now = local(2026, 9, 19, 10, 30)
    expect(parseLimitReset('5 PM', { now })).toBe(local(2026, 9, 19, 17))
    expect(parseLimitReset('8am', { now })).toBe(local(2026, 9, 20, 8))
  })

  it('reads a day with a time, this year or next', () => {
    // "You've hit your weekly limit · resets Oct 17, 11pm (America/Toronto)" read on Oct 14
    const oct14 = Date.UTC(2026, 9, 14, 3, 17)
    expect(parseLimitReset('Oct 17, 11pm (America/Toronto)', { now: oct14 })).toBe(Date.UTC(2026, 9, 18, 3, 0))
    expect(parseLimitReset('Oct 3', { now: Date.UTC(2026, 9, 1), timeZone: 'UTC/Zone' })).toBe(local(2026, 9, 3, 0))
    // Read on Dec 30, a reset on Jan 2: next year's.
    expect(parseLimitReset('Jan 2, 9am', { now: Date.UTC(2026, 11, 30, 12), timeZone: TZ })).toBe(Date.UTC(2027, 0, 2, 14, 0))
  })

  it('reads durations, ISO times and epoch seconds', () => {
    expect(parseLimitReset('in 2 days 3 hours', { now: NOW })).toBe(NOW + (51 * 60) * 60 * 1000)
    expect(parseLimitReset('in 45 minutes', { now: NOW })).toBe(NOW + 45 * 60 * 1000)
    expect(parseLimitReset('1 hr, 5 mins', { now: NOW })).toBe(NOW + 65 * 60 * 1000)
    // Muse: "Your usage window resets at 2026-10-19T15:13:21Z."
    expect(parseLimitReset('2026-10-19T15:13:21Z', { now: NOW })).toBe(Date.UTC(2026, 9, 19, 15, 13, 21))
    // Claude Code's older "Claude AI usage limit reached|1792440000"; Codex's resets_at.
    expect(parseLimitReset('1792440000', { now: NOW })).toBe(1792440000 * 1000)
    expect(parseLimitReset(1792440000, { now: NOW })).toBe(1792440000 * 1000)
  })

  it('says nothing for text that is no reset time', () => {
    for (const s of ['', 'soon', 'tomorrow', '99:99', '25', 'in a while', 'Foo 3, 9am', '1999-01-01T00:00:00Z', 'x'.repeat(200)])
      expect(parseLimitReset(s, { now: NOW, timeZone: TZ })).toBeNull()
    // Too far ahead to be a usage limit's reset.
    expect(parseLimitReset('in 90 days', { now: NOW })).toBeNull()
  })
})

describe('resetZone', () => {
  it('takes only a real IANA zone', () => {
    expect(resetZone('resets 3pm (America/Toronto)')).toBe('America/Toronto')
    expect(resetZone('resets 3pm (Mars/Olympus)')).toBeNull()
    expect(resetZone('resets 3pm')).toBeNull()
  })
})

describe('formatLimitReset', () => {
  it('shows only the time today, a weekday this week, a date later', () => {
    const now = local(2026, 9, 19, 10, 30)
    expect(formatLimitReset(local(2026, 9, 19, 15), { now, locale: 'en-GB' })).toBe('15:00')
    expect(formatLimitReset(local(2026, 9, 20, 9), { now, locale: 'en-GB' })).toBe('Tue 09:00')
    expect(formatLimitReset(local(2026, 10, 2, 9), { now, locale: 'en-GB' })).toBe('2 Nov, 09:00')
    expect(formatLimitReset(NaN)).toBe('')
  })
})
