<script setup>
// The status bar's remote hosts item, ported from Orca's SshStatusSegment.tsx
// and SshTargetStatusRow.tsx (MIT, Copyright (c) 2026 Lovecast Inc.): the
// hosts with a terminal open first, then the others, each with Connect or
// Disconnect, and "Manage Remote Hosts…" (Settings > SSH Hosts).
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { Server, ServerOff, LoaderCircle, MonitorSmartphone } from 'lucide-vue-next'
import { t } from '../../i18n'
import {
  remoteHostsState,
  hostStatus,
  statusLabel,
  statusTone,
  overallStatus,
  connectedHostCountLabel,
  canConnectStatus,
  connectVerb,
  connectRemoteHost,
  disconnectRemoteHost,
  manageRemoteHosts
} from '../../remoteHosts'
import './remoteHosts.css'

defineProps({
  compact: { type: Boolean, default: false },
  iconOnly: { type: Boolean, default: false }
})

const rows = computed(() => {
  const all = remoteHostsState.targets.map((x) => ({ id: x.id, label: x.label, target: x, status: hostStatus(x.id) }))
  return [...all.filter((r) => r.status === 'connected'), ...all.filter((r) => r.status !== 'connected')]
})
const overall = computed(() => overallStatus(rows.value.map((r) => r.status)))
const connectedCount = computed(() => rows.value.filter((r) => r.status === 'connected').length)
const anyConnecting = computed(() => overall.value === 'connecting')
// Orca's overallDotColor.
const dotTone = computed(() => {
  if (overall.value === 'connected') return 'ok'
  if (overall.value === 'partial') return connectedCount.value > 0 ? 'ok' : 'off'
  if (overall.value === 'connecting') return 'busy'
  return 'off'
})
const countLabel = computed(() =>
  anyConnecting.value ? t('remote.statusBar.connecting', 'Connecting…') : connectedHostCountLabel(connectedCount.value)
)

const open = ref(false)
const triggerEl = ref(null)
const popEl = ref(null)
const pos = ref({ left: -9999, top: -9999 })
const busy = ref({})

function place() {
  nextTick(() => {
    const el = popEl.value
    const trigger = triggerEl.value
    if (!el || !trigger) return
    const r = trigger.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8))
    const top = Math.max(8, r.top - h - 8)
    pos.value = { left, top }
  })
}
function toggle() {
  open.value = !open.value
  if (open.value) place()
}
function close() {
  open.value = false
}
function onDocDown(e) {
  if (!open.value) return
  if (popEl.value && popEl.value.contains(e.target)) return
  if (triggerEl.value && triggerEl.value.contains(e.target)) return
  close()
}
function onDocKey(e) {
  if (open.value && e.key === 'Escape') close()
}
onMounted(() => {
  window.addEventListener('pointerdown', onDocDown, true)
  window.addEventListener('keydown', onDocKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocDown, true)
  window.removeEventListener('keydown', onDocKey)
})

async function act(row, fn) {
  if (busy.value[row.id]) return
  busy.value = { ...busy.value, [row.id]: true }
  try {
    await fn()
  } catch {
    /* the pane or the settings page shows what went wrong */
  } finally {
    const next = { ...busy.value }
    delete next[row.id]
    busy.value = next
  }
}
function connect(row) {
  close()
  return act(row, () => connectRemoteHost(row.target))
}
function disconnect(row) {
  return act(row, () => disconnectRemoteHost(row.id))
}
function manage() {
  close()
  manageRemoteHosts()
}
</script>

<template>
  <button
    ref="triggerEl"
    type="button"
    class="sb-trigger"
    :aria-label="t('remote.statusBar.ariaLabel', 'Remote host connection status')"
    :aria-expanded="open"
    data-status-bar-trigger
    data-status-bar-context-menu-exempt
    data-test="remote-hosts-status"
    @click="toggle"
  >
    <template v-if="!iconOnly">
      <LoaderCircle v-if="anyConnecting" :size="12" class="rh-spin rh-busy" aria-hidden="true" />
      <Server v-else-if="overall === 'connected'" :size="12" class="rh-ok" aria-hidden="true" />
      <Server v-else-if="overall === 'partial'" :size="12" class="sb-muted" aria-hidden="true" />
      <ServerOff v-else :size="12" class="sb-muted" aria-hidden="true" />
      <span v-if="!compact" class="sb-label sb-muted-text">{{ countLabel }}</span>
      <span class="rh-dot small" :class="'rh-dot-' + dotTone" aria-hidden="true"></span>
    </template>
    <template v-else>
      <span class="rh-dot" :class="'rh-dot-' + dotTone" aria-hidden="true"></span>
      <LoaderCircle v-if="anyConnecting" :size="12" class="rh-spin sb-muted" aria-hidden="true" />
      <MonitorSmartphone v-else :size="12" class="sb-muted" aria-hidden="true" />
    </template>
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="popEl"
      class="orca-menu rh-pop"
      role="menu"
      :aria-label="t('remote.statusBar.title', 'Remote Hosts')"
      data-status-bar-context-menu-exempt
      :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
    >
      <div class="orca-menu-label orca-menu-caps">{{ t('remote.statusBar.title', 'Remote Hosts') }}</div>
      <div v-for="row in rows" :key="row.id" class="rh-status-row" data-test="remote-host-row">
        <span class="rh-dot small" :class="'rh-dot-' + statusTone(row.status)" aria-hidden="true"></span>
        <div class="rh-status-main">
          <div class="rh-status-label">{{ row.label }}</div>
          <div class="rh-status-sub">
            <span>{{ t('remote.statusBar.sshHost', 'SSH Host') }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ statusLabel(row.status) }}</span>
          </div>
        </div>
        <LoaderCircle v-if="busy[row.id]" :size="12" class="rh-spin sb-muted" aria-hidden="true" />
        <button
          v-else-if="canConnectStatus(row.status)"
          type="button"
          role="menuitem"
          class="rh-status-action"
          @click="connect(row)"
        >
          {{ connectVerb(row.status) }}
        </button>
        <button
          v-else-if="row.status === 'connected'"
          type="button"
          role="menuitem"
          class="rh-status-action muted"
          @click="disconnect(row)"
        >
          {{ t('remote.statusBar.disconnect', 'Disconnect') }}
        </button>
      </div>
      <div class="orca-menu-sep" role="separator"></div>
      <button type="button" class="orca-menu-item" role="menuitem" data-orca-menu-item @click="manage">
        <span class="orca-menu-text">{{ t('remote.statusBar.manage', 'Manage Remote Hosts…') }}</span>
      </button>
    </div>
  </Teleport>
</template>
