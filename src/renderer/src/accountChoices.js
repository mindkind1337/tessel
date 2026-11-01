// The accounts a Claude Code or Codex session can start on (Settings > AI
// provider accounts): the launchers' account choice and the account a pane
// header shows. Display fields only: main never sends a credential here.
// A choice exists when the agent has the system's sign-in and at least one
// added account that is signed in; otherwise nothing is shown or asked.
import { reactive } from 'vue'
import { t } from './i18n'
import { planInfo } from './claudePlan'

export const ACCOUNT_AGENTS = ['claude', 'codex']
const state = reactive({ providers: {} })
let pending = null
// App: the agent panes open now ({ agentId, accountId }), for the removal warning.
let openPanes = () => []
let plansHooked = false

export function refreshAccountChoices() {
  const api = typeof window !== 'undefined' && window.shellApi && window.shellApi.accounts
  if (!api || !api.list) return Promise.resolve()
  // A Claude account's subscription checked again (main's claudePlanCheck.js):
  // the headers follow it.
  if (!plansHooked && typeof api.onPlansChanged === 'function') {
    plansHooked = true
    try {
      api.onPlansChanged(() => refreshAccountChoices())
    } catch {
      /* read again at the next refresh */
    }
  }
  if (pending) return pending
  pending = Promise.resolve()
    .then(() => api.list())
    .then(applyAccountList)
    .catch(() => {})
    .finally(() => {
      pending = null
    })
  return pending
}
// A listing read (here, or by Settings > AI provider accounts after each change).
export function applyAccountList(res) {
  if (!res || !res.ok || !Array.isArray(res.providers)) return
  const next = {}
  for (const p of res.providers) {
    if (!p || !ACCOUNT_AGENTS.includes(p.provider)) continue
    // A failed read keeps what was known.
    next[p.provider] = p.error
      ? state.providers[p.provider]
      : {
          selectedId: typeof p.selectedId === 'string' ? p.selectedId : null,
          system: p.system && typeof p.system === 'object' ? p.system : null,
          accounts: Array.isArray(p.accounts) ? p.accounts.filter((a) => a && typeof a.id === 'string') : []
        }
  }
  state.providers = next
}

// An email's part before the @, shortened: what a header has room for.
export function shortAccount(email) {
  if (typeof email !== 'string' || !email.trim()) return ''
  const value = email.trim()
  const at = value.indexOf('@')
  const local = at > 0 ? value.slice(0, at) : value
  return local.length > 22 ? `${local.slice(0, 21)}…` : local
}

// [{ id: null | accountId, name, title, isDefault }], the system's sign-in
// first; [] when the agent has nothing to choose from.
export function choicesFrom(provider) {
  if (!provider) return []
  const ready = (provider.accounts || []).filter((a) => a.status === 'ready')
  if (!ready.length) return []
  const all = [
    { id: null, email: (provider.system && provider.system.email) || '', label: '' },
    ...ready.map((a) => ({ id: a.id, email: a.email || '', label: a.label || '' }))
  ]
  // The same email twice (the system's sign-in and an added account that is
  // the same login) is one choice, not two: the one new sessions use stays
  // (the system's when neither is), so nothing starts on another account.
  const isDefault = (r) => (provider.selectedId ?? null) === r.id
  const rows = all.filter((r, i) => {
    const key = r.email.trim().toLowerCase()
    if (!key) return true
    const same = all.filter((o) => o.email.trim().toLowerCase() === key)
    if (same.length < 2) return true
    const keep = same.find(isDefault) || same[0]
    return all.indexOf(keep) === i
  })
  // Nothing to choose between any more: nothing is shown or asked.
  if (rows.length < 2) return []
  const shorts = rows.map((r) => shortAccount(r.email))
  // Two with the same name before the @: their whole email.
  const clash = (i) => !!shorts[i] && shorts.filter((s) => s === shorts[i]).length > 1
  return rows.map((r, i) => {
    const name = clash(i) ? r.email : shorts[i] || r.label || (r.id === null ? t('accounts.choice.system', 'System sign-in') : t('accounts.choice.account', 'Account'))
    return {
      id: r.id,
      name,
      title:
        r.id === null
          ? r.email
            ? t('accounts.choice.systemTitle', 'The system’s own sign-in: {{email}}', { email: r.email })
            : t('accounts.choice.systemHint', 'The system’s own sign-in')
          : r.email || r.label || name,
      isDefault: (provider.selectedId ?? null) === r.id
    }
  })
}
export function accountChoices(agentId) {
  return ACCOUNT_AGENTS.includes(agentId) ? choicesFrom(state.providers[agentId]) : []
}
// The account new sessions use (the one Settings marks), when it is a choice.
export function defaultAccountChoice(agentId) {
  const hit = accountChoices(agentId).find((c) => c.isDefault)
  return hit ? hit.id : undefined
}

// A Claude account's subscription as Anthropic last reported it (main's
// claudePlanCheck.js), or null. accountId: an added account's id, or null
// (or undefined, as "Used by" counts it) for the system's sign-in.
export function accountSubscription(agentId, accountId) {
  const p = ACCOUNT_AGENTS.includes(agentId) ? state.providers[agentId] : null
  if (!p) return null
  const id = accountId ?? null
  const row = id === null ? p.system : (p.accounts || []).find((a) => a.id === id)
  return (row && row.subscription) || null
}
// A header's name and title with the account's subscription: its warning
// beside the name ("name · No subscription"), its plan in the title.
function withPlan(base, agentId, accountId) {
  const info = planInfo(accountSubscription(agentId, accountId))
  if (!info) return base
  return { name: info.warn ? `${base.name} · ${info.warnText}` : base.name, title: [base.title, info.title].filter(Boolean).join(' · '), plan: info }
}

// The account a pane runs on, for its header: { name, title, plan? } or null
// when the agent has a single account (nothing worth showing) or it is not
// known.
export function paneAccount(agentId, accountId) {
  if (accountId === undefined) return null
  const choices = accountChoices(agentId)
  if (!choices.length) return null
  const hit = choices.find((c) => c.id === accountId)
  if (hit) return withPlan({ name: hit.name, title: hit.title }, agentId, accountId)
  // Signed out or removed since: still named if it is known.
  const known = (state.providers[agentId]?.accounts || []).find((a) => a.id === accountId)
  if (!known) return null
  const name = shortAccount(known.email) || known.label || t('accounts.choice.account', 'Account')
  return withPlan({ name, title: known.email || name }, agentId, accountId)
}

export function setOpenPanesSource(fn) {
  openPanes = typeof fn === 'function' ? fn : () => []
}
// How many open panes run on this account (removing it stops their sign-in).
export function panesOnAccount(agentId, accountId) {
  try {
    return openPanes().filter((p) => p && p.agentId === agentId && p.accountId === accountId).length
  } catch {
    return 0
  }
}
