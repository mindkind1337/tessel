// The Changes tab's logic, ported from Orca's source control (MIT, Copyright
// (c) 2026 Lovecast Inc.): status-display.ts, listing/section-order.ts,
// listing/entry-actions.ts, commit/discard-all-sequence.ts,
// commit/discard-confirmation.ts, commit/commit-message-rows.ts,
// shared/source-control-primary-action-decision.ts,
// source-control-primary-action.ts, source-control-dropdown-*.ts and
// shared/diff-comments-format.ts. Pure: the Vue components render it.
//
// An entry: { path, oldPath?, area: 'staged'|'unstaged'|'untracked',
// status: 'modified'|'added'|'deleted'|'renamed'|'copied'|'untracked',
// conflictStatus?: 'unresolved', conflictKind?, added?, removed? }

export const STATUS_LABELS = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', copied: 'C' }
export const STATUS_COLORS = {
  modified: 'var(--git-decoration-modified)',
  added: 'var(--git-decoration-added)',
  deleted: 'var(--git-decoration-deleted)',
  renamed: 'var(--git-decoration-renamed)',
  untracked: 'var(--git-decoration-untracked)',
  copied: 'var(--git-decoration-copied)'
}
export const STATUS_TITLES = { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', untracked: 'Untracked', copied: 'Copied' }

// --- Sections (Orca's section-order.ts, default "changes-first") ------------------
export const SOURCE_CONTROL_AREAS = ['unstaged', 'staged', 'untracked']
export const SECTION_LABELS = { staged: 'Staged Changes', unstaged: 'Changes', untracked: 'Untracked Files' }
export const CONFLICTS_SECTION_LABEL = 'Conflicts'

export function isPinnedConflictEntry(entry) {
  return entry.conflictStatus === 'unresolved' || entry.conflictStatus === 'resolved_locally'
}

export function groupEntries(entries) {
  const groups = { staged: [], unstaged: [], untracked: [] }
  for (const e of entries || []) if (groups[e.area]) groups[e.area].push(e)
  // Orca sorts each group by path (source-control-status-sort.ts).
  for (const a of SOURCE_CONTROL_AREAS) groups[a].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
  return groups
}

// -> [{ id: 'conflicts'|area, area, items }] with unresolved conflicts pinned first.
export function buildDisplaySections(entries, order = SOURCE_CONTROL_AREAS) {
  const groups = groupEntries(entries)
  const pinned = SOURCE_CONTROL_AREAS.flatMap((a) => groups[a].filter(isPinnedConflictEntry))
  const sections = []
  if (pinned.length) sections.push({ id: 'conflicts', area: 'unstaged', items: pinned })
  for (const area of order) {
    const items = groups[area].filter((e) => !isPinnedConflictEntry(e))
    if (items.length) sections.push({ id: area, area, items })
  }
  return sections
}

// --- What a row may do (entry-actions.ts, discard-all-sequence.ts) ----------------
export function isStageableStatusEntry(entry) {
  return (entry.area === 'unstaged' || entry.area === 'untracked') && entry.conflictStatus !== 'unresolved'
}
export const canStageStatusEntry = isStageableStatusEntry
export function canUnstageStatusEntry(entry) {
  return entry.area === 'staged'
}
export function canDiscardStatusEntry(entry) {
  return (
    entry.conflictStatus !== 'unresolved' &&
    entry.conflictStatus !== 'resolved_locally' &&
    (entry.area === 'unstaged' || entry.area === 'untracked')
  )
}
export function getDiscardAllPaths(entries, area) {
  return entries
    .filter((e) => e.area === area && e.conflictStatus !== 'unresolved' && e.conflictStatus !== 'resolved_locally')
    .map((e) => e.path)
}
export function getUnstageAllPaths(entries) {
  return entries.filter((e) => e.area === 'staged').map((e) => e.path)
}
export function getStageAllPaths(entries) {
  return entries.filter(isStageableStatusEntry).map((e) => e.path)
}

// --- Discard confirmations (discard-confirmation.ts) -------------------------------
// Orca deletes untracked files for good; Tessel moves them to the Recycle Bin,
// so the "delete" copy says where they go instead of "cannot be undone".
const baseName = (p) => String(p || '').split('/').pop()

export function discardDeletesEntryFile(entry) {
  return entry.area === 'untracked' || entry.status === 'untracked' || entry.status === 'added'
}

export function getDiscardEntryConfirmationCopy(entry) {
  const name = baseName(entry.path)
  if (discardDeletesEntryFile(entry)) {
    return {
      title: `Delete "${name}"?`,
      description: 'This will move this file to the Recycle Bin.',
      confirmLabel: 'Delete'
    }
  }
  if (entry.status === 'deleted') {
    return {
      title: `Restore "${name}"?`,
      description: 'This will restore the file and discard the deletion. This cannot be undone.',
      confirmLabel: 'Restore'
    }
  }
  return {
    title: `Discard changes to "${name}"?`,
    description: 'This will revert all changes to this file. This cannot be undone.',
    confirmLabel: 'Discard'
  }
}

export function getDiscardAreaConfirmationCopy(area, count) {
  if (area === 'untracked') {
    return {
      title: count === 1 ? 'Delete 1 untracked file?' : `Delete ${count} untracked files?`,
      description:
        count === 1
          ? 'This will move this untracked file to the Recycle Bin.'
          : `This will move these ${count} untracked files to the Recycle Bin.`,
      confirmLabel: count === 1 ? 'Delete' : `Delete ${count}`
    }
  }
  return {
    title: 'Discard all unstaged changes?',
    description:
      count === 1
        ? 'This will revert the unstaged changes in 1 file. This cannot be undone.'
        : `This will revert unstaged changes in ${count} files. This cannot be undone.`,
    confirmLabel: 'Discard all'
  }
}

// --- Commit message box (commit-message-rows.ts) ---------------------------------
export function getCommitMessageTextareaRows(message) {
  const m = String(message || '')
  if (!m.length) return 2
  let rows = 1
  const scan = Math.min(m.length, 64 * 1024)
  for (let i = 0; i < scan && rows < 12; i++) if (m.charCodeAt(i) === 10) rows++
  return Math.min(12, Math.max(2, rows))
}

// --- Primary action (source-control-primary-action-decision.ts) --------------------
// inputs: { stagedCount, hasUnstagedChanges, hasStageableChanges, hasMessage,
//   hasUnresolvedConflicts, isCommitting, isRemoteOperationActive,
//   inFlightRemoteOpKind, upstreamStatus: { hasUpstream, ahead, behind, upstreamName } | null,
//   hasCurrentBranch }
// -> { kind: 'commit'|'stage'|'push'|'pull'|'sync'|'publish', label, title, disabled }
function describePushCount(n) {
  return `Push ${n} commit${n === 1 ? '' : 's'}`
}
function describePullCount(n) {
  return `Pull ${n} commit${n === 1 ? '' : 's'}`
}
function describeSyncCounts(ahead, behind) {
  return `Pull ${behind}, push ${ahead}`
}
const LABELS = { commit: 'Commit', stage: 'Stage All', push: 'Push', pull: 'Pull', sync: 'Sync', publish: 'Publish Branch' }

function action(kind, title, disabled) {
  return { kind, label: LABELS[kind], title, disabled }
}

export function resolvePrimaryAction(inputs) {
  const {
    stagedCount = 0,
    hasUnstagedChanges = false,
    hasStageableChanges = false,
    hasMessage = false,
    hasUnresolvedConflicts = false,
    isCommitting = false,
    isRemoteOperationActive = false,
    inFlightRemoteOpKind = null,
    upstreamStatus = null,
    hasCurrentBranch = true
  } = inputs || {}
  if (isCommitting) return action('commit', 'Commit in progress…', true)
  if (isRemoteOperationActive) {
    // The label of the running operation stays, disabled (source-control-primary-action-in-flight.ts).
    const kind = inFlightRemoteOpKind && LABELS[inFlightRemoteOpKind] ? inFlightRemoteOpKind : null
    if (kind) return action(kind, `${LABELS[kind]} in progress…`, true)
    const base = resolvePrimaryAction({ ...inputs, isRemoteOperationActive: false })
    return { ...base, title: base.kind === 'commit' ? 'Remote operation in progress — try again once it finishes' : 'Remote operation in progress…', disabled: true }
  }
  if (hasUnresolvedConflicts) return action('commit', 'Resolve conflicts before committing', true)
  const hasStaged = stagedCount > 0
  if (hasStaged && hasMessage) return action('commit', 'Commit staged changes', false)
  if (hasStaged && !hasMessage) return action('commit', 'Enter a commit message to commit', true)
  if (!hasStaged && hasStageableChanges) return action('stage', 'Stage all changes', false)
  if (!upstreamStatus) return action('commit', 'Stage at least one file to commit', true)
  if (!upstreamStatus.hasUpstream) {
    if (!hasCurrentBranch) return action('commit', 'Check out a branch before publishing commits.', true)
    return action('publish', 'Publish this branch to origin', false)
  }
  const { ahead = 0, behind = 0 } = upstreamStatus
  if (ahead > 0 && behind > 0) return action('sync', describeSyncCounts(ahead, behind), false)
  if (behind > 0) return action('pull', describePullCount(behind), false)
  if (ahead > 0) return action('push', describePushCount(ahead), false)
  return action('commit', hasUnstagedChanges ? 'Stage at least one file to commit' : 'Nothing to commit. Branch is up to date.', true)
}

// --- The chevron menu (source-control-dropdown-*.ts; every row always shown,
// disabled with its reason) -------------------------------------------------
function countLabel(base, n) {
  return n > 0 ? `${base} (${n})` : base
}
function syncLabel(ahead, behind) {
  return ahead === 0 && behind === 0 ? 'Sync' : `Sync (↓${behind} ↑${ahead})`
}

// inputs: the primary's, plus remoteBusy.
export function resolveDropdownItems(inputs) {
  const {
    stagedCount = 0,
    hasMessage = false,
    hasUnresolvedConflicts = false,
    isCommitting = false,
    isRemoteOperationActive = false,
    upstreamStatus = null,
    hasCurrentBranch = true,
    hasPartiallyStagedChanges = false
  } = inputs || {}
  const globalBusy = isCommitting || isRemoteOperationActive
  const upstreamLoading = !upstreamStatus
  const hasUpstream = !!(upstreamStatus && upstreamStatus.hasUpstream)
  const ahead = (upstreamStatus && upstreamStatus.ahead) || 0
  const behind = (upstreamStatus && upstreamStatus.behind) || 0
  const detached = !hasCurrentBranch
  let commitDisabledReason = null
  if (globalBusy) commitDisabledReason = isCommitting ? 'Commit in progress…' : 'Remote operation in progress…'
  else if (hasUnresolvedConflicts) commitDisabledReason = 'Resolve conflicts before committing'
  else if (stagedCount === 0) commitDisabledReason = 'Stage at least one file to commit'
  else if (!hasMessage) commitDisabledReason = 'Enter a commit message to commit'
  void hasPartiallyStagedChanges
  const canCommit = commitDisabledReason === null

  const commit = { kind: 'commit', label: 'Commit', title: commitDisabledReason ?? 'Commit staged changes', disabled: !canCommit }
  const commitPush = {
    kind: 'commit_push',
    label: 'Commit & Push',
    title: upstreamLoading
      ? 'Checking branch status…'
      : detached
        ? 'Check out a branch before pushing commits'
        : !hasUpstream
          ? 'Publish the branch first to push commits'
          : (commitDisabledReason ?? (behind > 0 ? 'Commit staged changes and try to push' : 'Commit staged changes and push')),
    disabled: globalBusy || upstreamLoading || !hasUpstream || detached || commitDisabledReason !== null
  }
  const commitSync = {
    kind: 'commit_sync',
    label: 'Commit & Sync',
    title: upstreamLoading
      ? 'Checking branch status…'
      : detached
        ? 'Check out a branch before syncing commits'
        : !hasUpstream
          ? 'Publish the branch first to sync commits'
          : (commitDisabledReason ?? 'Commit, then pull and push'),
    disabled: globalBusy || upstreamLoading || !hasUpstream || detached || commitDisabledReason !== null
  }
  const push = {
    kind: 'push',
    label: countLabel('Push', ahead),
    title: detached
      ? 'Check out a branch before pushing commits'
      : upstreamLoading || !hasUpstream
        ? 'Push this branch and set an upstream if needed'
        : behind > 0 && ahead > 0
          ? 'Push local commits; git may require syncing first'
          : ahead === 0
            ? `Nothing to push${upstreamStatus.upstreamName ? ` to ${upstreamStatus.upstreamName}` : ''}`
            : describePushCount(ahead),
    disabled: globalBusy || detached
  }
  const pull = {
    kind: 'pull',
    label: countLabel('Pull', behind),
    title: upstreamLoading
      ? 'Checking branch status…'
      : detached
        ? 'Check out a branch before pulling commits'
        : !hasUpstream
          ? 'Publish the branch first to pull commits'
          : behind === 0
            ? 'Nothing to pull'
            : describePullCount(behind),
    disabled: globalBusy || upstreamLoading || !hasUpstream || detached
  }
  const fastForward = {
    kind: 'fast_forward',
    label: countLabel('Fast-forward', behind),
    title: upstreamLoading
      ? 'Checking branch status…'
      : detached
        ? 'Check out a branch before fast-forwarding'
        : !hasUpstream
          ? 'Publish the branch first to fast-forward'
          : behind === 0
            ? 'Nothing to fast-forward'
            : ahead > 0
              ? 'Try a fast-forward pull; git may reject local commits'
              : `Fast-forward ${behind} commit${behind === 1 ? '' : 's'}`,
    disabled: globalBusy || upstreamLoading || !hasUpstream || detached
  }
  const sync = {
    kind: 'sync',
    label: syncLabel(ahead, behind),
    title: upstreamLoading
      ? 'Checking branch status…'
      : detached
        ? 'Check out a branch before syncing commits'
        : !hasUpstream
          ? 'Publish the branch first to sync commits'
          : ahead === 0 && behind === 0
            ? 'Branch is up to date'
            : describeSyncCounts(ahead, behind),
    disabled: globalBusy || upstreamLoading || !hasUpstream || detached
  }
  const fetch = { kind: 'fetch', label: 'Fetch', title: 'Fetch from remote without merging', disabled: globalBusy }
  const publish = {
    kind: 'publish',
    label: detached ? 'No Branch' : 'Publish Branch',
    title: upstreamLoading
      ? 'Checking branch status…'
      : detached
        ? 'Check out a branch before publishing commits'
        : hasUpstream
          ? 'Branch is already published'
          : 'Publish this branch to origin',
    disabled: globalBusy || upstreamLoading || hasUpstream || detached
  }
  return [commit, commitPush, commitSync, { kind: 'separator', id: 'before-remote' }, push, pull, fastForward, sync, fetch, publish]
}

// --- Review notes (shared/diff-comments-format.ts, lib/diff-comment-compat.ts) -----
// A note: { id, repo, filePath, startLine?, lineNumber, body, createdAt, sentAt? }
export function formatDiffComment(c) {
  const escaped = String(c.body || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  const locationLabel =
    c.lineNumber === 0
      ? 'Scope: file'
      : c.startLine !== undefined && c.startLine !== null && c.startLine !== c.lineNumber
        ? `Lines: ${c.startLine}-${c.lineNumber}`
        : `Line: ${c.lineNumber}`
  return [`File: ${c.filePath}`, locationLabel, `User comment: "${escaped}"`].join('\n')
}
export function formatDiffComments(comments) {
  return (comments || []).map(formatDiffComment).join('\n\n')
}

export function getDiffCommentLineLabel(c, compact = false) {
  if (c.startLine !== undefined && c.startLine !== null && c.startLine !== c.lineNumber) {
    return compact ? `L${c.startLine}-L${c.lineNumber}` : `Lines ${c.startLine}-${c.lineNumber}`
  }
  return compact ? `L${c.lineNumber}` : `Line ${c.lineNumber}`
}

// Orca's localized list label ("whole file", "lines 3-5", "line 3").
export function getListLineLabel(c) {
  if (c.lineNumber === 0) return 'whole file'
  if (c.startLine !== undefined && c.startLine !== null && c.startLine !== c.lineNumber) return `lines ${c.startLine}-${c.lineNumber}`
  return `line ${c.lineNumber}`
}

export const CONFLICT_KIND_LABELS = {
  both_modified: 'both modified',
  both_added: 'both added',
  deleted_by_us: 'deleted by us',
  deleted_by_them: 'deleted by them',
  added_by_us: 'added by us',
  added_by_them: 'added by them',
  both_deleted: 'both deleted'
}

export function conflictSummaryTitle(operation) {
  return operation === 'merge'
    ? 'Merge conflicts'
    : operation === 'rebase'
      ? 'Rebase conflicts'
      : operation === 'cherry-pick'
        ? 'Cherry-pick conflicts'
        : 'Conflicts'
}
export function operationBannerTitle(operation) {
  return operation === 'merge'
    ? 'Merge in progress'
    : operation === 'rebase'
      ? 'Rebase in progress'
      : operation === 'cherry-pick'
        ? 'Cherry-pick in progress'
        : 'Operation in progress'
}
