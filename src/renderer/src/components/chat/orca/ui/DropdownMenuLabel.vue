<script setup>
// After Orca's components/ui/dropdown-menu.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/** DropdownMenuLabel (div): a small muted heading. Props: inset. */
defineProps({ inset: { type: Boolean, default: false } })
</script>

<template>
  <div data-slot="dropdown-menu-label" :data-inset="inset ? '' : undefined" class="nc-ui-menu-label">
    <slot />
  </div>
</template>
