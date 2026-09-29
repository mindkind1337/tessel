<script setup>
// After Orca's components/ui/popover.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Popover (Radix Popover.Root; renders no element). Parts: PopoverTrigger,
 * PopoverAnchor, PopoverContent.
 * Props: open (v-model:open; leave unset for uncontrolled), defaultOpen,
 *   modal (Boolean: blocks pointer events outside and traps Tab).
 * Emits: update:open (Boolean).
 * Slot props: { open, close }.
 * <Popover v-model:open="open">
 *   <PopoverTrigger as-child><button type="button" :aria-label="label">…</button></PopoverTrigger>
 *   <PopoverContent side="top" align="end" :side-offset="8" class="panel"
 *     @open-auto-focus="(e) => e.preventDefault()">…</PopoverContent>
 * </Popover>
 */
import { computed, provide, shallowRef, useId } from 'vue'
import { POPOVER } from './contexts.js'
import { useControllableOpen } from './primitive.js'

const props = defineProps({
  open: { type: Boolean, default: undefined },
  defaultOpen: { type: Boolean, default: false },
  modal: { type: Boolean, default: false }
})
const emit = defineEmits(['update:open'])

const open = useControllableOpen(props, emit)
const triggerEl = shallowRef(null)
const anchorEl = shallowRef(null)

function close() {
  open.set(false)
}

provide(POPOVER, {
  open: open.value,
  setOpen: open.set,
  toggle: () => open.set(!open.value.value),
  modal: computed(() => props.modal),
  triggerEl,
  anchorEl,
  contentId: useId()
})
</script>

<template>
  <slot :open="open.value.value" :close="close" />
</template>
