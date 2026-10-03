// The left sidebar's logic, ported from Orca (MIT, Copyright (c) 2026
// Lovecast Inc.): projects (Orca's repos) -> workspaces (Orca's worktrees:
// the project folder and each task copy) -> the agents and terminals in each,
// with Orca's status vocabulary, "Agent Activity" (smart) sort, filters and
// agent summaries (src/renderer/src/components/sidebar/smart-sort.ts,
// smart-attention.ts, worktree-card-agent-summary.ts, AgentStateDot.tsx,
// lib/worktree-status.ts, lib/short-time-ago.ts). Pure functions: App feeds
// raw workspaces, the sidebar renders the rows.
import { t, intlLocale } from './i18n'
import { nativeChatSessionChoiceLabel } from './chat/orca/native-chat-session-option-labels'
import { listsChildren } from './agentChildrenView'
import { modelLabel } from '../../shared/modelLabel'

// --- Orca's agent state vocabulary (AgentStateDot.tsx) ------------------------
export function agentStateLabel(state) {
  switch (state) {
    case 'working':
      return t('sidebar.agentState.working', 'Working')
    case 'monitoring':
      return t('sidebar.agentState.monitoring', 'Monitoring background tasks')
    case 'blocked':
      return t('sidebar.agentState.blocked', 'Blocked')
    case 'waiting':
      return t('sidebar.agentState.waiting', 'Waiting for input')
    case 'interrupted':
      return t('sidebar.agentState.interrupted', 'Interrupted')
    case 'failed':
      return t('sidebar.agentState.failed', 'Failed')
    case 'done':
      return t('sidebar.agentState.done', 'Done')
    case 'idle':
      return t('sidebar.agentState.idle', 'Idle')
    case 'unverifiable':
      return t('sidebar.agentState.unverifiable', 'No recent update')
    case 'permission':
      return t('sidebar.agentState.permission', 'Needs attention')
  }
  return t('sidebar.agentState.idle', 'Idle')
}

// An agent pane: a terminal agent, or a chat agent (no terminal: ChatPane).
export function isAgentPane(pane) {
  return !!pane && (pane.kind === 'agent' || pane.kind === 'chat')
}

// Tessel's pane state -> Orca's dot state. Tessel: 'approval' (asks you),
// 'limited' (usage limit), 'working', 'monitoring' (its turn ended, its
// background work still runs), 'waiting' (done, waiting for you),
// 'ready', 'unknown' (no report yet), 'interrupted' (a chat's last turn was
// interrupted), 'stopped' (a chat whose session is not
// running: ended, crashed, not signed in, folder not trusted); sleeping
// panes are idle.
export function paneDotState(pane) {
  if (!isAgentPane(pane) || pane.sleeping) return 'idle'
  switch (pane.state) {
    case 'working':
      return 'working'
    case 'monitoring':
      return 'monitoring'
    case 'approval':
      return 'waiting'
    case 'limited':
      return 'blocked'
    case 'waiting':
      return 'done'
    case 'unknown':
      return 'unverifiable'
    case 'stopped':
    case 'interrupted':
      return 'interrupted'
  }
  return 'idle'
}

// A stopped chat, in words: why its session is not running (ChatPane's
// status when the app passes it).
function chatStoppedLabel(pane) {
  if (pane.chatStatus === 'signin') return t('sidebar.row.chatSignin', 'Not signed in')
  if (pane.chatStatus === 'untrusted') return t('sidebar.row.chatUntrusted', 'Folder not trusted')
  return t('sidebar.row.chatStopped', 'Stopped')
}

// A chat's model as its header shows it ("Opus 4.7 · high").
function chatModelText(pane) {
  // What its header shows (ChatPane writes it: list name, effort found).
  if (typeof pane.headerModel === 'string' && pane.headerModel) return pane.headerModel
  const name = modelLabel(pane.model)
  if (!name) return ''
  return pane.effort ? `${name} · ${nativeChatSessionChoiceLabel({ value: pane.effort, label: pane.effort })}` : name // i18n-ignore
}

