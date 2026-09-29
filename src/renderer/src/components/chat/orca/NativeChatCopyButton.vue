<script setup>
// After Orca's NativeChatCopyButton.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Per-message copy affordance for the native chat. Copies the text to the
 * clipboard and briefly swaps the icon to a check tint as success feedback —
 * matching the app's other inline copy buttons (icon swap, no toast).
 *
 * Tessel: copies through the same bridge as the rest of the chat
 * (window.shellApi.writeClipboard); without that bridge the button is not
 * rendered at all (nothing would be copied). "Copied" is also said in a
 * polite live region, since a changed aria-label is not announced.
 *
 * Props: text (what is copied), label (what this button copies, when it is not
 *   the whole message; default "Copy message"). Class goes to the <button>.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { Check, Copy } from 'lucide-vue-next'
import { t } from '../../../i18n'

const props = defineProps({
  text: { type: String, required: true },
  label: { type: String, default: undefined }
})

const copied = ref(false)
let resetTimer = null

onBeforeUnmount(() => {
  if (resetTimer !== null) window.clearTimeout(resetTimer)
})

function clipboardBridge() {
  const api = typeof window !== 'undefined' ? window.shellApi : null
  return api && typeof api.writeClipboard === 'function' ? api : null
}

async function handleCopy() {
  const api = clipboardBridge()
  if (!api) return
  try {
    await api.writeClipboard(props.text)
    copied.value = true
    if (resetTimer !== null) window.clearTimeout(resetTimer)
    resetTimer = window.setTimeout(() => {
      resetTimer = null
      copied.value = false
    }, 1500)
  } catch {
    /* best-effort: clipboard can reject when unfocused */
  }
}

const copiedText = computed(() => t('chat.orca.copyMessage.copied', 'Copied'))
const label = computed(() =>
  copied.value ? copiedText.value : (props.label ?? t('chat.orca.copyMessage.copy', 'Copy message'))
)
</script>

<template>
  <button
    v-if="clipboardBridge()"
    type="button"
    class="nc-copy-button"
    :class="{ 'is-copied': copied }"
    :aria-label="label"
    :title="label"
    @click="handleCopy"
  >
    <Check v-if="copied" class="nc-copy-icon" aria-hidden="true" />
    <Copy v-else class="nc-copy-icon" aria-hidden="true" />
    <span class="nc-copy-status" role="status">{{ copied ? copiedText : '' }}</span>
  </button>
</template>

<style scoped>
.nc-copy-button {
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
.nc-copy-button:hover {
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
.nc-copy-button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-copy-button.is-copied {
  color: var(--nc-status-success);
}
.nc-copy-icon {
  width: 14px;
  height: 14px;
}
/* Read aloud, never seen. */
.nc-copy-status {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
