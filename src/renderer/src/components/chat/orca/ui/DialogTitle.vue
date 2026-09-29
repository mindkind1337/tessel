<script setup>
// After Orca's components/ui/dialog.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/** DialogTitle (h2): names the dialog (its id is the panel's aria-labelledby). */
import { inject } from 'vue'
import { DIALOG, required } from './contexts.js'

const ctx = required(inject(DIALOG, null), 'DialogTitle', 'Dialog')
</script>

<template>
  <h2 :id="ctx.titleId" data-slot="dialog-title" class="nc-ui-dialog-title"><slot /></h2>
</template>

<style>
.nc-ui-dialog-title {
  margin: 0;
  font-size: 18px;
  line-height: 1.375;
  font-weight: 600;
  overflow-wrap: break-word;
}
</style>
