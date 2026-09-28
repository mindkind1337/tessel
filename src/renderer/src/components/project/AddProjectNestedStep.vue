<script setup>
// "Import repositories from folder" (Orca's AddRepoNestedImportStep,
// NestedRepoChecklist and NestedRepoScanLimitNotice, MIT, Copyright (c) 2026
// Lovecast Inc.): the repositories found in the chosen folder (live while the
// scan runs), which to import, and whether as one group or separately.
import { ref, computed, watch } from 'vue'
import { CircleHelp, CircleStop, GitBranch, LoaderCircle } from 'lucide-vue-next'
import { t } from '../../i18n'
import { baseName, foundSentence, scanLimitText } from '../../addProject'

const props = defineProps({
  scan: { type: Object, required: true },
  selected: { type: Array, required: true }, // selected repo paths
  groupName: { type: String, default: '' },
  scanning: { type: Boolean, default: false },
  busy: { type: Boolean, default: false }
})
const emit = defineEmits(['update:selected', 'update:groupName', 'import', 'open-folder', 'stop'])

const pending = ref(null) // 'group' | 'separate' | 'folder' while busy
watch(
  () => props.busy,
  (b) => {
    if (!b) pending.value = null
  }
)
const total = computed(() => props.scan.repos.length)
const count = computed(() => props.selected.length)
const allSelected = computed(() => total.value > 0 && count.value === total.value)
const mixed = computed(() => count.value > 0 && !allSelected.value)
const noneSelected = computed(() => count.value === 0)
const locked = computed(() => props.busy || props.scanning)
const folderName = computed(() => baseName(props.scan.selectedPath) || props.scan.selectedPath)
const limitsShown = computed(() => props.scanning || props.scan.truncated || props.scan.timedOut || props.scan.stopped)
const helpOpen = ref(false)

function toggleAll() {
  emit('update:selected', allSelected.value ? [] : props.scan.repos.map((r) => r.path))
}
function toggle(path, on) {
  const next = props.selected.filter((p) => p !== path)
  if (on) next.push(path)
  emit('update:selected', next)
}
function run(mode) {
  pending.value = mode
  if (mode === 'folder') emit('open-folder')
  else emit('import', mode)
}
function countText() {
  return t('project.nested.selectedCount', '{{selected}} of {{total}} selected', { selected: count.value, total: total.value })
}
function description() {
  const found = foundSentence(props.scan)
  return props.scanning ? t('project.nested.scanning', 'Scanning... {{found}}', { found }) : found
}
</script>

