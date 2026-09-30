<script setup>
// A terminal agent's conversation as a chat, read-only: for the agents with
// no chat protocol of their own (Grok, OpenClaude, OMP), after Orca's
// transcript-view native chat (NativeChatResolvedView.tsx and its transcript
// watch, MIT, Copyright (c) 2026 Lovecast Inc.). The main process reads the
// agent's session file (src/main/chat/transcriptView.js) and sends it again
// while the agent writes; the chat's list shows it. Typing stays in the
// terminal: there is no composer here.
// Props: agent ('grok' | 'openclaude' | 'omp'), sessionId, agentName,
//   isVisible (the file is watched only while the view shows).
// Emits: close (back to the terminal).
import { computed, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue'
import { MessagesSquare, SquareTerminal } from 'lucide-vue-next'
import './orca-tokens.css'
import NativeChatEmptyState from './NativeChatEmptyState.vue'
import NativeChatMessageList from './NativeChatMessageList.vue'
import { Button } from './ui/index.js'
import { createJournalAdapter } from '../../../chat/orca/adapter/journalAdapter.js'
import { reduceStructuredAgentSession, EMPTY_STRUCTURED_AGENT_SESSION } from '../../../chat/orca/shared/structured-agent-session-reducer.js'
import { projectStructuredAgentSessionMessages } from '../../../chat/orca/structured-agent-session-message-projection.js'
import { useNativeChatLinkActions } from '../../../chat/orca/composables/use-native-chat-link-actions.js'
import { t } from '../../../i18n'

const props = defineProps({
  agent: { type: String, required: true },
  sessionId: { type: String, required: true },
  agentName: { type: String, default: '' },
  // The pane the view covers (its folder bounds the file links).
  node: { type: Object, default: null },
  isVisible: { type: Boolean, default: true }
})
const emit = defineEmits(['close'])

// A session file appears with the agent's first message: looked for again
// meanwhile, while the view shows.
const RETRY_MS = 3000

const rootRef = ref(null)
const phase = ref('loading') // loading | ready | missing | error
const state = shallowRef(EMPTY_STRUCTURED_AGENT_SESSION)
const truncated = ref(false)
let viewId = null
let opening = false
let off = null
let retry = null
let alive = true

function api() {
  const a = typeof window !== 'undefined' && window.shellApi ? window.shellApi.transcriptView : null
  return a && typeof a.open === 'function' ? a : null
}

// The whole conversation again (the main process re-reads the file's tail).
function show(events) {
  const adapter = createJournalAdapter({ now: () => 0 })
  adapter.replay(events || [])
  state.value = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, { type: 'event', event: adapter.snapshotEvent() }, 0)
}

function stopRetry() {
  if (retry) clearTimeout(retry)
  retry = null
}
async function openView() {
  stopRetry()
  const a = api()
  if (!a || viewId || opening) {
    if (!a) phase.value = 'error'
    return
  }
  let res
  opening = true
  try {
    res = await a.open({ agent: props.agent, sessionId: props.sessionId })
  } catch {
    res = { ok: false, code: 'error' }
  } finally {
    opening = false
  }
  if (!alive) {
    if (res && res.ok) a.close({ viewId: res.viewId })
    return
  }
  if (!props.isVisible) {
    if (res && res.ok) a.close({ viewId: res.viewId })
    return
  }
  if (!res || !res.ok) {
    phase.value = res && res.code === 'missing' ? 'missing' : 'error'
    if (phase.value === 'missing') retry = setTimeout(openView, RETRY_MS)
    return
  }
  viewId = res.viewId
  truncated.value = !!res.truncated
  show(res.events)
  phase.value = 'ready'
}
function closeView() {
  stopRetry()
  const a = api()
  if (a && viewId) a.close({ viewId })
  viewId = null
}

onMounted(() => {
  const a = api()
  if (a && typeof a.onEvent === 'function') {
    const unsubscribe = a.onEvent((msg) => {
      if (!msg || msg.viewId !== viewId || !viewId) return
      if (msg.ok) {
        truncated.value = !!msg.truncated
        show(msg.events)
        phase.value = 'ready'
      }
    })
    if (typeof unsubscribe === 'function') off = unsubscribe
  }
  if (props.isVisible) openView()
})
onBeforeUnmount(() => {
  alive = false
  closeView()
  if (off) off()
})
// Watched only while it shows.
watch(
  () => props.isVisible,
  (visible) => {
    if (visible) openView()
    else closeView()
  }
)

