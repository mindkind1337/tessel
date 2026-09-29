<script setup>
// After Orca's components/ui/card.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/** CardHeader (div): a grid; a child with data-slot="card-action" gets its own column. */
</script>

<template>
  <div data-slot="card-header" class="nc-ui-card-header"><slot /></div>
</template>

<style>
.nc-ui-card-header {
  box-sizing: border-box;
  container-type: inline-size;
  container-name: card-header;
  display: grid;
  grid-auto-rows: min-content;
  grid-template-rows: auto auto;
  align-items: start;
  gap: 8px;
  padding-left: 24px;
  padding-right: 24px;
}
.nc-ui-card-header:has([data-slot='card-action']) {
  grid-template-columns: 1fr auto;
}
.nc-ui-card-header.border-b {
  padding-bottom: 24px;
}
</style>
