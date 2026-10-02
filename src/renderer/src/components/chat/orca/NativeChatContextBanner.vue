<script setup>
// Tessel's low-context banner, in the reference's one-line banner style
// (NativeChatLaunchRetry, after Orca, MIT, Copyright (c) 2026 Lovecast Inc.):
// once the context ring (NativeChatContextUsageRing) reads 85 % or more, the
// chat says so above the composer and offers to compact the conversation
// (Claude's /compact, Codex's and OpenCode's own compaction, through
// compact()). Without compact() it only warns. Closed with its X, it stays
// closed until the context is low again; it goes by itself once the
// compaction lands (the ring no longer knows the usage).
// Props: usage (StructuredAgentContextUsage or null), compact (() => result,
//   or null), busy (a turn or a request is running: Compact waits), disabled
//   (the chat cannot send), agentName.
import { computed, ref, watch } from 'vue'
import { Minimize2, TriangleAlert, X } from 'lucide-vue-next'
import { Button } from './ui/index.js'
import { t } from '../../../i18n'
import { formatContextTokenCount } from '../../../chat/orca/native-chat-context-usage-summary.js'

const LOW_CONTEXT_PERCENT = 85

const props = defineProps({
  usage: { type: Object, default: null },
  compact: { type: Function, default: null },
  busy: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  agentName: { type: String, default: '' }
})

const percentage = computed(() => (props.usage && Number.isFinite(props.usage.percentage) ? props.usage.percentage : null))
const low = computed(() => percentage.value !== null && percentage.value >= LOW_CONTEXT_PERCENT)
const dismissed = ref(false)
const compacting = ref(false)
// Low again (or unknown, e.g. just compacted): the next time it fills up, it says so again.
watch(low, (isLow) => {
  if (!isLow) {
    dismissed.value = false
    compacting.value = false
  }
})
const shown = computed(() => low.value && !dismissed.value)

const text = computed(() => {
  const used = props.usage ? formatContextTokenCount(props.usage.usedTokens) : ''
  const window = props.usage ? formatContextTokenCount(props.usage.windowTokens) : ''
  return props.compact
    ? t('chat.context.lowCompact', 'Context {{pct}}% full ({{used}} / {{window}})', { pct: percentage.value, used, window })
    : t('chat.context.low', 'Context almost full: {{pct}}% used ({{used}} / {{window}}). {{agent}} cannot compact it here: start a new conversation soon.', {
        pct: percentage.value,
        used,
        window,
        agent: props.agentName
      })
})
const compactTitle = computed(() =>
  props.busy ? t('chat.context.compactWait', 'Wait for the end of the turn') : t('chat.context.compactHint', 'Summarize the conversation so far to free the context')
)

async function onCompact() {
  if (!props.compact || compacting.value || props.busy || props.disabled) return
  compacting.value = true
  let res
  try {
    res = await props.compact()
  } catch {
    res = { ok: false }
  }
  // Refused: the button comes back (the pane said why).
  if (!res || res.ok === false) compacting.value = false
}
</script>

<template>
  <div v-if="shown" class="nc-context-banner" role="status" data-test="chat-context-low">
    <TriangleAlert class="nc-context-banner-icon" aria-hidden="true" />
    <span class="nc-context-banner-text">{{ text }}</span>
    <span class="nc-context-banner-actions">
      <Button
        v-if="compact"
        type="button"
        variant="outline"
        size="xs"
        data-test="chat-context-compact"
        :title="compactTitle"
        :disabled="busy || disabled || compacting"
        @click="onCompact"
      >
        <Minimize2 class="nc-size-3" aria-hidden="true" />
        {{ compacting ? t('chat.context.compacting', 'Compacting…') : t('chat.context.compact', 'Compact') }}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-test="chat-context-dismiss"
        :aria-label="t('chat.context.dismiss', 'Hide this warning')"
        :title="t('chat.context.dismiss', 'Hide this warning')"
        @click="dismissed = true"
      >
        <X class="nc-size-3" aria-hidden="true" />
      </Button>
    </span>
  </div>
</template>

<style scoped>
/* One quiet amber card above the composer: icon, text and actions on one
   line (the text wraps beside the icon, never under it). */
.nc-context-banner {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: calc(100% - 32px);
  max-width: 54rem;
  margin: 4px auto;
  padding: 6px 6px 6px 10px;
  border: 1px solid color-mix(in srgb, var(--nc-warning, #f59e0b) 35%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--nc-warning, #f59e0b) 8%, transparent);
  color: var(--nc-foreground, inherit);
  font-size: 12px;
  line-height: 16px;
}
.nc-context-banner-icon {
  width: 14px;
  height: 14px;
  flex: none;
  color: var(--nc-warning, #f59e0b);
}
.nc-context-banner-text {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--nc-muted-foreground, inherit);
  overflow-wrap: break-word;
}
.nc-context-banner-actions {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 2px;
}
.nc-context-banner-actions :deep(button) {
  font-size: 12px;
}
.nc-size-3 {
  width: 12px;
  height: 12px;
}
</style>
