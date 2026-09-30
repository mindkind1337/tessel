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
import RemoteBadge from './project/RemoteBadge.vue'
import { t } from '../i18n'
import { Files, GitBranch, ListChecks } from 'lucide-vue-next'

const SIDE_TABS = ['files', 'changes', 'tasks']

const props = defineProps({
  tab: { type: String, default: 'tasks' },
  root: { type: String, default: null },
  canInsert: { type: Boolean, default: false },
  agentPanes: { type: Array, default: () => [] },
  workspaceId: { type: String, default: null },
  // A project on a remote host: { hostId, host, path }. Its root is then an
  // ssh://… path: Files and Changes read it over SSH (src/main/remoteFs.js),
  // under a small badge naming the host.
  remote: { type: Object, default: null }
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

// Labels are translated where shown (the language can change while open).
// Icon tabs like Orca's top activity bar (right-sidebar-top-activity-bar.tsx,
// activity-bar-buttons.tsx): Files, Source Control (git branch), Tasks; the
// name is in the tooltip.
const TABS = [
  { id: 'files', key: 'explorer.side.files', label: 'Files', shortcut: 'Ctrl+Shift+X', icon: Files },
  { id: 'changes', key: 'explorer.side.changes', label: 'Changes', shortcut: 'Ctrl+Shift+G', icon: GitBranch },
  { id: 'tasks', key: 'explorer.side.tasks', label: 'Tasks', shortcut: 'Ctrl+Shift+K', icon: ListChecks }
]
const tabLabel = (tab) => t(tab.key, tab.label)
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
    <div class="side-tabs" role="tablist" :aria-label="t('explorer.side.panel', 'Side panel')">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        class="side-tab"
        :class="{ on: current() === tab.id }"
        role="tab"
        :aria-selected="current() === tab.id"
        :title="tabLabel(tab) + (tab.shortcut ? ` (${tab.shortcut})` : '')"
        :aria-label="tabLabel(tab)"
        :data-test="'side-tab-' + tab.id"
        @click="emit('update:tab', tab.id)"
      >
        <component :is="tab.icon" :size="16" aria-hidden="true" />
        <span
          v-if="tab.id === 'changes' && changes > 0"
          class="side-tab-badge"
          :title="
            changes === 1
              ? t('explorer.side.changedFiles', '{{count}} changed file', { count: changes })
              : t('explorer.side.changedFiles', '{{count}} changed files', { count: changes })
          "
          data-test="changes-badge"
          >{{ badge }}</span
        >
      </button>
      <span class="side-tabs-fill"></span>
    </div>
    <div class="side-body">
      <RemoteBadge
        v-if="remote && (current() === 'files' || current() === 'changes')"
        :host-id="remote.hostId"
        :host="remote.host"
        :path="remote.path"
      />
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