const messages = computed(() => projectStructuredAgentSessionMessages(state.value.items, [], state.value.submissions))
const session = computed(() => ({
  messages: messages.value,
  status: messages.value.length ? 'ready' : 'empty',
  sessionId: props.sessionId,
  agent: props.agent,
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: async () => 'unchanged',
  readPhase: 'ready'
}))
const fileLinkContext = computed(() => {
  const n = props.node
  const folder = n && (n.startDir || n.cwd || n.projectDir)
  return folder ? { worktreeId: n.id, worktreePath: folder, roots: [folder, n.projectDir].filter(Boolean) } : null
})
const { onLinkClick } = useNativeChatLinkActions(fileLinkContext, rootRef, () => ({ isVisible: props.isVisible }))
provide('nativeChatFileLinkContext', fileLinkContext)

const title = computed(() => t('chat.orca.transcriptView.title', 'Conversation of {{agent}}', { agent: props.agentName || props.agent }))
</script>

<template>
  <div ref="rootRef" class="nc-root nc-transcript-view" data-test="transcript-view">
    <div class="nc-transcript-head">
      <MessagesSquare class="nc-transcript-icon" aria-hidden="true" />
      <span class="nc-transcript-title">{{ title }}</span>
      <span class="nc-transcript-note">{{ t('chat.orca.transcriptView.readOnly', 'Read only: type in the terminal') }}</span>
      <span v-if="truncated" class="nc-transcript-note" data-test="transcript-view-truncated">{{ t('chat.orca.transcriptView.truncated', 'Latest part only') }}</span>
      <Button variant="ghost" size="sm" class="nc-transcript-back" data-test="transcript-view-close" @click="emit('close')">
        <SquareTerminal />
        {{ t('chat.orca.transcriptView.back', 'Back to terminal') }}
      </Button>
    </div>
    <div class="nc-transcript-body">
      <NativeChatEmptyState v-if="phase === 'loading'" kind="loading" />
      <div v-else-if="phase === 'missing'" class="nc-transcript-state" data-test="transcript-view-missing">
        <NativeChatEmptyState kind="empty" :agent="agent" />
        <p>{{ t('chat.orca.transcriptView.missing', 'No conversation file yet: it appears with the first message.') }}</p>
      </div>
      <div v-else-if="phase === 'error'" class="nc-transcript-state" data-test="transcript-view-error">
        <NativeChatEmptyState kind="error" :message="t('chat.orca.transcriptView.error', 'The conversation could not be read.')" />
      </div>
      <NativeChatEmptyState v-else-if="!messages.length" kind="empty" :agent="agent" />
      <NativeChatMessageList
        v-else
        :session="session"
        :journal-items="state.items"
        :is-visible="isVisible"
        :is-working="false"
        :expand-signal="false"
        :show-live-turn-activity="false"
        :on-link-click="onLinkClick"
        :allow-file-uri-links="true"
      />
    </div>
  </div>
</template>

<style scoped>
.nc-transcript-view {
  display: flex;
  height: 100%;
  min-height: 0;
  width: 100%;
  flex-direction: column;
  font-size: 14px;
}
.nc-transcript-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 12px;
  border-bottom: 1px solid var(--nc-border);
  background: color-mix(in srgb, var(--nc-muted) 60%, transparent);
  font-size: 12px;
}
.nc-transcript-icon {
  width: 14px;
  height: 14px;
  color: var(--nc-muted-foreground);
}
.nc-transcript-title {
  font-weight: 500;
  white-space: nowrap;
}
.nc-transcript-note {
  min-width: 0;
  overflow: hidden;
  color: var(--nc-muted-foreground);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-transcript-back {
  margin-left: auto;
}
.nc-transcript-body {
  display: flex;
  min-height: 0;
  flex: 1 1 0%;
  flex-direction: column;
}
.nc-transcript-state {
  display: flex;
  flex: 1 1 0%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--nc-muted-foreground);
  font-size: 12px;
}
</style>
