<script setup>
// The status bar at the bottom, ported from Orca's (MIT, Copyright (c) 2026
// Lovecast Inc.; src/renderer/src/components/status-bar/: StatusBarSurface,
// StatusBarVisibilityMenu, CaffeinateStatusSegment, ResourceUsageStatusSegment
// and its popover, PortsStatusSegment, SshStatusSegment). Left: where your
// typing goes and the panes (Tessel's former footer). Right: keep awake, the
// Resource Manager (memory · terminals), live ports, remote hosts.
// Right-click the bar to choose its indicators.
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import {
  Coffee,
  MemoryStick,
  Terminal,
  Plug,
  LoaderCircle,
  Server,
  Activity,
  ChevronRight,
  FolderOpen
} from 'lucide-vue-next'
import OrcaMenu from './OrcaMenu.vue'
import PortRow from './sidebar/PortRow.vue'
import ResourceSparkline from './ResourceSparkline.vue'
import RemoteHostsStatus from './remote/RemoteHostsStatus.vue'
import { settings } from '../settings'
import {
  formatMemory,
  formatCpu,
  awakeCopy,
  resourceTree,
  portsSummary,
  createResourceHistory,
  APP_HISTORY_KEY
} from '../statusBarModel'
import { t } from '../i18n'

const props = defineProps({
  // Left side: { target, summary, path }
  info: { type: Object, default: null },
  keepAwakeActive: { type: Boolean, default: false },
  // Live terminal panes: [{ id, pid, label, group, groupKey }]
  terminals: { type: Array, default: () => [] },
  // Live ports: [{ key, name, ports }] per workspace, and the others.
  portGroups: { type: Array, default: () => [] },
  externalPorts: { type: Array, default: () => [] },
  portsRefreshing: { type: Boolean, default: false },
  portsUnavailable: { type: String, default: '' }
})
const emit = defineEmits(['focus-pane', 'activate-card', 'port-open', 'port-copy', 'port-stop', 'refresh-ports'])

// --- Width breakpoints (Orca: compact < 900, icon only < 500) ---------------
const barEl = ref(null)
const width = ref(1200)
let observer = null
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && barEl.value) {
    observer = new ResizeObserver((entries) => (width.value = entries[0].contentRect.width))
    observer.observe(barEl.value)
  }
})
onBeforeUnmount(() => observer && observer.disconnect())
const compact = computed(() => width.value < 900)
const iconOnly = computed(() => width.value < 500)
const shows = (id) => settings.statusBarItems.includes(id)

// --- Keep computer awake (CaffeinateStatusSegment) --------------------------
const awake = computed(() => awakeCopy(settings.keepAwake, props.keepAwakeActive))
const awakeOpen = ref(null)
const awakeItems = computed(() => [
  { type: 'header', label: awake.value.title, hint: awake.value.statusText },
  { type: 'separator' },
  ...[
    {
      id: 'on',
      label: t('statusBar.awake.on', 'On'),
      description: t('statusBar.awake.onHint', 'Keep this computer awake continuously')
    },
    {
      id: 'agents',
      label: t('statusBar.awake.agent', 'Agent'),
      description: t('statusBar.awake.agentHint', 'Stay awake while an agent is working')
    },
    {
      id: 'off',
      label: t('statusBar.awake.off', 'Off'),
      description: t('statusBar.awake.offHint', 'Allow normal system sleep behavior')
    }
  ].map((m) => ({
    type: 'radio',
    label: m.label,
    description: m.description,
    checked: settings.keepAwake === m.id,
    onSelect: () => (settings.keepAwake = m.id)
  }))
])

