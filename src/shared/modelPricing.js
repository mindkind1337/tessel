// Estimated cost of an agent job, in US dollars, at the providers' public
// per-million-token API list prices.
//
// It is an API-equivalent estimate: a subscription (Claude Pro / Max,
// ChatGPT Plus / Pro, Gemini, Kimi or Grok plans...) is not billed per token.
// The figure says what the same tokens would have cost on the pay-as-you-go
// API, nothing more.
//
// Structure after Orca's claude-model-pricing.ts and codex-model-pricing.ts
// (MIT, Copyright (c) 2026 Lovecast Inc.); every price below was re-read from
// the official page named next to it on PRICING_UPDATED, and models a page
// does not list are left unknown (usd null) rather than guessed.
//
// Token convention (shared with the token counters):
// - inputTokens: NON-cached input tokens only. cacheReadTokens and
//   cacheWriteTokens are separate and never included in inputTokens; a caller
//   whose raw counter includes cached tokens (Codex, Gemini) subtracts them
//   first.
// - cacheWriteTokens: Claude's 5-minute cache write rate. Providers that do not
//   bill cache writes separately (Gemini, Grok, Kimi, older OpenAI models)
//   charge those tokens as ordinary input, so their cacheWrite rate is the
//   input rate.
// - A model without a cached-input discount (gpt-5.x-pro) bills cache reads at
//   the input rate.
// - Standard short-context rates only: a per-job aggregate has no per-request
//   prompt length. Not counted: long-context tiers (OpenAI > 272K, Gemini
//   > 200K, Grok >= 200K prompts; Claude 4.6 and later, including the
//   "[1m]" variants, keep standard rates over the full 1M window anyway),
//   Claude fast mode and Cursor "-fast" ids, batch discounts, data residency
//   multipliers, Gemini cache storage per hour, web search and other
//   per-call tool fees.
// - Claude's 1-hour cache writes (Claude Code makes most of its writes so):
//   a caller that knows how many of the cacheWriteTokens were 1-hour writes
//   passes them as cacheWrite1hTokens, priced at the 1-hour rate.

import { CLAUDE_PRICING } from './claudePricing.js'
import { numberFormat } from './intlCache.js'

export const PRICING_UPDATED = '2026-10-03'

const SOURCES = {
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  openai: 'https://developers.openai.com/api/docs/pricing',
  google: 'https://ai.google.dev/gemini-api/docs/pricing',
  xai: 'https://docs.x.ai/docs/models',
  kimi: 'https://platform.kimi.ai/docs/pricing/chat'
}
export const PRICING_SOURCES = Object.freeze({ ...SOURCES })

// [input, output, cacheRead, cacheWrite] per million tokens.
const r = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite })

// Claude: claudePricing.js's table (also used by the Claude usage report),
// standard rates and the 5-minute cache write.
const CLAUDE = Object.fromEntries(
  Object.entries(CLAUDE_PRICING).map(([k, p]) => [k, { ...r(p.input, p.output, p.cacheRead, p.cacheWrite), cacheWrite1h: p.cacheWrite1h }])
)

// OpenAI lists cache writes only for GPT-6 and GPT-5.6 (1.25x input); for the
// others a cache write is ordinary input. "—" for cached input (the pro
// models): no discount.
const OPENAI = {
  'gpt-6-astra': r(10, 50, 1, 12.5),
  'gpt-6.1-sol': r(2, 10, 0.1, 2.5),
  'gpt-6-sol': r(2, 10, 0.2, 2.5),
  'gpt-6-luna': r(0.1, 0.5, 0.01, 0.125),
  'gpt-5.6-sol': r(4, 20, 0.4, 5),
  'gpt-5.6-terra': r(2, 12, 0.2, 2.5),
  'gpt-5.6-luna': r(0.2, 1.2, 0.02, 0.25),
  'gpt-5.5': r(5, 30, 0.5, 5),
  'gpt-5.5-pro': r(30, 180, 30, 30),
  'gpt-5.4': r(2.5, 15, 0.25, 2.5),
  'gpt-5.4-mini': r(0.75, 4.5, 0.075, 0.75),
  'gpt-5.4-nano': r(0.2, 1.25, 0.02, 0.2),
  'gpt-5.4-pro': r(30, 180, 30, 30),
  'gpt-5.3-codex': r(1.75, 14, 0.175, 1.75),
  'gpt-5.2': r(1.75, 14, 0.175, 1.75),
  'gpt-5.1': r(1.25, 10, 0.125, 1.25),
  'gpt-5': r(1.25, 10, 0.125, 1.25),
  'gpt-5-mini': r(0.25, 2, 0.025, 0.25),
  'gpt-5-nano': r(0.05, 0.4, 0.005, 0.05),
  o3: r(2, 8, 0.5, 2),
  'o4-mini': r(1.1, 4.4, 0.275, 1.1),
  'gpt-4.1': r(2, 8, 0.5, 2),
  'gpt-4.1-mini': r(0.4, 1.6, 0.1, 0.4),
  'gpt-4o': r(2.5, 10, 1.25, 2.5),
  'gpt-4o-mini': r(0.15, 0.6, 0.075, 0.15)
}

