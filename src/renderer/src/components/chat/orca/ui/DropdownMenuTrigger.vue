<script setup>
// After Orca's components/ui/dropdown-menu.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DropdownMenuTrigger: a button (type="button") with aria-haspopup="menu",
 * aria-expanded, aria-controls, data-state. Like Radix it opens on pointer
 * down (left button, no Ctrl) and on Enter / Space / ArrowDown (then the
 * first item takes focus); a plain .click() does not toggle it.
 * Props: asChild, disabled.
 * <DropdownMenuTrigger as-child :disabled="busy"><Button variant="ghost" size="xs">…</Button></DropdownMenuTrigger>
 */
import { inject, onBeforeUnmount } from 'vue'
import { MENU, required } from './contexts.js'
import { Primitive, bindWith, elementOf } from './primitive.js'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  asChild: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
})

const ctx = required(inject(MENU, null), 'DropdownMenuTrigger', 'DropdownMenu')

function setEl(value) {
  ctx.triggerEl.value = elementOf(value)
}
onBeforeUnmount(() => (ctx.triggerEl.value = null))

const handlers = {
  onPointerdown(event) {
    if (event.defaultPrevented || props.disabled) return
    if (event.button === 0 && !event.ctrlKey) {
      const opening = !ctx.open.value
      ctx.toggle()
      // Keep focus off the trigger so the content can take it.
      if (opening) event.preventDefault()
    }
  },
  onKeydown(event) {
    if (event.defaultPrevented || props.disabled) return
    if (event.key === 'Enter' || event.key === ' ') ctx.toggle()
    if (event.key === 'ArrowDown') ctx.setOpen(true)
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') event.preventDefault()
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
          type: 'button',
          id: ctx.triggerId,
          'data-slot': 'dropdown-menu-trigger',
          'aria-haspopup': 'menu',
          'aria-expanded': ctx.open.value ? 'true' : 'false',
          'aria-controls': ctx.open.value ? ctx.contentId : undefined,
          'data-state': ctx.open.value ? 'open' : 'closed',
          'data-disabled': disabled ? '' : undefined,
          disabled: disabled || undefined
        },
        handlers
      )
    "
  >
    <slot />
  </Primitive>
</template>
