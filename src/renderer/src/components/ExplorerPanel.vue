<script setup>
// The file explorer (after Orca's): the workspace's project as a tree, with
// its git status (M modified, A added, D deleted, R renamed, U untracked),
// kept current as files change. Click a file to open it (Markdown, tables,
// images… in Tessel's viewer; code in your editor); right-click for more;
// drag a file onto a terminal to type its path there. Search by name (in
// folders not opened yet too) or by content; git-ignored files are dimmed.
// A sparse checkout: the tree can show one of its folders as its root.
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import ThemedSelect from './ui/ThemedSelect.vue'
import { statusOf, folderStatus, ignoredSet, isIgnored } from '../explorerStatus'
import { buildRows, toggledPaths, soleSubfolder, activeGuide, segmentOf, rowPadding, guideX, INDENT } from '../explorerRows'
import { settings } from '../settings'
import { isRemotePath, remoteHostPath } from '../../../shared/remotePath'
import { t } from '../i18n'

const props = defineProps({
  root: { type: String, default: null },
  // A pane to type paths into (the active one), for "Insert path".
  canInsert: { type: Boolean, default: false }
})
const emit = defineEmits(['open', 'open-editor', 'open-external', 'terminal-here', 'insert-path', 'toast', 'close'])

const nodes = reactive({}) // path -> { entries, loading, error }
const open = reactive({}) // folder path -> true when expanded
const status = ref({}) // full path (lower case) -> letter
const repo = ref(false)
const dotfiles = ref(true)
const selected = ref(null)
// Search: by 'names' or 'content'; results replace the tree while it has text.
const query = ref('')
const mode = ref('names')
const search = reactive({ busy: false, results: [], truncated: false, error: '', done: false })
const moreOpen = ref(false)
let viewRevision = 0
let disposed = false
let statusRequest = 0
const directoryRequests = new Map()
const stillCurrent = (revision, root) => !disposed && revision === viewRevision && root === props.root

const api = () => window.shellApi.explorer
const key = (p) => String(p || '').toLowerCase()
const rootName = computed(() => (props.root ? props.root.split(/[\\/]/).filter(Boolean).pop() : ''))
// A project on a remote host (its root is an ssh://… path): the same tree,
// read over ssh; paths shown, copied or typed are the host's (POSIX).
const remote = computed(() => isRemotePath(props.root))
const hostPath = (p) => (remote.value ? remoteHostPath(p) || p : p)

// --- Sparse checkout ----------------------------------------------------------------
// After Orca's sparse-scoped file tree (file-explorer-display-root.ts, MIT,
// Copyright (c) 2026 Lovecast Inc.): when the project's repository keeps only
// some folders (git sparse-checkout), the tree can show one of them as its
// root. A sole folder is shown by itself; with several, the whole project
// until one is chosen. The choice is kept per project while Tessel runs.
// It changes what the tree shows, never what is checked out.
const WHOLE = ''
const sparseDirs = ref([]) // [{ rel: 'a/b', path }]
const scope = ref(WHOLE) // the rel shown, or WHOLE
const scopeByRoot = new Map() // project (lower case) -> rel | WHOLE
const displayRoot = computed(() => {
  const d = scope.value ? sparseDirs.value.find((x) => x.rel === scope.value) : null
  return d ? d.path : props.root
})
async function loadSparse() {
  const root = props.root
  const fn = api() && api().sparse
  const res = root && fn ? await fn({ root }).catch(() => null) : null
  if (root !== props.root) return
  const dirs = res && res.ok && res.sparse && Array.isArray(res.dirs) ? res.dirs : []
  sparseDirs.value = dirs
  const saved = scopeByRoot.get(key(root))
  scope.value = saved !== undefined && (saved === WHOLE || dirs.some((d) => d.rel === saved)) ? saved : dirs.length === 1 ? dirs[0].rel : WHOLE
}
function chooseScope(rel) {
  const v = typeof rel === 'string' ? rel : WHOLE
  scopeByRoot.set(key(props.root), v)
  scope.value = v
}
const scopeHelp = computed(() =>
  t('explorer.sparse.help', 'This repository uses a sparse checkout: only some folders are on disk. Choosing one changes what the tree shows, not what is checked out. Name search looks in the folder shown; content search in the whole project.')
)

