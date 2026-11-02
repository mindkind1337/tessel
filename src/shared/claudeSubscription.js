// A Claude account's subscription as Anthropic reports it now (its OAuth
// profile, GET /api/oauth/profile), not as the login file Claude Code wrote
// at sign-in: that file is never updated when a subscription ends, so an
// account whose Max was canceled still says "max" there.
//
// Only these fields are ever kept (main's cache, the window's copy, a host's
// answer): nothing that names a person, and never a link to an invoice or a
// payment page. Each one is checked for its shape; anything else is dropped.
export const SUBSCRIPTION_FIELDS = Object.freeze([
  'plan_display_name',
  'organization_type',
  'rate_limit_tier',
  'seat_tier',
  'billing_type',
  'subscription_status',
  'has_claude_max',
  'has_claude_pro',
  'claude_code_trial_ends_at'
])
const WORDS = ['organization_type', 'rate_limit_tier', 'seat_tier', 'billing_type', 'subscription_status']
const FLAGS = ['has_claude_max', 'has_claude_pro']

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
// A service's own short name for a type, a tier or a status ("claude_max",
// "default_claude_max_20x", "past_due"), lower case.
function word(value) {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{0,59}$/.test(v) ? v : null
}
const flag = (value) => (typeof value === 'boolean' ? value : null)
// The plan's name as the service words it for people ("Ultra"): a short plain
// name, in any language, kept with its capitals.
export function planDisplayName(value) {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return /^\p{L}[\p{L}\p{N} +._-]{0,39}$/u.test(v) ? v : null
}
// A date (ISO text, or ms since 1970) -> ms, or null.
function when(value) {
  const ms = typeof value === 'number' ? value : typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? ms : null
}

// The profile's answer -> the kept fields, or null when it names none of
// them (not a profile). The plan's fields are the organization's, the two
// has_claude_* flags the account's; a newer answer that moves one is read
// where it is.
export function subscriptionFields(profile) {
  if (!object(profile)) return null
  const org = object(profile.organization) ? profile.organization : {}
  const account = object(profile.account) ? profile.account : {}
  const pick = (key) => (org[key] !== undefined ? org[key] : account[key] !== undefined ? account[key] : profile[key])
  const out = {}
  for (const key of WORDS) out[key] = word(pick(key))
  for (const key of FLAGS) out[key] = flag(pick(key))
  out.claude_code_trial_ends_at = when(pick('claude_code_trial_ends_at'))
  out.plan_display_name = planDisplayName(pick('plan_display_name'))
  if (!out.organization_type && !out.subscription_status && out.has_claude_max === null && out.has_claude_pro === null) return null
  return out
}

// A kept copy (the cache file, an IPC answer, a host's lines) checked again:
// the same fields with their shapes, and when it was checked. null when it
// is not one.
export function cleanSubscription(value) {
  if (!object(value)) return null
  const checkedAt = when(value.checkedAt)
  if (!checkedAt) return null
  const out = {}
  for (const key of WORDS) out[key] = word(value[key])
  for (const key of FLAGS) out[key] = flag(value[key])
  out.claude_code_trial_ends_at = when(value.claude_code_trial_ends_at)
  out.plan_display_name = planDisplayName(value.plan_display_name)
  if (!out.organization_type && !out.subscription_status && out.has_claude_max === null && out.has_claude_pro === null) return null
  out.checkedAt = checkedAt
  return out
}

// The plan's kind, from the service's type and tier, which keep their old words
// when a plan is renamed for people: Max 20x, Max 5x, Pro, Team, Enterprise, Free.
// null when the answer does not say.
const TYPES = { claude_max: 'Max', claude_pro: 'Pro', claude_team: 'Team', claude_enterprise: 'Enterprise', claude_free: 'Free' }
function planKind(sub) {
  const type = typeof sub.organization_type === 'string' ? sub.organization_type : ''
  let name = TYPES[type] || (/enterprise/.test(type) ? 'Enterprise' : /team/.test(type) ? 'Team' : null)
  if (!name) name = sub.has_claude_max === true ? 'Max' : sub.has_claude_pro === true ? 'Pro' : null
  if (name !== 'Max') return name
  const tier = typeof sub.rate_limit_tier === 'string' ? /(?:^|_)max_(\d{1,3})x(?:_|$)/.exec(sub.rate_limit_tier) : null
  return tier ? `Max ${Number(tier[1])}x` : 'Max'
}

// The plan's name to show: the service's own, so a new name needs no change here;
// its kind for an answer that does not give one.
export function subscriptionPlan(sub) {
  if (!object(sub)) return null
  return planDisplayName(sub.plan_display_name) || planKind(sub)
}

// Stripe's words for a subscription that ended, and for one not paid.
const ENDED = new Set(['canceled', 'cancelled', 'expired', 'ended', 'inactive', 'incomplete_expired', 'paused'])
const UNPAID = new Set(['past_due', 'unpaid', 'incomplete'])

// -> { plan, warn, trialEndsAt, checkedAt, attention } or null.
// warn: 'none' (a free account: no subscription), 'canceled' (a paid plan
// whose subscription ended), 'payment' (past due or unpaid), or null.
// trialEndsAt: a Claude Code trial still running (its end), else null.
// attention: the account cannot be counted on for a paid plan's limits now
// (a warning, and no trial running).
export function subscriptionState(sub, now = Date.now()) {
  const s = object(sub) ? sub : null
  if (!s) return null
  const plan = subscriptionPlan(s)
  const status = typeof s.subscription_status === 'string' ? s.subscription_status : ''
  let warn = null
  if (planKind(s) === 'Free') warn = 'none'
  else if (ENDED.has(status)) warn = 'canceled'
  else if (UNPAID.has(status)) warn = 'payment'
  const trial = Number.isFinite(s.claude_code_trial_ends_at) && s.claude_code_trial_ends_at > now ? s.claude_code_trial_ends_at : null
  return { plan, warn, trialEndsAt: trial, checkedAt: Number.isFinite(s.checkedAt) ? s.checkedAt : null, attention: !!warn && !trial }
}
