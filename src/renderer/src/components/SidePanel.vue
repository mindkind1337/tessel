<script setup>
// The right side panel (after Orca's): one panel, a tab bar at its top —
// Dashboard (every agent of every project), Files (the explorer), Changes
// (source control), Tasks (the task board), Task history (finished tasks,
// their time and cost), Agents (the agent session history), then the web pages opened with + (SideBrowser.vue, one tab each,
// x or a middle-click closes one). At the right end of the bar: + (a new web
// page) and Fullscreen (the panel over the whole workspace; Esc restores it).
// A tab is created the first time it is shown, then kept (its folders,
// search and scroll stay as they were) while the panel is open.
import { reactive, ref, watch, computed, provide, onMounted, onBeforeUnmount } from 'vue'
import ExplorerPanel from './ExplorerPanel.vue'
import { refreshStatus, statusOf, changeCount, rootKey } from '../scmState'
import ChangesPanel from './ChangesPanel.vue'
import TaskBoard from './TaskBoard.vue'
import SessionHistoryPanel from './SessionHistoryPanel.vue'
import AgentDashboard from './AgentDashboard.vue'
import SideBrowser from './SideBrowser.vue'
import AgentSessionHistoryIcon from './AgentSessionHistoryIcon.vue'
import RemoteBadge from './project/RemoteBadge.vue'
import { remoteHostsState } from '../remoteHosts'
import { t } from '../i18n'
import { displayUrl } from '../../../shared/browserUrl'
import TaskHistoryPanel from './TaskHistoryPanel.vue'
import { SIDE_TABS } from '../sideTabs'
import { Files, GitBranch, ListChecks, LayoutDashboard, Maximize2, Minimize2, Plus, Globe, X, ReceiptText } from 'lucide-vue-next'

const props = defineProps({
  tab: { type: String, default: 'tasks' },
  root: { type: String, default: null },
  canInsert: { type: Boolean, default: false },
  agentPanes: { type: Array, default: () => [] },
  workspaceId: { type: String, default: null },
  // sessionId -> paneId: the past conversations open in a pane (Agents tab).
  openSessionIds: { type: Object, default: () => ({}) },
  // A project on a remote host: { hostId, host, path }. Its root is then an
  // ssh://… path: Files and Changes read it over SSH (src/main/remoteFs.js),
  // under a small badge naming the host.
  remote: { type: Object, default: null },
  // The Dashboard tab: App's sidebarProjects (every project, its panes) and
  // its clock (the "Working 4m" times).
  projects: { type: Array, default: () => [] },
  now: { type: Number, default: () => Date.now() },
  // The panel over the whole workspace (App keeps it, not saved).
  fullscreen: { type: Boolean, default: false },
  // The web pages opened with +: [{ id, url, title }] (App keeps and saves
  // them; a page's tab id is its id).
  browsers: { type: Array, default: () => [] }
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
  'create-pr',
  // A past conversation to reopen in a new pane: { agent, id, cwd, accountId }.
  'resume-session',
  // Dashboard: put these idle agents to sleep (App's sleepPanes).
  'sleep',
  'update:fullscreen',
  'update:browsers'
])

