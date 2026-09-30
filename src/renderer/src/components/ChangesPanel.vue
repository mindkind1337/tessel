<script setup>
import ThemedSelect from './ui/ThemedSelect.vue'
// Source Control (the side panel's Changes tab), ported from Orca's
// right-sidebar/source-control (panel/panel-ready.tsx, panel/header-toolbar.tsx,
// listing/uncommitted-sections.tsx, listing/section-header.tsx,
// listing/uncommitted-entry-row.tsx, commit/commit-area.tsx,
// commit/commit-message-composer.tsx, commit/commit-action-menu.tsx,
// notes/notes-shelf.tsx, notes/diff-comments-list.tsx; MIT, Copyright (c)
// 2026 Lovecast Inc.), written for Vue.
//
// The changes of the workspace's project, or of a task's own copy (its
// worktree): Changes / Staged Changes / Untracked Files, stage, unstage,
// discard (asked first; untracked files go to the Recycle Bin), the commit
// box with Generate, Commit and the remote actions, and the review notes left
// on diff lines. A click on a file opens its diff in the editor. Git runs in
// the main process (src/main/sourceControl.js).
//
// Also after Orca: panel/branch-context-row.tsx and branch-line-total-chip.tsx
// (the branch, its line total, → its base), listing/tree-directory-rows.tsx
// and source-control-tree.ts (files as a folder tree, or a list),
// panel/header-overflow-menu.tsx (View as tree / list), "View all" on each
// section, and sync/git-history-panel.tsx (the Commits section,
// ScmHistoryPanel.vue).
import { ref, computed, watch, inject, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ExternalLink, Folder, FolderOpen, List, ListTree, Loader2, RefreshCw } from 'lucide-vue-next'
import { sectionTreeRows, sectionListRows, getSourceControlDirectoryActionPaths } from '../../../shared/sourceControlTree'
import { getFileTypeIcon } from '../fileTypeIcons'
import ScmHistoryPanel from './ScmHistoryPanel.vue'
import { tasks } from '../taskBoardStore'
import { settings } from '../settings'
import { refreshStatus, statusOf, bumpRevision, rootKey } from '../scmState'
import { notesFor, deleteNote, clearNotes, clearDelivered } from '../reviewNotes'
import {
  STATUS_LABELS,
  STATUS_COLORS,
  buildDisplaySections,
  resolveSourceControlGroupOrder,
  canStageStatusEntry,
  canUnstageStatusEntry,
  canDiscardStatusEntry,
  getStageAllPaths,
  getUnstageAllPaths,
  getDiscardAllPaths,
  getCommitMessageTextareaRows,
  resolvePrimaryAction,
  resolveDropdownItems,
  formatDiffComment,
  formatDiffComments,
  getDiffCommentLineLabel
} from '../../../shared/sourceControl'
import {
  scmText,
  statusTitle,
  sectionLabel,
  conflictKindLabel,
  conflictTitle,
  operationTitle,
  listLineLabel,
  discardEntryCopy,
  discardAreaCopy
} from '../scmLabels'
import LucideIcon from './LucideIcon.vue'
import NotesSendMenu from './NotesSendMenu.vue'
import { isRemotePath } from '../../../shared/remotePath'
import { t, intlLocale } from '../i18n'

const props = defineProps({
  root: { type: String, default: null },
  // Only this workspace's task copies (null: every one).
  workspaceId: { type: String, default: null }
})
const emit = defineEmits(['open', 'open-diff', 'review', 'create-pr', 'toast'])

const askConfirm = inject('askConfirm', null)
const api = () => window.shellApi && window.shellApi.scm

// --- Which repository: the project, or a task's copy --------------------------------
const copies = computed(() =>
  tasks.filter((k) => k.worktree && k.worktree.path && (!props.workspaceId || k.wsId === props.workspaceId) && k.column !== 'done')
)
const target = ref('project') // 'project' | task id
const copyTask = computed(() => (target.value === 'project' ? null : copies.value.find((k) => k.id === target.value) || null))
const repoRoot = computed(() => (copyTask.value ? copyTask.value.worktree.path : props.root))
watch(copies, (list) => {
  if (target.value !== 'project' && !list.some((k) => k.id === target.value)) target.value = 'project'
})

const state = computed(() => statusOf(repoRoot.value))
const data = computed(() => (state.value && state.value.data) || null)
const loaded = computed(() => !!(state.value && state.value.loaded))
const error = computed(() => (state.value && state.value.error) || '')
const entries = computed(() => (data.value && data.value.repo ? data.value.entries || [] : []))
const top = computed(() => (data.value && data.value.top) || repoRoot.value)

let disposed = false
async function load() {
  const root = repoRoot.value
  if (!root || !api()) return
  await refreshStatus(root)
  if (disposed) return
}

// --- Filter (Orca's header filter) -----------------------------------------------------
const filterExpanded = ref(false)
const filterQuery = ref('')
const filterInput = ref(null)
const normalizedFilter = computed(() => filterQuery.value.trim().toLowerCase())
function expandFilter() {
  filterExpanded.value = true
  nextTick(() => {
    if (filterInput.value) {
      filterInput.value.focus()
      filterInput.value.select()
    }
  })
}
function clearAndCollapseFilter() {
  filterQuery.value = ''
  filterExpanded.value = false
}

const filtered = computed(() =>
  normalizedFilter.value ? entries.value.filter((e) => e.path.toLowerCase().includes(normalizedFilter.value)) : entries.value
)
const groupOrder = computed(() => resolveSourceControlGroupOrder(settings.sourceControlGroupOrder))
const displaySections = computed(() => buildDisplaySections(filtered.value, groupOrder.value))
const unfilteredSectionsById = computed(() => new Map(buildDisplaySections(entries.value, groupOrder.value).map((s) => [s.id, s])))
const collapsed = ref(new Set())
function toggleSection(id) {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}

