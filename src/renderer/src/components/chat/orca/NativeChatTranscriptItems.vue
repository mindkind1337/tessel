<script setup>
// After Orca's NativeChatTranscriptItems.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Windowed transcript rows, absolutely positioned inside a full-height spacer.
 * Props: slots (buildNativeChatTranscriptSlots), context (the row context,
 *   see NativeChatTranscriptRow), window (what useNativeChatTranscriptWindow
 *   returns: { virtualItems, totalSize, scrollMargin, sizerRef, measureRow }).
 */
import { computed, unref } from 'vue'
import NativeChatTranscriptRow from './NativeChatTranscriptRow.vue'

const props = defineProps({
  slots: { type: Array, required: true },
  context: { type: Object, required: true },
  window: { type: Object, required: true }
})

const rows = computed(() => {
  const slots = props.slots
  const margin = unref(props.window.scrollMargin) ?? 0
  const rows = []
  for (const item of unref(props.window.virtualItems) ?? []) {
    const slot = slots[item.index]
    if (!slot) continue
    // `top`, not a transform: the reveal path walks `offsetTop` to find
    // where a card sits, and a transform is invisible to it.
    rows.push({ key: item.key, index: item.index, top: `${item.start - margin}px`, slot })
  }
  return rows
})
const height = computed(() => `${unref(props.window.totalSize) ?? 0}px`)

function sizerRef(node) {
  props.window.sizerRef(node)
}
function measureRow(node) {
  props.window.measureRow(node)
}
</script>

<template>
  <div :ref="sizerRef" data-native-chat-window class="nc-transcript-window" :style="{ height }">
    <div
      v-for="row in rows"
      :key="row.key"
      :ref="measureRow"
      :data-index="row.index"
      :style="{ position: 'absolute', top: row.top, left: '0', width: '100%' }"
    >
      <NativeChatTranscriptRow :slot="row.slot" :context="context" />
    </div>
  </div>
</template>

<style scoped>
.nc-transcript-window {
  position: relative;
  width: 100%;
}
</style>