// Orca's worktree-card-agent-summary.ts.
export const SUMMARY_STATE_ORDER = ['waiting', 'blocked', 'working', 'monitoring', 'interrupted', 'done', 'unverifiable', 'idle']

export function formatSummaryStateLabel(state) {
  switch (state) {
    case 'unverifiable':
      return t('sidebar.summary.unverifiable', 'not reporting')
    case 'permission':
      return t('sidebar.summary.permission', 'needs attention')
    case 'waiting':
      return t('sidebar.summary.waiting', 'waiting')
    case 'blocked':
      return t('sidebar.summary.blocked', 'blocked')
    case 'working':
      return t('sidebar.summary.working', 'working')
    case 'monitoring':
      return t('sidebar.summary.monitoring', 'monitoring')
    case 'interrupted':
      return t('sidebar.summary.interrupted', 'interrupted')
    case 'done':
      return t('sidebar.summary.done', 'done')
    case 'idle':
      return t('sidebar.summary.idle', 'idle')
  }
  return state
}

export function buildSummaryAgentGroups(rows) {
  const groups = new Map()
  for (const r of rows) {
    const list = groups.get(r.dotState)
    if (list) list.push(r)
    else groups.set(r.dotState, [r])
  }
  return SUMMARY_STATE_ORDER.flatMap((state) => (groups.has(state) ? [{ state, agents: groups.get(state) }] : []))
}

export function summarizeAgents(rows, subjectLabel) {
  const counts = new Map()
  for (const r of rows) counts.set(r.dotState, (counts.get(r.dotState) || 0) + 1)
  const parts = SUMMARY_STATE_ORDER.flatMap((state) => {
    const n = counts.get(state) || 0
    return n ? [{ count: n, state: formatSummaryStateLabel(state) }] : []
  })
  if (parts.length === 1) {
    const only = parts[0].state
    return rows.length === 1
      ? t('sidebar.summary.one', '{{subject}} {{state}}', { subject: subjectLabel, state: only })
      : t('sidebar.summary.all', 'All {{subject}} {{state}}', { subject: subjectLabel, state: only })
  }
  const list = parts.map((p) => t('sidebar.summary.part', '{{count}} {{state}}', p)).join(', ')
  return t('sidebar.summary.list', '{{subject}}: {{list}}', { subject: subjectLabel, list })
}

export function summarizeAgentIdentities(rows) {
  return rows
    .map((r) => t('sidebar.summary.identity', '{{name}} {{state}}', { name: r.primary, state: formatSummaryStateLabel(r.dotState) }))
    .join('; ')
}

// Up to maxCount rows, one per agent kind, the most common kinds first.
export function selectSummaryGroupIconAgents(rows, maxCount) {
  const groups = new Map()
  rows.forEach((r, index) => {
    const key = r.iconKind || 'unknown'
    const g = groups.get(key)
    if (g) g.agents.push(r)
    else groups.set(key, { agents: [r], firstIndex: index })
  })
  return [...groups.values()]
    .sort((a, b) => b.agents.length - a.agents.length || a.firstIndex - b.firstIndex)
    .slice(0, maxCount)
    .map((g) => g.agents[0])
}

