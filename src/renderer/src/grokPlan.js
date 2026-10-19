// Grok Build's subscription as main read it (grokAccount.js: its profile
// call, else the plan the CLI cached), for Settings > AI provider accounts,
// the usage menu and a Grok pane's header: { tag, warn, warnText, title } or
// null. Free / X Basic (no plan Grok Build runs on) says "No subscription",
// as a Claude account without one does.
import { reactive } from 'vue'
import { t } from './i18n'
import { timeAgo } from './sessionHistory'

export function grokPlanInfo(plan, now = Date.now()) {
  if (!plan || typeof plan !== 'object') return null
  const kind =
    plan.kind === 'api-key'
      ? t('accounts.grokPlan.apiKey', 'xAI API key (billed per token)')
      : plan.kind === 'team'
        ? plan.team
          ? t('accounts.grokPlan.teamNamed', 'Team: {{team}}', { team: plan.team })
          : t('accounts.grokPlan.team', 'Team account')
        : t('accounts.grokPlan.subscription', 'grok.com / X subscription')
  const warn = plan.attention === true
  const warnText = warn ? t('accounts.plan.none', 'No subscription') : ''
  const label = typeof plan.label === 'string' && plan.label ? plan.label : ''
  const source =
    plan.source === 'live'
      ? t('accounts.grokPlan.sourceLive', 'from xAI')
      : t('accounts.grokPlan.sourceCli', 'as Grok Build last saved it')
  const at = Number.isFinite(plan.checkedAt) ? plan.checkedAt : null
  const checked = at ? (now - at < 60_000 ? t('accounts.plan.checkedNow', 'checked just now') : t('accounts.plan.checked', 'checked {{when}}', { when: timeAgo(at, now) })) : ''
  if (!label && !warn && plan.kind !== 'api-key' && plan.kind !== 'team') return null
  const tag = warn ? warnText : label || (plan.kind === 'api-key' ? t('accounts.grokPlan.apiKeyShort', 'API key') : '')
  return { tag, warn, warnText, label, kind, title: [label, warnText, kind, [source, checked].filter(Boolean).join(', ')].filter(Boolean).join(' · ') }
}

// The sign-in on this computer, shared by the Grok panes' headers: read when
// a pane asks, at most once a minute (Settings reads it on its own).
const state = reactive({ status: null, at: 0, pending: null })
export function grokSignIn() {
  return state.status
}
export function resetGrokSignInForTests() {
  Object.assign(state, { status: null, at: 0, pending: null })
}
export function refreshGrokSignIn(force = false, now = Date.now()) {
  if (state.pending || (!force && now - state.at < 60_000)) return state.pending
  const read = window.shellApi?.providerSettings?.status
  if (typeof read !== 'function') return null
  state.at = now
  state.pending = Promise.resolve(window.shellApi.providerSettings.status())
    .then((s) => {
      state.status = s && typeof s === 'object' && s.grok && typeof s.grok === 'object' ? s.grok : null
    })
    .catch(() => {})
    .finally(() => {
      state.pending = null
    })
  return state.pending
}
