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
import PanelState from './ui/PanelState.vue'
import { statusOf, untrackedFolder, folderStatus, ignoredSet, isIgnored } from '../explorerStatus'
import { buildRows, toggledPaths, soleSubfolder, activeGuide, segmentOf, rowPadding, guideX, stickyFolders, INDENT, ROW_HEIGHT } from '../explorerRows'
import { statusMatters, foldersToReload, sameEntries, sameStatus, rememberIgnored, inGitDir, parentOf } from '../explorerChanges'
import { saveTree, loadTree, forgetTree } from '../explorerTreeCache'
import { settings } from '../settings'
import { isRemotePath, remoteHostPath } from '../../../shared/remotePath'
import { isVirtualPath, isLsharePath, parseLsharePath } from '../../../shared/liveSharePath'
import { accessOf, stateOfAnswer, accessStateText, accessStateKind, localOnlyText } from '../liveShareGuestAccess'
import { t } from '../i18n'
import FileIcon from './FileIcon.vue'
import Codicon from './Codicon.vue'
import ExplorerOutline from './ExplorerOutline.vue'
import ExplorerTimeline from './ExplorerTimeline.vue'

const props = defineProps({
  root: { type: String, default: null },
  // A pane to type paths into (the active one), for "Insert path".
  canInsert: { type: Boolean, default: false },
  // VS Code's "Open Editors" (explorer/openEditors.js): the workspace's open
  // files and pages.
  openEditors: { type: Array, default: () => [] },
  // The SSH host of a remote project, shown in the folder's header.
  remoteLabel: { type: String, default: '' },
  // The folder's header instead of its last name (a Live Share project:
  // the host's name for it; its path only holds its id).
  rootTitle: { type: String, default: '' },
  // Nothing can be created, renamed or moved to the Recycle Bin (a Live
  // Share host's project without "Edit files" is read-only by itself).
  readOnly: { type: Boolean, default: false }
})
const emit = defineEmits(['open', 'open-editor', 'open-external', 'terminal-here', 'insert-path', 'toast', 'close', 'activate-editor', 'close-editor', 'save-all', 'close-all', 'open-diff'])

// --- VS Code's sections: Open Editors, then the project's folder ---------------------
// Each folds by its header (kept in Settings); Open Editors shows 9 rows at
// most (VS Code's explorer.openEditors.visible), then scrolls.
const OPEN_EDITORS_MAX = 9
const fileIconsOn = computed(() => settings.fileIcons !== 'off')
const openEditorsShown = computed(() => settings.explorerOpenEditorsShown !== false)
const folderShown = computed(() => settings.explorerFolderShown !== false)
function toggleOpenEditors() {
  settings.explorerOpenEditorsShown = !openEditorsShown.value
}
function toggleFolder() {
  settings.explorerFolderShown = !folderShown.value
}
// New file / folder from the folder's header: the folder unfolds first.
function newFromHead(folder) {
  settings.explorerFolderShown = true
  startNew(displayRoot.value, folder)
}
const unsavedCount = computed(() => new Set(props.openEditors.filter((e) => e.dirty).map((e) => key(e.path))).size)
const unsavedLabel = computed(() => t('explorer.unsaved', '{{count}} unsaved', { count: unsavedCount.value }))
// An open file's git letter, when it is in this project.
const editorLetter = (ed) => (ed.kind === 'file' && ed.path ? statusOf(status.value, key(ed.path), key(props.root)) : '')
const folderTitle = computed(() => {
  const name = props.rootTitle || rootName.value || t('explorer.side.files', 'Files')
  return props.remoteLabel ? t('explorer.remoteTitle', '{{name}} [SSH: {{host}}]', { name, host: props.remoteLabel }) : name
})

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
let viewRevision = 0
let disposed = false
let statusRequest = 0
const directoryRequests = new Map()
const stillCurrent = (revision, root) => !disposed && revision === viewRevision && root === props.root

const api = () => window.shellApi.explorer
const key = (p) => String(p || '').toLowerCase()
const rootName = computed(() => (props.root ? props.root.split(/[\\/]/).filter(Boolean).pop() : ''))
// A project on a remote host (its root is an ssh://… path): the same tree,
// read over ssh; paths shown, copied or typed are the host's (POSIX). A Live
// Share host's project (lshare://…) is read through the session the same way;
// its paths are only ever relative to the project (the host's folder is
// never sent).
const remote = computed(() => isVirtualPath(props.root))
const lshare = computed(() => isLsharePath(props.root))
const hostPath = (p) => {
  if (isRemotePath(p)) return remoteHostPath(p) || p
  if (isLsharePath(p)) return parseLsharePath(p)?.rel || ''
  return p
}

// --- A Live Share host's project: what the host lets this guest do ----------------
// Read-only unless the host gave "Edit files" for this project and its last
// answer did not say read-only; the access taken away, or a host's Tessel
// too old to share files, shows that instead of the tree. Both follow the
// host live (liveShareAccess.js).
const access = computed(() => accessOf(props.root))
// The host's last word for the project shown: { root, readOnly, state }.
const answered = ref({ root: null, readOnly: false, state: null })
const answeredNow = computed(() => (answered.value.root === props.root ? answered.value : { readOnly: false, state: null }))
const accessState = computed(() => {
  if (!lshare.value) return null
  if (access.value && access.value.state !== 'ok') return access.value.state
  return answeredNow.value.state
})
const accessText = computed(() => accessStateText(accessState.value))
const readOnly = computed(
  () => props.readOnly || (lshare.value && (answeredNow.value.readOnly || !access.value || !access.value.edit || !!accessState.value))
)
// A host's answer: whether it says read-only, or why it refused.
function noteAnswer(res) {
  if (!lshare.value || !res) return
  const next = { ...answeredNow.value, root: props.root }
  if (typeof res.readOnly === 'boolean') next.readOnly = res.readOnly
  const state = stateOfAnswer(res)
  if (state) next.state = state
  else if (res.ok) next.state = null
  answered.value = next
}
// Access taken away: nothing of the host's project stays on screen, and
// what was being named or moved to the Recycle Bin is dropped; given back:
// read again.
let shownRoot = null
watch(accessState, (state, before) => {
  if (state) {
    // Answers still on their way are dropped, and nothing of it is kept.
    viewRevision++
    directoryRequests.clear()
    if (props.root) forgetTree(props.root)
    for (const k of Object.keys(nodes)) delete nodes[k]
    status.value = {}
    Object.assign(search, { busy: false, results: [], truncated: false, error: '', done: false })
  } else if (before && shownRoot === props.root) showRoot()
})
watch(readOnly, (ro) => {
  if (!ro) return
  edit.value = null
  confirmTrash.value = null
})
// Edit files given back: the host is asked again (its answer may still say
// read-only).
watch(
  () => !!(access.value && access.value.edit),
  (on) => {
    if (on && lshare.value && props.root) loadDir(props.root, { background: true })
  }
)
function refuseReadOnly() {
  emit('toast', t('explorer.readOnly', 'Read-only: the host has not let you edit files here.'))
}

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

