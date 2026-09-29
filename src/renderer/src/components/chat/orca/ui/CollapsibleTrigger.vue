<script setup>
// After Orca's components/ui/collapsible.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * CollapsibleTrigger: a button (type="button") toggling the Collapsible,
 * with aria-controls, aria-expanded and data-state 'open' | 'closed'
 * (style an open chevron with .row[data-state='open'] .chevron).
 * Props: asChild (the slot child becomes the trigger).
 * A @click that calls event.preventDefault() keeps it from toggling.
 */
import { inject } from 'vue'
import { COLLAPSIBLE, required } from './contexts.js'
import { Primitive, bindWith } from './primitive.js'

defineOptions({ inheritAttrs: false })
defineProps({ asChild: { type: Boolean, default: false } })

const ctx = required(inject(COLLAPSIBLE, null), 'CollapsibleTrigger', 'Collapsible')

function onClick(event) {
  if (event.defaultPrevented || ctx.disabled.value) return
  ctx.toggle()
}
</script>

<template>
  <Primitive
    as="button"
    :as-child="asChild"
    v-bind="
      bindWith(
        $attrs,
        {
          type: 'button',
          'data-slot': 'collapsible-trigger',
          'aria-controls': ctx.contentId,
          'aria-expanded': ctx.open.value ? 'true' : 'false',
          'data-state': ctx.open.value ? 'open' : 'closed',
          'data-disabled': ctx.disabled.value ? '' : undefined,
          disabled: ctx.disabled.value || undefined
        },
        { onClick }
      )
    "
  >
    <slot />
  </Primitive>
</template>
