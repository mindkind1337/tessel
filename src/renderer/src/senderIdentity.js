// The sender of a team message, as the window sees the sending pane (see
// src/shared/senderIdentity.js): built from the pane's state only, never from
// the message, then shown as one compact line with the details on hover.
import { cleanSender, senderLine, senderTag, senderRemote } from '../../shared/senderIdentity'
import { isRemotePath, parseRemotePath } from '../../shared/remotePath'
import { t, intlLocale } from './i18n'

export { cleanSender, senderTag, senderRemote }

// The SSH host a pane works on, from the pane's own state (never from what its
// agent writes): a terminal opened on a host (remoteHostId, remotePath) or a
// chat whose agent runs there (its folder is a virtual ssh:// path).
// -> { hostId, path } | null (a pane of this computer)
export function paneRemote(leaf) {
  if (!leaf || typeof leaf !== 'object') return null
  if (typeof leaf.remoteHostId === 'string' && /^ssh-[\w-]{1,60}$/.test(leaf.remoteHostId))
    return { hostId: leaf.remoteHostId, path: typeof leaf.remotePath === 'string' && leaf.remotePath ? leaf.remotePath : '' }
  const p = isRemotePath(leaf.cwd) ? parseRemotePath(leaf.cwd) : null
  return p ? { hostId: p.hostId, path: p.path } : null
}

// leaf: the sending pane. ctx (what App.vue knows around it): agentName
// ("Claude Code"), model (its header's text, "Opus 5.5 · high"), host
// ({ label, address } of its SSH host), branch (its project's, when it has
// no copy of its own), teamId, lead, card ({ id, title }), now.
export function buildSenderSnapshot(leaf, ctx = {}) {
  if (!leaf || typeof leaf.id !== 'string') return null
  const onHost = paneRemote(leaf)
  const remote = !!onHost
  const host = (remote && ctx.host) || {}
  const wt = leaf.worktree && typeof leaf.worktree === 'object' ? leaf.worktree : null
  const card = ctx.card && typeof ctx.card === 'object' ? ctx.card : null
  return cleanSender({
    paneId: leaf.id,
    num: leaf.num,
    name: leaf.paneName || leaf.title,
    agentId: leaf.agentId,
    agentName: ctx.agentName,
    model: ctx.model || leaf.headerModel,
    modelId: leaf.model,
    effort: leaf.effort || leaf.shownEffort,
    sessionId: leaf.sessionId,
    accountId: typeof leaf.accountId === 'string' ? leaf.accountId : '',
    host: remote ? 'ssh' : 'local',
    hostId: remote ? onHost.hostId : '',
    hostLabel: remote ? host.label || onHost.hostId : '',
    hostAddress: remote ? host.address : '',
    remotePath: remote ? onHost.path : '',
    worktree: wt ? wt.path : '',
    branch: (wt && wt.branch) || ctx.branch,
    teamId: ctx.teamId || leaf.team,
    lead: !!ctx.lead,
    cardId: card ? card.id : '',
    cardTitle: card ? card.title : '',
    at: Number.isFinite(ctx.now) ? ctx.now : Date.now()
  })
}

// "Ada · Claude Code · Opus 5.5 high · local · main" ('' for older records).
export function senderSummary(s) {
  return senderLine(s, { local: t('activity.sender.local', 'local') })
}

// Every detail, one per line, for a tooltip ('' for older records).
export function senderDetails(s) {
  if (!s || typeof s !== 'object') return ''
  const lines = []
  const add = (label, value) => value && lines.push(`${label}: ${value}`)
  add(t('activity.sender.pane', 'Pane'), [s.num ? `#${s.num}` : '', s.name, s.paneId ? `(${s.paneId})` : ''].filter(Boolean).join(' '))
  add(t('activity.sender.agent', 'Agent'), [s.agentName, s.agentId && s.agentId !== s.agentName ? `(${s.agentId})` : ''].filter(Boolean).join(' '))
  add(t('activity.sender.model', 'Model'), [s.model || s.modelId, s.model && s.modelId ? `(${s.modelId})` : ''].filter(Boolean).join(' '))
  if (s.effort && !(s.model && s.model.includes('·'))) add(t('activity.sender.effort', 'Effort'), s.effort)
  add(t('activity.sender.session', 'Session'), s.sessionId)
  add(t('activity.sender.account', 'Account'), s.accountId)
  add(
    t('activity.sender.host', 'Host'),
    s.host === 'ssh'
      ? [s.hostLabel, s.hostAddress && s.hostAddress !== s.hostLabel ? `(${s.hostAddress})` : ''].filter(Boolean).join(' ')
      : s.host === 'local'
        ? t('activity.sender.thisComputer', 'this computer')
        : ''
  )
  add(t('activity.sender.remotePath', 'Remote folder'), s.remotePath)
  add(t('activity.sender.worktree', 'Copy'), s.worktree)
  add(t('activity.sender.branch', 'Branch'), s.branch)
  add(t('activity.sender.team', 'Team'), s.teamId ? (s.lead ? t('activity.sender.teamLead', '{{team}} (lead)', { team: s.teamId }) : s.teamId) : '')
  add(t('activity.sender.card', 'Card'), [s.cardId, s.cardTitle ? `“${s.cardTitle}”` : ''].filter(Boolean).join(' '))
  add('Tessel', s.tesselVersion)
  if (s.at) add(t('activity.sender.at', 'Sent'), new Date(s.at).toLocaleString(intlLocale()))
  return lines.join('\n')
}
