<script setup>
// After Orca's components/ui/progress.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Progress: role="progressbar" with Radix's aria-value* and data-state
 * ('loading' | 'complete' | 'indeterminate' when value is null).
 * Props: value (number | null, 0..max), max (default 100),
 *   getValueLabel(value, max) (default "NN%").
 * <Progress :value="filled" :aria-label="label" class="bar" />
 */
import { computed } from 'vue'

const props = defineProps({
  value: { type: Number, default: null },
  max: { type: Number, default: 100 },
  getValueLabel: { type: Function, default: null }
})

const max = computed(() => (Number.isFinite(props.max) && props.max > 0 ? props.max : 100))
const value = computed(() =>
  typeof props.value === 'number' && Number.isFinite(props.value) && props.value >= 0 && props.value <= max.value
    ? props.value
    : null
)
const state = computed(() =>
  value.value === null ? 'indeterminate' : value.value === max.value ? 'complete' : 'loading'
)
const valueLabel = computed(() => {
  if (value.value === null) return undefined
  if (props.getValueLabel) return props.getValueLabel(value.value, max.value)
  return `${Math.round((value.value / max.value) * 100)}%`
})
// Same as the reference: the value is read as a percentage.
const indicatorStyle = computed(() => ({ transform: `translateX(-${100 - (props.value || 0)}%)` })) // i18n-ignore
</script>

<template>
  <div
    role="progressbar"
    data-slot="progress"
    class="nc-ui-progress"
    :aria-valuemax="max"
    :aria-valuemin="0"
    :aria-valuenow="value ?? undefined"
    :aria-valuetext="valueLabel"
    :data-state="state"
    :data-value="value ?? undefined"
    :data-max="max"
  >
    <div
      data-slot="progress-indicator"
      class="nc-ui-progress-indicator"
      :data-state="state"
      :data-value="value ?? undefined"
      :data-max="max"
      :style="indicatorStyle"
    />
  </div>
</template>

<style>
.nc-ui-progress {
  position: relative;
  height: 8px;
  width: 100%;
  overflow: hidden;
  border-radius: 9999px;
  background-color: color-mix(in srgb, var(--nc-primary) 20%, transparent);
}
.nc-ui-progress-indicator {
  height: 100%;
  width: 100%;
  flex: 1 1 0%;
  background-color: var(--nc-primary);
  transition: all 300ms ease-out;
}
@media (prefers-reduced-motion: reduce) {
  .nc-ui-progress-indicator {
    transition: none;
  }
}
</style>