async function loadDir(dir) {
  if (!api() || !props.root) return
  const revision = viewRevision, root = props.root
  const request = Symbol()
  directoryRequests.set(dir, request)
  const cur = nodes[dir] || { entries: [], loading: false, error: '' }
  nodes[dir] = { ...cur, loading: true }
  const res = await api().list({ root, dir, dotfiles: dotfiles.value }).catch(() => null)
  if (!stillCurrent(revision, root) || directoryRequests.get(dir) !== request) return
  nodes[dir] = res && res.ok ? { entries: res.entries, loading: false, error: '' } : { entries: [], loading: false, error: (res && res.error) || t('explorer.readFailed', 'Could not read it.') }
}
async function loadStatus() {
  if (!api() || !props.root) return
  const revision = viewRevision, root = props.root, request = ++statusRequest
  const res = await api().status({ root, ignored: true }).catch(() => null)
  if (!stillCurrent(revision, root) || request !== statusRequest) return
  if (!res || !res.ok) return
  const out = {}
  for (const [p, l] of Object.entries(res.files || {})) out[key(p)] = l
  status.value = out
  repo.value = !!res.repo
}
// Everything shown again: the open folders and the git status.
async function refresh() {
  if (!props.root) return
  const revision = viewRevision, root = props.root
  const dirs = [...new Set([props.root, displayRoot.value, ...Object.keys(open).filter((d) => open[d])])]
  await Promise.all([...dirs.map(loadDir), loadSparse()])
  if (!stillCurrent(revision, root)) return
  loadStatus()
  if (query.value.trim()) runSearch()
}
const folderStatuses = computed(() => folderStatus(status.value, key(props.root)))
const ignored = computed(() => ignoredSet(status.value))

// Settings > Appearance, "Show Git-Ignored Files" off: hidden.
const hiddenEntry = (e) => !settings.showGitIgnoredFiles && ignoredOf(e.path)
// What is being renamed or getting a new child stands on its own row.
const noJoin = computed(() => {
  const ed = edit.value
  if (!ed) return null
  return new Set([ed.mode === 'rename' ? ed.entry.path : ed.dir])
})
// The rows shown: open folders' children, depth first; a chain of folders
// each holding a single folder on one row (compact folders, like VS Code).
const tree = computed(() =>
  buildRows({
    root: props.root ? displayRoot.value : null,
    nodes,
    open,
    compact: settings.explorerCompactFolders !== false,
    hidden: hiddenEntry,
    noJoin: noJoin.value
  })
)
const rows = computed(() => tree.value.rows)
// The brighter indent guide, under the selected folder (or its parent).
const guide = computed(() => activeGuide(tree.value.rows, tree.value.index, selected.value))
const inGuide = (i) => !!guide.value && i >= guide.value.from && i < guide.value.to
// The selected folder of a compact row (-1: the row is not selected).
const segSelected = (row, i) => (selected.value != null && tree.value.index.get(selected.value) === i ? segmentOf(row, selected.value) : -1)
function letterOf(e) {
  return e.dir ? folderStatuses.value[key(e.path)] || '' : statusOf(status.value, key(e.path))
}
const ignoredOf = (p) => isIgnored(ignored.value, key(p), key(props.root))
// Search results without git-ignored files when they are hidden.
const shownResults = computed(() =>
  settings.showGitIgnoredFiles ? search.results : search.results.filter((h) => !ignoredOf(h.path))
)

// --- Search ------------------------------------------------------------------------
let searchTimer = 0
let searchSeq = 0
const searching = computed(() => !!query.value.trim())
async function runSearch() {
  clearTimeout(searchTimer)
  const q = query.value.trim()
  const seq = ++searchSeq
  if (!q || !props.root || !api()) {
    Object.assign(search, { busy: false, results: [], truncated: false, error: '', done: false })
    return
  }
  search.busy = true
  const fn = mode.value === 'content' ? api().searchContent : api().searchNames
  // Names: in the folder the tree shows; contents: the whole project.
  const within = mode.value === 'names' && displayRoot.value !== props.root ? { dir: displayRoot.value } : {}
  const res = fn
    ? await fn({ root: props.root, ...within, query: mode.value === 'content' ? query.value : q, dotfiles: dotfiles.value }).catch((err) => ({ ok: false, error: err.message }))
    : { ok: false, error: t('explorer.search.unavailable', 'Search is not available.') }
  if (seq !== searchSeq) return // a newer search is on its way
  Object.assign(search, {
    busy: false,
    results: res && res.ok ? res.results : [],
    truncated: !!(res && res.truncated),
    error: res && res.ok ? '' : (res && res.error) || t('explorer.search.failed', 'The search failed.'),
    done: true
  })
}
// Names as you type; contents a little after you stop (they cost more).
function scheduleSearch() {
  clearTimeout(searchTimer)
  if (!query.value.trim()) return runSearch()
  search.busy = true
  searchTimer = setTimeout(runSearch, mode.value === 'content' ? 300 : 120)
}
watch([query, mode], scheduleSearch)
function setMode(m) {
  mode.value = m
}
function clearSearch() {
  query.value = ''
}
const dirOf = (rel) => {
  const i = rel.search(/[\\/][^\\/]*$/)
  return i > 0 ? rel.slice(0, i) : ''
}
// A folder found by name: shown in the tree, its parents opened.
async function revealInTree(p) {
  const r = props.root.replace(/[\\/]+$/, '')
  const rel = relPath(p)
  const parts = rel === p ? [] : rel.split(/[\\/]/).filter(Boolean)
  let dir = r
  for (let i = 0; i < parts.length; i++) {
    dir = dir + '\\' + parts[i]
    open[dir] = true
    if (!nodes[dir]) await loadDir(dir)
  }
  query.value = ''
  selected.value = p
  nextTick(() => {
    const el = document.querySelector(`.explorer [data-path="${CSS.escape(p)}"]`) // i18n-ignore
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  })
}
function onHitClick(h) {
  selected.value = h.path + (h.line ? ':' + h.line : '')
  if (h.dir) revealInTree(h.path)
  else if (h.line) emit('open', h.path, h.line)
  else emit('open', h.path)
}

