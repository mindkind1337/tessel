import { describe, it, expect } from 'vitest'
import { estimateCost, formatCost, pricingKey, PRICING_UPDATED, MODEL_PRICES, PRICING_SOURCES } from '../modelPricing.js'
import { CLAUDE_PRICING, pricingModel } from '../claudePricing.js'

const M = 1_000_000
const per = (model) => estimateCost({ model }).perMillion

describe('PRICING_UPDATED', () => {
  it('is a YYYY-MM-DD date', () => {
    expect(PRICING_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('names an official source per provider', () => {
    for (const url of Object.values(PRICING_SOURCES)) expect(url).toMatch(/^https:\/\//)
  })
})

describe('Claude prices (platform.claude.com pricing page)', () => {
  it.each([
    ['claude-fable-5-1', 10, 50, 0.25, 12.5],
    ['claude-fable-5', 10, 50, 1, 12.5],
    ['claude-mythos-5-1', 10, 50, 0.25, 12.5],
    ['claude-opus-5-5', 4, 20, 0.2, 5],
    ['claude-opus-5', 5, 25, 0.5, 6.25],
    ['claude-opus-4-8', 5, 25, 0.5, 6.25],
    ['claude-opus-4-7', 5, 25, 0.5, 6.25],
    ['claude-opus-4-6', 5, 25, 0.5, 6.25],
    ['claude-opus-4-5', 5, 25, 0.5, 6.25],
    ['claude-opus-4-1', 15, 75, 1.5, 18.75],
    ['claude-opus-4', 15, 75, 1.5, 18.75],
    ['claude-sonnet-5-5', 2, 10, 0.2, 2.5],
    ['claude-sonnet-5', 2, 10, 0.2, 2.5],
    ['claude-sonnet-4-6', 3, 15, 0.3, 3.75],
    ['claude-sonnet-4-5', 3, 15, 0.3, 3.75],
    ['claude-sonnet-4', 3, 15, 0.3, 3.75],
    ['claude-haiku-4-5', 1, 5, 0.1, 1.25],
    ['claude-haiku-3-5', 0.8, 4, 0.08, 1]
  ])('%s', (model, input, output, cacheRead, cacheWrite) => {
    expect(per(model)).toEqual({ input, output, cacheRead, cacheWrite })
  })

  it('uses the 5-minute cache write rate, not the 1-hour one', () => {
    expect(per('claude-opus-5-5').cacheWrite).toBe(CLAUDE_PRICING['claude-opus-5-5'].cacheWrite)
    expect(per('claude-opus-5-5').cacheWrite).not.toBe(CLAUDE_PRICING['claude-opus-5-5'].cacheWrite1h)
  })

  it('shares its table with claudePricing.js', () => {
    for (const key of Object.keys(CLAUDE_PRICING)) expect(MODEL_PRICES[key]).toBeTruthy()
  })

  it('1M variants price as the base model (Claude 4.6+: standard rates over 1M)', () => {
    expect(pricingKey('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(pricingKey('claude-sonnet-4-6[1M]')).toBe('claude-sonnet-4-6')
    const a = estimateCost({ model: 'claude-opus-5-5[1m]', inputTokens: 900_000 }).usd
    expect(a).toBeCloseTo(3.6, 10)
  })
})

describe('claudePricing.js additions', () => {
  it('knows Sonnet 5.5 and Mythos apart from their majors', () => {
    expect(pricingModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(pricingModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(pricingModel('claude-mythos-5-1')).toBe('claude-mythos-5-1')
    expect(pricingModel('claude-mythos-5')).toBe('claude-mythos-5')
  })
})

describe('OpenAI prices (developers.openai.com pricing page)', () => {
  it.each([
    ['gpt-6-astra', 10, 50, 1, 12.5],
    ['gpt-6.1-sol', 2, 10, 0.1, 2.5],
    ['gpt-6-sol', 2, 10, 0.2, 2.5],
    ['gpt-6-luna', 0.1, 0.5, 0.01, 0.125],
    ['gpt-5.6-sol', 4, 20, 0.4, 5],
    ['gpt-5.6-terra', 2, 12, 0.2, 2.5],
    ['gpt-5.6-luna', 0.2, 1.2, 0.02, 0.25],
    ['gpt-5.5', 5, 30, 0.5, 5],
    ['gpt-5.4', 2.5, 15, 0.25, 2.5],
    ['gpt-5.4-mini', 0.75, 4.5, 0.075, 0.75],
    ['gpt-5.4-nano', 0.2, 1.25, 0.02, 0.2],
    ['gpt-5.3-codex', 1.75, 14, 0.175, 1.75],
    ['gpt-5.2', 1.75, 14, 0.175, 1.75],
    ['gpt-5.1', 1.25, 10, 0.125, 1.25],
    ['gpt-5', 1.25, 10, 0.125, 1.25],
    ['gpt-5-mini', 0.25, 2, 0.025, 0.25],
    ['gpt-5-nano', 0.05, 0.4, 0.005, 0.05],
    ['o3', 2, 8, 0.5, 2],
    ['o4-mini', 1.1, 4.4, 0.275, 1.1],
    ['gpt-4.1', 2, 8, 0.5, 2],
    ['gpt-4o', 2.5, 10, 1.25, 2.5]
  ])('%s', (model, input, output, cacheRead, cacheWrite) => {
    expect(per(model)).toEqual({ input, output, cacheRead, cacheWrite })
  })

  it('pro models have no cached discount: cache reads at the input rate', () => {
    expect(per('gpt-5.5-pro')).toEqual({ input: 30, output: 180, cacheRead: 30, cacheWrite: 30 })
    expect(per('gpt-5.4-pro').cacheRead).toBe(30)
  })

  it('a cache write on a model without a cache-write price is ordinary input', () => {
    expect(per('gpt-5.5').cacheWrite).toBe(per('gpt-5.5').input)
  })
})

describe('Gemini prices (ai.google.dev pricing page)', () => {
  it.each([
    ['gemini-3.5-flash', 1.5, 9, 0.15],
    ['gemini-3.5-flash-lite', 0.3, 2.5, 0.03],
    ['gemini-3.1-flash-lite', 0.25, 1.5, 0.025],
    ['gemini-3.1-pro-preview', 2, 12, 0.2],
    ['gemini-3-flash-preview', 0.5, 3, 0.05],
    ['gemini-2.5-pro', 1.25, 10, 0.125],
    ['gemini-2.5-flash', 0.3, 2.5, 0.03],
    ['gemini-2.5-flash-lite', 0.1, 0.4, 0.01]
  ])('%s', (model, input, output, cacheRead) => {
    expect(per(model)).toEqual({ input, output, cacheRead, cacheWrite: input })
  })

  it('Flash 3.6 / 3.7 / 3.8 rise on 2027-01-01', () => {
    for (const model of ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash']) {
      expect(estimateCost({ model, at: '2026-12-31' }).perMillion).toEqual({ input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 })
      expect(estimateCost({ model, at: '2027-01-01' }).perMillion).toEqual({ input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.5 })
    }
    expect(estimateCost({ model: 'gemini-3.8-flash', at: new Date('2027-02-01T00:00:00Z') }).perMillion.input).toBe(1.5)
    expect(estimateCost({ model: 'gemini-3.8-flash', at: Date.UTC(2026, 9, 3) }).perMillion.input).toBe(0.75)
  })

  it('an id without -preview finds the preview price', () => {
    expect(pricingKey('gemini-3.1-pro')).toBe('gemini-3.1-pro-preview')
    expect(pricingKey('models/gemini-2.5-pro')).toBe('gemini-2.5-pro')
  })
})

describe('Grok prices (docs.x.ai)', () => {
  it.each([
    ['grok-4.7', 2, 6, 0.5],
    ['grok-4.6', 2, 6, 0.5],
    ['grok-4.5', 2, 6, 0.3],
    ['grok-4.3', 1.25, 2.5, 0.2],
    ['grok-4.20-0309-reasoning', 1.25, 2.5, 0.2],
    ['grok-4.20-multi-agent-0309', 1.25, 2.5, 0.2],
    ['grok-build-0.1', 1, 2, 0.2],
    ['grok-build', 1, 2, 0.2]
  ])('%s', (model, input, output, cacheRead) => {
    expect(per(model)).toEqual({ input, output, cacheRead, cacheWrite: input })
  })
})

describe('Kimi prices (platform.kimi.ai)', () => {
  it.each([
    ['kimi-k3', 3, 15, 0.3],
    ['kimi-k2.7-code', 0.95, 4, 0.19],
    ['kimi-k2.7-code-highspeed', 1.9, 8, 0.38],
    ['kimi-k2.6', 0.95, 4, 0.16]
  ])('%s', (model, input, output, cacheRead) => {
    expect(per(model)).toEqual({ input, output, cacheRead, cacheWrite: input })
  })
})

describe('name normalisation', () => {
  it.each([
    ['claude-opus-5-5', 'claude-opus-5-5'],
    ['Opus 5.5', 'claude-opus-5-5'],
    ['Claude Opus 5.5', 'claude-opus-5-5'],
    ['  CLAUDE-OPUS-5-5  ', 'claude-opus-5-5'],
    ['anthropic/claude-sonnet-5', 'claude-sonnet-5'],
    ['anthropic:claude-sonnet-5', 'claude-sonnet-5'],
    ['Sonnet 5.5', 'claude-sonnet-5-5'],
    ['claude-sonnet-5-5', 'claude-sonnet-5-5'],
    ['Fable 5.1', 'claude-fable-5-1'],
    ['claude-fable-5', 'claude-fable-5'],
    ['Haiku 4.5', 'claude-haiku-4-5'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    ['claude-opus-4-20250514', 'claude-opus-4'],
    ['claude-opus-4@20250514', 'claude-opus-4'],
    ['claude-3-5-haiku-20241022', 'claude-haiku-3-5'],
    ['claude-opus-5-thinking-max', 'claude-opus-5'],
    ['claude-4.6-opus-high-thinking', 'claude-opus-4-6'],
    ['claude-opus-4.8', 'claude-opus-4-8'],
    ['Opus 5.5 (1M)', 'claude-opus-5-5'],
    ['gpt-6-astra', 'gpt-6-astra'],
    ['GPT-6 Astra', 'gpt-6-astra'],
    ['openai/gpt-6-astra', 'gpt-6-astra'],
    ['gpt-6-astra-high', 'gpt-6-astra'],
    ['gpt-6-astra (xhigh)', 'gpt-6-astra'],
    ['GPT-5.3 Codex', 'gpt-5.3-codex'],
    ['gpt-5.3-codex-high-fast', 'gpt-5.3-codex'],
    ['gpt-5.6-luna-medium', 'gpt-5.6-luna'],
    ['gpt-5.6-sol-xhigh-fast', 'gpt-5.6-sol'],
    ['GPT-5.4 mini', 'gpt-5.4-mini'],
    ['Gemini 2.5 Pro', 'gemini-2.5-pro'],
    ['moonshotai/kimi-k2.7-code', 'kimi-k2.7-code']
  ])('%s -> %s', (name, key) => {
    expect(pricingKey(name)).toBe(key)
  })

  it.each([
    [''],
    [null],
    [undefined],
    ['opus'],
    ['opus[1m]'],
    ['claude-opus-9'],
    ['gpt-6-mini'],
    ['gpt-7'],
    ['gpt-5.6'],
    ['gpt-5.5-codex'],
    ['gpt-5.2-codex'],
    ['gpt-5.3-codex-spark'],
    ['gemini-3-pro-preview'],
    ['grok-5'],
    ['grok-lite'],
    ['deepseek/deepseek-v4-flash'],
    ['qwen3:8b'],
    ['auto'],
    ['composer-2']
  ])('%s is unknown', (name) => {
    expect(pricingKey(name)).toBe(null)
    expect(estimateCost({ model: name, inputTokens: 1000 })).toEqual({ usd: null, known: false, perMillion: null })
  })
})

describe('estimateCost', () => {
  it('adds the four token kinds at their rates', () => {
    const r = estimateCost({ provider: 'claude', model: 'claude-opus-5-5', inputTokens: M, outputTokens: M, cacheReadTokens: M, cacheWriteTokens: M })
    expect(r.known).toBe(true)
    expect(r.usd).toBeCloseTo(4 + 20 + 0.2 + 5, 10)
  })

  it('1-hour cache writes (part of cacheWriteTokens) at the 1-hour rate (Claude Code writes them)', () => {
    const r = estimateCost({ model: 'claude-haiku-4-5-20251001', inputTokens: 18, outputTokens: 398, cacheReadTokens: 69935, cacheWriteTokens: 12576, cacheWrite1hTokens: 12576 })
    expect(r.usd).toBeCloseTo((18 * 1 + 398 * 5 + 69935 * 0.1 + 12576 * 2) / M, 12)
    const mixed = estimateCost({ model: 'claude-opus-5-5', cacheWriteTokens: M, cacheWrite1hTokens: M / 4 })
    expect(mixed.usd).toBeCloseTo(0.75 * 5 + 0.25 * 8, 10)
    // Never more 1-hour tokens than writes; other providers: their write rate.
    expect(estimateCost({ model: 'claude-opus-5-5', cacheWriteTokens: M, cacheWrite1hTokens: 3 * M }).usd).toBeCloseTo(8, 10)
    expect(estimateCost({ model: 'gpt-6-sol', cacheWriteTokens: M, cacheWrite1hTokens: M }).usd).toBeCloseTo(2.5, 10)
  })

  it('bills cached tokens once (inputTokens is the non-cached part)', () => {
    const r = estimateCost({ provider: 'codex', model: 'gpt-6-astra', inputTokens: 200_000, cacheReadTokens: 800_000, outputTokens: 10_000 })
    expect(r.usd).toBeCloseTo((200_000 * 10 + 800_000 * 1 + 10_000 * 50) / M, 10)
  })

  it('defaults every count to 0', () => {
    expect(estimateCost({ model: 'claude-haiku-4-5' })).toEqual({
      usd: 0,
      known: true,
      perMillion: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
    })
  })

  it('ignores negative, NaN and non-number counts', () => {
    const r = estimateCost({ model: 'claude-haiku-4-5', inputTokens: -5, outputTokens: NaN, cacheReadTokens: 'x', cacheWriteTokens: Infinity })
    expect(r.usd).toBe(0)
  })

  it('accepts numeric strings', () => {
    expect(estimateCost({ model: 'claude-haiku-4-5', outputTokens: '1000000' }).usd).toBe(5)
  })

  it('works without an argument', () => {
    expect(estimateCost()).toEqual({ usd: null, known: false, perMillion: null })
  })

  it('the model decides, not the provider', () => {
    expect(estimateCost({ provider: 'cursor', model: 'claude-opus-5-5', outputTokens: M }).usd).toBe(20)
    expect(estimateCost({ provider: 'opencode', model: 'openai/gpt-5.5', outputTokens: M }).usd).toBe(30)
  })

  it('a recorded cost wins (OpenCode)', () => {
    expect(estimateCost({ provider: 'opencode', model: 'claude-opus-5-5', inputTokens: M, recordedUsd: 1.23 })).toEqual({
      usd: 1.23,
      known: true,
      perMillion: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
    })
    expect(estimateCost({ model: 'some-local-model', recordedUsd: 0 })).toEqual({ usd: 0, known: true, perMillion: null })
  })

  it('ignores an unusable recorded cost', () => {
    expect(estimateCost({ model: 'claude-haiku-4-5', outputTokens: M, recordedUsd: NaN }).usd).toBe(5)
    expect(estimateCost({ model: 'claude-haiku-4-5', outputTokens: M, recordedUsd: -1 }).usd).toBe(5)
    expect(estimateCost({ model: 'x', recordedUsd: null }).known).toBe(false)
  })

  it('returns a fresh perMillion object (callers cannot change the table)', () => {
    const r = estimateCost({ model: 'claude-opus-5-5' })
    r.perMillion.input = 999
    expect(per('claude-opus-5-5').input).toBe(4)
  })
})

describe('formatCost', () => {
  it('formats French and English', () => {
    expect(formatCost(0.42, 'fr')).toBe('0,42 $')
    expect(formatCost(0.42, 'en')).toBe('$0.42')
    expect(formatCost(0.42, 'fr-FR')).toBe('0,42 $')
    expect(formatCost(0.42, 'en-US')).toBe('$0.42')
  })

  it('rounds to cents', () => {
    expect(formatCost(1.234, 'en')).toBe('$1.23')
    expect(formatCost(0.999, 'en')).toBe('$1.00')
    expect(formatCost(12.5, 'fr')).toBe('12,50 $')
  })

  it('groups thousands with plain spaces in French', () => {
    expect(formatCost(1234.5, 'en')).toBe('$1,234.50')
    expect(formatCost(1234.5, 'fr')).toBe('1 234,50 $')
  })

  it('shows under one cent as < 0.01', () => {
    expect(formatCost(0.004, 'fr')).toBe('< 0,01 $')
    expect(formatCost(0.004, 'en')).toBe('< $0.01')
    expect(formatCost(0.0099, 'en')).toBe('< $0.01')
    expect(formatCost(0.01, 'en')).toBe('$0.01')
  })

  it('shows zero as zero', () => {
    expect(formatCost(0, 'en')).toBe('$0.00')
    expect(formatCost(0, 'fr')).toBe('0,00 $')
  })

  it('shows a dash for no value', () => {
    expect(formatCost(null, 'fr')).toBe('—')
    expect(formatCost(undefined, 'en')).toBe('—')
    expect(formatCost(NaN, 'en')).toBe('—')
    expect(formatCost('0.42', 'en')).toBe('—')
  })

  it('falls back to English for a missing or bad locale', () => {
    expect(formatCost(0.42)).toBe('$0.42')
    expect(formatCost(0.42, 'not a locale!!')).toBe('$0.42')
  })

  it('formats an estimate end to end', () => {
    const { usd } = estimateCost({ model: 'Opus 5.5', inputTokens: 50_000, outputTokens: 15_000 })
    expect(formatCost(usd, 'fr')).toBe('0,50 $')
    expect(formatCost(estimateCost({ model: 'gpt-7' }).usd, 'en')).toBe('—')
  })
})
