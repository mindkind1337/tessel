<script setup>
// After Orca's components/ui/dialog.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DialogFooter (div): actions, right-aligned from 640px.
 * Props: showCloseButton (default false: adds an outline "Close" Button).
 */
import { computed } from 'vue'
import { t } from '../../../../i18n'
import Button from './Button.vue'
import DialogClose from './DialogClose.vue'

defineProps({ showCloseButton: { type: Boolean, default: false } })

const closeLabel = computed(() => t('chat.orca.ui.close', 'Close'))
</script>

<template>
  <div data-slot="dialog-footer" class="nc-ui-dialog-footer">
    <slot />
    <DialogClose v-if="showCloseButton" as-child>
      <Button variant="outline">{{ closeLabel }}</Button>
    </DialogClose>
  </div>
</template>

<style>
.nc-ui-dialog-footer {
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
}
@media (min-width: 640px) {
  .nc-ui-dialog-footer {
    flex-direction: row;
    justify-content: flex-end;
  }
}
</style>
