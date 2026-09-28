<script setup>
// Local quota observations update the toolbar without network polling.
// Authenticated provider reads happen only on menu/open/refresh actions;
// redeeming an actual reset credit additionally requires confirmation.
// Roster and provider flyout patterns inspired by Orca UsageRosterPanel,
// ProviderPanel and CodexSwitcherMenu (MIT, Lovecast, 2026); independent Vue UI.
// Amber from 66 %, red from 95 %; an old reading says so.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import BrandIcon from './BrandIcon.vue'

const emit = defineEmits(['details', 'accounts'])
const NAMES = {
  claude: 'Claude Code',
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
const providerErrors = ref({})
const providerBusy = ref({})
const resetConfirm = ref(null)
const resetBusy = ref(false)
const resetNotice = ref('')
const installed = ref([])
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
let alive = true
let accountsRequest = 0
let usageRequest = 0
let agentsRequest = 0
const providerRequests = new Map()

async function load() {
  if (!window.shellApi.getUsage) {
    usage.value = { error: 'The local usage reader is not available.' }
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
  if (!window.shellApi.listAgents) return
  const request = ++agentsRequest
  try {
    const result = await window.shellApi.listAgents()
    if (!alive || request !== agentsRequest) return
    if (!Array.isArray(result)) throw new Error('Could not read installed agents.')
    installed.value = result.filter((agent) => agent?.available && typeof agent.id === 'string')
    rosterError.value = ''
  } catch {
    if (alive && request === agentsRequest)
      rosterError.value = 'Could not refresh the installed agent list.'
  }
}
async function loadAccounts() {
  if (!window.shellApi.accounts?.list) return
  const request = ++accountsRequest
  try {
    const result = await window.shellApi.accounts.list()
    if (!alive || request !== accountsRequest) return
    if (!result?.ok) throw new Error(result?.error || 'Could not read accounts.')
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
      accountsError.value = err.message || 'Could not read accounts.'
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
async function readProvider(id) {
  if (!['claude', 'codex'].includes(id) || !window.shellApi.providerUsage?.read) return
  if (accountsReadFailed.value || providerAccounts(id)?.error || accountBusy.value[id]) return
  const accountId = selectedAccount(id)
  const request = (providerRequests.get(id) || 0) + 1
  providerRequests.set(id, request)
  providerBusy.value[id] = true
  providerErrors.value[id] = ''
  resetConfirm.value = null
  try {
    const result = await window.shellApi.providerUsage.read({ provider: id, accountId })
    if (!alive || request !== providerRequests.get(id) || accountId !== selectedAccount(id)) return
    if (!result?.ok) throw new Error(result?.error || 'Could not refresh provider usage.')
    if (result.provider !== id || result.accountId !== accountId)
      throw new Error('The usage account changed. Refresh before continuing.')
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
  } catch (err) {
    if (alive && request === providerRequests.get(id)) {
      providerErrors.value[id] = err.message || 'Could not refresh provider usage.'
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
    if (!result?.ok) throw new Error(result?.error || 'Could not switch accounts.')
    if (!alive) return
    accountNotice.value =
      provider.provider === 'claude'
        ? 'Restart your Claude terminals when ready to use this sign-in.'
        : 'New Codex terminals will use this account.'
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
    if (alive) accountsError.value = err.message || 'Could not switch accounts.'
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
              error: 'Usage has not been read for this account.'
            }
      )
    }
  }
  for (const agent of installed.value) {
    if (rows.has(agent.id)) rows.get(agent.id).name ||= agent.name
    else rows.set(agent.id, { id: agent.id, name: agent.name, windows: [], source: 'unsupported' })
  }
  for (const reading of Object.values(providerReadings.value)) {
    if (reading.accountId === selectedAccount(reading.id))
      rows.set(reading.id, { ...rows.get(reading.id), ...reading })
  }
  return [...rows.values()]
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
function stale(agent, window) {
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
  const plan = agent.plan || agent.planType || (matching ? selected?.plan : null)
  return typeof plan === 'string'
    ? plan
        .trim()
        .slice(0, 40)
        .replace(/[_-]+/g, ' ')
        .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    : ''
}
function unavailableText(agent) {
  if (agent.error) return agent.error
  return agent.source === 'unsupported'
    ? 'No local usage data. Tessel does not collect subscription quotas for this agent yet.'
    : 'Not available: its quota is not saved on this computer.'
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
    resetNotice.value = 'The usage account or reading changed. Refresh before resetting.'
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
        ? 'The reset result is uncertain. Refresh usage to check before trying again.'
        : result?.error || 'The reset could not be completed. Refresh before trying again.'
      return
    }
    resetNotice.value =
      {
        reset: 'Usage limits reset.',
        nothingToReset: 'There are no eligible limits to reset.',
        noCredit: 'No reset credit is available.',
        alreadyRedeemed: 'This reset was already redeemed.'
      }[result.outcome] || 'Reset request completed.'
    await Promise.all([readProvider('codex'), load()])
  } catch {
    if (alive) {
      if (providerReadings.value.codex) delete providerReadings.value.codex.resetToken
      resetConfirm.value = null
      resetNotice.value =
        'The reset result is uncertain. Refresh usage to check before trying again.'
    }
  } finally {
    if (alive) resetBusy.value = false
  }
}
function expiryText(iso) {
  if (!Number.isFinite(timestamp(iso))) return ''
  if (timestamp(iso) <= now.value) return 'Expired'
  return `Expires in ${shortReset(iso)}`
}
function accountLabel(id) {
  const provider = providerAccounts(id)
  return provider?.selectedId
    ? provider.accounts?.find((account) => account.id === provider.selectedId)?.label ||
        'Saved account'
    : provider?.system?.label || 'System default'
}
function updatedText(agent) {
  const observed = timestamp(agent?.updatedAt || agent?.observedAt)
  if (!Number.isFinite(observed)) return 'Not yet updated'
  const seconds = Math.max(0, Math.floor((now.value - observed) / 1000))
  if (seconds < 60) return 'Updated just now'
  if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `Updated ${Math.floor(seconds / 3600)} h ago`
  return `Updated ${Math.floor(seconds / 86400)} d ago`
}
function shortReset(iso) {
  const milliseconds = timestamp(iso) - now.value
  if (!Number.isFinite(milliseconds)) return ''
  if (milliseconds <= 0) return 'Reset passed'
  const minutes = Math.ceil(milliseconds / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
// The highest fresh window, for the icon's colour.
const worst = computed(() => {
  let max = -1
  for (const a of agents.value)
    for (const w of windows(a)) if (!stale(a, w) && w.usedPct > max) max = w.usedPct
  return max
})
const level = (pct) => (pct >= 95 ? 'bad' : pct >= 66 ? 'warn' : 'ok')

function resetText(iso) {
  if (!iso) return ''
  const ms = timestamp(iso) - now.value
  if (!Number.isFinite(ms)) return ''
  if (!(ms > 0)) return 'reset time passed'
  const min = Math.round(ms / 60000)
  if (min < 60) return `resets in ${min} min`
  if (min < 48 * 60) return `resets in ${Math.floor(min / 60)} h ${min % 60} min`
  return `resets ${new Date(iso).toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
}
function windowLabel(l) {
  return l === '5h' ? '5-hour' : l === 'week' ? 'Weekly' : l
}

function onDocDown(e) {
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
      .find((node) => node.dataset.test === `usage-row-${id}`)
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
async function refresh() {
  if (resetBusy.value) return
  await Promise.all([load(), loadAccounts(), loadAgents()])
  if (alive && open.value) await Promise.all(['claude', 'codex'].map(readProvider))
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocDown, true)
  window.addEventListener('tessel:accounts-changed', accountsChanged)
  window.addEventListener('resize', positionMenu)
  document.addEventListener('keydown', onKey, true)
  load()
  timer = setInterval(load, 60000)
})
onBeforeUnmount(() => {
  alive = false
  document.removeEventListener('pointerdown', onDocDown, true)
  window.removeEventListener('tessel:accounts-changed', accountsChanged)
  window.removeEventListener('resize', positionMenu)
  document.removeEventListener('keydown', onKey, true)
  clearInterval(timer)
})
function toggle() {
  if (resetBusy.value) return
  if (open.value) return closeMenu()
  open.value = !open.value
  if (open.value) {
    positionMenu()
    refresh()
  }
}
</script>

<template>
  <div ref="root" class="notif-wrap">
    <button
      ref="trigger"
      class="tb-icon"
      :class="[{ on: open }, worst >= 0 ? 'usage-' + level(worst) : '']"
      :title="
        worst >= 0
          ? 'Usage: up to ' + Math.round(worst) + '% of a quota used'
          : 'Usage of your agents\u0027 quotas'
      "
      aria-label="Usage"
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
      aria-label="Usage"
      :aria-busy="refreshing"
    >
      <header class="usage-roster-head">
        <strong>Usage</strong><span>all agents</span
        ><button
          type="button"
          class="usage-refresh"
          aria-label="Refresh usage"
          title="Refresh usage"
          :disabled="refreshing || resetBusy"
          data-test="usage-refresh"
          @click="refresh"
        >
          <svg
            :class="{ spinning: refreshing }"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M13 6a5 5 0 10.1 3M13 2.5V6H9.5"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </header>
      <div class="usage-density" role="group" aria-label="Usage display">
        <button
          type="button"
          :aria-pressed="mode === 'detailed'"
          data-test="usage-mode-detailed"
          @click="changeMode('detailed')"
        >
          Detailed</button
        ><button
          type="button"
          :aria-pressed="mode === 'compact'"
          data-test="usage-mode-compact"
          @click="changeMode('compact')"
        >
          Compact
        </button>
      </div>
      <div class="usage-roster-body">
        <p v-if="usage && usage.error" class="usage-account-error" role="alert">
          Could not read usage: {{ usage.error }}
        </p>
        <p v-else-if="!agents.length" class="notif-empty">
          {{ loading ? 'Reading usage...' : 'No agent usage available.' }}
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
            Retry
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
              ><BrandIcon :kind="a.id" :size="16" :label="agentName(a)"
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
              :title="
                windowLabel(summaryWindow(a).label) +
                ' quota used' +
                (stale(a, summaryWindow(a)) ? ' - last known reading' : '')
              "
            >
              <span v-if="stale(a, summaryWindow(a))" class="usage-old">last seen</span>
              <span v-else-if="shortReset(summaryWindow(a).resetsAt)" class="usage-countdown">{{
                shortReset(summaryWindow(a).resetsAt)
              }}</span>
              <span
                class="usage-summary-pct"
                :class="'usage-level-' + level(summaryWindow(a).usedPct)"
                >{{ Math.round(summaryWindow(a).usedPct) }}%</span
              >
            </span>
            <span v-else-if="!windows(a).length" class="usage-no-data">No local usage data</span>
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
                  >{{ Math.round(w.usedPct) }}%</span
                >
              </div>
              <div class="usage-bar">
                <div
                  class="usage-fill"
                  :class="level(w.usedPct)"
                  :style="{ width: w.usedPct + '%' }"
                ></div>
              </div>
              <div class="usage-reset">
                {{ resetText(w.resetsAt)
                }}<span v-if="stale(a, w)"> &middot; last known reading</span>
              </div>
            </div>
            <p v-if="a.observedAt && windows(a).length" class="usage-observed">
              Observed
              {{
                new Date(a.observedAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })
              }}
            </p>
          </div>
        </section>
      </div>
      <footer class="usage-roster-foot">
        <button type="button" data-test="usage-details" @click="(closeMenu(), emit('details'))">
          <span>Usage details &amp; history</span><span aria-hidden="true">&rsaquo;</span></button
        ><button
          v-if="hasAccounts"
          type="button"
          data-test="usage-manage-accounts"
          @click="(closeMenu(), emit('accounts'))"
        >
          <span>Manage accounts</span><span aria-hidden="true">&rsaquo;</span>
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
      :aria-label="agentName(detailAgent) + ' usage'"
      :aria-busy="providerBusy[detailAgent.id] || resetBusy"
      data-test="usage-provider-flyout"
    >
      <header class="usage-flyout-head">
        <button
          type="button"
          class="usage-back"
          :disabled="resetBusy"
          aria-label="Back to all agents"
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
        <button
          type="button"
          class="usage-refresh"
          :disabled="providerBusy[detailAgent.id] || resetBusy"
          aria-label="Refresh provider usage"
          data-test="usage-provider-refresh"
          @click="readProvider(detailAgent.id)"
        >
          <svg
            :class="{ spinning: providerBusy[detailAgent.id] }"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M13 6a5 5 0 10.1 3M13 2.5V6H9.5"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </header>
      <div class="usage-flyout-body">
        <p
          v-if="detailAgent.resetCreditsError"
          class="usage-account-error"
          role="alert"
          data-test="usage-reset-credits-error"
        >
          Reset credits: {{ detailAgent.resetCreditsError }}
        </p>
        <p v-if="providerErrors[detailAgent.id]" class="usage-account-error" role="alert">
          {{ providerErrors[detailAgent.id]
          }}<span v-if="windows(detailAgent).length"> Showing the last known reading.</span>
        </p>
        <p
          v-if="providerBusy[detailAgent.id] && !windows(detailAgent).length"
          class="usage-none"
          role="status"
        >
          Reading provider usage...
        </p>
        <p v-else-if="!windows(detailAgent).length" class="usage-none">
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
            :aria-label="windowLabel(w.label) + ' quota used'"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="w.usedPct"
          >
            <div
              class="usage-fill"
              :class="level(w.usedPct)"
              :style="{ width: w.usedPct + '%' }"
            ></div>
          </div>
          <div class="usage-flyout-window-meta">
            <span class="usage-pct" :class="'usage-level-' + level(w.usedPct)"
              >{{ Math.round(w.usedPct) }}% used</span
            ><span v-if="shortReset(w.resetsAt)">{{
              stale(detailAgent, w) ? 'Last known reading' : 'Resets in ' + shortReset(w.resetsAt)
            }}</span>
          </div>
        </div>
        <div v-if="credits" class="usage-reset-credits" data-test="usage-reset-credits">
          <strong
            >{{ credits.availableCount }} rate-limit
            {{ credits.availableCount === 1 ? 'reset' : 'resets' }} available</strong
          >
          <span
            v-if="expiryText(credits.nextExpiresAt)"
            :title="new Date(credits.nextExpiresAt).toLocaleString()"
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
            {{ resetBusy ? 'Using reset...' : 'Reset now' }}
          </button>
        </div>
        <div
          v-if="resetConfirm"
          class="usage-reset-confirm"
          role="alertdialog"
          aria-label="Confirm Codex usage reset"
          aria-describedby="usage-reset-explanation"
        >
          <strong>Reset Codex limits?</strong>
          <p id="usage-reset-explanation">
            This uses one reset credit for <strong>{{ resetConfirm.label }}</strong> and immediately
            resets eligible usage windows.
          </p>
          <div>
            <button
              type="button"
              :disabled="resetBusy"
              class="usage-action"
              data-test="usage-reset-cancel"
              @click="resetConfirm = null"
            >
              Cancel</button
            ><button
              type="button"
              :disabled="resetBusy"
              class="usage-action primary"
              data-test="usage-reset-confirm"
              @click="confirmReset"
            >
              {{ resetBusy ? 'Using reset...' : 'Use one reset credit' }}
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
          <h4>{{ agentName(detailAgent) }} account</h4>
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
            <label :for="'usage-account-' + detailAgent.id">Account</label>
            <select
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
                {{ providerAccounts(detailAgent.id).system.label || 'System default' }}
              </option>
              <option
                v-for="account in providerAccounts(detailAgent.id).accounts || []"
                :key="account.id"
                :value="account.id"
              >
                {{ account.label || account.email || 'Account'
                }}{{ account.status === 'missing' ? ' - sign-in needed' : '' }}
              </option>
            </select>
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
              Retry
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
          <span>Manage accounts</span><span aria-hidden="true">&rsaquo;</span>
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
/* The reset: its text on the left, "Reset now" on the right. */
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
.usage-account-picker select {
  min-width: 0;
  width: 100%;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--text);
  padding: 4px 6px;
  font: inherit;
}
.usage-account-picker select:disabled {
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
.usage-roster select:focus-visible {
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
@media (max-height: 300px) {
  .usage-roster.notif-menu {
    overflow: auto;
  }
  .usage-roster-body {
    flex: 0 0 auto;
  }
}
</style>
