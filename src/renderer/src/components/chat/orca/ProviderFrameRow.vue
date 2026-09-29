<script setup>
// After Orca's NativeChatTranscriptChrome.tsx, ProviderFrameRow (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * A provider's raw frame behind a disclosure: provider, summary, size when
 * truncated; the payload's head (text, never HTML) when opened.
 * Props: block (a text block with providerFrame; renders nothing otherwise),
 *   summary (replaces the derived summary, e.g. "Details").
 */
import { computed } from 'vue'
import { t } from '../../../i18n'
import { nativeChatProviderFrameSummary } from '../../../chat/orca/shared/native-chat-provider-frame-summary.js'

const props = defineProps({
  block: { type: Object, required: true },
  summary: { type: String, default: undefined }
})

const frame = computed(() =>
  props.block?.type === 'text' && props.block.providerFrame ? props.block.providerFrame : null
)
const summaryText = computed(() => props.summary ?? nativeChatProviderFrameSummary(props.block))
const byteLengthText = computed(() =>
  t('chat.orca.providerFrame.byteLength', '{{value0}} bytes', {
    value0: frame.value?.payload.byteLength
  })
)
const payloadText = computed(() =>
  frame.value ? `${frame.value.payload.head}${frame.value.payload.truncated ? '\n…' : ''}` : ''
)
</script>

<template>
  <details v-if="frame" class="nc-frame">
    <summary class="nc-frame-summary">
      <span class="nc-frame-chevron">›</span>
      <span class="nc-frame-provider">{{ frame.provider }}</span>
      <span class="nc-frame-text">{{ summaryText }}</span>
      <span v-if="frame.payload.truncated">· {{ byteLengthText }}</span>
    </summary>
    <pre class="nc-frame-payload nc-scrollbar-sleek">{{ payloadText }}</pre>
  </details>
</template>

<style scoped>
.nc-frame {
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
.nc-frame-summary {
  display: flex;
  cursor: pointer;
  list-style: none;
  align-items: center;
  gap: 8px;
  border-radius: 6px;
  padding: 4px 8px;
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
    monospace;
}
.nc-frame-summary::-webkit-details-marker {
  display: none;
}
.nc-frame-summary:hover {
  background: var(--nc-accent);
}
.nc-frame-summary:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-frame-chevron {
  transition-property: transform;
  transition-duration: 150ms;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-frame[open] .nc-frame-chevron {
  transform: rotate(90deg);
}
.nc-frame-provider {
  font-weight: 500;
  color: var(--nc-foreground);
}
.nc-frame-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-frame-payload {
  margin: 4px 0 0;
  max-height: 256px;
  overflow: auto;
  white-space: pre-wrap;
  border-radius: 6px;
  border: 1px solid var(--nc-border);
  background: var(--nc-muted);
  padding: 8px;
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
    monospace;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-foreground);
}
</style>
