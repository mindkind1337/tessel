// The texts of the Task history tab (TaskHistoryPanel.vue and its rows,
// TaskHistoryRow.vue): dates, times, tokens and costs in the interface's
// language. The Intl formatters are kept per locale (shared/intlCache.js):
// a list of hundreds of rows would otherwise create thousands of them.
import { pricedUsd } from './taskHistoryView'
import { formatTokens, costText } from './jobCost'
import { formatCost } from '../../shared/modelPricing'
import { dateTimeFormat } from '../../shared/intlCache'
import { formatDuration } from './timeFormat'
import { t, intlLocale } from './i18n'

const DATE = { dateStyle: 'short', timeStyle: 'short' }
const TIME = { timeStyle: 'short' }

export const when = (ms) => (ms ? dateTimeFormat(intlLocale(), DATE).format(new Date(ms)) : '')
export const clock = (ms) => dateTimeFormat(intlLocale(), TIME).format(new Date(ms))
export const duration = (ms) => (ms > 0 ? formatDuration(ms) : '—')
const tokensOf = (c) => (c ? (c.inputTokens || 0) + (c.outputTokens || 0) : 0)

export function tokensText(r) {
  if (!r.cost) return '…'
  if (r.cost.status !== 'ok') return '—'
  return formatTokens(tokensOf(r.cost))
}
export function tokensTitle(c) {
  if (!c || c.status !== 'ok') return undefined
  return [
    t('jobCost.detail.input', 'Input: {{n}}', { n: formatTokens(c.inputTokens) }),
    t('jobCost.detail.output', 'Output: {{n}}', { n: formatTokens(c.outputTokens) }),
    t('jobCost.detail.cacheRead', 'Cache read: {{n}}', { n: formatTokens(c.cacheReadTokens) }),
    t('jobCost.detail.cacheWrite', 'Cache write: {{n}}', { n: formatTokens(c.cacheWriteTokens) })
  ].join('\n')
}
export function costCell(r) {
  if (!r.cost) return '…'
  if (pricedUsd(r) === null) return t('taskHistory.unknown', 'unknown')
  return costText(r.cost) || '—'
}
export const estimateHint = () => t('jobCost.detail.estimate', 'API-equivalent estimate (subscriptions are not billed per token)')
export function usdText(usd) {
  const s = formatCost(usd, intlLocale())
  return s.startsWith('<') ? s : `~${s}` // i18n-ignore
}

const REASONS = {
  'no-session': () => t('taskHistory.reason.noSession', 'No agent session was seen for its pane.'),
  'missing-file': () => t('taskHistory.reason.missingFile', "The agent's session file could not be found."),
  remote: () => t('taskHistory.reason.remote', 'The agent ran on another computer.'),
  'unsupported-agent': () => t('taskHistory.reason.unsupported', 'Tessel cannot read the usage of this agent.'),
  'invalid-session': () => t('taskHistory.reason.invalidSession', 'The session id is not valid.'),
  'no-pane': () => t('taskHistory.reason.noPane', 'No agent pane worked on it.'),
  'not-started': () => t('taskHistory.reason.notStarted', 'It never went through Doing.'),
  'no-card': () => t('taskHistory.reason.noCard', 'Its card is gone and so is its record.'),
  error: () => t('taskHistory.reason.error', 'The figures could not be read.')
}
export const reasonText = (c) => (c && REASONS[c.reason] ? REASONS[c.reason]() : t('taskHistory.reason.error', 'The figures could not be read.'))

export const subagentsText = (n) => (n === 1 ? t('taskHistory.detail.subagents', '{{count}} sub-agent', { count: 1 }) : t('taskHistory.detail.subagents', '{{count}} sub-agents', { count: n }))

export function agentLabel(r) {
  return r.agentName || r.agentKind || t('taskHistory.noAgent', 'No agent')
}
