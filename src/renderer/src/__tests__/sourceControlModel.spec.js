// The logic ported from Orca's source control (shared/sourceControl.js), the
// review notes store, diff tab paths and the Add Review Note selection.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildDisplaySections,
  resolvePrimaryAction,
  resolveDropdownItems,
  getDiscardEntryConfirmationCopy,
  getDiscardAreaConfirmationCopy,
  getCommitMessageTextareaRows,
  formatDiffComment,
  formatDiffComments,
  getDiffCommentLineLabel,
  canDiscardStatusEntry,
  canStageStatusEntry
} from '../../../shared/sourceControl'
import { addNote, notesFor, updateNote, deleteNote, clearNotes, clearDelivered } from '../reviewNotes'
import { diffTabPath, docPathOf, isDiffTabPath, validSavedFiles, openTab } from '../editor/editorTabs'
import { selectionTarget, isAddReviewNoteChord } from '../editor/diffNotes'
import {
  buildSourceControlTree,
  compactSourceControlTree,
  flattenSourceControlTree,
  sectionTreeRows,
  getSourceControlDirectoryActionPaths
} from '../../../shared/sourceControlTree'
import {
  buildGitHistoryViewModels,
  buildDefaultGitHistoryColorMap,
  gitHistoryGraphGeometry,
  dedupeRemoteTrackingRefs
} from '../../../shared/gitHistoryGraph'
import { getFileTypeIcon } from '../fileTypeIcons'
import { File, FileBox, FileCode, FileLock, FileText } from 'lucide-vue-next'

describe('sections and row actions', () => {
  it('Changes first, conflicts pinned on top, each group sorted', () => {
    const s = buildDisplaySections([
      { path: 'z.js', area: 'unstaged', status: 'modified' },
      { path: 'a.js', area: 'untracked', status: 'untracked' },
      { path: 'b.js', area: 'staged', status: 'added' },
      { path: 'c.js', area: 'unstaged', status: 'modified' },
      { path: 'x.js', area: 'unstaged', status: 'modified', conflictStatus: 'unresolved' }
    ])
    expect(s.map((x) => [x.id, x.items.map((i) => i.path)])).toEqual([
      ['conflicts', ['x.js']],
      ['unstaged', ['c.js', 'z.js']],
      ['staged', ['b.js']],
      ['untracked', ['a.js']]
    ])
  })
  it('a conflict is never staged nor discarded; staged rows are not discarded', () => {
    const c = { area: 'unstaged', conflictStatus: 'unresolved' }
    expect(canStageStatusEntry(c)).toBe(false)
    expect(canDiscardStatusEntry(c)).toBe(false)
    expect(canDiscardStatusEntry({ area: 'staged' })).toBe(false)
    expect(canDiscardStatusEntry({ area: 'untracked' })).toBe(true)
  })
  it("discard copy: Orca's words, untracked to the Recycle Bin", () => {
    expect(getDiscardEntryConfirmationCopy({ path: 'src/a.js', area: 'unstaged', status: 'modified' })).toEqual({
      title: 'Discard changes to "a.js"?',
      description: 'This will revert all changes to this file. This cannot be undone.',
      confirmLabel: 'Discard'
    })
    expect(getDiscardEntryConfirmationCopy({ path: 'gone.js', area: 'unstaged', status: 'deleted' }).title).toBe('Restore "gone.js"?')
    expect(getDiscardEntryConfirmationCopy({ path: 'n.txt', area: 'untracked', status: 'untracked' })).toMatchObject({ title: 'Delete "n.txt"?', confirmLabel: 'Delete' })
    expect(getDiscardAreaConfirmationCopy('untracked', 3)).toMatchObject({ title: 'Delete 3 untracked files?', confirmLabel: 'Delete 3' })
    expect(getDiscardAreaConfirmationCopy('unstaged', 2).title).toBe('Discard all unstaged changes?')
  })
  it('commit box rows: 2 to 12', () => {
    expect(getCommitMessageTextareaRows('')).toBe(2)
    expect(getCommitMessageTextareaRows('a\nb\nc')).toBe(3)
    expect(getCommitMessageTextareaRows('\n'.repeat(40))).toBe(12)
  })
})

