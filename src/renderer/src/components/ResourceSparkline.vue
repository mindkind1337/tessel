<script setup>
// Orca's Sparkline (MIT, Copyright (c) 2026 Lovecast Inc.;
// src/renderer/src/components/status-bar/resource-usage-metrics.tsx): a thin
// line of a Resource Manager row's recent memory, 48 x 14, 1 px, muted.
import { computed } from 'vue'
import { sparklinePoints } from '../statusBarModel'

const props = defineProps({
  samples: { type: Array, default: () => [] },
  width: { type: Number, default: 48 },
  height: { type: Number, default: 14 }
})
const points = computed(() => sparklinePoints(props.samples, props.width, props.height))
</script>

<template>
  <svg
    class="sb-res-spark"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    aria-hidden="true"
    preserveAspectRatio="none"
  >
    <polyline :points="points" fill="none" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</template>