// background: a refresh of what is shown (a remote host serves the user's
// own clicks first).
// A folder's answer applied (the same entries keep their array: nothing is
// drawn again). A remote host that did not answer (transient): what was
// shown stays, with the error.
function applyListing(dir, res, cur) {
  const before = cur || nodes[dir] || { entries: [] }
  if (res && res.ok) {
    const now = nodes[dir]
    nodes[dir] = { entries: now && sameEntries(now.entries, res.entries) ? now.entries : res.entries, loading: false, error: '' }
    rememberSoon()
    return
  }
  const error = (res && res.error) || t('explorer.readFailed', 'Could not read it.')
  // A host that did not answer: what was shown (read before, or kept from
  // the last time) stays, with the error.
  nodes[dir] = { entries: res && res.transient ? before.entries : [], loading: false, error, ...(res && res.transient && before.stale ? { stale: true } : {}) }
}
// Open folders read again in the background: a small spinner on their row.
const refreshing = reactive({})
function markLoading(dir, request, background) {
  directoryRequests.set(dir, request)
  const cur = nodes[dir] || { entries: [], loading: false, error: '' }
  // A refresh in the background keeps the rows as they are until it answers.
  if (!background || !nodes[dir]) nodes[dir] = { ...cur, loading: true }
  else refreshing[dir] = true
  return cur
}
function doneLoading(dir, request) {
  if (directoryRequests.get(dir) === request) {
    directoryRequests.delete(dir)
    delete refreshing[dir]
  }
}
async function loadDir(dir, { background = false } = {}) {
  if (!api() || !props.root) return
  const revision = viewRevision, root = props.root
  const request = Symbol()
  const cur = markLoading(dir, request, background)
  if (background) backgroundLoads.value++
  const res = await api()
    .list({ root, dir, dotfiles: dotfiles.value, ...(background ? { background: true } : {}) })
    .catch(() => null)
    .finally(() => {
      if (background) backgroundLoads.value = Math.max(0, backgroundLoads.value - 1)
    })
  if (!stillCurrent(revision, root) || directoryRequests.get(dir) !== request) return
  noteAnswer(res)
  applyListing(dir, res, cur)
  doneLoading(dir, request)
}
const BACKGROUND_CHUNK = 8
// Several folders in one request (one round trip to a remote host), with
// each one's chain of sole sub-folders when chain (a compact row opens at
// once). Without listMany, one request per folder.
async function loadDirs(dirs, { background = false, chain = false } = {}) {
  dirs = [...new Set(dirs.filter(Boolean))]
  if (!api() || !props.root || !dirs.length) return
  const many = api().listMany
  if (!many || (dirs.length === 1 && !chain)) {
    await Promise.all(dirs.map((d) => loadDir(d, { background })))
    return
  }
  // A refresh of many folders goes in a few requests, one after the other:
  // a click waits for one of them at most, never for all.
  if (background && dirs.length > BACKGROUND_CHUNK) {
    for (let i = 0; i < dirs.length; i += BACKGROUND_CHUNK) {
      if (disposed) return
      await loadDirs(dirs.slice(i, i + BACKGROUND_CHUNK), { background, chain })
    }
    return
  }
  const revision = viewRevision, root = props.root
  const request = Symbol()
  const before = {}
  for (const d of dirs) before[d] = markLoading(d, request, background)
  if (background) backgroundLoads.value++
  const res = await many({ root, dirs, dotfiles: dotfiles.value, ...(chain ? { chain: true } : {}), ...(background ? { background: true } : {}) })
    .catch(() => null)
    .finally(() => {
      if (background) backgroundLoads.value = Math.max(0, backgroundLoads.value - 1)
    })
  if (!stillCurrent(revision, root)) return
  noteAnswer(res)
  const got = new Set()
  for (const r of res && res.ok && Array.isArray(res.results) ? res.results : []) {
    if (!r || typeof r.dir !== 'string') continue
    got.add(r.dir)
    if (r.dir in before) {
      if (directoryRequests.get(r.dir) === request) {
        applyListing(r.dir, r, before[r.dir])
        doneLoading(r.dir, request)
      }
    } else if (r.ok && !directoryRequests.has(r.dir)) applyListing(r.dir, r, null) // a sub-folder of a chain
  }
  const missing = dirs.filter((d) => !got.has(d) && directoryRequests.get(d) === request)
  // The whole request failed: said on each folder. A folder its answer did
  // not reach (cut at its size): asked on its own.
  if (res && res.ok) await Promise.all(missing.map((d) => loadDir(d, { background })))
  else
    for (const d of missing) {
      applyListing(d, res, before[d])
      doneLoading(d, request)
    }
}
// The user's own folder loads made in the same moment (folders clicked
// quickly) go as one request.
let loadBatch = null
function loadSoon(dir, { chain = false } = {}) {
  if (!api() || !api().listMany) return loadDir(dir)
  if (!loadBatch) {
    const batch = { dirs: new Set(), chain: false, revision: viewRevision }
    batch.done = new Promise((resolve) =>
      setTimeout(() => {
        if (loadBatch === batch) loadBatch = null
        if (batch.revision !== viewRevision) return resolve()
        loadDirs([...batch.dirs], { chain: batch.chain }).then(resolve, resolve)
      }, 0)
    )
    loadBatch = batch
  }
  loadBatch.dirs.add(dir)
  if (chain) loadBatch.chain = true
  return loadBatch.done
}
// The git letters: always in the background (they decorate a tree already
// shown; the listing never waits for them). Slow or failed: the tree and the
// last letters known stay as they are.
async function loadStatus() {
  if (!api() || !props.root) return
  const revision = viewRevision, root = props.root, request = ++statusRequest
  const res = await api().status({ root, ignored: true, background: true }).catch(() => null)
  // (An answer for a project no longer shown says nothing of this one.)
  if (!stillCurrent(revision, root)) return
  if (res && Number.isFinite(res.ms)) statusCost = res.ms
  // One that failed (ran out of time on a huge repository): the next waits
  // twice as long each time, not a new one every minute.
  statusFails = res && res.ok ? 0 : Math.min(statusFails + 1, 6)
  if (request !== statusRequest) return
  if (res && !res.ok && stateOfAnswer(res) === 'no-access') noteAnswer(res)
  if (!res || !res.ok) return
  const out = {}
  for (const [p, l] of Object.entries(res.files || {})) out[key(p)] = l
  // The same letters: nothing to draw again.
  if (!sameStatus(status.value, out)) {
    status.value = out
    repoChanges.value++
    rememberSoon()
  }
  repo.value = !!res.repo
}
// The Timeline reads a file's history again when the repository changes (a
// commit, a pull…): one more at each such change seen.
const repoChanges = ref(0)
// A file's git letter (the Timeline's "Uncommitted Changes" hover).
const fileLetter = (p) => statusOf(status.value, key(p), key(props.root))
// Git status after changes: at most every second (every 4 s on a remote
// host, where it shares the connection with the user's clicks), one run at
// a time, the last change always seen (VS Code's git extension debounces
// and throttles it the same way).
let statusTimer = 0
let statusBusy = false
let statusAgain = false
let statusLast = 0
// On a remote host, a status that takes long (a big project) is asked less
// often: at most a quarter of the time on it (3x its own time between runs).
let statusCost = 0
let statusFails = 0
const statusGap = () => {
  const base = remote.value ? Math.max(4000, Math.min(60000, statusCost * 3)) : 1000
  return statusFails ? Math.min(10 * 60000, Math.max(base, remote.value ? 60000 : 5000) * 2 ** (statusFails - 1)) : base
}
function requestStatus() {
  if (statusBusy) {
    statusAgain = true
    return
  }
  if (statusTimer) return
  statusTimer = setTimeout(runStatus, Math.max(0, statusLast + statusGap() - Date.now()))
}
async function runStatus() {
  statusTimer = 0
  statusBusy = true
  try {
    await loadStatus()
  } finally {
    statusBusy = false
    statusLast = Date.now()
    if (statusAgain && !disposed) {
      statusAgain = false
      requestStatus()
    }
  }
}
function resetStatusRuns() {
  clearTimeout(statusTimer)
  statusTimer = 0
  statusAgain = false
}
// The open folders (shown or not) and the project's own.
const openDirs = () => [props.root, displayRoot.value, ...Object.keys(open).filter((d) => open[d])]
// Everything shown again: the open folders (one request) and the git status.
async function refresh() {
  if (!props.root) return
  const revision = viewRevision, root = props.root
  prefetched.clear()
  await Promise.all([loadDirs(openDirs(), { background: true }), loadSparse()])
  if (!stillCurrent(revision, root)) return
  loadStatus()
  if (query.value.trim()) runSearch()
}
// A change notice: the folders it touches read again, git status when it
// can see the change; everything when the paths are not known.
let pendingChange = { all: false, paths: new Set(), renamed: new Set(), renamedKnown: true }
function noteChange(info) {
  const paths = info && Array.isArray(info.paths) ? info.paths : null
  if (!paths) pendingChange.all = true
  else for (const p of paths) if (typeof p === 'string') pendingChange.paths.add(p)
  if (info && Array.isArray(info.renamed)) for (const p of info.renamed) if (typeof p === 'string') pendingChange.renamed.add(p)
  if (!info || !Array.isArray(info.renamed)) pendingChange.renamedKnown = false
  clearTimeout(changedTimer)
  changedTimer = setTimeout(applyChanges, 200)
}
async function applyChanges() {
  const change = pendingChange
  pendingChange = { all: false, paths: new Set(), renamed: new Set(), renamedKnown: true }
  if (!props.root || disposed) return
  const revision = viewRevision, root = props.root
  if (change.all) {
    prefetched.clear()
    await Promise.all([loadDirs(openDirs(), { background: true }), loadSparse()])
    if (!stillCurrent(revision, root)) return
    requestStatus()
    if (query.value.trim()) runSearch()
    return
  }
  const paths = [...change.paths]
  for (const p of paths) {
    prefetched.delete(key(p))
    prefetched.delete(key(parentOf(p)))
  }
  const matters = statusMatters(props.root, paths, ignored.value)
  if (matters) requestStatus()
  if (matters && paths.some(inGitDir)) repoChanges.value++
  // A sparse checkout's list lives in git's own folder.
  if (paths.some((p) => /[\\/]\.git[\\/](info[\\/]sparse-checkout|config(\.worktree)?)$/i.test(p))) loadSparse()
  const dirs = foldersToReload(nodes, paths, { remote: remote.value, renamed: change.renamedKnown ? [...change.renamed] : null })
  if (dirs.length) await loadDirs(dirs, { background: true })
  if (!stillCurrent(revision, root)) return
  if (matters && query.value.trim() && paths.some((p) => !inGitDir(p))) runSearch()
}
// --- Prefetch (a remote project) --------------------------------------------------
// After a folder opens, when the connection is idle, its sub-folders are read
// in one background request (up to 24 of them, 300 entries each), kept
// aside: opening one then shows it at once. Kept aside, they change nothing
// shown (a compact row joins only folders read for it); a change notice
// drops them.
const prefetched = new Map() // folder key -> { dir, entries }
const prefetchWanted = new Set()
let prefetchTimer = 0
const PREFETCH_DIRS = 24
const PREFETCH_ENTRIES = 300
function schedulePrefetch(dir) {
  if (!remote.value || !api() || !api().listMany) return
  prefetchWanted.add(dir)
  clearTimeout(prefetchTimer)
  prefetchTimer = setTimeout(runPrefetch, 700)
}
async function runPrefetch() {
  prefetchTimer = 0
  const revision = viewRevision, root = props.root
  const want = []
  for (const d of prefetchWanted) {
    const n = nodes[d]
    for (const e of n && n.entries ? n.entries : [])
      if (e.dir && !e.link && !nodes[e.path] && !prefetched.has(key(e.path)) && !hiddenEntry(e) && !ignoredOf(e.path)) want.push(e.path)
  }
  prefetchWanted.clear()
  if (!want.length || !root) return
  const shownDots = dotfiles.value
  const res = await api()
    .listMany({ root, dirs: want.slice(0, PREFETCH_DIRS), dotfiles: shownDots, background: true, max: PREFETCH_ENTRIES })
    .catch(() => null)
  if (!stillCurrent(revision, root) || shownDots !== dotfiles.value) return
  for (const r of res && res.ok && Array.isArray(res.results) ? res.results : [])
    if (r && r.ok && !r.truncated && !nodes[r.dir]) prefetched.set(key(r.dir), { dir: r.dir, entries: r.entries })
}
// A folder to show: from the prefetch, or read (with its chain of sole
// sub-folders when compact folders are on).
function ensureDir(dir) {
  if (nodes[dir] && !nodes[dir].error) {
    // Kept from the last time (explorerTreeCache.js): shown now, read again.
    if (nodes[dir].stale) loadDirs([dir], { background: true })
    return Promise.resolve()
  }
  const pre = prefetched.get(key(dir))
  if (pre && pre.dir === dir) {
    prefetched.delete(key(dir))
    nodes[dir] = { entries: pre.entries, loading: false, error: '' }
    return Promise.resolve()
  }
  return loadSoon(dir, { chain: settings.explorerCompactFolders !== false })
}
const folderStatuses = computed(() => folderStatus(status.value, key(props.root)))
const ignored = computed(() => ignoredSet(status.value))
// Known to the side panel too: a change in ignored files only is no change
// for its Changes count either.
watch(ignored, (set) => rememberIgnored(props.root, set))

