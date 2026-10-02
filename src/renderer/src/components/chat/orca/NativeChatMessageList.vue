<script setup>
// After Orca's NativeChatMessageList.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * The transcript: a windowed (virtualized) list of the session's rows, the live
 * turn's activity line, the older-history row, the message rail, "Jump to
 * latest", and the pinned task list above the composer.
 *
 * Props:
 *   session — { messages, status, sessionId, agent, hasMore, loadingEarlier,
 *     olderHistoryGeneration, loadEarlier() → Promise<'applied' | 'unchanged' |
 *     'failed' | …>, readPhase ('loading' | 'ready' | 'error'),
 *     transcriptLifecycle? } (the reference's NativeChatLiveSession; a plain
 *     object rebuilt by a computed, or a reactive object).
 *   journalItems (structured sessions), railOutline (user messages older than
 *   the loaded window), isVisible (true), isWorking, expandSignal, fontScale (1),
 *   workingStartedAt, settledTurns, onLinkClick (function, passed to the rows),
 *   allowFileUriLinks, failedDeliveryMessageIds (Set), showTurnStatus (true),
 *   showLiveTurnActivity (true), turnActivity, runtimeContext.
 * It never moves the focus by itself (the rail list takes it only when the
 * reader opens it).
 */
import { computed, shallowRef, watch } from 'vue'
import { ArrowDown } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { createNativeChatMessageListProjection } from '../../../chat/orca/native-chat-message-list-projection.js'
import { structuredQuestionTranscript } from '../../../chat/orca/structured-agent-question-projection.js'
import { nativeChatTaskListState } from '../../../chat/orca/native-chat-task-list-state.js'
import { nativeChatTaskListPredecessors } from '../../../chat/orca/native-chat-task-list-history.js'
import { projectNativeChatTaskListFrames } from '../../../chat/orca/native-chat-task-list-frames.js'
import { omitNativeChatThreadGoalRows } from '../../../chat/orca/native-chat-thread-goal-rows.js'
import { shouldShowNativeChatTypingIndicator } from '../../../chat/orca/native-chat-typing-indicator.js'
import {
  buildNativeChatTranscriptSlots,
  nativeChatSlotIndexOf
} from '../../../chat/orca/native-chat-transcript-slots.js'
import { nativeChatReaderScrollInputHandlers } from '../../../chat/orca/native-chat-reader-scroll-input.js'
import { nativeChatTurnDiffs } from '../../../chat/orca/native-chat-turn-diffs.js'
import { isStructuredAgentSessionThinking } from '../../../chat/orca/shared/structured-agent-session-live-turn.js'
import { provideNativeChatDisclosures } from '../../../chat/orca/composables/native-chat-disclosure-store.js'
import { useNativeChatTurnStatus } from '../../../chat/orca/composables/use-native-chat-turn-status.js'
import { useNativeChatTranscriptWindow } from '../../../chat/orca/composables/use-native-chat-transcript-window.js'
import { useNativeChatTranscriptScroll } from '../../../chat/orca/composables/use-native-chat-transcript-scroll.js'
import { useNativeChatOlderHistoryAutoload } from '../../../chat/orca/composables/use-native-chat-older-history-autoload.js'
import { useNativeChatMessageRail } from '../../../chat/orca/composables/use-native-chat-message-rail.js'
import { useNativeChatRailHistoryJump } from '../../../chat/orca/composables/use-native-chat-rail-history-jump.js'
import NativeChatTaskList from './NativeChatTaskList.vue'
import NativeChatTypingIndicatorRow from './NativeChatTypingIndicatorRow.vue'
import NativeChatTurnActivityLine from './NativeChatTurnActivityLine.vue'
import NativeChatTranscriptItems from './NativeChatTranscriptItems.vue'
import NativeChatOlderHistoryRow from './NativeChatOlderHistoryRow.vue'
import NativeChatMessageRail from './NativeChatMessageRail.vue'

const MAX_EXPANDED_TURNS = 128

