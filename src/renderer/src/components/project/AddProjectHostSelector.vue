<script setup>
// The "Host" picker at the top of Add a project (Orca's AddRepoHostSelector,
// MIT, Copyright (c) 2026 Lovecast Inc.): this computer and the saved SSH
// hosts; "Add remote host" opens Settings > SSH Hosts. An SSH host that is
// not signed in has its Connect (Retry after an error) action in its row;
// picking that row connects too. The dialog selects it once connected.
// Each row is one compact line pair on one grid, like VS Code's quick pick:
// a status dot (green connected, grey disconnected, yellow connecting, red
// error) and the icon; the name, then user@host[:port] · its default folder
// (two saved hosts on one IP stay apart), or the error in red; on the
// right one action, centered: Connect (Retry) or a Connected tag. The
// status word itself is in the tooltip and the row's aria-label.
// The list is teleported to <body> with fixed coordinates (as ThemedSelect):
// it overflows the dialog instead of growing a scrollbar in it, opens below
// or above the trigger, whichever fits, and scrolls only when taller than
// the window. It is as wide as the dialog's content (460 to 640 px, never
// wider than the window). It sits just above the dialog (460) and under
// the SSH sign-in prompt, which closes it (AddProjectDialog).
import { ref, computed, onBeforeUnmount, nextTick } from 'vue'
import { Check, ChevronRight, ChevronsUpDown, LoaderCircle, Monitor, Plus, Server } from 'lucide-vue-next'
import { t } from '../../i18n'
import { canConnectHost } from '../../addProject'
import { statusLabel, statusTone, connectVerb } from '../../remoteHosts'
import { hostListWidth } from '../../remoteHostDisplay'

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
  // As wide as the picker's row (the dialog's content), else the trigger.
  const row = root.value ? root.value.getBoundingClientRect() : null
  const anchor = row && row.width > 0 ? row : r
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = hostListWidth(anchor.width, vw, { margin: MARGIN })
  const left = Math.max(MARGIN, Math.min(anchor.left, vw - width - MARGIN))
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
// The dot's tone: ok (green), busy (yellow), bad (red), off (grey).
function tone(host) {
  if (!host || host.kind === 'local') return 'local'
  if (host.status === 'error' || host.error) return statusTone(host.status) === 'busy' ? 'busy' : 'bad'
  return statusTone(host.status)
}
function hasError(host) {
  return !!host && host.kind !== 'local' && tone(host) === 'bad' && !!host.error
}
// For screen readers: name, address · folder, status (and the error).
function ariaLabel(host) {
  return tooltip(host).split('\n').join(', ')
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
            <span class="aph-dot-slot" aria-hidden="true"></span>
            <Plus :size="14" class="aph-icon" aria-hidden="true" />
            <span class="aph-item-body">
              <span class="aph-item-title">{{ t('project.host.addRemote', 'Add remote host') }}</span>
              <span class="aph-item-detail">{{ t('project.host.addSshDetail', 'Use an existing machine over SSH.') }}</span>
            </span>
            <span class="aph-action">
              <ChevronRight :size="14" class="aph-icon" aria-hidden="true" />
            </span>
          </button>
          <button
            v-for="host in hosts"
            :key="host.id"
            type="button"
            role="option"
            class="aph-item"
            :class="{ on: host.id === selectedId }"
            :aria-selected="host.id === selectedId"
            :aria-label="ariaLabel(host)"
            :title="tooltip(host)"
            data-host-item
            :data-test="'host-' + host.id"
            @click="pick(host)"
          >
            <span class="aph-dot-slot">
              <span
                v-if="host.kind !== 'local'"
                class="aph-dot"
                :class="'tone-' + tone(host)"
                :data-tone="tone(host)"
                :data-test="'host-status-' + host.id"
                ><span class="aph-sr">{{ statusText(host) }}</span></span
              >
            </span>
            <component :is="host.kind === 'local' ? Monitor : Server" :size="14" class="aph-icon" aria-hidden="true" />
            <span class="aph-item-body">
              <span class="aph-item-title" :data-test="'host-title-' + host.id">{{ host.label }}</span>
              <span v-if="hasError(host)" class="aph-item-detail bad" :data-test="'host-error-' + host.id">{{ host.error }}</span>
              <span v-else-if="subtitle(host)" class="aph-item-detail" :data-test="'host-sub-' + host.id">{{ subtitle(host) }}</span>
            </span>
            <span class="aph-action" :data-test="'host-action-' + host.id">
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
              <span v-else-if="host.kind !== 'local'" class="aph-tag" :data-test="'host-connected-' + host.id">{{ statusText(host) }}</span>
              <Check v-if="host.id === selectedId" :size="14" class="aph-icon aph-check" aria-hidden="true" />
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
  /* Just above the Add a project dialog (460), under the SSH sign-in
     prompt (remoteHosts.css .ssh-cred-backdrop), menus and tooltips. */
  z-index: 465;
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface-2);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
/* One grid for every row: dot, icon, name + detail, action. */
.aph-item {
  display: grid;
  grid-template-columns: 8px 14px minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 10px;
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  padding: 5px 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-strong);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  text-align: left;
  cursor: pointer;
}
.aph-item + .aph-item {
  margin-top: 1px;
}
.aph-item:hover,
.aph-item:focus-visible {
  background: var(--surface-3);
  outline: none;
}
.aph-item.on {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.aph-item.on:hover,
.aph-item.on:focus-visible {
  background: color-mix(in srgb, var(--accent) 18%, var(--surface-3));
}
.aph-item:focus-visible {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
}
.aph-add {
  color: var(--text-dim);
}
.aph-add .aph-item-title {
  color: var(--text-strong);
}
.aph-dot-slot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 8px;
  height: 8px;
}
.aph-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim);
  opacity: 0.6;
}
.aph-dot.tone-ok {
  background: var(--ok, #10b981);
  opacity: 1;
}
.aph-dot.tone-busy {
  background: var(--warn, #eab308);
  opacity: 1;
}
.aph-dot.tone-bad {
  background: var(--danger, #ef4444);
  opacity: 1;
}
.aph-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.aph-icon {
  flex-shrink: 0;
  color: var(--text-dim);
}
.aph-check {
  color: var(--accent);
}
.aph-item-body {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  min-width: 0;
}
.aph-item-title {
  display: block;
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aph-item-detail {
  display: block;
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aph-item-detail.bad {
  color: var(--danger);
}
.aph-action {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}
.aph-connect,
.aph-tag {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  height: 22px;
  padding: 0 8px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}
.aph-connect {
  border: 1px solid var(--border-strong);
  background: var(--surface-3);
  color: var(--text-strong);
  cursor: pointer;
}
.aph-connect:hover {
  border-color: color-mix(in srgb, var(--accent) 60%, var(--border-strong));
  background: color-mix(in srgb, var(--accent) 16%, var(--surface-3));
}
.aph-connect.busy {
  color: var(--text-dim);
  cursor: default;
}
.aph-connect.busy:hover {
  border-color: var(--border-strong);
  background: var(--surface-3);
}
.aph-tag {
  border: 1px solid color-mix(in srgb, var(--ok, #10b981) 35%, transparent);
  background: color-mix(in srgb, var(--ok, #10b981) 12%, transparent);
  color: var(--ok, #10b981);
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