// --- Tree or list (Orca's sourceControlViewMode), folders collapsed -------------------
const viewMode = computed(() => (settings.sourceControlViewMode === 'list' ? 'list' : 'tree'))
function toggleViewMode() {
  closeMore()
  settings.sourceControlViewMode = viewMode.value === 'tree' ? 'list' : 'tree'
}
const collapsedDirs = ref(new Set())
function toggleDir(key) {
  const next = new Set(collapsedDirs.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedDirs.value = next
}
const rowsBySection = computed(() => {
  const out = {}
  for (const s of displaySections.value) out[s.id] = viewMode.value === 'tree' ? sectionTreeRows(s, collapsedDirs.value) : sectionListRows(s)
  return out
})
// A folder's stage / unstage / discard; hidden while filtering (the folder
// shows only part of what it holds).
function dirActions(node) {
  const a = getSourceControlDirectoryActionPaths(node)
  const f = !!normalizedFilter.value
  return {
    canStage: !f && a.stagePaths.length > 0,
    canUnstage: !f && a.unstagePaths.length > 0,
    canDiscard: !f && a.discardPaths.length > 0,
    ...a
  }
}
const TREE_INDENT = 12
const dirPad = (node) => ({ paddingLeft: `${node.depth * TREE_INDENT + 8}px` })
const filePad = (node) => ({ paddingLeft: `${node.depth * TREE_INDENT + 20}px` })

const stagedEntries = computed(() => entries.value.filter((e) => e.area === 'staged'))
const unresolved = computed(() => entries.value.filter((e) => e.conflictStatus === 'unresolved'))
const hasUncommittedEntries = computed(() => entries.value.length > 0)

function fileName(p) {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}
function dirName(p) {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(0, i) : ''
}
const rowKey = (e) => `${e.area}::${e.path}`
const noMatchText = () => t('changes.filter.noMatch', 'No changed files match "{{query}}"', { query: filterQuery.value })
const notesCountTitle = (n) =>
  n === 1 ? t('changes.row.notes', '{{count}} note', { count: n }) : t('changes.row.notes', '{{count}} notes', { count: n })
function discardTitle(entry) {
  if (entry.area === 'untracked') return t('changes.action.deleteUntracked', 'Delete untracked file')
  if (entry.status === 'deleted') return t('changes.action.restore', 'Restore file')
  return t('changes.action.discard', 'Discard changes')
}

// --- Notes (review notes left on diff lines) -----------------------------------------
const notes = computed(() => (top.value ? notesFor(top.value) : []))
const noteCountByPath = computed(() => {
  const m = new Map()
  for (const n of notes.value) m.set(n.filePath, (m.get(n.filePath) || 0) + 1)
  return m
})
const notesExpanded = ref(false)
const notesCopied = ref(false)
const copiedNoteId = ref(null)
let copiedTimer = 0
const noteGroups = computed(() => {
  const map = new Map()
  for (const c of notes.value) {
    if (!map.has(c.filePath)) map.set(c.filePath, [])
    map.get(c.filePath).push(c)
  }
  for (const list of map.values()) list.sort((a, b) => a.lineNumber - b.lineNumber)
  return [...map.entries()]
})
const unsentNotes = computed(() => notes.value.filter((n) => !n.sentAt))
const allNotesScopes = computed(() => [{ id: 'all', label: t('changes.notes.allUnsent', 'All unsent notes'), notes: unsentNotes.value, prompt: formatDiffComments(unsentNotes.value) }])
function onNotesDelivered(sent) {
  clearDelivered(top.value, sent)
}
async function writeClipboard(text) {
  if (window.shellApi && window.shellApi.writeClipboard) return window.shellApi.writeClipboard(text)
  if (navigator.clipboard) return navigator.clipboard.writeText(text)
}
async function copyAllNotes() {
  if (!notes.value.length) return
  try {
    await writeClipboard(formatDiffComments(notes.value))
    notesCopied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (notesCopied.value = false), 1500)
  } catch {
    emit('toast', t('changes.notes.copyFailed', 'Failed to copy notes'))
  }
}
async function copyNote(c) {
  try {
    await writeClipboard(formatDiffComment(c))
    copiedNoteId.value = c.id
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copiedNoteId.value = null), 1500)
  } catch {
    /* the window may not be focused */
  }
}
const notesMenuOpen = ref(false)
async function askClearNotes(filePath = null) {
  notesMenuOpen.value = false
  const count = filePath ? notes.value.filter((n) => n.filePath === filePath).length : notes.value.length
  if (!count) return
  const ok = askConfirm
    ? await askConfirm({
        title: filePath
          ? t('changes.notes.clearForTitle', 'Clear notes for {{path}}?', { path: filePath })
          : t('changes.notes.clearAllTitle', 'Clear all notes?'),
        text:
          count === 1
            ? t('changes.notes.clearText', 'This will permanently delete {{count}} note. This cannot be undone.', { count })
            : t('changes.notes.clearText', 'This will permanently delete {{count}} notes. This cannot be undone.', { count }),
        confirmLabel: t('changes.notes.clear', 'Clear'),
        danger: true
      })
    : false
  if (ok) clearNotes(top.value, filePath)
}
function openNote(c) {
  const entry =
    entries.value.find((e) => e.path === c.filePath && e.area === 'unstaged') ||
    entries.value.find((e) => e.path === c.filePath && e.area === 'untracked') ||
    entries.value.find((e) => e.path === c.filePath)
  emit('open-diff', diffRequest(entry || { path: c.filePath, area: 'unstaged', status: 'modified' }, { line: c.lineNumber }))
}

// --- Opening a file's diff -----------------------------------------------------------
function fullPath(rel) {
  const base = String(top.value || '').replace(/[\\/]+$/, '')
  return `${base}\\${rel.split('/').join('\\')}`
}
function diffRequest(entry, extra = {}) {
  return {
    root: top.value,
    rel: entry.path,
    oldRel: entry.oldPath || null,
    area: entry.area,
    status: entry.status,
    file: fullPath(entry.path),
    ...extra
  }
}
const openKey = ref(null)
function openDiff(entry, pinned = false) {
  openKey.value = rowKey(entry)
  emit('open-diff', diffRequest(entry, { preview: !pinned }))
}

// "View all" (Orca opens the section in one combined diff; Tessel has no
// combined view yet, so each file's diff opens in its own tab, at most
// VIEW_ALL_MAX of them).
const VIEW_ALL_MAX = 20
function viewAll(section) {
  const items = (unfilteredSectionsById.value.get(section.id) || section).items
  const shown = items.slice(0, VIEW_ALL_MAX)
  for (const entry of shown) emit('open-diff', diffRequest(entry, { preview: false }))
  if (items.length > shown.length)
    emit(
      'toast',
      t('changes.viewAll.capped', 'Opened the first {{shown}} of {{count}} diffs.', { shown: shown.length, count: items.length })
    )
}

// A file of a commit (the Commits section): its diff, read-only.
function openCommitFile({ commit, entry, preview }) {
  emit('open-diff', {
    root: top.value,
    rel: entry.path,
    oldRel: entry.oldPath || null,
    area: 'commit',
    commit,
    status: entry.status,
    file: fullPath(entry.path),
    preview
  })
}

// --- Keyboard: arrows move between rows, Enter opens, left / right fold ----------------
const listEl = ref(null)
function rowEls() {
  return listEl.value ? [...listEl.value.querySelectorAll('[data-scm-row]')] : []
}
function onListKeydown(e) {
  if (e.target && /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) return
  const els = rowEls()
  if (!els.length) return
  const at = els.indexOf(document.activeElement)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (at < 0 && !(document.activeElement && listEl.value.contains(document.activeElement))) return
    e.preventDefault()
    const next = at < 0 ? 0 : Math.max(0, Math.min(els.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
    els[next].focus()
  }
}
function onRowKeydown(e, node) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    if (node.type === 'directory') toggleDir(node.key)
    else openDiff(node.entry, e.key === 'Enter' && (e.ctrlKey || e.metaKey))
  } else if (node.type === 'directory' && e.key === 'ArrowLeft' && !collapsedDirs.value.has(node.key)) {
    e.preventDefault()
    toggleDir(node.key)
  } else if (node.type === 'directory' && e.key === 'ArrowRight' && collapsedDirs.value.has(node.key)) {
    e.preventDefault()
    toggleDir(node.key)
  }
}

