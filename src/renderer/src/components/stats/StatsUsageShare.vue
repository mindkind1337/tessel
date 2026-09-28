<script setup>
// Vue port of Orca ShareUsageCard / ShareUsageButton (MIT, Lovecast, 2026).
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { toBlob } from 'html-to-image'
import { X, Copy, Check, Loader2 } from 'lucide-vue-next'
import { tokens, money } from './statsFormat'
import { t, intlLocale } from '../../i18n'
const props = defineProps({
  provider: String,
  label: String,
  model: { type: Object, required: true },
  rangeLabel: String
})
const emit = defineEmits(['close'])
const dialog = ref(null),
  card = ref(null),
  busy = ref(false),
  copied = ref(false),
  error = ref('')
let timer,
  disposed = false
const totalTokens = computed(() =>
  props.provider === 'claude'
    ? props.model.summary.inputTokens + props.model.summary.outputTokens
    : props.model.summary.totalTokens
)
const daily = computed(() => props.model.byDay.slice(-10))
const maximum = computed(() => daily.value.reduce((max, day) => Math.max(max, day.totalTokens), 1))
const series = computed(() =>
  props.provider === 'claude'
    ? [
        {
          key: 'cacheWriteTokens',
          label: t('stats.series.cacheWrite', 'Cache write'),
          color: 'rgba(217,70,239,.7)'
        },
        {
          key: 'cacheReadTokens',
          label: t('stats.series.cacheRead', 'Cache read'),
          color: 'rgba(251,191,36,.7)'
        },
        { key: 'outputTokens', label: t('stats.series.output', 'Output'), color: 'rgba(52,211,153,.8)' },
        { key: 'inputTokens', label: t('stats.series.input', 'Input'), color: 'rgba(56,189,248,.8)' }
      ]
    : [
        { key: 'newInputTokens', label: t('stats.series.input', 'Input'), color: 'rgba(56,189,248,.8)' },
        { key: 'visibleOutput', label: t('stats.series.output', 'Output'), color: 'rgba(52,211,153,.8)' },
        {
          key: 'cachedInputTokens',
          label: t('stats.series.cachedInput', 'Cached input'),
          color: 'rgba(251,191,36,.7)'
        },
        {
          key: 'reasoningTokens',
          label: t('stats.series.reasoning', 'Reasoning'),
          color: 'rgba(217,70,239,.7)'
        }
      ]
)
// The legend reads input, output, then the cache and reasoning series.
const LEGEND_ORDER = [
  'inputTokens',
  'newInputTokens',
  'outputTokens',
  'visibleOutput',
  'cacheReadTokens',
  'cacheWriteTokens',
  'cachedInputTokens',
  'reasoningTokens'
]
const legend = computed(() =>
  [...series.value].sort((a, b) => LEGEND_ORDER.indexOf(a.key) - LEGEND_ORDER.indexOf(b.key))
)
const value = (day, key) =>
  key === 'visibleOutput' ? Math.max(0, day.outputTokens - day.reasoningTokens) : day[key]
