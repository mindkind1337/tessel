<script setup>
// After Orca's components/ui/dialog.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DialogTrigger: a button (type="button") that opens the Dialog, with
 * aria-haspopup="dialog", aria-expanded, aria-controls and data-state. Focus
 * returns to it when the dialog closes.
 * Props: asChild.
 * <DialogTrigger as-child><Button variant="outline">{{ label }}</Button></DialogTrigger>
 */
import { inject, onBeforeUnmount } from 'vue'
import { DIALOG, required } from './contexts.js'
import { Primitive, bindWith, elementOf } from './primitive.js'

defineOptions({ inheritAttrs: false })
defineProps({ asChild: { type: Boolean, default: false } })

const ctx = required(inject(DIALOG, null), 'DialogTrigger', 'Dialog')

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
          'data-slot': 'dialog-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': ctx.open.value ? 'true' : 'false',
          'aria-controls': ctx.contentId,
          'data-state': ctx.open.value ? 'open' : 'closed'
        },
        { onClick }
      )
    "
  >
    <slot />
  </Primitive>
</template>