// --- The "…" menu ------------------------------------------------------------------
function moreAct(what) {
  moreOpen.value = false
  if (what === 'new-file') startNew(displayRoot.value, false)
  else if (what === 'new-folder') startNew(displayRoot.value, true)
  else if (what === 'dotfiles') dotfiles.value = !dotfiles.value
  else if (what === 'compact') settings.explorerCompactFolders = settings.explorerCompactFolders === false
}

// A row opens or closes as one: every folder of a compact row. A folder
// opened with a sole sub-folder opens it too, so the chain shows as one row
// (VS Code's autoExpandCompressedChildren); only with compact folders on.
async function toggleRow(row) {
  if (!row.dir) return
  const paths = toggledPaths(row)
  if (row.open) {
    for (const p of paths) delete open[p]
    return
  }
  for (const p of paths) open[p] = true
  let dir = row.path
  const revision = viewRevision
  for (let guard = 0; guard < 64 && dir; guard++) {
    if (!nodes[dir]) await loadDir(dir)
    if (revision !== viewRevision || !open[dir] || settings.explorerCompactFolders === false) return
    const next = soleSubfolder(nodes, dir, hiddenEntry)
    if (!next || open[next.path]) return
    open[next.path] = true
    dir = next.path
  }
}
// The segment of a compact row under the pointer (its last one elsewhere).
function segAt(ev, row) {
  const el = ev && ev.target && ev.target.closest ? ev.target.closest('[data-seg]') : null
  const i = el ? Number(el.dataset.seg) : -1
  return i >= 0 && i < row.chain.length ? i : row.chain.length - 1
}
let pressedSeg = -1
function onRowMouseDown(ev, row) {
  pressedSeg = segAt(ev, row)
}
// A click on a segment selects that folder; the row opens or closes.
function onRowClick(ev, row) {
  const e = row.chain[segAt(ev, row)]
  selected.value = e.path
  if (row.dir) toggleRow(row)
  else emit('open', e.path)
}
function rowOf(path) {
  const i = tree.value.index.get(path)
  return i === undefined ? null : rows.value[i]
}

