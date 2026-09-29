<script setup>
// After Orca's components/ui/dialog.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Dialog (Radix Dialog.Root; renders no element). Parts: DialogTrigger,
 * DialogContent (overlay + panel + close button), DialogHeader, DialogFooter,
 * DialogTitle, DialogDescription, DialogClose.
 * Props: open (v-model:open; leave unset for uncontrolled), defaultOpen,
 *   modal (default true: overlay, Tab trapped, focus kept inside).
 * Emits: update:open (Boolean).
 * Slot props: { open, close }.
 * <Dialog v-model:open="isOpen">
 *   <DialogContent class="preview">
 *     <DialogTitle class="title">{{ label }}</DialogTitle>
 *     <DialogDescription class="nc-ui-sr-only">{{ description }}</DialogDescription>
 *     <img :src="src" :alt="label" />
 *   </DialogContent>
 * </Dialog>
 */
import { computed, provide, shallowRef, useId } from 'vue'
import { DIALOG } from './contexts.js'
import { useControllableOpen } from './primitive.js'

const props = defineProps({
  open: { type: Boolean, default: undefined },
  defaultOpen: { type: Boolean, default: false },
  modal: { type: Boolean, default: true }
})
const emit = defineEmits(['update:open'])

const open = useControllableOpen(props, emit)

function close() {
  open.set(false)
}

provide(DIALOG, {
  open: open.value,
  setOpen: open.set,
  toggle: () => open.set(!open.value.value),
  modal: computed(() => props.modal),
  triggerEl: shallowRef(null),
  contentId: useId(),
  titleId: useId(),
  descriptionId: useId()
})
</script>

<template>
  <slot :open="open.value.value" :close="close" />
</template>
