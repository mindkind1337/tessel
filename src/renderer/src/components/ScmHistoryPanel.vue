<script setup>
// The Commits section at the bottom of Source Control, ported from Orca's
// right-sidebar/source-control/sync/git-history-panel.tsx, git-history-row.tsx,
// git-history-graph-svg.tsx and git-history-commit-files.tsx (MIT, Copyright
// (c) 2026 Lovecast Inc.), written for Vue. The last commits of HEAD with
// Orca's graph and ref pills; a click shows the files of a commit, a click on
// a file opens its diff in the editor. A commit link clicked elsewhere (a
// hash an agent wrote: links/commitLinks.js) opens it here, selected with
// its files (focus); one older than the commits listed shows above them.
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { ChevronDown, CircleHelp, RefreshCw } from 'lucide-vue-next'
import {
  buildDefaultGitHistoryColorMap,
  buildGitHistoryViewModels,
  gitHistoryGraphGeometry,
  graphColor,
  dedupeRemoteTrackingRefs,
  CIRCLE_RADIUS,
  CIRCLE_STROKE_WIDTH
} from '../../../shared/gitHistoryGraph'
import { STATUS_COLORS, STATUS_LABELS } from '../../../shared/sourceControl'
import FileIcon from './FileIcon.vue'
import { t, intlLocale } from '../i18n'
import { openTarget } from '../links/openTarget'
import { dateTimeFormat } from '../../../shared/intlCache'
import PanelState from './ui/PanelState.vue'
import TimelineHover from './TimelineHover.vue'
import { useCommitHover, commitEntry } from '../explorer/useCommitHover'
import { resolveCommit } from '../links/commitLinks'

const props = defineProps({
  // The repository folder (the project or a task's copy).
  root: { type: String, default: null },
  // The compare base ('origin/main'): its commit gets Orca's base colour.
  base: { type: String, default: null },
  // Changes when HEAD moves (a commit, a pull): the list is read again.
  head: { type: String, default: null },
  // A commit to show selected with its files: { commit, n } (n: each request).
  focus: { type: Object, default: null }
})
const emit = defineEmits(['open-file'])

const api = () => window.shellApi && window.shellApi.scm

// Collapsed by default (Orca docks it closed at the bottom); kept while Tessel runs.
const collapsed = ref(historyCollapsed.value)
watch(collapsed, (v) => (historyCollapsed.value = v))

const state = ref({ status: 'idle', result: null, error: '' })
let seq = 0
async function load() {
  const root = props.root
  if (!root || !api() || !api().history) return
  const token = ++seq
  state.value = { ...state.value, status: state.value.result ? 'refreshing' : 'loading' }
  let res = null
  try {
    res = await api().history({ root, base: props.base || undefined })
  } catch (err) {
    res = { ok: false, error: err && err.message }
  }
  if (token !== seq) return
  if (res && res.ok) {
    state.value = { status: 'ready', result: res, error: '' }
    expanded.value = new Set()
    files.value = {}
    outside.value = null
    selected.value = null
    if (pendingFocus) applyFocus()
  } else state.value = { status: 'error', result: state.value.result, error: (res && res.error) || t('changes.history.failed', 'Could not read the commits') }
}

const loading = computed(() => state.value.status === 'loading' || state.value.status === 'refreshing')
const result = computed(() => state.value.result)
const count = computed(() => (result.value ? result.value.items.length : 0))

const viewModels = computed(() => {
  const r = result.value
  if (!r) return []
  return buildGitHistoryViewModels(r.items, buildDefaultGitHistoryColorMap(r), r.currentRef, r.remoteRef, r.baseRef)
})
const rows = computed(() =>
  viewModels.value.map((vm) => {
    const refs = dedupeRemoteTrackingRefs(vm.historyItem.references || [], {
      preserveRefIds: result.value && result.value.baseRef ? [result.value.baseRef.id] : []
    })
    return { id: vm.historyItem.id, item: vm.historyItem, vm, geo: gitHistoryGraphGeometry(vm), refs: refs.slice(0, 2), hidden: refs.slice(2) }
  })
)
// The commit a link asked for when it is not among the commits read: first.
const shownRows = computed(() => (outside.value ? [{ id: outside.value.id, item: outside.value, vm: null }, ...rows.value] : rows.value))

