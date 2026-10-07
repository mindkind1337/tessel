<script setup>
// The Commits section at the bottom of Source Control, ported from Orca's
// right-sidebar/source-control/sync/git-history-panel.tsx, git-history-row.tsx,
// git-history-graph-svg.tsx and git-history-commit-files.tsx (MIT, Copyright
// (c) 2026 Lovecast Inc.), written for Vue. The last commits of HEAD with
// Orca's graph and ref pills; a click shows the files of a commit, a click on
// a file opens its diff in the editor.
import { ref, computed, watch, onBeforeUnmount } from 'vue'
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
import { getFileTypeIcon } from '../fileTypeIcons'
import { t, intlLocale } from '../i18n'
import { dateTimeFormat } from '../../../shared/intlCache'
import PanelState from './ui/PanelState.vue'

const props = defineProps({
  // The repository folder (the project or a task's copy).
  root: { type: String, default: null },
  // The compare base ('origin/main'): its commit gets Orca's base colour.
  base: { type: String, default: null },
  // Changes when HEAD moves (a commit, a pull): the list is read again.
  head: { type: String, default: null }
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
    return { vm, geo: gitHistoryGraphGeometry(vm), refs: refs.slice(0, 2), hidden: refs.slice(2) }
  })
)

function toggle() {
  collapsed.value = !collapsed.value
}
function onRefresh() {
  if (collapsed.value) return toggle()
  load()
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
onBeforeUnmount(() => {
  seq++
  stopResize()
})
defineExpose({ load })
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
      <div v-else class="sch-body" :style="bodyStyle" data-test="sc-history-list">
        <div v-if="state.status === 'error'" class="sch-file-meta bad sch-stale-error" data-test="sc-history-error">
          <span :title="state.error">{{ state.error }}</span>
          <button type="button" class="exit-btn" data-test="sc-history-retry" @click.stop="load">{{ t('changes.compare.retry', 'Retry') }}</button>
        </div>
        <template v-for="row in rows" :key="row.vm.historyItem.id">
          <button
            type="button"
            class="sch-row"
            :aria-expanded="expanded.has(row.vm.historyItem.id)"
            :aria-label="commitAria(row.vm.historyItem, expanded.has(row.vm.historyItem.id))"
            :title="row.vm.historyItem.message || row.vm.historyItem.subject"
            data-test="git-history-row"
            @click="toggleCommit(row.vm.historyItem)"
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
              <ChevronDown :size="12" class="sch-row-chev" :class="{ 'sc-rot': !expanded.has(row.vm.historyItem.id) }" />
              <span class="sch-subject">{{ row.vm.historyItem.subject }}</span>
            </span>
            <span v-if="row.refs.length" class="sch-refs">
              <span v-for="r in row.refs" :key="r.id" class="sch-ref" :style="refStyle(r)" :title="refLabel(r)">{{ r.name }}</span>
              <span v-if="row.hidden.length" class="sch-more" :title="row.hidden.map((r) => r.name).join(', ')">+{{ row.hidden.length }}</span>
            </span>
          </button>
          <div v-if="expanded.has(row.vm.historyItem.id)" class="sch-files" data-test="sc-history-files">
            <div v-if="meta(row.vm.historyItem)" class="sch-file-meta">{{ meta(row.vm.historyItem) }}</div>
            <template v-for="fs in [files[row.vm.historyItem.id] || { status: 'loading' }]" :key="'f'">
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
                  @click="openFile(row.vm.historyItem, e, false)"
                  @dblclick="openFile(row.vm.historyItem, e, true)"
                >
                  <component :is="getFileTypeIcon(e.path)" :size="14" class="sc-file-icon" :style="{ color: STATUS_COLORS[e.status] }" />
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
  </div>
</template>