// --- Resource Manager -------------------------------------------------------
const snapshot = ref(null)
const snapshotError = ref('')
const resourcesOpen = ref(false)
const resourceAnchor = ref(null)
const sortBy = ref('memory') // 'name' | 'cpu' | 'memory'
const appExpanded = ref(false)
let pollTimer = 0
let fetching = null
// Sparklines: each snapshot we already fetch adds one memory sample per
// workspace and for Tessel (Orca: 60 kept, kept while the popover is closed).
const history = createResourceHistory()
const historyTick = ref(0)
function historyOf(key) {
  void historyTick.value
  return history.read(key)
}
async function fetchSnapshot() {
  if (!window.shellApi || !window.shellApi.resourceSnapshot) return
  if (fetching) return fetching
  fetching = (async () => {
    try {
      const terms = props.terminals
      const res = await window.shellApi.resourceSnapshot({ ptys: terms.map((t) => ({ id: t.id, pid: t.pid })) })
      if (res && res.ok) {
        history.record(res, terms, Number.isFinite(res.at) ? res.at : Date.now())
        historyTick.value++
        snapshot.value = res
        snapshotError.value = ''
      } else snapshotError.value = (res && res.error) || t('statusBar.resources.memoryUnavailable', 'memory unavailable')
    } catch (e) {
      snapshotError.value = e.message
    } finally {
      fetching = null
    }
  })()
  return fetching
}
// Orca: one snapshot when ready, then every 2 s only while the popover is open.
onMounted(() => shows('resource-usage') && fetchSnapshot())
watch(resourcesOpen, (open) => {
  clearInterval(pollTimer)
  if (open) {
    fetchSnapshot()
    pollTimer = setInterval(() => document.visibilityState !== 'hidden' && fetchSnapshot(), 2000)
  }
})
onBeforeUnmount(() => clearInterval(pollTimer))
const metricLabel = computed(() => (snapshot.value && snapshot.value.processMemoryMetric === 'rss' ? 'RSS' : 'WS'))
const memBadge = computed(() => (snapshot.value ? formatMemory(snapshot.value.totalMemory) : '—'))
const tree = computed(() => resourceTree(snapshot.value, props.terminals, sortBy.value))
const terminalCount = computed(() => props.terminals.length)
const resourceTooltip = computed(() => {
  const mem = snapshot.value
    ? `${memBadge.value} · Σ ${metricLabel.value}${
        snapshot.value.totalPrivateMemory !== undefined
          ? ` · ${formatMemory(snapshot.value.totalPrivateMemory)} Σ ${t('statusBar.resources.private', 'Private')}`
          : ''
      }`
    : t('statusBar.resources.memoryUnavailable', 'memory unavailable')
  const n = terminalCount.value
  return [
    n === 1
      ? t('statusBar.resources.tooltip', 'Resource Manager - {{memory}} - {{count}} terminal session', { memory: mem, count: n })
      : t('statusBar.resources.tooltip', 'Resource Manager - {{memory}} - {{count}} terminal sessions', { memory: mem, count: n }),
    n > 0
      ? t('statusBar.resources.grouped', 'Terminal sessions are grouped by workspace.')
      : t('statusBar.resources.noSessions', 'No terminal sessions yet.')
  ].join('\n')
})
const resourceAriaLabel = computed(() => {
  const n = terminalCount.value
  return n === 1
    ? t('statusBar.resources.ariaLabel', 'Resource Manager, {{count}} terminal session', { count: n })
    : t('statusBar.resources.ariaLabel', 'Resource Manager, {{count}} terminal sessions', { count: n })
})
function toggleResources(e) {
  resourceAnchor.value = e.currentTarget.getBoundingClientRect()
  portsOpen.value = false
  resourcesOpen.value = !resourcesOpen.value
}
function metricDescription(metric) {
  return metric === 'RSS'
    ? t('statusBar.resources.rssHint', 'Summed resident set size (RSS). Shared or aliased pages can appear in more than one process.')
    : t('statusBar.resources.wsHint', 'Summed working set (WS): pages resident in RAM right now. Shared pages can appear in more than one process, and memory Windows has paged out is not counted here.')
}
function privateDescription() {
  return t('statusBar.resources.privateHint', 'Summed private bytes: memory these processes have committed, counted whether it is resident or paged out. This is what the host charges against its commit limit, so it keeps rising while the working set above shrinks under paging.')
}
const portsLabel = computed(() => {
  const n = ports.value.workspaceCount
  return n === 1
    ? t('statusBar.ports.ariaLabel', 'Ports, {{count}} workspace port', { count: n })
    : t('statusBar.ports.ariaLabel', 'Ports, {{count}} workspace ports', { count: n })
})
const portsTitle = computed(() => {
  const n = ports.value.workspaceCount
  const main =
    n === 1
      ? t('statusBar.ports.title', 'Ports — {{count}} workspace port', { count: n })
      : t('statusBar.ports.title', 'Ports — {{count}} workspace ports', { count: n })
  return ports.value.externalCount
    ? main + t('statusBar.ports.externalSuffix', ' · {{count}} external', { count: ports.value.externalCount })
    : main
})