const props = defineProps({
  session: { type: Object, required: true },
  journalItems: { type: Array, default: undefined },
  /** User messages older than the loaded window, from the host's outline. */
  railOutline: { type: Array, default: null },
  isVisible: { type: Boolean, default: true },
  isWorking: { type: Boolean, default: false },
  /** Toolbar-driven desired open state for every tool run; each flip re-syncs. */
  expandSignal: { type: Boolean, default: false },
  /** Chat-only text multiplier (1 = default), driven by the zoom shortcuts. */
  fontScale: { type: Number, default: 1 },
  workingStartedAt: { type: Number, default: null },
  /** Host-recorded turn durations keyed by user message id (structured lane). */
  settledTurns: { type: null, default: null },
  onLinkClick: { type: Function, default: undefined },
  allowFileUriLinks: { type: Boolean, default: false },
  failedDeliveryMessageIds: { type: Set, default: undefined },
  // Tessel: user messages waiting in the engine's queue ("Queued" chip); a
  // Map gives each one the reason it waits (the chat view over a terminal).
  queuedMessageIds: { type: [Set, Map], default: undefined },
  // Tessel: each change scrolls to the latest message (a message just sent).
  scrollToLatestSignal: { type: Number, default: 0 },
  /** Turn timing and disclosure are available on structured agent sessions. */
  showTurnStatus: { type: Boolean, default: true },
  /** Whether the active turn's foreground activity row should be visible. */
  showLiveTurnActivity: { type: Boolean, default: true },
  turnActivity: { type: Object, default: null },
  runtimeContext: { type: Object, default: null }
})

// { kind: 'diff', target } | { kind: 'rail', messageId, requestId } | null
const navigationRequest = shallowRef(null)
let navigationSequence = 0
const revealedDiff = computed(() =>
  navigationRequest.value?.kind === 'diff' ? navigationRequest.value.target : null
)
const railJump = computed(() =>
  navigationRequest.value?.kind === 'rail' ? navigationRequest.value : null
)
const receipts = computed(() =>
  props.journalItems ? structuredQuestionTranscript(props.journalItems).receipts : new Map()
)
const scrollRef = shallowRef(null)
const contentRef = shallowRef(null)
const expandedTurnIds = shallowRef(new Set())
provideNativeChatDisclosures()
function toggleExpandedTurn(turnKey) {
  const next = new Set(expandedTurnIds.value)
  if (next.has(turnKey)) {
    next.delete(turnKey)
  } else {
    if (next.size >= MAX_EXPANDED_TURNS) {
      const oldest = next.values().next().value
      if (oldest) next.delete(oldest)
    }
    next.add(turnKey)
  }
  expandedTurnIds.value = next
}

const loadingEarlier = computed(() => props.session.loadingEarlier === true)
const loadEarlier = () => props.session.loadEarlier()
// No paging from a pending or errored read: the lane would no-op, and its recovery
// remounts the row, which re-checks the range.
const showOlderHistory = computed(
  () => props.session.hasMore === true && props.session.readPhase === 'ready'
)

