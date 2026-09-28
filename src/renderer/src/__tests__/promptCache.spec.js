import { describe, it, expect } from 'vitest'
import { cacheCountdown } from '../promptCache'

describe('prompt cache countdown', () => {
  const t0 = 1_000_000
  it('counts down m:ss, warns in the last minute, then expires', () => {
    expect(cacheCountdown(t0, 300000, t0)).toMatchObject({ label: '5:00', level: 'ok' })
    expect(cacheCountdown(t0, 300000, t0 + 239_500)).toMatchObject({ label: '1:01', level: 'ok' })
    expect(cacheCountdown(t0, 300000, t0 + 240_000)).toMatchObject({ label: '1:00', level: 'warn' })
    expect(cacheCountdown(t0, 300000, t0 + 299_001)).toMatchObject({ label: '0:01', level: 'warn' })
    expect(cacheCountdown(t0, 300000, t0 + 400_000)).toMatchObject({ remainingMs: 0, label: '0:00', level: 'expired' })
  })
  it('an hour-long cache shows hours', () => {
    expect(cacheCountdown(t0, 3600000, t0).label).toBe('1:00:00')
    expect(cacheCountdown(t0, 3600000, t0 + 1000).label).toBe('59:59')
  })
})
