// The Source Control words of shared/sourceControl.js (Orca's decisions,
// kept in English there: the main process and its tests use them too), shown
// in the interface's language. scmText() takes the English the shared code
// returns (a button label, a reason in a tooltip) and gives it translated;
// text it does not know is shown as it is.
import { t } from './i18n'
import { discardDeletesEntryFile } from '../../shared/sourceControl'

// English (as shared/sourceControl.js writes it) -> its translation.
const EXACT = {
  Commit: () => t('changes.sc.commit', 'Commit'),
  'Stage All': () => t('changes.sc.stageAll', 'Stage All'), // i18n-ignore
  Push: () => t('changes.sc.push', 'Push'),
  Pull: () => t('changes.sc.pull', 'Pull'),
  Sync: () => t('changes.sc.sync', 'Sync'),
  Fetch: () => t('changes.sc.fetch', 'Fetch'),
  'Fast-forward': () => t('changes.sc.fastForward', 'Fast-forward'),
  'Publish Branch': () => t('changes.sc.publishBranch', 'Publish Branch'), // i18n-ignore
  'No Branch': () => t('changes.sc.noBranch', 'No Branch'), // i18n-ignore
  'Commit & Push': () => t('changes.sc.commitPush', 'Commit & Push'), // i18n-ignore
  'Commit & Sync': () => t('changes.sc.commitSync', 'Commit & Sync'), // i18n-ignore
  'Commit in progress…': () => t('changes.sc.commitInProgress', 'Commit in progress…'), // i18n-ignore
  'Remote operation in progress — try again once it finishes': () => // i18n-ignore
    t('changes.sc.remoteBusyRetry', 'Remote operation in progress — try again once it finishes'),
  'Remote operation in progress…': () => t('changes.sc.remoteBusy', 'Remote operation in progress…'), // i18n-ignore
  'Resolve conflicts before committing': () => t('changes.sc.resolveFirst', 'Resolve conflicts before committing'), // i18n-ignore
  'Commit staged changes': () => t('changes.sc.commitStaged', 'Commit staged changes'), // i18n-ignore
  'Enter a commit message to commit': () => t('changes.sc.enterMessage', 'Enter a commit message to commit'), // i18n-ignore
  'Stage all changes': () => t('changes.sc.stageAllChanges', 'Stage all changes'), // i18n-ignore
  'Stage at least one file to commit': () => t('changes.sc.stageOne', 'Stage at least one file to commit'), // i18n-ignore
  'Check out a branch before publishing commits.': () => // i18n-ignore
    t('changes.sc.checkoutBeforePublishDot', 'Check out a branch before publishing commits.'),
  'Check out a branch before publishing commits': () => // i18n-ignore
    t('changes.sc.checkoutBeforePublish', 'Check out a branch before publishing commits'),
  'Publish this branch to origin': () => t('changes.sc.publishToOrigin', 'Publish this branch to origin'), // i18n-ignore
  'Nothing to commit. Branch is up to date.': () => // i18n-ignore
    t('changes.sc.nothingToCommit', 'Nothing to commit. Branch is up to date.'),
  'Checking branch status…': () => t('changes.sc.checkingBranch', 'Checking branch status…'), // i18n-ignore
  'Check out a branch before pushing commits': () => // i18n-ignore
    t('changes.sc.checkoutBeforePush', 'Check out a branch before pushing commits'),
  'Publish the branch first to push commits': () => // i18n-ignore
    t('changes.sc.publishBeforePush', 'Publish the branch first to push commits'),
  'Commit staged changes and try to push': () => // i18n-ignore
    t('changes.sc.commitTryPush', 'Commit staged changes and try to push'),
  'Commit staged changes and push': () => t('changes.sc.commitAndPush', 'Commit staged changes and push'), // i18n-ignore
  'Check out a branch before syncing commits': () => // i18n-ignore
    t('changes.sc.checkoutBeforeSync', 'Check out a branch before syncing commits'),
  'Publish the branch first to sync commits': () => // i18n-ignore
    t('changes.sc.publishBeforeSync', 'Publish the branch first to sync commits'),
  'Commit, then pull and push': () => t('changes.sc.commitPullPush', 'Commit, then pull and push'), // i18n-ignore
  'Push this branch and set an upstream if needed': () => // i18n-ignore
    t('changes.sc.pushSetUpstream', 'Push this branch and set an upstream if needed'),
  'Push local commits; git may require syncing first': () => // i18n-ignore
    t('changes.sc.pushMaySync', 'Push local commits; git may require syncing first'),
  'Nothing to push': () => t('changes.sc.nothingToPush', 'Nothing to push'), // i18n-ignore
  'Check out a branch before pulling commits': () => // i18n-ignore
    t('changes.sc.checkoutBeforePull', 'Check out a branch before pulling commits'),
  'Publish the branch first to pull commits': () => // i18n-ignore
    t('changes.sc.publishBeforePull', 'Publish the branch first to pull commits'),
  'Nothing to pull': () => t('changes.sc.nothingToPull', 'Nothing to pull'), // i18n-ignore
  'Check out a branch before fast-forwarding': () => // i18n-ignore
    t('changes.sc.checkoutBeforeFf', 'Check out a branch before fast-forwarding'),
  'Publish the branch first to fast-forward': () => // i18n-ignore
    t('changes.sc.publishBeforeFf', 'Publish the branch first to fast-forward'),
  'Nothing to fast-forward': () => t('changes.sc.nothingToFf', 'Nothing to fast-forward'), // i18n-ignore
  'Try a fast-forward pull; git may reject local commits': () => // i18n-ignore
    t('changes.sc.tryFf', 'Try a fast-forward pull; git may reject local commits'),
  'Branch is up to date': () => t('changes.sc.upToDate', 'Branch is up to date'), // i18n-ignore
  'Fetch from remote without merging': () => t('changes.sc.fetchHint', 'Fetch from remote without merging'), // i18n-ignore
  'Branch is already published': () => t('changes.sc.alreadyPublished', 'Branch is already published') // i18n-ignore
}

