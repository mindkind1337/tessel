<!-- i18n-pending: text here does not go through t() yet -->
<script setup>
// The file explorer (after Orca's): the workspace's project as a tree, with
// its git status (M modified, A added, D deleted, R renamed, U untracked),
// kept current as files change. Click a file to open it (Markdown, tables,
// images… in Tessel's viewer; code in your editor); right-click for more;
// drag a file onto a terminal to type its path there. Search by name (in
// folders not opened yet too) or by content; git-ignored files are dimmed.
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { statusOf, folderStatus, ignoredSet, isIgnored } from '../explorerStatus'
import { settings } from '../settings'

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

const api = () => window.shellApi.explorer
const key = (p) => String(p || '').toLowerCase()
const rootName = computed(() => (props.root ? props.root.split(/[\\/]/).filter(Boolean).pop() : ''))

async function loadDir(dir) {
  if (!api() || !props.root) return
  const cur = nodes[dir] || { entries: [], loading: false, error: '' }
  nodes[dir] = { ...cur, loading: true }
  const res = await api().list({ root: props.root, dir, dotfiles: dotfiles.value }).catch(() => null)
  nodes[dir] = res && res.ok ? { entries: res.entries, loading: false, error: '' } : { entries: [], loading: false, error: (res && res.error) || 'Could not read it.' }
}
async function loadStatus() {
  if (!api() || !props.root) return
  const res = await api().status({ root: props.root, ignored: true }).catch(() => null)
  if (!res || !res.ok) return
  const out = {}
  for (const [p, l] of Object.entries(res.files || {})) out[key(p)] = l
  status.value = out
  repo.value = !!res.repo
}
// Everything shown again: the open folders and the git status.
async function refresh() {
  if (!props.root) return
  const dirs = [props.root, ...Object.keys(open).filter((d) => open[d])]
  await Promise.all(dirs.map(loadDir))
  loadStatus()
  if (query.value.trim()) runSearch()
}
const folderStatuses = computed(() => folderStatus(status.value, key(props.root)))
const ignored = computed(() => ignoredSet(status.value))

