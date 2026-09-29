<script setup>
// After Orca's NativeChatTranscriptChrome.tsx, NativeChatAgentControls (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * An agent message's controls: copy it, scroll it to the top, its time.
 * Props: markdown (what Copy copies), timestamp (ms or null).
 * Emits: scrollToTop. Class goes to the row.
 */
import { computed } from 'vue'
import { ArrowUp } from 'lucide-vue-next'
import { t } from '../../../i18n'
import NativeChatCopyButton from './NativeChatCopyButton.vue'
import NativeChatMessageTimestamp from './NativeChatMessageTimestamp.vue'

defineProps({
  markdown: { type: String, required: true },
  timestamp: { type: Number, default: null }
})
const emit = defineEmits(['scrollToTop'])

const scrollLabel = computed(() => t('chat.orca.scrollMessageToTop', 'Scroll this message to top'))
</script>

<template>
  <div class="nc-agent-controls">
    <NativeChatCopyButton :text="markdown" />
    <button
      type="button"
      class="nc-agent-control"
      :aria-label="scrollLabel"
      :title="scrollLabel"
      @click="emit('scrollToTop')"
    >
      <ArrowUp class="nc-agent-control-icon" aria-hidden="true" />
    </button>
    <NativeChatMessageTimestamp :timestamp="timestamp" />
  </div>
</template>

<style scoped>
.nc-agent-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}
.nc-agent-control {
  display: flex;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--nc-muted-foreground);
  font: inherit;
  transition-property: color, background-color, border-color, text-decoration-color, fill, stroke;
  transition-duration: 150ms;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-agent-control:hover {
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
.nc-agent-control:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-agent-control-icon {
  width: 14px;
  height: 14px;
}
</style>
