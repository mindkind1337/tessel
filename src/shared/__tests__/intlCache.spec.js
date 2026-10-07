// Intl formatters kept per locale and options (shared/intlCache.js), and the
// formatters of costs, tokens and plurals that use them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { numberFormat, dateTimeFormat, pluralRules, clearIntlCache } from '../intlCache'
import { formatCost } from '../modelPricing'
import { formatTokens } from '../../renderer/src/jobCost'

let made
let saved
beforeEach(() => {
  clearIntlCache()
  made = { NumberFormat: 0, DateTimeFormat: 0, PluralRules: 0 }
  saved = {}
  for (const k of Object.keys(made)) {
    saved[k] = Intl[k]
    Intl[k] = new Proxy(saved[k], { construct: (T, args) => (made[k]++, new T(...args)) })
  }
})
afterEach(() => {
  for (const k of Object.keys(saved)) Intl[k] = saved[k]
})

describe('intl formatters kept', () => {
  it('one formatter per locale and options', () => {
    const a = numberFormat('fr-CA', { maximumFractionDigits: 1 })
    expect(numberFormat('fr-CA', { maximumFractionDigits: 1 })).toBe(a)
    expect(numberFormat('en-US', { maximumFractionDigits: 1 })).not.toBe(a)
    expect(numberFormat('fr-CA', { maximumFractionDigits: 0 })).not.toBe(a)
    expect(dateTimeFormat('fr-CA', { timeStyle: 'short' })).toBe(dateTimeFormat('fr-CA', { timeStyle: 'short' }))
    expect(pluralRules('fr')).toBe(pluralRules('fr'))
    expect(made).toEqual({ NumberFormat: 3, DateTimeFormat: 1, PluralRules: 1 })
  })

  it('a locale Intl refuses throws and is not kept', () => {
    expect(() => numberFormat('not a locale!!')).toThrow()
    expect(() => numberFormat('not a locale!!')).toThrow()
  })

  it('a thousand costs and token counts create a handful of formatters, same text', () => {
    const texts = new Set()
    for (let i = 0; i < 1000; i++) {
      texts.add(formatCost(0.53, 'fr-CA'))
      formatTokens(1000 + i, 'fr-CA')
      formatTokens(2_500_000, 'fr-CA')
    }
    expect([...texts]).toEqual(['0,53 $'])
    expect(formatTokens(1000, 'fr-CA')).toBe('1k')
    expect(formatTokens(12_400, 'fr-CA')).toBe('12,4k')
    expect(made.NumberFormat).toBeLessThanOrEqual(4)
  })
})
