<script setup>
// After Orca's components/ui/collapsible.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Collapsible (div, Radix Collapsible.Root). Parts: CollapsibleTrigger,
 * CollapsibleContent.
 * Props: open (v-model:open; leave unset for uncontrolled), defaultOpen,
 *   disabled.
 * Emits: update:open (Boolean).
 * Slot props: { open }.
 * <Collapsible v-model:open="open" class="tasks">
 *   <CollapsibleTrigger class="row">Tasks</CollapsibleTrigger>
 *   <CollapsibleContent><Checklist /></CollapsibleContent>
 * </Collapsible>
 */
import { computed, provide, useId } from 'vue'
import { COLLAPSIBLE } from './contexts.js'
import { useControllableOpen } from './primitive.js'

const props = defineProps({
  open: { type: Boolean, default: undefined },
  defaultOpen: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:open'])

const open = useControllableOpen(props, emit)
const contentId = useId()

provide(COLLAPSIBLE, {
  open: open.value,
  disabled: computed(() => props.disabled),
  contentId,
  toggle: () => open.set(!open.value.value)
})
</script>

<template>
  <div
    data-slot="collapsible"
    :data-state="open.value.value ? 'open' : 'closed'"
    :data-disabled="disabled ? '' : undefined"
  >
    <slot :open="open.value.value" />
  </div>
</template>