describe("Orca's primary action and menu", () => {
  const up = (ahead, behind, hasUpstream = true) => ({ hasUpstream, ahead, behind, upstreamName: 'origin/main' })
  const p = (i) => resolvePrimaryAction(i)
  it('walks the ladder', () => {
    expect(p({ isCommitting: true })).toMatchObject({ kind: 'commit', disabled: true, title: 'Commit in progress…' })
    expect(p({ isRemoteOperationActive: true, inFlightRemoteOpKind: 'push' })).toMatchObject({ kind: 'push', label: 'Push', disabled: true, title: 'Push in progress…' })
    expect(p({ hasUnresolvedConflicts: true, stagedCount: 1, hasMessage: true })).toMatchObject({ disabled: true, title: 'Resolve conflicts before committing' })
    expect(p({ stagedCount: 1, hasMessage: true })).toMatchObject({ kind: 'commit', disabled: false })
    expect(p({ stagedCount: 1 })).toMatchObject({ kind: 'commit', disabled: true, title: 'Enter a commit message to commit' })
    expect(p({ hasStageableChanges: true })).toMatchObject({ kind: 'stage', label: 'Stage All' })
    expect(p({ upstreamStatus: up(0, 0, false) })).toMatchObject({ kind: 'publish', label: 'Publish Branch' })
    expect(p({ upstreamStatus: up(0, 0, false), hasCurrentBranch: false })).toMatchObject({ disabled: true })
    expect(p({ upstreamStatus: up(2, 3) })).toMatchObject({ kind: 'sync', title: 'Pull 3, push 2' })
    expect(p({ upstreamStatus: up(0, 1) })).toMatchObject({ kind: 'pull', title: 'Pull 1 commit' })
    expect(p({ upstreamStatus: up(4, 0) })).toMatchObject({ kind: 'push', title: 'Push 4 commits' })
    expect(p({ upstreamStatus: up(0, 0) })).toMatchObject({ kind: 'commit', disabled: true, title: 'Nothing to commit. Branch is up to date.' })
  })
  it('the menu keeps every row, disabled with a reason', () => {
    const items = resolveDropdownItems({ stagedCount: 1, hasMessage: true, upstreamStatus: up(1, 2) })
    const by = Object.fromEntries(items.filter((i) => i.kind !== 'separator').map((i) => [i.kind, i]))
    expect(by.commit_push).toMatchObject({ disabled: false, title: 'Commit staged changes and try to push' })
    expect(by.push.label).toBe('Push (1)')
    expect(by.pull.label).toBe('Pull (2)')
    expect(by.sync.label).toBe('Sync (↓2 ↑1)')
    expect(by.publish).toMatchObject({ disabled: true, title: 'Branch is already published' })
    const none = resolveDropdownItems({ stagedCount: 0, upstreamStatus: up(0, 0, false) })
    const b2 = Object.fromEntries(none.filter((i) => i.kind !== 'separator').map((i) => [i.kind, i]))
    expect(b2.commit_push).toMatchObject({ disabled: true, title: 'Publish the branch first to push commits' })
    expect(b2.push).toMatchObject({ disabled: false, title: 'Push this branch and set an upstream if needed' })
    expect(b2.publish.disabled).toBe(false)
  })
})

describe('review notes', () => {
  const R = 'C:\\repo'
  beforeEach(() => clearNotes(R))
  it("formats notes the way Orca sends them (quote-safe)", () => {
    expect(formatDiffComment({ filePath: 'a.js', lineNumber: 3, body: 'Say "hi"\nplease' })).toBe('File: a.js\nLine: 3\nUser comment: "Say \\"hi\\"\\nplease"')
    expect(formatDiffComment({ filePath: 'a.js', startLine: 2, lineNumber: 5, body: 'x' })).toBe('File: a.js\nLines: 2-5\nUser comment: "x"')
    expect(formatDiffComments([{ filePath: 'a', lineNumber: 1, body: 'x' }, { filePath: 'b', lineNumber: 2, body: 'y' }])).toContain('\n\nFile: b')
    expect(getDiffCommentLineLabel({ startLine: 2, lineNumber: 5 }, true)).toBe('L2-L5')
    expect(getDiffCommentLineLabel({ lineNumber: 5 })).toBe('Line 5')
  })
  it('adds, edits, deletes, keeps them per repository (any separators), and clears what was delivered', () => {
    const a = addNote({ repo: R, filePath: 'a.js', lineNumber: 4, startLine: 2, body: '  first ' })
    expect(a).toMatchObject({ filePath: 'a.js', startLine: 2, lineNumber: 4, body: 'first' })
    const b = addNote({ repo: 'c:/REPO/', filePath: 'b.js', lineNumber: 1, body: 'second' })
    expect(notesFor(R).map((n) => n.id)).toEqual([a.id, b.id])
    expect(addNote({ repo: R, filePath: 'a.js', lineNumber: 1, body: '   ' })).toBeNull()
    const snapshot = notesFor(R).map((n) => ({ ...n }))
    updateNote(R, a.id, 'edited while sending')
    clearDelivered(R, snapshot)
    expect(notesFor(R).map((n) => n.body)).toEqual(['edited while sending'])
    deleteNote(R, a.id)
    expect(notesFor(R)).toHaveLength(0)
  })
})

