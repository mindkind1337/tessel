// How a pane shows its agent's sub-agents (Claude Code's own list style):
// "7m 57s · ↓ 105.8k tokens".
import { t, intlLocale } from './i18n'

// The agents whose sub-agents Tessel reads from their own files: Claude Code
// (projects/<p>/<session>/subagents), Codex (spawned threads' rollouts),
// OpenCode and Cline (child sessions in their databases).
export const CHILD_AGENTS = ['claude', 'codex', 'opencode', 'cline']
export const listsChildren = (agent) => CHILD_AGENTS.includes(agent)

export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return t('pane.subAgents.elapsedHours', '{{h}}h {{m}}m', { h, m })
  if (m) return t('pane.subAgents.elapsedMinutes', '{{m}}m {{s}}s', { m, s: sec })
  return t('pane.subAgents.elapsedSeconds', '{{s}}s', { s: sec })
}

const decimal = (n) =>
  new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }).format(n)

export function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1000) return `${n}`
  if (n < 1000000) return t('pane.subAgents.thousands', '{{n}}k', { n: decimal(n / 1000) })
  return t('pane.subAgents.millions', '{{n}}M', { n: decimal(n / 1000000) })
}

// Minutes, for how long one has been quiet: "16m", "2h 5m".
function formatQuiet(ms) {
  const m = Math.max(0, Math.floor(ms / 60000))
  return m >= 60
    ? t('pane.subAgents.quietHours', '{{h}}h {{m}}m', { h: Math.floor(m / 60), m: m % 60 })
    : t('pane.subAgents.quietMinutes', '{{m}}m', { m })
}

// The line for one sub-agent: its time (still counting while it runs). A
// quiet one (unfinished, nothing written for a while: a long tool, or
// stopped) says for how long, never that it finished.
export function childTime(c, now = Date.now()) {
  if (c.state === 'quiet')
    return c.lastAt
      ? t('pane.subAgents.quietFor', 'quiet {{time}}', { time: formatQuiet(now - c.lastAt) })
      : t('pane.subAgents.quiet', 'quiet')
  if (!c.startedAt) return ''
  const end = c.state === 'running' ? now : c.state === 'done' && c.endedAt ? c.endedAt : now
  return formatElapsed(end - c.startedAt)
}

// A sub-agent that was stopped or crashed never writes that it finished: its
// files say "running", then "quiet", forever. It is active only while it
// really can be: it wrote in the last CHILD_STALE_MS, and, once its parent's
// turn is over (the pane idle since parentIdleSince), it wrote after that end
// (a background sub-agent keeps writing; a stopped one does not), unless
// Claude says it was started in the background (background: true).
export const CHILD_STALE_MS = 10 * 60 * 1000
const PARENT_GRACE_MS = 5 * 1000
export function childActive(c, { now = Date.now(), parentIdleSince = null } = {}) {
  if (!c || c.state !== 'running') return false
  if (Number.isFinite(c.lastAt) && now - c.lastAt > CHILD_STALE_MS) return false
  // One started in the background works on after its parent's turn, even
  // while it writes nothing (one long answer); it is over when it says so.
  if (Number.isFinite(parentIdleSince) && c.background !== true) {
    const at = c.lastAt || c.startedAt || 0
    if (at <= parentIdleSince + PARENT_GRACE_MS) return false
  }
  return true
}
// Its state as shown: 'running' only while active; an unfinished one that is
// not (quiet) is shown quiet and folds with the finished ones.
export function childShownState(c, ctx) {
  if (c.state === 'done') return 'done'
  return childActive(c, ctx) ? 'running' : 'quiet'
}

// Shown in the pane header: those running (its count), and, folded, the quiet
// ones and those finished in the last half hour (older ones stay in the list
// only when you open it).
export const RECENT_MS = 30 * 60 * 1000
export function childrenSummary(list, now = Date.now(), parentIdleSince = null) {
  const ctx = { now, parentIdleSince }
  let running = 0
  let quiet = 0
  let recent = 0
  let recentQuiet = 0
  for (const c of list) {
    const state = childShownState(c, ctx)
    if (state === 'running') running++
    else if (state === 'quiet') {
      quiet++
      const at = c.lastAt || c.startedAt
      if (Number.isFinite(at) && now - at < RECENT_MS) recentQuiet++
    } else if (c.endedAt && now - c.endedAt < RECENT_MS) recent++
  }
  return { running, quiet, recent, recentQuiet, total: list.length }
}
