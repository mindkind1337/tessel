<script setup>
import ThemedSelect from './ui/ThemedSelect.vue'
// Local quota observations update the toolbar. Authenticated provider reads
// happen on menu/open/refresh actions, and from the main process's automatic
// refresh (usagePoller.js: at startup, every 2 min by default while the window
// is in use, on focus when older than 5 min, and the limits a running chat
// reports), whose readings arrive on providerUsage.onUpdate and
// colour the icon without a click. Redeeming an actual reset credit
// additionally requires confirmation.
// Roster and provider flyout patterns inspired by Orca UsageRosterPanel,
// ProviderPanel and CodexSwitcherMenu (MIT, Lovecast, 2026); independent Vue UI.
// Amber from 60 %, red from 80 % (the reference's thresholds); an old reading says so.
import { RefreshCw } from 'lucide-vue-next'
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import BrandIcon from './BrandIcon.vue'
import UsageVisibility from './UsageVisibility.vue'
import { settings } from '../settings'
import { displayedUsagePercent, usagePercentLabel } from '../usagePercent'
import { loadUsageProviders } from '../usageProviders'
import { t, intlLocale } from '../i18n'

const emit = defineEmits(['details', 'accounts'])
const NAMES = {
  claude: 'Claude Code', // i18n-ignore
  codex: 'Codex',
  kimi: 'Kimi',
  gemini: 'Gemini',
  copilot: 'Copilot',
  opencode: 'OpenCode',
  qwen: 'Qwen',
  cline: 'Cline',
  ollama: 'Ollama'
}
const open = ref(false)
const usage = ref(null) // { agents: [...] } | { error }
const root = ref(null)
const trigger = ref(null)
const mode = ref('compact')
const selectedProvider = ref(null)
const accountChooser = ref(false)
const flyoutPosition = ref({})
const stacked = ref(false)
const providerReadings = ref({})
// provider -> { accountId, plan }: the plan its last read found (Claude: from its login).
const providerPlans = ref({})
const providerErrors = ref({})
const providerBusy = ref({})
const resetConfirm = ref(null)
const resetBusy = ref(false)
const resetNotice = ref('')
const historyRevision = ref(0)
const installed = ref([])
const unavailable = ref([])
const trackedProviders = computed(() =>
  installed.value.filter(
    (p) =>
      p.quota && !settings.hiddenUsageProviders.includes(p.id) && !unavailable.value.includes(p.id)
  )
)
const rosterError = ref('')
const loading = ref(false)
const now = ref(Date.now())
const menuPosition = ref({})
const accounts = ref([])
const accountsError = ref('')
const accountBusy = ref({})
const accountNotice = ref('')
const accountsReadFailed = ref(false)
const hasAccounts = computed(() => !!window.shellApi.accounts?.list)
const refreshing = computed(() => loading.value || Object.values(providerBusy.value).some(Boolean))
let timer = null
let stopPush = null
let alive = true
let accountsRequest = 0
let usageRequest = 0
let agentsRequest = 0
const providerRequests = new Map()