// --- Ports ------------------------------------------------------------------
const ports = computed(() => portsSummary(props.portGroups, props.externalPorts))
const portsOpen = ref(false)
const portsAnchor = ref(null)
const externalExpanded = ref(false)
function togglePorts(e) {
  portsAnchor.value = e.currentTarget.getBoundingClientRect()
  resourcesOpen.value = false
  portsOpen.value = !portsOpen.value
  if (portsOpen.value) emit('refresh-ports')
}

// --- Remote hosts (SshStatusSegment): see remote/RemoteHostsStatus.vue ------

// --- Popovers: placed above their trigger, closed by a click outside ---------
const popEl = ref(null)
const popPos = ref({ left: 0, top: 0 })
function placePopover(anchor) {
  nextTick(() => {
    const el = popEl.value
    if (!el || !anchor) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.min(Math.max(8, anchor.right - w), window.innerWidth - w - 8)
    const top = Math.max(8, anchor.top - h - 8)
    popPos.value = { left, top }
  })
}
watch([resourcesOpen, portsOpen, tree, () => ports.value.workspaceCount, externalExpanded], () => {
  if (resourcesOpen.value) placePopover(resourceAnchor.value)
  else if (portsOpen.value) placePopover(portsAnchor.value)
})
function onDocDown(e) {
  if (!resourcesOpen.value && !portsOpen.value) return
  if (e.target.closest && (e.target.closest('.sb-popover') || e.target.closest('[data-status-bar-trigger]'))) return
  resourcesOpen.value = false
  portsOpen.value = false
}
function onDocKey(e) {
  if (e.key === 'Escape' && (resourcesOpen.value || portsOpen.value)) {
    resourcesOpen.value = false
    portsOpen.value = false
  }
}
onMounted(() => {
  window.addEventListener('pointerdown', onDocDown, true)
  window.addEventListener('keydown', onDocKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocDown, true)
  window.removeEventListener('keydown', onDocKey)
})

// --- Right-click: which indicators show (StatusBarVisibilityMenu) -----------
const visibilityMenu = ref(null)
const visibilityItems = computed(() =>
  [
    { id: 'ssh', label: t('statusBar.hosts.title', 'Remote Hosts'), icon: Server },
    { id: 'resource-usage', label: t('statusBar.resources.title', 'Resource Manager'), icon: Activity },
    { id: 'ports', label: t('statusBar.ports.name', 'Ports'), icon: Plug }
  ].map((i) => ({
    type: 'checkbox',
    label: i.label,
    icon: i.icon,
    checked: shows(i.id),
    onSelect: () =>
      (settings.statusBarItems = shows(i.id)
        ? settings.statusBarItems.filter((x) => x !== i.id)
        : [...settings.statusBarItems, i.id])
  }))
)
function onContextMenu(e) {
  if (e.target.closest && e.target.closest('[data-status-bar-context-menu-exempt]')) return
  e.preventDefault()
  visibilityMenu.value = { x: e.clientX, y: e.clientY }
}

function focusSession(id) {
  resourcesOpen.value = false
  emit('focus-pane', id)
}
function goToWorktree(key) {
  portsOpen.value = false
  emit('activate-card', key)
}
</script>

