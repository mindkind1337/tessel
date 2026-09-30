<script setup>
// Browse the folders of an SSH host and pick one, like Orca's
// RemoteFileBrowser (MIT, Copyright (c) 2026 Lovecast Inc.:
// components/sidebar/RemoteFileBrowser.tsx, RemoteFileBrowserBreadcrumbs.tsx,
// RemoteFileBrowserEntryList.tsx, remote-file-browser-helpers.ts).
// Up, home, a breadcrumb; a field that filters the list or, with a slash,
// takes a path (Enter goes there); folders and files (files shown, not
// choosable); "Select folder" picks the folder shown, a double-click the
// folder clicked. The listing comes from the host's signed-in session
// (window.shellApi.remoteFs.browse; src/main/remoteFs.js).
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ArrowUp, ChevronRight, Folder, Home, LoaderCircle, Search } from 'lucide-vue-next'
import { t } from '../../i18n'
import { getFileTypeIcon } from '../../fileTypeIcons'
import { joinRemote, parentRemote, remoteCrumbs, isPathInput, resolveTypedPath, filterRemoteEntries, enterAction } from '../../addProject'

const props = defineProps({
  hostId: { type: String, required: true },
  initialPath: { type: String, default: '~' },
  // What choosing does: 'project' (open it), 'clone' / 'create' (the parent folder).
  purpose: { type: String, default: 'project' }
})
const emit = defineEmits(['select', 'cancel'])

const FILE_HINT_MS = 2000
const CLICK_MS = 220

const path = ref('')
const entries = ref([])
const truncated = ref(false)
const loading = ref(true)
const error = ref('')
const failedPath = ref('')
const filter = ref('')
const fileHint = ref(false)
const inputEl = ref(null)
let gen = 0
let hintTimer = null
let clickTimer = null

const api = () => (window.shellApi && window.shellApi.remoteFs) || null
const pathMode = computed(() => isPathInput(filter.value))
const shown = computed(() => (pathMode.value ? entries.value : filterRemoteEntries(entries.value, filter.value)))
const crumbs = computed(() => remoteCrumbs(path.value))
const selectDisabled = computed(() => loading.value || !!error.value || !path.value)

async function load(dir) {
  const my = ++gen
  const a = api()
  loading.value = true
  error.value = ''
  failedPath.value = dir
  let res
  try {
    res = a && a.browse ? await a.browse(props.hostId, dir) : { ok: false, error: t('project.error.generic', 'Something went wrong.') }
  } catch (err) {
    res = { ok: false, error: (err && err.message) || t('project.error.generic', 'Something went wrong.') }
  }
  if (my !== gen) return
  loading.value = false
  if (res && res.ok) {
    path.value = res.path
    entries.value = Array.isArray(res.entries) ? res.entries : []
    truncated.value = !!res.truncated
    failedPath.value = ''
  } else {
    entries.value = []
    truncated.value = false
    if (res && res.path) path.value = res.path
    error.value = (res && res.error) || t('project.error.generic', 'Something went wrong.')
  }
}

function clearHint() {
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = null
  fileHint.value = false
}
function showFileHint() {
  clearHint()
  fileHint.value = true
  hintTimer = setTimeout(() => {
    fileHint.value = false
    hintTimer = null
  }, FILE_HINT_MS)
}

function navigate(dir) {
  filter.value = ''
  clearHint()
  load(dir)
  nextTick(() => inputEl.value && inputEl.value.focus())
}
function goUp() {
  if (path.value && path.value !== '/') navigate(parentRemote(path.value))
}
function retry() {
  load(failedPath.value || path.value || props.initialPath || '~')
}

function onRowClick(entry) {
  if (clickTimer) clearTimeout(clickTimer)
  clickTimer = setTimeout(() => {
    clickTimer = null
    if (entry.dir) navigate(joinRemote(path.value, entry.name))
    else showFileHint()
  }, CLICK_MS)
}
function onRowDoubleClick(entry) {
  if (!entry.dir || loading.value) return
  if (clickTimer) clearTimeout(clickTimer)
  clickTimer = null
  emit('select', joinRemote(path.value, entry.name))
}
function choose() {
  if (!selectDisabled.value) emit('select', path.value)
}

