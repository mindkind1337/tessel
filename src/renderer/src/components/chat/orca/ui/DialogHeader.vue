<script setup>
// After Orca's components/ui/dialog.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/** DialogHeader (div): title and description stacked, centred under 640px. */
</script>

<template>
  <div data-slot="dialog-header" class="nc-ui-dialog-header"><slot /></div>
</template>

<style>
.nc-ui-dialog-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: center;
}
@media (min-width: 640px) {
  .nc-ui-dialog-header {
    text-align: left;
  }
}
</style>
