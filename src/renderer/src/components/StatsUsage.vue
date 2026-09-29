<script setup>
// Vue port of Orca's StatsPane / UsageOverviewPane / provider panes
// (MIT, Copyright (c) 2026 Lovecast Inc.). Reads Tessel's local reports.
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'
import BrandIcon from './BrandIcon.vue'
import ResetHistory from './ResetHistory.vue'
import UsageVisibility from './UsageVisibility.vue'
import { settings } from '../settings'
import { loadUsageProviders } from '../usageProviders'
import StatsStatCard from './stats/StatsStatCard.vue'
import StatsIcon from './stats/StatsIcon.vue'
import StatsUsageOverview from './stats/StatsUsageOverview.vue'
import StatsUsageProvider from './stats/StatsUsageProvider.vue'
import {
  normalizeUsageReport,
  buildUsageOverview,
  usageDateRange,
  USAGE_REPORT_PROVIDERS
} from '../usageStats'
import { duration } from './stats/statsFormat'
import './stats/statsUsage.css'
import { t, intlLocale } from '../i18n'

const props = defineProps({
  initialProvider: { type: String, default: 'overview' },
  worktreePaths: { type: Array, default: () => [] },
  statsSummary: { type: Object, default: null }
})
const catalog = ref([])
const catalogError = ref('')
const PROVIDERS = computed(() => [
  { id: 'overview', label: t('stats.overviewTab', 'Overview') },
  ...catalog.value
    .filter((p) => p.report && !settings.hiddenUsageProviders.includes(p.id))
    .map((p) => ({ id: p.id, label: p.id === 'claude' ? 'Claude' : p.name }))
])
// Each local report and the shellApi call that reads it.
const REPORTERS = {
  claude: 'claudeUsageReport',
  codex: 'codexUsageReport',
  opencode: 'opencodeUsageReport'
}
const PREF_KEY = 'tessel:usage-analytics'
function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}')
    return Object.fromEntries(USAGE_REPORT_PROVIDERS.map((id) => [id, saved[id] !== false]))
  } catch {
    return Object.fromEntries(USAGE_REPORT_PROVIDERS.map((id) => [id, true]))
  }
}
const enabled = ref(readPreferences())
const active = ref(
  ['overview', ...USAGE_REPORT_PROVIDERS].includes(props.initialProvider)
    ? props.initialProvider
    : 'overview'
)
const selectionOpen = ref(false)
const reports = ref({})
// Overview uses the same provider scope/range selection, as in Orca's store.
const overviewReports = reports
const loading = ref({})
const errors = ref({})
const stats = ref(null)
const statsError = ref('')
const range = ref(Object.fromEntries(USAGE_REPORT_PROVIDERS.map((id) => [id, '30d'])))
const scope = ref(Object.fromEntries(USAGE_REPORT_PROVIDERS.map((id) => [id, 'tessel'])))
const root = ref(null)
const queryKeys = new Map()
const requests = new Map()
const pendingQueries = new Map()
let disposed = false
let statsRequest = 0
let catalogRequest = 0
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const label = computed(
  () =>
    PROVIDERS.value.find((provider) => provider.id === active.value)?.label ||
    t('stats.overviewTab', 'Overview')
)
const summary = computed(() => props.statsSummary || stats.value)
const available = (id) =>
  !!REPORTERS[id] &&
  typeof window.shellApi?.[REPORTERS[id]] === 'function' &&
  PROVIDERS.value.some((p) => p.id === id && id !== 'overview')
const current = computed(
  () =>
    reports.value[active.value] ||
    (USAGE_REPORT_PROVIDERS.includes(active.value) ? normalizeUsageReport(active.value, null) : null)
)
const overview = computed(() =>
  buildUsageOverview(
    Object.fromEntries(
      USAGE_REPORT_PROVIDERS.filter((id) => enabled.value[id] && available(id))
        .map((id) => [id, overviewReports.value[id]])
    ),
    { timezone, dayCount: 42 }
  )
)
const providerRows = computed(() =>
  PROVIDERS.value
    .filter((provider) => provider.id !== 'overview')
    .map((provider) => ({
      ...provider,
      report: overviewReports.value[provider.id],
      supported: available(provider.id),
      enabled: enabled.value[provider.id] === true,
      loading: loading.value[`provider:${provider.id}`], // i18n-ignore
      error: errors.value[`provider:${provider.id}`] // i18n-ignore
    }))
)
const overviewBusy = computed(() => Object.values(loading.value).some(Boolean))
async function detectProviders() {
  const request = ++catalogRequest
  try {
    const result = await loadUsageProviders()
    if (disposed || request !== catalogRequest) return
    catalog.value = result
    catalogError.value = ''
    if (!PROVIDERS.value.some((p) => p.id === active.value)) active.value = 'overview'
  } catch {
    if (!disposed && request === catalogRequest)
      catalogError.value = t('stats.catalogError', 'Could not detect installed usage providers. Refresh to retry.'
      )
  }
}
watch(
  () => settings.hiddenUsageProviders,
  () => {
    if (!PROVIDERS.value.some((p) => p.id === active.value)) active.value = 'overview'
    for (const p of PROVIDERS.value) if (p.id !== 'overview') loadProvider(p.id)
  },
  { deep: true }
)

