<script setup>
// After Orca's NativeChatAutocompleteMenus.tsx, NativeChatMentionHint (MIT, Copyright (c) 2026 Lovecast Inc.)
// The "@file" hint above the composer; accepted on pointer down so the
// textarea keeps the focus. Props: query. Emits: accept().
import { t } from '../../../i18n'

defineProps({
  query: { type: String, default: '' }
})
const emit = defineEmits(['accept'])

function accept(event) {
  event.preventDefault()
  emit('accept')
}
</script>

<template>
  <button type="button" class="nc-mention-hint" @pointerdown="accept">
    {{ t('chat.orca.composer.mentionHint', 'Referencing file:') }}
    <span class="nc-mention-query">@{{ query || '…' }}</span>
  </button>
</template>

<style scoped>
/* absolute bottom-full left-3 right-3 z-20 mb-1 flex w-auto items-center gap-2
   rounded-md border border-border bg-popover px-3 py-1.5 text-left text-xs
   text-muted-foreground shadow-md sm:left-4 sm:right-4.
   Why z-20: matches the slash picker. The composer shell below is a paint
   containment boundary, so it paints at z-index 0 in tree order and would
   otherwise cover this hint's drop shadow. */
.nc-mention-hint {
  position: absolute;
  bottom: 100%;
  left: 12px;
  right: 12px;
  z-index: 20;
  margin-bottom: 4px;
  display: flex;
  width: auto;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  border: 1px solid var(--nc-border);
  border-radius: 6px;
  background: var(--nc-popover);
  padding: 6px 12px;
  text-align: left;
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
  box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  cursor: pointer;
}
@media (min-width: 640px) {
  .nc-mention-hint {
    left: 16px;
    right: 16px;
  }
}
/* font-medium text-foreground */
.nc-mention-query {
  font-weight: 500;
  color: var(--nc-foreground);
}
</style>