describe('diff tabs and the Add Review Note chord', () => {
  it('a diff tab has its own path, never restored after a restart', () => {
    const p = diffTabPath('C:\\p\\a.js', 'staged')
    expect(isDiffTabPath(p)).toBe(true)
    expect(docPathOf({ path: p })).toBe('C:\\p\\a.js')
    expect(docPathOf({ path: p, diff: { full: 'C:\\p\\a.js' } })).toBe('C:\\p\\a.js')
    const res = openTab([{ path: 'C:\\p\\a.js' }], 'C:\\p\\a.js', p)
    expect(res.files.map((f) => f.path)).toEqual(['C:\\p\\a.js', p])
    expect(validSavedFiles([{ path: p }, { path: 'C:\\p\\a.js' }]).map((f) => f.path)).toEqual(['C:\\p\\a.js'])
  })
  it('Ctrl+Shift+A on a selection: its lines (a selection ending at column 1 stops the line before)', () => {
    expect(isAddReviewNoteChord({ ctrlKey: true, shiftKey: true, altKey: false, code: 'KeyA', key: 'A' })).toBe(true)
    expect(isAddReviewNoteChord({ ctrlKey: true, shiftKey: false, altKey: false, code: 'KeyA', key: 'a' })).toBe(false)
    expect(selectionTarget({ startLineNumber: 3, endLineNumber: 3, endColumn: 5 })).toEqual({ lineNumber: 3 })
    expect(selectionTarget({ startLineNumber: 3, endLineNumber: 6, endColumn: 1 })).toEqual({ lineNumber: 5, startLine: 3 })
    expect(selectionTarget(null)).toBeNull()
  })
})

describe("Orca's source control tree (shared/sourceControlTree.js)", () => {
  const e = (path, area = 'unstaged', extra = {}) => ({ path, area, status: 'modified', ...extra })
  it('builds folders first, numeric order, file counts per folder', () => {
    const tree = buildSourceControlTree('unstaged', [e('src/file10.js'), e('src/file2.js'), e('a/b/c.js'), e('root.js')])
    expect(tree.map((n) => [n.type, n.name, n.fileCount])).toEqual([
      ['directory', 'a', 1],
      ['directory', 'src', 2],
      ['file', 'root.js', undefined]
    ])
    expect(tree[1].children.map((n) => n.name)).toEqual(['file2.js', 'file10.js'])
  })

  it('compacts chains of single folders and flattens without collapsed folders', () => {
    const roots = compactSourceControlTree(buildSourceControlTree('unstaged', [e('a/b/c.js'), e('a/b/d.js'), e('x.js')]))
    expect(roots.map((n) => [n.name, n.depth])).toEqual([
      ['a/b', 0],
      ['x.js', 0]
    ])
    expect(flattenSourceControlTree(roots).map((n) => [n.name, n.depth])).toEqual([
      ['a/b', 0],
      ['c.js', 1],
      ['d.js', 1],
      ['x.js', 0]
    ])
    expect(flattenSourceControlTree(roots, new Set([roots[0].key])).map((n) => n.name)).toEqual(['a/b', 'x.js'])
  })

  it('conflicts first inside a folder; the Conflicts section has its own folder keys', () => {
    const rows = sectionTreeRows({ id: 'conflicts', area: 'unstaged', items: [e('d/z.js', 'unstaged', { conflictStatus: 'unresolved' }), e('d/a.js')] }, new Set())
    expect(rows.map((n) => n.name)).toEqual(['d', 'z.js', 'a.js'])
    expect(rows[0].key).toBe('dir::conflicts::d')
  })

  it("a folder's actions: stage / unstage / discard what it holds", () => {
    const [dir] = buildSourceControlTree('unstaged', [e('d/a.js'), e('d/c.js', 'unstaged', { conflictStatus: 'unresolved' })])
    expect(getSourceControlDirectoryActionPaths(dir)).toEqual({ stagePaths: ['d/a.js'], unstagePaths: [], discardPaths: ['d/a.js'] })
    const [staged] = buildSourceControlTree('staged', [e('d/s.js', 'staged')])
    expect(getSourceControlDirectoryActionPaths(staged)).toEqual({ stagePaths: [], unstagePaths: ['d/s.js'], discardPaths: [] })
  })
})