// Rebound sessions must release the previous transcript's cached rows.
const projectMessages = computed(() => {
  void props.session.agent
  void props.session.sessionId
  return createNativeChatMessageListProjection()
})
const messages = computed(() => {
  const projected = projectNativeChatTaskListFrames(projectMessages.value(props.session.messages))
  // Structured sessions show goal state in the banner above the composer.
  return props.journalItems ? omitNativeChatThreadGoalRows(projected) : projected
})
const taskListPredecessors = computed(() => nativeChatTaskListPredecessors(messages.value))
const taskListState = computed(() => nativeChatTaskListState(messages.value))
const showTypingIndicator = computed(() =>
  props.showTurnStatus
    ? props.isWorking
    : shouldShowNativeChatTypingIndicator({ messages: messages.value, isWorking: props.isWorking })
)
const latestUserIndex = computed(() => messages.value.findLastIndex((message) => message.role === 'user'))
const currentTurnKey = computed(() =>
  latestUserIndex.value === -1 ? undefined : (messages.value[latestUserIndex.value]?.id ?? undefined)
)
// Resolve each row's turn boundary once. Prefix slice/findLast in the render
// loop becomes quadratic for long transcripts.
const turnKeys = computed(() => {
  let key
  return messages.value.map((message) => {
    if (message.role === 'user') key = message.id
    return key
  })
})
const turnDiffs = computed(() =>
  props.journalItems ? nativeChatTurnDiffs(messages.value, turnKeys.value) : new Map()
)
// "Thinking" is real reasoning content at the tail of the turn, not the absence
// of output — the latter reports thinking while the request is merely in flight.
const thinking = computed(() =>
  props.journalItems ? isStructuredAgentSessionThinking(props.journalItems) : false
)
const turnStatuses = useNativeChatTurnStatus({
  messages,
  latestUserIndex,
  isWorking: () => props.showTurnStatus && props.isWorking,
  workingStartedAt: () => (props.showTurnStatus ? props.workingStartedAt : null),
  settledTurns: () => (props.showTurnStatus ? props.settledTurns : null),
  thinking
})
const lifecycleWorking = computed(() => props.session.transcriptLifecycle?.state === 'working')
const slots = computed(() =>
  buildNativeChatTranscriptSlots({
    messages: messages.value,
    turnKeys: turnKeys.value,
    latestUserIndex: latestUserIndex.value,
    currentTurnKey: currentTurnKey.value,
    receipts: receipts.value,
    turnStatuses: {
      active: turnStatuses.active.value,
      completedByTurn: turnStatuses.completedByTurn.value
    },
    turnDiffs: turnDiffs.value,
    showTurnStatus: props.showTurnStatus,
    expandedTurnKeys: expandedTurnIds.value,
    isWorking: props.isWorking,
    lifecycleWorking: lifecycleWorking.value
  })
)
const transcriptWindow = useNativeChatTranscriptWindow({
  scrollRef,
  slots,
  isVisible: () => props.isVisible,
  // One pin serves both: revealing a diff and jumping from the rail are
  // mutually exclusive things to be doing.
  revealIndex: () =>
    nativeChatSlotIndexOf(slots.value, railJump.value?.messageId ?? revealedDiff.value?.messageId)
})
const { showJump, onScroll, scrollToBottom, scrollMessageToTop } = useNativeChatTranscriptScroll({
  scrollRef,
  contentRef,
  itemCount: () => slots.value.length,
  isWorking: () => props.isWorking,
  showTypingIndicator,
  isVisible: () => props.isVisible,
  alignToViewportTop: transcriptWindow.alignToViewportTop,
  scrollToEnd: transcriptWindow.scrollToEnd,
  restoreScrollOffset: transcriptWindow.restoreScrollOffset,
  consumeProgrammaticScroll: transcriptWindow.consumeProgrammaticScroll,
  reconcileReaderScroll: transcriptWindow.reconcileReaderScroll
})
const olderHistory = useNativeChatOlderHistoryAutoload({
  scrollRef,
  historyKey: () =>
    `${props.session.agent}:${props.session.sessionId ?? ''}:${props.session.olderHistoryGeneration}`,
  isVisible: () => props.isVisible,
  hasMore: showOlderHistory,
  loadingEarlier,
  loadEarlier
})
const rail = useNativeChatMessageRail({
  scrollRef,
  slots,
  virtualItems: transcriptWindow.virtualItems,
  outline: () => props.railOutline
})
function requestRailJump(item) {
  navigationSequence += 1
  navigationRequest.value = { kind: 'rail', messageId: item.id, requestId: navigationSequence }
}
const railHistoryJump = useNativeChatRailHistoryJump({
  items: rail.items,
  sessionKey: () => `${props.session.agent}:${props.session.sessionId}`,
  loadEarlier,
  jumpToLoaded: requestRailJump
})
const { start: startHistoryJump, abort: beginNavigation } = railHistoryJump
// Every navigation begins by aborting a history jump still paging, which would
// otherwise land later and pull the reader away from where they just went.
function selectRailItem(item) {
  if (item.slotIndex === null) {
    startHistoryJump(item)
    return
  }
  beginNavigation()
  requestRailJump(item)
}
function revealDiff(target) {
  beginNavigation()
  navigationSequence += 1
  navigationRequest.value = { kind: 'diff', target: { ...target, requestId: navigationSequence } }
}
function jumpToLatest() {
  beginNavigation()
  scrollToBottom()
}
// Tessel: what you just sent is shown, wherever you had scrolled.
watch(
  () => props.scrollToLatestSignal,
  (now, before) => {
    if (now !== before) jumpToLatest()
  },
  { flush: 'post' }
)
const readerScrollInput = nativeChatReaderScrollInputHandlers(beginNavigation)
// Pinning the target mounts it in the same render, so the row exists by the time
// this post-render watcher runs. Routed through `scrollMessageToTop` rather than
// the virtualizer because that is what releases the bottom pin — without it the
// next streamed token snaps the reader straight back down.
//
// Serviced once per request, then released: a request left standing would keep
// its pin, which outranks the diff reveal that shares it.
let servicedRailJump = 0
watch(
  railJump,
  (jump) => {
    if (jump === null || servicedRailJump === jump.requestId) return
    servicedRailJump = jump.requestId
    const index = nativeChatSlotIndexOf(slots.value, jump.messageId)
    const row = scrollRef.value?.querySelector(`[data-index="${index}"]`) // i18n-ignore
    if (row) scrollMessageToTop(row)
    navigationRequest.value = null
  },
  { flush: 'post' }
)

// Everything a row needs that is the same for every row: one object, so a row's
// props change only when that row's own slot does.
const rowContext = computed(() => ({
  expandSignal: props.expandSignal,
  showTurnStatus: props.showTurnStatus,
  revealedDiff: revealedDiff.value,
  taskListPredecessors: taskListPredecessors.value,
  expandedTurnIds: expandedTurnIds.value,
  failedDeliveryMessageIds: props.failedDeliveryMessageIds,
  queuedMessageIds: props.queuedMessageIds,
  allowFileUriLinks: props.allowFileUriLinks,
  runtimeContext: props.runtimeContext,
  onLinkClick: props.onLinkClick,
  onToggleExpandedTurn: toggleExpandedTurn,
  onScrollMessageToTop: scrollMessageToTop,
  onRevealDiff: revealDiff
}))

