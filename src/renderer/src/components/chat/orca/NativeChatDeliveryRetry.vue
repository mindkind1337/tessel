<script setup>
// After Orca's NativeChatDeliveryRetry.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// A message that did not get through. The reference's banner reads its
// outbox (the entry the drain stopped on: "not sent" or "unconfirmed", with
// Retry). Tessel's engine refuses a send at once instead: each refused
// message is an entry of `unsent` ({ key, text, error, sending }) with Retry,
// Copy and Discard (ChatPane's "Not sent"), in the reference's look.
// Props: outbox, blockedClientMessageId, retry(clientMessageId) (the
//   reference); unsent, retryDisabledReason (why Retry waits: not signed in,
//   the agent starts…).
// Emits: retry-unsent(entry), discard(entry) (the pane puts the focus back
//   in the composer when it had it), copied({ entry, ok }) (the pane says so).
import { computed } from 'vue'
import { Copy, RotateCcw, TriangleAlert, X } from 'lucide-vue-next'
import { Button } from './ui/index.js'
import { t } from '../../../i18n'
import { admitStructuredAgentSessionOutboxEntry } from '../../../chat/orca/shared/structured-agent-session-outbox.js'

const props = defineProps({
  outbox: { type: Array, default: () => [] },
  blockedClientMessageId: { type: String, default: null },
  retry: { type: Function, default: null },
  unsent: { type: Array, default: () => [] },
  retryDisabledReason: { type: String, default: '' }
})
const emit = defineEmits(['retry-unsent', 'discard', 'copied'])

// Read through the drain's own rule, so Retry can never name an entry other
// than the one the queue actually stopped on.
const retryable = computed(() => {
  const admission = admitStructuredAgentSessionOutboxEntry(props.outbox, props.blockedClientMessageId)
  return admission.state === 'blocked' ? admission.entry : null
})

// Copy through Tessel's clipboard bridge (the renderer's own clipboard as a fallback).
async function copy(entry) {
  let ok = true
  try {
    const api = typeof window !== 'undefined' ? window.shellApi : null
    if (api && typeof api.writeClipboard === 'function') api.writeClipboard(entry.text)
    else if (typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(entry.text)
    else ok = false
  } catch {
    ok = false
  }
  emit('copied', { entry, ok })
}
</script>

<template>
  <div v-if="retryable" class="nc-delivery" data-test="chat-delivery-retry">
    <span>
      {{
        retryable.state === 'unconfirmed'
          ? t('chat.orca.deliveryRetry.unconfirmed', 'Message delivery is unconfirmed.')
          : t('chat.orca.deliveryRetry.notSent', 'Message was not sent.')
      }}
    </span>
    <Button type="button" variant="ghost" size="xs" @click="retry && retry(retryable.clientMessageId)">
      <RotateCcw class="nc-size-3" aria-hidden="true" />
      {{ t('chat.orca.deliveryRetry.retry', 'Retry') }}
    </Button>
  </div>
  <div
    v-for="u in unsent"
    :key="'unsent-' + u.key"
    class="nc-delivery nc-delivery--unsent"
    role="group"
    :aria-label="t('chat.unsent.title', 'Not sent')"
    data-test="chat-unsent"
  >
    <div class="nc-delivery-body">
      <span class="nc-delivery-head">
        <TriangleAlert class="nc-delivery-icon" aria-hidden="true" />
        <span class="nc-delivery-title">{{ u.sending ? t('chat.unsent.sending', 'Sending…') : t('chat.unsent.title', 'Not sent') }}</span>
        <span v-if="u.error && !u.sending" class="nc-delivery-error" data-test="chat-unsent-error">{{ u.error }}</span>
      </span>
      <span class="nc-delivery-text" data-test="chat-unsent-text">{{ u.text }}</span>
    </div>
    <span class="nc-delivery-actions">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-test="chat-unsent-retry"
        :disabled="u.sending || !!retryDisabledReason"
        :title="retryDisabledReason || undefined"
        @click="emit('retry-unsent', u)"
      >
        <RotateCcw class="nc-size-3" aria-hidden="true" />
        {{ t('chat.unsent.retry', 'Retry') }}
      </Button>
      <Button type="button" variant="ghost" size="xs" data-test="chat-unsent-copy" @click="copy(u)">
        <Copy class="nc-size-3" aria-hidden="true" />
        {{ t('chat.unsent.copy', 'Copy') }}
      </Button>
      <Button type="button" variant="ghost" size="xs" data-test="chat-unsent-discard" :disabled="u.sending" @click="emit('discard', u)">
        <X class="nc-size-3" aria-hidden="true" />
        {{ t('chat.unsent.discard', 'Discard') }}
      </Button>
    </span>
  </div>
</template>

<style scoped>
/* mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-1 text-xs text-muted-foreground */
.nc-delivery {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  max-width: 56rem;
  margin: 0 auto;
  padding: 4px 16px;
  color: var(--nc-muted-foreground);
  font-size: 12px;
  line-height: 16px;
}
.nc-delivery-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.nc-delivery-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.nc-delivery-icon {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--nc-warning);
}
.nc-delivery-title {
  color: var(--nc-foreground);
  font-weight: 500;
}
.nc-delivery-error {
  color: var(--nc-destructive);
  overflow-wrap: anywhere;
}
/* The refused message itself: three lines at most, the rest on Copy. */
.nc-delivery-text {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
}
.nc-delivery-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
}
.nc-size-3 {
  width: 12px;
  height: 12px;
}
</style>