// The rows shown: open folders' children, depth first.
const rows = computed(() => {
  const out = []
  const walk = (dir, depth) => {
    const n = nodes[dir]
    if (!n) return
    for (const e of n.entries) {
      // Settings > Appearance, "Show Git-Ignored Files" off: hidden.
      if (!settings.showGitIgnoredFiles && ignoredOf(e.path)) continue
      out.push({ ...e, depth })
      if (e.dir && open[e.path]) walk(e.path, depth + 1)
    }
  }
  if (props.root) walk(props.root, 0)
  return out
})
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
  const res = fn
    ? await fn({ root: props.root, query: mode.value === 'content' ? query.value : q, dotfiles: dotfiles.value }).catch((err) => ({ ok: false, error: err.message }))
    : { ok: false, error: 'Search is not available.' }
  if (seq !== searchSeq) return // a newer search is on its way
  Object.assign(search, {
    busy: false,
    results: res && res.ok ? res.results : [],
    truncated: !!(res && res.truncated),
    error: res && res.ok ? '' : (res && res.error) || 'The search failed.',
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
    const el = document.querySelector(`.explorer-row[data-path="${CSS.escape(p)}"]`)
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
  if (what === 'new-file') startNew(props.root, false)
  else if (what === 'new-folder') startNew(props.root, true)
  else if (what === 'dotfiles') dotfiles.value = !dotfiles.value
}

async function toggle(e) {
  if (!e.dir) return
  if (open[e.path]) delete open[e.path]
  else {
    open[e.path] = true
    if (!nodes[e.path]) await loadDir(e.path)
  }
}
function onRowClick(e) {
  selected.value = e.path
  if (e.dir) toggle(e)
  else emit('open', e.path)
}
function collapseAll() {
  for (const k of Object.keys(open)) delete open[k]
}
const relPath = (p) => {
  const r = props.root.replace(/[\\/]+$/, '')
  return p.toLowerCase().startsWith(r.toLowerCase() + '\\') ? p.slice(r.length + 1) : p
}
const quoted = (p) => (/[\s&()^;,'"]/.test(p) ? `"${p}"` : p)

// --- Drag a file to a terminal -------------------------------------------------
function onDragStart(ev, e) {
  if (!ev.dataTransfer) return
  ev.dataTransfer.setData('text/x-tessel-path', e.path)
  ev.dataTransfer.setData('text/plain', e.path)
  ev.dataTransfer.effectAllowed = 'copy'
}

// --- Context menu ----------------------------------------------------------------
const menu = reactive({ open: false, x: 0, y: 0, entry: null })
const menuEl = ref(null)
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
  if (!e) return props.root
  return e.dir ? e.path : e.path.replace(/[\\/][^\\/]*$/, '')
})
function copy(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {})
  emit('toast', 'Copied.')
}
async function act(what) {
  const e = menu.entry
  closeMenu()
  if (what === 'open' && e) emit('open', e.path)
  else if (what === 'editor' && e) emit('open-editor', e.path)
  else if (what === 'external' && e) emit('open-external', e.path)
  else if (what === 'terminal') emit('terminal-here', menuDir.value)
  else if (what === 'insert' && e) emit('insert-path', quoted(relPath(e.path)))
  else if (what === 'copy' && e) copy(e.path)
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
async function startNew(dir, folder) {
  if (dir !== props.root && !open[dir]) {
    open[dir] = true
    await loadDir(dir)
  }
  edit.value = { mode: 'new', dir, folder, value: '', error: '' }
  nextTick(() => editEl.value && editEl.value.focus())
}
async function startRename(e) {
  // From the search results: shown in the tree first.
  if (searching.value) await revealInTree(e.path.replace(/[\\/][^\\/]*$/, ''))
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
    ed.error = (res && res.error) || 'It could not be done.'
    return
  }
  edit.value = null
  await refresh()
  selected.value = res.path
  if (ed.mode === 'new' && !ed.folder) emit('open', res.path)
}
const confirmTrash = ref(null) // the entry waiting for a confirmation
function trashIt(e) {
  confirmTrash.value = e
}
async function doTrash() {
  const e = confirmTrash.value
  confirmTrash.value = null
  if (!e) return
  const res = await api().trash({ root: props.root, path: e.path }).catch((err) => ({ ok: false, error: err.message }))
  if (res && res.ok) emit('toast', `"${e.name}" is in the Recycle Bin.`)
  else emit('toast', `"${e.name}" could not be moved to the Recycle Bin: ${(res && res.error) || 'unknown error'}`)
  refresh()
}

// --- The project shown -------------------------------------------------------------
let stopChanged = null
let changedTimer = 0
async function showRoot() {
  for (const k of Object.keys(nodes)) delete nodes[k]
  for (const k of Object.keys(open)) delete open[k]
  status.value = {}
  edit.value = null
  if (!props.root || !api()) return
  api().watch(props.root)
  await loadDir(props.root)
  loadStatus()
  runSearch()
}
watch(() => props.root, showRoot)
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
  if (stopChanged) stopChanged()
  clearTimeout(changedTimer)
  clearTimeout(searchTimer)
  if (api()) api().unwatch()
})
const LETTER_TITLE = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'New, not in git yet' }
</script>