// Orca's lib/short-time-ago.ts.
export function formatShortTimeAgo(ts, now = Date.now()) {
  const delta = now - ts
  if (delta < 60000) return t('sidebar.time.now', '< 1m')
  const minutes = Math.floor(delta / 60000)
  if (minutes < 60) return t('sidebar.time.minutes', '{{count}}m', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('sidebar.time.hours', '{{count}}h', { count: hours })
  return t('sidebar.time.days', '{{count}}d', { count: Math.floor(hours / 24) })
}

// --- Worktree status (Orca's lib/worktree-status.ts) --------------------------
export function getWorktreeStatusLabel(status) {
  switch (status) {
    case 'active':
      return t('sidebar.status.active', 'Active')
    case 'working':
      return t('sidebar.status.working', 'Working')
    case 'monitoring':
      return t('sidebar.status.monitoring', 'Monitoring background tasks')
    case 'permission':
      return t('sidebar.status.permission', 'Needs permission')
    case 'interrupted':
      return t('sidebar.status.interrupted', 'Interrupted')
    case 'done':
      return t('sidebar.status.done', 'Done')
    case 'inactive':
      return t('sidebar.status.inactive', 'Inactive')
  }
  return ''
}

// A copy's status from its panes: someone asks you > working > monitoring
// background work > usage limit (Orca's red "interrupted") > done > a live
// pane > nothing live.
export function cardStatus(rows) {
  const live = rows.filter((r) => !r.sleeping)
  if (live.some((r) => r.dotState === 'waiting')) return 'permission'
  if (live.some((r) => r.dotState === 'working')) return 'working'
  if (live.some((r) => r.dotState === 'monitoring')) return 'monitoring'
  if (live.some((r) => r.dotState === 'blocked')) return 'interrupted'
  if (live.some((r) => r.dotState === 'done')) return 'done'
  if (live.length) return 'active'
  return 'inactive'
}

// Orca's smart-attention.ts classes: 1 needs you, 2 done, 3 working (or
// monitoring its background work), 4 not reporting, 5 idle.
export function attentionOf(rows) {
  let cls = 5
  let ts = 0
  for (const r of rows) {
    if (r.sleeping || r.kind !== 'agent') continue
    const c =
      r.dotState === 'waiting' || r.dotState === 'blocked' ? 1 : r.dotState === 'done' ? 2 : r.dotState === 'working' || r.dotState === 'monitoring' ? 3 : r.dotState === 'unverifiable' ? 4 : 5
    const at = r.since || 0
    if (c < cls || (c === cls && at > ts)) {
      cls = c
      ts = at
    }
  }
  return { cls, attentionTimestamp: cls === 5 ? 0 : ts }
}

// --- Rows ---------------------------------------------------------------------
export function folderName(p) {
  const parts = String(p || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
  return parts[parts.length - 1] || String(p || '')
}

function samePath(a, b) {
  const n = (p) =>
    String(p || '')
      .replace(/[\\/]+$/, '')
      .replace(/\\/g, '/')
      .toLowerCase()
  return !!a && !!b && n(a) === n(b)
}

// One pane -> one agent row (Orca's CompactAgentRow data).
// A chat agent (kind 'chat') is an agent row too, marked chat: it has no
// terminal (no shell process, no team tools to restart).
export function paneRow(pane, now = Date.now()) {
  const chat = pane.kind === 'chat'
  const agent = pane.kind === 'agent' || chat
  const dotState = paneDotState(pane)
  const stopped = chat && !pane.sleeping && pane.state === 'stopped'
  let secondary
  const terminal = t('sidebar.row.terminal', 'Terminal')
  const agentName = t('sidebar.row.agent', 'Agent')
  if (!agent) secondary = terminal
  else if (pane.sleeping) secondary = t('sidebar.status.sleeping', 'Sleeping')
  else if (stopped) secondary = chatStoppedLabel(pane)
  else if (pane.state === 'limited')
    secondary = pane.reset
      ? t('sidebar.row.usageLimitReset', 'Usage limit · {{reset}}', { reset: pane.reset })
      : t('sidebar.row.usageLimit', 'Usage limit')
  else if (pane.state === 'approval') secondary = t('sidebar.row.asksApproval', 'Asks your approval')
  else if (pane.typingHold) secondary = t('sidebar.row.typingHold', 'Message waits until you send your text')
  else if (pane.held) secondary = t('sidebar.row.held', 'Message waits for your approval')
  // Beside the name: only what needs attention (the dot shows the state);
  // the task goes on a second line under it (subline).
  else secondary = ''
  // Only a task: its state and how long ("Idle · 1 min") are already the dot
  // and the time on the right.
  const subline = agent ? pane.task || '' : ''
  const primary = pane.paneName || pane.title || (agent ? agentName : terminal)
  return {
    id: pane.id,
    num: pane.num || 0,
    paneName: pane.paneName,
    kind: agent ? 'agent' : 'shell',
    chat,
    iconKind: agent ? pane.agentId || 'agent' : pane.shellId || 'shell',
    accent: agent ? pane.accent || null : null,
    typeLabel: pane.agentLabel || pane.title || (agent ? agentName : terminal),
    title: pane.paneName || pane.title || (agent ? agentName : terminal),
    primary,
    secondary: primary === secondary ? '' : secondary,
    stateLabel: stopped ? t('sidebar.row.chatStopped', 'Stopped') : agent ? agentStateLabel(dotState) : '',
    // A chat's model (a terminal agent's comes from its pane header: paneModels).
    model: chat ? chatModelText(pane) : '',
    subline,
    dotState,
    sleeping: !!pane.sleeping,
    since: pane.since || 0,
    time: agent && pane.since ? formatShortTimeAgo(pane.since, now) : null,
    focused: !!pane.focused,
    isActive: !!pane.isActive,
    unvisited: !!pane.attention,
    team: pane.team || null,
    lead: !!pane.lead,
    // A worker started by a coordinator (orchestration): { id, label, num,
    // status } of that coordinator, for the row's link to it.
    workerOf: agent && pane.workerOf && pane.workerOf.id ? { ...pane.workerOf } : null,
    teamUnread: pane.teamUnread || 0,
    toolsDown: !chat && !!pane.toolsDown,
    activityAt: pane.activityAt || 0,
    pid: chat ? null : pane.pid || null,
    trackLevel: pane.track ? pane.track.level : null,
    // Sub-agents (Claude Code, Codex, OpenCode, Cline) are listed under its row.
    children:
      agent && listsChildren(pane.agentId) && pane.sessionId && !pane.sleeping
        ? { agent: pane.agentId, sessionId: pane.sessionId, ...(pane.accountId !== undefined ? { accountId: pane.accountId } : {}) }
        : null
  }
}

// A project's workspaces: its folder (the primary one) and each task copy,
// with the panes working in each.
export function buildProjectCards(project, now = Date.now()) {
  const cards = []
  const byPath = new Map()
  const main = {
    key: `${project.id}::`,
    projectId: project.id,
    isMain: true,
    path: project.cwd || null,
    branch: project.branch || '',
    title: project.cwd ? folderName(project.cwd) : project.name,
    taskId: null,
    // A project on an SSH host: its host, shown as a chip on the card.
    ...(project.remote && project.remote.host ? { host: project.remote.host } : {}),
    panes: []
  }
  cards.push(main)
  const copyCard = (path, branch, title, taskId) => {
    for (const [p, c] of byPath) if (samePath(p, path)) return c
    const c = {
      key: `${project.id}::${path}`,
      projectId: project.id,
      isMain: false,
      path,
      branch: branch || '',
      title: title || branch || folderName(path),
      taskId: taskId || null,
      panes: []
    }
    byPath.set(path, c)
    cards.push(c)
    return c
  }
  for (const c of project.copies || []) if (c && c.path) copyCard(c.path, c.branch, c.title, c.taskId)
  // A task copy git lists: its branch comes from git when the task has none.
  for (const c of cards) {
    if (c.isMain || c.branch) continue
    const wt = (project.worktrees || []).find((w) => w && samePath(w.path, c.path))
    if (wt && wt.branch) c.branch = wt.branch
  }
  for (const pane of project.panes || []) {
    if (pane.kind === 'editor' || pane.kind === 'browser') continue
    const card =
      pane.copyPath && !samePath(pane.copyPath, project.cwd) ? copyCard(pane.copyPath, pane.copyBranch, null, null) : main
    card.panes.push(paneRow(pane, now))
  }
  for (const card of cards) {
    card.status = cardStatus(card.panes)
    card.sleeping = card.panes.every((r) => r.sleeping)
    card.isActive = card.panes.some((r) => r.focused)
    card.isUnread = card.panes.some((r) => r.unvisited)
    card.attention = attentionOf(card.panes)
    // Orca's lastActivityAt: what its agents did (a state change), not
    // where you clicked, so a click never reorders the list.
    card.lastActivityAt = Math.max(0, ...card.panes.map((r) => r.since || 0))
    card.agentCount = card.panes.filter((r) => r.kind === 'agent').length
  }
  return cards
}

// The project's other git worktrees (project.worktrees, from `git worktree
// list`): the ones with no card (no task, no pane). Not the project folder
// itself, not a registration whose folder is gone. Tessel did not make them,
// so they stay hidden until you choose to show one (after Orca's
// worktree-visibility-resolution.ts shouldShowWorktree and
// external-worktree-visibility.ts, MIT, Copyright (c) 2026 Lovecast Inc.:
// a worktree the app did not create defaults to 'hide').
export function projectOtherBranches(project, cards = buildProjectCards(project)) {
  const out = []
  for (const w of project.worktrees || []) {
    if (!w || typeof w.path !== 'string' || !w.path || w.prunable) continue
    // The project's own checkout (a remote project's: git's word, self).
    if (w.self || samePath(w.path, project.cwd)) continue
    if (cards.some((c) => !c.isMain && samePath(c.path, w.path))) continue
    if (out.some((o) => samePath(o.path, w.path))) continue
    const head = typeof w.head === 'string' ? w.head.slice(0, 7) : ''
    out.push({
      key: `${project.id}::${w.path}`,
      projectId: project.id,
      path: w.path,
      branch: w.branch || '',
      // Detached: its commit, short.
      label: w.branch || head || folderName(w.path),
      folder: folderName(w.path),
      locked: !!w.locked,
      detached: !w.branch
    })
  }
  const locale = intlLocale()
  return out.sort((a, b) => a.label.localeCompare(b.label, locale))
}

// A project's other worktrees split by your choices (shownPaths: the ones you
// chose to Show): shown (a row each under the project), hidden (all the
// rest, which the Hidden worktrees dialog lists), and the ones its "Hiding N"
// line counts: hidden minus the detached ones (no branch), which stay out of
// it like Orca's scratch worktrees stay out of its discovery inbox.
export function projectWorktreeVisibility(project, shownPaths = [], cards = buildProjectCards(project)) {
  const others = projectOtherBranches(project, cards)
  const paths = Array.isArray(shownPaths) ? shownPaths : []
  const isShown = (o) => paths.some((p) => samePath(p, o.path))
  const shown = others.filter(isShown)
  const hidden = others.filter((o) => !isShown(o))
  return { shown, hidden, inbox: hidden.filter((o) => !o.detached) }
}

export const HIDDEN_WORKTREE_GROUP_LIMIT = 5
export const HIDDEN_WORKTREE_PREVIEW_LIMIT = 3

// The folder a worktree sits in (Orca's getExternalWorktreeParentPath),
// separators as written: 'C:\\repo.worktrees', '/srv', 'ssh://host/srv'.
export function worktreeParentPath(path) {
  const p = String(path || '').replace(/[\\/]+$/, '')
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (at < 0) return '?'
  if (at === 0) return p[0]
  const parent = p.slice(0, at)
  return /^[A-Za-z]:$/.test(parent) ? parent + p[at] : parent
}

// Orca's groupWorktreesByParentPath: one group per parent folder, in the
// order met.
export function groupWorktreesByParentPath(items) {
  const groups = []
  const byKey = new Map()
  for (const item of items) {
    const path = worktreeParentPath(item.path)
    const key = path.replace(/\\/g, '/').toLowerCase()
    let g = byKey.get(key)
    if (!g) {
      g = { key, path, items: [] }
      byKey.set(key, g)
      groups.push(g)
    }
    g.items.push(item)
  }
  return groups
}

// The unfolded line's preview (Orca's ImportedWorktreesVisibilityLine): at
// most 5 folders, 3 worktrees each unless that folder is opened in full
// (openGroups: their keys), then how many more folders.
export function hiddenWorktreesPreview(items, openGroups) {
  const all = groupWorktreesByParentPath(items)
  const groups = all.slice(0, HIDDEN_WORKTREE_GROUP_LIMIT).map((g) => {
    const full = Array.isArray(openGroups) && openGroups.includes(g.key)
    return {
      key: g.key,
      path: g.path,
      count: g.items.length,
      items: full ? g.items : g.items.slice(0, HIDDEN_WORKTREE_PREVIEW_LIMIT),
      more: Math.max(0, g.items.length - HIDDEN_WORKTREE_PREVIEW_LIMIT),
      full
    }
  })
  return { groups, moreGroups: Math.max(0, all.length - groups.length) }
}

export function hiddenWorktreesLabel(count) {
  return count === 1
    ? t('sidebar.hiddenWorktrees.line', 'Hiding {{count}} discovered worktree', { count })
    : t('sidebar.hiddenWorktrees.line', 'Hiding {{count}} discovered worktrees', { count })
}

// Orca's buildWorktreeComparator.
export function compareCards(sortBy, projectNames = {}) {
  const label = (c) => c.title || ''
  const locale = intlLocale()
  return (a, b) => {
    switch (sortBy) {
      case 'name':
        return label(a).localeCompare(label(b), locale)
      case 'smart':
        return (
          a.attention.cls - b.attention.cls ||
          b.attention.attentionTimestamp - a.attention.attentionTimestamp ||
          b.lastActivityAt - a.lastActivityAt ||
          label(a).localeCompare(label(b), locale)
        )
      case 'recent':
        return b.lastActivityAt - a.lastActivityAt || label(a).localeCompare(label(b), locale)
      case 'repo':
        return (
          (projectNames[a.projectId] || '').localeCompare(projectNames[b.projectId] || '', locale) ||
          label(a).localeCompare(label(b), locale)
        )
    }
    return (a.order || 0) - (b.order || 0) // manual: the project folder, then the copies as they came
  }
}

export const DEFAULT_SIDEBAR_OPTIONS = Object.freeze({
  groupBy: 'repo', // 'repo' (Project) | 'none'
  sortBy: 'recent', // 'name' | 'smart' | 'recent' | 'repo' | 'manual'
  projectOrderBy: 'manual', // 'manual' | 'recent'
  showSleepingWorkspaces: true,
  alwaysShowDefaultBranchWorkspace: true,
  hideDefaultBranchWorkspace: false,
  filterRepoIds: [],
  collapsedGroups: [],
  expandedBranches: [], // projects whose hidden-worktrees line is unfolded
  shownWorktrees: {}, // project group key -> the worktree paths you chose to show
  dismissedWorktreeLines: [], // projects whose hidden-worktrees line you closed for good
  openWorktreeGroups: {} // project group key -> folders of its line shown in full (not kept)
})

// Orca's visible-worktrees rules: sleeping ones hidden on request (the
// project folder kept when asked), the project folder hidden on request;
// the workspace you are in always stays.
export function isCardVisible(card, opts) {
  if (card.isActive) return true
  if (opts.hideDefaultBranchWorkspace && card.isMain) return false
  if (!opts.showSleepingWorkspaces && card.sleeping && !(card.isMain && opts.alwaysShowDefaultBranchWorkspace)) return false
  return true
}

// projects -> the list's rows: [{ type: 'header', key, project, count,
// collapsed }], [{ type: 'card', key, card, project }] and, under a project
// with other git worktrees, a row per worktree you chose to show [{ type:
// 'branch', key, project, item }], then its hidden ones' line [{ type:
// 'others', key, groupKey, project, count, open, groups, moreGroups }]
// (groups only while unfolded). A header carries its hiddenWorktrees.
export function buildSidebarRows(projects, options = {}, now = Date.now()) {
  const opts = { ...DEFAULT_SIDEBAR_OPTIONS, ...options }
  const filter = new Set((opts.filterRepoIds || []).filter((id) => projects.some((p) => p.id === id)))
  const collapsed = new Set(opts.collapsedGroups || [])
  const expanded = new Set(opts.expandedBranches || [])
  const dismissed = new Set(opts.dismissedWorktreeLines || [])
  const names = Object.fromEntries(projects.map((p) => [p.id, p.name]))
  const cmp = compareCards(opts.sortBy, names)
  const shown = projects.filter((p) => !filter.size || filter.has(p.id))
  const groups = shown.map((project, index) => {
    const cards = buildProjectCards(project, now)
    cards.forEach((c, i) => (c.order = i))
    const visible = cards.filter((c) => isCardVisible(c, opts)).sort(cmp)
    return {
      project,
      index,
      cards: visible,
      worktrees: projectWorktreeVisibility(project, (opts.shownWorktrees || {})[`repo:${project.id}`], cards), // i18n-ignore
      hidden: cards.length - visible.length,
      lastActivityAt: Math.max(0, ...cards.map((c) => c.lastActivityAt))
    }
  })
  const rows = []
  if (opts.groupBy === 'none') {
    const all = groups.flatMap((g) => g.cards.map((card) => ({ card, project: g.project }))).sort((a, b) => cmp(a.card, b.card))
    const key = 'all'
    rows.push({ type: 'header', key, label: t('sidebar.groups.all', 'All'), project: null, count: all.length, collapsed: collapsed.has(key) })
    if (!collapsed.has(key)) for (const { card, project } of all) rows.push({ type: 'card', key: card.key, card, project })
    return rows
  }
  if (opts.projectOrderBy === 'recent') groups.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.index - b.index)
  for (const g of groups) {
    const key = `repo:${g.project.id}` // i18n-ignore
    rows.push({
      type: 'header',
      key,
      label: g.project.name,
      project: g.project,
      count: g.cards.length,
      hidden: g.hidden,
      hiddenWorktrees: g.worktrees.hidden,
      collapsed: collapsed.has(key)
    })
    if (collapsed.has(key)) continue
    // Every workspace of it hidden by the filters: a way back, not a dead end.
    if (!g.cards.length && g.hidden) rows.push({ type: 'hidden', key: `${key}:hidden`, project: g.project, count: g.hidden }) // i18n-ignore
    for (const card of g.cards) rows.push({ type: 'card', key: card.key, card, project: g.project })
    // The worktrees you chose to show: a row each.
    for (const item of g.worktrees.shown) rows.push({ type: 'branch', key: `${key}:wt:${item.path}`, project: g.project, item }) // i18n-ignore
    // The rest: one folded line, never a card each (unless closed for good).
    if (g.worktrees.inbox.length && !dismissed.has(key)) {
      const open = expanded.has(key)
      const preview = open ? hiddenWorktreesPreview(g.worktrees.inbox, (opts.openWorktreeGroups || {})[key]) : { groups: [], moreGroups: 0 }
      rows.push({ type: 'others', key: `${key}:others`, groupKey: key, project: g.project, count: g.worktrees.inbox.length, open, ...preview }) // i18n-ignore
    }
  }
  return rows
}

// Arrow keys in the list: the card above or below the current one (Orca's
// navigateWorktree), wrapping at the ends.
export function neighborCard(rows, currentKey, direction) {
  const cards = rows.filter((r) => r.type === 'card')
  if (!cards.length) return null
  const at = cards.findIndex((r) => r.key === currentKey)
  if (at < 0) return direction === 'up' ? cards[cards.length - 1].card : cards[0].card
  const next = (at + (direction === 'up' ? -1 : 1) + cards.length) % cards.length
  return cards[next].card
}

// The pane a click on a card goes to: the one you were in there last, else
// its first pane (agents first).
export function cardTargetPane(card) {
  if (!card.panes.length) return null
  const focused = card.panes.find((r) => r.focused)
  if (focused) return focused.id
  const recent = [...card.panes].sort((a, b) => b.activityAt - a.activityAt)[0]
  if (recent && recent.activityAt) return recent.id
  return (card.panes.find((r) => r.kind === 'agent') || card.panes[0]).id
}

// What the plug scans: each card's pane shells and folder.
export function portProbes(projects) {
  const out = []
  for (const project of projects) {
    for (const card of buildProjectCards(project)) {
      const pids = card.panes.map((r) => r.pid).filter((n) => Number.isInteger(n) && n > 0)
      // A folder is named in command lines only for a git project or copy
      // (a home folder would claim every program started from it).
      const path = card.path && (!card.isMain || card.branch) ? card.path : null
      if (!pids.length && !path) continue
      out.push({ id: card.key, pids, path })
    }
  }
  return out
}
