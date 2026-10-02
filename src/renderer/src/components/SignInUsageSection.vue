<script setup>
// Cursor and Grok in Settings > AI provider accounts: the sign-in already on
// this computer (read only) and its plan usage. After Orca's
// CursorAccountsSection.tsx and GrokAccountsSection.tsx (MIT, Copyright (c)
// 2026 Lovecast Inc.).
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ProviderAccountRow from './ProviderAccountRow.vue'
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
const reset = computed(() => resetText(windows.value.find((w) => Number.isFinite(w.resetsAt))?.resetsAt))
const weekly = computed(() => windows.value.some((w) => w.label === 'Weekly'))
const name = computed(() => (props.provider === 'cursor' ? CURSOR : t('settings.accounts.grok.title', 'Grok (xAI)')))
// The row's one status line: who is signed in and the first usage number.
const line = computed(() => {
  if (props.loading && !props.status) return { text: t('settings.accounts.loading', 'Loading…'), tone: 'dim' }
  if (props.status?.error) return { text: props.status.error, tone: 'error' }
  if (!signedIn.value)
    return {
      text:
        props.provider === 'cursor'
          ? t('settings.accounts.cursor.signedOut', 'No Cursor sign-in found on this computer')
          : t('settings.accounts.grok.signedOut', 'Not signed in to Grok CLI'),
      tone: 'dim'
    }
  if (!fresh.value) return { text: t('settings.accounts.row.expired', 'Sign-in expired'), tone: 'warn' }
  const who = props.status.email || props.status.displayName
  let text = who
    ? t('settings.accounts.row.signedInAs', 'Signed in as {{name}}', { name: who })
    : t('settings.accounts.status.ready', 'Signed in')
  const first = windows.value[0]
  if (first && Number.isFinite(first.usedPct))
    text += ' · ' + t('settings.accounts.row.used', '{{pct}}% used', { pct: Math.round(first.usedPct) })
  return { text, tone: 'ok' }
})
// What to do next, under the status (signed out or expired).
const help = computed(() => {
  if (props.loading && !props.status) return ''
  if (!signedIn.value)
    return props.provider === 'cursor'
      ? t('settings.accounts.cursor.signedOutShort', 'Sign in with Cursor IDE or run cursor-agent login, then Refresh usage.')
      : t('settings.accounts.grok.signedOutShort', 'Run grok login in a terminal, then Refresh usage.')
  if (!fresh.value)
    return props.provider === 'cursor'
      ? t('settings.accounts.cursor.expiredShort', 'Run cursor-agent login on this computer, then Refresh usage.')
      : t('settings.accounts.grok.expiredShort', 'Run grok on this computer (complete sign-in if asked), then Refresh usage.')
  return ''
})
const attention = computed(
  () => !!props.status?.error || (signedIn.value && !fresh.value) || !!staleError.value
)
// Where Tessel reads the sign-in from.
const sourceText = computed(() => {
  if (props.provider === 'grok') return t('settings.accounts.grok.source', 'Read from the Grok CLI session (~/.grok/auth.json).')
  const source = sourceLabel(props.status?.credentialSource)
  return source
    ? t('settings.accounts.cursor.readFrom', 'Read from {{source}}. Tessel never changes your Cursor login.', { source })
    : t('settings.accounts.cursor.readOnly', 'Tessel only reads the Cursor sign-in on this computer; it never changes it.')
})

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
  <ProviderAccountRow
    :provider="provider"
    :icon="provider"
    :name="name"
    :status="line.text"
    :tone="line.tone"
    :attention="attention"
  >
    <template #actions>
      <button
        type="button"
        class="exit-btn"
        :disabled="refreshing"
        data-test="usage-account-refresh"
        @click="refresh"
      >
        {{ refreshing ? t('settings.accounts.refreshing', 'Refreshing…') : t('settings.accounts.refreshUsage', 'Refresh usage') }}
      </button>
    </template>
    <template v-if="help" #note>
      <span data-test="usage-account-help">{{ help }}</span>
    </template>

    <!-- Details: where the sign-in is read, the usage numbers, the provider's page. -->
    <p class="usage-hint" data-test="usage-account-source">
      <span v-if="signedIn && (status?.email || status?.displayName)" class="usage-account-name" data-test="usage-account-name">{{
        status.email || status.displayName
      }}</span>
      {{ sourceText }}
    </p>
    <div v-if="windows.length" class="usage-account-usage" data-test="usage-account-usage">
      <p class="usage-label">
        {{
          provider === 'cursor'
            ? t('settings.accounts.cursor.usageTitle', 'Monthly plan usage')
            : weekly
              ? t('settings.accounts.grok.weeklyTitle', 'Weekly credits')
              : t('settings.accounts.grok.monthlyTitle', 'Monthly usage')
        }}
      </p>
      <ul class="usage-account-windows">
        <li v-for="w in windows" :key="w.label">
          <span class="usage-badge">{{ Math.round(w.usedPct) }}%</span>{{ windowLabel(w.label) }}
        </li>
      </ul>
      <p v-if="reset" class="usage-hint">{{ reset }}</p>
      <p
        v-if="staleError"
        class="usage-account-error"
        role="alert"
        v-text="t('settings.accounts.staleUsage', 'Last known usage — the latest refresh failed: {{reason}}', { reason: staleError })"
      ></p>
    </div>
    <p v-else-if="usage?.unlimited" class="usage-hint">{{ t('settings.accounts.cursor.unlimited', 'This Cursor plan has no usage limit.') }}</p>
    <div v-else-if="unavailable" class="usage-account-usage" data-test="usage-account-unavailable">
      <p class="usage-hint">
        {{
          provider === 'cursor'
            ? t('settings.accounts.cursor.noAllowance', 'Cursor reported no usage allowance for this account.')
            : t('settings.accounts.grok.noPercentage', 'Grok reported no usage percentage for this account.')
        }}
        {{ unavailable }}
      </p>
    </div>
    <div>
      <button type="button" class="usage-link" data-test="usage-account-link" @click="openLink">
        {{
          provider === 'cursor'
            ? t('settings.accounts.cursor.dashboard', 'Cursor dashboard')
            : t('settings.accounts.grok.docs', 'Grok CLI docs')
        }}
        <span aria-hidden="true">↗</span>
      </button>
    </div>
  </ProviderAccountRow>
</template>

<style scoped src="./usageAccount.css"></style>
