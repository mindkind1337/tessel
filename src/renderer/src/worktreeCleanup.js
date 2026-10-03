// Clean up worktrees: which of a project's other worktrees are listed, which
// are safe to remove, what makes the others risky, and the removal run
// itself, one worktree after the other (after Orca's workspace-cleanup
// removal candidates, selection model and background removal, MIT,
// Copyright (c) 2026 Lovecast Inc.). Pure: the dialog renders it, App gives
// the git evidence (src/main/worktreeCleanup.js) and does each removal.
import { t } from './i18n'
import { buildProjectCards, samePath, folderName } from './sidebarModel'

// Not touched for this long: inactive.
export const INACTIVE_MS = 7 * 24 * 60 * 60 * 1000

// Never selectable here (the reason is shown instead of a checkbox).
export const BLOCKERS = ['detached', 'default-branch', 'locked']

// The rows of the dialog. scan: the main process's { defaultBranch, items };
// project: the sidebar's project (its panes, task copies); tasks: the board's
// cards [{ id, title, worktree: { path }, mergedAt }].
export function cleanupRows(scan, { project = null, tasks = [], now = Date.now() } = {}) {
  const items = (scan && scan.items) || []
  const cards = project ? buildProjectCards(project, now) : []
  return items.map((ev) => {
    const card = cards.find((c) => !c.isMain && samePath(c.path, ev.path))
    const panes = card ? card.panes.length : 0
    const agents = card ? card.agentCount : 0
    const task = tasks.find((x) => x && x.worktree && !x.mergedAt && samePath(x.worktree.path, ev.path)) || null
    const activityAt = Math.max(ev.activityAt || 0, (card && card.lastActivityAt) || 0)
    const blocker = ev.detached ? 'detached' : ev.onDefault ? 'default-branch' : ev.locked ? 'locked' : null
    const risks = []
    if (ev.dirty === true) risks.push('dirty')
    else if (ev.dirty === null && !ev.missing) risks.push('unknown-status')
    if (ev.merged === false) risks.push('unmerged')
    else if (ev.merged === null) risks.push('unknown-merge')
    if (panes) risks.push('open-panes')
    if (task) risks.push('task')
    return {
      ...ev,
      key: ev.path,
      label: ev.branch || folderName(ev.path),
      panes,
      agents,
      paneIds: card ? card.panes.map((p) => p.id) : [],
      taskId: task ? task.id : null,
      taskTitle: task ? task.title : '',
      activityAt,
      inactive: !activityAt || now - activityAt >= INACTIVE_MS,
      blocker,
      risks,
      removable: !blocker,
      safe: !blocker && risks.length === 0,
      // Work that would be lost: git must be told (worktree remove --force,
      // branch -D). Open panes alone do not need it: they are closed first.
      force: risks.some((r) => r === 'dirty' || r === 'unknown-status' || r === 'unmerged' || r === 'unknown-merge')
    }
  })
}

// Listed by default: merged, inactive, or whose folder is gone. showAll: every one.
export function visibleRows(rows, { showAll = false } = {}) {
  const list = showAll ? rows.slice() : rows.filter((r) => r.merged === true || r.inactive || r.missing)
  // Safe ones first, then removable, then the rest; oldest activity first.
  const rank = (r) => (r.safe ? 0 : r.removable ? 1 : 2)
  return list.sort((a, b) => rank(a) - rank(b) || (a.activityAt || 0) - (b.activityAt || 0) || a.label.localeCompare(b.label))
}

// The default selection: only the safe ones.
export function defaultSelection(rows) {
  return new Set(rows.filter((r) => r.safe).map((r) => r.key))
}

// Ticking a row: never a blocked one.
export function toggleSelection(selection, row) {
  const next = new Set(selection)
  if (next.has(row.key)) next.delete(row.key)
  else if (row.removable) next.add(row.key)
  return next
}

// Only rows still listed and removable stay selected (after a rescan).
export function pruneSelection(selection, rows) {
  const keep = new Set(rows.filter((r) => r.removable).map((r) => r.key))
  return new Set([...selection].filter((k) => keep.has(k)))
}

export function riskLabel(code, row = {}) {
  switch (code) {
    case 'dirty':
      return row.changes === 1
        ? t('cleanup.risk.dirtyOne', '1 uncommitted change')
        : t('cleanup.risk.dirty', '{{count}} uncommitted changes', { count: row.changes || 0 })
    case 'unknown-status':
      return t('cleanup.risk.unknownStatus', 'Could not check for uncommitted changes')
    case 'unmerged':
      return row.ahead
        ? row.ahead === 1
          ? t('cleanup.risk.unmergedOne', '1 commit not merged')
          : t('cleanup.risk.unmerged', '{{count}} commits not merged', { count: row.ahead })
        : t('cleanup.risk.unmergedPlain', 'Not merged')
    case 'unknown-merge':
      return t('cleanup.risk.unknownMerge', 'Could not check if it is merged')
    case 'open-panes':
      return row.agents
        ? t('cleanup.risk.openAgents', '{{count}} open panes ({{agents}} agents): closed first', { count: row.panes, agents: row.agents })
        : t('cleanup.risk.openPanes', '{{count}} open panes: closed first', { count: row.panes })
    case 'task':
      return t('cleanup.risk.task', 'Copy of the task "{{title}}"', { title: row.taskTitle })
    default:
      return code
  }
}

export function blockerLabel(code) {
  switch (code) {
    case 'detached':
      return t('cleanup.blocker.detached', 'No branch (detached): remove it from git')
    case 'default-branch':
      return t('cleanup.blocker.defaultBranch', 'On the default branch')
    case 'locked':
      return t('cleanup.blocker.locked', 'Locked in git')
    default:
      return code
  }
}

// Removes the rows one after the other (never two git deletes at once in a
// repository). remove(row) -> { ok, error }; onProgress(key, state, error)
// with state 'removing' | 'done' | 'failed'. A failure never stops the rest.
// -> { done: [keys], failed: [{ key, error }] }
export async function removeRows(rows, remove, onProgress = () => {}) {
  const done = []
  const failed = []
  for (const row of rows) {
    onProgress(row.key, 'removing')
    let res
    try {
      res = await remove(row)
    } catch (err) {
      res = { ok: false, error: (err && err.message) || String(err) }
    }
    if (res && res.ok) {
      done.push(row.key)
      onProgress(row.key, 'done')
    } else {
      const error = (res && res.error) || t('cleanup.unknownError', 'Unknown error')
      failed.push({ key: row.key, error })
      onProgress(row.key, 'failed', error)
    }
  }
  return { done, failed }
}