// Gemini: cacheRead = "context caching" (storage per hour not counted); a
// cache write is ordinary input. Text rates; <= 200K-prompt rates for Pro.
// Some Flash models are cheaper until a date: { ...rates, until, later }.
const GEMINI_FLASH_PROMO = { ...r(0.75, 3.75, 0.075, 0.75), until: '2026-12-31', later: r(1.5, 7.5, 0.15, 1.5) }
const GEMINI = {
  'gemini-3.8-flash': GEMINI_FLASH_PROMO,
  'gemini-3.7-flash': GEMINI_FLASH_PROMO,
  'gemini-3.6-flash': GEMINI_FLASH_PROMO,
  'gemini-3.5-flash': r(1.5, 9, 0.15, 1.5),
  'gemini-3.5-flash-lite': r(0.3, 2.5, 0.03, 0.3),
  'gemini-3.1-flash-lite': r(0.25, 1.5, 0.025, 0.25),
  'gemini-3.1-pro-preview': r(2, 12, 0.2, 2),
  'gemini-3-flash-preview': r(0.5, 3, 0.05, 0.5),
  'gemini-2.5-pro': r(1.25, 10, 0.125, 1.25),
  'gemini-2.5-flash': r(0.3, 2.5, 0.03, 0.3),
  'gemini-2.5-flash-lite': r(0.1, 0.4, 0.01, 0.1)
}

// xAI: < 200K-prompt rates; a cache write is ordinary input.
const GROK = {
  'grok-4.7': r(2, 6, 0.5, 2),
  'grok-4.6': r(2, 6, 0.5, 2),
  'grok-4.5': r(2, 6, 0.3, 2),
  'grok-4.3': r(1.25, 2.5, 0.2, 1.25),
  // grok-4.20-0309-reasoning, -non-reasoning and -multi-agent-0309.
  'grok-4.20': r(1.25, 2.5, 0.2, 1.25),
  'grok-build-0.1': r(1, 2, 0.2, 1)
}

// Kimi: "cache hit" = cacheRead, "cache miss" = input (and cache write).
const KIMI = {
  'kimi-k3': r(3, 15, 0.3, 3),
  'kimi-k2.7-code-highspeed': r(1.9, 8, 0.38, 1.9),
  'kimi-k2.7-code': r(0.95, 4, 0.19, 0.95),
  'kimi-k2.6': r(0.95, 4, 0.16, 0.95)
}

export const MODEL_PRICES = Object.freeze({ ...CLAUDE, ...OPENAI, ...GEMINI, ...GROK, ...KIMI })

// Effort / speed / mode words agents append to an id ("gpt-6-astra-high",
// "claude-opus-5-thinking-max", "gpt-5.3-codex-high-fast").
const TIER_SUFFIX = /-(?:none|minimal|low|medium|high|xhigh|extra-high|max|ultra|auto|fast|thinking)$/

