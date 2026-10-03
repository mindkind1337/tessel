<script setup>
// Clean up worktrees, from a project's menu or the command palette: its
// inactive or merged worktrees with their git evidence, the safe ones ticked,
// removed together after a confirmation, with progress and an error per
// worktree that failed (it stays listed, to try again). After Orca's
// WorkspaceCleanupDialog and its candidate rows and confirm step, MIT,
// Copyright (c) 2026 Lovecast Inc.
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { AlertTriangle, Check, GitBranch, Loader2, X } from 'lucide-vue-next'
import { t } from '../../i18n'
import { formatShortTimeAgo } from '../../sidebarModel'
import {
  cleanupRows,
  visibleRows,
  defaultSelection,
  toggleSelection,
  pruneSelection,
  removeRows,
  riskLabel,
  blockerLabel
} from '../../worktreeCleanup'

const props = defineProps({
  // The sidebar's project ({ id, name, cwd, panes, copies }).
  project: { type: Object, required: true },
  // The board's cards ([{ id, title, worktree, mergedAt }]).
  tasks: { type: Array, default: () => [] },
  // cwd -> the main process's scan ({ ok, root, defaultBranch, items } | { ok: false, error }).
  scan: { type: Function, required: true },
  // (row, { root, defaultBranch }) -> { ok, error }: closes its panes, then removes it.
  remove: { type: Function, required: true },
  now: { type: Number, default: () => Date.now() }
})
const emit = defineEmits(['close', 'removed'])

const phase = ref('scanning') // scanning | error | list | confirm | removing
const scanError = ref('')
const result = ref(null)
const showAll = ref(false)
const selection = ref(new Set())
const progress = ref({}) // key -> { state: 'removing' | 'done' | 'failed', error }
const removed = ref(new Set())
const summary = ref('')
const dialog = ref(null)
let previousFocus = null
let firstScan = true

const allRows = computed(() =>
  cleanupRows(result.value, { project: props.project, tasks: props.tasks, now: props.now }).filter((r) => !removed.value.has(r.key))
)
// A row that failed stays listed even if the filter would hide it.
const rows = computed(() => {
  const list = visibleRows(allRows.value, { showAll: showAll.value })
  const failed = allRows.value.filter((r) => progress.value[r.key]?.state === 'failed' && !list.includes(r))
  return [...list, ...failed]
})
const hiddenCount = computed(() => allRows.value.length - rows.value.length)
const selectedRows = computed(() => rows.value.filter((r) => selection.value.has(r.key)))
const riskySelected = computed(() => selectedRows.value.filter((r) => !r.safe))
const allSafe = computed(() => rows.value.filter((r) => r.safe))

function scanErrorText(error) {
  switch (error) {
    case 'remote':
      return t('cleanup.error.remote', 'Clean up worktrees works on projects on this computer only.')
    case 'not-repo':
      return t('cleanup.error.notRepo', 'The project folder is not a git repository.')
    case 'unknown-folder':
      return t('cleanup.error.unknownFolder', 'This folder is not an open project.')
    default:
      return t('cleanup.error.scan', 'Could not read the worktrees ({{error}}).', { error: error || t('cleanup.unknownError', 'Unknown error') })
  }
}

async function rescan() {
  if (!props.project.cwd) {
    scanError.value = scanErrorText('not-repo')
    phase.value = 'error'
    return
  }
  if (!result.value) phase.value = 'scanning'
  let res
  try {
    res = await props.scan(props.project.cwd)
  } catch (err) {
    res = { ok: false, error: err && err.message }
  }
  if (!res || !res.ok) {
    if (!result.value) {
      scanError.value = scanErrorText(res && res.error)
      phase.value = 'error'
    }
    return
  }
  // A row that failed and that git no longer lists (it unregistered the copy
  // but its folder stayed): kept, with its error, so it can be tried again
  // (review:remove deletes such a leftover folder).
  const prev = (result.value && result.value.items) || []
  const kept = prev.filter((i) => progress.value[i.path]?.state === 'failed' && !res.items.some((x) => x.path === i.path))
  result.value = kept.length ? { ...res, items: [...res.items, ...kept] } : res
  // Worktrees gone from git are gone from the list (and from what was removed).
  removed.value = new Set([...removed.value].filter((k) => result.value.items.some((i) => i.path === k)))
  if (firstScan) {
    firstScan = false
    selection.value = defaultSelection(visibleRows(allRows.value))
  } else selection.value = pruneSelection(selection.value, allRows.value)
  if (phase.value === 'scanning') phase.value = 'list'
}

