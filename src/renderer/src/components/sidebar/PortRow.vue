<script setup>
// One live port with its Open / Copy / Stop actions, ported from Orca's
// WorktreePortRow (sidebar/WorktreeCardPorts.tsx) and the status bar's
// PortRow (status-bar/ports-status-popover-rows.tsx); MIT, Copyright (c)
// 2026 Lovecast Inc. Tessel has no built-in browser: Open uses the system
// browser.
import { computed } from 'vue'
import { Copy, ExternalLink, Trash2 } from 'lucide-vue-next'
import { addressForPort } from '../../portScanner'
import { t } from '../../i18n'

const props = defineProps({
  port: { type: Object, required: true },
  // 'card' (the sidebar card's Live Ports) | 'status' (the status bar popover)
  variant: { type: String, default: 'card' }
})
const emit = defineEmits(['open', 'copy', 'stop'])

const processLabel = computed(
  () =>
    props.port.processName ||
    (props.port.pid ? `PID ${props.port.pid}` : t('sidebar.ports.unknownProcess', 'Unknown process'))
)
const address = computed(() => addressForPort(props.port))
// Orca's canStopWorkspacePort: an owned process, never the app itself.
const canStop = computed(() => props.port.kind !== 'external' && !!props.port.pid && props.port.processName !== 'Electron')

function act(kind, e) {
  e.stopPropagation()
  emit(kind, props.port)
  if (e.detail > 0) e.currentTarget.blur()
}
</script>

<template>
  <div class="port-row" :class="variant === 'status' ? 'port-row-status' : 'port-row-card'">
    <span class="port-row-num">{{ port.port }}</span>
    <div v-if="variant === 'status'" class="port-row-body">
      <span class="port-row-process" :title="processLabel">{{ processLabel }}</span>
      <span class="port-row-address" :title="address">{{ address }}</span>
    </div>
    <div v-else class="port-row-body-inline" :title="`${processLabel} - ${address}`">
      <span class="port-row-process">{{ processLabel }}</span>
      <span class="port-row-dash">-</span>
      <span class="port-row-address">{{ address }}</span>
    </div>
    <div class="port-row-actions">
      <button type="button" class="port-row-action" :aria-label="t('sidebar.ports.openInBrowser', 'Open in Browser')" :title="t('sidebar.ports.openInBrowser', 'Open in Browser')" @click="act('open', $event)">
        <ExternalLink :size="12" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="port-row-action"
        :aria-label="t('sidebar.ports.copy', 'Copy {{address}}', { address })"
        :title="t('sidebar.ports.copy', 'Copy {{address}}', { address })"
        @click="act('copy', $event)"
      >
        <Copy :size="12" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="port-row-action"
        :aria-label="t('sidebar.ports.stopProcess', 'Stop Process')"
        :title="t('sidebar.ports.stopProcess', 'Stop Process')"
        :disabled="!canStop"
        @click="act('stop', $event)"
      >
        <Trash2 :size="12" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