async function loadStats() {
  if (!window.shellApi?.statsUsage?.summary || props.statsSummary) return
  const request = ++statsRequest
  try {
    const result = await window.shellApi.statsUsage.summary()
    if (disposed || request !== statsRequest) return
    if (!result?.ok)
      throw new Error(
        result?.error || t('stats.activityError', 'Could not read activity statistics.')
      )
    stats.value = result
    statsError.value = ''
  } catch (error) {
    if (!disposed && request === statsRequest)
      statsError.value =
        error.message || t('stats.activityError', 'Could not read activity statistics.')
  }
}
async function loadProvider(id, { refresh = false } = {}) {
  if (!available(id) || !enabled.value[id]) return
  const key = `provider:${id}` // i18n-ignore
  const selectedRange = range.value[id]
  const selectedScope = scope.value[id]
  const dates = usageDateRange(selectedRange, { timezone })
  const query = {
    ...dates,
    timezone,
    ...(selectedScope === 'tessel' ? { roots: [...props.worktreePaths] } : {})
  }
  const signature = JSON.stringify(query)
  const target = reports
  if (!refresh && queryKeys.get(key) === signature && target.value[id]) return
  if (!refresh && loading.value[key] && pendingQueries.get(key) === signature) return
  pendingQueries.set(key, signature)
  if (queryKeys.get(key) !== signature) delete target.value[id]
  const request = (requests.get(key) || 0) + 1
  requests.set(key, request)
  loading.value[key] = true
  errors.value[key] = ''
  try {
    const raw =
      await window.shellApi[REPORTERS[id]](query)
    if (disposed || request !== requests.get(key)) return
    if (!raw?.ok)
      throw new Error(raw?.error || t('stats.providerError', 'Could not read {{id}} usage.', { id }))
    target.value[id] = normalizeUsageReport(id, raw, { timezone, range: dates })
    queryKeys.set(key, signature)
  } catch (error) {
    if (!disposed && request === requests.get(key)) {
      errors.value[key] = error.message || t('stats.localError', 'Could not read local usage.')
      // Data from another filter must never look like the requested scope.
      if (queryKeys.get(key) !== signature) delete target.value[id]
    }
  } finally {
    if (!disposed && request === requests.get(key)) loading.value[key] = false
  }
}
async function refreshOverview() {
  await detectProviders()
  await Promise.all([
    loadStats(),
    ...USAGE_REPORT_PROVIDERS.map((id) => loadProvider(id, { overview: true, refresh: true }))
  ])
}
async function chooseProvider(id) {
  active.value = id
  selectionOpen.value = false
  await nextTick()
  root.value?.scrollIntoView?.({ block: 'start', behavior: 'instant' })
}
async function toggleSelection() {
  selectionOpen.value = !selectionOpen.value
  if (selectionOpen.value) {
    await nextTick()
    root.value?.querySelector('.su-provider-menu [aria-checked="true"]')?.focus()
  }
}
function selectionKey(event) {
  if (!selectionOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    selectionOpen.value = false
    root.value?.querySelector('[data-test="stats-provider-select"]')?.focus()
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    event.stopPropagation()
    const options = Array.from(root.value?.querySelectorAll('.su-provider-menu button') || [])
    const index = options.indexOf(document.activeElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
    options[next]?.focus()
  }
}
async function setEnabled(id, value) {
  if (!available(id)) return
  enabled.value[id] = value
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(enabled.value))
  } catch {
    /* Current view remains usable without storage. */
  }
  if (!value) {
    for (const kind of ['overview', 'provider']) {
      const key = `${kind}:${id}`
      requests.set(key, (requests.get(key) || 0) + 1)
      loading.value[key] = false
      queryKeys.delete(key)
    }
    delete reports.value[id]
    delete overviewReports.value[id]
  } else {
    await Promise.all([
      loadProvider(id, { overview: true }),
      ...(active.value === id ? [loadProvider(id)] : [])
    ])
  }
}
function setFilter(kind, value) {
  if (kind === 'range' && ['7d', '30d', '90d', 'all'].includes(value))
    range.value[active.value] = value
  if (kind === 'scope' && ['all', 'tessel'].includes(value)) scope.value[active.value] = value
  loadProvider(active.value)
}
function accountChanged() {
  for (const [key, request] of requests) requests.set(key, request + 1)
  queryKeys.clear()
  reports.value = {}
  overviewReports.value = {}
  loading.value = {}
  if (active.value === 'overview') refreshOverview()
  else loadProvider(active.value, { refresh: true })
}
function onOutside(event) {
  if (!root.value?.querySelector('.su-provider-control')?.contains(event.target))
    selectionOpen.value = false
}
watch(active, (id) =>
  id === 'overview'
    ? Promise.all(USAGE_REPORT_PROVIDERS.map((provider) => loadProvider(provider, { overview: true })))
    : loadProvider(id)
)
watch(
  () => props.worktreePaths,
  () => {
    for (const id of USAGE_REPORT_PROVIDERS) {
      if (scope.value[id] === 'tessel' && (active.value === 'overview' || active.value === id))
        loadProvider(id)
    }
  },
  { deep: true }
)
onMounted(async () => {
  await detectProviders()
  if (disposed) return
  loadStats()
  if (active.value === 'overview')
    USAGE_REPORT_PROVIDERS.forEach((id) => loadProvider(id, { overview: true }))
  else loadProvider(active.value)
  window.addEventListener('tessel:accounts-changed', accountChanged)
  document.addEventListener('pointerdown', onOutside)
})
onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('tessel:accounts-changed', accountChanged)
  document.removeEventListener('pointerdown', onOutside)
})
</script>

