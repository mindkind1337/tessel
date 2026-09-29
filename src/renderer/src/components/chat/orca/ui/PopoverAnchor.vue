<script setup>
// After Orca's components/ui/popover.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * PopoverAnchor: positions the PopoverContent against this element instead
 * of the trigger (div, or the slot child with asChild).
 */
import { inject, onBeforeUnmount } from 'vue'
import { POPOVER, required } from './contexts.js'
import { Primitive, elementOf } from './primitive.js'

defineProps({ asChild: { type: Boolean, default: false } })

const ctx = required(inject(POPOVER, null), 'PopoverAnchor', 'Popover')

function setEl(value) {
  ctx.anchorEl.value = elementOf(value)
}
onBeforeUnmount(() => (ctx.anchorEl.value = null))
</script>

<template>
  <Primitive :ref="setEl" as="div" :as-child="asChild" data-slot="popover-anchor">
    <slot />
  </Primitive>
</template>
