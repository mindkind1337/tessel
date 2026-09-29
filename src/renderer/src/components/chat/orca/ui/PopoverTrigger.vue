<script setup>
// After Orca's components/ui/popover.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * PopoverTrigger: a button (type="button") that toggles the Popover on click,
 * with aria-haspopup="dialog", aria-expanded, aria-controls and data-state.
 * Props: asChild (the slot child — a <button> or a <Button> — becomes the
 *   trigger; its own listeners run first, and event.preventDefault() in its
 *   @click stops the toggle).
 * <PopoverTrigger as-child><Button variant="ghost" size="icon-sm">…</Button></PopoverTrigger>
 */
import { inject, onBeforeUnmount } from 'vue'
import { POPOVER, required } from './contexts.js'
import { Primitive, bindWith, elementOf } from './primitive.js'

defineOptions({ inheritAttrs: false })
defineProps({ asChild: { type: Boolean, default: false } })

const ctx = required(inject(POPOVER, null), 'PopoverTrigger', 'Popover')

function setEl(value) {
  ctx.triggerEl.value = elementOf(value)
}
onBeforeUnmount(() => (ctx.triggerEl.value = null))

function onClick(event) {
  if (event.defaultPrevented) return
  ctx.toggle()
}
</script>

<template>
  <Primitive
    :ref="setEl"
    as="button"
    :as-child="asChild"
    v-bind="
      bindWith(
        $attrs,
        {
          type: 'button',
          'data-slot': 'popover-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': ctx.open.value ? 'true' : 'false',
          'aria-controls': ctx.open.value ? ctx.contentId : undefined,
          'data-state': ctx.open.value ? 'open' : 'closed'
        },
        { onClick }
      )
    "
  >
    <slot />
  </Primitive>
</template>