function toggle() {
  collapsed.value = !collapsed.value
}
function onRefresh() {
  if (collapsed.value) return toggle()
  load()
}

// --- A commit asked for (a commit link: ChangesPanel's commitFocus) ----------------
// Opened (the section unfolds), selected, its files shown and scrolled to;
// after the list is read when a read is on its way (or the section was
// closed). One the list does not hold (older, another branch) is read on
// its own and shown first.
const selected = ref(null) // the selected commit's id
const outside = ref(null) // { id, subject, author, timestamp, displayId }
const listEl = ref(null)
let pendingFocus = null
async function applyFocus() {
  const commit = pendingFocus
  pendingFocus = null
  const r = result.value
  if (!commit || !r) return
  const root = props.root
  let item = r.items.find((i) => i.id === commit || i.id.startsWith(commit)) || null
  if (!item) {
    const info = await resolveCommit(root, commit)
    if (!info || root !== props.root || result.value !== r) return
    item = { id: info.id, subject: info.subject || info.id.slice(0, 7), author: info.author, timestamp: info.timestamp, displayId: info.id.slice(0, 7) }
    outside.value = item
  }
  selected.value = item.id
  if (!expanded.value.has(item.id)) toggleCommit(item)
  await nextTick()
  const el = listEl.value && [...listEl.value.querySelectorAll('[data-commit-id]')].find((x) => x.getAttribute('data-commit-id') === item.id)
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
}

// Files of a commit, read once when it is first opened.
const expanded = ref(new Set())
const files = ref({}) // id -> { status: 'loading'|'ready'|'error', entries?, error? }
async function toggleCommit(item) {
  const id = item.id
  const next = new Set(expanded.value)
  if (next.has(id)) {
    next.delete(id)
    expanded.value = next
    return
  }
  next.add(id)
  expanded.value = next
  if (files.value[id] && files.value[id].status !== 'error') return
  files.value = { ...files.value, [id]: { status: 'loading' } }
  // The list read again since (another repository, HEAD moved): this answer is not for it.
  const token = seq
  let res = null
  try {
    res = await api().commitFiles({ root: props.root, commit: id })
  } catch (err) {
    res = { ok: false, error: err && err.message }
  }
  if (token !== seq) return
  files.value = {
    ...files.value,
    [id]: res && res.ok ? { status: 'ready', entries: res.entries || [] } : { status: 'error', error: (res && res.error) || t('changes.history.filesFailed', 'Failed to load commit files') }
  }
}

function commitAria(item, open) {
  const vars = { id: item.displayId || item.id, subject: item.subject }
  return open ? t('changes.history.hideFiles', 'Hide files in commit {{id}}: {{subject}}', vars) : t('changes.history.showFiles', 'Show files in commit {{id}}: {{subject}}', vars)
}
function refLabel(ref) {
  return ref.category ? `${ref.name} (${ref.category})` : ref.name
}
function refStyle(ref) {
  return ref.color ? { borderColor: graphColor(ref.color), color: graphColor(ref.color) } : null
}
// The commit's day and time ("6 oct. 23:12"), with the year when it is not this one.
function commitDate(timestamp, now = new Date()) {
  const d = new Date(timestamp)
  const options = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  if (d.getFullYear() !== now.getFullYear()) options.year = 'numeric'
  return dateTimeFormat(intlLocale(), options).format(d)
}
function meta(item) {
  let date = ''
  if (item.timestamp != null && Number.isFinite(item.timestamp)) {
    try {
      date = commitDate(item.timestamp)
    } catch {
      date = ''
    }
  }
  return [item.author, date].filter(Boolean).join(' · ')
}
const baseName = (p) => String(p).split('/').pop()
const dirOf = (p) => {
  const i = String(p).lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : ''
}
function openFile(item, entry, pinned) {
  emit('open-file', { commit: item.id, entry, preview: !pinned })
}

