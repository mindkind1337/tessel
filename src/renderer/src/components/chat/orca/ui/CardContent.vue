<script setup>
// After Orca's components/ui/card.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/** CardContent (div): 24px side padding. */
</script>

<template>
  <div data-slot="card-content" class="nc-ui-card-content"><slot /></div>
</template>

<style>
.nc-ui-card-content {
  box-sizing: border-box;
  padding-left: 24px;
  padding-right: 24px;
}
</style>