describe("Orca's commit graph (shared/gitHistoryGraph.js)", () => {
  const item = (id, parentIds, references = []) => ({ id, parentIds, subject: id, references })
  it('one lane for a straight history; HEAD marked; a merge opens a second lane', () => {
    const currentRef = { id: 'refs/heads/main', name: 'main', revision: 'm' }
    const items = [item('m', ['a', 'b'], [{ id: 'refs/heads/main', name: 'main', category: 'branches' }]), item('b', ['a']), item('a', [])]
    const vms = buildGitHistoryViewModels(items, buildDefaultGitHistoryColorMap({ currentRef }), currentRef)
    expect(vms.map((v) => v.kind)).toEqual(['HEAD', 'node', 'node'])
    expect(vms[0].outputSwimlanes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(vms[0].outputSwimlanes[0].color).toBe('git-graph-ref')
    expect(vms[0].historyItem.references[0].color).toBe('git-graph-ref')
    const geo = gitHistoryGraphGeometry(vms[0])
    expect(geo).toMatchObject({ cx: 11, cy: 12, isMerge: true, width: 33 })
    expect(geo.paths.map((p) => p.key)).toEqual(['merge-parent-b', 'out-of-node'])
    expect(gitHistoryGraphGeometry(vms[2]).paths.map((p) => p.key)).toEqual(['base-a', 'into-node']) // the merged lane joins back
  })

  it('drops origin/x when the local x is on the same commit', () => {
    const refs = [
      { id: 'refs/heads/main', name: 'main', category: 'branches' },
      { id: 'refs/remotes/origin/main', name: 'origin/main', category: 'remote branches' },
      { id: 'refs/remotes/origin/other', name: 'origin/other', category: 'remote branches' }
    ]
    expect(dedupeRemoteTrackingRefs(refs).map((r) => r.name)).toEqual(['main', 'origin/other'])
    expect(dedupeRemoteTrackingRefs(refs, { preserveRefIds: ['refs/remotes/origin/main'] })).toHaveLength(3)
  })
})

describe('file type icons (Orca lib/file-type-icons.ts)', () => {
  it('by name, then by extension, else a plain file', () => {
    expect(getFileTypeIcon('src/package.json')).toBe(FileBox)
    expect(getFileTypeIcon('a\\b\\x.vue')).toBe(FileCode)
    expect(getFileTypeIcon('notes.md')).toBe(FileText)
    expect(getFileTypeIcon('.env.local')).toBe(FileLock)
    expect(getFileTypeIcon('noext')).toBe(File)
  })
})

describe('commit diff tabs', () => {
  it('a file of a commit gets its own tab per commit', () => {
    const p = diffTabPath('C:\\p\\a.js', 'commit', 'abc1234')
    expect(isDiffTabPath(p)).toBe(true)
    expect(p).not.toBe(diffTabPath('C:\\p\\a.js', 'commit', 'def5678'))
    expect(p).not.toBe(diffTabPath('C:\\p\\a.js', 'unstaged'))
  })

  it('a file committed on the branch gets its own tab per base and HEAD', () => {
    const p = diffTabPath('C:\\p\\a.js', 'branch', 'abc1234', 'fed9876')
    expect(isDiffTabPath(p)).toBe(true)
    expect(docPathOf({ path: p, diff: { full: 'C:\\p\\a.js' } })).toBe('C:\\p\\a.js')
    expect(p).not.toBe(diffTabPath('C:\\p\\a.js', 'commit', 'abc1234'))
    expect(p).not.toBe(diffTabPath('C:\\p\\a.js', 'branch', 'abc1234', '0001111'))
    expect(validSavedFiles([{ path: p }])).toEqual([])
  })
})
