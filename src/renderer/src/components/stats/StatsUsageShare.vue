<script setup>
// Vue port of Orca ShareUsageCard / ShareUsageButton (MIT, Lovecast, 2026).
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { toBlob } from 'html-to-image'
import { X, Copy, Check, Loader2 } from 'lucide-vue-next'
import { tokens, money } from './statsFormat'
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
        { key: 'cacheWriteTokens', label: 'Cache write', color: 'rgba(217,70,239,.7)' },
        { key: 'cacheReadTokens', label: 'Cache read', color: 'rgba(251,191,36,.7)' },
        { key: 'outputTokens', label: 'Output', color: 'rgba(52,211,153,.8)' },
        { key: 'inputTokens', label: 'Input', color: 'rgba(56,189,248,.8)' }
      ]
    : [
        { key: 'newInputTokens', label: 'Input', color: 'rgba(56,189,248,.8)' },
        { key: 'visibleOutput', label: 'Output', color: 'rgba(52,211,153,.8)' },
        { key: 'cachedInputTokens', label: 'Cached input', color: 'rgba(251,191,36,.7)' },
        { key: 'reasoningTokens', label: 'Reasoning', color: 'rgba(217,70,239,.7)' }
      ]
)
const value = (day, key) =>
  key === 'visibleOutput' ? Math.max(0, day.outputTokens - day.reasoningTokens) : day[key]
const dateRange = computed(() => {
  const range = props.model.range
  const end = range?.to ? new Date(range.to + 'T12:00:00') : new Date()
  const endText = end.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
  return range?.from
    ? new Date(range.from + 'T12:00:00').toLocaleDateString([], {
        month: 'short',
        day: 'numeric'
      }) +
        ' - ' +
        endText
    : 'Through ' + endText
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
      throw new Error('Image clipboard is not available in this window.')
    const blob = await toBlob(card.value, { pixelRatio: 2, skipFonts: true })
    if (!blob) throw new Error('Could not render the usage image.')
    if (window.shellApi.writeClipboardImage) {
      const result = await window.shellApi.writeClipboardImage(
        new Uint8Array(await blob.arrayBuffer())
      )
      if (!result?.ok) throw new Error(result?.error || 'Could not copy the usage image.')
    } else await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    if (!disposed) {
      copied.value = true
      timer = setTimeout(() => {
        copied.value = false
      }, 2000)
    }
  } catch (cause) {
    if (!disposed) error.value = cause.message || 'Could not copy the usage image.'
  } finally {
    if (!disposed) busy.value = false
  }
}
function shareOnX() {
  const text =
    props.label +
    ' usage - ' +
    props.rangeLabel +
    ': ' +
    tokens(totalTokens.value) +
    ' tokens, ' +
    money(props.model.summary.estimatedCostUsd) +
    ' estimated API-equivalent cost. Tracked locally with Tessel.'
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
      aria-label="Share usage"
      tabindex="-1"
    >
      <header class="su-section-head">
        <h3>Share usage</h3>
        <button
          type="button"
          class="su-icon-button"
          aria-label="Close share usage"
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
              ><strong>Tessel</strong><small>{{ label }} Usage</small></span
            >
          </div>
          <span class="su-share-range">{{ rangeLabel }}</span>
        </header>
        <p class="su-share-dates">{{ dateRange }}</p>
        <div class="su-share-numbers">
          <div class="su-share-cost">
            <strong>{{ money(model.summary.estimatedCostUsd) }}</strong
            ><span>Est. cost</span>
          </div>
          <div>
            <strong>{{ tokens(totalTokens) }}</strong
            ><span>Total tokens</span>
          </div>
          <div>
            <strong class="su-share-model">{{ model.topModel || 'n/a' }}</strong
            ><span>Top model</span>
          </div>
        </div>
        <div class="su-share-chart-head">
          <span>Daily tokens</span
          ><small
            >{{ model.summary.sessions ?? 'n/a' }} sessions &middot;
            {{ model.summary.activityCount }}
            {{ provider === 'claude' ? 'turns' : 'events' }}</small
          >
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
          <span
            v-for="segment in [...series].sort(
              (a, b) =>
                [
                  'Input',
                  'Output',
                  'Cache read',
                  'Cache write',
                  'Cached input',
                  'Reasoning'
                ].indexOf(a.label) -
                [
                  'Input',
                  'Output',
                  'Cache read',
                  'Cache write',
                  'Cached input',
                  'Reasoning'
                ].indexOf(b.label)
            )"
            :key="segment.key"
            ><i :style="{ background: segment.color }"></i>{{ segment.label }}</span
          >
        </div>
        <footer class="su-share-card-footer">
          <span
            ><strong>{{ tokens(model.summary.inputTokens) }}</strong> input</span
          ><span
            ><strong>{{ tokens(model.summary.outputTokens) }}</strong> output</span
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
          />{{ copied ? 'Copied' : busy ? 'Copying...' : 'Copy image' }}</button
        ><button type="button" class="su-button" data-test="stats-share-x" @click="shareOnX">
          Share on X
        </button>
      </div>
    </section>
  </div>
</template>