// Labels are translated where shown (the language can change while open).
// Icon tabs like Orca's top activity bar (right-sidebar-top-activity-bar.tsx,
// activity-bar-buttons.tsx): Files, Source Control (git branch), Tasks; the
// name is in the tooltip.
const TABS = [
  { id: 'dashboard', key: 'agentDashboard.tab', label: 'Dashboard', shortcut: '', icon: LayoutDashboard },
  { id: 'files', key: 'explorer.side.files', label: 'Files', shortcut: 'Ctrl+Shift+X', icon: Files },
  { id: 'changes', key: 'explorer.side.changes', label: 'Changes', shortcut: 'Ctrl+Shift+G', icon: GitBranch },
  { id: 'tasks', key: 'explorer.side.tasks', label: 'Tasks', shortcut: 'Ctrl+Shift+K', icon: ListChecks },
  { id: 'taskHistory', key: 'taskHistory.tab', label: 'Task history — time and cost', shortcut: '', icon: ReceiptText }, // i18n-ignore
  { id: 'history', key: 'explorer.side.history', label: 'Agent Session History', shortcut: '', icon: AgentSessionHistoryIcon } // i18n-ignore
]
const tabLabel = (tab) => t(tab.key, tab.label)
const isBrowser = (id) => props.browsers.some((b) => b.id === id)
const isTab = (id) => SIDE_TABS.includes(id) || isBrowser(id)
const shown = reactive({})
// The tabs shown before this one, latest last: closing a page goes back to
// the latest one still there.
const visited = []
watch(
  () => props.tab,
  (t, before) => {
    if (isTab(t)) shown[t] = true
    if (before && before !== t) {
      visited.push(before)
      if (visited.length > 20) visited.shift()
    }
  },
  { immediate: true }
)
const current = () => (isTab(props.tab) ? props.tab : 'tasks')

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
// A remote project whose host was not connected (Files / Changes refused,
// the badge offers Connect): once it is (Connect, or a terminal signed in on
// the host), Files and Changes read it again from scratch.
const remoteRev = ref(0)
watch(
  () => !!(props.remote && remoteHostsState.needsConnect[props.remote.hostId]),
  (needs, before) => {
    if (before && !needs && props.remote) {
      remoteRev.value++
      reload()
    }
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
// --- Fullscreen and the web pages (+) -----------------------------------------
function setFullscreen(on) {
  if (!!on !== props.fullscreen) emit('update:fullscreen', !!on)
}
// A web page of the panel with the keyboard (its address bar, the page):
// the window's Esc never comes here, the page asks (SideBrowser.vue).
// -> whether fullscreen was left.
provide('sideFullscreen', {
  exit: () => {
    if (!props.fullscreen) return false
    setFullscreen(false)
    return true
  }
})
// A pane brought to the front from the panel: fullscreen would hide it.
function focusPane(id) {
  setFullscreen(false)
  emit('focus-pane', id)
}
const rootEl = ref(null)
// Esc restores the panel, unless something used the key already (a search
// box, a page) or the keyboard is elsewhere (a pane, a dialog).
function onKey(e) {
  if (e.key !== 'Escape' || !props.fullscreen || e.defaultPrevented) return
  const target = e.target
  const inPanel = !!rootEl.value && target instanceof Node && rootEl.value.contains(target)
  if (!inPanel && target !== document.body && target !== document.documentElement) return
  e.preventDefault()
  setFullscreen(false)
}
function newBrowserId() {
  let id
  do id = 'web-' + Math.random().toString(36).slice(2, 10) // i18n-ignore
  while (isTab(id))
  return id
}
// +: a new page, shown. A link a page opens in a new pane: a new tab, not shown.
function addBrowser(url = '', show = true) {
  const page = { id: newBrowserId(), url: url || '', title: '' }
  emit('update:browsers', [...props.browsers, page])
  if (show) emit('update:tab', page.id)
}
// A page closed: its tab goes; if it was shown, the tab shown before it.
function closeBrowser(id) {
  const rest = props.browsers.filter((b) => b.id !== id)
  delete shown[id]
  emit('update:browsers', rest)
  if (props.tab !== id) return
  const ok = (tab) => tab !== id && (SIDE_TABS.includes(tab) || rest.some((b) => b.id === tab))
  const back = [...visited].reverse().find(ok)
  emit('update:tab', back || 'dashboard')
}
function browserLabel(b) {
  return b.title || displayUrl(b.url) || t('sidePanelAdd.newPage', 'New page')
}
// Middle-click closes a page's tab.
function onBrowserTabAux(e, id) {
  if (e.button !== 1) return
  e.preventDefault()
  closeBrowser(id)
}
window.addEventListener('keydown', onKey)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  if (stop) stop()
  clearTimeout(timer)
  if (explorer()) explorer().unwatch()
})
</script>