// --- The branch against its base (branch-context-row.tsx) ---------------------------
const compare = ref(null) // { base, ahead, behind, added, removed, reviewUrl, error }
let compareSeq = 0
let compareTimer = 0
async function loadCompare() {
  const root = repoRoot.value
  if (!root || !api() || !api().branchCompare) return
  const token = ++compareSeq
  let res = null
  try {
    res = await api().branchCompare({ root })
  } catch (err) {
    res = { ok: false, error: err && err.message }
  }
  if (token !== compareSeq || disposed || root !== repoRoot.value) return
  if (res && res.ok) compare.value = res.base ? res : null
  else compare.value = { base: (res && res.base) || (compare.value && compare.value.base) || null, error: (res && res.error) || unknownError() }
}
function scheduleCompare() {
  clearTimeout(compareTimer)
  compareTimer = setTimeout(loadCompare, 300)
}
// Read again when what it measures changes: HEAD, the files, the upstream.
const compareSignature = computed(() => {
  const d = data.value
  if (!d || !d.repo) return ''
  return [d.head, d.branch, d.upstream, d.ahead, d.behind, ...entries.value.map((e) => `${e.area}:${e.path}:${e.added}:${e.removed}`)].join('|')
})
watch(compareSignature, (sig) => {
  if (sig) scheduleCompare()
})
const baseLabel = computed(() =>
  compare.value && compare.value.base ? compare.value.base.replace(/^refs\/(remotes|heads|tags)\//, '') : ''
)
const hasLineTotal = computed(() => !!compare.value && !compare.value.error && ((compare.value.added || 0) > 0 || (compare.value.removed || 0) > 0))
const lineTotalAria = computed(() => {
  const c = compare.value
  if (!c) return ''
  const added = c.added || 0
  const removed = c.removed || 0
  if (added > 0 && removed > 0) return t('changes.lineTotal.both', '{{added}} lines added, {{removed}} lines deleted', { added, removed })
  if (added > 0) return t('changes.lineTotal.added', '{{added}} lines added', { added })
  return t('changes.lineTotal.removed', '{{removed}} lines deleted', { removed })
})
const fmtCount = (n) => {
  try {
    return Number(n || 0).toLocaleString(intlLocale())
  } catch {
    return String(n || 0)
  }
}
const compareStats = computed(() => {
  const c = compare.value
  if (!c || c.error) return []
  const ref = baseLabel.value
  const out = []
  if (c.ahead > 0)
    out.push({
      key: 'ahead',
      label: `↑${c.ahead}`,
      title:
        c.ahead === 1
          ? t('changes.compare.aheadOne', '1 commit ahead of {{ref}}', { ref })
          : t('changes.compare.ahead', '{{count}} commits ahead of {{ref}}', { count: c.ahead, ref })
    })
  if (c.behind > 0)
    out.push({
      key: 'behind',
      label: `↓${c.behind}`,
      title:
        c.behind === 1
          ? t('changes.compare.behindOne', '1 commit behind {{ref}}', { ref })
          : t('changes.compare.behind', '{{count}} commits behind {{ref}}', { count: c.behind, ref })
    })
  return out
})
function openReviewPage() {
  const url = compare.value && compare.value.reviewUrl
  if (url && window.shellApi && window.shellApi.openExternal) window.shellApi.openExternal(url)
}

// --- Stage, unstage, discard -----------------------------------------------------------
const isExecutingBulk = ref(false)
async function afterMutation() {
  bumpRevision()
  await load()
}
async function runGit(fn, failure) {
  let res = null
  try {
    res = await fn()
  } catch (err) {
    res = { ok: false, error: err && err.message }
  }
  if (!res || !res.ok)
    emit('toast', t('changes.git.failedWith', '{{failure}}: {{error}}', { failure, error: (res && res.error) || unknownError() }))
  await afterMutation()
  return !!(res && res.ok)
}
const unknownError = () => t('changes.unknownError', 'unknown error')
const stage = (path) =>
  runGit(
    () => api().stage({ root: repoRoot.value, paths: [path] }),
    t('changes.git.stageFileFailed', 'Failed to stage {{name}}', { name: fileName(path) })
  )
const unstage = (path) =>
  runGit(
    () => api().unstage({ root: repoRoot.value, paths: [path] }),
    t('changes.git.unstageFileFailed', 'Failed to unstage {{name}}', { name: fileName(path) })
  )
async function stagePaths(paths) {
  if (!paths.length || isExecutingBulk.value) return
  isExecutingBulk.value = true
  try {
    await runGit(() => api().stage({ root: repoRoot.value, paths }), t('changes.git.stageFailed', 'Failed to stage'))
  } finally {
    isExecutingBulk.value = false
  }
}
async function unstagePaths(paths) {
  if (!paths.length || isExecutingBulk.value) return
  isExecutingBulk.value = true
  try {
    await runGit(() => api().unstage({ root: repoRoot.value, paths }), t('changes.git.unstageFailed', 'Failed to unstage'))
  } finally {
    isExecutingBulk.value = false
  }
}
async function confirmDiscard(copy, pathText) {
  if (!askConfirm) return false
  return (await askConfirm({ title: copy.title, text: `${copy.description}\n${pathText}`, confirmLabel: copy.confirmLabel, danger: true })) === true
}
async function requestDiscardEntry(entry) {
  const root = repoRoot.value
  const copy = discardEntryCopy(entry, { remote: remoteRepo.value })
  if (!(await confirmDiscard(copy, entry.path))) return
  if (!discardContextStillCurrent(root)) return
  await runGit(
    () => api().discard({ root, paths: [entry.path] }),
    t('changes.git.discardFileFailed', 'Failed to discard {{name}}', { name: fileName(entry.path) })
  )
}
async function requestDiscardAllInArea(area, paths) {
  if (!paths.length || isExecutingBulk.value) return
  const root = repoRoot.value
  const copy = discardAreaCopy(area, paths.length, { remote: remoteRepo.value })
  const n = paths.length
  const filesText = n === 1 ? t('changes.discard.files', '{{count}} file', { count: n }) : t('changes.discard.files', '{{count}} files', { count: n })
  if (!(await confirmDiscard(copy, filesText))) return
  if (!discardContextStillCurrent(root)) return
  isExecutingBulk.value = true
  try {
    await runGit(() => api().discard({ root, paths }), t('changes.git.discardFailed', 'Failed to discard'))
  } finally {
    isExecutingBulk.value = false
  }
}

function discardContextStillCurrent(root) {
  if (disposed) return false
  if (root === repoRoot.value) return true
  emit('toast', t('changes.discard.repositoryChanged', 'The repository changed. Discard was cancelled; no files were changed.'))
  return false
}

function sectionActions(section) {
  const actionSection = unfilteredSectionsById.value.get(section.id) || section
  const items = actionSection.items
  const stageAll = getStageAllPaths(items)
  const unstageAll = getUnstageAllPaths(items)
  const discardAll = section.area === 'staged' ? [] : getDiscardAllPaths(items, section.area)
  const f = !!normalizedFilter.value
  return {
    canStageAll: !f && stageAll.length > 0,
    canUnstageAll: !f && unstageAll.length > 0,
    canRevertAll: !f && discardAll.length > 0,
    stageAll,
    unstageAll,
    discardAll
  }
}

// --- Commit area (commit-area.tsx) --------------------------------------------------------
const drafts = draftStore()
const commitMessage = computed({
  get: () => drafts[rootKey(repoRoot.value)] || '',
  set: (v) => (drafts[rootKey(repoRoot.value)] = v)
})
const isCommitting = ref(false)
const remoteOp = ref(null) // 'push' | 'pull' | 'sync' | 'publish' | 'fetch' | 'fast_forward'
const commitError = ref('')
const remoteActionError = ref('')
const isGenerating = ref(false)
const generateError = ref('')

const upstreamStatus = computed(() =>
  data.value && data.value.repo
    ? { hasUpstream: !!data.value.hasUpstream, ahead: data.value.ahead || 0, behind: data.value.behind || 0, upstreamName: data.value.upstream || '' }
    : null
)
const actionInputs = computed(() => ({
  stagedCount: stagedEntries.value.length,
  hasUnstagedChanges: entries.value.some((e) => e.area !== 'staged'),
  hasStageableChanges: entries.value.some((e) => canStageStatusEntry(e)),
  hasMessage: commitMessage.value.trim().length > 0,
  hasUnresolvedConflicts: unresolved.value.length > 0,
  isCommitting: isCommitting.value,
  isRemoteOperationActive: !!remoteOp.value,
  inFlightRemoteOpKind: remoteOp.value === 'fetch' || remoteOp.value === 'fast_forward' ? null : remoteOp.value,
  upstreamStatus: upstreamStatus.value,
  hasCurrentBranch: !!(data.value && data.value.branch)
}))
const primaryAction = computed(() => resolvePrimaryAction(actionInputs.value))
const dropdownItems = computed(() => resolveDropdownItems(actionInputs.value))
const PRIMARY_ICONS = { commit: 'check', stage: 'plus', push: 'arrowUp', sync: 'arrowDownUp', publish: 'cloudUpload' }
const primaryIcon = computed(() => PRIMARY_ICONS[primaryAction.value.kind] || null)
const showSpinner = computed(() =>
  primaryAction.value.kind === 'commit' ? isCommitting.value : !!remoteOp.value && primaryAction.value.kind === remoteOp.value
)
const showChevronSpinner = computed(() => (isCommitting.value || !!remoteOp.value) && !showSpinner.value)
const rows = computed(() => getCommitMessageTextareaRows(commitMessage.value))
const hasMessage = computed(() => commitMessage.value.trim().length > 0)
const commitFieldDisabled = computed(() => isCommitting.value)
const generateAgent = computed(() => (settings.defaultAgent === 'codex' ? 'codex' : 'claude'))
const isGenerateDisabled = computed(
  () => isGenerating.value || isCommitting.value || stagedEntries.value.length === 0 || hasMessage.value || unresolved.value.length > 0
)
const generateTooltip = computed(() => {
  if (isGenerating.value) return t('changes.generate.generating', 'Generating commit message…')
  if (isCommitting.value) return t('changes.sc.commitInProgress', 'Commit in progress…')
  if (stagedEntries.value.length === 0) return t('changes.generate.stageFirst', 'Stage at least one file to generate a message.')
  if (hasMessage.value) return t('changes.generate.clearFirst', 'Clear the message to regenerate.')
  return t('changes.generate.tooltip', 'Generate a commit message with {{agent}} from the staged changes', {
    agent: generateAgent.value === 'codex' ? 'Codex' : 'Claude'
  })
})

async function commit() {
  const message = commitMessage.value.trim()
  if (!message || isCommitting.value) return false
  isCommitting.value = true
  commitError.value = ''
  const root = repoRoot.value
  let res = null
  try {
    res = await api().commit({ root, message })
  } catch (err) {
    res = { ok: false, error: err && err.message }
  } finally {
    isCommitting.value = false
  }
  if (res && res.ok) {
    drafts[rootKey(root)] = ''
    await afterMutation()
    return true
  }
  commitError.value = (res && res.error) || t('changes.commit.failed', 'Commit failed.')
  await afterMutation()
  return false
}

const REMOTE = {
  push: (root) => api().push({ root }),
  publish: (root) => api().push({ root }),
  pull: (root) => api().pull({ root }),
  fast_forward: (root) => api().pull({ root, ffOnly: true }),
  sync: (root) => api().sync({ root }),
  fetch: (root) => api().fetch({ root })
}
function remoteFailure(kind) {
  if (kind === 'push') return t('changes.remote.pushFailed', 'Push failed')
  if (kind === 'publish') return t('changes.remote.publishFailed', 'Publish failed')
  if (kind === 'pull') return t('changes.remote.pullFailed', 'Pull failed')
  if (kind === 'fast_forward') return t('changes.remote.ffFailed', 'Fast-forward failed')
  if (kind === 'sync') return t('changes.remote.syncFailed', 'Sync failed')
  return t('changes.remote.fetchFailed', 'Fetch failed')
}
async function remote(kind) {
  if (remoteOp.value || !REMOTE[kind]) return false
  remoteOp.value = kind
  remoteActionError.value = ''
  let res = null
  try {
    res = await REMOTE[kind](repoRoot.value)
  } catch (err) {
    res = { ok: false, error: err && err.message }
  } finally {
    remoteOp.value = null
  }
  if (!res || !res.ok)
    remoteActionError.value = t('changes.git.failedWith', '{{failure}}: {{error}}', {
      failure: remoteFailure(kind),
      error: (res && res.error) || unknownError()
    })
  await afterMutation()
  return !!(res && res.ok)
}

async function onPrimaryAction() {
  const a = primaryAction.value
  if (a.disabled) return
  if (a.kind === 'commit') await commit()
  else if (a.kind === 'stage') await stagePaths(getStageAllPaths(entries.value))
  else await remote(a.kind)
}
const menuOpen = ref(false)
const menuPos = ref({ top: 0, right: 0 })
const chevronEl = ref(null)
const menuEl = ref(null)
function toggleMenu() {
  if (menuOpen.value) return closeMenu()
  const r = chevronEl.value && chevronEl.value.getBoundingClientRect()
  if (r) menuPos.value = { top: Math.round(r.bottom + 4), right: Math.max(4, Math.round(window.innerWidth - r.right)) }
  menuOpen.value = true
  nextTick(() => document.addEventListener('mousedown', onMenuOutside, true))
}
function closeMenu() {
  menuOpen.value = false
  document.removeEventListener('mousedown', onMenuOutside, true)
}
function onMenuOutside(e) {
  if ((menuEl.value && menuEl.value.contains(e.target)) || (chevronEl.value && chevronEl.value.contains(e.target))) return
  closeMenu()
}
async function onDropdownAction(kind) {
  const root = repoRoot.value
  closeMenu()
  if (kind === 'commit') await commit()
  else if (kind === 'commit_push' || kind === 'commit_sync') {
    if (!(await commit()) || disposed) return
    if (root !== repoRoot.value) {
      emit('toast', t('changes.commit.repositoryChanged', 'The commit finished, but the repository changed. Push or sync was cancelled.'))
      return
    }
    await remote(kind === 'commit_push' ? 'push' : 'sync')
  } else await remote(kind)
}

// Ctrl+Enter in the panel commits (Orca's commit-shortcut.ts).
function onRootKeydown(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey) {
    if (primaryAction.value.disabled || primaryAction.value.kind !== 'commit') return
    e.preventDefault()
    e.stopPropagation()
    commit()
  }
}