<template>
  <div class="explorer" aria-label="Files" @keydown.escape="closeMenu">
    <div class="explorer-head">
      <span class="explorer-title" :title="root || ''">{{ rootName || 'Files' }}</span>
      <span class="explorer-actions">
        <button class="tb-icon" title="Collapse all folders" aria-label="Collapse all" data-test="explorer-collapse" :disabled="!root" @click="collapseAll">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <button class="tb-icon" title="Refresh" aria-label="Refresh" data-test="explorer-refresh" :disabled="!root" @click="refresh">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <span class="explorer-more-wrap">
          <button
            class="tb-icon"
            :class="{ on: moreOpen }"
            title="More"
            aria-label="More"
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
            <button role="menuitem" class="ctx-menu-item" data-test="explorer-new-file" @click="moreAct('new-file')">New file</button>
            <button role="menuitem" class="ctx-menu-item" data-test="explorer-new-folder" @click="moreAct('new-folder')">New folder</button>
            <div class="ctx-menu-sep"></div>
            <button role="menuitemcheckbox" class="ctx-menu-item" :aria-checked="dotfiles" data-test="explorer-dotfiles" @click="moreAct('dotfiles')">
              <span class="explorer-check">{{ dotfiles ? '✓' : '' }}</span>Show dotfiles
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
          :placeholder="mode === 'content' ? 'Search in files' : 'Search files'"
          aria-label="Search files"
          data-test="explorer-search"
          spellcheck="false"
          @keydown.escape.stop="clearSearch"
        />
        <button v-if="query" class="explorer-search-clear" title="Clear" aria-label="Clear the search" @click="clearSearch">×</button>
      </div>
      <div class="explorer-seg" role="radiogroup" aria-label="Search by">
        <button role="radio" :aria-checked="mode === 'names'" :class="{ on: mode === 'names' }" data-test="explorer-mode-names" @click="setMode('names')">Names</button>
        <button role="radio" :aria-checked="mode === 'content'" :class="{ on: mode === 'content' }" data-test="explorer-mode-content" @click="setMode('content')">Content</button>
      </div>
    </div>

    <div v-if="!root" class="explorer-empty">
      This workspace has no project folder. Choose one from the workspace menu (Project folder…) to see its files here.
    </div>
    <div v-else-if="searching" class="explorer-tree explorer-results" data-test="explorer-results" :data-mode="mode">
      <div v-if="search.error" class="explorer-empty">{{ search.error }}</div>
      <div v-else-if="search.done && !search.busy && !search.results.length" class="explorer-empty">No {{ mode === 'content' ? 'text' : 'file' }} matches “{{ query.trim() }}”.</div>
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
          <svg v-if="h.dir" class="explorer-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.8 4h4.4l1.4 1.5h6.6v7.7H1.8z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /></svg>
          <svg v-else class="explorer-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.8h5l3 3v9.4H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /></svg>
          <span class="explorer-name">{{ h.name }}</span>
          <span class="explorer-hit-dir">{{ dirOf(h.rel) }}</span>
          <span v-if="ignoredOf(h.path)" class="explorer-ignored" title="Ignored by .gitignore">⊘</span>
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
      <div v-if="search.truncated" class="explorer-empty">Only the first {{ search.results.length }} results are shown. Type more to narrow the search.</div>
      <div v-if="search.busy && !search.results.length" class="explorer-empty">Searching…</div>
    </div>
    <div v-else class="explorer-tree" role="tree" @contextmenu.self="onContext($event, null)">
      <div v-if="edit && edit.mode === 'new' && edit.dir === root" class="explorer-edit" :style="{ paddingLeft: '8px' }">
        <input
          :ref="setEditEl"
          v-model="edit.value"
          class="explorer-edit-input"
          :placeholder="edit.folder ? 'Folder name' : 'File name'"
          @keydown.enter.prevent="commitEdit"
          @keydown.escape.prevent="edit = null"
          @blur="commitEdit"
        />
        <div v-if="edit.error" class="explorer-edit-error">{{ edit.error }}</div>
      </div>
      <template v-for="e in rows" :key="e.path">
        <div
          v-if="!(edit && edit.mode === 'rename' && edit.entry.path === e.path)"
          class="explorer-row"
          :class="{ selected: selected === e.path, dir: e.dir, ignored: ignoredOf(e.path), ['git-' + (letterOf(e) || 'none')]: true }"
          role="treeitem"
          :aria-expanded="e.dir ? !!open[e.path] : undefined"
          :style="{ paddingLeft: 8 + e.depth * 14 + 'px' }"
          :title="relPath(e.path) + (letterOf(e) ? ` (${LETTER_TITLE[letterOf(e)] || letterOf(e)})` : '')"
          draggable="true"
          :data-path="e.path"
          @click="onRowClick(e)"
          @dblclick="!e.dir && emit('open', e.path, { keep: true })"
          @contextmenu="onContext($event, e)"
          @dragstart="onDragStart($event, e)"
        >
          <span class="explorer-chev">{{ e.dir ? (open[e.path] ? '▾' : '▸') : '' }}</span>
          <svg v-if="e.dir" class="explorer-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.8 4h4.4l1.4 1.5h6.6v7.7H1.8z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /></svg>
          <svg v-else class="explorer-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.8h5l3 3v9.4H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /></svg>
          <span class="explorer-name">{{ e.name }}</span>
          <span v-if="ignoredOf(e.path)" class="explorer-ignored" title="Ignored by .gitignore">⊘</span>
          <span v-else-if="letterOf(e)" class="explorer-git">{{ e.dir ? '•' : letterOf(e) }}</span>
        </div>
        <div v-else class="explorer-edit" :style="{ paddingLeft: 8 + e.depth * 14 + 'px' }">
          <input :ref="setEditEl" v-model="edit.value" class="explorer-edit-input" @keydown.enter.prevent="commitEdit" @keydown.escape.prevent="edit = null" @blur="commitEdit" />
          <div v-if="edit.error" class="explorer-edit-error">{{ edit.error }}</div>
        </div>
        <div
          v-if="e.dir && open[e.path] && edit && edit.mode === 'new' && edit.dir === e.path"
          class="explorer-edit"
          :style="{ paddingLeft: 8 + (e.depth + 1) * 14 + 'px' }"
        >
          <input
            :ref="setEditEl"
            v-model="edit.value"
            class="explorer-edit-input"
            :placeholder="edit.folder ? 'Folder name' : 'File name'"
            @keydown.enter.prevent="commitEdit"
            @keydown.escape.prevent="edit = null"
            @blur="commitEdit"
          />
          <div v-if="edit.error" class="explorer-edit-error">{{ edit.error }}</div>
        </div>
      </template>
      <div v-if="nodes[root] && nodes[root].error" class="explorer-empty">{{ nodes[root].error }}</div>
    </div>

    <div v-if="menu.open" class="explorer-menu-back" @mousedown.self="closeMenu" @contextmenu.prevent="closeMenu">
      <div ref="menuEl" class="ctx-menu explorer-menu" role="menu" tabindex="-1" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <template v-if="menu.entry && !menu.entry.dir">
          <button role="menuitem" class="ctx-menu-item" @click="act('open')">Open</button>
          <button role="menuitem" class="ctx-menu-item" @click="act('editor')">Open in editor</button>
          <button role="menuitem" class="ctx-menu-item" @click="act('external')">Open in VS Code</button>
        </template>
        <button role="menuitem" class="ctx-menu-item" @click="act('terminal')">Open a terminal here</button>
        <button v-if="menu.entry && canInsert" role="menuitem" @click="act('insert')">Insert path in the active pane</button>
        <div class="ctx-menu-sep"></div>
        <button role="menuitem" class="ctx-menu-item" @click="act('new-file')">New file</button>
        <button role="menuitem" class="ctx-menu-item" @click="act('new-folder')">New folder</button>
        <template v-if="menu.entry">
          <button role="menuitem" class="ctx-menu-item" @click="act('rename')">Rename</button>
          <button role="menuitem" class="ctx-menu-item danger" @click="act('trash')">Move to Recycle Bin</button>
        </template>
        <div class="ctx-menu-sep"></div>
        <template v-if="menu.entry">
          <button role="menuitem" class="ctx-menu-item" @click="act('copy')">Copy path</button>
          <button role="menuitem" class="ctx-menu-item" @click="act('copy-rel')">Copy relative path</button>
        </template>
        <button role="menuitem" class="ctx-menu-item" @click="act('reveal')">Reveal in File Explorer</button>
      </div>
    </div>

    <div v-if="confirmTrash" class="explorer-confirm" role="alertdialog" aria-label="Move to Recycle Bin">
      <div>Move <strong>{{ confirmTrash.name }}</strong> to the Recycle Bin?</div>
      <div class="explorer-confirm-actions">
        <button class="exit-btn" @click="confirmTrash = null">Cancel</button>
        <button class="exit-btn danger" @click="doTrash">Move to Recycle Bin</button>
      </div>
    </div>
  </div>
</template>