// English with numbers or names in it.
const PATTERNS = [
  [/^Push (\d+) commits?$/, (m) => commits('push', +m[1])],
  [/^Pull (\d+) commits?$/, (m) => commits('pull', +m[1])],
  [/^Fast-forward (\d+) commits?$/, (m) => commits('fastForward', +m[1])],
  [/^Pull (\d+), push (\d+)$/, (m) => t('changes.sc.pullPush', 'Pull {{behind}}, push {{ahead}}', { behind: m[1], ahead: m[2] })],
  [/^Nothing to push to (.+)$/, (m) => t('changes.sc.nothingToPushTo', 'Nothing to push to {{upstream}}', { upstream: m[1] })],
  [/^Sync \(↓(\d+) ↑(\d+)\)$/, (m) => t('changes.sc.syncCounts', 'Sync (↓{{behind}} ↑{{ahead}})', { behind: m[1], ahead: m[2] })],
  [/^(Push|Pull|Fast-forward) \((\d+)\)$/, (m) => t('changes.sc.withCount', '{{action}} ({{count}})', { action: scmText(m[1]), count: m[2] })],
  [/^(.+) in progress…$/, (m) => t('changes.sc.inProgress', '{{action}} in progress…', { action: scmText(m[1]) })]
]

function commits(kind, n) {
  if (kind === 'push')
    return n === 1
      ? t('changes.sc.pushCommits', 'Push {{count}} commit', { count: n })
      : t('changes.sc.pushCommits', 'Push {{count}} commits', { count: n })
  if (kind === 'pull')
    return n === 1
      ? t('changes.sc.pullCommits', 'Pull {{count}} commit', { count: n })
      : t('changes.sc.pullCommits', 'Pull {{count}} commits', { count: n })
  return n === 1
    ? t('changes.sc.ffCommits', 'Fast-forward {{count}} commit', { count: n })
    : t('changes.sc.ffCommits', 'Fast-forward {{count}} commits', { count: n })
}

export function scmText(text) {
  if (text == null || text === '') return text
  const exact = Object.prototype.hasOwnProperty.call(EXACT, text) ? EXACT[text] : null
  if (exact) return exact()
  for (const [re, fn] of PATTERNS) {
    const m = re.exec(text)
    if (m) return fn(m)
  }
  return text
}

// --- Words of the file list -------------------------------------------------------
export function statusTitle(status) {
  switch (status) {
    case 'modified':
      return t('changes.status.modified', 'Modified')
    case 'added':
      return t('changes.status.added', 'Added')
    case 'deleted':
      return t('changes.status.deleted', 'Deleted')
    case 'renamed':
      return t('changes.status.renamed', 'Renamed')
    case 'untracked':
      return t('changes.status.untracked', 'Untracked')
    case 'copied':
      return t('changes.status.copied', 'Copied')
    default:
      return status
  }
}

export function sectionLabel(section) {
  if (section.id === 'conflicts') return t('changes.section.conflicts', 'Conflicts')
  if (section.area === 'staged') return t('changes.section.staged', 'Staged Changes')
  if (section.area === 'untracked') return t('changes.section.untracked', 'Untracked Files')
  return t('changes.section.unstaged', 'Changes')
}