// --- Keyboard ------------------------------------------------------------------------
// Like VS Code's explorer: up and down move between rows, right opens (or
// goes to the next folder of a compact row), left closes (or goes back a
// folder, then to the parent), Enter opens, F2 renames, Delete trashes.
const treeEl = ref(null)
function scrollToSelected() {
  nextTick(() => {
    const p = selected.value
    if (!p) return
    const tree = treeEl.value
    const el = tree ? [...tree.querySelectorAll('[data-path]')].find((x) => x.dataset.path === p) : null
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  })
}
function selectRow(i) {
  const list = rows.value
  if (!list.length) return
  const row = list[Math.max(0, Math.min(list.length - 1, i))]
  selected.value = row.path
  scrollToSelected()
}
function onTreeKey(ev) {
  if (ev.target && /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return
  const list = rows.value
  const cur = selected.value != null ? tree.value.index.get(selected.value) : undefined
  const row = cur === undefined ? null : list[cur]
  const seg = row ? segmentOf(row, selected.value) : -1
  const k = ev.key
  let done = true
  if (k === 'ArrowDown') selectRow(row ? cur + 1 : 0)
  else if (k === 'ArrowUp') selectRow(row ? cur - 1 : list.length - 1)
  else if (k === 'Home') selectRow(0)
  else if (k === 'End') selectRow(list.length - 1)
  else if (!row) done = false
  else if (k === 'ArrowRight') {
    if (seg < row.chain.length - 1) selected.value = row.chain[seg + 1].path
    else if (row.dir && !row.open) toggleRow(row)
    else if (row.dir && list[cur + 1] && list[cur + 1].depth > row.depth) selectRow(cur + 1)
  } else if (k === 'ArrowLeft') {
    if (seg > 0) selected.value = row.chain[seg - 1].path
    else if (row.dir && row.open) toggleRow(row)
    else if (rowOf(row.parent)) {
      selected.value = row.parent
      scrollToSelected()
    }
  } else if (k === 'Enter') {
    if (row.dir) toggleRow(row)
    else emit('open', row.path)
  } else if (k === 'F2') startRename(row.chain[seg])
  else if (k === 'Delete') trashIt(row.chain[seg])
  else done = false
  if (done) ev.preventDefault()
}
function collapseAll() {
  for (const k of Object.keys(open)) delete open[k]
}
const relPath = (p) => {
  const r = props.root.replace(/[\\/]+$/, '')
  if (!p.toLowerCase().startsWith(r.toLowerCase()) || !/^[\\/]/.test(p.slice(r.length))) return hostPath(p)
  const rel = p.slice(r.length + 1)
  return remote.value ? rel.replace(/\\/g, '/') : rel
}
// A path typed in a terminal: quoted for cmd / PowerShell, or for the
// host's POSIX shell (single quotes) in a remote project.
const posixQuoted = (p) => (/[^\w@%+=:,./-]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p)
const quoted = (p) => (remote.value ? posixQuoted(p) : /[\s&()^;,'"]/.test(p) ? `"${p}"` : p)

// --- Drag a file to a terminal -------------------------------------------------
// From a compact row: the folder pressed.
function onRowDragStart(ev, row) {
  onDragStart(ev, row.chain[pressedSeg >= 0 && pressedSeg < row.chain.length ? pressedSeg : row.chain.length - 1])
}
function onDragStart(ev, e) {
  if (!ev.dataTransfer) return
  ev.dataTransfer.setData('text/x-tessel-path', hostPath(e.path))
  ev.dataTransfer.setData('text/plain', hostPath(e.path))
  ev.dataTransfer.effectAllowed = 'copy'
}

// --- Context menu ----------------------------------------------------------------
const menu = reactive({ open: false, x: 0, y: 0, entry: null })
const menuEl = ref(null)
// On a compact row: the folder right-clicked (the last one off the names).
function onRowContext(ev, row) {
  onContext(ev, row.chain[segAt(ev, row)])
}
function onContext(ev, e) {
  ev.preventDefault()
  selected.value = e ? e.path : null
  menu.entry = e
  menu.x = Math.min(ev.clientX, window.innerWidth - 230)
  menu.y = Math.min(ev.clientY, window.innerHeight - 330)
  menu.open = true
  nextTick(() => menuEl.value && menuEl.value.focus())
}
function closeMenu() {
  menu.open = false
}
const menuDir = computed(() => {
  const e = menu.entry
  if (!e) return displayRoot.value
  return e.dir ? e.path : e.path.replace(/[\\/][^\\/]*$/, '')
})
function copy(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {})
  emit('toast', t('explorer.copied', 'Copied.'))
}
async function act(what) {
  const e = menu.entry
  closeMenu()
  if (what === 'open' && e) emit('open', e.path)
  else if (what === 'editor' && e) emit('open-editor', e.path)
  else if (what === 'external' && e) emit('open-external', e.path)
  else if (what === 'terminal') emit('terminal-here', menuDir.value)
  else if (what === 'insert' && e) emit('insert-path', quoted(relPath(e.path)))
  else if (what === 'copy' && e) copy(hostPath(e.path))
  else if (what === 'copy-rel' && e) copy(relPath(e.path))
  else if (what === 'reveal') await api().reveal({ root: props.root, path: e ? e.path : props.root })
  else if (what === 'new-file' || what === 'new-folder') startNew(menuDir.value, what === 'new-folder')
  else if (what === 'rename' && e) startRename(e)
  else if (what === 'trash' && e) trashIt(e)
}

// --- New, rename, delete ---------------------------------------------------------
// One small field at a time: { mode: 'new' | 'rename', dir, folder, entry, value, error }
const edit = ref(null)
const editEl = ref(null)
// The field may be inside the list (a ref there would be an array).
const setEditEl = (el) => {
  if (el) editEl.value = el
}
// A folder inside a closed compact row stands on its own row while edited:
// the folders before it in that row open, so it shows.
function openBefore(path) {
  const row = rowOf(path)
  if (row && row.chain.length > 1) for (const c of row.chain.slice(0, segmentOf(row, path))) open[c.path] = true
}
async function startNew(dir, folder) {
  openBefore(dir)
  if (dir !== displayRoot.value && !open[dir]) {
    open[dir] = true
    await loadDir(dir)
  }
  edit.value = { mode: 'new', dir, folder, value: '', error: '' }
  nextTick(() => editEl.value && editEl.value.focus())
}
async function startRename(e) {
  // From the search results: shown in the tree first.
  if (searching.value) await revealInTree(e.path.replace(/[\\/][^\\/]*$/, ''))
  openBefore(e.path)
  edit.value = { mode: 'rename', entry: e, value: e.name, error: '' }
  nextTick(() => {
    const el = editEl.value
    if (!el) return
    el.focus()
    const dot = e.dir ? -1 : e.name.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : e.name.length)
  })
}
async function commitEdit() {
  const ed = edit.value
  if (!ed) return
  const name = ed.value.trim()
  if (!name || (ed.mode === 'rename' && name === ed.entry.name)) {
    edit.value = null
    return
  }
  const res =
    ed.mode === 'new'
      ? await api().create({ root: props.root, dir: ed.dir, name, folder: ed.folder }).catch((err) => ({ ok: false, error: err.message }))
      : await api().rename({ root: props.root, path: ed.entry.path, name }).catch((err) => ({ ok: false, error: err.message }))
  if (!res || !res.ok) {
    ed.error = (res && res.error) || t('explorer.editFailed', 'It could not be done.')
    return
  }
  edit.value = null
  await refresh()
  selected.value = res.path
  if (ed.mode === 'new' && !ed.folder) emit('open', res.path)
}
const confirmTrash = ref(null) // the entry waiting for a confirmation
// The question around the name (shown in bold): [before, after].
function trashQuestion() {
  const parts = (
    remote.value
      ? t('explorer.trash.confirmRemote', 'Move {{name}} to the trash on the remote host?')
      : t('explorer.trash.confirm', 'Move {{name}} to the Recycle Bin?')
  ).split('{{name}}')
  return [parts[0] || '', parts.slice(1).join('')]
}
const trashLabel = computed(() =>
  remote.value ? t('explorer.trash.actionRemote', 'Move to the host’s trash') : t('explorer.trash.action', 'Move to Recycle Bin')
)
function trashIt(e) {
  confirmTrash.value = e
}
async function doTrash() {
  const e = confirmTrash.value
  confirmTrash.value = null
  if (!e) return
  const res = await api().trash({ root: props.root, path: e.path }).catch((err) => ({ ok: false, error: err.message }))
  const why = (res && res.error) || t('explorer.unknownError', 'unknown error')
  if (res && res.ok)
    emit(
      'toast',
      remote.value
        ? t('explorer.trash.doneRemote', '"{{name}}" is in the remote host’s trash.', { name: e.name })
        : t('explorer.trash.done', '"{{name}}" is in the Recycle Bin.', { name: e.name })
    )
  else
    emit(
      'toast',
      remote.value
        ? t('explorer.trash.failedRemote', '"{{name}}" could not be moved to the remote host’s trash: {{error}}', { name: e.name, error: why })
        : t('explorer.trash.failed', '"{{name}}" could not be moved to the Recycle Bin: {{error}}', { name: e.name, error: why })
    )
  refresh()
}

// --- The project shown -------------------------------------------------------------
let stopChanged = null
let changedTimer = 0
async function showRoot() {
  const revision = ++viewRevision, root = props.root
  directoryRequests.clear()
  for (const k of Object.keys(nodes)) delete nodes[k]
  for (const k of Object.keys(open)) delete open[k]
  status.value = {}
  edit.value = null
  sparseDirs.value = []
  scope.value = WHOLE
  if (!props.root || !api()) return
  api().watch(props.root)
  await Promise.all([loadDir(props.root), loadSparse()])
  if (!stillCurrent(revision, root)) return
  loadStatus()
  runSearch()
}
watch(() => props.root, showRoot)
// Another folder shown: read when new; a name search follows it.
watch(displayRoot, (dir) => {
  if (dir && !nodes[dir]) loadDir(dir)
  if (mode.value === 'names' && query.value.trim()) runSearch()
})
watch(dotfiles, refresh)
onMounted(() => {
  showRoot()
  if (api() && api().onChanged)
    stopChanged = api().onChanged((r) => {
      if (!props.root || key(r) !== key(props.root)) return
      clearTimeout(changedTimer)
      changedTimer = setTimeout(refresh, 200)
    })
})
onBeforeUnmount(() => {
  disposed = true
  if (stopChanged) stopChanged()
  clearTimeout(changedTimer)
  clearTimeout(searchTimer)
  if (api()) api().unwatch()
})
function letterTitle(letter) {
  if (letter === 'M') return t('explorer.git.modified', 'Modified')
  if (letter === 'A') return t('explorer.git.added', 'Added')
  if (letter === 'D') return t('explorer.git.deleted', 'Deleted')
  if (letter === 'R') return t('explorer.git.renamed', 'Renamed')
  if (letter === 'C') return t('explorer.git.copied', 'Copied')
  if (letter === 'U') return t('explorer.git.untracked', 'New, not in git yet')
  return letter
}
function rowTitle(e) {
  const letter = letterOf(e)
  if (!letter) return relPath(e.path)
  return t('explorer.rowTitle', '{{path}} ({{status}})', { path: relPath(e.path), status: letterTitle(letter) })
}
</script>

<template>
  <div class="explorer" :aria-label="t('explorer.side.files', 'Files')" @keydown.escape="closeMenu">
    <div class="explorer-head">
      <span class="explorer-title" :title="root || ''">{{ rootName || t('explorer.side.files', 'Files') }}</span>
      <span class="explorer-actions">
        <button
          class="tb-icon"
          :title="t('explorer.collapseAllFolders', 'Collapse all folders')"
          :aria-label="t('explorer.collapseAll', 'Collapse all')"
          data-test="explorer-collapse" :disabled="!root" @click="collapseAll">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <button
          class="tb-icon"
          :title="t('explorer.refresh', 'Refresh')"
          :aria-label="t('explorer.refresh', 'Refresh')"
          data-test="explorer-refresh" :disabled="!root" @click="refresh">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <span class="explorer-more-wrap">
          <button
            class="tb-icon"
            :class="{ on: moreOpen }"
            :title="t('explorer.more', 'More')"
            :aria-label="t('explorer.more', 'More')"
            aria-haspopup="menu"
            :aria-expanded="moreOpen"
            data-test="explorer-more"
            :disabled="!root"
            @click="moreOpen = !moreOpen"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg>
          </button>
          <div v-if="moreOpen" class="explorer-menu-back" @mousedown.self="moreOpen = false"></div>
          <div v-if="moreOpen" class="ctx-menu explorer-more-menu" role="menu" @keydown.escape.stop="moreOpen = false">
            <button role="menuitem" class="ctx-menu-item" data-test="explorer-new-file" @click="moreAct('new-file')">
              {{ t('explorer.newFile', 'New file') }}
            </button>
            <button role="menuitem" class="ctx-menu-item" data-test="explorer-new-folder" @click="moreAct('new-folder')">
              {{ t('explorer.newFolder', 'New folder') }}
            </button>
            <div class="ctx-menu-sep"></div>
            <button role="menuitemcheckbox" class="ctx-menu-item" :aria-checked="dotfiles" data-test="explorer-dotfiles" @click="moreAct('dotfiles')">
              <span class="explorer-check">{{ dotfiles ? '✓' : '' }}</span>{{ t('explorer.showDotfiles', 'Show dotfiles') }}
            </button>
            <button
              role="menuitemcheckbox"
              class="ctx-menu-item"
              :aria-checked="settings.explorerCompactFolders !== false"
              data-test="explorer-compact"
              @click="moreAct('compact')"
            >
              <span class="explorer-check">{{ settings.explorerCompactFolders !== false ? '✓' : '' }}</span>{{ t('explorer.compactFolders', 'Compact folders') }}
            </button>
          </div>
        </span>
      </span>
    </div>
    <div v-if="root" class="explorer-tools">
      <div class="explorer-search">
        <svg class="explorer-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" /><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
        <input
          v-model="query"
          class="explorer-filter"
          :placeholder="mode === 'content' ? t('explorer.search.inFiles', 'Search in files') : t('explorer.search.files', 'Search files')"
          :aria-label="t('explorer.search.files', 'Search files')"
          data-test="explorer-search"
          spellcheck="false"
          @keydown.escape.stop="clearSearch"
        />
        <button
          v-if="query"
          class="explorer-search-clear"
          :title="t('explorer.search.clear', 'Clear')"
          :aria-label="t('explorer.search.clearAria', 'Clear the search')"
          @click="clearSearch"
        >
          ×
        </button>
      </div>
      <div class="explorer-seg" role="radiogroup" :aria-label="t('explorer.search.by', 'Search by')">
        <button role="radio" :aria-checked="mode === 'names'" :class="{ on: mode === 'names' }" data-test="explorer-mode-names" @click="setMode('names')">
          {{ t('explorer.search.names', 'Names') }}
        </button>
        <button role="radio" :aria-checked="mode === 'content'" :class="{ on: mode === 'content' }" data-test="explorer-mode-content" @click="setMode('content')">
          {{ t('explorer.search.content', 'Content') }}
        </button>
      </div>
    </div>

    <div v-if="root && sparseDirs.length" class="explorer-scope" data-test="explorer-scope" :title="scopeHelp">
      <span class="explorer-scope-label">{{ t('explorer.sparse.label', 'Sparse checkout') }}</span>
      <ThemedSelect
        class="explorer-scope-select"
        :model-value="scope"
        :aria-label="t('explorer.sparse.choose', 'Folder shown in the tree')"
        data-test="explorer-scope-select"
        @update:model-value="chooseScope"
      >
        <option value="">{{ t('explorer.sparse.whole', 'Whole project') }}</option>
        <option v-for="d in sparseDirs" :key="d.rel" :value="d.rel">{{ d.rel }}</option>
      </ThemedSelect>
    </div>

    <div v-if="!root" class="explorer-empty">
      {{
        t(
          'explorer.noProject',
          'This workspace has no project folder. Choose one from the workspace menu (Project folder…) to see its files here.'
        )
      }}
    </div>
    <div v-else-if="searching" class="explorer-tree explorer-results" data-test="explorer-results" :data-mode="mode">
      <div v-if="search.error" class="explorer-empty">{{ search.error }}</div>
      <div
        v-else-if="search.done && !search.busy && !search.results.length"
        class="explorer-empty"
        v-text="
          mode === 'content'
            ? t('explorer.search.noText', 'No text matches “{{query}}”.', { query: query.trim() })
            : t('explorer.search.noFile', 'No file matches “{{query}}”.', { query: query.trim() })
        "
      ></div>
      <template v-if="mode === 'names'">
        <div
          v-for="h in shownResults"
          :key="h.path"
          class="explorer-row explorer-hit"
          :class="{ selected: selected === h.path, dir: h.dir, ignored: ignoredOf(h.path), ['git-' + (letterOf(h) || 'none')]: true }"
          :title="h.rel"
          draggable="true"
          :data-path="h.path"
          @click="onHitClick(h)"
          @contextmenu="onContext($event, h)"
          @dragstart="onDragStart($event, h)"
        >
          <svg v-if="h.dir" class="explorer-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.8 4h4.4l1.4 1.5h6.6v7.7H1.8z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /></svg>
          <svg v-else class="explorer-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.8h5l3 3v9.4H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /></svg>
          <span class="explorer-name">{{ h.name }}</span>
          <span class="explorer-hit-dir">{{ dirOf(h.rel) }}</span>
          <span v-if="ignoredOf(h.path)" class="explorer-ignored" :title="t('explorer.ignored', 'Ignored by .gitignore')">⊘</span>
          <span v-else-if="letterOf(h)" class="explorer-git">{{ h.dir ? '•' : letterOf(h) }}</span>
        </div>
      </template>
      <template v-else>
        <div
          v-for="h in shownResults"
          :key="h.path + ':' + h.line"
          class="explorer-row explorer-line-hit"
          :class="{ selected: selected === h.path + ':' + h.line }"
          :title="h.rel + ':' + h.line"
          :data-path="h.path"
          :data-line="h.line"
          @click="onHitClick(h)"
        >
          <span class="explorer-hit-loc">{{ h.rel }}:{{ h.line }}</span>
          <span class="explorer-hit-text">{{ h.text }}</span>
        </div>
      </template>
      <div
        v-if="search.truncated"
        class="explorer-empty"
        v-text="
          t('explorer.search.truncated', 'Only the first {{count}} results are shown. Type more to narrow the search.', {
            count: search.results.length
          })
        "
      ></div>
      <div v-if="search.busy && !search.results.length" class="explorer-empty">{{ t('explorer.search.searching', 'Searching…') }}</div>
    </div>
    <div
      v-else
      ref="treeEl"
      class="explorer-tree explorer-files"
      role="tree"
      tabindex="0"
      :aria-label="t('explorer.side.files', 'Files')"
      @keydown="onTreeKey"
      @contextmenu.self="onContext($event, null)"
    >
      <div v-if="edit && edit.mode === 'new' && edit.dir === displayRoot" class="explorer-edit" :style="{ paddingLeft: rowPadding(0) + 22 + 'px' }">
        <input
          :ref="setEditEl"
          v-model="edit.value"
          class="explorer-edit-input"
          :placeholder="edit.folder ? t('explorer.folderName', 'Folder name') : t('explorer.fileName', 'File name')"
          @keydown.enter.prevent="commitEdit"
          @keydown.escape.prevent="edit = null"
          @blur="commitEdit"
        />
        <div v-if="edit.error" class="explorer-edit-error">{{ edit.error }}</div>
      </div>
      <template v-for="(row, i) in rows" :key="row.path">
        <div
          v-if="!(edit && edit.mode === 'rename' && edit.entry.path === row.path)"
          class="explorer-row"
          :class="{
            selected: segSelected(row, i) >= 0,
            dir: row.dir,
            open: row.open,
            compact: row.chain.length > 1,
            ignored: ignoredOf(row.path),
            ['git-' + (letterOf(row.entry) || 'none')]: true
          }"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-expanded="row.dir ? row.open : undefined"
          :aria-selected="segSelected(row, i) >= 0"
          :style="{ paddingLeft: rowPadding(row.depth) + 'px' }"
          :title="rowTitle(row.entry)"
          draggable="true"
          :data-path="row.path"
          @mousedown="onRowMouseDown($event, row)"
          @click="onRowClick($event, row)"
          @dblclick="!row.dir && emit('open', row.path, { keep: true })"
          @contextmenu="onRowContext($event, row)"
          @dragstart="onRowDragStart($event, row)"
        >
          <span v-if="row.depth" class="explorer-guides" aria-hidden="true" :style="{ left: guideX(0) + 'px', width: row.depth * INDENT + 'px' }"></span>
          <span v-if="inGuide(i)" class="explorer-guide-active" aria-hidden="true" :style="{ left: guideX(guide.depth) + 'px' }"></span>
          <span class="explorer-twistie" aria-hidden="true"><svg v-if="row.dir" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z" /></svg></span>
          <svg v-if="row.dir" class="explorer-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.8 4h4.4l1.4 1.5h6.6v7.7H1.8z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /></svg>
          <svg v-else class="explorer-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.8h5l3 3v9.4H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /></svg>
          <span v-if="row.chain.length > 1" class="explorer-name">
            <template v-for="(c, s) in row.chain" :key="c.path">
              <span v-if="s" class="explorer-crumb-sep">/</span>
              <span class="explorer-crumb" :class="{ active: segSelected(row, i) === s }" :data-seg="s" :data-path="c.path" :title="rowTitle(c)">{{ c.name }}</span>
            </template>
          </span>
          <span v-else class="explorer-name">{{ row.name }}</span>
          <span v-if="ignoredOf(row.path)" class="explorer-ignored" :title="t('explorer.ignored', 'Ignored by .gitignore')">⊘</span>
          <span v-else-if="letterOf(row.entry)" class="explorer-git">{{ row.dir ? '•' : letterOf(row.entry) }}</span>
        </div>
        <div v-else class="explorer-edit" :style="{ paddingLeft: rowPadding(row.depth) + 22 + 'px' }">
          <input :ref="setEditEl" v-model="edit.value" class="explorer-edit-input" @keydown.enter.prevent="commitEdit" @keydown.escape.prevent="edit = null" @blur="commitEdit" />
          <div v-if="edit.error" class="explorer-edit-error">{{ edit.error }}</div>
        </div>
        <div
          v-if="row.open && edit && edit.mode === 'new' && edit.dir === row.path"
          class="explorer-edit"
          :style="{ paddingLeft: rowPadding(row.depth + 1) + 22 + 'px' }"
        >
          <input
            :ref="setEditEl"
            v-model="edit.value"
            class="explorer-edit-input"
            :placeholder="edit.folder ? t('explorer.folderName', 'Folder name') : t('explorer.fileName', 'File name')"
            @keydown.enter.prevent="commitEdit"
            @keydown.escape.prevent="edit = null"
            @blur="commitEdit"
          />
          <div v-if="edit.error" class="explorer-edit-error">{{ edit.error }}</div>
        </div>
      </template>
      <div v-if="nodes[displayRoot] && nodes[displayRoot].error" class="explorer-empty">{{ nodes[displayRoot].error }}</div>
    </div>

    <div v-if="menu.open" class="explorer-menu-back" @mousedown.self="closeMenu" @contextmenu.prevent="closeMenu">
      <div ref="menuEl" class="ctx-menu explorer-menu" role="menu" tabindex="-1" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <template v-if="menu.entry && !menu.entry.dir">
          <button role="menuitem" class="ctx-menu-item" @click="act('open')">{{ t('explorer.menu.open', 'Open') }}</button>
          <button role="menuitem" class="ctx-menu-item" @click="act('editor')">{{ t('explorer.menu.openInEditor', 'Open in editor') }}</button>
          <button v-if="!remote" role="menuitem" class="ctx-menu-item" @click="act('external')">{{ t('explorer.menu.openInVsCode', 'Open in VS Code') }}</button>
        </template>
        <button role="menuitem" class="ctx-menu-item" @click="act('terminal')">{{ t('explorer.menu.terminalHere', 'Open a terminal here') }}</button>
        <button v-if="menu.entry && canInsert" role="menuitem" @click="act('insert')">
          {{ t('explorer.menu.insertPath', 'Insert path in the active pane') }}
        </button>
        <div class="ctx-menu-sep"></div>
        <button role="menuitem" class="ctx-menu-item" @click="act('new-file')">{{ t('explorer.newFile', 'New file') }}</button>
        <button role="menuitem" class="ctx-menu-item" @click="act('new-folder')">{{ t('explorer.newFolder', 'New folder') }}</button>
        <template v-if="menu.entry">
          <button role="menuitem" class="ctx-menu-item" @click="act('rename')">{{ t('explorer.menu.rename', 'Rename') }}</button>
          <button role="menuitem" class="ctx-menu-item danger" @click="act('trash')">{{ trashLabel }}</button>
        </template>
        <div class="ctx-menu-sep"></div>
        <template v-if="menu.entry">
          <button role="menuitem" class="ctx-menu-item" @click="act('copy')">{{ t('explorer.menu.copyPath', 'Copy path') }}</button>
          <button role="menuitem" class="ctx-menu-item" @click="act('copy-rel')">{{ t('explorer.menu.copyRelPath', 'Copy relative path') }}</button>
        </template>
        <button v-if="!remote" role="menuitem" class="ctx-menu-item" @click="act('reveal')">{{ t('explorer.menu.reveal', 'Reveal in File Explorer') }}</button>
      </div>
    </div>

    <div v-if="confirmTrash" class="explorer-confirm" role="alertdialog" :aria-label="trashLabel">
      <div>{{ trashQuestion()[0] }}<strong>{{ confirmTrash.name }}</strong>{{ trashQuestion()[1] }}</div>
      <div class="explorer-confirm-actions">
        <button class="exit-btn" @click="confirmTrash = null">{{ t('explorer.trash.cancel', 'Cancel') }}</button>
        <button class="exit-btn danger" @click="doTrash">{{ trashLabel }}</button>
      </div>
    </div>
  </div>
</template>
