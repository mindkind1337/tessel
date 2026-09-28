<script setup>
// Port of Orca StatCard.tsx, MIT Copyright (c) 2026 Lovecast Inc.
import StatsIcon from './StatsIcon.vue'
defineProps({ label: String, value: [String, Number], icon: String })
</script>
<template>
  <div class="su-card">
    <div class="su-card-icon"><StatsIcon :kind="icon" /></div>
    <div class="su-card-copy">
      <p class="su-card-value">{{ value }}</p>
      <p class="su-card-label">{{ label }}</p>
    </div>
  </div>
</template>