// Lower case, provider prefix and notes off, spaces as dashes:
// "Claude Opus 5.5" -> "claude-opus-5.5", "openai/GPT-6 Astra (high)" -> "gpt-6-astra-high".
function tidy(model) {
  let s = String(model || '')
    .replace(/[​-‍⁠﻿]/g, '')
    .toLowerCase()
    .trim()
  s = s.replace(/^.*\//, '') // anthropic/…, openai/…, models/…, moonshotai/…
  s = s.replace(/^[a-z]+:(?=[a-z])/, '') // anthropic:claude-…
  s = s.replace(/\[1m\]/g, '').replace(/\(1m\)/g, '')
  s = s.replace(/[()]/g, ' ')
  s = s.replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  s = s.replace(/@\d{8}$/, '').replace(/-\d{8}$/, '') // dated snapshots
  return s
}

function stripTiers(s) {
  let out = s
  for (let i = 0; i < 4 && TIER_SUFFIX.test(out); i++) out = out.replace(TIER_SUFFIX, '')
  return out
}

const CLAUDE_FAMILY = '(fable|mythos|opus|sonnet|haiku)'

function claudeKey(s) {
  // "claude-opus-5-5", "opus-5.5", "claude-opus-4-20250514", "opus-4-5-thinking-high"
  let m = new RegExp(`(?:^|-)${CLAUDE_FAMILY}-(\\d{1,2})(?:[-.](\\d))?(?!\\d)`).exec(s)
  // Version first: "claude-3-5-haiku", Cursor's "claude-4.6-opus-high-thinking"
  if (!m) {
    const v = new RegExp(`(?:^|-)(\\d{1,2})(?:[-.](\\d))?-${CLAUDE_FAMILY}(?:-|$)`).exec(s)
    if (v) m = [v[0], v[3], v[1], v[2]]
  }
  if (!m) return null
  const key = `claude-${m[1]}-${m[2]}${m[3] ? '-' + m[3] : ''}`
  return CLAUDE[key] ? key : null
}

function tableKey(table, s) {
  const base = stripTiers(s)
  for (const k of [s, base, `${base}-preview`]) if (Object.prototype.hasOwnProperty.call(table, k)) return k
  return null
}

function grokKey(s) {
  const base = stripTiers(s)
  if (/^grok-4\.20(?:-|$)/.test(base)) return 'grok-4.20'
  // xAI lists the Grok Build model as grok-build-0.1; the CLI says "grok-build".
  if (base === 'grok-build' || /^grok-build-0\.1(?:-|$)/.test(base)) return 'grok-build-0.1'
  return tableKey(GROK, base)
}

// A model id or display name -> a key of MODEL_PRICES, or null when unknown.
// provider is only a hint: the model name decides.
export function pricingKey(model) {
  const s = tidy(model)
  if (!s) return null
  if (/(^|-)(fable|mythos|opus|sonnet|haiku)(-|$)/.test(s)) return claudeKey(s)
  if (/^(gpt-|o\d)/.test(s)) return tableKey(OPENAI, s)
  if (s.startsWith('gemini-')) return tableKey(GEMINI, s)
  if (s.startsWith('grok-')) return grokKey(s)
  if (s.startsWith('kimi-')) return tableKey(KIMI, s)
  return null
}

function toDay(at) {
  if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at)) return at.slice(0, 10)
  const d = at instanceof Date ? at : new Date(Number.isFinite(at) ? at : Date.now())
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10)
}

// The rates of a model on a day (some prices change on a set date).
function ratesFor(key, at) {
  const p = MODEL_PRICES[key]
  const use = p.until && toDay(at) > p.until ? p.later : p
  return { input: use.input, output: use.output, cacheRead: use.cacheRead, cacheWrite: use.cacheWrite }
}

const count = (n) => {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? v : 0
}

// -> { usd: number|null, known: boolean, perMillion: { input, output, cacheRead, cacheWrite } | null }
// Optional extras: at, when the tokens were used (Date, ms or 'YYYY-MM-DD';
// today by default); recordedUsd, a cost the agent recorded itself (OpenCode),
// which wins over the estimate; cacheWrite1hTokens, how many of the
// cacheWriteTokens were 1-hour writes (Claude's 1-hour rate; the ordinary
// write rate for a model without one).
export function estimateCost({ provider, model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, cacheWrite1hTokens = 0, at, recordedUsd } = {}) {
  void provider
  const key = pricingKey(model)
  const p = key ? ratesFor(key, at) : null
  if (typeof recordedUsd === 'number' && Number.isFinite(recordedUsd) && recordedUsd >= 0) {
    return { usd: recordedUsd, known: true, perMillion: p }
  }
  if (!p) return { usd: null, known: false, perMillion: null }
  const writes = count(cacheWriteTokens)
  const writes1h = Math.min(writes, count(cacheWrite1hTokens))
  const rate1h = MODEL_PRICES[key].cacheWrite1h ?? p.cacheWrite
  const usd =
    (count(inputTokens) * p.input +
      count(outputTokens) * p.output +
      count(cacheReadTokens) * p.cacheRead +
      (writes - writes1h) * p.cacheWrite +
      writes1h * rate1h) /
    1_000_000
  return { usd, known: true, perMillion: p }
}

// '0,42 $' (fr) / '$0.42' (en); '< 0,01 $' / '< $0.01' under one cent; '—' when null.
// Plain spaces (Intl's non-breaking ones replaced) so the text is predictable.
export function formatCost(usd, locale) {
  if (usd === null || usd === undefined || typeof usd !== 'number' || !Number.isFinite(usd)) return '—'
  let fmt
  try {
    fmt = numberFormat(locale || 'en', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 })
  } catch {
    fmt = numberFormat('en', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  const text = (n) => fmt.format(n).replace(/[  ]/g, ' ')
  if (usd > 0 && usd < 0.01) return `< ${text(0.01)}`
  return text(usd)
}
