<script setup>
// The small "remote" badge above Files and Changes for a project on an SSH
// host: the host and the folder, and what its session is doing (connecting,
// reading, saving, pushing…) with a Cancel button while an operation runs
// (it ends the session; the next operation starts a new one). The session
// itself lives in the main process (src/main/remoteFs.js).
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { Server, Loader2, X } from 'lucide-vue-next'
import { t } from '../../i18n'

const props = defineProps({
  hostId: { type: String, default: '' },
  host: { type: String, default: '' },
  path: { type: String, default: '' }
})

const activity = ref(null) // { state, pending, op }
// Shown only when an operation lasts: no flicker for quick ones.
const slow = ref(false)
let slowTimer = 0
let stop = null

function opLabel(op) {
  switch (op) {
    case 'list':
      return t('project.remote.op.list', 'Reading the folder…')
    case 'read':
      return t('project.remote.op.read', 'Reading the file…')
    case 'save':
      return t('project.remote.op.save', 'Saving…')
    case 'status':
      return t('project.remote.op.status', 'Reading git status…')
    case 'search':
      return t('project.remote.op.search', 'Searching…')
    case 'commit':
      return t('project.remote.op.commit', 'Committing…')
    case 'push':
      return t('project.remote.op.push', 'Pushing…')
    case 'pull':
      return t('project.remote.op.pull', 'Pulling…')
    case 'fetch':
      return t('project.remote.op.fetch', 'Fetching…')
    default:
      return t('project.remote.op.working', 'Working on the host…')
  }
}

const busy = computed(() => !!activity.value && (activity.value.state === 'connecting' || activity.value.state === 'busy'))
const label = computed(() => {
  const a = activity.value
  if (!a) return ''
  if (a.state === 'connecting') return t('project.remote.connecting', 'Connecting to {{host}}…', { host: props.host })
  return opLabel(a.op)
})

watch(busy, (b) => {
  clearTimeout(slowTimer)
  if (!b) slow.value = false
  else slowTimer = setTimeout(() => (slow.value = true), 400)
})

function cancel() {
  if (window.shellApi && window.shellApi.remoteFs) window.shellApi.remoteFs.cancel(props.hostId).catch(() => {})
}

onMounted(() => {
  const api = window.shellApi && window.shellApi.remoteFs
  if (!api) return
  stop = api.onActivity((a) => {
    if (a && a.hostId === props.hostId) activity.value = a.state === 'closed' ? null : a
  })
  api
    .state()
    .then((r) => {
      const s = r && r.sessions && r.sessions[props.hostId]
      if (s && !activity.value) activity.value = s
    })
    .catch(() => {})
})
onBeforeUnmount(() => {
  if (stop) stop()
  clearTimeout(slowTimer)
})
</script>

<template>
  <div class="rb" data-test="remote-badge">
    <span class="rb-tag" :title="t('project.remote.badgeHint', 'Files and changes of this project are on {{host}}, read over SSH.', { host })">
      <Server :size="12" aria-hidden="true" />
      {{ t('project.remote.badge', 'Remote') }}
    </span>
    <span class="rb-where" :title="`${host}:${path}`">{{ host }}<template v-if="path">:{{ path }}</template></span>
    <template v-if="busy && slow">
      <span class="rb-busy" role="status" data-test="remote-busy">
        <Loader2 :size="12" class="rb-spin" aria-hidden="true" />
        <span class="rb-label">{{ label }}</span>
      </span>
      <button
        type="button"
        class="rb-cancel"
        :title="t('project.remote.cancel', 'Cancel (ends the connection)')"
        :aria-label="t('project.remote.cancel', 'Cancel (ends the connection)')"
        data-test="remote-cancel"
        @click="cancel"
      >
        <X :size="12" aria-hidden="true" />
      </button>
    </template>
  </div>
</template>

<style scoped>
.rb {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 2px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 11px;
  overflow: hidden;
}
.rb-tag {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-hover, rgba(127, 127, 127, 0.15));
  color: var(--text-strong);
  font-weight: 500;
}
.rb-where {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rb-busy {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  max-width: 50%;
}
.rb-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rb-spin {
  animation: rb-spin 1s linear infinite;
}
@keyframes rb-spin {
  to {
    transform: rotate(360deg);
  }
}
.rb-cancel {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.rb-cancel:hover {
  background: var(--bg-hover, rgba(127, 127, 127, 0.2));
  color: var(--text-strong);
}
</style>
