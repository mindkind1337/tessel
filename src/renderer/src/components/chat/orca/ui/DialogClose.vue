<script setup>
// After Orca's components/ui/dialog.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DialogClose: a button (type="button") that closes the Dialog.
 * Props: asChild.
 * <DialogClose as-child><Button variant="outline">{{ cancelLabel }}</Button></DialogClose>
 */
import { inject } from 'vue'
import { DIALOG, required } from './contexts.js'
import { Primitive, bindWith } from './primitive.js'

defineOptions({ inheritAttrs: false })
defineProps({ asChild: { type: Boolean, default: false } })

const ctx = required(inject(DIALOG, null), 'DialogClose', 'Dialog')

function onClick(event) {
  if (event.defaultPrevented) return
  ctx.setOpen(false)
}
</script>

<template>
  <Primitive
    as="button"
    :as-child="asChild"
    v-bind="bindWith($attrs, { type: 'button', 'data-slot': 'dialog-close' }, { onClick })"
  >
    <slot />
  </Primitive>
</template>
