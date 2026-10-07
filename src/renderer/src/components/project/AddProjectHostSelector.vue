<script setup>
// The "Host" picker at the top of Add a project (Orca's AddRepoHostSelector,
// MIT, Copyright (c) 2026 Lovecast Inc.): this computer and the saved SSH
// hosts; "Add remote host" opens Settings > SSH Hosts. An SSH host that is
// not signed in has its Connect (Retry after an error) action in its row;
// picking that row connects too. The dialog selects it once connected.
// Each SSH row: its name, then user@host[:port] · its default folder (two
// saved hosts on one IP stay apart), and its status.
// The list is teleported to <body> with fixed coordinates (as ThemedSelect):
// it overflows the dialog instead of growing a scrollbar in it, opens below
// or above the trigger, whichever fits, and scrolls only when taller than
// the window.
import { ref, computed, onBeforeUnmount, nextTick } from 'vue'
import { Check, ChevronRight, ChevronsUpDown, LoaderCircle, Plus } from 'lucide-vue-next'
import { t } from '../../i18n'
import { canConnectHost } from '../../addProject'
import { statusLabel, connectVerb } from '../../remoteHosts'

const props = defineProps({
  hosts: { type: Array, required: true },
  selectedId: { type: String, default: null },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['select', 'add-host', 'connect'])

const MARGIN = 8
const GAP = 4
const open = ref(false)
const root = ref(null)
const triggerEl = ref(null)
const listEl = ref(null)
const placement = ref({})
const selected = computed(() => props.hosts.find((h) => h.id === props.selectedId) || props.hosts[0] || null)

// Below the trigger when it fits, else above when that fits, else the
// roomier side with the list capped to it (it scrolls then).
function place() {
  const trig = triggerEl.value
  if (!trig) return
  const r = trig.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(380, vw - 2 * MARGIN)
  const left = Math.max(MARGIN, Math.min(r.left, vw - width - MARGIN))
  const natural = listEl.value ? listEl.value.scrollHeight : 0
  const below = vh - r.bottom - GAP - MARGIN
  const above = r.top - GAP - MARGIN
  const up = natural > below && (natural <= above || above > below)
  const space = Math.max(0, up ? above : below)
  placement.value = {
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${space}px`,
    ...(up ? { bottom: `${vh - r.top + GAP}px` } : { top: `${r.bottom + GAP}px` })
  }
}

function onDocPointer(e) {
  const inTrigger = root.value && root.value.contains(e.target)
  const inList = listEl.value && listEl.value.contains(e.target)
  if (!inTrigger && !inList) close()
}
// A scroll outside the list (the dialog) or a resize: follow the trigger.
function onScroll(e) {
  if (listEl.value && e && e.target instanceof Node && listEl.value.contains(e.target)) return
  if (open.value) place()
}
function onResize() {
  if (open.value) place()
}
function toggle() {
  if (props.disabled) return
  if (open.value) return close()
  place()
  open.value = true
  document.addEventListener('pointerdown', onDocPointer, true)
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onResize)
  nextTick(() => {
    place()
    // The selected host's row, else the first one.
    const first = listEl.value && (listEl.value.querySelector('[data-host-item].on') || listEl.value.querySelector('[data-host-item]'))
    if (first) first.focus()
  })
}
function close() {
  open.value = false
  document.removeEventListener('pointerdown', onDocPointer, true)
  document.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onResize)
}
function pick(host) {
  if (canConnectHost(host)) return connect(host)
  emit('select', host.id)
  close()
  if (triggerEl.value) triggerEl.value.focus()
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
// The row's status word (Connected, Disconnected...).
function statusText(host) {
  if (!host || host.kind === 'local') return t('project.host.local', 'Local')
  return statusLabel(host.status)
}
// Under the name: user@host[:port] · folder (local: This computer).
function subtitle(host) {
  if (!host) return ''
  if (host.kind === 'local') return host.detail || ''
  return host.subtitle || ''
}
// The full tooltip: name, user@host:port · folder, status (and the error).
function tooltip(host) {
  if (!host) return ''
  if (host.kind === 'local') return [host.label, host.detail].filter(Boolean).join('\n')
  const status = host.status === 'error' && host.error ? `${statusText(host)} · ${host.error}` : statusText(host)
  return [host.label, host.full, status].filter(Boolean).join('\n')
}
function addHost() {
  close()
  emit('add-host')
}
function backToTrigger() {
  close()
  if (triggerEl.value) triggerEl.value.focus()
}
// ↑/↓/Home/End in the list; Esc closes the list, not the dialog; Tab
// goes back to the trigger (the list sits outside the dialog).
function onListKey(e) {
  if (e.key === 'Escape' || e.key === 'Tab') {
    e.preventDefault()
    e.stopPropagation()
    backToTrigger()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = Array.from(listEl.value ? listEl.value.querySelectorAll('[data-host-item]') : [])
  if (!items.length) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Home') return items[0].focus()
  if (e.key === 'End') return items[items.length - 1].focus()
  const i = items.indexOf(document.activeElement)
  const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next].focus()
}
// ↓ / ↑ on the closed trigger opens the list.
function onTriggerKey(e) {
  if (!open.value && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    e.stopPropagation()
    toggle()
  }
}
onBeforeUnmount(close)
defineExpose({ close })
</script>

<template>
  <div ref="root" class="aph">
    <span class="aph-label">{{ t('project.host.label', 'Host') }}</span>
    <div class="aph-anchor">
      <button
        ref="triggerEl"
        type="button"
        class="aph-trigger"
        role="combobox"
        aria-haspopup="listbox"
        :aria-expanded="open"
        :disabled="disabled"
        :title="tooltip(selected)"
        data-test="host-trigger"
        @click="toggle"
        @keydown="onTriggerKey"
      >
        <span class="aph-trigger-label">{{ selected ? selected.label : '' }}</span>
        <span v-if="selected && selected.kind !== 'local' && subtitle(selected)" class="aph-trigger-sub" data-test="host-trigger-sub">{{
          subtitle(selected)
        }}</span>
        <span v-if="selected && selected.kind !== 'local'" class="aph-trigger-status" data-test="host-trigger-status">{{ statusText(selected) }}</span>
        <ChevronsUpDown :size="14" class="aph-chevrons" aria-hidden="true" />
      </button>
      <Teleport to="body">
        <div
          v-if="open"
          ref="listEl"
          class="aph-list"
          role="listbox"
          :style="placement"
          :aria-label="t('project.host.label', 'Host')"
          data-test="host-list"
          @keydown="onListKey"
        >
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
            :title="tooltip(host)"
            data-host-item
            :data-test="'host-' + host.id"
            @click="pick(host)"
          >
            <Check :size="12" class="aph-icon aph-check" :class="{ shown: host.id === selectedId }" aria-hidden="true" />
            <span class="aph-item-body">
              <span class="aph-item-head">
                <span class="aph-item-title" :data-test="'host-title-' + host.id">{{ host.label }}</span>
                <span
                  class="aph-item-status"
                  :class="{ bad: host.status === 'error', ok: host.status === 'connected' }"
                  :data-test="'host-status-' + host.id"
                  >{{ statusText(host) }}</span
                >
              </span>
              <span v-if="subtitle(host)" class="aph-item-detail" :data-test="'host-sub-' + host.id">{{ subtitle(host) }}</span>
              <span v-if="host.status === 'error' && host.error" class="aph-item-detail bad" :data-test="'host-error-' + host.id">{{
                host.error
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
      </Teleport>
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
  max-width: 26rem;
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
.aph-trigger-label {
  flex: 0 1 auto;
}
.aph-trigger-sub {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 400;
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
  position: fixed;
  z-index: 2147483000;
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
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
.aph-item-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.aph-item-title {
  display: block;
  flex: 1;
  min-width: 0;
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
.aph-item-status {
  flex-shrink: 0;
  color: var(--text-dim);
  font-size: 11px;
}
.aph-item-status.ok {
  color: var(--ok, var(--text-dim));
}
.aph-item-status.bad,
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