<template>
  <footer ref="barEl" class="sb" :aria-label="t('statusBar.ariaLabel', 'Status bar')" @contextmenu="onContextMenu">
    <div class="sb-left">
      <template v-if="info">
        <span class="sb-info sb-target" :title="info.target">{{ info.target }}</span>
        <span class="sb-info" :title="info.summary">{{ info.summary }}</span>
        <span v-if="info.path && !compact" class="sb-info sb-path" :title="info.path">{{ info.path }}</span>
      </template>
    </div>
    <div class="sb-spacer"></div>
    <div class="sb-right">
      <!-- Keep computer awake -->
      <button
        type="button"
        class="sb-trigger sb-awake"
        :aria-label="awake.ariaLabel"
        :title="awake.ariaLabel"
        data-status-bar-context-menu-exempt
        data-status-bar-trigger
        @click="awakeOpen = awakeOpen ? null : $event.currentTarget.getBoundingClientRect()"
      >
        <Coffee :size="12" :class="{ active: keepAwakeActive }" aria-hidden="true" />
        <span v-if="!iconOnly" class="sb-label">{{ awake.modeLabel }}</span>
        <span class="sb-awake-dot" :class="{ active: keepAwakeActive }" aria-hidden="true"></span>
      </button>

      <!-- Resource Manager: memory · terminals -->
      <button
        v-if="shows('resource-usage')"
        type="button"
        class="sb-trigger"
        :aria-label="resourceAriaLabel"
        :title="resourceTooltip"
        :aria-expanded="resourcesOpen"
        data-status-bar-context-menu-exempt
        data-status-bar-trigger
        @click="toggleResources"
      >
        <MemoryStick :size="12" class="sb-muted" aria-hidden="true" />
        <template v-if="!iconOnly">
          <span class="sb-label sb-num">{{ memBadge }}</span>
          <span class="sb-sep">·</span>
          <Terminal :size="12" class="sb-muted" aria-hidden="true" />
          <span class="sb-count">{{ terminalCount }}</span>
        </template>
        <span v-else-if="terminalCount > 0" class="sb-count">{{ terminalCount }}</span>
      </button>

      <!-- Ports -->
      <button
        v-if="shows('ports')"
        type="button"
        class="sb-trigger"
        :aria-label="portsLabel"
        :title="portsTitle"
        :aria-expanded="portsOpen"
        data-status-bar-context-menu-exempt
        data-status-bar-trigger
        @click="togglePorts"
      >
        <LoaderCircle v-if="portsRefreshing" :size="12" class="sb-muted sb-spin" aria-hidden="true" />
        <Plug v-else :size="12" class="sb-muted" aria-hidden="true" />
        <span v-if="!iconOnly || ports.totalCount > 0" class="sb-label sb-num">{{ ports.workspaceCount }}</span>
      </button>

      <!-- Remote hosts (remote/RemoteHostsStatus.vue) -->
      <RemoteHostsStatus v-if="shows('ssh')" :compact="compact" :icon-only="iconOnly" />
    </div>

    <OrcaMenu
      :open="!!awakeOpen"
      :anchor="awakeOpen"
      side="top"
      align="end"
      :offset="8"
      :width="256"
      :items="awakeItems"
      :label="awake.title"
      @close="awakeOpen = null"
    />
    <OrcaMenu
      :open="!!visibilityMenu"
      :anchor="visibilityMenu"
      side="bottom"
      :offset="0"
      :items="visibilityItems"
      :label="t('statusBar.menu.items', 'Status bar items')"
      @close="visibilityMenu = null"
    />

    <Teleport to="body">
      <!-- Resource Manager popover -->
      <div
        v-if="resourcesOpen"
        ref="popEl"
        class="sb-popover sb-resources"
        role="dialog"
        :aria-label="t('statusBar.resources.title', 'Resource Manager')"
        data-status-bar-context-menu-exempt
        :style="{ left: popPos.left + 'px', top: popPos.top + 'px' }"
      >
        <div class="sb-pop-head">
          <span class="sb-pop-title"><MemoryStick :size="12" class="sb-muted" aria-hidden="true" /> {{ t('statusBar.resources.title', 'Resource Manager') }}</span>
        </div>
        <div v-if="snapshot" class="sb-res-summary">
          <span :title="t('statusBar.resources.cpuHint', 'Combined CPU load. Values above 100% mean more than one core is working at once.')">{{ formatCpu(snapshot.totalCpu) }}</span>
          <span class="sb-sep">·</span>
          <span :title="metricDescription(metricLabel)">{{ formatMemory(snapshot.totalMemory) }} <span class="sb-muted-text">Σ {{ metricLabel }}</span></span>
          <template v-if="snapshot.totalPrivateMemory !== undefined">
            <span class="sb-sep">·</span>
            <span :title="privateDescription()">{{ formatMemory(snapshot.totalPrivateMemory) }} <span class="sb-muted-text">Σ {{ t('statusBar.resources.private', 'Private') }}</span></span>
          </template>
        </div>
        <div class="sb-res-body">
          <div class="sb-res-sort">
            <button type="button" class="sb-res-col name" :class="{ on: sortBy === 'name' }" @click="sortBy = 'name'">{{ t('statusBar.resources.name', 'Name') }}</button>
            <button type="button" class="sb-res-col cpu" :class="{ on: sortBy === 'cpu' }" @click="sortBy = 'cpu'">CPU</button>
            <button type="button" class="sb-res-col mem" :class="{ on: sortBy === 'memory' }" @click="sortBy = 'memory'">
              {{ metricLabel }}
            </button>
          </div>
          <div class="sb-res-scroll">
            <template v-if="snapshot">
              <div v-if="!tree.groups.length" class="sb-empty">{{ t('statusBar.resources.nothingRunning', 'Nothing running right now') }}</div>
              <div v-for="g in tree.groups" :key="g.key" class="sb-res-group">
                <div class="sb-res-row group">
                  <span class="sb-res-name">{{ g.name }}</span>
                  <ResourceSparkline :samples="historyOf(g.key)" />
                  <span class="sb-res-cpu">{{ formatCpu(g.cpu) }}</span>
                  <span class="sb-res-mem">{{ formatMemory(g.memory) }}</span>
                </div>
                <button
                  v-for="s in g.sessions"
                  :key="s.id"
                  type="button"
                  class="sb-res-row session"
                  :title="t('statusBar.resources.goTo', 'Go to {{name}}', { name: s.label })"
                  @click="focusSession(s.id)"
                >
                  <span class="sb-res-dot" :class="{ bound: s.bound }" aria-hidden="true"></span>
                  <span class="sb-res-name">{{ s.label }}</span>
                  <span class="sb-res-cpu">{{ s.bound ? formatCpu(s.cpu) : '—' }}</span>
                  <span class="sb-res-mem">{{ s.bound ? formatMemory(s.memory) : '—' }}</span>
                </button>
              </div>
              <div class="sb-res-group">
                <button
                  type="button"
                  class="sb-res-row sb-res-app"
                  :aria-label="appExpanded ? t('statusBar.resources.collapseApp', 'Collapse Tessel') : t('statusBar.resources.expandApp', 'Expand Tessel')"
                  @click="appExpanded = !appExpanded"
                >
                  <ChevronRight :size="12" class="sb-res-chevron" :class="{ open: appExpanded }" aria-hidden="true" />
                  <span class="sb-res-name caps">Tessel</span>
                  <ResourceSparkline :samples="historyOf(APP_HISTORY_KEY)" />
                  <span class="sb-res-cpu">{{ formatCpu(snapshot.app.total.cpu) }}</span>
                  <span class="sb-res-mem">{{ formatMemory(snapshot.app.total.memory) }}</span>
                </button>
                <template v-if="appExpanded">
                  <div v-for="a in tree.app" :key="a.key" class="sb-res-row session">
                    <span class="sb-res-dot bound" aria-hidden="true"></span>
                    <span class="sb-res-name">{{ a.label }}</span>
                    <span class="sb-res-cpu">{{ formatCpu(a.cpu) }}</span>
                    <span class="sb-res-mem">{{ formatMemory(a.memory) }}</span>
                  </div>
                </template>
              </div>
            </template>
            <div
              v-else
              class="sb-empty"
              v-text="snapshotError ? t('statusBar.resources.unavailable', 'Resource snapshots are unavailable: {{error}}', { error: snapshotError }) : t('statusBar.loading', 'Loading…')"
            ></div>
          </div>
        </div>
      </div>

      <!-- Ports popover -->
      <div
        v-if="portsOpen"
        ref="popEl"
        class="sb-popover sb-ports"
        role="dialog"
        :aria-label="t('statusBar.ports.name', 'Ports')"
        data-status-bar-context-menu-exempt
        :style="{ left: popPos.left + 'px', top: popPos.top + 'px' }"
      >
        <div class="sb-pop-head">
          <span class="sb-pop-title"><Plug :size="12" class="sb-muted" aria-hidden="true" /> {{ t('statusBar.ports.name', 'Ports') }}</span>
          <span class="sb-pop-hint" v-text="t('statusBar.ports.counts', '{{workspace}} workspace · {{external}} external', { workspace: ports.workspaceCount, external: ports.externalCount })"></span>
        </div>
        <div v-if="portsUnavailable" class="sb-notice" v-text="t('statusBar.ports.unavailable', 'Port scan unavailable on this computer: {{reason}}', { reason: portsUnavailable })"></div>
        <div class="sb-ports-list">
          <section v-for="g in ports.groups" :key="g.key" class="sb-port-group">
            <div class="sb-port-group-head">
              <span class="sb-port-group-name" :title="g.name">{{ g.name }}</span>
              <button type="button" class="port-row-action" :aria-label="t('statusBar.ports.goToWorktree', 'Go to Worktree')" :title="t('statusBar.ports.goToWorktree', 'Go to Worktree')" @click="goToWorktree(g.key)">
                <FolderOpen :size="12" aria-hidden="true" />
              </button>
              <span class="sb-port-group-count">{{ g.ports.length }}</span>
            </div>
            <div class="sb-port-rows">
              <PortRow
                v-for="p in g.ports"
                :key="p.id"
                :port="p"
                variant="status"
                @open="emit('port-open', $event)"
                @copy="emit('port-copy', $event)"
                @stop="emit('port-stop', $event)"
              />
            </div>
          </section>
          <div v-if="!ports.groups.length" class="sb-empty">
            {{ portsRefreshing ? t('statusBar.ports.scanning', 'Scanning for workspace ports...') : t('statusBar.ports.none', 'No workspace ports detected') }}
          </div>
          <section class="sb-external">
            <button type="button" class="sb-external-toggle" :aria-expanded="externalExpanded" @click="externalExpanded = !externalExpanded">
              <ChevronRight :size="12" class="sb-res-chevron" :class="{ open: externalExpanded }" aria-hidden="true" />
              {{ t('statusBar.ports.external', 'External Ports') }}
              <span class="sb-port-group-count">{{ ports.externalCount }}</span>
            </button>
            <template v-if="externalExpanded">
              <div v-if="externalPorts.length" class="sb-port-rows">
                <PortRow
                  v-for="p in externalPorts"
                  :key="p.id"
                  :port="p"
                  variant="status"
                  @open="emit('port-open', $event)"
                  @copy="emit('port-copy', $event)"
                  @stop="emit('port-stop', $event)"
                />
              </div>
              <div v-else class="sb-empty">{{ t('statusBar.ports.noExternal', 'No external ports detected') }}</div>
            </template>
          </section>
        </div>
      </div>
    </Teleport>
  </footer>
</template>
