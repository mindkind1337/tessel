<script setup>
// The Agent Session History tab's icon (Tabler's category glyph, in
// currentColor like the lucide tab icons), after Orca's
// agent-session-history-icon.tsx (MIT, Copyright (c) 2026 Lovecast Inc.).
defineProps({ size: { type: Number, default: 16 } })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 4h6v6h-6z" />
    <path d="M4 14h6v6h-6z" />
    <path d="M17 17m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
    <path d="M7 7m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
  </svg>
</template>
