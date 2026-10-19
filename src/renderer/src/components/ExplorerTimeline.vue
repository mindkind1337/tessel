<script setup>
// VS Code's Timeline (timelinePane.ts) at the bottom of the explorer: the
// history of the file in the editor in use (or the one pinned), newest
// first: its changes not committed yet, the commits that changed it (its git
// extension's Git History) and the versions kept at its saves (Local
// History). A click opens that change's diff; a commit's hover tells all.
import { ref, reactive, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { settings } from '../settings'
import { t } from '../i18n'
import { openTarget } from '../links/openTarget'
import { activeEditor } from '../editor/activeEditor'
import { localHistoryState } from '../editor/localHistory'
import { timelineEntries, splitPath, repoTopOf } from '../explorer/timeline'
import { rowPadding, ROW_HEIGHT } from '../explorerRows'
import { usePaneResize } from '../explorer/paneResize'
import Codicon from './Codicon.vue'
import TimelineHover from './TimelineHover.vue'

const props = defineProps({
  // The project's folder is folded: this section takes the room left.
  fill: { type: Boolean, default: false },
  // One more each time the explorer sees the repository change (a commit…).
  changeTick: { type: Number, default: 0 },
  // A file's git letter in the explorer (M, A, D, R, C, U), for its
  // "Uncommitted Changes" hover.
  letterOf: { type: Function, default: null }
})
const emit = defineEmits(['open-diff', 'toast'])

const shown = computed(() => settings.explorerTimelineShown === true)
function toggleShown() {
  settings.explorerTimelineShown = !shown.value
}
const sectionEl = ref(null)
const { height, startResize } = usePaneResize({ key: 'explorerTimelineHeight', sectionEl })

// --- The file shown: the editor's, or the one pinned ----------------------------------
const pinned = ref(null)
const target = computed(() => pinned.value || activeEditor.path || null)
function togglePin() {
  pinned.value = pinned.value ? null : activeEditor.path || data.path || null
}
const fileName = (p) => splitPath(p)[1]
const description = computed(() => {
  const name = data.path ? fileName(data.path) : ''
  if (!name) return ''
  return pinned.value ? t('explorer.timeline.pinnedName', '{{name}} (pinned)', { name }) : name
})

// --- Its entries ----------------------------------------------------------------------------
const gitOn = computed(() => settings.explorerTimelineGit !== false)
const localOn = computed(() => settings.explorerTimelineLocal !== false)
const data = reactive({ path: null, loading: false, commits: [], hasMore: false, uncommitted: false, scm: true, rel: null, local: [], loaded: false })
const pageSize = computed(() => Math.max(20, Math.floor(height.value / ROW_HEIGHT) - 1))
let limit = 0
let seq = 0
async function load({ more = false } = {}) {
  const my = ++seq
  const path = target.value
  if (!shown.value || !path) {
    Object.assign(data, { path: path || null, loading: false, commits: [], hasMore: false, uncommitted: false, scm: true, rel: null, local: [], loaded: false })
    return
  }
  const sameFile = data.path === path && data.loaded
  if (!sameFile) {
    Object.assign(data, { path, commits: [], hasMore: false, uncommitted: false, rel: null, local: [], loaded: false })
    limit = 0
    hideHover()
  }
  limit = more ? limit + pageSize.value : Math.max(limit, pageSize.value)
  data.loading = true
  const api = (typeof window !== 'undefined' && window.shellApi) || {}
  const [dir] = splitPath(path)
  // A Live Share host's file: its Local History is the host's (asked of it;
  // this computer keeps none of it, editor/localHistory.js).
  const local = localOn.value
  const [g, l] = await Promise.all([
    gitOn.value && api.scm && api.scm.fileHistory ? Promise.resolve(api.scm.fileHistory({ root: dir, path, limit })).catch(() => null) : null,
    local && api.localHistory && api.localHistory.list ? Promise.resolve(api.localHistory.list({ path })).catch(() => null) : null
  ])
  if (my !== seq) return
  Object.assign(data, {
    loading: false,
    loaded: true,
    commits: g && g.ok && Array.isArray(g.items) ? g.items : [],
    hasMore: !!(g && g.ok && g.hasMore),
    uncommitted: !!(g && g.ok && g.uncommitted),
    rel: g && g.ok ? g.rel || null : null,
    // Source Control knows this file (VS Code adds "Source Control has not
    // been configured." when not).
    scm: !gitOn.value || !!(g && g.ok),
    local: l && Array.isArray(l.entries) ? l.entries : []
  })
}
let loadTimer = 0
function scheduleLoad(ms = 0) {
  clearTimeout(loadTimer)
  loadTimer = setTimeout(load, ms)
}
watch([target, shown, gitOn, localOn], () => scheduleLoad(0), { immediate: true })
// A save kept (Local History), a change in the repository: read again (VS
// Code's refreshDebounced, 500 ms).
watch(
  () => localHistoryState.rev,
  () => {
    if (localHistoryState.path && data.path && String(localHistoryState.path).toLowerCase() === String(data.path).toLowerCase()) scheduleLoad(500)
  }
)
watch(
  () => props.changeTick,
  () => data.path && scheduleLoad(500)
)
function refresh() {
  hideHover()
  load()
}
function loadMore() {
  if (!data.loading) load({ more: true })
}

// "now" moves on: the relative times follow (every 30 s while shown).
const now = ref(Date.now())
let clock = 0
watch(
  shown,
  (on) => {
    clearInterval(clock)
    clock = on ? setInterval(() => (now.value = Date.now()), 30000) : 0
  },
  { immediate: true }
)
const entries = computed(() =>
  timelineEntries({ commits: data.commits, uncommitted: data.uncommitted, local: data.local, git: gitOn.value, history: localOn.value, now: now.value })
)

// VS Code's messages when there is nothing to show.
const message = computed(() => {
  if (!target.value) return t('explorer.timeline.noEditor', 'The active editor cannot provide timeline information.')
  if (entries.value.length) return ''
  if (data.loading || !data.loaded) return t('explorer.timeline.loading', 'Loading timeline for {{file}}...', { file: fileName(target.value) })
  let text
  if (!gitOn.value && !localOn.value) text = t('explorer.timeline.allFiltered', 'All timeline sources have been filtered out.')
  else if (localOn.value)
    text = t('explorer.timeline.noLocalHistoryYet', 'Local History will track recent changes as you save them unless the file has been excluded or is too large.')
  else text = t('explorer.timeline.noFilteredInfo', 'No filtered timeline information was provided.')
  if (!data.scm) text += ' ' + t('explorer.timeline.noScm', 'Source Control has not been configured.')
  return text
})

// --- Opening an entry: its diff -------------------------------------------------------------
const selectedId = ref(null)
function repoRoot(path) {
  return repoTopOf(path, data.rel) || splitPath(path)[0]
}
function relOf(path) {
  return data.rel || fileName(path)
}
function openEntry(e, { preview = true } = {}) {
  const file = data.path
  if (!e || !file) return
  selectedId.value = e.id
  if (e.kind === 'commit') emit('open-diff', { root: repoRoot(file), rel: relOf(file), area: 'commit', commit: e.commit.id, status: 'modified', file, preview })
  else if (e.kind === 'uncommitted') emit('open-diff', { root: repoRoot(file), rel: relOf(file), area: 'unstaged', status: 'modified', file, preview })
  else if (e.kind === 'local') emit('open-diff', { root: splitPath(file)[0], rel: fileName(file), area: 'local', local: e.localId, localTime: e.time, file, preview })
}

// --- Keyboard -------------------------------------------------------------------------------
const treeEl = ref(null)
function selectAt(i) {
  const list = entries.value
  if (!list.length) return
  const e = list[Math.max(0, Math.min(list.length - 1, i))]
  selectedId.value = e.id
  nextTick(() => {
    const row = treeEl.value && [...treeEl.value.querySelectorAll('[data-id]')].find((x) => x.dataset.id === e.id)
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
  })
}
function onTreeKey(ev) {
  const list = entries.value
  const cur = list.findIndex((e) => e.id === selectedId.value)
  const k = ev.key
  let done = true
  if (k === 'ArrowDown') selectAt(cur >= 0 ? cur + 1 : 0)
  else if (k === 'ArrowUp') selectAt(cur >= 0 ? cur - 1 : list.length - 1)
  else if (k === 'Home') selectAt(0)
  else if (k === 'End') selectAt(list.length - 1)
  else if (k === 'Enter' && cur >= 0) openEntry(list[cur])
  else done = false
  if (done) ev.preventDefault()
}

// --- The hover (VS Code's workbench hover: after 500 ms, kept while the
// pointer is on it; at once when moving from one entry to the next) --------------------------
const hover = reactive({ entry: null, anchor: null })
const infos = reactive({}) // commit id -> { stats, webUrl }
let showTimer = 0
let hideTimer = 0
let hiddenAt = 0
function rectOf(el) {
  const r = el.getBoundingClientRect()
  return { left: r.left, right: r.right, top: r.top, height: r.height }
}
function onRowEnter(e, ev) {
  clearTimeout(hideTimer)
  if (hover.entry && hover.entry.id === e.id) return
  clearTimeout(showTimer)
  const el = ev.currentTarget
  const quick = !!hover.entry || Date.now() - hiddenAt < 200
  showTimer = setTimeout(() => showHover(e, el), quick ? 0 : 500)
}
function onRowLeave() {
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
  hideTimer = setTimeout(hideHover, 150)
}
function onHoverEnter() {
  clearTimeout(hideTimer)
}
function showHover(e, el) {
  if (!el || !el.isConnected) return
  hover.entry = e
  hover.anchor = rectOf(el)
  if (e.kind === 'commit') loadInfo(e.commit.id)
}
function hideHover() {
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
  if (hover.entry) hiddenAt = Date.now()
  hover.entry = null
  hover.anchor = null
}
async function loadInfo(id) {
  if (infos[id] || !data.path) return
  const api = window.shellApi && window.shellApi.scm
  if (!api || !api.commitInfo) return
  infos[id] = { pending: true }
  const res = await Promise.resolve(api.commitInfo({ root: splitPath(data.path)[0], commit: id })).catch(() => null)
  infos[id] = res && res.ok ? { stats: res.stats || null, webUrl: res.webUrl || null } : { stats: null, webUrl: null }
}
const hoverInfo = computed(() => (hover.entry && hover.entry.kind === 'commit' ? infos[hover.entry.commit.id] || null : null))
function statusText(letter) {
  if (letter === 'A') return t('explorer.timeline.status.indexAdded', 'Index Added')
  if (letter === 'D') return t('explorer.timeline.status.deleted', 'Deleted')
  if (letter === 'R') return t('explorer.timeline.status.indexRenamed', 'Index Renamed')
  if (letter === 'C') return t('explorer.timeline.status.indexCopied', 'Index Copied')
  if (letter === 'U') return t('explorer.timeline.status.untracked', 'Untracked')
  return t('explorer.timeline.status.modified', 'Modified')
}
const hoverStatus = computed(() => (hover.entry && hover.entry.kind === 'uncommitted' ? statusText(props.letterOf && data.path ? props.letterOf(data.path) : '') : ''))
function copyHash(id) {
  if (navigator.clipboard) navigator.clipboard.writeText(id).catch(() => {})
}
// Through Tessel's link router (links/openTarget.js), like every link.
function openUrl(url, event) {
  Promise.resolve(openTarget(url, { event })).catch(() => {})
}
function onHoverOpen() {
  const e = hover.entry
  hideHover()
  openEntry(e)
}

// --- The header's filter menu ---------------------------------------------------------------
const menu = reactive({ open: false, x: 0, y: 0 })
const menuEl = ref(null)
function openMenu(ev) {
  const r = ev.currentTarget.getBoundingClientRect()
  menu.x = r.right
  menu.y = r.bottom + 2
  menu.open = true
  nextTick(() => {
    const el = menuEl.value
    if (!el) return
    const w = el.getBoundingClientRect().width
    menu.x = Math.max(4, Math.min(r.right - w, window.innerWidth - w - 4))
    const h = el.getBoundingClientRect().height
    if (menu.y + h > window.innerHeight - 4) menu.y = Math.max(4, r.top - h - 2)
    el.focus()
  })
}
function closeMenu() {
  menu.open = false
}
function pick(what) {
  closeMenu()
  if (what === 'git') settings.explorerTimelineGit = !gitOn.value
  else if (what === 'local') settings.explorerTimelineLocal = !localOn.value
}

onBeforeUnmount(() => {
  seq++
  clearTimeout(loadTimer)
  clearInterval(clock)
  hideHover()
})
</script>

<template>
  <section ref="sectionEl" class="explorer-section explorer-pane explorer-timeline" :class="{ expanded: shown, fill: shown && props.fill }" :style="shown && !props.fill ? { height: height + 28 + 'px' } : null" data-test="timeline">
    <div v-if="shown && !props.fill" class="explorer-sash" aria-hidden="true" data-test="timeline-sash" @pointerdown="startResize"></div>
    <div
      class="explorer-section-head explorer-pane-head"
      role="button"
      tabindex="0"
      :aria-expanded="shown"
      data-test="timeline-head"
      @click="toggleShown"
      @keydown.self.enter.prevent="toggleShown"
      @keydown.self.space.prevent="toggleShown"
    >
      <span class="explorer-twistie" :class="{ open: shown }" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z" /></svg></span>
      <span class="explorer-section-title">{{ t('explorer.timeline.title', 'Timeline') }}</span>
      <span v-if="shown && description" class="explorer-pane-description" data-test="timeline-description">{{ description }}</span>
      <span v-if="shown" class="explorer-actions" @click.stop>
        <button
          class="tb-icon"
          :title="pinned ? t('explorer.timeline.unpin', 'Unpin the Current Timeline') : t('explorer.timeline.pin', 'Pin the Current Timeline')"
          :aria-label="pinned ? t('explorer.timeline.unpin', 'Unpin the Current Timeline') : t('explorer.timeline.pin', 'Pin the Current Timeline')"
          :aria-pressed="!!pinned"
          data-test="timeline-pin"
          :disabled="!pinned && !target"
          @click="togglePin"
        >
          <Codicon :name="pinned ? 'pinned' : 'pin'" />
        </button>
        <button class="tb-icon" :title="t('explorer.refresh', 'Refresh')" :aria-label="t('explorer.refresh', 'Refresh')" data-test="timeline-refresh" @click="refresh">
          <Codicon name="refresh" />
        </button>
        <button
          class="tb-icon"
          :class="{ open: menu.open }"
          :title="t('explorer.timeline.filter', 'Filter Timeline')"
          :aria-label="t('explorer.timeline.filter', 'Filter Timeline')"
          aria-haspopup="menu"
          :aria-expanded="menu.open"
          data-test="timeline-filter"
          @click="openMenu"
        >
          <Codicon name="filter" />
        </button>
      </span>
    </div>
    <div v-if="shown" class="explorer-pane-body">
      <div v-if="message" class="explorer-pane-message" data-test="timeline-message">{{ message }}</div>
      <div v-else ref="treeEl" class="explorer-pane-tree" role="tree" tabindex="0" :aria-label="t('explorer.timeline.title', 'Timeline')" data-test="timeline-list" @keydown="onTreeKey" @scroll="hideHover">
        <div
          v-for="e in entries"
          :key="e.id"
          class="explorer-row timeline-row"
          :class="{ selected: selectedId === e.id, ['timeline-' + e.kind]: true }"
          role="treeitem"
          :aria-level="1"
          :aria-selected="selectedId === e.id"
          :aria-label="t('explorer.timeline.ariaItem', '{{time}}: {{label}}', { time: e.relativeFull, label: e.label })"
          :style="{ paddingLeft: rowPadding(0) + 'px' }"
          :data-id="e.id"
          data-test="timeline-row"
          @click="openEntry(e)"
          @dblclick="openEntry(e, { preview: false })"
          @mouseenter="onRowEnter(e, $event)"
          @mouseleave="onRowLeave"
        >
          <span class="explorer-twistie" aria-hidden="true"></span>
          <Codicon class="timeline-icon" :name="e.icon" />
          <span class="explorer-name timeline-label">{{ e.label }}</span>
          <span v-if="e.description" class="open-editor-folder timeline-description">{{ e.description }}</span>
          <span class="timeline-time" :class="{ duplicate: e.sameTime }" :aria-label="e.relativeFull"><span class="timeline-time-text">{{ e.relative }}</span></span>
        </div>
        <div
          v-if="data.hasMore && gitOn"
          class="explorer-row timeline-row timeline-more"
          role="treeitem"
          :aria-level="1"
          :style="{ paddingLeft: rowPadding(0) + 'px' }"
          data-test="timeline-more"
          @click="loadMore"
        >
          <span class="explorer-twistie" aria-hidden="true"></span>
          <span class="explorer-name timeline-label">{{ data.loading ? t('explorer.timeline.loadingMore', 'Loading...') : t('explorer.timeline.loadMore', 'Load more') }}</span>
        </div>
      </div>
    </div>

    <TimelineHover
      v-if="hover.entry && hover.anchor"
      :entry="hover.entry"
      :anchor="hover.anchor"
      :info="hoverInfo"
      :status-text="hoverStatus"
      :now="now"
      @enter="onHoverEnter"
      @leave="onRowLeave"
      @open="onHoverOpen"
      @copy="copyHash"
      @open-url="openUrl"
    />

    <div v-if="menu.open" class="explorer-menu-back" @mousedown.self="closeMenu" @contextmenu.prevent="closeMenu">
      <div ref="menuEl" class="ctx-menu explorer-menu explorer-pane-menu" role="menu" tabindex="-1" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @keydown.escape="closeMenu">
        <button role="menuitemcheckbox" class="ctx-menu-item" :aria-checked="gitOn" data-test="timeline-filter-git" @click="pick('git')">
          <span class="explorer-pane-check"><Codicon v-if="gitOn" name="check" /></span>{{ t('explorer.timeline.gitHistory', 'Git History') }}
        </button>
        <button role="menuitemcheckbox" class="ctx-menu-item" :aria-checked="localOn" data-test="timeline-filter-local" @click="pick('local')">
          <span class="explorer-pane-check"><Codicon v-if="localOn" name="check" /></span>{{ t('explorer.timeline.localHistory', 'Local History') }}
        </button>
      </div>
    </div>
  </section>
</template>
