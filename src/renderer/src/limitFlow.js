// What Tessel does when an agent hits its usage limit, so a project never
// waits on it (App.vue wires it): its reset time as you read it, who can take
// over its cards, what its team lead and teammates are told, and which other
// account of its agent it could restart on. Pure: no Vue, no window.
import { t, intlLocale } from './i18n'
import { formatLimitReset } from '../../shared/limitReset'

// The reset as a short time ("15:00", "Tue 09:00"), else as the agent said
// it ("in 2 hours"), else ''.
export function limitClock(limit, now = Date.now()) {
  if (!limit) return ''
  if (Number.isFinite(limit.resetAt)) return formatLimitReset(limit.resetAt, { now, locale: intlLocale() })
  return limit.reset || ''
}

// " (resets at 15:00)" / " (resets in 2 hours)" for a person, else ''.
export function limitWhen(limit, now = Date.now()) {
  const when = limitClock(limit, now)
  if (!when) return ''
  return ' ' + (!Number.isFinite(limit.resetAt) && /^in /.test(when) ? t('app.limit.resets', '(resets {{when}})', { when }) : t('app.limit.resetsAt', '(resets at {{when}})', { when }))
}

// The same for agents (English, the language of their messages):
// " until 15:00" in 24-hour time, " until in 2 hours" never.
export function limitUntilEn(limit, now = Date.now()) {
  if (!limit) return ''
  const at = Number.isFinite(limit.resetAt) ? new Date(limit.resetAt) : null
  if (at && Number.isFinite(at.getTime())) {
    const two = (n) => String(n).padStart(2, '0')
    const time = `${two(at.getHours())}:${two(at.getMinutes())}`
    const sameDay = at.toDateString() === new Date(now).toDateString()
    return sameDay ? ` until ${time}` : ` until ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}` // i18n-ignore
  }
  if (/^in /.test(limit.reset || '')) return ` for the next ${limit.reset.slice(3)}` // i18n-ignore
  return limit.reset ? ` until ${limit.reset}` : '' // i18n-ignore
}

// Who takes over the cards of an agent at its limit: an agent free now (no
// card of its own under way, not at its limit, not asking for an approval,
// not working). A team's card stays in its team (its board and its lead
// follow it there); a card of no team goes to an agent of its workspace.
// The same kind of agent first. candidates: [{ id, agentId, team, wsId,
// free }]. -> a candidate or null.
export function pickReplacement(limited, candidates) {
  if (!limited) return null
  const team = limited.team || null
  const near = (candidates || []).filter(
    (c) => c && c.id !== limited.id && c.free && (team ? c.team === team : c.wsId === limited.wsId)
  )
  const rank = (c) => (c.agentId === limited.agentId ? 0 : 1)
  return near.sort((a, b) => rank(a) - rank(b))[0] || null
}

// The lead's message when one of its teammates hits its limit (English: it
// goes to an agent). cards: [{ id, title }] it had under way; free: names of
// teammates free now.
export function leadLimitText({ name, until, cards, free }) {
  const parts = [`[Tessel] ${name} hit its usage limit${until} and cannot work until then.`] // i18n-ignore
  if (cards.length)
    parts.push(`Its cards under way: ${cards.map((c) => `${c.id} "${c.title}"`).join(', ')}. Give that work to another teammate (team_task_add for them, with what was done so far) instead of waiting, or tell the user.`) // i18n-ignore
  parts.push(free.length ? `Free now: ${free.join(', ')}.` : 'No teammate is free right now.') // i18n-ignore
  parts.push('Messages to it wait until its limit is over.') // i18n-ignore
  return parts.join(' ')
}

export function leadFreeText(name) {
  return `[Tessel] ${name} is no longer at its usage limit: it can work again.` // i18n-ignore
}

// The brief of a card given to another agent because its own hit the limit.
export function handOverText({ card, from }) {
  const lines = [
    `[Tessel] Card ${card.id} "${card.title}" is yours now: ${from} hit its usage limit while working on it.`, // i18n-ignore
    card.brief ? `Its brief: ${card.brief}` : '', // i18n-ignore
    card.worktree && card.worktree.path ? `Its work so far is in ${card.worktree.path} (branch ${card.worktree.branch || '?'}): continue from there.` : 'Check what was already done before you start.', // i18n-ignore
    'Move the card on the board as you go (team_task_move), and say when it is done.' // i18n-ignore
  ]
  return lines.filter(Boolean).join('\n')
}

// Other accounts of the pane's agent it could restart on (accountChoices.js
// choices: [{ id, name }], id null for the computer's own sign-in): not the
// one it runs on, not one another pane is at its limit on.
// limitedAccounts: the account ids (null too) of the other panes at their limit.
export function otherAccounts(current, choices, limitedAccounts = []) {
  const cur = current == null ? null : current
  return (choices || []).filter((c) => (c.id == null ? null : c.id) !== cur && !limitedAccounts.includes(c.id == null ? null : c.id))
}
