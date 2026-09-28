<script setup>
// The toolbar gauge: how much of each agent's subscription quota is used
// (5-hour and weekly windows) and when it resets, read by the main process
// from the agents' own local files (agentUsage.js: no sign-in, no network).
// Amber from 80 %, red from 95 %; an old reading says so.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import BrandIcon from './BrandIcon.vue'

const emit = defineEmits(['details', 'accounts'])
const NAMES = { claude: 'Claude Code', codex: 'Codex' }
const open = ref(false)
const usage = ref(null) // { agents: [...] } | { error }
const root = ref(null)
const accounts = ref([])
const accountsError = ref('')
const accountBusy = ref({})
const accountNotice = ref('')
const accountsReadFailed = ref(false)
const hasAccounts = computed(() => !!window.shellApi.accounts?.list)
let timer = null
let alive = true
let accountsRequest = 0
let usageRequest = 0

async function load() {
  if (!window.shellApi.getUsage) return
  const request = ++usageRequest
  try {
    const result = await window.shellApi.getUsage()
    if (alive && request === usageRequest) usage.value = result
  } catch (err) {
    if (alive && request === usageRequest) usage.value = { error: err && err.message }
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
      return provider.error && old ? { ...old, error: provider.error } : provider
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
async function selectAccount(provider, event) {
  const selection = event.target.value || null
  // Keep the confirmed value visible until the main process has saved it.
  event.target.value = provider.selectedId || ''
  if (accountBusy.value[provider.provider] || selection === provider.selectedId) return
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
  load()
  if (open.value) loadAccounts()
}
const agents = computed(() =>
  usage.value && Array.isArray(usage.value.agents) ? usage.value.agents : []
)
// The highest fresh window, for the icon's colour.
const worst = computed(() => {
  let max = -1
  for (const a of agents.value)
    for (const w of a.windows || []) if (!w.stale && w.usedPct > max) max = w.usedPct
  return max
})
const level = (pct) => (pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : 'ok')

function resetText(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
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
  if (open.value && root.value && !root.value.contains(e.target)) open.value = false
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocDown, true)
  window.addEventListener('tessel:accounts-changed', accountsChanged)
  load()
  timer = setInterval(load, 60000)
})
onBeforeUnmount(() => {
  alive = false
  document.removeEventListener('pointerdown', onDocDown, true)
  window.removeEventListener('tessel:accounts-changed', accountsChanged)
  clearInterval(timer)
})
function toggle() {
  open.value = !open.value
  if (open.value) {
    load()
    loadAccounts()
  }
}
</script>

<template>
  <div ref="root" class="notif-wrap">
    <button
      class="tb-icon"
      :class="[{ on: open }, worst >= 0 ? 'usage-' + level(worst) : '']"
      :title="
        worst >= 0
          ? `Usage: up to ${Math.round(worst)}% of a quota used`
          : 'Usage of your agents’ quotas'
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
    <div v-if="open" class="notif-menu usage-menu" role="dialog" aria-label="Usage">
      <div class="notif-head">
        <span>Usage of your subscriptions</span>
        <button
          class="exit-btn"
          data-test="usage-details"
          @click="((open = false), emit('details'))"
        >
          Details…
        </button>
      </div>
      <p v-if="usage && usage.error" class="notif-empty">
        Could not read the usage: {{ usage.error }}
      </p>
      <p v-else-if="!agents.length" class="notif-empty">Reading…</p>
      <p v-if="accountsError" class="usage-account-error" role="alert">
        {{ accountsError }}
        <button
          v-if="accountsReadFailed"
          type="button"
          class="exit-btn"
          data-test="usage-accounts-retry"
          @click="loadAccounts"
        >
          Retry
        </button>
      </p>
      <p v-if="accountNotice" class="usage-account-notice" role="status">{{ accountNotice }}</p>
      <div v-for="a in agents" :key="a.id" class="usage-agent" data-test="usage-agent">
        <div class="usage-agent-head">
          <BrandIcon :kind="a.id" :size="14" />
          <span class="usage-agent-name">{{ NAMES[a.id] || a.id }}</span>
          <span v-if="a.stale && a.windows && a.windows.length" class="usage-stale"
            >last seen
            {{
              a.observedAt
                ? new Date(a.observedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit'
                  })
                : ''
            }}</span
          >
        </div>
        <div v-if="providerAccounts(a.id)" class="usage-account-picker">
          <label :for="'usage-account-' + a.id">Account</label>
          <select
            :id="'usage-account-' + a.id"
            :value="providerAccounts(a.id).selectedId || ''"
            :disabled="accountBusy[a.id] || !!providerAccounts(a.id).error || accountsReadFailed"
            :data-test="'usage-account-' + a.id"
            @change="selectAccount(providerAccounts(a.id), $event)"
          >
            <option v-if="providerAccounts(a.id).system" value="">
              {{ providerAccounts(a.id).system.label || 'System default' }}
            </option>
            <option
              v-for="account in providerAccounts(a.id).accounts || []"
              :key="account.id"
              :value="account.id"
            >
              {{ account.label || account.email || 'Account'
              }}{{ account.status === 'missing' ? ' · sign-in needed' : '' }}
            </option>
          </select>
          <span v-if="providerAccounts(a.id).error" class="usage-account-error" role="alert">{{
            providerAccounts(a.id).error
          }}</span>
        </div>
        <p v-if="!a.windows || !a.windows.length" class="usage-none">
          {{ a.error || 'Not available: its quota is not saved on this computer.' }}
        </p>
        <div v-for="w in a.windows" :key="w.label" class="usage-window" :class="{ stale: w.stale }">
          <div class="usage-line">
            <span>{{ windowLabel(w.label) }}</span>
            <span class="usage-pct">{{ Math.round(w.usedPct) }}%</span>
          </div>
          <div class="usage-bar">
            <div
              class="usage-fill"
              :class="level(w.usedPct)"
              :style="{ width: Math.min(100, w.usedPct) + '%' }"
            ></div>
          </div>
          <div class="usage-reset">{{ resetText(w.resetsAt) }}</div>
        </div>
      </div>
      <div v-if="hasAccounts" class="usage-accounts-foot">
        <button
          type="button"
          class="exit-btn"
          data-test="usage-manage-accounts"
          @click="((open = false), emit('accounts'))"
        >
          Manage accounts…
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.usage-account-picker {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  margin: 8px 0;
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
.usage-account-picker select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.usage-account-picker select:disabled {
  opacity: 0.6;
}
.usage-account-error,
.usage-account-notice {
  margin: 8px 12px;
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
.usage-accounts-foot {
  padding: 8px 12px;
  border-top: 1px solid var(--border);
}
</style>