async function generate() {
  if (isGenerateDisabled.value || !api()) return
  isGenerating.value = true
  generateError.value = ''
  const root = repoRoot.value
  let res = null
  try {
    res = await api().generate({ root, agent: generateAgent.value })
  } catch (err) {
    res = { ok: false, error: err && err.message }
  } finally {
    isGenerating.value = false
  }
  if (res && res.ok && res.message) {
    if (!(drafts[rootKey(root)] || '').trim()) drafts[rootKey(root)] = res.message
  } else if (!(res && res.cancelled))
    generateError.value = t('changes.generate.failed', 'Could not generate a commit message: {{error}}', {
      error: (res && res.error) || unknownError()
    })
}
function cancelGenerate() {
  if (api() && api().cancelGenerate) api().cancelGenerate({ root: repoRoot.value })
}

// --- Header: branch, more menu ------------------------------------------------------------
const moreOpen = ref(false)
const moreEl = ref(null)
const moreBtn = ref(null)
const morePos = ref({ top: 0, right: 0 })
function toggleMore() {
  if (moreOpen.value) return closeMore()
  const r = moreBtn.value && moreBtn.value.getBoundingClientRect()
  if (r) morePos.value = { top: Math.round(r.bottom + 4), right: Math.max(4, Math.round(window.innerWidth - r.right)) }
  moreOpen.value = true
  nextTick(() => document.addEventListener('mousedown', onMoreOutside, true))
}
function closeMore() {
  moreOpen.value = false
  document.removeEventListener('mousedown', onMoreOutside, true)
}
function onMoreOutside(e) {
  if ((moreEl.value && moreEl.value.contains(e.target)) || (moreBtn.value && moreBtn.value.contains(e.target))) return
  closeMore()
}
// A project on a remote host: its git runs there (remoteFs.js); the message
// agents work on this machine's folders, so not yet. Create PR runs gh here on
// the host's repository (named from its remote, githubService.js), so it
// names the project folder (the one saved root the main process accepts).
const remoteRepo = computed(() => isRemotePath(repoRoot.value))
const canCreatePr = computed(() => !!(data.value && data.value.repo && data.value.branch && (data.value.remotes || []).length))
function createPr() {
  closeMore()
  emit('create-pr', { cwd: remoteRepo.value ? repoRoot.value : top.value, taskId: copyTask.value ? copyTask.value.id : null })
}
const branchTitle = computed(() => {
  const d = data.value
  if (!d || !d.repo) return ''
  if (!d.branch) return t('changes.branch.detached', 'Detached HEAD')
  return d.branch
})