function toggle(row) {
  if (phase.value !== 'list') return
  selection.value = toggleSelection(selection.value, row)
}
function selectSafe() {
  selection.value = new Set(allSafe.value.map((r) => r.key))
}
function selectNone() {
  selection.value = new Set()
}

async function runRemoval() {
  const list = selectedRows.value.slice()
  if (!list.length) return
  phase.value = 'removing'
  summary.value = ''
  const ctx = { root: result.value.root, defaultBranch: result.value.defaultBranch }
  const res = await removeRows(
    list,
    (row) => props.remove(row, ctx),
    (key, state, error) => {
      progress.value = { ...progress.value, [key]: { state, error: error || '' } }
    }
  )
  removed.value = new Set([...removed.value, ...res.done])
  if (res.done.length) emit('removed', res.done)
  // The failed ones stay ticked: Remove again tries them again.
  selection.value = new Set(res.failed.map((f) => f.key))
  summary.value = res.failed.length
    ? failedSummary(res.done.length, res.failed.length)
    : res.done.length === 1
      ? t('cleanup.summaryOne', 'Removed 1 worktree.')
      : t('cleanup.summary', 'Removed {{count}} worktrees.', { count: res.done.length })
  phase.value = 'list'
  rescan()
}

function failedSummary(done, failed) {
  if (!done)
    return failed === 1
      ? t('cleanup.summaryFailedOne', '1 could not be removed: see why below, then try again.')
      : t('cleanup.summaryFailedOnly', '{{count}} could not be removed: see why below, then try again.', { count: failed })
  return failed === 1
    ? t('cleanup.summaryFailedMixedOne', 'Removed {{done}}. 1 could not be removed: see why below, then try again.', { done })
    : t('cleanup.summaryFailed', 'Removed {{done}}. {{failed}} could not be removed: see why below, then try again.', { done, failed })
}

// The button that had the focus goes away with each step (confirm, removing):
// the focus comes back to the dialog, so Escape and Tab keep working there
// and nothing typed reaches the terminal behind it.
watch(phase, () =>
  nextTick(() => {
    const el = dialog.value
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
  })
)

function close() {
  if (phase.value === 'removing') return
  emit('close')
}
function onEscape() {
  if (phase.value === 'confirm') phase.value = 'list'
  else close()
}

function aheadBehind(row) {
  const parts = []
  if (row.ahead) parts.push(t('cleanup.ahead', '{{count}} ahead', { count: row.ahead }))
  if (row.behind) parts.push(t('cleanup.behind', '{{count}} behind', { count: row.behind }))
  return parts.join(' · ')
}
function ago(ts) {
  return ts ? t('cleanup.ago', '{{time}} ago', { time: formatShortTimeAgo(ts, props.now) }) : t('cleanup.never', 'never')
}
// Text with placeholders (a template cannot hold "{{x}}" inside its own {{ }}).
const L = {
  sub: (branch) => t('cleanup.sub', 'compared with {{branch}}', { branch }),
  confirm: (count) => t('cleanup.confirm', 'Remove {{count}} worktrees? Their folders and their branches are deleted.', { count }),
  removeN: (count) => t('cleanup.removeN', 'Remove {{count}} worktrees', { count }),
  removeNDots: (count) => t('cleanup.removeNDots', 'Remove {{count}} worktrees…', { count }),
  openChip: (row) =>
    row.agents ? t('cleanup.agentsChip', '{{count}} agents open', { count: row.agents }) : t('cleanup.panesChip', '{{count}} panes open', { count: row.panes }),
  lastCommit: (row) => t('cleanup.lastCommit', 'Last commit {{time}}: {{subject}}', { time: ago(row.lastCommitAt), subject: row.lastCommitSubject }),
  lastActivity: (row) => t('cleanup.lastActivity', 'Last activity {{time}}', { time: ago(row.activityAt) }),
  failed: (error) => t('cleanup.failed', 'Not removed: {{error}}', { error }),
  emptyHidden: (count) => t('cleanup.emptyHidden', '{{count}} active worktrees are hidden: Show active worktrees too lists them.', { count })
}
function stateOf(row) {
  return progress.value[row.key] || null
}

