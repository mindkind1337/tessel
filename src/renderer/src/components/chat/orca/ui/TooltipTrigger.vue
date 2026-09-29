<script setup>
// After Orca's components/ui/tooltip.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * TooltipTrigger: a button by default; with asChild the slot child (a
 * <Button>, or a DropdownMenuTrigger / PopoverTrigger with as-child — they
 * nest) becomes the trigger. Adds aria-describedby (the content's id while
 * open) and data-state 'closed' | 'delayed-open' | 'instant-open'.
 * Props: asChild.
 * <TooltipTrigger as-child><Button size="icon-sm" :aria-label="label"><Mic /></Button></TooltipTrigger>
 */
import { inject, onBeforeUnmount } from 'vue'
import { TOOLTIP, required } from './contexts.js'
import { Primitive, bindWith, elementOf } from './primitive.js'

defineOptions({ inheritAttrs: false })
defineProps({ asChild: { type: Boolean, default: false } })

const ctx = required(inject(TOOLTIP, null), 'TooltipTrigger', 'Tooltip')
let hasPointerMoveOpened = false
let isPointerDown = false

function setEl(value) {
  ctx.triggerEl.value = elementOf(value)
}
function onPointerUp() {
  isPointerDown = false
}
onBeforeUnmount(() => {
  ctx.triggerEl.value = null
  document.removeEventListener('pointerup', onPointerUp)
})

const handlers = {
  onPointermove(event) {
    if (event.defaultPrevented || event.pointerType === 'touch') return
    if (!hasPointerMoveOpened) {
      ctx.onTriggerEnter()
      hasPointerMoveOpened = true
    }
  },
  onPointerleave(event) {
    if (event.defaultPrevented) return
    ctx.onTriggerLeave()
    hasPointerMoveOpened = false
  },
  onPointerdown(event) {
    if (event.defaultPrevented) return
    if (ctx.open.value) ctx.onClose()
    isPointerDown = true
    document.addEventListener('pointerup', onPointerUp, { once: true })
  },
  onFocus(event) {
    if (event.defaultPrevented) return
    // Keyboard focus shows the label; a click's focus does not.
    if (!isPointerDown) ctx.onOpen()
  },
  onBlur(event) {
    if (event.defaultPrevented) return
    ctx.onClose()
  },
  onClick(event) {
    if (event.defaultPrevented) return
    ctx.onClose()
  }
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
          'data-slot': 'tooltip-trigger',
          'aria-describedby': ctx.open.value ? ctx.contentId : undefined,
          'data-state': ctx.state.value
        },
        handlers
      )
    "
  >
    <slot />
  </Primitive>
</template>