// --- Keep current -----------------------------------------------------------------------
// The side panel watches the project and reads its status again as files
// change (its count badge); a task's copy is outside the watched project, so
// it is read again every few seconds while shown.
let timer = 0
let poll = 0
function schedule() {
  clearTimeout(timer)
  timer = setTimeout(load, 250)
}
watch(repoRoot, () => {
  commitError.value = ''
  remoteActionError.value = ''
  generateError.value = ''
  openKey.value = null
  compare.value = null
  collapsedDirs.value = new Set()
  load()
  scheduleCompare()
})
function onFocus() {
  schedule()
}
onMounted(() => {
  load()
  scheduleCompare()
  poll = setInterval(() => {
    if (copyTask.value && !document.hidden) load()
  }, 4000)
  window.addEventListener('focus', onFocus)
})
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(timer)
  clearTimeout(copiedTimer)
  clearTimeout(compareTimer)
  clearInterval(poll)
  window.removeEventListener('focus', onFocus)
  closeMenu()
  closeMore()
})
function refreshAll() {
  closeMore()
  load()
  loadCompare()
}
defineExpose({ load })
</script>

<script>
import { reactive } from 'vue'
// Commit message drafts per repository, kept while Tessel runs (Orca's
// commit-drafts.ts keeps one per worktree).
const draftsByRoot = reactive({})
function draftStore() {
  return draftsByRoot
}
</script>