const showActivityLine = computed(
  () => props.showTurnStatus && props.showLiveTurnActivity && props.isWorking
)
const taskList = computed(() => {
  const list = taskListState.value.list
  return list && list.tasks.length > 0 ? list : null
})
const jumpLabel = computed(() => t('chat.orca.jumpToLatest', 'Jump to latest'))
</script>

<template>
  <div class="nc-message-list">
    <div class="nc-message-list__body">
      <!-- Named so measurement can find the scroll root without depending on
           which class happens to make it scroll. `zoom` scales the transcript's
           text and layout together, on the scroll container itself so scroll
           offsets and row measurements share one coordinate space. -->
      <div
        ref="scrollRef"
        data-native-chat-scroll
        class="nc-scrollbar-sleek nc-message-list__scroll"
        :style="{ zoom: fontScale }"
        @scroll="onScroll"
        @wheel="readerScrollInput.onWheel"
        @touchmove="readerScrollInput.onTouchMove"
        @keydown="readerScrollInput.onKeyDown"
        @pointerdown="readerScrollInput.onPointerDown"
      >
        <NativeChatOlderHistoryRow
          v-if="showOlderHistory"
          :older-history="olderHistory"
          :loading-earlier="loadingEarlier"
        />
        <div class="nc-message-list__gutter">
          <!-- Matches the composer column (max-w-4xl) with a 5px inset on each
               side so content is slightly narrower than the input box. -->
          <div ref="contentRef" data-native-chat-column class="nc-message-list__column">
            <NativeChatTranscriptItems :slots="slots" :context="rowContext" :window="transcriptWindow" />
            <NativeChatTurnActivityLine
              v-if="showActivityLine"
              :activity="turnActivity"
              :status="turnStatuses.active.value"
            />
            <NativeChatTypingIndicatorRow v-if="!showTurnStatus && showTypingIndicator" />
          </div>
        </div>
      </div>
      <NativeChatMessageRail
        :rail="rail"
        :scroll-ref="scrollRef"
        :pending-id="railHistoryJump.pendingId.value"
        @select="selectRailItem"
        @reader-scroll="beginNavigation"
      />
      <button
        v-if="showJump"
        type="button"
        class="nc-message-list__jump"
        :aria-label="jumpLabel"
        :title="jumpLabel"
        @click="jumpToLatest"
      >
        <ArrowDown class="nc-message-list__jump-icon" />
      </button>
    </div>
    <div v-if="taskList" class="nc-message-list__tasks">
      <div class="nc-message-list__tasks-column" :style="{ zoom: fontScale }">
        <NativeChatTaskList :key="session.sessionId" :list="taskList" presentation="composer" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.nc-message-list {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1 1 0%;
  flex-direction: column;
}
.nc-message-list__body {
  position: relative;
  min-height: 0;
  flex: 1 1 0%;
}
.nc-message-list__scroll {
  position: relative;
  height: 100%;
  overflow-y: auto;
  /* Never a horizontal bar: wide content (code, tables) scrolls on its own. */
  overflow-x: hidden;
  /* Browser anchoring would add unattributed movement beside the virtualizer's anchor. */
  overflow-anchor: none;
  scrollbar-gutter: stable both-edges;
}
.nc-message-list__gutter {
  box-sizing: border-box;
  padding: 40px 12px 16px;
}
.nc-message-list__column {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  max-width: 56rem;
  margin-inline: auto;
  flex-direction: column;
  gap: 20px;
  padding-inline: 5px;
}
.nc-message-list__jump {
  position: absolute;
  bottom: 12px;
  right: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  margin: 0;
  border: 1px solid var(--nc-border);
  border-radius: 9999px;
  padding: 0;
  background: color-mix(in srgb, var(--nc-card) 90%, transparent);
  color: var(--nc-muted-foreground);
  font-family: inherit;
  font-size: 12px;
  line-height: 16px;
  box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  backdrop-filter: blur(8px);
  cursor: default;
}
.nc-message-list__jump:hover {
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
.nc-message-list__jump:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-message-list__jump-icon {
  width: 14px;
  height: 14px;
}
.nc-message-list__tasks {
  box-sizing: border-box;
  flex-shrink: 0;
  padding: 0 12px 8px;
}
.nc-message-list__tasks-column {
  width: 100%;
  max-width: 56rem;
  margin-inline: auto;
}
@media (min-width: 40rem) {
  .nc-message-list__gutter {
    padding-inline: 16px;
  }
  .nc-message-list__tasks {
    padding-inline: 16px;
  }
}
</style>
