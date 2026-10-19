// Grok Build's subscription: its tier (SuperGrok, SuperGrok Heavy, X Premium+,
// Free...) and the kind of sign-in (a grok.com / X subscription, a team, an
// xAI API key), for Settings > AI provider accounts, "Where you're signed
// in", the usage menu and a Grok pane's header.
//
// Two sources, each said with the answer and when it was checked:
// - live: Grok Build's own profile call, GET https://cli-chat-proxy.grok.com/v1/user
//   (the "login enrichment" its sign-in makes: subscriptionTier, teamName,
//   organizationName...), asked with the existing sign-in alongside its usage
//   read (extraProviderUsage.js); never a token refresh;
// - cli: what Grok Build last fetched itself and keeps on this computer,
//   <GROK_HOME or ~/.grok>/settings_cache.json { fetched_at, settings: {
//   subscription_tier, subscription_tier_display } } (its /v1/settings), and
//   auth.json's sign-in kind (auth_mode, principal_type, team_id), read
//   without ever keeping a token.
// The tier names are Grok Build's own (its telemetry's tier list:
// supergrok_heavy, supergrok_plus, supergrok, supergrok_lite, x_premium_plus,
// x_premium, x_basic, free, api_key), in any spelling the services use
// (SUPERGROK_HEAVY, SuperGrokHeavy, "SuperGrok Heavy", SUBSCRIPTION_TIER_...).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FILE_LIMIT = 512 * 1024
const TIERS = [
  ['supergrokheavy', 'SuperGrok Heavy', true],
  ['supergrokplus', 'SuperGrok Plus', true],
  ['supergroklite', 'SuperGrok Lite', true],
  ['supergrok', 'SuperGrok', true],
  ['xpremiumplus', 'X Premium+', true],
  ['premiumplus', 'X Premium+', true],
  ['xpremium', 'X Premium', true],
  ['premium', 'X Premium', true],
  ['xbasic', 'X Basic', false],
  ['basic', 'X Basic', false],
  ['free', 'Free', false],
  ['none', 'Free', false],
  ['apikey', 'API key', false]
]
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v, max = 120) => (typeof v === 'string' && v.trim() && !/[\u0000-\u001f]/.test(v) ? v.trim().slice(0, max) : null) // eslint-disable-line no-control-regex

export function grokHome(home = os.homedir(), env = process.env) {
  const own = typeof env.GROK_HOME === 'string' ? env.GROK_HOME.trim() : ''
  return own && path.isAbsolute(own) ? own : path.join(home, '.grok')
}

// A tier as a service spells it -> { tier, label, paid } or null. A display
// name it does not know (a new plan) is kept as it is, its kind unknown.
export function grokTier(raw) {
  const s = text(raw, 60)
  if (!s) return null
  const key = s
    .toLowerCase()
    .replace(/^subscription[_\s-]*tier[_\s-]*/, '')
    .replace(/[^a-z0-9]/g, '')
  if (!key || key === 'unspecified' || key === 'unknown') return null
  for (const [id, label, paid] of TIERS) if (key === id) return { tier: id, label, paid }
  return /^[\w .+-]{1,40}$/.test(s) ? { tier: key.slice(0, 40), label: s, paid: null } : null
}

function readJson(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > FILE_LIMIT) return null
    const o = JSON.parse(fs.readFileSync(file, 'utf8'))
    return object(o) ? o : null
  } catch {
    return null
  }
}

// auth.json's sign-in kind, never a token: 'subscription' (grok.com / X
// sign-in), 'team' (a team's principal), 'api-key', or null (signed out).
export function grokSignInKind(auth, env = process.env) {
  const rows = object(auth) ? Object.entries(auth).filter(([, r]) => object(r) && typeof r.key === 'string' && r.key.length >= 8) : []
  const preferred = rows.filter(([k]) => k === 'https://auth.x.ai' || k.startsWith('https://auth.x.ai::'))
  const row = (preferred.length ? preferred : rows).map(([, r]) => r)[0]
  if (!row) return typeof env.XAI_API_KEY === 'string' && env.XAI_API_KEY.trim() ? { kind: 'api-key', team: null } : null
  const principal = String(row.principal_type || '').toLowerCase()
  const team = text(row.team_name, 80)
  if (principal && principal !== 'user') return { kind: 'team', team }
  if (String(row.auth_mode || '').toLowerCase() === 'api_key') return { kind: 'api-key', team: null }
  return { kind: 'subscription', team }
}

// The plan Grok Build fetched last (settings_cache.json), and the sign-in
// kind: { label, tier, paid, kind, team, source: 'cli', checkedAt } or null.
export function readGrokPlanLocal(home = os.homedir(), env = process.env) {
  const dir = grokHome(home, env)
  const signIn = grokSignInKind(readJson(path.join(dir, 'auth.json')), env)
  if (!signIn) return null
  if (signIn.kind === 'api-key') return { label: 'API key', tier: 'apikey', paid: false, kind: 'api-key', team: null, source: 'cli', checkedAt: null } // i18n-ignore
  const cache = readJson(path.join(dir, 'settings_cache.json'))
  let payload = null
  try {
    payload = cache && typeof cache.payload === 'string' && cache.payload.length <= FILE_LIMIT ? JSON.parse(cache.payload) : object(cache?.settings) ? cache : null
  } catch {
    payload = null
  }
  const settings = object(payload?.settings) ? payload.settings : {}
  const tier = grokTier(settings.subscription_tier) || grokTier(settings.subscription_tier_display)
  const display = text(settings.subscription_tier_display, 40)
  const at = Date.parse(payload?.fetched_at || '')
  if (!tier && !display) return { label: null, tier: null, paid: null, kind: signIn.kind, team: signIn.team, source: 'cli', checkedAt: Number.isFinite(at) ? at : null }
  return {
    label: display || tier.label,
    tier: tier ? tier.tier : null,
    paid: tier ? tier.paid : null,
    kind: signIn.kind,
    team: signIn.team,
    source: 'cli',
    checkedAt: Number.isFinite(at) ? at : null
  }
}

// GET .../v1/user's answer -> { label, tier, paid, kind, team, org } or null.
export function grokUserPlan(data) {
  const d = object(data?.user) ? data.user : object(data) ? data : null
  if (!d) return null
  const tier = grokTier(d.subscriptionTier ?? d.subscription_tier)
  const team = text(d.teamName ?? d.team_name, 80)
  const org = text(d.organizationName ?? d.organization_name, 120)
  const principal = String(d.principalType ?? d.principal_type ?? '').toLowerCase()
  const kind = principal && principal !== 'user' ? 'team' : 'subscription'
  if (!tier && !team && !org) return null
  return { label: tier ? tier.label : null, tier: tier ? tier.tier : null, paid: tier ? tier.paid : null, kind, team, org }
}

// Whether a plan needs your attention: signed in with no paid tier (Free,
// X Basic) while Grok Build needs SuperGrok or X Premium+.
export const grokPlanAttention = (plan) => !!plan && plan.kind === 'subscription' && plan.paid === false
