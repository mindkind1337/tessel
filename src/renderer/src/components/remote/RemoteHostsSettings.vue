<script setup>
// Settings > Remote Hosts > SSH Hosts, ported from Orca's SshPane.tsx and
// SshTargetCard.tsx (MIT, Copyright (c) 2026 Lovecast Inc.). Hosts found in
// ~/.ssh/config are synced when the page opens (Import brings back the ones
// you removed); Connect opens a terminal pane running ssh on the host.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Plus, Upload, Server, ServerOff, Pencil, Trash2, MonitorSmartphone, LoaderCircle } from 'lucide-vue-next'
import ConfirmDialog from '../ConfirmDialog.vue'
import RemoteHostForm from './RemoteHostForm.vue'
import { t } from '../../i18n'
import {
  remoteHostsState,
  syncRemoteHosts,
  refreshRemoteHosts,
  connectRemoteHost,
  disconnectRemoteHost,
  hostStatus,
  hostError,
  statusLabel,
  statusTone,
  isConnectingStatus,
  endpointOf,
  emptyForm,
  formFromTarget,
  buildSavePayload,
  remoteErrorText
} from '../../remoteHosts'
import './remoteHosts.css'

const targets = computed(() => remoteHostsState.targets)
const formOpen = ref(false)
const editingId = ref(null)
const formInitial = ref(emptyForm())
const formError = ref('')
const saving = ref(false)
const testing = ref({})
const busy = ref({}) // id -> 'connect' | 'disconnect' | 'remove'
const pendingRemove = ref(null)
const notice = ref({ text: '', tone: '' })
let noticeTimer = null
let alive = true

function api() {
  return window.shellApi && window.shellApi.remoteHosts
}

function say(text, tone = '') {
  notice.value = { text, tone }
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    if (alive) notice.value = { text: '', tone: '' }
  }, 6000)
}

onMounted(() => syncRemoteHosts())
onBeforeUnmount(() => {
  alive = false
  clearTimeout(noticeTimer)
})

function openAdd() {
  editingId.value = null
  formInitial.value = emptyForm()
  formError.value = ''
  formOpen.value = true
}
function openEdit(target) {
  editingId.value = target.id
  formInitial.value = formFromTarget(target)
  formError.value = ''
  formOpen.value = true
}
function closeForm() {
  formOpen.value = false
  editingId.value = null
}

async function save(form) {
  const payload = buildSavePayload(form)
  if (!payload.ok) {
    formError.value = payload.error
    return
  }
  if (saving.value || !api()) return
  saving.value = true
  formError.value = ''
  try {
    const res = editingId.value ? await api().update(editingId.value, payload.target) : await api().add(payload.target)
    if (!alive) return
    if (!res || !res.ok) {
      formError.value = remoteErrorText(res && res.error, t('remote.pane.saveFailed', 'Failed to save target'))
      return
    }
    say(editingId.value ? t('remote.pane.updated', 'Target updated') : t('remote.pane.added', 'Target added'), 'ok')
    closeForm()
    await refreshRemoteHosts()
  } catch {
    if (alive) formError.value = t('remote.pane.saveFailed', 'Failed to save target')
  } finally {
    if (alive) saving.value = false
  }
}

async function importConfig() {
  if (!api()) return
  try {
    const res = await api().importConfig(true)
    if (!alive) return
    if (!res || !res.ok) {
      say(t('remote.pane.importFailed', 'Import failed'), 'bad')
      return
    }
    const n = (res.targets || []).length
    if (n === 0) say(t('remote.pane.inSync', '~/.ssh/config already in sync'))
    else if (n === 1) say(t('remote.pane.synced_one', 'Synced {{count}} server', { count: n }), 'ok')
    else say(t('remote.pane.synced', 'Synced {{count}} servers', { count: n }), 'ok')
    await refreshRemoteHosts()
  } catch {
    if (alive) say(t('remote.pane.importFailed', 'Import failed'), 'bad')
  }
}

async function test(target) {
  if (!api() || testing.value[target.id]) return
  testing.value = { ...testing.value, [target.id]: true }
  try {
    const res = await api().test(target.id)
    if (!alive) return
    if (res && res.success) say(t('remote.pane.testOk', 'Connection successful'), 'ok')
    else say((res && res.error) || t('remote.pane.testFailed', 'Connection test failed'), 'bad')
  } catch {
    if (alive) say(t('remote.pane.testError', 'Test failed'), 'bad')
  } finally {
    if (alive) {
      const next = { ...testing.value }
      delete next[target.id]
      testing.value = next
    }
  }
}

async function run(target, action, fn) {
  if (busy.value[target.id]) return
  busy.value = { ...busy.value, [target.id]: action }
  try {
    await fn()
  } finally {
    if (alive) {
      const next = { ...busy.value }
      delete next[target.id]
      busy.value = next
    }
  }
}

function connect(target) {
  return run(target, 'connect', async () => {
    const ok = await connectRemoteHost(target).catch(() => false)
    if (!ok && alive) say(t('remote.pane.connectFailed', 'Connection failed'), 'bad')
  })
}
function disconnect(target) {
  return run(target, 'disconnect', async () => {
    const res = await disconnectRemoteHost(target.id).catch(() => null)
    if ((!res || !res.ok) && alive) say(t('remote.pane.disconnectFailed', 'Disconnect failed'), 'bad')
  })
}

async function onRemoveAnswer(answer) {
  const target = pendingRemove.value
  pendingRemove.value = null
  if (!answer || !target || !api()) return
  await run(target, 'remove', async () => {
    const res = await api().remove(target.id).catch(() => null)
    if (!alive) return
    if (res && res.ok) say(t('remote.pane.removed', 'Target removed'), 'ok')
    else say(remoteErrorText(res && res.error, t('remote.pane.removeFailed', 'Failed to remove target')), 'bad')
    await refreshRemoteHosts()
  })
}

