<script setup>
// After Orca's components/ui/card.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Card (div). Parts: CardHeader, CardTitle, CardDescription, CardContent.
 * No props; class and attributes go to the div.
 * <Card class="notice"><CardHeader><CardTitle>{{ title }}</CardTitle></CardHeader>
 *   <CardContent>{{ body }}</CardContent></Card>
 */
</script>

<template>
  <div data-slot="card" class="nc-ui-card"><slot /></div>
</template>

<style>
.nc-ui-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 24px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--nc-border) 50%, transparent);
  background-color: var(--nc-card);
  padding-top: 24px;
  padding-bottom: 24px;
  color: var(--nc-card-foreground);
  box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
}
</style>
