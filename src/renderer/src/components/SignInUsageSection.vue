<script setup>
// Cursor and Grok in Settings > AI provider accounts: the sign-in already on
// this computer (read only) and its plan usage. After Orca's
// CursorAccountsSection.tsx and GrokAccountsSection.tsx (MIT, Copyright (c)
// 2026 Lovecast Inc.).
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { t, intlLocale } from '../i18n'

const props = defineProps({
  provider: { type: String, required: true }, // 'cursor' | 'grok'
  status: { type: Object, default: null },
  loading: { type: Boolean, default: false }
})
const emit = defineEmits(['reload'])
const LINKS = {
  cursor: 'https://cursor.com/dashboard/spending',
  grok: 'https://docs.x.ai/build/overview'
}
const CURSOR = 'Cursor' // i18n-ignore product name
const usage = ref(null)
const refreshing = ref(false)
let alive = true
let stopPush = null

const signedIn = computed(() => props.status?.signedIn === true)
const fresh = computed(() => props.status?.tokenFresh === true)
const windows = computed(() => (Array.isArray(usage.value?.windows) ? usage.value.windows : []))
// Never let unknown usage read as healthy: a signed-in account with no
// numbers says why, and a failed refresh is said beside the last numbers.
const unavailable = computed(() =>
  signedIn.value && !windows.value.length && usage.value && !usage.value.ok ? usage.value.error || null : null
)
const staleError = computed(() =>
  signedIn.value && windows.value.length && usage.value?.stale ? usage.value.error || null : null
)

function sourceLabel(source) {
  if (source === 'keychain') return t('settings.accounts.cursor.sourceKeychain', 'macOS Keychain (cursor-agent)')
  if (source === 'cli') return t('settings.accounts.cursor.sourceCli', 'Cursor CLI auth file')
  if (source === 'desktop') return t('settings.accounts.cursor.sourceDesktop', 'Cursor IDE')
  return null
}
// The main process names windows in English (usageProviderMapping.js).
function windowLabel(label) {
  switch (label) {
    case '5-hour':
      return t('usage.window.fiveHour', '5-hour')
    case 'Weekly':
      return t('usage.window.weekly', 'Weekly')
    case 'Monthly':
      return t('settings.accounts.window.monthly', 'Monthly')
    case 'Monthly requests': // i18n-ignore
      return t('settings.accounts.window.monthlyRequests', 'Monthly requests')
    case 'Cursor models': // i18n-ignore
      return t('settings.accounts.window.cursorModels', 'Cursor models')
    case 'Other models': // i18n-ignore
      return t('settings.accounts.window.otherModels', 'Other models')
    case 'On demand': // i18n-ignore
      return t('settings.accounts.window.onDemand', 'On demand')
  }
  return String(label || '').slice(0, 70)
}
function resetText(at) {
  if (!Number.isFinite(at)) return ''
  const when = new Date(at).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })
  return t('settings.accounts.resets', 'Resets {{when}}', { when })
}
// What the signed-in card says under the account name.
const signedInText = computed(() => {
  if (props.provider === 'grok')
    return fresh.value
      ? t('settings.accounts.grok.signedIn', 'Signed in. Tessel reads the Grok CLI session stored on disk.')
      : t('settings.accounts.grok.expired', 'Session expired — run grok on the computer running Tessel and wait for it to start. If prompted, complete sign-in, then click Refresh usage. No chat message is needed.')
  if (!fresh.value)
    return t('settings.accounts.cursor.expired', 'Sign-in expired — run cursor-agent login on the computer running Tessel, then click Refresh usage.')
  const source = sourceLabel(props.status?.credentialSource)
  return source
    ? t('settings.accounts.cursor.signedInFrom', 'Signed in. Tessel reads the session stored in {{source}}.', { source })
    : t('settings.accounts.cursor.signedInGeneric', 'Signed in. Tessel reads the Cursor session stored on this computer.')
})
const reset = computed(() => resetText(windows.value.find((w) => Number.isFinite(w.resetsAt))?.resetsAt))
const weekly = computed(() => windows.value.some((w) => w.label === 'Weekly'))

async function read() {
  if (!window.shellApi?.providerUsage?.read) return
  try {
    const result = await window.shellApi.providerUsage.read({ provider: props.provider, accountId: null })
    if (alive && result && typeof result === 'object') usage.value = result
  } catch {
    if (alive) usage.value = { ok: false, error: t('settings.accounts.usageFailed', 'Could not read usage.') }
  }
}
async function refresh() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await read()
    emit('reload')
  } finally {
    if (alive) refreshing.value = false
  }
}
async function openLink() {
  try {
    await window.shellApi?.openExternal?.(LINKS[props.provider])
  } catch {
    /* nothing to open with */
  }
}
// The automatic usage refresh pushes this provider's readings too.
function pushed(result) {
  if (result?.provider === props.provider && (result.accountId ?? null) === null) usage.value = result
}
// Read once the sign-in is known and valid (no request for a missing login).
watch(
  () => signedIn.value && fresh.value,
  (ready) => {
    if (ready && !usage.value) read()
  },
  { immediate: true }
)
onMounted(() => {
  stopPush = window.shellApi?.providerUsage?.onUpdate?.(pushed) || null
})
onBeforeUnmount(() => {
  alive = false
  if (typeof stopPush === 'function') stopPush()
})
</script>