function subtitle(target) {
  return target.identityFile ? `${endpointOf(target)} • ${target.identityFile}` : endpointOf(target)
}
</script>

<template>
  <div class="rh-pane" data-test="remote-hosts">
    <div class="rh-head">
      <div>
        <p class="rh-head-title">{{ t('remote.pane.title', 'SSH hosts') }}</p>
        <p class="rh-head-desc">
          {{ t('remote.pane.description', 'Add an existing machine over SSH so projects and workspaces can run there.') }}
        </p>
      </div>
      <div class="rh-head-actions">
        <button type="button" class="rh-btn" data-test="remote-import" @click="importConfig">
          <Upload :size="12" aria-hidden="true" />
          {{ t('remote.pane.import', 'Import') }}
        </button>
        <button type="button" class="rh-btn" data-test="remote-add" @click="openAdd">
          <Plus :size="12" aria-hidden="true" />
          {{ t('remote.pane.addTarget', 'Add Target') }}
        </button>
      </div>
    </div>

    <p v-if="notice.text" class="rh-notice" :class="notice.tone" role="status">{{ notice.text }}</p>
    <p v-if="remoteHostsState.error" class="rh-notice bad" role="alert">{{ remoteHostsState.error }}</p>

    <div v-if="!targets.length" class="rh-empty">{{ t('remote.pane.empty', 'No SSH targets configured.') }}</div>
    <div v-else class="rh-list">
      <div
        v-for="target in targets"
        :key="target.id"
        class="rh-card"
        data-ssh-target-card
        :data-ssh-target-label="target.label"
      >
        <Server :size="16" class="rh-card-icon" aria-hidden="true" />
        <div class="rh-card-main">
          <div class="rh-card-title">
            <span class="rh-card-label">{{ target.label }}</span>
            <span class="rh-dot" :class="'rh-dot-' + statusTone(hostStatus(target.id))" aria-hidden="true"></span>
            <span class="rh-card-status">{{ statusLabel(hostStatus(target.id)) }}</span>
            <span v-if="target.source === 'ssh-config'" class="rh-card-source">· {{ t('remote.card.fromConfig', 'from ~/.ssh/config') }}</span>
          </div>
          <p class="rh-card-endpoint">{{ subtitle(target) }}</p>
          <p v-if="hostError(target.id)" class="rh-card-error">{{ hostError(target.id) }}</p>
        </div>
        <div class="rh-card-actions">
          <button
            type="button"
            class="rh-icon-btn"
            :disabled="!!busy[target.id]"
            :aria-label="t('remote.card.edit', 'Edit target')"
            :title="t('remote.card.edit', 'Edit target')"
            @click="openEdit(target)"
          >
            <Pencil :size="12" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="rh-icon-btn danger"
            :disabled="!!busy[target.id]"
            :aria-label="busy[target.id] === 'remove' ? t('remote.card.removing', 'Removing target') : t('remote.card.remove', 'Remove target')"
            :title="t('remote.card.remove', 'Remove target')"
            @click="pendingRemove = target"
          >
            <LoaderCircle v-if="busy[target.id] === 'remove'" :size="12" class="rh-spin" aria-hidden="true" />
            <Trash2 v-else :size="12" aria-hidden="true" />
          </button>
          <template v-if="hostStatus(target.id) === 'connected'">
            <button type="button" class="rh-btn ghost" :disabled="!!busy[target.id]" @click="disconnect(target)">
              <ServerOff :size="12" aria-hidden="true" />
              {{ t('remote.card.disconnect', 'Disconnect') }}
            </button>
          </template>
          <template v-else-if="isConnectingStatus(hostStatus(target.id))">
            <button type="button" class="rh-btn ghost" disabled>
              <LoaderCircle :size="12" class="rh-spin" aria-hidden="true" />
              {{ t('remote.card.connecting', 'Connecting') }}
            </button>
          </template>
          <template v-else>
            <button
              type="button"
              class="rh-btn ghost"
              data-test="remote-test"
              :disabled="!!testing[target.id] || !!busy[target.id]"
              @click="test(target)"
            >
              <LoaderCircle v-if="testing[target.id]" :size="12" class="rh-spin" aria-hidden="true" />
              <MonitorSmartphone v-else :size="12" aria-hidden="true" />
              {{ t('remote.card.test', 'Test') }}
            </button>
            <button
              type="button"
              class="rh-btn ghost"
              data-test="remote-connect"
              :disabled="!!busy[target.id]"
              @click="connect(target)"
            >
              <LoaderCircle v-if="busy[target.id] === 'connect'" :size="12" class="rh-spin" aria-hidden="true" />
              <Server v-else :size="12" aria-hidden="true" />
              {{ t('remote.card.connect', 'Connect') }}
            </button>
          </template>
        </div>
      </div>
    </div>

    <RemoteHostForm
      v-if="formOpen"
      :key="editingId || 'new'"
      :initial="formInitial"
      :editing="!!editingId"
      :saving="saving"
      :error="formError"
      @save="save"
      @close="closeForm"
    />
    <ConfirmDialog
      v-if="pendingRemove"
      :title="t('remote.remove.title', 'Remove SSH Target')"
      :text="t('remote.remove.description', 'This will remove the target and end any active remote terminals.') + ' ' + pendingRemove.label"
      :confirm-label="t('remote.remove.confirm', 'Remove')"
      danger
      @answer="onRemoveAnswer"
    />
  </div>
</template>
