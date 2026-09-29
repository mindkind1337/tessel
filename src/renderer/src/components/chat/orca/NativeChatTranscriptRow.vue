<script setup>
// After Orca's NativeChatTranscriptRow.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * One transcript row: the message (or the receipt standing in for it), the turn
 * status under it, and the turn's diff rollup.
 *
 * These three were siblings in the transcript column and took their spacing from
 * it. Windowing needs one element per row to position and measure, so the
 * wrapper carries that spacing itself — the gap BETWEEN rows is the window's.
 *
 * Props: slot (one entry of buildNativeChatTranscriptSlots), context (what is
 * the same for every row — NativeChatMessageList builds it once):
 *   { expandSignal, showTurnStatus, revealedDiff, taskListPredecessors (Map),
 *     expandedTurnIds (Set), failedDeliveryMessageIds (Set?), allowFileUriLinks,
 *     runtimeContext, onLinkClick?, onToggleExpandedTurn(turnKey),
 *     onScrollMessageToTop(element), onRevealDiff(target) }
 */
import { computed } from 'vue'
import NativeChatMessageRow from './NativeChatMessageRow.vue'
import NativeChatResolutionReceipt from './NativeChatResolutionReceipt.vue'
import NativeChatWorkingStatus from './NativeChatWorkingStatus.vue'
import NativeChatTurnDiffRollup from './NativeChatTurnDiffRollup.vue'

const props = defineProps({
  slot: { type: Object, required: true },
  context: { type: Object, required: true }
})

const message = computed(() => props.slot.message)
const predecessors = computed(() => props.context.taskListPredecessors?.get(message.value.id))
const expanded = computed(() =>
  props.slot.turnKey ? props.context.expandedTurnIds.has(props.slot.turnKey) : undefined
)
const revealedDiff = computed(() =>
  props.context.revealedDiff?.messageId === message.value.id ? props.context.revealedDiff : undefined
)
const deliveryFailed = computed(
  () => props.context.failedDeliveryMessageIds?.has(message.value.id) === true
)
// Stable per turn, so the status row does not re-render with every list render.
const onToggleExpanded = computed(() => {
  const turnKey = props.slot.turnKey
  if (!props.slot.turnFolds || !turnKey) return undefined
  const toggle = props.context.onToggleExpandedTurn
  return () => toggle(turnKey)
})
</script>

<template>
  <div class="nc-transcript-row">
    <NativeChatResolutionReceipt
      v-if="slot.receipt"
      :body="slot.receipt"
      :disclosure-id="message.id"
    />
    <NativeChatMessageRow
      v-else
      :message="message"
      :previous-todo-write="predecessors?.todowrite"
      :previous-update-plan="predecessors?.update_plan"
      :revealed-diff="revealedDiff"
      :expand-signal="context.expandSignal"
      :active-turn-is-working="slot.activeTurnIsWorking"
      :trailing-run="slot.trailingRun"
      @scroll-message-to-top="context.onScrollMessageToTop"
      @link-click="context.onLinkClick"
      :allow-file-uri-links="context.allowFileUriLinks"
      :delivery-failed="deliveryFailed"
      :structured-activity-ui="context.showTurnStatus"
      :folded="slot.folded"
      :runtime-context="context.runtimeContext"
    />
    <NativeChatWorkingStatus
      v-if="slot.status"
      :started-at="slot.status.startedAt"
      :thinking="slot.status.thinking"
      :worked-seconds="slot.status.workedSeconds"
      :expanded="expanded === true"
      @toggle-expanded="onToggleExpanded"
    />
    <NativeChatTurnDiffRollup
      v-if="slot.turnDiff"
      :diff="slot.turnDiff"
      @reveal="context.onRevealDiff"
    />
  </div>
</template>

<style scoped>
.nc-transcript-row {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
</style>
