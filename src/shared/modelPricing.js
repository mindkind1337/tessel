// STUB: replaced by the pricing module on merge (claude/model-pricing).
// Only the two exports the job-cost display uses, with the same contract:
//   formatCost(usd, locale) -> '$0.42' / '0,42 $' ('< 0,01 $' under a cent, '—' for null)
//   estimateCost(...)       -> { usd, known }

export function formatCost(usd, locale = 'en-US') {
  if (usd === null || usd === undefined || !Number.isFinite(Number(usd))) return '—'
  const n = Number(usd)
  const fmt = (v) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' }).format(v)
  if (n > 0 && n < 0.01) return `< ${fmt(0.01)}`
  return fmt(n)
}

export function estimateCost() {
  return { usd: null, known: false }
}
