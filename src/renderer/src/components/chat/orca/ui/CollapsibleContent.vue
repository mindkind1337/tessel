<script setup>
// After Orca's components/ui/collapsible.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * CollapsibleContent (div): rendered only while open, like Radix's Presence.
 * Props: forceMount (keep it in the DOM, with the hidden attribute, while
 *   closed).
 */
import { inject } from 'vue'
import { COLLAPSIBLE, required } from './contexts.js'

defineProps({ forceMount: { type: Boolean, default: false } })

const ctx = required(inject(COLLAPSIBLE, null), 'CollapsibleContent', 'Collapsible')
</script>

<template>
  <div
    v-if="forceMount || ctx.open.value"
    :id="ctx.contentId"
    data-slot="collapsible-content"
    :data-state="ctx.open.value ? 'open' : 'closed'"
    :data-disabled="ctx.disabled.value ? '' : undefined"
    :hidden="!ctx.open.value"
  >
    <slot v-if="ctx.open.value" />
  </div>
</template>