function onFilterKey(e) {
  if (e.isComposing) return
  if (e.key === 'Enter') {
    e.preventDefault()
    if (pathMode.value) {
      const target = resolveTypedPath(filter.value, path.value)
      if (target) navigate(target)
      else error.value = t('project.remoteBrowser.badPath', 'This path has characters that cannot be used.')
      return
    }
    const action = enterAction(shown.value)
    if (action.type === 'navigate') navigate(joinRemote(path.value, action.name))
    else if (action.type === 'fileHint') showFileHint()
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    if (filter.value) {
      filter.value = ''
      clearHint()
    } else emit('cancel')
    return
  }
  if (e.key === 'Backspace' && filter.value === '' && path.value && path.value !== '/') {
    e.preventDefault()
    goUp()
  }
}

function enterToGoText() {
  return t('project.remoteBrowser.enterToGo', 'Press Enter to go to {{path}}', { path: filter.value.trim() })
}
function noMatchesText() {
  return t('project.remoteBrowser.noMatches', "No matches for '{{filter}}'", { filter: filter.value.trim() })
}
function footerText() {
  const vars = { path: path.value }
  if (props.purpose === 'clone') return t('project.remoteBrowser.footerClone', 'Clones into this folder on this host · {{path}}', vars)
  if (props.purpose === 'create') return t('project.remoteBrowser.footerCreate', 'Creates the project in this folder on this host · {{path}}', vars)
  return t('project.remoteBrowser.footer', 'Opens as a project on this host · {{path}}', vars)
}

onMounted(() => load(props.initialPath || '~'))
onBeforeUnmount(() => {
  gen++
  clearHint()
  if (clickTimer) clearTimeout(clickTimer)
})
</script>

