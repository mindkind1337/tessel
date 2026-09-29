<script setup>
// After Orca's components/ui/dialog.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DialogDescription (p): describes the dialog (its id is the panel's
 * aria-describedby). Hide it visually with class "nc-ui-sr-only".
 */
import { inject } from 'vue'
import { DIALOG, required } from './contexts.js'

const ctx = required(inject(DIALOG, null), 'DialogDescription', 'Dialog')
</script>

<template>
  <p :id="ctx.descriptionId" data-slot="dialog-description" class="nc-ui-dialog-description"><slot /></p>
</template>

<style>
.nc-ui-dialog-description {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
  color: var(--nc-muted-foreground);
}
</style>
