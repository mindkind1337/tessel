// STUB (job-cost-main branch): a placeholder with the agreed exports so the
// job cost tracking (src/main/jobCost.js) builds and runs on its own. The real
// src/shared/modelPricing.js, written on another branch, REPLACES this file
// whole at the merge: keep theirs, drop this one.
//
// estimateCost({ provider, model, inputTokens, outputTokens, cacheReadTokens,
//   cacheWriteTokens }) -> { usd: number | null, known: boolean, perMillion }
// inputTokens: the input NOT read from the cache; cache reads and writes apart.
// Here only Claude models are priced (src/shared/claudePricing.js).
import { CLAUDE_PRICING, pricingModel, turnCostUsd } from './claudePricing'

export function estimateCost({ model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 } = {}) {
  const key = pricingModel(model)
  if (!key) return { usd: null, known: false, perMillion: null }
  const usd = turnCostUsd(model, { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens })
  const p = CLAUDE_PRICING[key]
  return { usd, known: usd !== null, perMillion: { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite } }
}
