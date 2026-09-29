<script setup>
// After Orca's NativeChatOlderHistoryRow.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Top of the transcript while older history remains: the auto-load sentinel,
 * a quiet status line, and a manual load only once auto-load has stopped.
 * Rendered as a direct child of the (positioned) transcript scroller.
 * Props: olderHistory (what useNativeChatOlderHistoryAutoload returns:
 *   { sentinelRef, isAutoLoadEnabled, loadEarlierManually }), loadingEarlier.
 */
import { computed, onBeforeUnmount, ref, unref, watch } from 'vue'
import { t } from '../../../i18n'
import { Button } from './ui/index.js'

/** Pages that land quickly (local reads) should not flash a label. */
const LOADING_LABEL_DELAY_MS = 200

const props = defineProps({
  olderHistory: { type: Object, required: true },
  loadingEarlier: { type: Boolean, default: false }
})

const autoLoad = computed(() => unref(props.olderHistory.isAutoLoadEnabled) === true)

// The reference mounts a DelayedLoadingLabel while a page loads; its timer
// starts with the mount and the label goes with the unmount.
const labelVisible = ref(false)
let timer = null
function clearTimer() {
  if (timer !== null) window.clearTimeout(timer)
  timer = null
}
watch(
  () => autoLoad.value && props.loadingEarlier,
  (loading) => {
    clearTimer()
    labelVisible.value = false
    if (loading) timer = window.setTimeout(() => (labelVisible.value = true), LOADING_LABEL_DELAY_MS)
  },
  { immediate: true }
)
onBeforeUnmount(clearTimer)

function setSentinel(node) {
  props.olderHistory.sentinelRef(node)
}
</script>

<template>
  <div :ref="setSentinel" class="nc-older-history">
    <!-- Out of flow, inside the scroller's top padding: its coming and going must
         never move the window, least of all when the last page takes it away. -->
    <span v-if="autoLoad" role="status" aria-live="polite" class="nc-older-history__status">
      <template v-if="loadingEarlier && labelVisible">{{
        t('chat.orca.loadingEarlierMessages', 'Loading earlier messages…')
      }}</template>
    </span>
    <Button
      v-else
      variant="ghost"
      size="xs"
      :disabled="loadingEarlier"
      @click="olderHistory.loadEarlierManually()"
    >
      {{
        loadingEarlier
          ? t('chat.orca.loadingEarlier', 'Loading…')
          : t('chat.orca.loadEarlier', 'Load earlier messages')
      }}
    </Button>
  </div>
</template>

<style scoped>
.nc-older-history {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  display: flex;
  height: 40px;
  align-items: center;
  justify-content: center;
}
.nc-older-history__status {
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
</style>