const na = () => t('stats.na', 'n/a')
const cardTitle = () => t('stats.share.cardTitle', '{{name}} Usage', { name: props.label })
function activityText() {
  const vars = {
    sessions: props.model.summary.sessions ?? na(),
    count: props.model.summary.activityCount
  }
  return props.provider === 'claude'
    ? t('stats.provider.rowTurns', '{{sessions}} sessions · {{count}} turns', vars)
    : t('stats.provider.rowEvents', '{{sessions}} sessions · {{count}} events', vars)
}
const dateRange = computed(() => {
  const range = props.model.range
  const end = range?.to ? new Date(range.to + 'T12:00:00') : new Date()
  const endText = end.toLocaleDateString(intlLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  return range?.from
    ? t('stats.share.dateRange', '{{from}} - {{to}}', {
        from: new Date(range.from + 'T12:00:00').toLocaleDateString(intlLocale(), {
          month: 'short',
          day: 'numeric'
        }),
        to: endText
      })
    : t('stats.share.through', 'Through {{date}}', { date: endText })
})
onMounted(() => dialog.value?.focus())
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(timer)
})
async function copyImage() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (
      !window.shellApi.writeClipboardImage &&
      (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    )
      throw new Error(
        t('stats.share.noClipboard', 'Image clipboard is not available in this window.')
      )
    const blob = await toBlob(card.value, { pixelRatio: 2, skipFonts: true })
    if (!blob) throw new Error(t('stats.share.renderError', 'Could not render the usage image.'))
    if (window.shellApi.writeClipboardImage) {
      const result = await window.shellApi.writeClipboardImage(
        new Uint8Array(await blob.arrayBuffer())
      )
      if (!result?.ok)
        throw new Error(
          result?.error || t('stats.share.copyError', 'Could not copy the usage image.')
        )
    } else await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    if (!disposed) {
      copied.value = true
      timer = setTimeout(() => {
        copied.value = false
      }, 2000)
    }
  } catch (cause) {
    if (!disposed)
      error.value = cause.message || t('stats.share.copyError', 'Could not copy the usage image.')
  } finally {
    if (!disposed) busy.value = false
  }
}
function shareOnX() {
  const text = t('stats.share.post', '{{name}} usage - {{range}}: {{tokens}} tokens, {{cost}} estimated API-equivalent cost. Tracked locally with Tessel.',
    {
      name: props.label,
      range: props.rangeLabel,
      tokens: tokens(totalTokens.value),
      cost: money(props.model.summary.estimatedCostUsd)
    }
  )
  window.shellApi.openExternal?.('https://x.com/intent/post?text=' + encodeURIComponent(text))
}
</script>
<template>
  <div
    class="su-share-backdrop"
    @pointerdown.self="emit('close')"
    @keydown.escape.stop.prevent="emit('close')"
  >
    <section
      ref="dialog"
      class="su-share-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="t('stats.share.title', 'Share usage')"
      tabindex="-1"
    >
      <header class="su-section-head">
        <h3>{{ t('stats.share.title', 'Share usage') }}</h3>
        <button
          type="button"
          class="su-icon-button"
          :aria-label="t('stats.share.close', 'Close share usage')"
          @click="emit('close')"
        >
          <X :size="16" />
        </button>
      </header>
      <div ref="card" class="su-share-card">
        <div class="su-share-glow su-share-glow-top"></div>
        <div class="su-share-glow su-share-glow-bottom"></div>
        <header class="su-share-card-head">
          <div class="su-share-brand">
            <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
              <path fill="white" d="M2 2h9v9H2Zm13 0h9v9h-9ZM2 15h9v9H2Zm13 0h9v9h-9Z" /></svg
            ><span
              ><strong>Tessel</strong
              ><small>{{ cardTitle() }}</small></span
            >
          </div>
          <span class="su-share-range">{{ rangeLabel }}</span>
        </header>
        <p class="su-share-dates">{{ dateRange }}</p>
        <div class="su-share-numbers">
          <div class="su-share-cost">
            <strong>{{ money(model.summary.estimatedCostUsd) }}</strong
            ><span>{{ t('stats.estCost', 'Est. cost') }}</span>
          </div>
          <div>
            <strong>{{ tokens(totalTokens) }}</strong
            ><span>{{ t('stats.totalTokens', 'Total tokens') }}</span>
          </div>
          <div>
            <strong class="su-share-model">{{ model.topModel || na() }}</strong
            ><span>{{ t('stats.share.topModel', 'Top model') }}</span>
          </div>
        </div>
        <div class="su-share-chart-head">
          <span>{{ t('stats.share.dailyTokens', 'Daily tokens') }}</span
          ><small>{{ activityText() }}</small>
        </div>
        <div class="su-share-chart">
          <div v-for="day in daily" :key="day.day" class="su-share-day">
            <span>{{ tokens(day.totalTokens) }}</span>
            <div class="su-share-day-bar">
              <i
                v-for="segment in series"
                :key="segment.key"
                :style="{
                  height: (value(day, segment.key) / maximum) * 100 + '%',
                  background: segment.color
                }"
              ></i>
            </div>
            <span>{{ day.day.slice(5) }}</span>
          </div>
        </div>
        <div class="su-share-legend">
          <span v-for="segment in legend" :key="segment.key"
            ><i :style="{ background: segment.color }"></i>{{ segment.label }}</span
          >
        </div>
        <footer class="su-share-card-footer">
          <span
            ><strong>{{ tokens(model.summary.inputTokens) }}</strong>
            {{ t('stats.share.input', 'input') }}</span
          ><span
            ><strong>{{ tokens(model.summary.outputTokens) }}</strong>
            {{ t('stats.share.output', 'output') }}</span
          ><span>Tessel</span>
        </footer>
      </div>
      <p v-if="error" class="su-error" role="alert">{{ error }}</p>
      <div class="su-share-actions">
        <button
          type="button"
          class="su-button"
          :disabled="busy"
          data-test="stats-copy-image"
          @click="copyImage"
        >
          <Loader2 v-if="busy" :size="14" /><Check v-else-if="copied" :size="14" /><Copy
            v-else
            :size="14"
          />{{
            copied
              ? t('stats.share.copied', 'Copied')
              : busy
                ? t('stats.share.copying', 'Copying...')
                : t('stats.share.copy', 'Copy image')
          }}</button
        ><button type="button" class="su-button" data-test="stats-share-x" @click="shareOnX">
          {{ t('stats.share.onX', 'Share on X') }}
        </button>
      </div>
    </section>
  </div>
</template>
