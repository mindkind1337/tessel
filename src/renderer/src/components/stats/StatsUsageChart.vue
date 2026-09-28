<!-- i18n-pending: text here does not go through t() yet -->
<script setup>
import { computed } from 'vue'
import { tokens } from './statsFormat'
const props = defineProps({
  daily: { type: Array, default: () => [] },
  provider: { type: String, required: true }
})
const segments = computed(() =>
  props.provider === 'claude'
    ? [
        { key: 'inputTokens', label: 'Input', color: 'input' },
        { key: 'outputTokens', label: 'Output', color: 'output' },
        { key: 'cacheReadTokens', label: 'Cache read', color: 'cache' },
        { key: 'cacheWriteTokens', label: 'Cache write', color: 'reasoning' }
      ]
    : [
        { key: 'newInputTokens', label: 'Input', color: 'input' },
        { key: 'visibleOutput', label: 'Output', color: 'output' },
        { key: 'cachedInputTokens', label: 'Cached input', color: 'cache' },
        { key: 'reasoningTokens', label: 'Reasoning', color: 'reasoning' }
      ]
)
const rows = computed(() =>
  props.daily
    .slice(-10)
    .map((row) => ({ ...row, visibleOutput: Math.max(0, row.outputTokens - row.reasoningTokens) }))
)
const maximum = computed(() => props.daily.reduce((max, row) => Math.max(max, row.totalTokens), 1))
const barSegments = computed(() =>
  props.provider === 'claude' ? [...segments.value].reverse() : segments.value
)
</script>
<template>
  <section class="su-panel su-daily" data-test="stats-daily-chart">
    <header>
      <h4>Daily usage</h4>
      <p class="su-muted">
        {{
          provider === 'claude'
            ? 'Input, output, cache read, and cache write totals by day.'
            : 'Input, cached input, output, and reasoning totals by day.'
        }}
      </p>
    </header>
    <div
      class="su-daily-grid"
      role="img"
      :aria-label="provider + ' daily token usage; latest ten days in the selected range'"
    >
      <div v-for="day in rows" :key="day.day" class="su-daily-column">
        <span class="su-daily-value">{{ tokens(day.totalTokens) }}</span>
        <div class="su-daily-bar">
          <div
            v-for="segment in barSegments"
            :key="segment.key"
            :class="'su-color-' + segment.color"
            :style="{ height: (day[segment.key] / maximum) * 100 + '%' }"
            :title="
              day.day + ' - ' + segment.label + ': ' + day[segment.key].toLocaleString() + ' tokens'
            "
            :data-segment="segment.key"
          ></div>
        </div>
        <span class="su-daily-label">{{ day.day.slice(5) }}</span>
      </div>
    </div>
    <div class="su-chart-legend">
      <span v-for="segment in segments" :key="segment.key"
        ><i :class="'su-color-' + segment.color"></i>{{ segment.label }}</span
      >
    </div>
    <p v-if="provider === 'codex'" class="su-muted su-chart-note">
      Cached input and reasoning are included in the totals, not added twice.
    </p>
  </section>
</template>
