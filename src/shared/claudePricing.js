// Estimated cost of Claude Code turns, in US dollars at API list prices (per
// million tokens). A subscription is not billed this way: it is what the same
// tokens would cost on the API. Prices and the model-name matching come from
// Orca (github.com/stablyai/orca, src/main/claude-usage/claude-model-pricing.ts,
// MIT, Copyright (c) 2026 Lovecast Inc.), rewritten here in JavaScript.

const LONG = { thresholdTokens: 200_000, inputAbove: 6, outputAbove: 22.5, cacheReadAbove: 0.6, cacheWriteAbove: 7.5, cacheWrite1hAbove: 12 }

export const CLAUDE_PRICING = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, cacheWrite1h: 20 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, ...LONG },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, ...LONG },
  'claude-sonnet-3-7': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-sonnet-3-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1, cacheWrite1h: 1.6 },
  'claude-haiku-3': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3, cacheWrite1h: 0.5 }
}

// A model id as Claude Code writes it -> a key of CLAUDE_PRICING, or null.
export function pricingModel(model) {
  if (!model) return null
  const lower = String(model).toLowerCase().trim().replace(/^anthropic[/:]/, '')
  const n = lower.replace(/\./g, '-').replace(/-thinking$/, '')
  // Point releases before their major (whose pattern also accepts -5-1/-5-5).
  const rules = [
    [/fable-5-1(?:$|[^0-9a-z])/, 'claude-fable-5-1'],
    [/fable-5(?:$|[^0-9])/, 'claude-fable-5'],
    [/opus-5-5(?:$|[^0-9a-z])/, 'claude-opus-5-5'],
    [/opus-5(?:$|[^0-9])/, 'claude-opus-5'],
    [/opus-4-8(?:$|[^0-9])/, 'claude-opus-4-8'],
    [/opus-4-7(?:$|[^0-9])/, 'claude-opus-4-7'],
    [/opus-4-6(?:$|[^0-9])/, 'claude-opus-4-6'],
    [/opus-4-5(?:$|[^0-9])/, 'claude-opus-4-5'],
    [/opus-4-1(?:$|[^0-9])/, 'claude-opus-4-1'],
    [/opus-4(?:$|-20\d{6}$|@20\d{6}$)/, 'claude-opus-4'],
    [/opus-4/, 'claude-opus-4-8'], // a newer Opus 4 point release: today's Opus price
    [/sonnet-5(?:$|[^0-9])/, 'claude-sonnet-5'],
    [/sonnet-4-6(?:$|[^0-9])/, 'claude-sonnet-4-6'],
    [/sonnet-4-5(?:$|[^0-9])/, 'claude-sonnet-4-5'],
    [/sonnet-4/, 'claude-sonnet-4-6'],
    [/sonnet-3-7|3-7-sonnet/, 'claude-sonnet-3-7'],
    [/sonnet-3-5|3-5-sonnet/, 'claude-sonnet-3-5'],
    [/haiku-4-5/, 'claude-haiku-4-5'],
    [/haiku-3-5|3-5-haiku/, 'claude-haiku-3-5'],
    [/haiku-3/, 'claude-haiku-3']
  ]
  for (const [re, key] of rules) if (re.test(n)) return key
  return null
}

function tiered(tokens, base, above, threshold) {
  if (threshold === undefined || above === undefined) return tokens * base
  return Math.min(tokens, threshold) * base + Math.max(tokens - threshold, 0) * above
}

// One turn's cost in $ (null for a model with no known price).
// cacheWrite: every cache write; cacheWrite1h: its 1-hour part (billed 2x).
export function turnCostUsd(model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cacheWrite1h = 0 } = {}) {
  const key = pricingModel(model)
  if (!key) return null
  const p = CLAUDE_PRICING[key]
  const w1h = Math.min(Math.max(cacheWrite1h, 0), cacheWrite)
  // Both cache TTLs share one long-context allowance.
  const share = cacheWrite > 0 ? w1h / cacheWrite : 0
  const t = p.thresholdTokens
  return (
    (tiered(input, p.input, p.inputAbove, t) +
      tiered(output, p.output, p.outputAbove, t) +
      tiered(cacheRead, p.cacheRead, p.cacheReadAbove, t) +
      tiered(cacheWrite - w1h, p.cacheWrite, p.cacheWriteAbove, t === undefined ? undefined : t * (1 - share)) +
      tiered(w1h, p.cacheWrite1h, p.cacheWrite1hAbove, t === undefined ? undefined : t * share)) /
    1_000_000
  )
}