onMounted(() => {
  previousFocus = document.activeElement
  dialog.value?.focus()
  rescan()
})
onUnmounted(() => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <div class="help-backdrop wcl-backdrop" data-test="cleanup-dialog" @pointerdown.self="close">
    <div
      ref="dialog"
      class="help-card wcl-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wcl-title"
      tabindex="-1"
      @focusin.stop
      @keydown.escape.prevent.stop="onEscape"
    >
      <div class="hwt-head">
        <div class="hwt-head-text">
          <h2 id="wcl-title" class="hwt-title">{{ t('cleanup.title', 'Clean up worktrees') }}</h2>
          <p class="hwt-sub">
            <span>{{ project.name }}</span>
            <span v-if="result && result.defaultBranch">
              · {{ L.sub(result.defaultBranch) }}</span
            >
          </p>
        </div>
        <button type="button" class="hwt-close" :disabled="phase === 'removing'" :aria-label="t('cleanup.close', 'Close')" @click="close">
          <X :size="14" aria-hidden="true" />
        </button>
      </div>

      <div v-if="phase === 'scanning'" class="wcl-note" data-test="cleanup-scanning">
        <Loader2 :size="14" class="wcl-spin" aria-hidden="true" /> {{ t('cleanup.scanning', 'Reading the worktrees…') }}
      </div>
      <div v-else-if="phase === 'error'" class="wcl-note wcl-error" data-test="cleanup-error">{{ scanError }}</div>

      <template v-else-if="phase === 'confirm'">
        <p class="wcl-confirm-text" data-test="cleanup-confirm">
          {{
            selectedRows.length === 1
              ? t('cleanup.confirmOne', 'Remove 1 worktree? Its folder and its branch are deleted.')
              : L.confirm(selectedRows.length)
          }}
        </p>
        <div v-if="riskySelected.length" class="wcl-warn" data-test="cleanup-confirm-risky">
          <div class="wcl-warn-title">
            <AlertTriangle :size="14" aria-hidden="true" />
            {{ t('cleanup.confirmRisky', 'Work in these is lost for good:') }}
          </div>
          <ul>
            <li v-for="row in riskySelected" :key="row.key">
              <strong>{{ row.label }}</strong> — {{ row.risks.map((r) => riskLabel(r, row)).join(', ') }}
            </li>
          </ul>
        </div>
        <ul class="wcl-confirm-list">
          <li v-for="row in selectedRows" :key="row.key">{{ row.label }} <span class="hwt-path">{{ row.path }}</span></li>
        </ul>
        <div class="confirm-actions">
          <button type="button" class="confirm-btn" data-test="cleanup-back" @click="phase = 'list'">{{ t('cleanup.back', 'Back') }}</button>
          <button type="button" class="confirm-btn primary danger" data-test="cleanup-confirm-remove" @click="runRemoval">
            {{
              selectedRows.length === 1 ? t('cleanup.removeOne', 'Remove 1 worktree') : L.removeN(selectedRows.length)
            }}
          </button>
        </div>
      </template>

      <template v-else>
        <div v-if="summary" class="wcl-note" data-test="cleanup-summary">{{ summary }}</div>
        <div class="wcl-toolbar">
          <label class="wcl-showall">
            <input v-model="showAll" type="checkbox" data-test="cleanup-show-all" :disabled="phase === 'removing'" />
            {{ t('cleanup.showAll', 'Show active worktrees too') }}
          </label>
          <span class="wcl-spacer"></span>
          <button type="button" class="osb-link" :disabled="phase === 'removing'" data-test="cleanup-select-safe" @click="selectSafe">
            {{ t('cleanup.selectSafe', 'Select safe ones') }}
          </button>
          <button type="button" class="osb-link" :disabled="phase === 'removing'" data-test="cleanup-select-none" @click="selectNone">
            {{ t('cleanup.selectNone', 'Select none') }}
          </button>
        </div>

        <ul v-if="rows.length" class="hwt-list wcl-list">
          <li
            v-for="row in rows"
            :key="row.key"
            class="hwt-row wcl-row"
            :class="{ 'wcl-blocked': !row.removable, 'wcl-risky': row.removable && !row.safe }"
            data-test="cleanup-row"
          >
            <input
              type="checkbox"
              class="wcl-check"
              data-test="cleanup-check"
              :checked="selection.has(row.key)"
              :disabled="!row.removable || phase === 'removing'"
              :aria-label="t('cleanup.selectRow', 'Select {{name}}', { name: row.label })"
              @change="toggle(row)"
            />
            <div class="hwt-row-text">
              <div class="hwt-name"><GitBranch :size="12" aria-hidden="true" /> {{ row.label }}</div>
              <!-- Cut at the start: the folder name at the end tells the rows apart. -->
              <div class="hwt-path wcl-path" :title="row.path"><bdi>{{ row.path }}</bdi></div>
              <div class="wcl-chips">
                <span v-if="row.missing" class="wcl-chip">{{ t('cleanup.missing', 'Folder gone') }}</span>
                <span v-else-if="row.dirty === false" class="wcl-chip ok">{{ t('cleanup.clean', 'Clean') }}</span>
                <span v-else-if="row.dirty" class="wcl-chip bad">{{ t('cleanup.dirtyChip', 'Dirty') }}</span>
                <span v-if="row.merged === true" class="wcl-chip ok">{{ t('cleanup.merged', 'Merged') }}</span>
                <span v-else-if="row.merged === false" class="wcl-chip bad">{{ t('cleanup.notMerged', 'Not merged') }}</span>
                <span v-if="aheadBehind(row)" class="wcl-chip">{{ aheadBehind(row) }}</span>
                <span v-if="row.panes" class="wcl-chip">{{
                  L.openChip(row)
                }}</span>
              </div>
              <div class="wcl-meta">
                <span v-if="row.lastCommitAt" :title="row.lastCommitSubject">{{
                  L.lastCommit(row)
                }}</span>
                <span>{{ L.lastActivity(row) }}</span>
              </div>
              <div v-if="row.blocker" class="wcl-reason" data-test="cleanup-blocker">{{ blockerLabel(row.blocker) }}</div>
              <div v-else-if="row.risks.length" class="wcl-reason wcl-risk" data-test="cleanup-risk">
                <AlertTriangle :size="12" aria-hidden="true" /> {{ row.risks.map((r) => riskLabel(r, row)).join(' · ') }}
              </div>
              <div v-if="stateOf(row)?.state === 'failed'" class="wcl-reason wcl-error" data-test="cleanup-row-error">
                {{ L.failed(stateOf(row).error) }}
              </div>
            </div>
            <span v-if="stateOf(row)?.state === 'removing'" class="wcl-state" data-test="cleanup-row-removing">
              <Loader2 :size="13" class="wcl-spin" aria-hidden="true" /> {{ t('cleanup.removing', 'Removing…') }}
            </span>
            <span v-else-if="stateOf(row)?.state === 'done'" class="wcl-state ok"><Check :size="13" aria-hidden="true" /></span>
          </li>
        </ul>
        <div v-else class="hwt-empty" data-test="cleanup-empty">
          <div>
            <div class="hwt-empty-title">{{ t('cleanup.empty', 'Nothing to clean up') }}</div>
            <div class="hwt-empty-sub">
              {{
                hiddenCount
                  ? L.emptyHidden(hiddenCount)
                  : t('cleanup.emptyNone', 'This project has no other worktrees.')
              }}
            </div>
          </div>
        </div>

        <div class="confirm-actions">
          <button type="button" class="confirm-btn" :disabled="phase === 'removing'" @click="close">{{ t('cleanup.close', 'Close') }}</button>
          <button
            type="button"
            class="confirm-btn primary danger"
            data-test="cleanup-remove"
            :disabled="!selectedRows.length || phase === 'removing'"
            @click="phase = 'confirm'"
          >
            {{
              phase === 'removing'
                ? t('cleanup.removing', 'Removing…')
                : !selectedRows.length
                  ? t('cleanup.removeNone', 'Remove worktrees…')
                  : selectedRows.length === 1
                    ? t('cleanup.removeOneDots', 'Remove 1 worktree…')
                    : L.removeNDots(selectedRows.length)
            }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
