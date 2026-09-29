<script setup>
// After Orca's components/ui/card.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/** CardDescription (div): 14px muted text. */
</script>

<template>
  <div data-slot="card-description" class="nc-ui-card-description"><slot /></div>
</template>

<style>
.nc-ui-card-description {
  font-size: 14px;
  line-height: 20px;
  color: var(--nc-muted-foreground);
}
</style>