async function load() {
  if (!window.shellApi.getUsage) {
    usage.value = {
      error: t('usage.menu.readerUnavailable', 'The local usage reader is not available.')
    }
    return
  }
  const request = ++usageRequest
  loading.value = true
  now.value = Date.now()
  try {
    const result = await window.shellApi.getUsage()
    if (alive && request === usageRequest) usage.value = result
  } catch (err) {
    if (alive && request === usageRequest) usage.value = { error: err && err.message }
  } finally {
    if (alive && request === usageRequest) loading.value = false
  }
}
async function loadAgents() {
  const request = ++agentsRequest
  try {
    const result = await loadUsageProviders()
    if (!alive || request !== agentsRequest) return
    if (!Array.isArray(result)) throw new Error('Could not read installed agents.')
    installed.value = result
    unavailable.value = []
    rosterError.value = ''
  } catch {
    if (alive && request === agentsRequest)
      rosterError.value = t('usage.menu.rosterError', 'Could not refresh the installed agent list.'
      )
  }
}
async function loadAccounts() {
  if (!window.shellApi.accounts?.list) return
  const request = ++accountsRequest
  try {
    const result = await window.shellApi.accounts.list()
    if (!alive || request !== accountsRequest) return
    if (!result?.ok)
      throw new Error(result?.error || t('usage.menu.accountsError', 'Could not read accounts.'))
    accounts.value = (result.providers || []).map((provider) => {
      const old = accounts.value.find((entry) => entry.provider === provider.provider)
      const next = provider.error && old ? { ...old, error: provider.error } : provider
      if ((old?.selectedId || null) !== (next.selectedId || null))
        invalidateProvider(provider.provider)
      return next
    })
    accountsError.value = ''
    accountsReadFailed.value = false
  } catch (err) {
    if (alive && request === accountsRequest) {
      accountsError.value =
        err.message || t('usage.menu.accountsError', 'Could not read accounts.')
      accountsReadFailed.value = true
    }
  }
}
function providerAccounts(id) {
  return accounts.value.find((provider) => provider.provider === id)
}
function selectedAccount(id) {
  return providerAccounts(id)?.selectedId || null
}
function invalidateProvider(id) {
  providerRequests.set(id, (providerRequests.get(id) || 0) + 1)
  delete providerReadings.value[id]
  delete providerErrors.value[id]
  providerBusy.value[id] = false
  resetConfirm.value = null
}
// When each provider was last read (as the reference's MIN_REFETCH_MS: opening
// the menu reads again only after 5 minutes; the refresh button always does).
const MIN_REFETCH_MS = 5 * 60 * 1000
const providerReadAt = new Map()
async function readProvider(id) {
  if (!trackedProviders.value.some((p) => p.id === id) || !window.shellApi.providerUsage?.read)
    return
  providerReadAt.set(id, Date.now())
  if (accountsReadFailed.value || providerAccounts(id)?.error || accountBusy.value[id]) return
  const accountId = selectedAccount(id)
  const request = (providerRequests.get(id) || 0) + 1
  providerRequests.set(id, request)
  providerBusy.value[id] = true
  providerErrors.value[id] = ''
  resetConfirm.value = null
  if (!['claude', 'codex'].includes(id)) delete providerReadings.value[id]
  try {
    const result = await window.shellApi.providerUsage.read({ provider: id, accountId })
    if (!alive || request !== providerRequests.get(id) || accountId !== selectedAccount(id)) return
    // Its plan (from its login) even when its usage could not be read.
    if (typeof result?.plan === 'string') providerPlans.value[id] = { accountId, plan: result.plan }
    if (!result?.ok) {
      if (result?.code === 'unavailable')
        unavailable.value = [...new Set([...unavailable.value, id])]
      throw new Error(
        result?.error || t('usage.menu.providerError', 'Could not refresh provider usage.')
      )
    }
    if (result.provider !== id || result.accountId !== accountId)
      throw new Error(
        t('usage.menu.accountChanged', 'The usage account changed. Refresh before continuing.')
      )
    applyReading(id, result)
  } catch (err) {
    if (alive && request === providerRequests.get(id)) {
      providerErrors.value[id] =
        err.message || t('usage.menu.providerError', 'Could not refresh provider usage.')
      const previous = [
        providerReadings.value[id],
        agents.value.find((agent) => agent.id === id)
      ].find((reading) => reading && reading.accountId === accountId)
      if (previous)
        providerReadings.value[id] = {
          ...previous,
          accountId,
          stale: true,
          resetToken: null,
          windows: windows(previous).map((window) => ({ ...window, stale: true }))
        }
      else delete providerReadings.value[id]
    }
  } finally {
    if (alive && request === providerRequests.get(id)) providerBusy.value[id] = false
  }
}
function applyReading(id, result) {
  providerReadings.value[id] = {
    ...result,
    id,
    source: 'provider',
    stale: false,
    error: null,
    resetToken: result.resetToken || null,
    resetCredits: result.resetCredits || null,
    resetCreditsError: result.resetCreditsError || null
  }
  now.value = Date.now()
}
// A reading pushed by the automatic refresh, for the selected account only.
// A read in progress here wins: its own result follows.
let accountsLoaded = false
async function pushed(result) {
  const id = result?.provider
  if (!alive || typeof id !== 'string') return
  // Pushed readings are for the selected account only: know it first.
  if (['claude', 'codex'].includes(id) && hasAccounts.value && !accountsLoaded && !accounts.value.length) {
    accountsLoaded = true
    await loadAccounts()
    if (!alive) return
  }
  if (!trackedProviders.value.some((p) => p.id === id)) return
  const accountId = result.accountId ?? null
  if (providerBusy.value[id] || accountBusy.value[id] || accountId !== selectedAccount(id)) return
  if (accountsReadFailed.value || providerAccounts(id)?.error) return
  providerRequests.set(id, (providerRequests.get(id) || 0) + 1)
  if (typeof result.plan === 'string') providerPlans.value[id] = { accountId, plan: result.plan }
  if (result.ok && result.kept) {
    // A recent reading kept through a failed refresh: shown as last known.
    providerErrors.value[id] = typeof result.error === 'string' ? result.error : ''
    providerReadings.value[id] = {
      ...result,
      id,
      source: 'provider',
      stale: true,
      resetToken: null
    }
    now.value = Date.now()
    return
  }
  if (result.ok) {
    providerErrors.value[id] = ''
    applyReading(id, result)
    return
  }
  if (result.code === 'unavailable') unavailable.value = [...new Set([...unavailable.value, id])]
  providerErrors.value[id] =
    (typeof result.error === 'string' && result.error) ||
    t('usage.menu.providerError', 'Could not refresh provider usage.')
  const previous = providerReadings.value[id]
  if (previous && previous.accountId === accountId)
    providerReadings.value[id] = {
      ...previous,
      stale: true,
      resetToken: null,
      windows: windows(previous).map((window) => ({ ...window, stale: true }))
    }
}
async function selectAccount(provider, event) {
  const selection = event.target.value || null
  // Keep the confirmed value visible until the main process has saved it.
  event.target.value = provider.selectedId || ''
  if (resetBusy.value || accountBusy.value[provider.provider] || selection === provider.selectedId)
    return
  invalidateProvider(provider.provider)
  accountBusy.value[provider.provider] = true
  accountsError.value = ''
  accountNotice.value = ''
  try {
    const result = await window.shellApi.accounts.select(provider.provider, selection)
    if (!result?.ok)
      throw new Error(result?.error || t('usage.menu.switchError', 'Could not switch accounts.'))
    if (!alive) return
    accountNotice.value =
      provider.provider === 'claude'
        ? t('usage.menu.claudeSwitched', 'Restart your Claude terminals when ready to use this sign-in.'
          )
        : t('usage.menu.codexSwitched', 'New Codex terminals will use this account.')
    if (result.warning) accountNotice.value += ` ${result.warning}`
    await Promise.all([loadAccounts(), load()])
    accountBusy.value[provider.provider] = false
    if (alive && open.value) await readProvider(provider.provider)
    if (alive)
      window.dispatchEvent(
        new CustomEvent('tessel:accounts-changed', {
          detail: { provider: provider.provider, source: 'usage-menu' }
        })
      )
  } catch (err) {
    if (alive)
      accountsError.value =
        err.message || t('usage.menu.switchError', 'Could not switch accounts.')
  } finally {
    if (alive) accountBusy.value[provider.provider] = false
  }
}
function accountsChanged(event) {
  if (event.detail?.source === 'usage-menu') return
  for (const id of ['claude', 'codex']) invalidateProvider(id)
  load()
  if (open.value) loadAccounts()
}
const agents = computed(() => {
  const rows = new Map()
  for (const agent of Array.isArray(usage.value?.agents) ? usage.value.agents : []) {
    if (agent && typeof agent.id === 'string') {
      const selected = selectedAccount(agent.id)
      const matches =
        agent.accountId === selected || (selected === null && agent.accountId === undefined)
      rows.set(
        agent.id,
        matches
          ? { ...agent }
          : {
              id: agent.id,
              name: agent.name,
              accountId: selected,
              windows: [],
              source: 'unavailable',
              error: t('usage.menu.notReadForAccount', 'Usage has not been read for this account.')
            }
      )
    }
  }
  for (const agent of trackedProviders.value) {
    if (rows.has(agent.id)) rows.get(agent.id).name ||= agent.name
    else
      rows.set(agent.id, {
        id: agent.id,
        name: agent.name,
        windows: [],
        source: 'unavailable',
        error:
          providerErrors.value[agent.id] ||
          t('usage.menu.openToReadProvider', 'Open to read provider usage.')
      })
  }
  for (const reading of Object.values(providerReadings.value)) {
    if (reading.accountId === selectedAccount(reading.id))
      rows.set(reading.id, { ...rows.get(reading.id), ...reading })
  }
  return [...rows.values()].filter((row) => trackedProviders.value.some((p) => p.id === row.id))
})
function agentName(agent) {
  return agent.name || NAMES[agent.id] || agent.id
}
function windows(agent) {
  return (Array.isArray(agent.windows) ? agent.windows : []).filter(
    (window) =>
      typeof window?.usedPct === 'number' &&
      Number.isFinite(window.usedPct) &&
      window.usedPct >= 0 &&
      window.usedPct <= 100
  )
}
function timestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.parse(value)
}
// window: null when a provider sends no reading for it (never a crash).
function stale(agent, window) {
  if (!window) return false
  const reset = timestamp(window.resetsAt)
  return (
    window.stale === true ||
    (window.stale === undefined && agent.stale === true) ||
    (Number.isFinite(reset) && reset <= now.value)
  )
}
function summaryWindow(agent) {
  const valid = windows(agent)
  const fresh = valid.filter((window) => !stale(agent, window))
  return (fresh.length ? fresh : valid).reduce(
    (best, window) => (!best || window.usedPct > best.usedPct ? window : best),
    null
  )
}
function planLabel(agent) {
  const provider = providerAccounts(agent.id)
  const matching =
    !provider || agent.accountId === undefined || agent.accountId === provider.selectedId
  const selected = provider?.selectedId
    ? provider.accounts?.find((account) => account.id === provider.selectedId)
    : provider?.system
  const known = providerPlans.value[agent.id]
  const plan =
    agent.plan ||
    agent.planType ||
    (known && known.accountId === (agent.accountId ?? selectedAccount(agent.id)) ? known.plan : null) ||
    (matching ? selected?.plan : null)
  return typeof plan === 'string'
    ? plan
        .trim()
        .slice(0, 40)
        .replace(/[_-]+/g, ' ')
        .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    : ''
}
function unavailableText(agent) {
  if (agent.unlimited)
    return t('usage.menu.unlimitedPlan', 'Unlimited plan — no quota ceiling reported.')
  if (agent.error) return agent.error
  return t('usage.menu.openToRead', 'Open to read usage for this account.')
}
function expandedFor(id) {
  return selectedProvider.value === id
}
function changeMode(value) {
  mode.value = value
  closeProvider()
}
function toggleProvider(id) {
  if (resetBusy.value) return
  if (selectedProvider.value === id) return closeProvider()
  selectedProvider.value = id
  accountChooser.value = false
  resetNotice.value = ''
  positionMenu()
  readProvider(id)
}
function closeProvider() {
  if (resetBusy.value) return
  selectedProvider.value = null
  accountChooser.value = false
  resetConfirm.value = null
  positionMenu()
}
const detailAgent = computed(() =>
  agents.value.find((agent) => agent.id === selectedProvider.value)
)
const credits = computed(() => {
  const value = detailAgent.value?.resetCredits
  return Number.isInteger(value?.availableCount) && value.availableCount >= 0 ? value : null
})
const canReset = computed(() => {
  const agent = detailAgent.value
  const observed = timestamp(agent?.observedAt)
  return (
    agent?.id === 'codex' &&
    agent.source === 'provider' &&
    agent.accountId === selectedAccount(agent.id) &&
    !agent.stale &&
    !agent.error &&
    !agent.resetCreditsError &&
    Number.isFinite(observed) &&
    now.value - observed < 5 * 60000 &&
    credits.value?.availableCount > 0 &&
    credits.value.eligible === true &&
    typeof agent.resetToken === 'string' &&
    !!agent.resetToken &&
    !providerErrors.value[agent.id] &&
    !providerBusy.value[agent.id] &&
    !accountBusy.value[agent.id] &&
    !accountsReadFailed.value &&
    !providerAccounts(agent.id)?.error &&
    !!window.shellApi.providerUsage?.redeemReset
  )
})
function beginReset() {
  if (!canReset.value || resetBusy.value) return
  resetNotice.value = ''
  resetConfirm.value = {
    provider: 'codex',
    accountId: selectedAccount('codex'),
    resetToken: detailAgent.value.resetToken,
    label: accountLabel('codex')
  }
}
async function confirmReset() {
  const request = resetConfirm.value
  if (resetBusy.value || !request) return
  if (
    !canReset.value ||
    request.accountId !== selectedAccount('codex') ||
    request.resetToken !== detailAgent.value?.resetToken
  ) {
    resetConfirm.value = null
    resetNotice.value = t('usage.menu.resetStale', 'The usage account or reading changed. Refresh before resetting.'
    )
    return
  }
  resetBusy.value = true
  resetNotice.value = ''
  try {
    const result = await window.shellApi.providerUsage.redeemReset({
      provider: 'codex',
      accountId: request.accountId,
      resetToken: request.resetToken,
      confirmed: true
    })
    if (!alive) return
    // A reset token is never retried, including ambiguous network failures.
    if (providerReadings.value.codex) delete providerReadings.value.codex.resetToken
    resetConfirm.value = null
    if (!result?.ok) {
      resetNotice.value = result?.uncertain
        ? t('usage.menu.resetUncertain', 'The reset result is uncertain. Refresh usage to check before trying again.'
          )
        : result?.error ||
          t('usage.menu.resetFailed', 'The reset could not be completed. Refresh before trying again.'
          )
      if (result?.historyError) resetNotice.value += ` ${result.historyError}`
      return
    }
    resetNotice.value =
      {
        reset: () => t('usage.menu.outcome.reset', 'Usage limits reset.'),
        nothingToReset: () =>
          t('usage.menu.outcome.nothingToReset', 'There are no eligible limits to reset.'),
        noCredit: () => t('usage.menu.outcome.noCredit', 'No reset credit is available.'),
        alreadyRedeemed: () =>
          t('usage.menu.outcome.alreadyRedeemed', 'This reset was already redeemed.')
      }[result.outcome]?.() || t('usage.menu.outcome.done', 'Reset request completed.')
    if (result.historyError) resetNotice.value += ` ${result.historyError}`
    await Promise.all([readProvider('codex'), load()])
  } catch {
    if (alive) {
      if (providerReadings.value.codex) delete providerReadings.value.codex.resetToken
      resetConfirm.value = null
      resetNotice.value = t('usage.menu.resetUncertain', 'The reset result is uncertain. Refresh usage to check before trying again.'
      )
    }
  } finally {
    if (alive) {
      resetBusy.value = false
      historyRevision.value++
    }
  }
}
function expiryText(iso) {
  if (!Number.isFinite(timestamp(iso))) return ''
  if (timestamp(iso) <= now.value) return t('usage.menu.expired', 'Expired')
  return t('usage.menu.expiresIn', 'Expires in {{time}}', { time: shortReset(iso) })
}
function accountLabel(id) {
  const provider = providerAccounts(id)
  return provider?.selectedId
    ? provider.accounts?.find((account) => account.id === provider.selectedId)?.label ||
        t('usage.menu.savedAccount', 'Saved account')
    : provider?.system?.label || t('usage.menu.systemDefault', 'System default')
}
function updatedText(agent) {
  const observed = timestamp(agent?.updatedAt || agent?.observedAt)
  if (!Number.isFinite(observed)) return t('usage.menu.notUpdated', 'Not yet updated')
  const seconds = Math.max(0, Math.floor((now.value - observed) / 1000))
  if (seconds < 60) return t('usage.menu.updatedNow', 'Updated just now')
  if (seconds < 3600)
    return t('usage.menu.updatedMin', 'Updated {{count}} min ago', {
      count: Math.floor(seconds / 60)
    })
  if (seconds < 86400)
    return t('usage.menu.updatedHours', 'Updated {{count}} h ago', {
      count: Math.floor(seconds / 3600)
    })
  return t('usage.menu.updatedDays', 'Updated {{count}} d ago', {
    count: Math.floor(seconds / 86400)
  })
}
function shortReset(iso) {
  const milliseconds = timestamp(iso) - now.value
  if (!Number.isFinite(milliseconds)) return ''
  if (milliseconds <= 0) return t('usage.menu.resetPassed', 'Reset passed')
  const minutes = Math.ceil(milliseconds / 60000)
  if (minutes < 60) return t('usage.time.minutes', '{{m}}m', { m: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('usage.time.hoursMinutes', '{{h}}h {{m}}m', { h: hours, m: minutes % 60 })
  return t('usage.time.daysHours', '{{d}}d {{h}}h', { d: Math.floor(hours / 24), h: hours % 24 })
}
// A kept reading (the automatic refresh failed, the reading is recent) still
// counts for the icon until its window resets.
function counts(agent, window) {
  if (!window) return false
  if (!stale(agent, window)) return true
  const reset = timestamp(window.resetsAt)
  return agent.kept === true && window.stale !== true && !(Number.isFinite(reset) && reset <= now.value)
}
// The highest fresh window, for the icon's colour.
const worst = computed(() => {
  let max = -1
  for (const a of agents.value)
    for (const w of windows(a)) if (counts(a, w) && w.usedPct > max) max = w.usedPct
  return max
})
const level = (pct) => (pct >= 80 ? 'bad' : pct >= 60 ? 'warn' : 'ok')

function resetText(iso) {
  if (!iso) return ''
  const ms = timestamp(iso) - now.value
  if (!Number.isFinite(ms)) return ''
  if (!(ms > 0)) return t('usage.menu.resetTimePassed', 'reset time passed')
  const min = Math.round(ms / 60000)
  if (min < 60) return t('usage.menu.resetsInMin', 'resets in {{m}} min', { m: min })
  if (min < 48 * 60)
    return t('usage.menu.resetsInHours', 'resets in {{h}} h {{m}} min', {
      h: Math.floor(min / 60),
      m: min % 60
    })
  return t('usage.menu.resetsOn', 'resets {{date}}', {
    date: new Date(iso).toLocaleDateString(intlLocale(), {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit'
    })
  })
}
// The main process names windows in English (providerUsage.js,
// usageProviderMapping.js): shown in the interface's language. The cases
// below are those names, not text shown as is.
function windowLabel(l) {
  switch (l) {
    case '5h':
    case '5-hour':
      return t('usage.window.fiveHour', '5-hour')
    case 'week':
    case 'Weekly':
      return t('usage.window.weekly', 'Weekly')
    case 'Primary window': // i18n-ignore
      return t('usage.window.primary', 'Primary window')
    case 'Secondary window': // i18n-ignore
      return t('usage.window.secondary', 'Secondary window')
  }
  const minutes = /^(\d+) min$/.exec(String(l || ''))
  if (minutes) return t('usage.window.minutes', '{{count}} min', { count: Number(minutes[1]) })
  // A model's weekly limit ("Opus weekly", "Sonnet weekly", …), named by the provider.
  const model = /^(.{1,40}) weekly$/.exec(String(l || '')) // i18n-ignore
  return model ? t('usage.window.modelWeekly', '{{model}} weekly', { model: model[1] }) : l
}
// Anthropic's own words for a locked window, shown as is (bounded).
function lockedText(w) {
  return typeof w?.lockedReason === 'string' && w.lockedReason.trim()
    ? w.lockedReason.trim().slice(0, 200)
    : ''
}
// Claude: this week's usage by category (seven_day_breakdown).
const breakdown = computed(() => {
  const value = detailAgent.value?.breakdown
  const rows = (Array.isArray(value?.rows) ? value.rows : [])
    .filter(
      (row) =>
        typeof row?.label === 'string' &&
        row.label.trim() &&
        typeof row.pct === 'number' &&
        Number.isFinite(row.pct)
    )
    .slice(0, 20)
    .map((row) => ({
      label: row.label.trim().slice(0, 60),
      pct: Math.min(100, Math.max(0, row.pct))
    }))
  return rows.length ? { asOf: timestamp(value.asOf), rows } : null
})
function asOfText(value) {
  return t('usage.menu.asOf', 'as of {{time}}', {
    time: new Date(value).toLocaleString(intlLocale(), {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit'
    })
  })
}
// Claude: paid extra usage, only when it is on. Amounts in minor units.
const extraUsage = computed(() => {
  const value = detailAgent.value?.extraUsage
  const amount = (n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null)
  if (!value || amount(value.used) === null) return null
  const decimals = Number.isInteger(value.decimals) && value.decimals >= 0 && value.decimals <= 4 ? value.decimals : 2
  const pct = amount(value.pct)
  return {
    currency: typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) ? value.currency : null,
    decimals,
    used: value.used,
    limit: amount(value.limit),
    pct: pct === null ? null : Math.min(100, pct),
    limitReached: value.limitReached === true
  }
})
function money(minor, extra) {
  const options = {
    minimumFractionDigits: extra.decimals,
    maximumFractionDigits: extra.decimals
  }
  const value = minor / 10 ** extra.decimals
  try {
    return new Intl.NumberFormat(
      intlLocale(),
      extra.currency ? { ...options, style: 'currency', currency: extra.currency } : options
    ).format(value)
  } catch {
    return value.toFixed(extra.decimals)
  }
}
function extraUsageText(extra) {
  return extra.limit !== null
    ? t('usage.menu.extraUsageOf', '{{used}} of {{limit}} this month', {
        used: money(extra.used, extra),
        limit: money(extra.limit, extra)
      })
    : t('usage.menu.extraUsageUsed', '{{used}} used this month', { used: money(extra.used, extra) })
}
// "5-hour quota used", or "left" when Settings shows what remains.
function quotaText(label) {
  const name = windowLabel(label)
  return settings.usagePercentageDisplay === 'remaining'
    ? t('usage.menu.quotaLeft', '{{window}} quota left', { window: name })
    : t('usage.menu.quotaUsed', '{{window}} quota used', { window: name })
}
function summaryTitle(agent) {
  const window = summaryWindow(agent)
  if (!window) return ''
  const quota = quotaText(window.label)
  return stale(agent, window)
    ? t('usage.menu.quotaLastKnown', '{{quota}} - last known reading', { quota })
    : quota
}
function observedText(value) {
  return t('usage.menu.observed', 'Observed {{time}}', {
    time: new Date(value).toLocaleString(intlLocale(), {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  })
}
function creditsText(count) {
  return t(
    'usage.menu.resetsAvailable',
    count === 1 ? '{{count}} rate-limit reset available' : '{{count}} rate-limit resets available',
    { count }
  )
}
// The account name sits in bold inside the sentence, wherever the language puts it.
const resetExplanation = computed(() =>
  t('usage.menu.resetExplain', 'This uses one reset credit for {{account}} and immediately resets eligible usage windows.'
  ).split('{{account}}')
)

function onDocDown(e) {
  const selectOwner = e.target?.closest?.('[data-select-owner]')?.dataset.selectOwner
  if (selectOwner && root.value?.contains(document.getElementById(selectOwner))) return
  if (resetBusy.value) return
  if (open.value && root.value && !root.value.contains(e.target)) closeMenu()
}
function positionMenu() {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  const width = Math.min(360, Math.max(0, window.innerWidth - 16))
  stacked.value = window.innerWidth < 684
  const totalWidth = selectedProvider.value && !stacked.value ? width + 308 : width
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - totalWidth - 8))
  const top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 180))
  menuPosition.value = {
    position: 'fixed',
    width: `${width}px`,
    left: `${left}px`,
    right: 'auto',
    top: `${top}px`,
    maxHeight: `${Math.max(0, window.innerHeight - top - 8)}px`
  }
  flyoutPosition.value = {
    ...menuPosition.value,
    width: `${stacked.value ? width : 300}px`,
    left: `${stacked.value ? left : left + width + 8}px`
  }
}
function onKey(event) {
  if (!open.value || event.key !== 'Escape') return
  event.stopPropagation()
  if (resetBusy.value) return
  if (resetConfirm.value) {
    resetConfirm.value = null
    return
  }
  if (accountChooser.value) {
    accountChooser.value = false
    return
  }
  if (selectedProvider.value) {
    const id = selectedProvider.value
    closeProvider()
    Array.from(root.value?.querySelectorAll('[data-test]') || [])
      .find((node) => node.dataset.test === `usage-row-${id}`) // i18n-ignore
      ?.focus()
    return
  }
  closeMenu()
  trigger.value?.focus()
}
function closeMenu() {
  if (resetBusy.value) return
  open.value = false
  closeProvider()
}
// force: the refresh button (always reads); opening the menu reads only the
// providers not read in the last 5 minutes, so opening it often never floods
// the usage services (they answer "too many requests" and block).
async function refresh(force = true) {
  if (resetBusy.value) return
  await Promise.all([load(), loadAccounts(), loadAgents()])
  if (!alive || !open.value) return
  const now = Date.now()
  const due = trackedProviders.value.filter((p) => force === true || now - (providerReadAt.get(p.id) || 0) >= MIN_REFETCH_MS)
  await Promise.all(due.map((p) => readProvider(p.id)))
}
function visibilityChanged({ id, show }) {
  if (!show && selectedProvider.value === id) closeProvider()
  if (show && open.value) readProvider(id)
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocDown, true)
  window.addEventListener('tessel:accounts-changed', accountsChanged)
  window.addEventListener('resize', positionMenu)
  document.addEventListener('keydown', onKey, true)
  load()
  timer = setInterval(load, 60000)
  loadAgents()
  stopPush = window.shellApi.providerUsage?.onUpdate?.(pushed) || null
  configureAutoRefresh()
})
// Settings > Usage refresh, and the providers hidden from this menu.
function configureAutoRefresh() {
  const minutes = settings.usageRefreshMinutes
  window.shellApi.providerUsage
    ?.autoRefresh?.({
      hidden: [...settings.hiddenUsageProviders],
      intervalMs: minutes > 0 ? minutes * 60000 : 0
    })
    ?.catch?.(() => {})
}
watch(
  () => [settings.usageRefreshMinutes, settings.hiddenUsageProviders.join(',')],
  configureAutoRefresh
)
onBeforeUnmount(() => {
  alive = false
  document.removeEventListener('pointerdown', onDocDown, true)
  window.removeEventListener('tessel:accounts-changed', accountsChanged)
  window.removeEventListener('resize', positionMenu)
  document.removeEventListener('keydown', onKey, true)
  clearInterval(timer)
  stopPush?.()
})
function toggle() {
  if (resetBusy.value) return
  if (open.value) return closeMenu()
  open.value = !open.value
  if (open.value) {
    positionMenu()
    refresh(false)
  }
}