<template>
  <div class="rfb" data-test="remote-browser">
    <div class="rfb-bar">
      <button
        type="button"
        class="rfb-tool"
        :disabled="loading || !path || path === '/'"
        :title="t('project.remoteBrowser.up', 'Parent folder')"
        :aria-label="t('project.remoteBrowser.up', 'Parent folder')"
        data-test="rfb-up"
        @click="goUp"
      >
        <ArrowUp :size="14" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="rfb-tool"
        :disabled="loading"
        :title="t('project.remoteBrowser.home', 'Home folder')"
        :aria-label="t('project.remoteBrowser.home', 'Home folder')"
        data-test="rfb-home"
        @click="navigate('~')"
      >
        <Home :size="14" aria-hidden="true" />
      </button>
      <nav class="rfb-crumbs" :aria-label="t('project.remoteBrowser.path', 'Path')">
        <button type="button" class="rfb-crumb" :class="{ current: crumbs.length === 0 }" data-test="rfb-root" @click="navigate('/')">/</button>
        <template v-for="(c, i) in crumbs" :key="c.path">
          <ChevronRight :size="10" class="rfb-sep" aria-hidden="true" />
          <button type="button" class="rfb-crumb" :class="{ current: i === crumbs.length - 1 }" :title="c.path" @click="navigate(c.path)">{{ c.name }}</button>
        </template>
      </nav>
    </div>

    <div class="rfb-search">
      <Search :size="14" class="rfb-search-icon" aria-hidden="true" />
      <input
        ref="inputEl"
        v-model="filter"
        type="text"
        class="rfb-input"
        :placeholder="t('project.remoteBrowser.filterPlaceholder', 'Type to filter or enter a path…')"
        spellcheck="false"
        autocomplete="off"
        autofocus
        data-test="rfb-filter"
        @input="clearHint"
        @keydown="onFilterKey"
      />
    </div>
    <p v-if="pathMode && filter.trim()" class="rfb-note" data-test="rfb-path-hint">
      {{ enterToGoText() }}
    </p>

    <div class="rfb-list-box">
      <div class="rfb-list" role="listbox" :aria-busy="loading" data-test="rfb-list">
        <div v-if="loading" class="rfb-center"><LoaderCircle :size="20" class="rfb-spin" aria-hidden="true" /></div>
        <div v-else-if="error" class="rfb-center column" role="alert">
          <p class="rfb-error" data-test="rfb-error">{{ error }}</p>
          <button type="button" class="ap-btn outline small" data-test="rfb-retry" @click="retry">{{ t('project.remoteBrowser.retry', 'Retry') }}</button>
        </div>
        <div v-else-if="!entries.length" class="rfb-center">
          <p class="rfb-muted">{{ t('project.remoteBrowser.empty', 'Empty folder') }}</p>
        </div>
        <div v-else-if="!shown.length" class="rfb-center">
          <p class="rfb-muted">{{ noMatchesText() }}</p>
        </div>
        <template v-else>
          <button
            v-for="entry in shown"
            :key="entry.name"
            type="button"
            role="option"
            class="rfb-row"
            :class="{ file: !entry.dir }"
            :aria-disabled="!entry.dir"
            :title="entry.dir ? entry.name : t('project.remoteBrowser.fileHint', 'Files cannot be opened as a project')"
            :data-test="(entry.dir ? 'rfb-dir-' : 'rfb-file-') + entry.name"
            @mousedown.prevent="inputEl && inputEl.focus()"
            @click="onRowClick(entry)"
            @dblclick="onRowDoubleClick(entry)"
          >
            <Folder v-if="entry.dir" :size="14" class="rfb-icon" aria-hidden="true" />
            <component :is="getFileTypeIcon(entry.name)" v-else :size="14" class="rfb-icon dim" aria-hidden="true" />
            <span class="rfb-name">{{ entry.name }}</span>
            <ChevronRight v-if="entry.dir" :size="14" class="rfb-icon dim" aria-hidden="true" />
          </button>
          <p v-if="truncated" class="rfb-note pad">{{ t('project.remoteBrowser.truncated', 'Only the first entries are shown. Type a path to go further.') }}</p>
        </template>
      </div>
    </div>

    <p class="rfb-footer" :title="fileHint ? undefined : path" data-test="rfb-footer">
      {{ fileHint ? t('project.remoteBrowser.fileHint', 'Files cannot be opened as a project') : footerText() }}
    </p>
    <div class="rfb-actions">
      <button type="button" class="ap-btn outline small" data-test="rfb-cancel" @click="emit('cancel')">{{ t('project.remoteBrowser.cancel', 'Cancel') }}</button>
      <button type="button" class="ap-btn primary small" :disabled="selectDisabled" :title="path" data-test="rfb-select" @click="choose">
        {{ t('project.remoteBrowser.select', 'Select folder') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.rfb {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  width: 100%;
}
.rfb-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 28px;
  overflow-x: auto;
  scrollbar-width: none;
}
.rfb-tool {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  padding: 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.rfb-tool:hover:not(:disabled) {
  background: var(--surface-3);
}
.rfb-tool:disabled {
  opacity: 0.3;
  cursor: default;
}
.rfb-crumbs {
  display: flex;
  align-items: center;
  min-width: 0;
  margin-left: 4px;
  color: var(--text-dim);
  font-size: 11px;
}
.rfb-crumb {
  flex-shrink: 0;
  max-width: 120px;
  padding: 0 2px;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.rfb-crumb:hover {
  color: var(--text-strong);
}
.rfb-crumb.current {
  color: var(--text-strong);
  font-weight: 600;
}
.rfb-sep {
  flex-shrink: 0;
  opacity: 0.5;
}
.rfb-search {
  position: relative;
}
.rfb-search-icon {
  position: absolute;
  top: 50%;
  left: 8px;
  color: var(--text-dim);
  transform: translateY(-50%);
  pointer-events: none;
}
.rfb-input {
  width: 100%;
  height: 28px;
  box-sizing: border-box;
  padding: 0 8px 0 28px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--bg, var(--surface));
  color: var(--text-strong);
  font: inherit;
  font-size: 12px;
}
.rfb-input:focus {
  outline: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
}
.rfb-list-box {
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--bg, var(--surface));
}
.rfb-list {
  height: 240px;
  overflow-y: auto;
}
.rfb-center {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 0 16px;
}
.rfb-center.column {
  flex-direction: column;
  gap: 8px;
}
.rfb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: 0;
  background: transparent;
  color: var(--text-strong);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.rfb-row:hover,
.rfb-row:focus-visible {
  background: color-mix(in srgb, var(--surface-3) 60%, transparent);
  outline: none;
}
.rfb-row.file {
  color: var(--text);
  cursor: default;
}
.rfb-icon {
  flex-shrink: 0;
  color: var(--text-dim);
}
.rfb-icon.dim {
  opacity: 0.6;
}
.rfb-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rfb-muted {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
}
.rfb-error {
  margin: 0;
  color: var(--danger, #f87171);
  font-size: 12px;
  text-align: center;
}
.rfb-note {
  margin: -4px 0 0;
  color: var(--text-dim);
  font-size: 11px;
}
.rfb-note.pad {
  margin: 0;
  padding: 6px 12px;
}
.rfb-footer {
  margin: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rfb-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.rfb-spin {
  color: var(--text-dim);
  animation: rfb-spin 1s linear infinite;
}
@keyframes rfb-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
