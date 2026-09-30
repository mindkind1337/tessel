<script setup>
// The "Host" picker at the top of Add a project (Orca's AddRepoHostSelector,
// MIT, Copyright (c) 2026 Lovecast Inc.): this computer and the saved SSH
// hosts; "Add remote host" opens Settings > SSH Hosts. An SSH host that is
// not signed in has its Connect (Retry after an error) action in its row;
// picking that row connects too. The dialog selects it once connected.
import { ref, computed, onBeforeUnmount, nextTick } from 'vue'
import { Check, ChevronRight, ChevronsUpDown, LoaderCircle, Plus } from 'lucide-vue-next'
import { t } from '../../i18n'
import { hostStatusText, canConnectHost } from '../../addProject'
import { statusLabel, connectVerb } from '../../remoteHosts'

const props = defineProps({
  hosts: { type: Array, required: true },
  selectedId: { type: String, default: null },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['select', 'add-host', 'connect'])

const open = ref(false)
const root = ref(null)
const listEl = ref(null)
const selected = computed(() => props.hosts.find((h) => h.id === props.selectedId) || props.hosts[0] || null)

function onDocPointer(e) {
  if (root.value && !root.value.contains(e.target)) close()
}
function toggle() {
  if (props.disabled) return
  if (open.value) return close()
  open.value = true
  document.addEventListener('pointerdown', onDocPointer, true)
  nextTick(() => {
    const first = listEl.value && listEl.value.querySelector('[data-host-item].on, [data-host-item]')
    if (first) first.focus()
  })
}
function close() {
  open.value = false
  document.removeEventListener('pointerdown', onDocPointer, true)
}
function pick(host) {
  if (canConnectHost(host)) return connect(host)
  emit('select', host.id)
  close()
}
// The list stays open while it connects (its row says so); the dialog
// selects the host and closes the list once it is connected.
function connect(host) {
  if (host.status === 'connecting') return
  emit('connect', host.id)
}
function connectText(host) {
  if (host.status === 'connecting') return t('project.host.connecting', 'Connecting')
  return connectVerb(host.status === 'error' ? 'error' : host.status)
}
function detailText(host) {
  return host.status === 'error' && host.error ? `${hostStatusText(host)} · ${host.error}` : hostStatusText(host)
}
function addHost() {
  close()
  emit('add-host')
}
// ↑/↓ in the list; Esc closes the list, not the dialog.
function onListKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
    root.value && root.value.querySelector('.aph-trigger')?.focus()
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const items = Array.from(listEl.value ? listEl.value.querySelectorAll('[data-host-item]') : [])
  if (!items.length) return
  e.preventDefault()
  const i = items.indexOf(document.activeElement)
  const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next].focus()
}
onBeforeUnmount(close)
defineExpose({ close })
</script>

<template>
  <div ref="root" class="aph">
    <span class="aph-label">{{ t('project.host.label', 'Host') }}</span>
    <div class="aph-anchor">
      <button
        type="button"
        class="aph-trigger"
        role="combobox"
        :aria-expanded="open"
        :disabled="disabled"
        data-test="host-trigger"
        @click="toggle"
      >
        <span class="aph-trigger-label">{{ selected ? selected.label : '' }}</span>
        <span v-if="selected && selected.kind !== 'local'" class="aph-trigger-status" :title="hostStatusText(selected)">{{
          statusLabel(selected.status)
        }}</span>
        <ChevronsUpDown :size="14" class="aph-chevrons" aria-hidden="true" />
      </button>
      <div v-if="open" ref="listEl" class="aph-list" role="listbox" data-test="host-list" @keydown="onListKey">
        <button type="button" class="aph-item aph-add" data-host-item data-test="host-add" @click="addHost">
          <Plus :size="12" class="aph-icon" aria-hidden="true" />
          <span class="aph-item-body">
            <span class="aph-item-title">{{ t('project.host.addRemote', 'Add remote host') }}</span>
            <span class="aph-item-detail">{{ t('project.host.addSshDetail', 'Use an existing machine over SSH.') }}</span>
          </span>
          <ChevronRight :size="14" class="aph-icon" aria-hidden="true" />
        </button>
        <button
          v-for="host in hosts"
          :key="host.id"
          type="button"
          role="option"
          class="aph-item"
          :class="{ on: host.id === selectedId }"
          :aria-selected="host.id === selectedId"
          data-host-item
          :data-test="'host-' + host.id"
          @click="pick(host)"
        >
          <Check :size="12" class="aph-icon aph-check" :class="{ shown: host.id === selectedId }" aria-hidden="true" />
          <span class="aph-item-body">
            <span class="aph-item-title">{{ host.label }}</span>
            <span class="aph-item-detail" :class="{ bad: host.status === 'error' }" :title="detailText(host)" :data-test="'host-status-' + host.id">{{
              detailText(host)
            }}</span>
          </span>
          <span
            v-if="canConnectHost(host)"
            role="button"
            tabindex="-1"
            class="aph-connect"
            :class="{ busy: host.status === 'connecting' }"
            :aria-disabled="host.status === 'connecting'"
            :data-test="'host-connect-' + host.id"
            @click.stop.prevent="connect(host)"
          >
            <LoaderCircle v-if="host.status === 'connecting'" :size="12" class="aph-spin" aria-hidden="true" />
            {{ connectText(host) }}
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.aph {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.aph-label {
  color: var(--text-dim);
  font-weight: 500;
}
.aph-anchor {
  position: relative;
  min-width: 0;
}
.aph-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  max-width: 18rem;
  min-width: 0;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface-3) 30%, transparent);
  color: var(--text-strong);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.aph-trigger:hover:not(:disabled) {
  background: var(--surface-3);
}
.aph-trigger:disabled {
  opacity: 0.5;
  cursor: default;
}
.aph-trigger:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: 1px;
}
.aph-trigger-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aph-trigger-status {
  flex-shrink: 0;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 400;
}
.aph-chevrons {
  flex-shrink: 0;
  opacity: 0.5;
}
.aph-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 5;
  width: min(340px, calc(100vw - 1rem));
  max-height: 280px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface-2);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
.aph-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-strong);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.aph-item:hover,
.aph-item:focus-visible {
  background: var(--surface-3);
  outline: none;
}
.aph-add {
  color: var(--text-dim);
}
.aph-icon {
  flex-shrink: 0;
  margin-top: 2px;
}
.aph-check {
  opacity: 0;
  color: var(--text-dim);
}
.aph-check.shown {
  opacity: 0.7;
}
.aph-item-body {
  display: block;
  flex: 1;
  min-width: 0;
}
.aph-item-title {
  display: block;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aph-item-detail {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aph-item-detail.bad {
  color: var(--danger);
}
.aph-connect {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  align-self: center;
  justify-content: flex-end;
  gap: 4px;
  min-width: 5.75rem;
  margin-left: 8px;
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
}
.aph-connect:hover {
  color: var(--text-strong);
}
.aph-connect.busy {
  cursor: default;
}
.aph-spin {
  animation: aph-spin 0.9s linear infinite;
}
@keyframes aph-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
