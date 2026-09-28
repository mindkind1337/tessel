<script setup>
import { computed } from 'vue'
import BrandIcon from '../BrandIcon.vue'
import StatsStatCard from './StatsStatCard.vue'
import StatsIcon from './StatsIcon.vue'
import { tokens, money, percent } from './statsFormat'
import { t, intlLocale } from '../../i18n'
const props = defineProps({
  overview: { type: Object, required: true },
  providers: { type: Array, default: () => [] },
  loading: Boolean
})
defineEmits(['refresh', 'enable', 'provider'])
const enabled = computed(() => props.providers.filter((row) => row.supported && row.enabled))
const ready = computed(() => enabled.value.filter((row) => row.report?.status === 'ready'))
const segments = computed(() => [
  { label: t('stats.mix.newInput', 'New input'), key: 'new', value: props.overview.newInputTokens },
  { label: t('stats.series.output', 'Output'), key: 'out', value: props.overview.outputTokens },
  { label: t('stats.mix.cache', 'Cache'), key: 'cache', value: props.overview.cacheTokens }
])
const mixTotal = computed(() => segments.value.reduce((total, row) => total + row.value, 0))
function dayLabel(day) {
  return day
    ? new Date(`${day}T12:00:00`).toLocaleDateString(intlLocale(), {
        month: 'short',
        day: 'numeric'
      })
    : ''
}
const updated = computed(() =>
  props.overview.lastUpdatedAt
    ? t('stats.updated', 'Updated {{time}}', {
        time: new Date(props.overview.lastUpdatedAt).toLocaleString(intlLocale())
      })
    : t('stats.notScanned', 'Not scanned yet')
)
const na = () => t('stats.na', 'n/a')
function dayTitle(day) {
  return t('stats.overview.dayTokens', '{{day}}: {{value}} tokens', {
    day: day.day,
    value: day.totalTokens.toLocaleString(intlLocale())
  })
}
function enableText(provider) {
  return t('stats.overview.enableProvider', 'Enable {{name}}', { name: provider.label })
}
function bestText() {
  return t('stats.overview.best', 'Best: {{day}}', { day: dayLabel(props.overview.bestDay?.day) })
}
function reasoningText() {
  return t('stats.overview.reasoning', '{{value}} reasoning', {
    value: tokens(props.overview.reasoningTokens)
  })
}
function mixText(segment) {
  return t('stats.overview.mixSegment', '{{series}}: {{value}}', {
    series: segment.label,
    value: tokens(segment.value)
  })
}
function countsText() {
  return t('stats.overview.providerCounts', '{{enabled}} enabled · {{withData}} with data', {
    enabled: enabled.value.length,
    withData: ready.value.filter((row) => row.report.hasData).length
  })
}
function sessionsText() {
  const sessions = props.overview.sessions
  return t('stats.overview.sessions', '{{value}} sessions', {
    value: sessions === null ? na() : sessions.toLocaleString(intlLocale())
  })
}
function tokensText(provider) {
  return t('stats.overview.tokens', '{{value}} tokens', {
    value: tokens(provider.report.summary.totalTokens)
  })
}
function activityText(provider) {
  const summary = provider.report.summary
  return t('stats.overview.sessionsActivity', '{{sessions}} sessions · {{count}} {{activity}}', {
    sessions: summary.sessions ?? na(),
    count: summary.activityCount,
    activity: summary.activityLabel
  })
}
function noReaderText(provider) {
  return t('stats.noReader', 'No local {{name}} usage reader is available in Tessel.', {
    name: provider.label
  })
}
function statusText(provider) {
  if (!provider.supported) return t('stats.overview.status.unavailable', 'Unavailable')
  if (provider.loading) return t('stats.overview.status.scanning', 'Scanning')
  return provider.enabled
    ? t('stats.overview.status.enabled', 'Enabled')
    : t('stats.overview.status.off', 'Off')
}
</script>
<template>
  <div class="su-overview" data-test="stats-overview">
    <section class="su-panel">
      <header class="su-section-head">
        <div>
          <h3>{{ t('stats.overview.title', 'Usage Overview') }}</h3>
          <p class="su-muted">
            {{ updated
            }}<span v-if="overview.hasPartialCost">
              &mdash; {{ t('stats.overview.partialCost', 'some model prices are unavailable') }}</span
            >
          </p>
        </div>
        <button
          type="button"
          class="su-icon-button"
          :disabled="loading || !enabled.length"
          :aria-label="t('stats.overview.refresh', 'Refresh usage overview')"
          data-test="stats-overview-refresh"
          @click="$emit('refresh')"
        >
          <StatsIcon kind="refresh" />
        </button>
      </header>
      <div v-if="!enabled.length" class="su-empty">
        <h4>{{ t('stats.overview.startTitle', 'Start tracking tokens') }}</h4>
        <p>
          {{
            t('stats.overview.startHint', 'Enable a provider to scan local agent logs and build the combined token ledger.'
            )
          }}
        </p>
        <div class="su-actions">
          <button
            v-for="provider in providers.filter((row) => row.supported)"
            :key="provider.id"
            type="button"
            class="su-button"
            @click="$emit('enable', provider.id)"
          >
            {{ enableText(provider) }}
          </button>
        </div>
      </div>
      <div v-else-if="!ready.length && loading" class="su-empty" role="status">
        {{ t('stats.scanning', 'Scanning local usage logs...') }}
      </div>
      <div v-else-if="!ready.length" class="su-empty">
        {{
          t('stats.overview.readError', 'Local usage could not be read. Check the provider errors below and refresh.'
          )
        }}
      </div>
      <template v-else>
        <div class="su-cards su-cards-four">
          <StatsStatCard
            :label="t('stats.totalTokens', 'Total tokens')"
            :value="tokens(overview.totalTokens)"
            icon="tokens"
          />
          <StatsStatCard
            :label="t('stats.estCost', 'Est. cost')"
            :value="money(overview.estimatedCostUsd)"
            icon="money"
          />
          <StatsStatCard
            :label="t('stats.overview.activeDays', 'Active days')"
            :value="overview.activeDays.toLocaleString(intlLocale())"
            icon="calendar"
          />
          <StatsStatCard
            :label="t('stats.overview.cacheShare', 'Cache share')"
            :value="percent(overview.cacheShare)"
            icon="cache"
          />
        </div>
        <p v-if="!overview.hasData" class="su-empty">
          {{
            t('stats.overview.noData', 'No local Claude or Codex usage found yet. The overview will populate after the next agent session writes token logs.'
            )
          }}
        </p>
        <div v-else class="su-overview-charts">
          <section class="su-panel su-inset">
            <header class="su-section-head">
              <div>
                <h4>{{ t('stats.overview.intensity', 'Daily intensity') }}</h4>
                <p class="su-muted">
                  {{
                    t('stats.overview.intensityHint', 'Recent combined Claude and Codex token activity.')
                  }}
                </p>
              </div>
              <span v-if="overview.bestDay" class="su-badge">{{ bestText() }}</span>
            </header>
            <div
              class="su-heatmap"
              role="img"
              :aria-label="t('stats.overview.heatmap', 'Recent token activity heatmap')"
            >
              <span
                v-for="day in overview.daily"
                :key="day.day"
                :class="'su-intensity-' + day.intensity"
                :title="dayTitle(day)"
                :aria-label="dayTitle(day)"
              ></span>
            </div>
            <div class="su-heatmap-legend">
              <span>{{ dayLabel(overview.daily[0]?.day) }}</span
              ><span>{{ t('stats.overview.less', 'Less') }}</span
              ><span class="su-heatmap-scale" aria-hidden="true"
                ><i v-for="n in 5" :key="n" :class="'su-intensity-' + (n - 1)"></i></span
              ><span>{{ t('stats.overview.more', 'More') }}</span
              ><span>{{ dayLabel(overview.daily.at(-1)?.day) }}</span>
            </div>
          </section>
          <section class="su-panel su-inset">
            <header class="su-section-head">
              <div>
                <h4>{{ t('stats.overview.mix', 'Token mix') }}</h4>
                <p class="su-muted">
                  {{
                    t('stats.overview.mixHint', 'Combined input, output, and cache tokens across enabled providers.'
                    )
                  }}
                </p>
              </div>
              <span v-if="overview.reasoningTokens > 0" class="su-badge">{{ reasoningText() }}</span>
            </header>
            <div
              class="su-token-mix"
              role="img"
              :aria-label="t('stats.overview.mixLabel', 'Combined token mix')"
            >
              <span
                v-for="segment in segments"
                :key="segment.key"
                :class="'su-mix-' + segment.key"
                :style="{ width: (mixTotal ? (segment.value / mixTotal) * 100 : 0) + '%' }"
                :title="mixText(segment)"
              ></span>
            </div>
            <div class="su-mix-legend">
              <span v-for="segment in segments" :key="segment.key"
                ><i :class="'su-mix-' + segment.key"></i
                >{{ mixText(segment) }}</span
              >
            </div>
          </section>
        </div>
      </template>
    </section>
    <section class="su-providers">
      <header class="su-section-head">
        <div>
          <h4>{{ t('stats.overview.providers', 'Providers') }}</h4>
          <p class="su-muted">
            {{ countsText() }}
          </p>
        </div>
        <span class="su-badge">{{ sessionsText() }}</span>
      </header>
      <div class="su-provider-grid">
        <article
          v-for="provider in providers"
          :key="provider.id"
          class="su-panel su-provider-card"
          :data-test="'stats-overview-' + provider.id"
        >
          <header class="su-section-head">
            <div>
              <button
                type="button"
                class="su-provider-title"
                @click="$emit('provider', provider.id)"
              >
                <BrandIcon :kind="provider.id" :size="15" :label="provider.label" /><strong>{{
                  provider.label
                }}</strong></button
              ><span class="su-badge">{{ statusText(provider) }}</span>
            </div>
            <button
              v-if="provider.supported && !provider.enabled"
              type="button"
              class="su-button"
              @click="$emit('enable', provider.id)"
            >
              {{ t('stats.overview.enable', 'Enable') }}
            </button>
          </header>
          <template
            v-if="provider.supported && provider.enabled && provider.report?.status === 'ready'"
            ><p class="su-muted su-provider-top">
              {{ provider.report.topModel || t('stats.overview.noModel', 'No model yet')
              }}<span v-if="provider.report.topProject">
                &mdash; {{ provider.report.topProject }}</span
              >
            </p>
            <div class="su-provider-metrics">
              <span>{{ tokensText(provider) }}</span
              ><span>{{ activityText(provider) }}</span
              ><span>{{ money(provider.report.summary.estimatedCostUsd) }}</span>
            </div>
            <div class="su-provider-share">
              <span
                :style="{
                  width:
                    (overview.totalTokens
                      ? (provider.report.summary.totalTokens / overview.totalTokens) * 100
                      : 0) + '%'
                }"
              ></span></div
          ></template>
          <p v-else-if="!provider.supported" class="su-muted">
            {{ noReaderText(provider) }}
          </p>
          <p v-else-if="!provider.enabled" class="su-muted">
            {{ t('stats.overview.off', 'Local usage analytics is off.') }}
          </p>
          <p v-if="provider.error" class="su-error" role="alert">
            {{ provider.error
            }}<span v-if="provider.report?.hasData">
              {{ t('stats.overview.lastScan', 'Showing the last successful scan.') }}</span
            >
          </p>
        </article>
      </div>
    </section>
  </div>
</template>