// Resizing the list (its top edge), like Orca: 96-520 px, at most a third of the window.
const MIN_H = 96
const MAX_H = 520
const height = ref(historyHeight.value)
watch(height, (v) => (historyHeight.value = v))
const clampH = (h) => Math.min(MAX_H, Math.max(MIN_H, h))
let drag = null
function onPointerMove(e) {
  if (drag) height.value = clampH(drag.startHeight + drag.startY - e.clientY)
}
function stopResize() {
  if (!drag) return
  document.body.style.cursor = drag.cursor
  document.body.style.userSelect = drag.userSelect
  drag = null
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', stopResize)
}
function startResize(e) {
  if (collapsed.value) return
  e.preventDefault()
  drag = { startY: e.clientY, startHeight: height.value, cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', stopResize)
}
function onResizeKey(e) {
  const step = e.shiftKey ? 32 : 16
  if (e.key === 'ArrowUp') height.value = clampH(height.value + step)
  else if (e.key === 'ArrowDown') height.value = clampH(height.value - step)
  else if (e.key === 'Home') height.value = MIN_H
  else if (e.key === 'End') height.value = MAX_H
  else return
  e.preventDefault()
}
const bodyStyle = computed(() => ({ height: `min(${height.value}px, 33vh)` })) // i18n-ignore

// Read when opened, and again when HEAD or the repository changes while open.
watch(
  () => [props.root, props.head, props.base, collapsed.value],
  ([root, , , isCollapsed], old) => {
    if (!root || isCollapsed) return
    const rootChanged = !old || old[0] !== root
    if (rootChanged) state.value = { status: 'idle', result: null, error: '' }
    load()
  },
  { immediate: true }
)
watch(
  () => props.focus && props.focus.n,
  () => {
    if (!props.focus || !props.focus.commit) return
    pendingFocus = props.focus.commit
    // Closed: opening it reads the list, which then shows the commit.
    if (collapsed.value) return void (collapsed.value = false)
    if (state.value.status === 'ready' && result.value) applyFocus()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  seq++
  stopResize()
  commitHover.dispose()
})
defineExpose({ load })

// A commit's whole story on hover (the Timeline's card, VS Code's git
// hover): author, when, the full message, its numbers, hash and GitHub page.
const commitHover = useCommitHover({ root: () => props.root })
function openHoveredCommit() {
  const e = commitHover.hover.entry
  commitHover.hide()
  const item = e && rows.value.map((r) => r.vm.historyItem).find((i) => i.id === e.id)
  if (item && !expanded.value.has(item.id)) toggleCommit(item)
}
function copyCommitHash(id) {
  if (navigator.clipboard) navigator.clipboard.writeText(id).catch(() => {})
}
// A commit's page, a link in its message, its author's address: Tessel's
// link router (links/openTarget.js; Ctrl+click: the other browser).
function openCommitUrl(url, event) {
  Promise.resolve(openTarget(url, { event })).catch(() => {})
}
</script>

<script>
import { ref as moduleRef } from 'vue'
// Open or closed, and its height, kept while Tessel runs (every panel shares them).
const historyCollapsed = moduleRef(true)
const historyHeight = moduleRef(256)
</script>

<template>
  <div class="sch" data-test="sc-history">
    <div
      v-if="!collapsed"
      class="sch-resize"
      role="separator"
      :aria-label="t('changes.history.resize', 'Resize commits')"
      aria-orientation="horizontal"
      :aria-valuemin="96"
      :aria-valuemax="520"
      :aria-valuenow="height"
      tabindex="0"
      @pointerdown="startResize"
      @keydown="onResizeKey"
    ></div>
    <div class="sch-head">
      <div class="sch-head-row">
        <button type="button" class="sch-toggle" :aria-expanded="!collapsed" data-test="sc-history-toggle" @click="toggle">
          <ChevronDown :size="12" class="sch-chev" :class="{ 'sc-rot': collapsed }" />
          <span>{{ t('changes.history.title', 'Commits') }}</span>
          <span v-if="result" class="sch-count" data-test="sc-history-count">{{ count }}</span>
          <span v-if="result && result.hasMore" class="sch-count">+</span>
        </button>
        <button
          type="button"
          class="sch-mini"
          :aria-label="t('changes.history.refsHelp', 'What are refs?')"
          :title="t('changes.history.refsHelpText', 'Refs are branch or tag names pointing at that exact commit. They only appear where Git has a named ref for the commit.')"
          @click.stop
        >
          <CircleHelp :size="12" />
        </button>
        <button
          type="button"
          class="sch-mini"
          :aria-label="t('changes.history.refresh', 'Refresh commits')"
          :title="t('changes.history.refresh', 'Refresh commits')"
          data-test="sc-history-refresh"
          @click.stop="onRefresh"
        >
          <RefreshCw :size="12" :class="{ 'sc-spin': loading }" />
        </button>
      </div>
    </div>
    <template v-if="!collapsed">
      <div v-if="state.status === 'error' && !result" class="sch-body" :style="bodyStyle" data-test="sc-history-error">
        <PanelState kind="error" :text="state.error" @retry="load" />
      </div>
      <div v-else-if="!result" class="sch-body sch-msg" :style="bodyStyle">
        <RefreshCw :size="12" class="sc-spin" />
        <span>{{ t('changes.history.loading', 'Loading graph...') }}</span>
      </div>
      <div v-else-if="!rows.length" class="sch-body sch-msg" :style="bodyStyle">{{ t('changes.history.none', 'No commits yet') }}</div>
      <div v-else ref="listEl" class="sch-body" :style="bodyStyle" data-test="sc-history-list">
        <div v-if="state.status === 'error'" class="sch-file-meta bad sch-stale-error" data-test="sc-history-error">
          <span :title="state.error">{{ state.error }}</span>
          <button type="button" class="exit-btn" data-test="sc-history-retry" @click.stop="load">{{ t('changes.compare.retry', 'Retry') }}</button>
        </div>
        <template v-for="row in shownRows" :key="row.id">
          <button
            v-if="!row.vm"
            type="button"
            class="sch-row sch-outside"
            :class="{ 'sch-selected': selected === row.id }"
            :data-commit-id="row.id"
            :aria-expanded="expanded.has(row.id)"
            :aria-label="commitAria(row.item, expanded.has(row.id))"
            :title="t('changes.history.outsideHint', 'Not among the latest commits of this branch')"
            data-test="git-history-outside"
            @click="toggleCommit(row.item)"
          >
            <span class="sch-subject-wrap">
              <ChevronDown :size="12" class="sch-row-chev" :class="{ 'sc-rot': !expanded.has(row.id) }" />
              <span class="sch-hash">{{ row.item.displayId }}</span>
              <span class="sch-subject">{{ row.item.subject }}</span>
            </span>
          </button>
          <button
            v-else
            type="button"
            class="sch-row"
            :class="{ 'sch-selected': selected === row.id }"
            :data-commit-id="row.id"
            :aria-expanded="expanded.has(row.id)"
            :aria-label="commitAria(row.item, expanded.has(row.id))"
            data-test="git-history-row"
            @mouseenter="commitHover.onRowEnter(commitEntry(row.item), $event)"
            @mouseleave="commitHover.onRowLeave"
            @click="commitHover.hide(), toggleCommit(row.item)"
          >
            <svg aria-hidden="true" class="sch-graph" :width="row.geo.width" :height="row.geo.height" :viewBox="`0 0 ${row.geo.width} ${row.geo.height}`">
              <path v-for="p in row.geo.paths" :key="p.key" :d="p.d" fill="none" :stroke="graphColor(p.color)" stroke-linecap="round" stroke-width="1" />
              <template v-if="row.vm.kind === 'HEAD'">
                <circle :cx="row.geo.cx" :cy="row.geo.cy" :r="CIRCLE_RADIUS + 3" :fill="graphColor(row.geo.circleColor)" stroke="var(--surface)" :stroke-width="CIRCLE_STROKE_WIDTH" />
                <circle :cx="row.geo.cx" :cy="row.geo.cy" :r="CIRCLE_STROKE_WIDTH" fill="var(--surface)" />
              </template>
              <template v-else-if="row.geo.isMerge">
                <circle :cx="row.geo.cx" :cy="row.geo.cy" :r="CIRCLE_RADIUS + 1" :fill="graphColor(row.geo.circleColor)" />
                <circle :cx="row.geo.cx" :cy="row.geo.cy" :r="CIRCLE_RADIUS - 1.5" fill="var(--surface)" />
              </template>
              <circle v-else :cx="row.geo.cx" :cy="row.geo.cy" :r="CIRCLE_RADIUS" :fill="graphColor(row.geo.circleColor)" />
            </svg>
            <span class="sch-subject-wrap">
              <ChevronDown :size="12" class="sch-row-chev" :class="{ 'sc-rot': !expanded.has(row.id) }" />
              <span class="sch-subject">{{ row.item.subject }}</span>
            </span>
            <span v-if="row.refs.length" class="sch-refs">
              <span v-for="r in row.refs" :key="r.id" class="sch-ref" :style="refStyle(r)" :title="refLabel(r)">{{ r.name }}</span>
              <span v-if="row.hidden.length" class="sch-more" :title="row.hidden.map((r) => r.name).join(', ')">+{{ row.hidden.length }}</span>
            </span>
          </button>
          <div v-if="expanded.has(row.id)" class="sch-files" data-test="sc-history-files">
            <div v-if="meta(row.item)" class="sch-file-meta">{{ meta(row.item) }}</div>
            <template v-for="fs in [files[row.id] || { status: 'loading' }]" :key="'f'">
              <div v-if="fs.status === 'loading'" class="sch-file-meta sch-msg-inline">
                <RefreshCw :size="12" class="sc-spin" />
                <span>{{ t('changes.history.loadingFiles', 'Loading files…') }}</span>
              </div>
              <div v-else-if="fs.status === 'error'" class="sch-file-meta bad" :title="fs.error">{{ fs.error }}</div>
              <div v-else-if="!fs.entries.length" class="sch-file-meta">{{ t('changes.history.noFiles', 'No file changes in this commit') }}</div>
              <template v-else>
                <button
                  v-for="e in fs.entries"
                  :key="e.path"
                  type="button"
                  class="sch-file"
                  :title="e.path"
                  data-test="git-history-commit-file"
                  @click="openFile(row.item, e, false)"
                  @dblclick="openFile(row.item, e, true)"
                >
                  <FileIcon class="sc-file-icon" :name="e.path" />
                  <span class="sch-file-name">
                    <span class="sch-file-base">{{ baseName(e.path) }}</span>
                    <span v-if="dirOf(e.path)" class="sch-file-dir">{{ dirOf(e.path) }}</span>
                  </span>
                  <span class="sc-status" :style="{ color: STATUS_COLORS[e.status] }">{{ STATUS_LABELS[e.status] }}</span>
                </button>
              </template>
            </template>
          </div>
        </template>
      </div>
    </template>
    <TimelineHover
      v-if="commitHover.hover.entry && commitHover.hover.anchor"
      :entry="commitHover.hover.entry"
      :anchor="commitHover.hover.anchor"
      :info="commitHover.info()"
      @enter="commitHover.onCardEnter"
      @leave="commitHover.onRowLeave"
      @open="openHoveredCommit"
      @copy="copyCommitHash"
      @open-url="openCommitUrl"
    />
  </div>
</template>