<template>
  <div ref="rootEl" class="side-panel">
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
      <div v-if="browsers.length" class="side-web-tabs">
        <div
          v-for="b in browsers"
          :key="b.id"
          class="side-tab side-web-tab"
          :class="{ on: current() === b.id }"
          role="tab"
          tabindex="0"
          :aria-selected="current() === b.id"
          :title="browserLabel(b)"
          :aria-label="browserLabel(b)"
          :data-test="'side-tab-' + b.id"
          @click="emit('update:tab', b.id)"
          @keydown.enter.self.prevent="emit('update:tab', b.id)"
          @keydown.space.self.prevent="emit('update:tab', b.id)"
          @mousedown.middle.prevent
          @auxclick="onBrowserTabAux($event, b.id)"
        >
          <Globe :size="16" aria-hidden="true" />
          <button
            type="button"
            class="side-web-close"
            tabindex="-1"
            :title="t('sidePanelAdd.closePage', 'Close page (middle-click)')"
            :aria-label="t('sidePanelAdd.closePage', 'Close page (middle-click)')"
            data-test="side-web-close"
            @click.stop="closeBrowser(b.id)"
          >
            <X :size="10" aria-hidden="true" />
          </button>
        </div>
      </div>
      <span class="side-tabs-fill"></span>
      <button
        type="button"
        class="side-tab-action"
        :title="t('sidePanelAdd.title', 'New browser page')"
        :aria-label="t('sidePanelAdd.title', 'New browser page')"
        data-test="side-add"
        @click="addBrowser()"
      >
        <Plus :size="15" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="side-tab-action"
        :class="{ on: fullscreen }"
        :title="fullscreen ? t('sidePanelAdd.exitFullscreen', 'Exit fullscreen (Esc)') : t('sidePanelAdd.fullscreen', 'Fullscreen')"
        :aria-label="fullscreen ? t('sidePanelAdd.exitFullscreen', 'Exit fullscreen (Esc)') : t('sidePanelAdd.fullscreen', 'Fullscreen')"
        :aria-pressed="fullscreen"
        data-test="side-fullscreen"
        @click="setFullscreen(!fullscreen)"
      >
        <Minimize2 v-if="fullscreen" :size="14" aria-hidden="true" />
        <Maximize2 v-else :size="14" aria-hidden="true" />
      </button>
    </div>
    <div class="side-body">
      <RemoteBadge
        v-if="remote && (current() === 'files' || current() === 'changes')"
        :host-id="remote.hostId"
        :host="remote.host"
        :path="remote.path"
      />
      <AgentDashboard
        v-if="shown.dashboard"
        v-show="current() === 'dashboard'"
        :projects="projects"
        :now="now"
        @focus-pane="focusPane"
        @sleep="(ids) => emit('sleep', ids)"
      />
      <ExplorerPanel
        v-if="shown.files"
        :key="'files:' + remoteRev"
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
        :key="'changes:' + remoteRev"
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
        @focus-pane="focusPane"
        @review="(id) => emit('review', id)"
      />
      <TaskHistoryPanel
        v-if="shown.taskHistory"
        v-show="current() === 'taskHistory'"
        :projects="projects"
        :now="now"
        :active="current() === 'taskHistory'"
        @focus-pane="focusPane"
      />
      <SessionHistoryPanel
        v-if="shown.history"
        v-show="current() === 'history'"
        :cwd="remote ? null : root"
        :remote="remote"
        :open-ids="openSessionIds"
        :active="current() === 'history'"
        @resume="(s) => emit('resume-session', s)"
        @focus-pane="focusPane"
        @open-editor="(file) => emit('open-editor', file)"
        @toast="(t) => emit('toast', t)"
      />
      <template v-for="b in browsers" :key="b.id">
        <SideBrowser
          v-if="shown[b.id]"
          v-show="current() === b.id"
          :node="b"
          :active="current() === b.id"
          @close="closeBrowser(b.id)"
          @open-tab="(url) => addBrowser(url, false)"
        />
      </template>
    </div>
  </div>
</template>
