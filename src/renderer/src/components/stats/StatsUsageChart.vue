<script setup>
import { computed } from 'vue'
import { tokens } from './statsFormat'
import { t, intlLocale } from '../../i18n'
const props = defineProps({
  daily: { type: Array, default: () => [] },
  provider: { type: String, required: true }
})
const segments = computed(() =>
  props.provider === 'claude'
    ? [
        { key: 'inputTokens', label: t('stats.series.input', 'Input'), color: 'input' },
        { key: 'outputTokens', label: t('stats.series.output', 'Output'), color: 'output' },
        { key: 'cacheReadTokens', label: t('stats.series.cacheRead', 'Cache read'), color: 'cache' },
        {
          key: 'cacheWriteTokens',
          label: t('stats.series.cacheWrite', 'Cache write'),
          color: 'reasoning'
        }
      ]
    : [
        { key: 'newInputTokens', label: t('stats.series.input', 'Input'), color: 'input' },
        { key: 'visibleOutput', label: t('stats.series.output', 'Output'), color: 'output' },
        {
          key: 'cachedInputTokens',
          label: t('stats.series.cachedInput', 'Cached input'),
          color: 'cache'
        },
        {
          key: 'reasoningTokens',
          label: t('stats.series.reasoning', 'Reasoning'),
          color: 'reasoning'
        }
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
function segmentTitle(day, segment) {
  return t('stats.chart.segment', '{{day}} - {{series}}: {{count}} tokens', {
    day: day.day,
    series: segment.label,
    count: day[segment.key].toLocaleString(intlLocale())
  })
}
</script>
<template>
  <section class="su-panel su-daily" data-test="stats-daily-chart">
    <header>
      <h4>{{ t('stats.chart.title', 'Daily usage') }}</h4>
      <p class="su-muted">
        {{
          provider === 'claude'
            ? t('stats.chart.claudeHint', 'Input, output, cache read, and cache write totals by day.')
            : t('stats.chart.codexHint', 'Input, cached input, output, and reasoning totals by day.')
        }}
      </p>
    </header>
    <div
      class="su-daily-grid"
      role="img"
      :aria-label="
        t('stats.chart.label', '{{provider}} daily token usage; latest ten days in the selected range', {
          provider
        })
      "
    >
      <div v-for="day in rows" :key="day.day" class="su-daily-column">
        <span class="su-daily-value">{{ tokens(day.totalTokens) }}</span>
        <div class="su-daily-bar">
          <div
            v-for="segment in barSegments"
            :key="segment.key"
            :class="'su-color-' + segment.color"
            :style="{ height: (day[segment.key] / maximum) * 100 + '%' }"
            :title="segmentTitle(day, segment)"
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
    <p v-if="provider !== 'claude'" class="su-muted su-chart-note">
      {{
        t('stats.chart.codexNote', 'Cached input and reasoning are included in the totals, not added twice.'
        )
      }}
    </p>
  </section>
</template>