<template>
  <div ref="root" class="stats-usage" data-test="stats-usage">
    <section v-if="summary" class="su-activity">
      <p v-if="summary.totalAgentsSpawned === 0 && summary.totalPRsCreated === 0" class="su-empty">
        {{ t('stats.firstAgent', 'Start your first agent to begin tracking') }}
      </p>
      <template v-else>
        <div class="su-cards su-cards-three">
          <StatsStatCard
            :label="t('stats.agentsSpawned', 'Agents spawned')"
            :value="summary.totalAgentsSpawned?.toLocaleString(intlLocale()) ?? t('stats.na', 'n/a')"
            icon="agent"
          />
          <StatsStatCard
            :label="t('stats.agentTime', 'Time agents worked')"
            :value="duration(summary.totalAgentTimeMs)"
            icon="clock"
          />
          <StatsStatCard
            :label="t('stats.prsCreated', 'PRs created')"
            :value="summary.totalPRsCreated?.toLocaleString(intlLocale()) ?? t('stats.na', 'n/a')"
            icon="pr"
          />
        </div>
        <p
          v-if="summary.firstEventAt"
          class="su-muted"
          v-text="
            t('stats.trackingSince', 'Tracking since {{date}}', {
              date: new Date(summary.firstEventAt).toLocaleDateString(intlLocale(), {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
              })
            })
          "
        ></p>
      </template>
    </section>
    <p v-if="statsError" class="su-error" role="alert">{{ statsError }}</p>
    <p v-if="catalogError" class="su-error" role="alert">
      {{ catalogError }}
      <button type="button" class="su-button" @click="refreshOverview">
        {{ t('stats.retry', 'Retry') }}
      </button>
    </p>
    <UsageVisibility :providers="catalog" />
    <p v-if="PROVIDERS.length === 1 && !catalogError" class="su-muted">
      {{
        t('stats.noCollector', 'No installed agents with a local usage history collector. Subscription quotas are available in the Usage menu.'
        )
      }}
    </p>
    <header class="su-analytics-head">
      <h3>{{ t('stats.analytics', 'Usage Analytics') }}</h3>
      <div class="su-provider-control" @keydown="selectionKey">
        <button
          type="button"
          class="su-button su-provider-select"
          aria-haspopup="menu"
          :aria-expanded="selectionOpen"
          :aria-label="t('stats.providerSelect', 'Usage analytics provider: {{name}}', { name: label })"
          data-test="stats-provider-select"
          @click="toggleSelection"
        >
          <StatsIcon v-if="active === 'overview'" /><BrandIcon
            v-else
            :kind="active"
            :size="14"
            :label="label"
          /><span>{{ label }}</span
          ><ChevronDown :size="14" aria-hidden="true" />
        </button>
        <div
          v-if="selectionOpen"
          class="su-provider-menu"
          role="menu"
          :aria-label="t('stats.providerMenu', 'Usage analytics provider')"
        >
          <button
            v-for="provider in PROVIDERS"
            :key="provider.id"
            type="button"
            role="menuitemradio"
            :aria-checked="active === provider.id"
            :data-test="'stats-provider-' + provider.id"
            @click="chooseProvider(provider.id)"
          >
            <StatsIcon v-if="provider.id === 'overview'" /><BrandIcon
              v-else
              :kind="provider.id"
              :size="14"
              :label="provider.label"
            /><span>{{ provider.label }}</span
            ><Check v-if="active === provider.id" :size="14" aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
    <StatsUsageOverview
      v-if="active === 'overview'"
      :overview="overview"
      :providers="providerRows"
      :loading="overviewBusy"
      @refresh="refreshOverview"
      @enable="setEnabled($event, true)"
      @provider="chooseProvider"
    />
    <StatsUsageProvider
      v-else
      :key="active"
      :provider="active"
      :label="label"
      :model="current"
      :supported="available(active)"
      :enabled="enabled[active] === true"
      :loading="!!loading['provider:' + active]"
      :error="errors['provider:' + active] || ''"
      :range="range[active] || '30d'"
      :scope="scope[active] || 'all'"
      @enable="setEnabled(active, $event)"
      @refresh="loadProvider(active, { refresh: true })"
      @filter="setFilter($event.kind, $event.value)"
    />
    <ResetHistory
      v-if="active === 'overview' || active === 'codex'"
      :provider="active === 'codex' ? 'codex' : undefined"
    />
  </div>
</template>
