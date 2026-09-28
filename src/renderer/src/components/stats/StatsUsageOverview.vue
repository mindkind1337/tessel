<script setup>
import { computed } from 'vue'
import BrandIcon from '../BrandIcon.vue'
import StatsStatCard from './StatsStatCard.vue'
import StatsIcon from './StatsIcon.vue'
import { tokens, money, percent } from './statsFormat'
const props = defineProps({
  overview: { type: Object, required: true },
  providers: { type: Array, default: () => [] },
  loading: Boolean
})
defineEmits(['refresh', 'enable', 'provider'])
const enabled = computed(() => props.providers.filter((row) => row.supported && row.enabled))
const ready = computed(() => enabled.value.filter((row) => row.report?.status === 'ready'))
const segments = computed(() => [
  { label: 'New input', key: 'new', value: props.overview.newInputTokens },
  { label: 'Output', key: 'out', value: props.overview.outputTokens },
  { label: 'Cache', key: 'cache', value: props.overview.cacheTokens }
])
const mixTotal = computed(() => segments.value.reduce((total, row) => total + row.value, 0))
function dayLabel(day) {
  return day
    ? new Date(`${day}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })
    : ''
}
const updated = computed(() =>
  props.overview.lastUpdatedAt
    ? `Updated ${new Date(props.overview.lastUpdatedAt).toLocaleString()}`
    : 'Not scanned yet'
)
</script>
<template>
  <div class="su-overview" data-test="stats-overview">
    <section class="su-panel">
      <header class="su-section-head">
        <div>
          <h3>Usage Overview</h3>
          <p class="su-muted">
            {{ updated
            }}<span v-if="overview.hasPartialCost"> &mdash; some model prices are unavailable</span>
          </p>
        </div>
        <button
          type="button"
          class="su-icon-button"
          :disabled="loading || !enabled.length"
          aria-label="Refresh usage overview"
          data-test="stats-overview-refresh"
          @click="$emit('refresh')"
        >
          <StatsIcon kind="refresh" />
        </button>
      </header>
      <div v-if="!enabled.length" class="su-empty">
        <h4>Start tracking tokens</h4>
        <p>Enable a provider to scan local agent logs and build the combined token ledger.</p>
        <div class="su-actions">
          <button
            v-for="provider in providers.filter((row) => row.supported)"
            :key="provider.id"
            type="button"
            class="su-button"
            @click="$emit('enable', provider.id)"
          >
            Enable {{ provider.label }}
          </button>
        </div>
      </div>
      <div v-else-if="!ready.length && loading" class="su-empty" role="status">
        Scanning local usage logs...
      </div>
      <div v-else-if="!ready.length" class="su-empty">
        Local usage could not be read. Check the provider errors below and refresh.
      </div>
      <template v-else>
        <div class="su-cards su-cards-four">
          <StatsStatCard label="Total tokens" :value="tokens(overview.totalTokens)" icon="tokens" />
          <StatsStatCard label="Est. cost" :value="money(overview.estimatedCostUsd)" icon="money" />
          <StatsStatCard
            label="Active days"
            :value="overview.activeDays.toLocaleString()"
            icon="calendar"
          />
          <StatsStatCard label="Cache share" :value="percent(overview.cacheShare)" icon="cache" />
        </div>
        <p v-if="!overview.hasData" class="su-empty">
          No local Claude or Codex usage found yet. The overview will populate after the next agent
          session writes token logs.
        </p>
        <div v-else class="su-overview-charts">
          <section class="su-panel su-inset">
            <header class="su-section-head">
              <div>
                <h4>Daily intensity</h4>
                <p class="su-muted">Recent combined Claude and Codex token activity.</p>
              </div>
              <span v-if="overview.bestDay" class="su-badge"
                >Best: {{ dayLabel(overview.bestDay.day) }}</span
              >
            </header>
            <div class="su-heatmap" role="img" aria-label="Recent token activity heatmap">
              <span
                v-for="day in overview.daily"
                :key="day.day"
                :class="'su-intensity-' + day.intensity"
                :title="day.day + ': ' + day.totalTokens.toLocaleString() + ' tokens'"
                :aria-label="day.day + ': ' + day.totalTokens.toLocaleString() + ' tokens'"
              ></span>
            </div>
            <div class="su-heatmap-legend">
              <span>{{ dayLabel(overview.daily[0]?.day) }}</span
              ><span>Less</span
              ><span class="su-heatmap-scale" aria-hidden="true"
                ><i v-for="n in 5" :key="n" :class="'su-intensity-' + (n - 1)"></i></span
              ><span>More</span><span>{{ dayLabel(overview.daily.at(-1)?.day) }}</span>
            </div>
          </section>
          <section class="su-panel su-inset">
            <header class="su-section-head">
              <div>
                <h4>Token mix</h4>
                <p class="su-muted">
                  Combined input, output, and cache tokens across enabled providers.
                </p>
              </div>
              <span v-if="overview.reasoningTokens > 0" class="su-badge"
                >{{ tokens(overview.reasoningTokens) }} reasoning</span
              >
            </header>
            <div class="su-token-mix" role="img" aria-label="Combined token mix">
              <span
                v-for="segment in segments"
                :key="segment.key"
                :class="'su-mix-' + segment.key"
                :style="{ width: (mixTotal ? (segment.value / mixTotal) * 100 : 0) + '%' }"
                :title="segment.label + ': ' + tokens(segment.value)"
              ></span>
            </div>
            <div class="su-mix-legend">
              <span v-for="segment in segments" :key="segment.key"
                ><i :class="'su-mix-' + segment.key"></i>{{ segment.label }}:
                {{ tokens(segment.value) }}</span
              >
            </div>
          </section>
        </div>
      </template>
    </section>
    <section class="su-providers">
      <header class="su-section-head">
        <div>
          <h4>Providers</h4>
          <p class="su-muted">
            {{ enabled.length }} enabled &middot;
            {{ ready.filter((row) => row.report.hasData).length }} with data
          </p>
        </div>
        <span class="su-badge"
          >{{
            overview.sessions === null ? 'n/a' : overview.sessions.toLocaleString()
          }}
          sessions</span
        >
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
              ><span class="su-badge">{{
                !provider.supported
                  ? 'Unavailable'
                  : provider.loading
                    ? 'Scanning'
                    : provider.enabled
                      ? 'Enabled'
                      : 'Off'
              }}</span>
            </div>
            <button
              v-if="provider.supported && !provider.enabled"
              type="button"
              class="su-button"
              @click="$emit('enable', provider.id)"
            >
              Enable
            </button>
          </header>
          <template
            v-if="provider.supported && provider.enabled && provider.report?.status === 'ready'"
            ><p class="su-muted su-provider-top">
              {{ provider.report.topModel || 'No model yet'
              }}<span v-if="provider.report.topProject">
                &mdash; {{ provider.report.topProject }}</span
              >
            </p>
            <div class="su-provider-metrics">
              <span>{{ tokens(provider.report.summary.totalTokens) }} tokens</span
              ><span
                >{{ provider.report.summary.sessions ?? 'n/a' }} sessions &middot;
                {{ provider.report.summary.activityCount }}
                {{ provider.report.summary.activityLabel }}</span
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
            No local {{ provider.label }} usage reader is available in Tessel.
          </p>
          <p v-else-if="!provider.enabled" class="su-muted">Local usage analytics is off.</p>
          <p v-if="provider.error" class="su-error" role="alert">
            {{ provider.error
            }}<span v-if="provider.report?.hasData"> Showing the last successful scan.</span>
          </p>
        </article>
      </div>
    </section>
  </div>
</template>