<template>
  <section class="usage-account" :data-provider="provider" :aria-labelledby="`usage-account-${provider}`">
    <header class="usage-account-head">
      <div>
        <h4 :id="`usage-account-${provider}`">
          <BrandIcon :kind="provider" :size="16" />{{
            provider === 'cursor' ? CURSOR : t('settings.accounts.grok.title', 'Grok (xAI)')
          }}
        </h4>
        <p class="usage-account-desc">
          {{
            provider === 'cursor'
              ? t('settings.accounts.cursor.subtitle', 'Shows your monthly Cursor plan usage from the sign-in already on this computer. Tessel only reads it — it never changes your Cursor login.')
              : t('settings.accounts.grok.subtitle', 'Shows weekly credit usage from your Grok CLI sign-in (session file ~/.grok/auth.json).')
          }}
        </p>
      </div>
      <button type="button" class="usage-link" data-test="usage-account-link" @click="openLink">
        {{
          provider === 'cursor'
            ? t('settings.accounts.cursor.dashboard', 'Cursor dashboard')
            : t('settings.accounts.grok.docs', 'Grok CLI docs')
        }}
        <span aria-hidden="true">↗</span>
      </button>
    </header>
    <div class="usage-account-card" :class="{ ready: signedIn && fresh }">
      <span class="usage-account-shield" aria-hidden="true">{{ signedIn && fresh ? '✓' : '○' }}</span>
      <div class="usage-account-body" aria-live="polite">
        <p v-if="loading && !status" class="usage-account-dim">{{ t('settings.accounts.loading', 'Loading…') }}</p>
        <template v-else-if="signedIn">
          <p class="usage-account-name" data-test="usage-account-name">
            {{ status.email || status.displayName || t('settings.accounts.status.ready', 'Signed in') }}
          </p>
          <p class="usage-account-dim" data-test="usage-account-state">{{ signedInText }}</p>
        </template>
        <template v-else>
          <p class="usage-account-name">
            {{
              provider === 'cursor'
                ? t('settings.accounts.cursor.signedOut', 'No Cursor sign-in found on this computer')
                : t('settings.accounts.grok.signedOut', 'Not signed in to Grok CLI')
            }}
          </p>
          <p class="usage-account-dim">
            {{
              provider === 'cursor'
                ? t('settings.accounts.cursor.signedOutHelp', 'Sign in with Cursor IDE, or run cursor-agent login in a terminal, then click Refresh usage here.')
                : t('settings.accounts.grok.signedOutHelp', 'In a terminal, run grok login, then click Refresh usage here.')
            }}
          </p>
        </template>
        <p v-if="status?.error" class="usage-account-error" role="alert">{{ status.error }}</p>
      </div>
      <button
        type="button"
        class="usage-btn"
        :disabled="refreshing"
        data-test="usage-account-refresh"
        @click="refresh"
      >
        {{ refreshing ? t('settings.accounts.refreshing', 'Refreshing…') : t('settings.accounts.refreshUsage', 'Refresh usage') }}
      </button>
    </div>
    <div v-if="windows.length" class="usage-account-usage" data-test="usage-account-usage">
      <p class="usage-account-title">
        {{
          provider === 'cursor'
            ? t('settings.accounts.cursor.usageTitle', 'Monthly plan usage')
            : weekly
              ? t('settings.accounts.grok.weeklyTitle', 'Weekly credits')
              : t('settings.accounts.grok.monthlyTitle', 'Monthly usage')
        }}
      </p>
      <p class="usage-account-dim">
        {{
          provider === 'cursor'
            ? t('settings.accounts.cursor.usageDescription', 'Cursor bills two pools that reset with your billing cycle, plus on-demand spend once they run out.')
            : weekly
              ? t('settings.accounts.grok.weeklyDescription', 'Same weekly credit % as the grok /usage screen in the terminal.')
              : t('settings.accounts.grok.monthlyDescription', 'Included monthly usage for Grok unified-billing accounts.')
        }}
      </p>
      <ul class="usage-account-windows">
        <li v-for="w in windows" :key="w.label">
          <span class="usage-badge">{{ Math.round(w.usedPct) }}%</span>{{ windowLabel(w.label) }}
        </li>
      </ul>
      <p v-if="reset" class="usage-account-dim">{{ reset }}</p>
      <p
        v-if="staleError"
        class="usage-account-error"
        role="alert"
        v-text="t('settings.accounts.staleUsage', 'Last known usage — the latest refresh failed: {{reason}}', { reason: staleError })"
      ></p>
    </div>
    <div v-else-if="usage?.unlimited" class="usage-account-usage">
      <p class="usage-account-dim">{{ t('settings.accounts.cursor.unlimited', 'This Cursor plan has no usage limit.') }}</p>
    </div>
    <div v-else-if="unavailable" class="usage-account-usage" data-test="usage-account-unavailable">
      <p class="usage-account-title">{{ t('settings.accounts.usage', 'Usage') }}</p>
      <p class="usage-account-dim">
        {{
          provider === 'cursor'
            ? t('settings.accounts.cursor.noAllowance', 'Cursor reported no usage allowance for this account.')
            : t('settings.accounts.grok.noPercentage', 'Grok reported no usage percentage for this account.')
        }}
      </p>
      <p class="usage-account-dim">{{ unavailable }}</p>
    </div>
  </section>
</template>

<style scoped src="./usageAccount.css"></style>