<template>
  <div class="apn">
    <header class="ap-head">
      <h2 id="ap-heading" class="ap-title">{{ t('project.nested.title', 'Import repositories from folder') }}</h2>
      <div class="apn-desc-row">
        <button
          v-if="scanning"
          type="button"
          class="apn-stop"
          :aria-label="t('project.nested.stopScan', 'Stop scan')"
          :title="t('project.nested.stopHint', 'Scanning repositories. Click to stop.')"
          data-test="nested-stop"
          @click="emit('stop')"
        >
          <LoaderCircle :size="14" class="apn-spin ap-spin" aria-hidden="true" />
          <CircleStop :size="14" class="apn-stop-icon" aria-hidden="true" />
        </button>
        <p class="ap-desc apn-desc" data-test="nested-desc">{{ description() }}</p>
      </div>
    </header>

    <div class="apn-list" data-test="nested-list">
      <label class="apn-all">
        <input
          type="checkbox"
          :checked="allSelected"
          :indeterminate.prop="mixed"
          :disabled="locked"
          :aria-label="allSelected ? t('project.nested.deselectAll', 'Deselect all') : t('project.nested.selectAll', 'Select all')"
          data-test="nested-all"
          @change="toggleAll"
        />
        <span class="apn-all-label">{{ allSelected ? t('project.nested.deselectAll', 'Deselect all') : t('project.nested.selectAll', 'Select all') }}</span>
        <span class="apn-all-count">{{ countText() }}</span>
      </label>
      <ul class="apn-rows">
        <li v-for="repo in scan.repos" :key="repo.path">
          <label class="apn-row" :title="repo.path">
            <input
              type="checkbox"
              :checked="selected.includes(repo.path)"
              :disabled="locked"
              data-test="nested-repo"
              @change="toggle(repo.path, $event.target.checked)"
            />
            <GitBranch :size="14" class="apn-branch" aria-hidden="true" />
            <span class="apn-name" :class="{ on: selected.includes(repo.path) }">{{ repo.displayName }}</span>
          </label>
        </li>
      </ul>
    </div>

    <div
      v-if="limitsShown"
      class="apn-limits"
      data-test="nested-limits"
      @pointerenter="helpOpen = true"
      @pointerleave="helpOpen = false"
    >
      <span>{{ scan.stopped ? t('project.nested.stopped', 'Scan stopped early.') : t('project.nested.partial', 'Showing partial scan results.') }}</span>
      <span class="apn-help-anchor">
        <button
          type="button"
          class="apn-help"
          :aria-label="t('project.nested.limitsAria', 'Nested repository scan limits')"
          :aria-expanded="helpOpen"
          :title="scanLimitText(scan)"
          @focus="helpOpen = true"
          @blur="helpOpen = false"
          @click.stop="helpOpen = true"
        >
          <CircleHelp :size="14" aria-hidden="true" />
        </button>
        <span v-if="helpOpen" class="apn-help-pop" role="tooltip">{{ scanLimitText(scan) }}</span>
      </span>
    </div>

    <div class="apn-group">
      <p class="apn-group-title">{{ t('project.nested.groupTitle', 'Group these repositories?') }}</p>
      <p class="apn-group-desc">
        {{
          t(
            'project.nested.groupDescription',
            'Choose this if these projects belong together — a monorepo, or just a set of related repos. Tessel will group them and let you work from the parent folder.'
          )
        }}
      </p>
    </div>
    <div class="apn-field">
      <label for="apn-group-name" class="ap-label">{{ t('project.nested.groupName', 'Group name') }}</label>
      <input
        id="apn-group-name"
        class="ap-input"
        :value="groupName"
        :placeholder="folderName"
        :disabled="locked"
        :aria-label="t('project.nested.groupName', 'Group name')"
        data-test="nested-group-name"
        @input="emit('update:groupName', $event.target.value)"
      />
    </div>
    <p v-if="noneSelected" class="apn-none">
      {{
        t(
          'project.nested.noneSelected',
          'No repositories are selected. Open the parent folder instead to use editor, terminal, and search without Git features.'
        )
      }}
    </p>
    <div class="apn-actions">
      <button v-if="noneSelected" type="button" class="ap-btn secondary" :disabled="locked" data-test="nested-folder" @click="run('folder')">
        <LoaderCircle v-if="busy && pending === 'folder'" :size="14" class="ap-spin" aria-hidden="true" />
        {{ t('project.nested.openAsFolder', 'Open as Folder') }}
      </button>
      <button type="button" class="ap-btn outline" :disabled="locked || noneSelected" data-test="nested-separate" @click="run('separate')">
        <LoaderCircle v-if="busy && pending === 'separate'" :size="14" class="ap-spin" aria-hidden="true" />
        {{ t('project.nested.separate', 'No, import separately') }}
      </button>
      <button type="button" class="ap-btn primary" :disabled="locked || noneSelected" data-test="nested-group" @click="run('group')">
        <LoaderCircle v-if="busy && pending === 'group'" :size="14" class="ap-spin" aria-hidden="true" />
        {{ t('project.nested.group', 'Yes, import as group') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.apn {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  min-width: 0;
}
.apn-desc-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.apn-desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.apn-stop {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.apn-stop .apn-stop-icon {
  display: none;
}
.apn-stop:hover,
.apn-stop:focus-visible {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
  outline: none;
}
.apn-stop:hover .apn-spin,
.apn-stop:focus-visible .apn-spin {
  display: none;
}
.apn-stop:hover .apn-stop-icon,
.apn-stop:focus-visible .apn-stop-icon {
  display: block;
}
.apn-spin {
  color: var(--orca-yellow, #eab308);
}
.apn-list {
  display: flex;
  flex-direction: column;
  max-height: 16rem;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface) 60%, transparent);
}
.apn-all {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--surface-3) 30%, transparent);
  cursor: pointer;
}
.apn-all:hover {
  background: color-mix(in srgb, var(--surface-3) 50%, transparent);
}
.apn-all-label {
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.apn-all-count {
  flex-shrink: 0;
  margin-left: auto;
  color: var(--text-dim);
  font-size: 11px;
}
.apn-rows {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-x: hidden;
  overflow-y: auto;
  list-style: none;
}
.apn-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 8px 12px;
  border-top: 1px solid var(--border-strong);
  cursor: pointer;
}
.apn-row:hover {
  background: var(--surface-3);
}
.apn input[type='checkbox'] {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--accent);
}
.apn-branch {
  flex-shrink: 0;
  color: var(--text-dim);
}
.apn-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.apn-name.on {
  color: var(--text-strong);
}
.apn-limits {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
  font-size: 11px;
}
.apn-help-anchor {
  position: relative;
  display: inline-flex;
}
.apn-help {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  cursor: help;
}
.apn-help:hover {
  color: var(--text-strong);
}
.apn-help-pop {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  z-index: 5;
  width: 260px;
  padding: 8px 12px;
  transform: translateX(-50%);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 12px;
  line-height: 1.6;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.apn-group-title {
  margin: 0;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}
.apn-group-desc,
.apn-none {
  margin: 4px 0 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.5;
}
.apn-none {
  margin: 0;
}
.apn-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.apn-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
</style>