export function conflictKindLabel(kind) {
  switch (kind) {
    case 'both_modified':
      return t('changes.conflict.bothModified', 'both modified')
    case 'both_added':
      return t('changes.conflict.bothAdded', 'both added')
    case 'deleted_by_us':
      return t('changes.conflict.deletedByUs', 'deleted by us')
    case 'deleted_by_them':
      return t('changes.conflict.deletedByThem', 'deleted by them')
    case 'added_by_us':
      return t('changes.conflict.addedByUs', 'added by us')
    case 'added_by_them':
      return t('changes.conflict.addedByThem', 'added by them')
    case 'both_deleted':
      return t('changes.conflict.bothDeleted', 'both deleted')
    default:
      return kind
  }
}

export function conflictTitle(operation) {
  if (operation === 'merge') return t('changes.conflict.merge', 'Merge conflicts')
  if (operation === 'rebase') return t('changes.conflict.rebase', 'Rebase conflicts')
  if (operation === 'cherry-pick') return t('changes.conflict.cherryPick', 'Cherry-pick conflicts')
  return t('changes.conflict.generic', 'Conflicts')
}

export function operationTitle(operation) {
  if (operation === 'merge') return t('changes.operation.merge', 'Merge in progress')
  if (operation === 'rebase') return t('changes.operation.rebase', 'Rebase in progress')
  if (operation === 'cherry-pick') return t('changes.operation.cherryPick', 'Cherry-pick in progress')
  return t('changes.operation.generic', 'Operation in progress')
}

// A note's place: "whole file", "lines 3-5", "line 3".
export function listLineLabel(c) {
  if (c.lineNumber === 0) return t('changes.notes.wholeFile', 'whole file')
  if (c.startLine !== undefined && c.startLine !== null && c.startLine !== c.lineNumber)
    return t('changes.notes.linesLower', 'lines {{start}}-{{end}}', { start: c.startLine, end: c.lineNumber })
  return t('changes.notes.lineLower', 'line {{line}}', { line: c.lineNumber })
}

// --- Discard confirmations (shared getDiscard*ConfirmationCopy, translated) -------
const baseName = (p) => String(p || '').split('/').pop()

// remote: a remote project's files go to the host's trash instead.
export function discardEntryCopy(entry, { remote = false } = {}) {
  const name = baseName(entry.path)
  if (discardDeletesEntryFile(entry)) {
    return {
      title: t('changes.discard.deleteTitle', 'Delete "{{name}}"?', { name }),
      description: remote
        ? t('changes.discard.deleteTextRemote', 'This will move this file to the trash on the remote host.')
        : t('changes.discard.deleteText', 'This will move this file to the Recycle Bin.'),
      confirmLabel: t('changes.discard.delete', 'Delete')
    }
  }
  if (entry.status === 'deleted') {
    return {
      title: t('changes.discard.restoreTitle', 'Restore "{{name}}"?', { name }),
      description: t('changes.discard.restoreText', 'This will restore the file and discard the deletion. This cannot be undone.'),
      confirmLabel: t('changes.discard.restore', 'Restore')
    }
  }
  return {
    title: t('changes.discard.discardTitle', 'Discard changes to "{{name}}"?', { name }),
    description: t('changes.discard.discardText', 'This will revert all changes to this file. This cannot be undone.'),
    confirmLabel: t('changes.discard.discard', 'Discard')
  }
}

export function discardAreaCopy(area, count, { remote = false } = {}) {
  if (area === 'untracked') {
    return count === 1
      ? {
          title: t('changes.discard.deleteUntrackedTitle', 'Delete 1 untracked file?', { count }),
          description: remote
            ? t('changes.discard.deleteUntrackedTextRemote', 'This will move this untracked file to the trash on the remote host.', { count })
            : t('changes.discard.deleteUntrackedText', 'This will move this untracked file to the Recycle Bin.', { count }),
          confirmLabel: t('changes.discard.delete', 'Delete')
        }
      : {
          title: t('changes.discard.deleteUntrackedTitle', 'Delete {{count}} untracked files?', { count }),
          description: remote
            ? t('changes.discard.deleteUntrackedTextRemote', 'This will move these {{count}} untracked files to the trash on the remote host.', { count })
            : t('changes.discard.deleteUntrackedText', 'This will move these {{count}} untracked files to the Recycle Bin.', { count }),
          confirmLabel: t('changes.discard.deleteCount', 'Delete {{count}}', { count })
        }
  }
  return {
    title: t('changes.discard.discardAllTitle', 'Discard all unstaged changes?'),
    description:
      count === 1
        ? t('changes.discard.discardAllText', 'This will revert the unstaged changes in 1 file. This cannot be undone.', { count })
        : t('changes.discard.discardAllText', 'This will revert unstaged changes in {{count}} files. This cannot be undone.', { count }),
    confirmLabel: t('changes.discard.discardAll', 'Discard all')
  }
}
