<script setup>
// After Orca's NativeChatStructuredSessionStatus.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// The lines above the composer: the agent still starting (messages wait),
// the session's or the composer's error, and the background-task dock.
// Props: sessionId, agentLabel, startupPhase ('starting' | 'ready' | null),
//   error, composerError, isVisible, backgroundTasks (the session's view:
//   { show, isMonitoring, tasks, settledTasks, supportsStop, supportsStopAll }),
//   stopBackgroundTask(taskId?) -> Promise.
import { computed, ref } from 'vue'
import { t } from '../../../i18n'

// Lot 4's dock. Looked up so this line works before it lands (then no dock:
// Tessel's engine has no background tasks yet). TODO(lead): a plain import
// once NativeChatBackgroundTasksStatus.vue is there.
const dockModules = import.meta.glob('./NativeChatBackgroundTasksStatus.vue', { eager: true, import: 'default' })
const NativeChatBackgroundTasksStatus = dockModules['./NativeChatBackgroundTasksStatus.vue'] || null

const props = defineProps({
  sessionId: { type: String, default: '' },
  agentLabel: { type: String, required: true },
  startupPhase: { type: String, default: null },
  error: { type: String, default: null },
  composerError: { type: String, default: null },
  isVisible: { type: Boolean, default: true },
  backgroundTasks: {
    type: Object,
    default: () => ({ show: false, isMonitoring: false, tasks: [], settledTasks: [], supportsStop: false, supportsStopAll: false })
  },
  stopBackgroundTask: { type: Function, default: async () => undefined }
})

const NO_STOPPING_TASKS = new Set()
// { sessionId, taskIds, all } while stops are on their way (per session).
const stopping = ref(null)
const expanded = ref(null)
const activeStopping = computed(() => (stopping.value?.sessionId === props.sessionId ? stopping.value : null))

function onStop(taskId) {
  const sessionId = props.sessionId
  const current = stopping.value
  const taskIds = new Set(current?.sessionId === sessionId ? current.taskIds : NO_STOPPING_TASKS)
  if (taskId) taskIds.add(taskId)
  stopping.value = { sessionId, taskIds, all: taskId ? current?.sessionId === sessionId && current.all : true }
  let call
  try {
    call = Promise.resolve(props.stopBackgroundTask(taskId))
  } catch (err) {
    call = Promise.reject(err)
  }
  call
    .catch(() => {})
    .finally(() => {
      const now = stopping.value
      if (now?.sessionId !== sessionId) return
      const left = new Set(now.taskIds)
      if (taskId) left.delete(taskId)
      const all = taskId ? now.all : false
      stopping.value = left.size === 0 && !all ? null : { sessionId, taskIds: left, all }
    })
}
function onExpandedChange(value) {
  expanded.value = { sessionId: props.sessionId, expanded: value }
}
const startingText = computed(() =>
  t('chat.orca.sessionStatus.starting', '{{value0}} is still starting. Messages wait until it is ready; close this chat to give up on it.', {
    value0: props.agentLabel
  })
)
</script>

<template>
  <p v-if="startupPhase === 'starting'" class="nc-session-status" data-test="chat-session-starting">{{ startingText }}</p>
  <p v-if="error || composerError" class="nc-session-status nc-session-status--error" data-test="chat-session-error">{{ error ?? composerError }}</p>
  <component
    :is="NativeChatBackgroundTasksStatus"
    v-if="backgroundTasks.show && NativeChatBackgroundTasksStatus"
    :is-visible="isVisible"
    :tasks="backgroundTasks.tasks"
    :settled-tasks="backgroundTasks.settledTasks"
    :indicator-active="backgroundTasks.isMonitoring"
    :supports-task-stop="backgroundTasks.supportsStop"
    :supports-stop-all="backgroundTasks.supportsStopAll"
    :stopping-task-ids="activeStopping?.taskIds ?? NO_STOPPING_TASKS"
    :stopping-all="activeStopping?.all ?? false"
    :expanded="expanded?.sessionId === sessionId && expanded.expanded"
    @expanded-change="onExpandedChange"
    @stop="onStop"
  />
</template>

<style scoped>
/* mx-auto w-full max-w-4xl px-4 py-1 text-xs text-muted-foreground */
.nc-session-status {
  box-sizing: border-box;
  width: 100%;
  max-width: 56rem;
  margin: 0 auto;
  padding: 4px 16px;
  color: var(--nc-muted-foreground);
  font-size: 12px;
  line-height: 16px;
}
.nc-session-status--error {
  color: var(--nc-destructive);
}
</style>