// Settings > Editor > Files, "Show Git-ignored files" off: hidden.
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
  const k = key(e.path)
  return e.dir ? folderStatuses.value[k] || untrackedFolder(status.value, k, key(props.root)) : statusOf(status.value, k, key(props.root))
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
  if (!q || !props.root || !api() || accessState.value) {
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
  // (A host too old for search alone still shows its tree.)
  if (res && !res.ok && stateOfAnswer(res) === 'no-access') noteAnswer(res)
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
  const missing = []
  for (let i = 0; i < parts.length; i++) {
    dir = dir + '\\' + parts[i]
    open[dir] = true
    if (!nodes[dir]) missing.push(dir)
  }
  // Its folders read together (one round trip to a remote host).
  if (missing.length) await loadDirs(missing)
  query.value = ''
  selected.value = p
  scrollToSelected()
}
// A folder or file named by a link elsewhere (a terminal, a chat:
// links/openTarget.js): shown and selected in the tree, its folders opened.
// -> false when it is not below this project's folder.
function revealPath(p) {
  if (!props.root || typeof p !== 'string') return false
  const r = props.root.replace(/[\\/]+$/, '')
  const virtual = /^(ssh|lshare):\/\//i.test(r)
  // The tree's own paths: the root as given, then "\" between folders.
  const rest = p.slice(r.length)
  const head = p.slice(0, r.length)
  if (!(virtual ? head === r : head.replace(/\//g, '\\').toLowerCase() === r.replace(/\//g, '\\').toLowerCase())) return false
  if (rest && !/^[\\/]/.test(rest)) return false
  const parts = rest.split(/[\\/]+/).filter(Boolean)
  settings.explorerFolderShown = true
  // The project's folder itself: its section, unfolded, is it.
  if (parts.length) revealInTree(r + '\\' + parts.join('\\'))
  return true
}
defineExpose({ revealPath })
function onHitClick(h) {
  selected.value = h.path + (h.line ? ':' + h.line : '')
  if (h.dir) revealInTree(h.path)
  else if (h.line) emit('open', h.path, h.line)
  else emit('open', h.path)
}


// A row opens or closes as one: every folder of a compact row. A folder
// opened with a sole sub-folder opens it too, so the chain shows as one row
// (VS Code's autoExpandCompressedChildren); only with compact folders on.
async function toggleRow(row) {
  if (!row.dir) return
  const paths = toggledPaths(row)
  rememberSoon()
  if (row.open) {
    for (const p of paths) delete open[p]
    return
  }
  for (const p of paths) open[p] = true
  let dir = row.path
  const revision = viewRevision
  for (let guard = 0; guard < 64 && dir; guard++) {
    await ensureDir(dir)
    if (revision !== viewRevision || !open[dir] || settings.explorerCompactFolders === false) break
    const next = soleSubfolder(nodes, dir, hiddenEntry)
    if (!next || open[next.path]) break
    open[next.path] = true
    dir = next.path
  }
  if (revision === viewRevision && open[dir]) schedulePrefetch(dir)
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
// The selected row brought into view: scrolled to by its place first (it
// may not be drawn: only the rows in view are), then exactly.
function scrollToSelected() {
  nextTick(() => {
    const p = selected.value
    const el = treeEl.value
    if (!p || !el) return
    const ri = tree.value.index.get(p)
    if (ri !== undefined && windowed.value.virtual) {
      const at = items.value.findIndex((it) => it.kind === 'row' && it.i === ri)
      if (at >= 0) {
        const top = at * ROW_HEIGHT
        if (top < el.scrollTop) el.scrollTop = top
        else if (top + ROW_HEIGHT > el.scrollTop + viewport.value) el.scrollTop = top + ROW_HEIGHT - viewport.value
        scrollTop.value = el.scrollTop
      }
    }
    nextTick(() => {
      const row = [...el.querySelectorAll('[data-path]')].find((x) => x.dataset.path === p)
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
    })
  })
}

// --- Rows drawn: only those in view (VS Code's listView.ts) -----------------------
// Every row is 22 px, so the rows in view follow from the scroll position;
// the others are one empty space above and one below. Under 150 rows, or
// while a name is edited (its field must stay), all are drawn.
const VIRTUAL_MIN = 150
const OVERSCAN = 12
const scrollTop = ref(0)
const viewport = ref(0)
// The tree's items: its rows, and under an open folder still being read (or
// that could not be), a "Loading…" (or error) line.
const items = computed(() => {
  const out = []
  tree.value.rows.forEach((row, i) => {
    out.push({ kind: 'row', key: row.path, row, i })
    if (!row.open) return
    const n = nodes[row.path]
    if (!n || (n.loading && !n.entries.length && !n.error)) out.push({ kind: 'loading', key: 'loading:' + row.path, depth: row.depth + 1 })
    else if (n.error && !n.loading) out.push({ kind: 'error', key: 'error:' + row.path, depth: row.depth + 1, dir: row.path, error: n.error })
  })
  return out
})
const windowed = computed(() => {
  const list = items.value
  const h = viewport.value
  if (list.length < VIRTUAL_MIN || !h || edit.value) return { list, before: 0, after: 0, virtual: false }
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(list.length, Math.ceil((scrollTop.value + h) / ROW_HEIGHT) + OVERSCAN)
  return { list: list.slice(start, end), before: start * ROW_HEIGHT, after: (list.length - end) * ROW_HEIGHT, virtual: true }
})
// VS Code's sticky scroll: the open folders above the first line stay at the
// top, one line each (explorerRows.js stickyFolders). A click on one brings
// its own line back there; its arrow folds it.
const itemDepths = computed(() => items.value.map((it) => ({ depth: it.kind === 'row' ? it.row.depth : it.depth })))
const sticky = computed(() => {
  if (!scrollTop.value) return []
  const list = items.value
  return stickyFolders(itemDepths.value, scrollTop.value)
    .map((s) => ({ ...s, row: list[s.at] && list[s.at].row }))
    .filter((s) => s.row)
})
function onStickyClick(s, level) {
  selected.value = s.row.path
  const el = treeEl.value
  if (!el) return
  el.scrollTop = Math.max(0, (s.at - level) * ROW_HEIGHT)
  scrollTop.value = el.scrollTop
}
let scrollQueued = false
const nextFrame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16))
function onTreeScroll(ev) {
  const el = ev && ev.target
  if (!el || scrollQueued) return
  scrollQueued = true
  nextFrame(() => {
    scrollQueued = false
    scrollTop.value = el.scrollTop
    rememberSoon()
  })
}
function measure() {
  const el = treeEl.value
  viewport.value = el ? el.clientHeight || 0 : 0
  if (el) scrollTop.value = el.scrollTop || 0
}
let resizeObserver = null
watch(
  treeEl,
  (el) => {
    if (resizeObserver) resizeObserver.disconnect()
    resizeObserver = null
    measure()
    if (el && typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => measure())
      resizeObserver.observe(el)
    }
  },
  { flush: 'post' }
)
// The folder of an error line read again.
function retryDir(dir) {
  if (dir) loadDirs([dir])
}
// The project's own folder could not be read: everything again.
function retryRoot() {
  const dir = displayRoot.value
  if (!dir) return
  loadDir(dir).then(() => {
    if (!repo.value) loadStatus()
  })
}
// --- The tree kept per project (explorerTreeCache.js) ---------------------------
// What is shown, as a snapshot: the folders read (their entries' own
// arrays), the open ones, the selection, the scroll, the git letters.
function snapshotTree() {
  const out = {}
  for (const [d, n] of Object.entries(nodes)) if (n && Array.isArray(n.entries) && (n.entries.length || (!n.loading && !n.error))) out[d] = n.entries
  return {
    nodes: out,
    open: Object.keys(open).filter((d) => open[d]),
    selected: selected.value,
    scrollTop: treeEl.value ? treeEl.value.scrollTop || 0 : scrollTop.value,
    status: status.value,
    repo: repo.value
  }
}
// Kept for the project shown (not a Live Share project this guest cannot read).
let saveTimer = 0
function rememberTree() {
  clearTimeout(saveTimer)
  saveTimer = 0
  if (!shownRoot || shownRoot !== props.root || accessState.value) return
  saveTree(shownRoot, snapshotTree(), api())
}
watch(selected, () => rememberSoon())
function rememberSoon() {
  if (saveTimer || disposed) return
  saveTimer = setTimeout(rememberTree, 1500)
}
// The project's folder could not be read: what went wrong, with Retry;
// above the rows when a remote host did not answer and they were kept.
const rootError = computed(() => {
  const n = props.root ? nodes[displayRoot.value] : null
  return n && n.error && !n.loading ? { text: n.error, kept: n.entries.length > 0 } : null
})
// Folders read again in the background (after a change, Refresh): a small
// spinner in the header.
const backgroundLoads = ref(0)
// The project's folder before its first answer: "Loading…", never an
// empty tree.
const rootLoading = computed(() => {
  const n = props.root ? nodes[displayRoot.value] : null
  return !!props.root && !!api() && (!n || (n.loading && !n.entries.length && !n.error))
})
// Rows kept from the last time and not read again yet (explorerTreeCache.js):
// dimmed, and the header says so.
const staleOf = (dir) => !!(dir && nodes[dir] && nodes[dir].stale)
const staleShown = computed(() => !!props.root && (staleOf(displayRoot.value) || Object.keys(open).some((d) => open[d] && staleOf(d))))
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
  } else if (k === 'F2' && !readOnly.value) startRename(row.chain[seg])
  else if (k === 'Delete' && !readOnly.value) trashIt(row.chain[seg])
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
  menu.x = ev.clientX
  menu.y = ev.clientY
  menu.open = true
  nextTick(() => {
    const el = menuEl.value
    if (!el) return
    keepMenuOnScreen(el, ev.clientX, ev.clientY)
    el.focus()
  })
}
// The menu stays in the window, as VS Code's: above the pointer when there is
// no room under it, to its left when there is none on its right, else pushed
// in (its real size: labels are longer in some languages).
function keepMenuOnScreen(el, x, y, pad = 4) {
  const r = el.getBoundingClientRect()
  const w = r.width
  const h = r.height
  const maxX = window.innerWidth - pad
  const maxY = window.innerHeight - pad
  if (y + h > maxY) menu.y = y - h >= pad ? y - h : Math.max(pad, maxY - h)
  if (x + w > maxX) menu.x = x - w >= pad ? x - w : Math.max(pad, maxX - w)
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
// What runs on this computer (a Live Share host's file is not on it), and
// what changes the host's files.
const LOCAL_ONLY = ['external', 'terminal', 'reveal']
const WRITES = ['new-file', 'new-folder', 'rename', 'trash']
async function act(what) {
  const e = menu.entry
  closeMenu()
  if (lshare.value && LOCAL_ONLY.includes(what)) return emit('toast', localOnlyText())
  if (readOnly.value && WRITES.includes(what)) return refuseReadOnly()
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
  // The view's options (VS Code keeps them in its settings; here, in this menu).
  else if (what === 'dotfiles') dotfiles.value = !dotfiles.value
  else if (what === 'compact') settings.explorerCompactFolders = settings.explorerCompactFolders === false
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
  if (readOnly.value) return refuseReadOnly()
  openBefore(dir)
  if (dir !== displayRoot.value && !open[dir]) {
    open[dir] = true
    await loadDir(dir)
  }
  edit.value = { mode: 'new', dir, folder, value: '', error: '' }
  nextTick(() => editEl.value && editEl.value.focus())
}
async function startRename(e) {
  if (readOnly.value) return refuseReadOnly()
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
  if (readOnly.value) {
    edit.value = null
    return refuseReadOnly()
  }
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
  if (readOnly.value) return refuseReadOnly()
  confirmTrash.value = e
}
async function doTrash() {
  const e = confirmTrash.value
  confirmTrash.value = null
  if (!e) return
  if (readOnly.value) return refuseReadOnly()
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
// A tree kept longer ago than this: its project's folder is read in your turn.
const KEPT_FOREGROUND_MS = 10 * 60 * 1000
let stopChanged = null
let changedTimer = 0
async function showRoot() {
  // The project shown until now: kept as it was, for when it comes back.
  if (shownRoot && shownRoot !== props.root && !accessState.value) saveTree(shownRoot, snapshotTree(), api())
  clearTimeout(saveTimer)
  saveTimer = 0
  const revision = ++viewRevision, root = props.root
  directoryRequests.clear()
  for (const k of Object.keys(refreshing)) delete refreshing[k]
  prefetched.clear()
  prefetchWanted.clear()
  clearTimeout(prefetchTimer)
  clearTimeout(changedTimer)
  pendingChange = { all: false, paths: new Set(), renamed: new Set(), renamedKnown: true }
  resetStatusRuns()
  statusCost = 0
  statusFails = 0
  loadBatch = null
  for (const k of Object.keys(nodes)) delete nodes[k]
  for (const k of Object.keys(open)) delete open[k]
  status.value = {}
  repo.value = false
  selected.value = null
  edit.value = null
  sparseDirs.value = []
  scope.value = WHOLE
  shownRoot = props.root
  // A Live Share project the window says this guest cannot read: nothing is
  // shown or asked.
  const readable = !!props.root && !!api() && !(access.value && access.value.state !== 'ok')
  // Stale while it is read again: the tree as it was last shown comes back
  // at once (its folders open, the selection, the scroll, the git letters),
  // never an empty "Loading…"; then its open folders are read again in the
  // background and only what changed is applied.
  const kept = readable ? loadTree(props.root, api()) : null
  if (kept) {
    for (const [d, entries] of Object.entries(kept.nodes || {})) nodes[d] = { entries, loading: false, error: '', stale: true }
    for (const d of kept.open || []) if (nodes[d]) open[d] = true
    status.value = kept.status || {}
    repo.value = !!kept.repo
    selected.value = kept.selected || null
  }
  const top = kept ? kept.scrollTop || 0 : 0
  scrollTop.value = top
  if (treeEl.value) treeEl.value.scrollTop = top
  if (kept) nextTick(() => {
    if (treeEl.value && shownRoot === root) treeEl.value.scrollTop = top
  })
  if (!readable) return
  api().watch(props.root)
  // Kept a long while ago: the project's own folder is read in your turn
  // (its rows stay meanwhile), the open ones behind it.
  const old = kept && Date.now() - (kept.at || 0) > KEPT_FOREGROUND_MS
  if (kept && old) await Promise.all([loadDir(props.root), loadDirs(openDirs().filter((d) => d !== props.root), { background: true }), loadSparse()])
  else if (kept) await Promise.all([loadDirs(openDirs(), { background: true }), loadSparse()])
  else await Promise.all([loadDir(props.root), loadSparse()])
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
    stopChanged = api().onChanged((r, info) => {
      if (!props.root || key(r) !== key(props.root)) return
      noteChange(info)
    })
  window.addEventListener('resize', measure)
})
onBeforeUnmount(() => {
  // Kept for the next panel (a host connected again remounts it).
  rememberTree()
  disposed = true
  if (stopChanged) stopChanged()
  clearTimeout(changedTimer)
  clearTimeout(searchTimer)
  clearTimeout(prefetchTimer)
  resetStatusRuns()
  window.removeEventListener('resize', measure)
  if (resizeObserver) resizeObserver.disconnect()
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
    <!-- Search (by name or content) first, then VS Code's explorer: "Open
         Editors", then the project's folder. -->
    <div v-if="root && !accessState" class="explorer-tools">
      <div class="explorer-search">
        <Codicon class="explorer-search-icon" name="search" :size="14" />
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

    <section class="explorer-section explorer-open-editors" data-test="open-editors">
      <div
        class="explorer-section-head"
        role="button"
        tabindex="0"
        :aria-expanded="openEditorsShown"
        data-test="open-editors-head"
        @click="toggleOpenEditors"
        @keydown.self.enter.prevent="toggleOpenEditors"
        @keydown.self.space.prevent="toggleOpenEditors"
      >
        <span class="explorer-twistie" :class="{ open: openEditorsShown }" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z" /></svg></span>
        <span class="explorer-section-title">{{ t('explorer.openEditors', 'Open Editors') }}</span>
        <span v-if="unsavedCount" class="explorer-badge" data-test="open-editors-unsaved">{{ unsavedLabel }}</span>
        <span class="explorer-actions" @click.stop>
          <button v-if="!readOnly" class="tb-icon" :title="t('explorer.newFile', 'New file')" :aria-label="t('explorer.newFile', 'New file')" data-test="open-editors-new-file" :disabled="!root" @click="newFromHead(false)">
            <Codicon name="new-file" />
          </button>
          <button class="tb-icon" :title="t('explorer.saveAll', 'Save all')" :aria-label="t('explorer.saveAll', 'Save all')" data-test="open-editors-save-all" :disabled="!unsavedCount" @click="emit('save-all')">
            <Codicon name="save-all" />
          </button>
          <button class="tb-icon" :title="t('explorer.closeAll', 'Close all')" :aria-label="t('explorer.closeAll', 'Close all')" data-test="open-editors-close-all" :disabled="!openEditors.length" @click="emit('close-all')">
            <Codicon name="close-all" />
          </button>
        </span>
      </div>
      <div v-if="openEditorsShown" class="open-editors-list" role="listbox" :aria-label="t('explorer.openEditors', 'Open Editors')" :style="{ maxHeight: OPEN_EDITORS_MAX * ROW_HEIGHT + 'px' }">
        <div
          v-for="ed in openEditors"
          :key="ed.key"
          class="explorer-row open-editor"
          :class="{ active: ed.active, dirty: ed.dirty, preview: ed.preview, ['git-' + (editorLetter(ed) || 'none')]: true }"
          role="option"
          :aria-selected="ed.active"
          :title="ed.path || ed.folder"
          data-test="open-editor"
          @click="emit('activate-editor', ed)"
          @mousedown.middle.prevent
          @mouseup.middle="emit('close-editor', ed)"
        >
          <button
            type="button"
            class="open-editor-close"
            :title="t('explorer.closeEditor', 'Close')"
            :aria-label="t('explorer.closeEditor', 'Close')"
            data-test="open-editor-close"
            @click.stop="emit('close-editor', ed)"
          >
            <Codicon class="open-editor-dot" name="circle-filled" />
            <Codicon class="open-editor-x" name="close" />
          </button>
          <FileIcon v-if="ed.kind === 'file'" class="explorer-icon" :name="ed.path" />
          <Codicon v-else class="explorer-icon open-editor-globe" name="globe" />
          <span class="explorer-name open-editor-name">{{ ed.name }}</span>
          <span class="open-editor-folder">{{ ed.folder }}</span>
          <span v-if="editorLetter(ed)" class="explorer-git">{{ editorLetter(ed) }}</span>
        </div>
      </div>
    </section>
    <div
      class="explorer-head explorer-section-head"
      role="button"
      tabindex="0"
      :aria-expanded="folderShown"
      data-test="explorer-folder-head"
      @click="toggleFolder"
      @keydown.self.enter.prevent="toggleFolder"
      @keydown.self.space.prevent="toggleFolder"
    >
      <span class="explorer-twistie" :class="{ open: folderShown }" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z" /></svg></span>
      <span class="explorer-title explorer-section-title" :title="root || ''">{{ folderTitle }}</span>
      <span v-if="backgroundLoads > 0 && !rootLoading" class="explorer-spinner explorer-head-spinner" role="status" :aria-label="t('explorer.loading', 'Loading…')" data-test="explorer-reloading"></span>
      <span v-if="staleShown" class="explorer-stale-note" role="status" :title="t('explorer.staleHint', 'These are the files shown last time: they are read again in the background and updated in place.')" data-test="explorer-stale">{{ t('explorer.staleNote', 'Last known files, updating…') }}</span>
      <span v-if="readOnly && lshare && !accessState" class="explorer-badge explorer-readonly" :title="t('explorer.readOnly', 'Read-only: the host has not let you edit files here.')" data-test="explorer-read-only">{{ t('explorer.readOnlyTag', 'Read-only') }}</span>
      <span class="explorer-actions" @click.stop>
        <button v-if="!readOnly" class="tb-icon" :title="t('explorer.newFile', 'New file')" :aria-label="t('explorer.newFile', 'New file')" data-test="explorer-head-new-file" :disabled="!root" @click="newFromHead(false)">
          <Codicon name="new-file" />
        </button>
        <button v-if="!readOnly" class="tb-icon" :title="t('explorer.newFolder', 'New folder')" :aria-label="t('explorer.newFolder', 'New folder')" data-test="explorer-head-new-folder" :disabled="!root" @click="newFromHead(true)">
          <Codicon name="new-folder" />
        </button>
        <button class="tb-icon" :title="t('explorer.refresh', 'Refresh')" :aria-label="t('explorer.refresh', 'Refresh')" data-test="explorer-refresh" :disabled="!root" @click="refresh">
          <Codicon name="refresh" />
        </button>
        <button class="tb-icon" :title="t('explorer.collapseAllFolders', 'Collapse all folders')" :aria-label="t('explorer.collapseAll', 'Collapse all')" data-test="explorer-collapse" :disabled="!root" @click="collapseAll">
          <Codicon name="collapse-all" />
        </button>
      </span>
    </div>
    <template v-if="folderShown">
    <div v-if="root && sparseDirs.length && !accessState" class="explorer-scope" data-test="explorer-scope" :title="scopeHelp">
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
    <PanelState
      v-else-if="accessState"
      :kind="accessStateKind(accessState)"
      :text="accessText"
      :retry="(!access || access.state === 'ok') && accessState !== 'remote'"
      data-test="explorer-access"
      @retry="showRoot"
    />
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
          <FileIcon v-else class="explorer-icon" :name="h.name" />
          <span class="explorer-name">{{ h.name }}</span>
          <span class="explorer-hit-dir">{{ dirOf(h.rel) }}</span>
          <span v-if="!ignoredOf(h.path) && letterOf(h)" class="explorer-git">{{ h.dir ? '•' : letterOf(h) }}</span>
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
      @scroll="onTreeScroll"
      @contextmenu.self="onContext($event, null)"
    >
      <div v-if="sticky.length" class="explorer-sticky" data-test="explorer-sticky">
        <div
          v-for="(s, k) in sticky"
          :key="'sticky:' + s.row.path"
          class="explorer-row explorer-sticky-row dir open"
          :class="{ last: k === sticky.length - 1, selected: selected === s.row.path, ignored: ignoredOf(s.row.path), ['git-' + (letterOf(s.row.entry) || 'none')]: true }"
          :style="{ top: s.top + 'px', paddingLeft: rowPadding(s.row.depth) + 4 + 'px' }"
          :title="rowTitle(s.row.entry)"
          @click="onStickyClick(s, k)"
          @contextmenu="onRowContext($event, s.row)"
        >
          <span class="explorer-twistie" aria-hidden="true" @click.stop="toggleRow(s.row)"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z" /></svg></span>
          <span class="explorer-name">{{ s.row.chain.map((c) => c.name).join(' / ') }}</span>
          <span v-if="!ignoredOf(s.row.path) && letterOf(s.row.entry)" class="explorer-git">•</span>
        </div>
      </div>
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
      <PanelState v-if="rootLoading" />
      <PanelState v-else-if="rootError && !rootError.kept" kind="error" :text="rootError.text" @retry="retryRoot" />
      <div v-else-if="rootError" class="explorer-root-error" role="alert" data-test="explorer-error">
        <span class="explorer-root-error-text">{{ rootError.text }}</span>
        <button class="explorer-retry" data-test="explorer-retry" @click="retryRoot">{{ t('explorer.retry', 'Retry') }}</button>
      </div>
      <div v-if="windowed.before" class="explorer-spacer" aria-hidden="true" :style="{ height: windowed.before + 'px' }"></div>
      <template v-for="{ key: itemKey, kind, row, i, depth, dir, error } in windowed.list" :key="itemKey">
        <div v-if="kind === 'loading'" class="explorer-pending" role="status" data-test="explorer-dir-loading" :style="{ paddingLeft: rowPadding(depth) + 22 + 'px' }">
          <span class="explorer-spinner" aria-hidden="true"></span>{{ t('explorer.loading', 'Loading…') }}
        </div>
        <div v-else-if="kind === 'error'" class="explorer-pending explorer-dir-error" role="alert" :title="error" :style="{ paddingLeft: rowPadding(depth) + 22 + 'px' }">
          <span class="explorer-dir-error-text">{{ error }}</span>
          <button class="explorer-retry" data-test="explorer-retry-dir" @click.stop="retryDir(dir)">{{ t('explorer.retry', 'Retry') }}</button>
        </div>
        <div
          v-else-if="!(edit && edit.mode === 'rename' && edit.entry.path === row.path)"
          class="explorer-row"
          :class="{
            selected: segSelected(row, i) >= 0,
            dir: row.dir,
            open: row.open,
            compact: row.chain.length > 1,
            stale: staleOf(row.parent),
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
          <!-- A folder: its arrow. A file: its icon in the arrow's place (VS Code
               aligns file icons with arrows when folders have no icon). -->
          <span v-if="row.dir || !fileIconsOn" class="explorer-twistie" aria-hidden="true"><svg v-if="row.dir" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z" /></svg></span>
          <FileIcon v-else class="explorer-icon" :name="row.name" />
          <span v-if="row.chain.length > 1" class="explorer-name">
            <template v-for="(c, s) in row.chain" :key="c.path">
              <span v-if="s" class="explorer-crumb-sep">/</span>
              <span class="explorer-crumb" :class="{ active: segSelected(row, i) === s }" :data-seg="s" :data-path="c.path" :title="rowTitle(c)">{{ c.name }}</span>
            </template>
          </span>
          <span v-else class="explorer-name">{{ row.name }}</span>
          <span v-if="row.dir && row.open && refreshing[row.path]" class="explorer-spinner explorer-row-spinner" role="status" :aria-label="t('explorer.loading', 'Loading…')" data-test="explorer-dir-refreshing"></span>
          <span v-if="!ignoredOf(row.path) && letterOf(row.entry)" class="explorer-git">{{ row.dir ? '•' : letterOf(row.entry) }}</span>
        </div>
        <div v-else-if="kind === 'row'" class="explorer-edit" :style="{ paddingLeft: rowPadding(row.depth) + 22 + 'px' }">
          <input :ref="setEditEl" v-model="edit.value" class="explorer-edit-input" @keydown.enter.prevent="commitEdit" @keydown.escape.prevent="edit = null" @blur="commitEdit" />
          <div v-if="edit.error" class="explorer-edit-error">{{ edit.error }}</div>
        </div>
        <div
          v-if="kind === 'row' && row.open && edit && edit.mode === 'new' && edit.dir === row.path"
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
      <div v-if="windowed.after" class="explorer-spacer" aria-hidden="true" :style="{ height: windowed.after + 'px' }"></div>

    </div>

    </template>

    <!-- VS Code's Outline and Timeline: the editor in use's symbols and its
         file's history. -->
    <ExplorerOutline :fill="!folderShown" />
    <ExplorerTimeline
      :fill="!folderShown"
      :change-tick="repoChanges"
      :letter-of="fileLetter"
      @open-diff="(req) => emit('open-diff', req)"
      @toast="(m) => emit('toast', m)"
    />

    <div v-if="menu.open" class="explorer-menu-back" @mousedown.self="closeMenu" @contextmenu.prevent="closeMenu">
      <div ref="menuEl" class="ctx-menu explorer-menu" role="menu" tabindex="-1" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <template v-if="menu.entry && !menu.entry.dir">
          <button role="menuitem" class="ctx-menu-item" @click="act('open')">{{ t('explorer.menu.open', 'Open') }}</button>
          <button role="menuitem" class="ctx-menu-item" @click="act('editor')">{{ t('explorer.menu.openInEditor', 'Open in editor') }}</button>
          <button v-if="!remote" role="menuitem" class="ctx-menu-item" data-test="explorer-menu-external" @click="act('external')">{{ t('explorer.menu.openInVsCode', 'Open in VS Code') }}</button>
        </template>
        <button v-if="!lshare" role="menuitem" class="ctx-menu-item" data-test="explorer-menu-terminal" @click="act('terminal')">{{ t('explorer.menu.terminalHere', 'Open a terminal here') }}</button>
        <button v-if="menu.entry && canInsert" role="menuitem" @click="act('insert')">
          {{ t('explorer.menu.insertPath', 'Insert path in the active pane') }}
        </button>
        <template v-if="!readOnly">
          <div class="ctx-menu-sep"></div>
          <button role="menuitem" class="ctx-menu-item" data-test="explorer-menu-new-file" @click="act('new-file')">{{ t('explorer.newFile', 'New file') }}</button>
          <button role="menuitem" class="ctx-menu-item" @click="act('new-folder')">{{ t('explorer.newFolder', 'New folder') }}</button>
          <template v-if="menu.entry">
            <button role="menuitem" class="ctx-menu-item" data-test="explorer-menu-rename" @click="act('rename')">{{ t('explorer.menu.rename', 'Rename') }}</button>
            <button role="menuitem" class="ctx-menu-item danger" data-test="explorer-menu-trash" @click="act('trash')">{{ trashLabel }}</button>
          </template>
        </template>
        <div class="ctx-menu-sep"></div>
        <template v-if="menu.entry">
          <button role="menuitem" class="ctx-menu-item" @click="act('copy')">{{ t('explorer.menu.copyPath', 'Copy path') }}</button>
          <button role="menuitem" class="ctx-menu-item" @click="act('copy-rel')">{{ t('explorer.menu.copyRelPath', 'Copy relative path') }}</button>
        </template>
        <button v-if="!remote" role="menuitem" class="ctx-menu-item" data-test="explorer-menu-reveal" @click="act('reveal')">{{ t('explorer.menu.reveal', 'Reveal in File Explorer') }}</button>
        <div class="ctx-menu-sep"></div>
        <button role="menuitemcheckbox" class="ctx-menu-item" :aria-checked="dotfiles" data-test="explorer-dotfiles" @click="act('dotfiles')">
          <span class="explorer-check">{{ dotfiles ? '✓' : '' }}</span>{{ t('explorer.showDotfiles', 'Show dotfiles') }}
        </button>
        <button role="menuitemcheckbox" class="ctx-menu-item" :aria-checked="settings.explorerCompactFolders !== false" data-test="explorer-compact" @click="act('compact')">
          <span class="explorer-check">{{ settings.explorerCompactFolders !== false ? '✓' : '' }}</span>{{ t('explorer.compactFolders', 'Compact folders') }}
        </button>
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