// Settings > Appearance, "Usage percentages": used or remaining.
const shownPct = (used) => displayedUsagePercent(used, settings.usagePercentageDisplay)
const pctLabel = (used) => usagePercentLabel(used, settings.usagePercentageDisplay)
const emptyTitle = () => t('usage.menu.buttonTitleEmpty', "Usage of your agents' quotas")
</script>

<template>
  <div ref="root" class="notif-wrap">
    <button
      ref="trigger"
      class="tb-icon"
      :class="[{ on: open }, worst >= 0 ? 'usage-' + level(worst) : '']"
      :title="
        worst >= 0
          ? t('usage.menu.buttonTitle', 'Usage: up to {{pct}}% of a quota used', {
              pct: Math.round(worst)
            })
          : emptyTitle()
      "
      :aria-label="t('usage.menu.title', 'Usage')"
      :aria-expanded="open"
      data-test="usage-button"
      @click="toggle"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2.5 11.5a5.5 5.5 0 1111 0"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
        />
        <path d="M8 11.5l2.6-3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
    </button>
    <div
      v-if="open"
      v-show="!(selectedProvider && stacked)"
      class="notif-menu usage-menu usage-roster"
      :class="{ compact: mode === 'compact' }"
      :style="menuPosition"
      role="dialog"
      :aria-label="t('usage.menu.title', 'Usage')"
      :aria-busy="refreshing"
    >
      <header class="usage-roster-head">
        <strong>{{ t('usage.menu.title', 'Usage') }}</strong
        ><span>{{ t('usage.menu.allAgents', 'all agents') }}</span
        ><button
          type="button"
          class="usage-refresh"
          :aria-label="t('usage.menu.refresh', 'Refresh usage')"
          :title="t('usage.menu.refresh', 'Refresh usage')"
          :disabled="refreshing || resetBusy"
          data-test="usage-refresh"
          @click="refresh(true)"
        >
          <RefreshCw :size="13" :class="{ spinning: refreshing }" aria-hidden="true" />
        </button>
      </header>
      <div class="usage-density" role="group" :aria-label="t('usage.menu.display', 'Usage display')">
        <button
          type="button"
          :aria-pressed="mode === 'detailed'"
          data-test="usage-mode-detailed"
          @click="changeMode('detailed')"
        >
          {{ t('usage.menu.detailed', 'Detailed') }}</button
        ><button
          type="button"
          :aria-pressed="mode === 'compact'"
          data-test="usage-mode-compact"
          @click="changeMode('compact')"
        >
          {{ t('usage.menu.compact', 'Compact') }}
        </button>
      </div>
      <div class="usage-roster-body">
        <UsageVisibility :providers="installed" @change="visibilityChanged" />
        <p
          v-if="usage && usage.error"
          class="usage-account-error"
          role="alert"
          v-text="t('usage.menu.readError', 'Could not read usage: {{error}}', { error: usage.error })"
        ></p>
        <p v-else-if="!agents.length" class="notif-empty">
          {{
            loading
              ? t('usage.menu.reading', 'Reading usage...')
              : t('usage.menu.empty', 'No configured usage providers to show. Install a supported agent, sign in, then refresh.'
                )
          }}
        </p>
        <p v-if="rosterError" class="usage-account-notice" role="status">{{ rosterError }}</p>
        <p v-if="accountsError" class="usage-account-error" role="alert">
          {{ accountsError }}
          <button
            v-if="accountsReadFailed"
            type="button"
            class="usage-text-button"
            data-test="usage-accounts-retry"
            @click="loadAccounts"
          >
            {{ t('usage.menu.retry', 'Retry') }}
          </button>
        </p>
        <p v-if="accountNotice" class="usage-account-notice" role="status">{{ accountNotice }}</p>
        <section v-for="a in agents" :key="a.id" class="usage-agent" data-test="usage-agent">
          <button
            type="button"
            class="usage-roster-row"
            :data-test="'usage-row-' + a.id"
            :aria-expanded="expandedFor(a.id)"
            :aria-controls="expandedFor(a.id) ? 'usage-provider-flyout' : undefined"
            @click="toggleProvider(a.id)"
          >
            <span class="usage-brand"
              ><BrandIcon
                :kind="a.id === 'opencode-go' ? 'opencode' : a.id"
                :size="16"
                :label="agentName(a)"
            /></span>
            <span class="usage-roster-name"
              >{{ agentName(a)
              }}<span v-if="planLabel(a)" class="usage-plan">
                &middot; {{ planLabel(a) }}</span
              ></span
            >
            <span
              v-if="mode === 'compact' && summaryWindow(a)"
              class="usage-summary"
              :class="{ stale: stale(a, summaryWindow(a)) }"
              :title="summaryTitle(a)"
            >
              <span v-if="stale(a, summaryWindow(a))" class="usage-old">{{
                t('usage.menu.lastSeen', 'last seen')
              }}</span>
              <span v-else-if="shortReset(summaryWindow(a).resetsAt)" class="usage-countdown">{{
                shortReset(summaryWindow(a).resetsAt)
              }}</span>
              <span
                class="usage-summary-pct"
                :class="'usage-level-' + level(summaryWindow(a).usedPct)"
                >{{ shownPct(summaryWindow(a).usedPct) }}%</span
              >
            </span>
            <span v-else-if="!windows(a).length" class="usage-no-data">{{
              providerBusy[a.id]
                ? t('usage.menu.loading', 'Loading usage…')
                : a.unlimited
                  ? t('usage.menu.unlimited', 'Unlimited')
                  : providerErrors[a.id]
                    ? t('usage.menu.refreshNeeded', 'Refresh needed')
                    : t('usage.menu.openForUsage', 'Open for usage')
            }}</span>
            <svg
              class="usage-chevron"
              :class="{ expanded: expandedFor(a.id) }"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="m4.5 2.5 3.5 3.5-3.5 3.5"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <div v-if="mode === 'detailed'" class="usage-provider-detail">
            <p v-if="!windows(a).length" class="usage-none">{{ unavailableText(a) }}</p>
            <div
              v-for="w in windows(a)"
              :key="w.label"
              class="usage-window"
              :class="{ stale: stale(a, w) }"
            >
              <div class="usage-line">
                <span>{{ windowLabel(w.label) }}</span
                ><span class="usage-pct" :class="'usage-level-' + level(w.usedPct)"
                  >{{ shownPct(w.usedPct) }}%</span
                >
              </div>
              <div class="usage-bar">
                <div
                  class="usage-fill"
                  :class="level(w.usedPct)"
                  :style="{ width: shownPct(w.usedPct) + '%' }"
                ></div>
              </div>
              <div class="usage-reset">
                {{ resetText(w.resetsAt)
                }}<span v-if="stale(a, w)">
                  &middot; {{ t('usage.menu.lastKnownReadingLower', 'last known reading') }}</span
                >
              </div>
            </div>
            <p v-if="a.observedAt && windows(a).length" class="usage-observed">
              {{ observedText(a.observedAt) }}
            </p>
          </div>
        </section>
      </div>
      <footer class="usage-roster-foot">
        <button type="button" data-test="usage-details" @click="(closeMenu(), emit('details'))">
          <span>{{ t('usage.menu.details', 'Usage details & history') }}</span
          ><span aria-hidden="true">&rsaquo;</span></button
        ><button
          v-if="hasAccounts"
          type="button"
          data-test="usage-manage-accounts"
          @click="(closeMenu(), emit('accounts'))"
        >
          <span>{{ t('usage.menu.manageAccounts', 'Manage accounts') }}</span
          ><span aria-hidden="true">&rsaquo;</span>
        </button>
      </footer>
    </div>
    <section
      v-if="open && detailAgent"
      id="usage-provider-flyout"
      class="notif-menu usage-roster usage-flyout"
      :class="{ stacked }"
      :style="flyoutPosition"
      role="dialog"
      :aria-label="t('usage.menu.agentUsage', '{{name}} usage', { name: agentName(detailAgent) })"
      :aria-busy="providerBusy[detailAgent.id] || resetBusy"
      data-test="usage-provider-flyout"
    >
      <header class="usage-flyout-head">
        <button
          type="button"
          class="usage-back"
          :disabled="resetBusy"
          :aria-label="t('usage.menu.back', 'Back to all agents')"
          data-test="usage-provider-back"
          @click="closeProvider"
        >
          &lsaquo;
        </button>
        <div class="usage-flyout-title">
          <strong
            ><BrandIcon :kind="detailAgent.id" :size="16" :label="agentName(detailAgent)" />{{
              agentName(detailAgent)
            }}</strong
          >
          <span>{{ updatedText(detailAgent) }}</span>
        </div>
      </header>
      <div class="usage-flyout-body">
        <p
          v-if="detailAgent.resetCreditsError"
          class="usage-account-error"
          role="alert"
          data-test="usage-reset-credits-error"
          v-text="
            t('usage.menu.resetCreditsError', 'Reset credits: {{error}}', {
              error: detailAgent.resetCreditsError
            })
          "
        ></p>
        <p v-if="providerErrors[detailAgent.id]" class="usage-account-error" role="alert">
          {{ providerErrors[detailAgent.id]
          }}<span v-if="windows(detailAgent).length">{{ ' ' + t('usage.menu.showingLastKnown', 'Showing the last known reading.') }}</span>
        </p>
        <p
          v-if="providerBusy[detailAgent.id] && !windows(detailAgent).length"
          class="usage-none"
          role="status"
        >
          {{ t('usage.menu.readingProvider', 'Reading provider usage...') }}
        </p>
        <!-- Not the same error again under the red one. -->
        <p
          v-else-if="!windows(detailAgent).length && unavailableText(detailAgent) !== providerErrors[detailAgent.id]"
          class="usage-none"
        >
          {{ unavailableText(detailAgent) }}
        </p>
        <div
          v-for="w in windows(detailAgent)"
          :key="w.label"
          class="usage-window usage-flyout-window"
          :class="{ stale: stale(detailAgent, w) }"
        >
          <div class="usage-line">
            <span>{{ windowLabel(w.label) }}</span>
          </div>
          <div
            class="usage-bar"
            role="meter"
            :aria-label="quotaText(w.label)"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="shownPct(w.usedPct)"
          >
            <div
              class="usage-fill"
              :class="level(w.usedPct)"
              :style="{ width: shownPct(w.usedPct) + '%' }"
            ></div>
          </div>
          <div class="usage-flyout-window-meta">
            <span class="usage-pct" :class="'usage-level-' + level(w.usedPct)"
              >{{ pctLabel(w.usedPct) }}</span
            ><span
              v-if="shortReset(w.resetsAt)"
              v-text="
                stale(detailAgent, w)
                  ? t('usage.menu.lastKnownReading', 'Last known reading')
                  : t('usage.menu.resetsIn', 'Resets in {{time}}', { time: shortReset(w.resetsAt) })
              "
            ></span>
          </div>
          <p
            v-if="lockedText(w)"
            class="usage-locked"
            role="note"
            data-test="usage-locked"
            v-text="t('usage.menu.locked', 'Locked: {{reason}}', { reason: lockedText(w) })"
          ></p>
        </div>
        <div v-if="extraUsage" class="usage-extra" data-test="usage-extra">
          <div class="usage-section-head">
            <h4>{{ t('usage.menu.extraUsage', 'Extra usage') }}</h4>
            <span
              v-if="extraUsage.pct !== null"
              class="usage-pct"
              :class="'usage-level-' + level(extraUsage.pct)"
              >{{ Math.round(extraUsage.pct) }}%</span
            >
          </div>
          <div
            v-if="extraUsage.pct !== null"
            class="usage-bar"
            role="meter"
            :aria-label="t('usage.menu.extraUsageSpent', 'Extra usage spent')"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="Math.round(extraUsage.pct)"
          >
            <div
              class="usage-fill"
              :class="level(extraUsage.pct)"
              :style="{ width: extraUsage.pct + '%' }"
            ></div>
          </div>
          <p class="usage-extra-amount" data-test="usage-extra-amount">{{ extraUsageText(extraUsage) }}</p>
          <p v-if="extraUsage.limitReached" class="usage-locked" role="alert" data-test="usage-extra-limit">
            {{ t('usage.menu.extraUsageLimitReached', 'Monthly spend limit reached.') }}
          </p>
        </div>
        <div v-if="breakdown" class="usage-breakdown" data-test="usage-breakdown">
          <div class="usage-section-head">
            <h4>{{ t('usage.menu.weekShare', "Share of this week's usage") }}</h4>
            <span v-if="Number.isFinite(breakdown.asOf)">{{ asOfText(breakdown.asOf) }}</span>
          </div>
          <p class="usage-breakdown-hint">{{
            t('usage.menu.weekShareHint', 'Where your usage went, not how much of your limit is used.')
          }}</p>
          <div
            v-for="(row, index) in breakdown.rows"
            :key="index"
            class="usage-breakdown-row"
            data-test="usage-breakdown-row"
          >
            <span class="usage-breakdown-label" :title="row.label">{{ row.label }}</span
            ><span class="usage-breakdown-pct">{{ Math.round(row.pct) }}%</span>
            <div class="usage-bar">
              <div class="usage-fill ok" :style="{ width: row.pct + '%' }"></div>
            </div>
          </div>
        </div>
        <div v-if="credits" class="usage-reset-credits" data-test="usage-reset-credits">
          <strong>{{ creditsText(credits.availableCount) }}</strong>
          <span
            v-if="expiryText(credits.nextExpiresAt)"
            :title="new Date(credits.nextExpiresAt).toLocaleString(intlLocale())"
            >{{ expiryText(credits.nextExpiresAt) }}</span
          >
          <button
            v-if="!resetConfirm && (canReset || resetBusy)"
            type="button"
            :disabled="resetBusy"
            class="usage-action"
            data-test="usage-reset-now"
            @click="beginReset"
          >
            {{
              resetBusy ? t('usage.menu.resetting', 'Resetting…') : t('usage.menu.reset', 'Reset')
            }}
          </button>
        </div>
        <div
          v-if="resetConfirm"
          class="usage-reset-confirm"
          role="alertdialog"
          :aria-label="t('usage.menu.confirmResetLabel', 'Confirm Codex usage reset')"
          aria-describedby="usage-reset-explanation"
        >
          <strong>{{ t('usage.menu.confirmResetTitle', 'Reset Codex limits?') }}</strong>
          <p id="usage-reset-explanation">
            {{ resetExplanation[0] }}<strong>{{ resetConfirm.label }}</strong
            >{{ resetExplanation[1] }}
          </p>
          <div>
            <button
              type="button"
              :disabled="resetBusy"
              class="usage-action primary"
              data-test="usage-reset-confirm"
              @click="confirmReset"
            >
              {{
                resetBusy
                  ? t('usage.menu.resetting', 'Resetting…')
                  : t('usage.menu.reset', 'Reset')
              }}</button
            ><button
              type="button"
              :disabled="resetBusy"
              class="usage-action"
              data-test="usage-reset-cancel"
              @click="resetConfirm = null"
            >
              {{ t('usage.menu.cancel', 'Cancel') }}
            </button>
          </div>
        </div>
        <p
          v-if="resetNotice"
          class="usage-account-notice"
          role="status"
          data-test="usage-reset-notice"
        >
          {{ resetNotice }}
        </p>
        <div v-if="providerAccounts(detailAgent.id)" class="usage-flyout-accounts">
          <h4
            v-text="t('usage.menu.agentAccount', '{{name}} account', { name: agentName(detailAgent) })"
          ></h4>
          <button
            type="button"
            class="usage-account-toggle"
            :disabled="resetBusy || accountBusy[detailAgent.id]"
            :aria-expanded="accountChooser"
            data-test="usage-account-toggle"
            @click="accountChooser = !accountChooser"
          >
            <span>{{ accountLabel(detailAgent.id) }}</span
            ><span aria-hidden="true">{{ accountChooser ? '\u2304' : '\u203a' }}</span>
          </button>
          <div v-if="accountChooser" class="usage-account-picker">
            <label :for="'usage-account-' + detailAgent.id">{{
              t('usage.menu.account', 'Account')
            }}</label>
            <ThemedSelect
              :id="'usage-account-' + detailAgent.id"
              :value="providerAccounts(detailAgent.id).selectedId || ''"
              :disabled="
                resetBusy ||
                accountBusy[detailAgent.id] ||
                !!providerAccounts(detailAgent.id).error ||
                accountsReadFailed
              "
              :data-test="'usage-account-' + detailAgent.id"
              @change="selectAccount(providerAccounts(detailAgent.id), $event)"
            >
              <option v-if="providerAccounts(detailAgent.id).system" value="">
                {{
                  providerAccounts(detailAgent.id).system.label ||
                  t('usage.menu.systemDefault', 'System default')
                }}
              </option>
              <option
                v-for="account in providerAccounts(detailAgent.id).accounts || []"
                :key="account.id"
                :value="account.id"
                v-text="
                  account.status === 'missing'
                    ? t('usage.menu.signInNeeded', '{{account}} - sign-in needed', {
                        account: account.label || account.email || t('usage.menu.account', 'Account')
                      })
                    : account.label || account.email || t('usage.menu.account', 'Account')
                "
              ></option>
            </ThemedSelect>
          </div>
          <p v-if="providerAccounts(detailAgent.id).error" class="usage-account-error" role="alert">
            {{ providerAccounts(detailAgent.id).error }}
          </p>
          <p v-if="accountsError" class="usage-account-error" role="alert">
            {{ accountsError }}
            <button
              v-if="accountsReadFailed"
              type="button"
              class="usage-text-button"
              data-test="usage-provider-accounts-retry"
              @click="loadAccounts"
            >
              {{ t('usage.menu.retry', 'Retry') }}
            </button>
          </p>
          <p v-if="accountNotice" class="usage-account-notice" role="status">{{ accountNotice }}</p>
        </div>
      </div>
      <footer v-if="hasAccounts" class="usage-roster-foot">
        <button
          type="button"
          :disabled="resetBusy"
          data-test="usage-provider-manage-accounts"
          @click="(closeMenu(), emit('accounts'))"
        >
          <span>{{ t('usage.menu.manageAccounts', 'Manage accounts') }}</span><span aria-hidden="true">&rsaquo;</span>
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.usage-roster.notif-menu {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  color: var(--text);
  background: var(--surface);
  box-shadow: 0 12px 40px #0005;
}
.usage-flyout.notif-menu {
  z-index: 61;
}
.usage-flyout-head {
  display: flex;
  gap: 9px;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.usage-flyout-title {
  min-width: 0;
  flex: 1;
}
.usage-flyout-title strong {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-strong);
}
.usage-flyout-title > span {
  display: block;
  margin-top: 5px;
  font-size: 10px;
  color: var(--text-dim);
}
.usage-back {
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font-size: 23px;
  padding: 0 4px;
  cursor: pointer;
}
.usage-flyout-body {
  min-height: 0;
  overflow-y: auto;
  padding: 0 13px 12px;
  overscroll-behavior: contain;
}
.usage-flyout .usage-window {
  margin-top: 13px;
}
.usage-flyout .usage-line {
  color: var(--text-strong);
  font-weight: 500;
}
.usage-flyout .usage-bar {
  height: 6px;
  margin-top: 7px;
}
.usage-flyout-window-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  font-size: 10px;
  color: var(--text-dim);
}
.usage-flyout-window-meta .usage-pct {
  font-size: 10px;
  font-weight: 400;
}
.usage-flyout .usage-none {
  margin-top: 12px;
}
.usage-flyout .usage-account-error,
.usage-flyout .usage-account-notice {
  margin: 10px 0 0;
}
.usage-locked {
  margin: 6px 0 0;
  font-size: 10px;
  line-height: 1.45;
  color: var(--warn);
  overflow-wrap: anywhere;
}
.usage-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
}
.usage-section-head h4 {
  margin: 0;
  color: var(--text-dim);
  font-size: 10px;
  font-weight: 500;
}
.usage-section-head > span {
  font-size: 10px;
  color: var(--text-dim);
}
.usage-extra-amount {
  margin: 6px 0 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.usage-breakdown-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 8px;
  margin-top: 7px;
  font-size: 11px;
}
.usage-breakdown-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-breakdown-pct {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.usage-flyout .usage-breakdown-row .usage-bar {
  grid-column: 1 / -1;
  height: 3px;
  margin-top: 4px;
}
.usage-extra,
.usage-breakdown,
.usage-reset-credits,
.usage-flyout-accounts {
  margin-top: 14px;
  padding-top: 11px;
  border-top: 1px solid var(--border);
}
.usage-reset-credits strong {
  display: block;
  font-size: 11px;
  font-weight: 500;
}
.usage-reset-credits > span {
  display: block;
  font-size: 10px;
  margin-top: 4px;
  color: var(--text-dim);
}
.usage-action {
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 11px;
  padding: 6px 9px;
  cursor: pointer;
}
.usage-action:hover:not(:disabled) {
  background: var(--surface-3);
}
.usage-action:disabled,
.usage-account-toggle:disabled {
  opacity: 0.55;
  cursor: default;
}
/* The reset: its text on the left, "Reset" on the right. */
.usage-reset-credits {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 12px;
  align-items: center;
}
.usage-reset-credits > strong,
.usage-reset-credits > span {
  grid-column: 1;
}
.usage-reset-credits .usage-action {
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
  white-space: nowrap;
}
.usage-action.primary {
  background: var(--accent);
  color: var(--chrome);
  border-color: var(--accent);
  font-weight: 600;
}
/* Hovered, it stays the main button (a lighter blue), still readable. */
.usage-action.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 82%, #fff);
  border-color: color-mix(in srgb, var(--accent) 82%, #fff);
  color: var(--chrome);
}
.usage-reset-confirm {
  margin-top: 12px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  padding: 10px;
  font-size: 11px;
}
.usage-reset-confirm p {
  margin: 7px 0 10px;
  color: var(--text-dim);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.usage-reset-confirm > div {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.usage-flyout-accounts h4 {
  margin: 0 0 6px;
  color: var(--text-dim);
  font-size: 10px;
  font-weight: 500;
}
.usage-account-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 0;
  color: var(--text);
  background: transparent;
  border: 0;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.usage-account-toggle > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-roster-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 13px 9px;
  flex: 0 0 auto;
}
.usage-roster-head strong {
  margin-right: auto;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-strong);
}
.usage-roster-head > span {
  font-size: 10px;
  color: var(--text-dim);
}
.usage-refresh {
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  width: 24px;
  height: 24px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.usage-refresh:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text-strong);
}
.usage-refresh:disabled {
  opacity: 0.6;
  cursor: default;
}
.usage-density {
  display: flex;
  flex: 0 0 auto;
  margin: 0 13px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  padding: 2px;
  gap: 2px;
}
.usage-density button {
  flex: 1;
  background: transparent;
  border: 0;
  border-radius: 3px;
  padding: 5px 8px;
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.usage-density button[aria-pressed='true'] {
  background: var(--surface-3);
  color: var(--text-strong);
}
.usage-roster-body {
  flex: 1 1 auto;
  overflow: auto;
  min-height: 0;
  border-top: 1px solid var(--border);
  overscroll-behavior: contain;
}
.usage-roster .usage-agent {
  padding: 0;
  border: 0;
  margin: 0;
}
.usage-roster .usage-agent + .usage-agent {
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.usage-roster-row {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 9px;
  padding: 11px 13px;
  text-align: left;
  color: var(--text);
  border: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.usage-roster-row:hover {
  background: var(--surface-2);
}
.usage-roster-row[aria-expanded='true'] {
  background: var(--surface-2);
}
.usage-roster.compact .usage-roster-row {
  padding-top: 6px;
  padding-bottom: 6px;
}
.usage-brand {
  flex: 0 0 23px;
  width: 23px;
  height: 23px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface-2);
  display: grid;
  place-items: center;
}
.usage-roster-name {
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-plan {
  color: var(--text-dim);
  font-weight: 400;
}
.usage-summary {
  margin-left: auto;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.usage-countdown,
.usage-old {
  color: var(--text-dim);
  font-size: 10px;
}
.usage-summary-pct {
  color: var(--text-strong);
}
.usage-level-warn {
  color: var(--warn);
}
.usage-level-bad {
  color: var(--danger);
}
.stale .usage-summary-pct,
.usage-window.stale .usage-pct {
  color: var(--text-dim);
}
.usage-no-data {
  margin-left: auto;
  font-size: 10px;
  min-width: 0;
  color: var(--text-dim);
  text-align: right;
}
.usage-chevron {
  flex: 0 0 12px;
  color: var(--text-dim);
  margin-left: auto;
  transition: transform 0.12s ease;
}
.usage-summary + .usage-chevron,
.usage-no-data + .usage-chevron {
  margin-left: 0;
}
.usage-chevron.expanded {
  transform: rotate(90deg);
}
.usage-provider-detail {
  padding: 0 13px 12px 45px;
}
.usage-roster .usage-window {
  margin-top: 9px;
}
.usage-roster .usage-line {
  font-size: 11px;
}
.usage-roster .usage-bar {
  height: 4px;
  margin-top: 5px;
}
.usage-roster .usage-reset,
.usage-observed {
  margin: 5px 0 0;
  font-size: 10px;
  color: var(--text-dim);
  line-height: 1.45;
}
.usage-observed {
  padding-top: 4px;
}
.usage-roster .usage-none {
  margin: 2px 0 0;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.5;
}
.usage-account-picker {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  margin: 2px 0 9px;
  font-size: 11px;
  color: var(--text-dim);
}
.usage-account-picker .ts-select {
  min-width: 0;
  width: 100%;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--text);
  padding: 4px 6px;
  font: inherit;
}
.usage-account-picker .ts-select:disabled {
  opacity: 0.6;
}
.usage-account-error,
.usage-account-notice {
  margin: 8px 13px;
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.usage-account-error {
  color: var(--danger);
}
.usage-account-picker .usage-account-error {
  grid-column: 1 / -1;
  margin: 0;
}
.usage-account-notice {
  color: var(--text-dim);
}
.usage-text-button {
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}
.usage-roster-foot {
  padding: 4px 0;
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}
.usage-roster-foot button {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 13px;
  color: var(--text);
  background: transparent;
  border: 0;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.usage-roster-foot button:hover {
  background: var(--surface-2);
  color: var(--text-strong);
}
.usage-roster button:focus-visible,
.usage-roster .ts-select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
@keyframes usage-refresh-spin {
  to {
    transform: rotate(360deg);
  }
}
.spinning {
  animation: usage-refresh-spin 1s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
  .usage-chevron {
    transition: none;
  }
}
@media (max-height: 540px) {
  .usage-roster.compact .usage-roster-row {
    padding-top: 3px;
    padding-bottom: 3px;
  }
  .usage-roster.compact .usage-brand {
    flex-basis: 21px;
    width: 21px;
    height: 21px;
  }
}
@media (max-height: 300px) {
  .usage-roster.notif-menu {
    overflow: auto;
  }
  .usage-roster-body {
    flex: 0 0 auto;
  }
}
</style>
