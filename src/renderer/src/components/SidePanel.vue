<!-- i18n-pending: text here does not go through t() yet -->
<script setup>
// The right side panel (after Orca's): one panel, a tab bar at its top —
// Files (the explorer), Changes (source control), Tasks (the task board).
// A tab is created the first time it is shown, then kept (its folders,
// search and scroll stay as they were) while the panel is open.
import { reactive, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import ExplorerPanel from './ExplorerPanel.vue'
import { refreshStatus, statusOf, changeCount, rootKey } from '../scmState'
import ChangesPanel from './ChangesPanel.vue'
import TaskBoard from './TaskBoard.vue'

const SIDE_TABS = ['files', 'changes', 'tasks']

const props = defineProps({
  tab: { type: String, default: 'tasks' },
  root: { type: String, default: null },
  canInsert: { type: Boolean, default: false },
  agentPanes: { type: Array, default: () => [] },
  workspaceId: { type: String, default: null }
})
const emit = defineEmits([
  'update:tab',
  'close',
  'open',
  'open-editor',
  'open-external',
  'terminal-here',
  'insert-path',
  'toast',
  'new-task',
  'focus-pane',
  'review',
  'open-diff',
  'create-pr'
])

const TABS = [
  { id: 'files', label: 'Files', shortcut: 'Ctrl+Shift+X' },
  { id: 'changes', label: 'Changes', shortcut: 'Ctrl+Shift+G' },
  { id: 'tasks', label: 'Tasks', shortcut: 'Ctrl+Shift+K' }
]
const shown = reactive({})
watch(
  () => props.tab,
  (t) => {
    if (SIDE_TABS.includes(t)) shown[t] = true
  },
  { immediate: true }
)
const current = () => (SIDE_TABS.includes(props.tab) ? props.tab : 'tasks')

// The count on the Changes tab (like a source control badge): the project's
// changed files, read again as its files change.
const changes = computed(() => {
  const s = statusOf(props.root)
  return s && s.data ? changeCount(s.data) : 0
})
const badge = computed(() => (changes.value > 99 ? '99+' : String(changes.value)))
const explorer = () => window.shellApi && window.shellApi.explorer
let stop = null
let timer = 0
function reload() {
  if (props.root && window.shellApi && window.shellApi.scm) refreshStatus(props.root)
}
watch(
  () => props.root,
  (r) => {
    if (r && explorer()) explorer().watch(r)
    reload()
  }
)
onMounted(() => {
  if (props.root && explorer()) explorer().watch(props.root)
  reload()
  if (explorer() && explorer().onChanged)
    stop = explorer().onChanged((r) => {
      if (!props.root || rootKey(r) !== rootKey(props.root)) return
      clearTimeout(timer)
      timer = setTimeout(reload, 250)
    })
})
onBeforeUnmount(() => {
  if (stop) stop()
  clearTimeout(timer)
  if (explorer()) explorer().unwatch()
})
</script>

<template>
  <div class="side-panel">
    <div class="side-tabs" role="tablist" aria-label="Side panel">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="side-tab"
        :class="{ on: current() === t.id }"
        role="tab"
        :aria-selected="current() === t.id"
        :title="t.label + (t.shortcut ? ` (${t.shortcut})` : '')"
        :aria-label="t.label"
        :data-test="'side-tab-' + t.id"
        @click="emit('update:tab', t.id)"
      >
        <svg v-if="t.id === 'files'" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 1.8h5l3 3v9.4H4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          <path d="M9 1.8v3h3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
        </svg>
        <svg v-else-if="t.id === 'changes'" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3" />
          <circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.3" />
          <circle cx="11.5" cy="5.5" r="1.6" stroke="currentColor" stroke-width="1.3" />
          <path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-2.2 3.2-5.6 4.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.3" />
          <path d="M5 6.2l1.3 1.3L8.6 5.2M5 10.3h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        <span class="side-tab-label">{{ t.label }}</span>
        <span
          v-if="t.id === 'changes' && changes > 0"
          class="side-tab-badge"
          :title="`${changes} changed file${changes === 1 ? '' : 's'}`"
          data-test="changes-badge"
          >{{ badge }}</span
        >
      </button>
      <span class="side-tabs-fill"></span>
      <button class="tb-icon side-close" title="Close the panel" aria-label="Close the side panel" data-test="side-close" @click="emit('close')">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
      </button>
    </div>
    <div class="side-body">
      <ExplorerPanel
        v-if="shown.files"
        v-show="current() === 'files'"
        :root="root"
        :can-insert="canInsert"
        @open="(file, arg) => emit('open', file, arg)"
        @open-editor="(file) => emit('open-editor', file)"
        @open-external="(file) => emit('open-external', file)"
        @terminal-here="(dir) => emit('terminal-here', dir)"
        @insert-path="(text) => emit('insert-path', text)"
        @toast="(t) => emit('toast', t)"
        @close="emit('close')"
      />
      <ChangesPanel
        v-if="shown.changes"
        v-show="current() === 'changes'"
        :root="root"
        :workspace-id="workspaceId"
        @open="(file) => emit('open', file)"
        @open-diff="(req) => emit('open-diff', req)"
        @create-pr="(q) => emit('create-pr', q)"
        @toast="(t) => emit('toast', t)"
        @review="(id) => emit('review', id)"
      />
      <TaskBoard
        v-if="shown.tasks"
        v-show="current() === 'tasks'"
        :agent-panes="agentPanes"
        :workspace-id="workspaceId"
        @new-task="emit('new-task')"
        @focus-pane="(id) => emit('focus-pane', id)"
        @review="(id) => emit('review', id)"
      />
    </div>
  </div>
</template>