<template>
  <div class="changes sc-root" :aria-label="t('changes.title', 'Source Control')" data-test="changes-panel" @keydown="onRootKeydown">
    <!-- Header (panel/header-toolbar.tsx): Create PR at the left, filter and more at the right. -->
    <div class="sc-header">
      <div v-if="!filterExpanded" class="sc-header-row">
        <ThemedSelect
          v-if="root && copies.length"
          v-model="target"
          class="sc-repo-select"
          :title="t('changes.target.hint', 'Show the changes of the project or of a task\'s own copy')"
          :aria-label="t('changes.target.repository', 'Repository')"
          data-test="changes-target"
        >
          <option value="project">{{ t('changes.target.project', 'Project') }}</option>
          <option v-for="k in copies" :key="k.id" :value="k.id">{{ k.title }}</option>
        </ThemedSelect>
        <button
          v-if="copyTask"
          type="button"
          class="sc-pr-btn"
          :title="t('changes.review.hint', 'Review this task\'s branch: its commits, then merge or discard')"
          data-test="review-changes"
          @click="emit('review', copyTask.id)"
        >
          {{ t('changes.review.button', 'Review & merge') }}
        </button>
        <button
          v-else-if="canCreatePr"
          type="button"
          class="sc-pr-btn"
          :title="t('changes.pr.hint', 'Create a pull request for this branch')"
          data-test="sc-create-pr"
          @click="createPr"
        >
          <LucideIcon name="gitPullRequestArrow" :size="14" />
          {{ t('changes.pr.create', 'Create PR') }}
        </button>
        <span class="sc-fill" aria-hidden="true"></span>
        <button
          type="button"
          class="sc-icon-btn"
          :class="{ on: normalizedFilter }"
          :title="normalizedFilter ? t('changes.filter.active', 'Filter: {{query}}', { query: filterQuery }) : t('changes.filter.byName', 'Filter files by name')"
          :aria-label="
            normalizedFilter ? t('changes.filter.active', 'Filter: {{query}}', { query: filterQuery }) : t('changes.filter.byName', 'Filter files by name')
          "
          :aria-expanded="false"
          data-test="source-control-filter-toggle"
          @click="expandFilter"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <span v-if="normalizedFilter" class="sc-filter-dot"></span>
        </button>
        <button
          ref="moreBtn"
          type="button"
          class="sc-icon-btn"
          :title="t('changes.moreActions', 'More source control actions')"
          :aria-label="t('changes.moreActions', 'More source control actions')"
          aria-haspopup="menu"
          :aria-expanded="moreOpen"
          data-test="sc-more"
          @click="toggleMore"
        >
          <LucideIcon name="moreHorizontal" :size="14" />
        </button>
      </div>
      <div v-else class="sc-header-row sc-filter-row">
        <svg class="sc-dim" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          ref="filterInput"
          v-model="filterQuery"
          type="text"
          class="sc-filter-input"
          :placeholder="t('changes.filter.placeholder', 'Filter files…')"
          :aria-label="t('changes.filter.placeholder', 'Filter files…')"
          data-test="source-control-filter-input"
          @keydown.escape.prevent.stop="filterExpanded = false"
        />
        <button
          type="button"
          class="sc-icon-btn"
          :title="t('changes.filter.clearClose', 'Clear and close filter')"
          :aria-label="t('changes.filter.clearClose', 'Clear and close filter')"
          @click="clearAndCollapseFilter"
        >
          <LucideIcon name="x" :size="14" />
        </button>
      </div>

      <!-- Branch context (panel/branch-context-row.tsx): the branch and its line
           total, then → the base it is compared with. -->
      <div
        v-if="data && data.repo"
        class="sc-branch"
        role="group"
        :aria-label="baseLabel ? t('changes.compare.flow', '{{head}} → {{base}}', { head: branchTitle, base: baseLabel }) : undefined"
        data-test="sc-branch"
      >
        <div class="sc-branch-head">
          <span
            class="sc-branch-name"
            :class="{ detached: !data.branch }"
            tabindex="0"
            :title="branchTitle"
            :aria-label="t('changes.branch.current', 'Current branch: {{branch}}', { branch: branchTitle })"
            data-test="source-control-head-identity"
            >{{ branchTitle }}</span
          >
          <span
            v-if="hasLineTotal"
            class="sc-line-total"
            role="group"
            :aria-label="lineTotalAria"
            :title="lineTotalAria"
            data-test="source-control-branch-line-total"
          >
            <span v-if="compare.added > 0" aria-hidden="true" class="sc-plus">+{{ fmtCount(compare.added) }}</span>
            <span v-if="compare.removed > 0" aria-hidden="true" class="sc-minus">-{{ fmtCount(compare.removed) }}</span>
          </span>
        </div>
        <div v-if="baseLabel" class="sc-branch-base">
          <span class="sc-arrow" aria-hidden="true">→</span>
          <span class="sc-base-ref" :title="t('changes.compare.base', 'Compared with {{base}}', { base: compare.base })" data-test="sc-base">{{
            baseLabel
          }}</span>
          <span v-for="stat in compareStats" :key="stat.key" class="sc-stat" tabindex="0" :title="stat.title" :aria-label="stat.title">{{
            stat.label
          }}</span>
          <button
            v-if="compare.error"
            type="button"
            class="sc-icon-btn sm"
            :title="t('changes.compare.retry', 'Retry')"
            :aria-label="t('changes.compare.retry', 'Retry')"
            @click="loadCompare"
          >
            <RefreshCw :size="12" />
          </button>
          <button
            v-if="compare.reviewUrl"
            type="button"
            class="sc-icon-btn sm"
            :title="t('changes.compare.openReview', 'Open review page in browser')"
            :aria-label="t('changes.compare.openReview', 'Open review page in browser')"
            data-test="sc-review-page"
            @click="openReviewPage"
          >
            <ExternalLink :size="12" />
          </button>
        </div>
        <div v-if="compare && compare.error" class="sc-compare-error" :title="compare.error">{{ compare.error }}</div>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="moreOpen" ref="moreEl" class="ctx-menu sc-menu" role="menu" :style="{ top: morePos.top + 'px', right: morePos.right + 'px' }" data-test="sc-more-menu">
        <button type="button" class="ctx-menu-item" role="menuitem" data-test="sc-view-mode" @click="toggleViewMode">
          <span class="sc-menu-row">
            <component :is="viewMode === 'tree' ? List : ListTree" :size="14" />
            {{ viewMode === 'tree' ? t('changes.menu.viewList', 'View as list') : t('changes.menu.viewTree', 'View as tree') }}
          </span>
        </button>
        <button type="button" class="ctx-menu-item" role="menuitem" @click="refreshAll">
          <span class="sc-menu-row"><LucideIcon name="refreshCw" :size="14" />{{ t('changes.menu.refresh', 'Refresh') }}</span>
        </button>
        <button type="button" class="ctx-menu-item" role="menuitem" :disabled="!canCreatePr" @click="createPr">
          <span class="sc-menu-row"><LucideIcon name="gitPullRequestArrow" :size="14" />{{ t('changes.menu.createPr', 'Create PR…') }}</span>
        </button>
        <template v-if="notes.length">
          <div class="ctx-menu-sep"></div>
          <button type="button" class="ctx-menu-item" role="menuitem" @click="closeMore(), (notesExpanded = true)">
            <span class="sc-menu-row"><LucideIcon name="messageSquare" :size="14" />{{ t('changes.notes.title', 'Notes') }}</span>
            <span class="sc-menu-count">{{ notes.length }}</span>
          </button>
        </template>
      </div>
    </Teleport>

    <!-- Notes shelf: hidden when there is none (notes are made in the diff view). -->
    <div v-if="notes.length" class="sc-notes" data-test="sc-notes">
      <div class="sc-notes-head">
        <button
          type="button"
          class="sc-notes-toggle"
          :aria-expanded="notesExpanded"
          :title="notesExpanded ? t('changes.notes.collapse', 'Collapse notes') : t('changes.notes.expand', 'Expand notes')"
          data-test="sc-notes-toggle"
          @click="notesExpanded = !notesExpanded"
        >
          <LucideIcon name="chevronDown" :size="12" :class="{ 'sc-rot': !notesExpanded }" />
          <LucideIcon name="messageSquare" :size="14" />
          <span>{{ t('changes.notes.title', 'Notes') }}</span>
          <span class="sc-notes-count">{{ notes.length }}</span>
        </button>
        <span class="sc-notes-actions">
          <NotesSendMenu :scopes="allNotesScopes" trigger-class="sc-notes-btn" @delivered="onNotesDelivered" />
          <button
            type="button"
            class="sc-notes-btn"
            :aria-label="t('changes.notes.copyAllAria', 'Copy all notes to clipboard')"
            :title="t('changes.notes.copyAll', 'Copy all notes')"
            @click="copyAllNotes"
          >
            <LucideIcon :name="notesCopied ? 'check' : 'copy'" :size="14" />
          </button>
          <span class="sc-rel">
            <button
              type="button"
              class="sc-notes-btn"
              :aria-label="t('changes.notes.more', 'More note actions')"
              :title="t('changes.notes.more', 'More note actions')"
              @click="notesMenuOpen = !notesMenuOpen"
            >
              <LucideIcon name="moreHorizontal" :size="14" />
            </button>
            <div v-if="notesMenuOpen" class="ctx-menu sc-notes-menu" role="menu">
              <button type="button" class="ctx-menu-item danger" role="menuitem" data-test="sc-clear-notes" @click="askClearNotes()">
                <span class="sc-menu-row"><LucideIcon name="trash2" :size="14" />{{ t('changes.notes.clearAll', 'Clear all notes...') }}</span>
              </button>
            </div>
          </span>
        </span>
      </div>
      <div v-if="notesExpanded" class="sc-notes-list" data-test="sc-notes-list">
        <div v-for="[filePath, list] in noteGroups" :key="filePath" class="sc-notes-file">
          <div class="sc-notes-file-head">
            <button type="button" class="sc-notes-file-name" :title="t('changes.notes.openFile', 'Open {{path}}', { path: filePath })" @click="openNote(list[0])">
              {{ filePath }}
            </button>
            <button
              type="button"
              class="sc-note-mini danger"
              :title="t('changes.notes.clearFor', 'Clear notes for {{path}}', { path: filePath })"
              :aria-label="t('changes.notes.clearFor', 'Clear notes for {{path}}', { path: filePath })"
              @click="askClearNotes(filePath)"
            >
              <LucideIcon name="trash2" :size="12" />
            </button>
          </div>
          <ul class="sc-notes-ul">
            <li v-for="c in list" :key="c.id" class="sc-note" data-test="sc-note">
              <button
                type="button"
                class="sc-note-open"
                :title="t('changes.notes.openNoteTitle', 'Open {{path}} ({{where}})', { path: c.filePath, where: listLineLabel(c) })"
                :aria-label="t('changes.notes.openNoteAria', 'Open note on {{where}}', { where: listLineLabel(c) })"
                @click="openNote(c)"
              >
                <span class="sc-chip">{{ getDiffCommentLineLabel(c, true) }}</span>
                <span class="sc-chip sc-chip-soft">{{ t('changes.notes.diff', 'Diff') }}</span>
                <span v-if="c.sentAt" class="sc-chip sc-chip-soft">{{ t('changes.notes.sent', 'Sent') }}</span>
                <span class="sc-note-body">{{ c.body }}</span>
              </button>
              <button
                type="button"
                class="sc-note-mini"
                :title="t('changes.notes.copy', 'Copy note')"
                :aria-label="t('changes.notes.copyOnLine', 'Copy note on line {{line}}', { line: c.lineNumber })"
                @click="copyNote(c)"
              >
                <LucideIcon :name="copiedNoteId === c.id ? 'check' : 'copy'" :size="12" />
              </button>
              <button
                type="button"
                class="sc-note-mini danger"
                :title="t('changes.notes.delete', 'Delete note')"
                :aria-label="t('changes.notes.deleteOnLine', 'Delete note on line {{line}}', { line: c.lineNumber })"
                @click="deleteNote(top, c.id)"
              >
                <LucideIcon name="trash" :size="12" />
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <div ref="listEl" class="sc-scroll explorer-tree" @keydown="onListKeydown">
      <div v-if="!root && !copyTask" class="explorer-empty">
        {{
          t(
            'changes.noProject',
            'This workspace has no project folder. Choose one from the workspace menu (Project folder…) to see its changes here.'
          )
        }}
      </div>
      <div
        v-else-if="loaded && error"
        class="explorer-empty explorer-error"
        data-test="changes-error"
        v-text="t('changes.statusError', 'Could not read the git status: {{error}}', { error })"
      ></div>
      <div v-else-if="loaded && data && !data.repo" class="explorer-empty">{{ t('changes.notRepo', 'This folder is not in a git repository.') }}</div>
      <template v-else>
        <!-- Conflicts / an operation stopped half way -->
        <div v-if="unresolved.length" class="sc-pad">
          <div class="sc-conflict-card" role="alert">
            <div class="sc-conflict-title"><LucideIcon name="triangleAlert" :size="14" />{{ conflictTitle(data && data.operation) }}</div>
            <div
              class="sc-conflict-text"
              v-text="
                t('changes.conflict.unresolvedCount', '{{title}}: {{count}} unresolved', {
                  title: conflictTitle(data && data.operation),
                  count: unresolved.length
                })
              "
            ></div>
            <div class="sc-conflict-hint">
              {{ t('changes.conflict.hint', 'Resolved files move back to normal changes after they leave the live conflict state.') }}
            </div>
          </div>
        </div>
        <div v-else-if="data && data.operation" class="sc-pad">
          <div class="sc-conflict-card sc-op-card">
            <div class="sc-conflict-title">{{ operationTitle(data.operation) }}</div>
          </div>
        </div>

        <!-- The commit area stays mounted (Orca keeps it on clean trees too). -->
        <div v-if="data && data.repo" class="sc-commit" data-test="sc-commit">
          <div class="sc-composer">
            <textarea
              v-model="commitMessage"
              class="sc-commit-msg"
              :class="{ 'with-generate': !remoteRepo }"
              :rows="rows"
              :disabled="commitFieldDisabled"
              :placeholder="t('changes.commit.placeholder', 'Message')"
              :aria-label="t('changes.commit.message', 'Commit message')"
              spellcheck="false"
              data-test="sc-commit-message"
            ></textarea>
            <button
              v-if="isGenerating"
              type="button"
              class="sc-generate cancel"
              :title="t('changes.generate.clickToStop', 'Generating commit message. Click to stop.')"
              :aria-label="t('changes.generate.stop', 'Stop generating commit message')"
              data-test="sc-generate-stop"
              @click="cancelGenerate"
            >
              <LucideIcon name="refreshCw" :size="14" class="sc-spin sc-gen-spin" />
              <LucideIcon name="square" :size="14" class="sc-gen-stop" />
            </button>
            <button
              v-else-if="!remoteRepo"
              type="button"
              class="sc-generate"
              :class="{ disabled: isGenerateDisabled }"
              :aria-disabled="isGenerateDisabled"
              :title="generateTooltip"
              :aria-label="t('changes.generate.aria', 'Generate commit message with AI')"
              data-test="sc-generate"
              @click="generate"
            >
              <LucideIcon name="sparkles" :size="14" />
            </button>
          </div>
          <div class="sc-split">
            <button
              type="button"
              class="sc-primary"
              :disabled="primaryAction.disabled"
              :title="scmText(primaryAction.title)"
              data-test="sc-primary"
              @click="onPrimaryAction"
            >
              <LucideIcon v-if="showSpinner" name="loader2" :size="14" class="sc-spin" />
              <LucideIcon v-else-if="primaryIcon" :name="primaryIcon" :size="14" />
              {{ scmText(primaryAction.label) }}
            </button>
            <button
              ref="chevronEl"
              type="button"
              class="sc-chevron"
              :class="{ dim: primaryAction.disabled }"
              :title="t('changes.commit.moreActions', 'More commit and remote actions')"
              :aria-label="t('changes.commit.moreActions', 'More commit and remote actions')"
              aria-haspopup="menu"
              :aria-expanded="menuOpen"
              data-test="sc-chevron"
              @click="toggleMenu"
            >
              <LucideIcon :name="showChevronSpinner ? 'loader2' : 'chevronDown'" :size="14" :class="{ 'sc-spin': showChevronSpinner }" />
            </button>
          </div>
          <p v-if="commitError" id="commit-area-error" class="sc-notice bad" role="alert" data-test="sc-commit-error">{{ commitError }}</p>
          <p v-if="remoteActionError" class="sc-notice bad" role="alert" data-test="sc-remote-error">{{ remoteActionError }}</p>
          <p v-if="generateError" class="sc-notice bad" role="alert">{{ generateError }}</p>
        </div>
        <Teleport to="body">
          <div v-if="menuOpen" ref="menuEl" class="ctx-menu sc-menu sc-commit-menu" role="menu" :style="{ top: menuPos.top + 'px', right: menuPos.right + 'px' }" data-test="sc-commit-menu">
            <template v-for="item in dropdownItems" :key="item.kind === 'separator' ? item.id : item.kind">
              <div v-if="item.kind === 'separator'" class="ctx-menu-sep"></div>
              <button
                v-else
                type="button"
                class="ctx-menu-item sc-menu-item"
                role="menuitem"
                :disabled="item.disabled"
                :title="scmText(item.title)"
                :data-kind="item.kind"
                @click="onDropdownAction(item.kind)"
              >
                <span>{{ scmText(item.label) }}</span>
              </button>
            </template>
          </div>
        </Teleport>

        <!-- Changes / Staged Changes / Untracked Files (listing/uncommitted-sections.tsx) -->
        <div v-for="section in displaySections" :key="section.id" class="sc-section" :data-section="section.id">
          <div class="sc-section-header">
            <div class="sc-section-row">
              <button type="button" class="sc-section-toggle" :aria-expanded="!collapsed.has(section.id)" data-test="sc-section-toggle" @click="toggleSection(section.id)">
                <LucideIcon name="chevronDown" :size="14" :class="{ 'sc-rot': collapsed.has(section.id) }" />
                <span class="sc-section-label" :title="sectionLabel(section)">{{ sectionLabel(section) }}</span>
                <span class="sc-section-count" data-test="changes-count">{{ section.items.length }}</span>
              </button>
              <span class="sc-section-actions">
                <template v-for="a in [sectionActions(section)]" :key="'a'">
                  <button
                    v-if="a.canRevertAll"
                    type="button"
                    class="sc-action"
                    :class="{ disabled: isExecutingBulk }"
                    :aria-disabled="isExecutingBulk"
                    :title="section.area === 'untracked' ? t('changes.action.deleteAllUntracked', 'Delete all untracked') : t('changes.discard.discardAll', 'Discard all')"
                    :aria-label="
                      section.area === 'untracked' ? t('changes.action.deleteAllUntracked', 'Delete all untracked') : t('changes.discard.discardAll', 'Discard all')
                    "
                    data-test="sc-discard-all"
                    @click.stop="requestDiscardAllInArea(section.area, a.discardAll)"
                  >
                    <LucideIcon :name="section.area === 'untracked' ? 'trash' : 'undo2'" :size="14" />
                  </button>
                  <button
                    v-if="a.canStageAll"
                    type="button"
                    class="sc-action"
                    :class="{ disabled: isExecutingBulk }"
                    :aria-disabled="isExecutingBulk"
                    :title="t('changes.action.stageAll', 'Stage all')"
                    :aria-label="t('changes.action.stageAll', 'Stage all')"
                    data-test="sc-stage-all"
                    @click.stop="stagePaths(a.stageAll)"
                  >
                    <LucideIcon name="plus" :size="14" />
                  </button>
                  <button
                    v-if="a.canUnstageAll"
                    type="button"
                    class="sc-action"
                    :class="{ disabled: isExecutingBulk }"
                    :aria-disabled="isExecutingBulk"
                    :title="t('changes.action.unstageAll', 'Unstage all')"
                    :aria-label="t('changes.action.unstageAll', 'Unstage all')"
                    data-test="sc-unstage-all"
                    @click.stop="unstagePaths(a.unstageAll)"
                  >
                    <LucideIcon name="minus" :size="14" />
                  </button>
                  <button
                    type="button"
                    class="sc-view-all"
                    :title="t('changes.viewAll.hint', 'Open the diff of every file of this section')"
                    data-test="sc-view-all"
                    @click.stop="viewAll(section)"
                  >
                    {{ t('changes.viewAll.label', 'View all') }}
                  </button>
                </template>
              </span>
            </div>
          </div>
          <template v-if="!collapsed.has(section.id)">
            <template v-for="node in rowsBySection[section.id]" :key="node.key">
              <!-- A folder (listing/tree-directory-rows.tsx) -->
              <div
                v-if="node.type === 'directory'"
                class="sc-dir"
                :style="dirPad(node)"
                :data-path="node.path"
                data-test="sc-dir"
                data-scm-row
                tabindex="-1"
                role="treeitem"
                :aria-expanded="!collapsedDirs.has(node.key)"
                @keydown="onRowKeydown($event, node)"
              >
                <button type="button" class="sc-dir-toggle" tabindex="-1" :title="node.path" @click="toggleDir(node.key)">
                  <LucideIcon name="chevronDown" :size="12" :class="{ 'sc-rot': collapsedDirs.has(node.key) }" />
                  <component :is="collapsedDirs.has(node.key) ? Folder : FolderOpen" :size="12" class="sc-dir-icon" />
                  <span class="sc-dir-name">{{ node.name }}</span>
                </button>
                <span class="sc-dir-count" data-test="sc-dir-count">{{ node.fileCount }}</span>
                <template v-for="d in [dirActions(node)]" :key="'d'">
                  <div v-if="d.canDiscard || d.canStage || d.canUnstage" class="sc-row-actions" @click.stop @dblclick.stop>
                    <button
                      v-if="d.canDiscard"
                      type="button"
                      class="sc-action"
                      :class="{ disabled: isExecutingBulk }"
                      :title="node.area === 'untracked' ? t('changes.action.deleteUntrackedInFolder', 'Delete untracked in folder') : t('changes.action.discardFolder', 'Discard folder')"
                      :aria-label="node.area === 'untracked' ? t('changes.action.deleteUntrackedInFolder', 'Delete untracked in folder') : t('changes.action.discardFolder', 'Discard folder')"
                      data-test="sc-dir-discard"
                      @click="requestDiscardAllInArea(node.area, d.discardPaths)"
                    >
                      <LucideIcon :name="node.area === 'untracked' ? 'trash' : 'undo2'" :size="14" />
                    </button>
                    <button
                      v-if="d.canStage"
                      type="button"
                      class="sc-action"
                      :class="{ disabled: isExecutingBulk }"
                      :title="t('changes.action.stageFolder', 'Stage folder')"
                      :aria-label="t('changes.action.stageFolder', 'Stage folder')"
                      data-test="sc-dir-stage"
                      @click="stagePaths(d.stagePaths)"
                    >
                      <LucideIcon name="plus" :size="14" />
                    </button>
                    <button
                      v-if="d.canUnstage"
                      type="button"
                      class="sc-action"
                      :class="{ disabled: isExecutingBulk }"
                      :title="t('changes.action.unstageFolder', 'Unstage folder')"
                      :aria-label="t('changes.action.unstageFolder', 'Unstage folder')"
                      data-test="sc-dir-unstage"
                      @click="unstagePaths(d.unstagePaths)"
                    >
                      <LucideIcon name="minus" :size="14" />
                    </button>
                  </div>
                </template>
              </div>
              <!-- A changed file (listing/uncommitted-entry-row.tsx) -->
              <div
                v-else
                class="sc-row"
                :class="{ current: openKey === rowKey(node.entry) }"
                :style="filePad(node)"
                :data-path="node.entry.path"
                :data-area="node.entry.area"
                :title="t('changes.row.title', '{{path}} ({{status}})', { path: node.entry.path, status: statusTitle(node.entry.status) })"
                data-test="changes-row"
                data-scm-row
                tabindex="-1"
                @click="openDiff(node.entry)"
                @dblclick="openDiff(node.entry, true)"
                @keydown="onRowKeydown($event, node)"
              >
                <component :is="getFileTypeIcon(node.entry.path)" :size="14" class="sc-file-icon" :style="{ color: STATUS_COLORS[node.entry.status] }" />
                <div class="sc-row-text">
                  <span class="sc-row-line">
                    <span class="sc-row-name explorer-name">{{ fileName(node.entry.path) }}</span>
                    <span v-if="viewMode === 'list' && dirName(node.entry.path)" class="sc-row-dir explorer-hit-dir">{{ dirName(node.entry.path) }}</span>
                  </span>
                  <div v-if="node.entry.conflictKind" class="sc-row-sub">{{ conflictKindLabel(node.entry.conflictKind) }}</div>
                </div>
                <span v-if="noteCountByPath.get(node.entry.path)" class="sc-row-notes" :title="notesCountTitle(noteCountByPath.get(node.entry.path))">
                  <LucideIcon name="messageSquare" :size="12" />
                  <span>{{ noteCountByPath.get(node.entry.path) }}</span>
                </span>
                <span v-if="node.entry.conflictStatus === 'unresolved'" class="sc-conflict-badge" role="status">
                  <LucideIcon name="triangleAlert" :size="12" /><span>{{ t('changes.row.unresolved', 'Unresolved') }}</span>
                </span>
                <template v-else>
                  <span v-if="node.entry.added > 0 || node.entry.removed > 0" class="sc-counts">
                    <span v-if="node.entry.added > 0" class="sc-plus">+{{ node.entry.added }}</span>
                    <span v-if="node.entry.added > 0 && node.entry.removed > 0">{{ ' ' }}</span>
                    <span v-if="node.entry.removed > 0" class="sc-minus">-{{ node.entry.removed }}</span>
                  </span>
                  <span class="sc-status" :style="{ color: STATUS_COLORS[node.entry.status] }">{{ STATUS_LABELS[node.entry.status] }}</span>
                </template>
                <div class="sc-row-actions" @click.stop @dblclick.stop>
                  <button
                    v-if="canDiscardStatusEntry(node.entry)"
                    type="button"
                    class="sc-action"
                    :title="discardTitle(node.entry)"
                    :aria-label="discardTitle(node.entry)"
                    data-test="sc-discard"
                    @click="requestDiscardEntry(node.entry)"
                  >
                    <LucideIcon :name="node.entry.area === 'untracked' ? 'trash' : 'undo2'" :size="14" />
                  </button>
                  <button
                    v-if="canStageStatusEntry(node.entry)"
                    type="button"
                    class="sc-action"
                    :title="t('changes.action.stage', 'Stage')"
                    :aria-label="t('changes.action.stage', 'Stage')"
                    data-test="sc-stage"
                    @click="stage(node.entry.path)"
                  >
                    <LucideIcon name="plus" :size="14" />
                  </button>
                  <button
                    v-if="canUnstageStatusEntry(node.entry)"
                    type="button"
                    class="sc-action"
                    :title="t('changes.action.unstage', 'Unstage')"
                    :aria-label="t('changes.action.unstage', 'Unstage')"
                    data-test="sc-unstage"
                    @click="unstage(node.entry.path)"
                  >
                    <LucideIcon name="minus" :size="14" />
                  </button>
                </div>
              </div>
            </template>
          </template>
        </div>

        <div v-if="loaded && data && data.repo && !hasUncommittedEntries && !normalizedFilter" class="sc-empty" data-test="sc-empty">
          <div class="sc-empty-heading">{{ t('changes.empty.title', 'No changes') }}</div>
          <div class="sc-empty-text">{{ t('changes.empty.text', 'This workspace is clean: everything is committed.') }}</div>
        </div>
        <div v-if="normalizedFilter && !filtered.length" class="sc-empty">
          <div class="sc-empty-heading">{{ t('changes.filter.noMatchTitle', 'No matching files') }}</div>
          <div class="sc-empty-text" v-text="noMatchText()"></div>
        </div>
        <div v-if="!loaded" class="explorer-empty">{{ t('changes.reading', 'Reading git status…') }}</div>

        <!-- Commits, docked at the bottom as the list scrolls (sync/git-history-panel.tsx). -->
        <div v-if="data && data.repo" class="sc-history-dock">
          <ScmHistoryPanel :root="repoRoot" :head="data.head || ''" :base="compare && compare.base ? compare.base : null" @open-file="openCommitFile" />
        </div>
      </template>
    </div>
  </div>
</template>
