<!-- i18n-pending: text here does not go through t() yet -->
<script setup>
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
import { ref, computed, watch, inject, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { tasks } from '../taskBoardStore'
import { settings } from '../settings'
import { refreshStatus, statusOf, bumpRevision, rootKey } from '../scmState'
import { notesFor, deleteNote, clearNotes, clearDelivered } from '../reviewNotes'
import {
  STATUS_LABELS,
  STATUS_COLORS,
  STATUS_TITLES,
  SECTION_LABELS,
  CONFLICTS_SECTION_LABEL,
  CONFLICT_KIND_LABELS,
  buildDisplaySections,
  resolveSourceControlGroupOrder,
  canStageStatusEntry,
  canUnstageStatusEntry,
  canDiscardStatusEntry,
  getStageAllPaths,
  getUnstageAllPaths,
  getDiscardAllPaths,
  getDiscardEntryConfirmationCopy,
  getDiscardAreaConfirmationCopy,
  getCommitMessageTextareaRows,
  resolvePrimaryAction,
  resolveDropdownItems,
  formatDiffComment,
  formatDiffComments,
  getDiffCommentLineLabel,
  getListLineLabel,
  conflictSummaryTitle,
  operationBannerTitle
} from '../../../shared/sourceControl'
import LucideIcon from './LucideIcon.vue'
import NotesSendMenu from './NotesSendMenu.vue'

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
  tasks.filter((t) => t.worktree && t.worktree.path && (!props.workspaceId || t.wsId === props.workspaceId) && t.column !== 'done')
)
const target = ref('project') // 'project' | task id
const copyTask = computed(() => (target.value === 'project' ? null : copies.value.find((t) => t.id === target.value) || null))
const repoRoot = computed(() => (copyTask.value ? copyTask.value.worktree.path : props.root))
watch(copies, (list) => {
  if (target.value !== 'project' && !list.some((t) => t.id === target.value)) target.value = 'project'
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
const allNotesScopes = computed(() => [{ id: 'all', label: 'All unsent notes', notes: unsentNotes.value, prompt: formatDiffComments(unsentNotes.value) }])
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
    emit('toast', 'Failed to copy notes')
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
        title: filePath ? `Clear notes for ${filePath}?` : 'Clear all notes?',
        text: `This will permanently delete ${count} note${count === 1 ? '' : 's'}. This cannot be undone.`,
        confirmLabel: 'Clear',
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
  if (!res || !res.ok) emit('toast', `${failure}: ${(res && res.error) || 'unknown error'}`)
  await afterMutation()
  return !!(res && res.ok)
}
const stage = (path) => runGit(() => api().stage({ root: repoRoot.value, paths: [path] }), `Failed to stage ${fileName(path)}`)
const unstage = (path) => runGit(() => api().unstage({ root: repoRoot.value, paths: [path] }), `Failed to unstage ${fileName(path)}`)
async function stagePaths(paths) {
  if (!paths.length || isExecutingBulk.value) return
  isExecutingBulk.value = true
  try {
    await runGit(() => api().stage({ root: repoRoot.value, paths }), 'Failed to stage')
  } finally {
    isExecutingBulk.value = false
  }
}
async function unstagePaths(paths) {
  if (!paths.length || isExecutingBulk.value) return
  isExecutingBulk.value = true
  try {
    await runGit(() => api().unstage({ root: repoRoot.value, paths }), 'Failed to unstage')
  } finally {
    isExecutingBulk.value = false
  }
}
async function confirmDiscard(copy, pathText) {
  if (!askConfirm) return false
  return (await askConfirm({ title: copy.title, text: `${copy.description}\n${pathText}`, confirmLabel: copy.confirmLabel, danger: true })) === true
}
async function requestDiscardEntry(entry) {
  const copy = getDiscardEntryConfirmationCopy(entry)
  if (!(await confirmDiscard(copy, entry.path))) return
  await runGit(() => api().discard({ root: repoRoot.value, paths: [entry.path] }), `Failed to discard ${fileName(entry.path)}`)
}
async function requestDiscardAllInArea(area, paths) {
  if (!paths.length || isExecutingBulk.value) return
  const copy = getDiscardAreaConfirmationCopy(area, paths.length)
  if (!(await confirmDiscard(copy, `${paths.length} ${paths.length === 1 ? 'file' : 'files'}`))) return
  isExecutingBulk.value = true
  try {
    await runGit(() => api().discard({ root: repoRoot.value, paths }), 'Failed to discard')
  } finally {
    isExecutingBulk.value = false
  }
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
  if (isGenerating.value) return 'Generating commit message…'
  if (isCommitting.value) return 'Commit in progress…'
  if (stagedEntries.value.length === 0) return 'Stage at least one file to generate a message.'
  if (hasMessage.value) return 'Clear the message to regenerate.'
  return `Generate a commit message with ${generateAgent.value === 'codex' ? 'Codex' : 'Claude'} from the staged changes`
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
  commitError.value = (res && res.error) || 'Commit failed.'
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
const REMOTE_FAIL = { push: 'Push failed', publish: 'Publish failed', pull: 'Pull failed', fast_forward: 'Fast-forward failed', sync: 'Sync failed', fetch: 'Fetch failed' }
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
  if (!res || !res.ok) remoteActionError.value = `${REMOTE_FAIL[kind]}: ${(res && res.error) || 'unknown error'}`
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
  closeMenu()
  if (kind === 'commit') await commit()
  else if (kind === 'commit_push') {
    if (await commit()) await remote('push')
  } else if (kind === 'commit_sync') {
    if (await commit()) await remote('sync')
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
  } else if (!(res && res.cancelled)) generateError.value = `Could not generate a commit message: ${(res && res.error) || 'unknown error'}`
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
const canCreatePr = computed(() => !!(data.value && data.value.repo && data.value.branch && (data.value.remotes || []).length))
function createPr() {
  closeMore()
  emit('create-pr', { cwd: top.value, taskId: copyTask.value ? copyTask.value.id : null })
}
const branchTitle = computed(() => {
  const d = data.value
  if (!d || !d.repo) return ''
  if (!d.branch) return 'Detached HEAD'
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
  load()
})
function onFocus() {
  schedule()
}
onMounted(() => {
  load()
  poll = setInterval(() => {
    if (copyTask.value && !document.hidden) load()
  }, 4000)
  window.addEventListener('focus', onFocus)
})
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(timer)
  clearTimeout(copiedTimer)
  clearInterval(poll)
  window.removeEventListener('focus', onFocus)
  closeMenu()
  closeMore()
})
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
  <div class="changes sc-root" aria-label="Source Control" data-test="changes-panel" @keydown="onRootKeydown">
    <div class="sc-header">
      <div v-if="!filterExpanded" class="sc-header-row">
        <select
          v-if="root && copies.length"
          v-model="target"
          class="sc-repo-select"
          title="Show the changes of the project or of a task's own copy"
          aria-label="Repository"
          data-test="changes-target"
        >
          <option value="project">Project</option>
          <option v-for="t in copies" :key="t.id" :value="t.id">{{ t.title }}</option>
        </select>
        <span v-else class="sc-title">Source Control</span>
        <span class="sc-fill" aria-hidden="true"></span>
        <button
          v-if="copyTask"
          type="button"
          class="sc-btn-xs sc-review-btn"
          title="Review this task's branch: its commits, then merge or discard"
          data-test="review-changes"
          @click="emit('review', copyTask.id)"
        >
          Review &amp; merge
        </button>
        <button
          v-else-if="canCreatePr"
          type="button"
          class="sc-btn-xs"
          title="Create a pull request for this branch"
          data-test="sc-create-pr"
          @click="createPr"
        >
          <LucideIcon name="gitPullRequestArrow" :size="14" />
          Create PR
        </button>
        <button
          type="button"
          class="sc-icon-btn"
          :class="{ on: normalizedFilter }"
          :title="normalizedFilter ? `Filter: ${filterQuery}` : 'Filter files by name'"
          :aria-label="normalizedFilter ? `Filter: ${filterQuery}` : 'Filter files by name'"
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
          title="More source control actions"
          aria-label="More source control actions"
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
          placeholder="Filter files…"
          aria-label="Filter files…"
          data-test="source-control-filter-input"
          @keydown.escape.prevent.stop="filterExpanded = false"
        />
        <button type="button" class="sc-icon-btn" title="Clear and close filter" aria-label="Clear and close filter" @click="clearAndCollapseFilter">
          <LucideIcon name="x" :size="14" />
        </button>
      </div>
      <div v-if="data && data.repo" class="sc-branch-row" data-test="sc-branch">
        <LucideIcon name="gitBranch" :size="12" class="sc-dim" />
        <span class="sc-branch-name" :title="branchTitle" :aria-label="`Current branch: ${branchTitle}`">{{ branchTitle }}</span>
        <template v-if="data.hasUpstream">
          <span class="sc-upstream" :title="`Tracking ${data.upstream}`">
            <span v-if="data.ahead" title="Commits to push">↑{{ data.ahead }}</span>
            <span v-if="data.behind" title="Commits to pull">↓{{ data.behind }}</span>
            <span v-if="!data.ahead && !data.behind" class="sc-dim">{{ data.upstream }}</span>
          </span>
        </template>
        <span v-else-if="data.branch" class="sc-upstream sc-dim" title="This branch has no upstream yet">not published</span>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="moreOpen" ref="moreEl" class="ctx-menu sc-menu" role="menu" :style="{ top: morePos.top + 'px', right: morePos.right + 'px' }" data-test="sc-more-menu">
        <button type="button" class="ctx-menu-item" role="menuitem" @click="closeMore(), load()">
          <span class="sc-menu-row"><LucideIcon name="refreshCw" :size="14" />Refresh</span>
        </button>
        <button type="button" class="ctx-menu-item" role="menuitem" :disabled="!canCreatePr" @click="createPr">
          <span class="sc-menu-row"><LucideIcon name="gitPullRequestArrow" :size="14" />Create PR…</span>
        </button>
        <template v-if="notes.length">
          <div class="ctx-menu-sep"></div>
          <button type="button" class="ctx-menu-item" role="menuitem" @click="closeMore(), (notesExpanded = true)">
            <span class="sc-menu-row"><LucideIcon name="messageSquare" :size="14" />Notes</span>
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
          :title="notesExpanded ? 'Collapse notes' : 'Expand notes'"
          data-test="sc-notes-toggle"
          @click="notesExpanded = !notesExpanded"
        >
          <LucideIcon name="chevronDown" :size="12" :class="{ 'sc-rot': !notesExpanded }" />
          <LucideIcon name="messageSquare" :size="14" />
          <span>Notes</span>
          <span class="sc-notes-count">{{ notes.length }}</span>
        </button>
        <span class="sc-notes-actions">
          <NotesSendMenu :scopes="allNotesScopes" trigger-class="sc-notes-btn" @delivered="onNotesDelivered" />
          <button type="button" class="sc-notes-btn" aria-label="Copy all notes to clipboard" title="Copy all notes" @click="copyAllNotes">
            <LucideIcon :name="notesCopied ? 'check' : 'copy'" :size="14" />
          </button>
          <span class="sc-rel">
            <button type="button" class="sc-notes-btn" aria-label="More note actions" title="More note actions" @click="notesMenuOpen = !notesMenuOpen">
              <LucideIcon name="moreHorizontal" :size="14" />
            </button>
            <div v-if="notesMenuOpen" class="ctx-menu sc-notes-menu" role="menu">
              <button type="button" class="ctx-menu-item danger" role="menuitem" data-test="sc-clear-notes" @click="askClearNotes()">
                <span class="sc-menu-row"><LucideIcon name="trash2" :size="14" />Clear all notes...</span>
              </button>
            </div>
          </span>
        </span>
      </div>
      <div v-if="notesExpanded" class="sc-notes-list" data-test="sc-notes-list">
        <div v-for="[filePath, list] in noteGroups" :key="filePath" class="sc-notes-file">
          <div class="sc-notes-file-head">
            <button type="button" class="sc-notes-file-name" :title="`Open ${filePath}`" @click="openNote(list[0])">{{ filePath }}</button>
            <button type="button" class="sc-note-mini danger" :title="`Clear notes for ${filePath}`" :aria-label="`Clear notes for ${filePath}`" @click="askClearNotes(filePath)">
              <LucideIcon name="trash2" :size="12" />
            </button>
          </div>
          <ul class="sc-notes-ul">
            <li v-for="c in list" :key="c.id" class="sc-note" data-test="sc-note">
              <button
                type="button"
                class="sc-note-open"
                :title="`Open ${c.filePath} (${getListLineLabel(c)})`"
                :aria-label="`Open note on ${getListLineLabel(c)}`"
                @click="openNote(c)"
              >
                <span class="sc-chip">{{ getDiffCommentLineLabel(c, true) }}</span>
                <span class="sc-chip sc-chip-soft">Diff</span>
                <span v-if="c.sentAt" class="sc-chip sc-chip-soft">Sent</span>
                <span class="sc-note-body">{{ c.body }}</span>
              </button>
              <button type="button" class="sc-note-mini" title="Copy note" :aria-label="`Copy note on line ${c.lineNumber}`" @click="copyNote(c)">
                <LucideIcon :name="copiedNoteId === c.id ? 'check' : 'copy'" :size="12" />
              </button>
              <button type="button" class="sc-note-mini danger" title="Delete note" :aria-label="`Delete note on line ${c.lineNumber}`" @click="deleteNote(top, c.id)">
                <LucideIcon name="trash" :size="12" />
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <div class="sc-scroll explorer-tree">
      <div v-if="!root && !copyTask" class="explorer-empty">This workspace has no project folder. Choose one from the workspace menu (Project folder…) to see its changes here.</div>
      <div v-else-if="loaded && error" class="explorer-empty explorer-error" data-test="changes-error">Could not read the git status: {{ error }}</div>
      <div v-else-if="loaded && data && !data.repo" class="explorer-empty">This folder is not in a git repository.</div>
      <template v-else>
        <!-- Conflicts / an operation stopped half way -->
        <div v-if="unresolved.length" class="sc-pad">
          <div class="sc-conflict-card" role="alert">
            <div class="sc-conflict-title"><LucideIcon name="triangleAlert" :size="14" />{{ conflictSummaryTitle(data && data.operation) }}</div>
            <div class="sc-conflict-text">{{ conflictSummaryTitle(data && data.operation) }}: {{ unresolved.length }} unresolved</div>
            <div class="sc-conflict-hint">Resolved files move back to normal changes after they leave the live conflict state.</div>
          </div>
        </div>
        <div v-else-if="data && data.operation" class="sc-pad">
          <div class="sc-conflict-card sc-op-card">
            <div class="sc-conflict-title">{{ operationBannerTitle(data.operation) }}</div>
          </div>
        </div>

        <!-- The commit area stays mounted (Orca keeps it on clean trees too). -->
        <div v-if="data && data.repo" class="sc-commit" data-test="sc-commit">
          <div class="sc-composer">
            <textarea
              v-model="commitMessage"
              class="sc-commit-msg"
              :class="{ 'with-generate': true }"
              :rows="rows"
              :disabled="commitFieldDisabled"
              placeholder="Message"
              aria-label="Commit message"
              spellcheck="false"
              data-test="sc-commit-message"
            ></textarea>
            <button
              v-if="isGenerating"
              type="button"
              class="sc-generate cancel"
              title="Generating commit message. Click to stop."
              aria-label="Stop generating commit message"
              data-test="sc-generate-stop"
              @click="cancelGenerate"
            >
              <LucideIcon name="refreshCw" :size="14" class="sc-spin sc-gen-spin" />
              <LucideIcon name="square" :size="14" class="sc-gen-stop" />
            </button>
            <button
              v-else
              type="button"
              class="sc-generate"
              :class="{ disabled: isGenerateDisabled }"
              :aria-disabled="isGenerateDisabled"
              :title="generateTooltip"
              aria-label="Generate commit message with AI"
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
              :title="primaryAction.title"
              data-test="sc-primary"
              @click="onPrimaryAction"
            >
              <LucideIcon v-if="showSpinner" name="loader2" :size="14" class="sc-spin" />
              <LucideIcon v-else-if="primaryIcon" :name="primaryIcon" :size="14" />
              {{ primaryAction.label }}
            </button>
            <button
              ref="chevronEl"
              type="button"
              class="sc-chevron"
              :class="{ dim: primaryAction.disabled }"
              title="More commit and remote actions"
              aria-label="More commit and remote actions"
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
                :title="item.title"
                :data-kind="item.kind"
                @click="onDropdownAction(item.kind)"
              >
                <span>{{ item.label }}</span>
              </button>
            </template>
          </div>
        </Teleport>

        <!-- Changes / Staged Changes / Untracked Files -->
        <div v-for="section in displaySections" :key="section.id" class="sc-section" :data-section="section.id">
          <div class="sc-section-header">
            <div class="sc-section-row">
              <button type="button" class="sc-section-toggle" :aria-expanded="!collapsed.has(section.id)" data-test="sc-section-toggle" @click="toggleSection(section.id)">
                <LucideIcon name="chevronDown" :size="14" :class="{ 'sc-rot': collapsed.has(section.id) }" />
                <span class="sc-section-label" :title="section.id === 'conflicts' ? CONFLICTS_SECTION_LABEL : SECTION_LABELS[section.area]">{{
                  section.id === 'conflicts' ? CONFLICTS_SECTION_LABEL : SECTION_LABELS[section.area]
                }}</span>
                <span class="sc-section-count" data-test="changes-count">{{ section.items.length }}</span>
              </button>
              <span class="sc-section-actions">
                <template v-for="a in [sectionActions(section)]" :key="'a'">
                  <button
                    v-if="a.canRevertAll"
                    type="button"
                    class="sc-action"
                    :class="{ disabled: isExecutingBulk }"
                    :title="section.area === 'untracked' ? 'Delete all untracked' : 'Discard all'"
                    :aria-label="section.area === 'untracked' ? 'Delete all untracked' : 'Discard all'"
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
                    title="Stage all"
                    aria-label="Stage all"
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
                    title="Unstage all"
                    aria-label="Unstage all"
                    data-test="sc-unstage-all"
                    @click.stop="unstagePaths(a.unstageAll)"
                  >
                    <LucideIcon name="minus" :size="14" />
                  </button>
                </template>
              </span>
            </div>
          </div>
          <template v-if="!collapsed.has(section.id)">
            <div
              v-for="entry in section.items"
              :key="rowKey(entry)"
              class="sc-row"
              :class="{ current: openKey === rowKey(entry) }"
              :data-path="entry.path"
              :data-area="entry.area"
              :title="`${entry.path} (${STATUS_TITLES[entry.status] || entry.status})`"
              data-test="changes-row"
              @click="openDiff(entry)"
              @dblclick="openDiff(entry, true)"
            >
              <LucideIcon name="file" :size="14" class="sc-file-icon" :style="{ color: STATUS_COLORS[entry.status] }" />
              <div class="sc-row-text">
                <span class="sc-row-line">
                  <span class="sc-row-name explorer-name">{{ fileName(entry.path) }}</span>
                  <span v-if="dirName(entry.path)" class="sc-row-dir explorer-hit-dir">{{ dirName(entry.path) }}</span>
                </span>
                <div v-if="entry.conflictKind" class="sc-row-sub">{{ CONFLICT_KIND_LABELS[entry.conflictKind] }}</div>
              </div>
              <span
                v-if="noteCountByPath.get(entry.path)"
                class="sc-row-notes"
                :title="`${noteCountByPath.get(entry.path)} note${noteCountByPath.get(entry.path) === 1 ? '' : 's'}`"
              >
                <LucideIcon name="messageSquare" :size="12" />
                <span>{{ noteCountByPath.get(entry.path) }}</span>
              </span>
              <span v-if="entry.conflictStatus === 'unresolved'" class="sc-conflict-badge" role="status">
                <LucideIcon name="triangleAlert" :size="12" /><span>Unresolved</span>
              </span>
              <template v-else>
                <span v-if="entry.added > 0 || entry.removed > 0" class="sc-counts">
                  <span v-if="entry.added > 0" class="sc-plus">+{{ entry.added }}</span>
                  <span v-if="entry.added > 0 && entry.removed > 0">{{ ' ' }}</span>
                  <span v-if="entry.removed > 0" class="sc-minus">-{{ entry.removed }}</span>
                </span>
                <span class="sc-status" :style="{ color: STATUS_COLORS[entry.status] }">{{ STATUS_LABELS[entry.status] }}</span>
              </template>
              <div class="sc-row-actions" @click.stop @dblclick.stop>
                <button
                  v-if="canDiscardStatusEntry(entry)"
                  type="button"
                  class="sc-action"
                  :title="entry.area === 'untracked' ? 'Delete untracked file' : entry.status === 'deleted' ? 'Restore file' : 'Discard changes'"
                  :aria-label="entry.area === 'untracked' ? 'Delete untracked file' : entry.status === 'deleted' ? 'Restore file' : 'Discard changes'"
                  data-test="sc-discard"
                  @click="requestDiscardEntry(entry)"
                >
                  <LucideIcon :name="entry.area === 'untracked' ? 'trash' : 'undo2'" :size="14" />
                </button>
                <button v-if="canStageStatusEntry(entry)" type="button" class="sc-action" title="Stage" aria-label="Stage" data-test="sc-stage" @click="stage(entry.path)">
                  <LucideIcon name="plus" :size="14" />
                </button>
                <button v-if="canUnstageStatusEntry(entry)" type="button" class="sc-action" title="Unstage" aria-label="Unstage" data-test="sc-unstage" @click="unstage(entry.path)">
                  <LucideIcon name="minus" :size="14" />
                </button>
              </div>
            </div>
          </template>
        </div>

        <div v-if="loaded && data && data.repo && !hasUncommittedEntries && !normalizedFilter" class="sc-empty" data-test="sc-empty">
          <div class="sc-empty-heading">No changes</div>
          <div class="sc-empty-text">This workspace is clean: everything is committed.</div>
        </div>
        <div v-if="normalizedFilter && !filtered.length" class="sc-empty">
          <div class="sc-empty-heading">No matching files</div>
          <div class="sc-empty-text">No changed files match "{{ filterQuery }}"</div>
        </div>
        <div v-if="!loaded" class="explorer-empty">Reading git status…</div>
      </template>
    </div>
  </div>
</template>
