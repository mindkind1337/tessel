<script setup>
// Settings > AI provider accounts, after Claude Code and Codex: the providers
// whose sign-in Tessel does not manage, only reads for usage (Gemini, OpenCode
// Go, MiniMax, Grok, Cursor), in Orca's order (AccountsPane.tsx and its
// provider sections; MIT, Copyright (c) 2026 Lovecast Inc.). One row each,
// its keys and options folded under Configure. Keys and cookies go to the
// main process and stay there (encrypted); this page only learns whether each
// one is saved.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ProviderAccountRow from './ProviderAccountRow.vue'
import SecretField from './SecretField.vue'
import SignInUsageSection from './SignInUsageSection.vue'
import ThemedSelect from './ui/ThemedSelect.vue'
import { t } from '../i18n'

// Product names and examples, the same in every language.
const NAMES = { gemini: 'Gemini', opencode: 'OpenCode Go', minimax: 'MiniMax', grok: 'Grok', cursor: 'Cursor' } // i18n-ignore
const ORDER = ['gemini', 'opencode', 'minimax', 'grok', 'cursor']
const COOKIE_EXAMPLE = 'auth=…; __Host-console_session=…' // i18n-ignore
const WORKSPACE_EXAMPLE = 'opencode.ai/workspace/wrk_…/go' // i18n-ignore
const DEFAULT_MODEL = 'general' // i18n-ignore
const state = ref(null)
const agents = ref(null) // installed agent ids, null when unknown
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const notice = ref({}) // section -> message
const drafts = ref({ opencodeWorkspaceId: '', minimaxGroupId: '', minimaxUsageModels: '' })
const cookieHelp = ref(false)
const advanced = ref(false)
const revealed = ref(new Set()) // hidden providers shown on request
const available = computed(() => !!window.shellApi?.providerSettings?.status)
let alive = true

const settings = computed(() => state.value?.settings || {})
const saved = computed(() => state.value?.saved || {})
const secure = computed(() => state.value?.secure !== false)
// The saved file is readable as it is (not Tessel's sealed form): warned where
// the keys are managed (after Orca's UnsealedCredentialNotice, MIT, Lovecast Inc. 2026).
const unsealed = computed(() => state.value?.protection === 'plaintext')
const has = (...ids) => !agents.value || ids.some((id) => agents.value.has(id))
// Orca shows every section; Tessel shows a provider when its agent is
// installed here, or when something is already set or signed in for it.
// The others are named on one quiet line at the end, and can be shown.
const relevant = computed(() => ({
  gemini: has('gemini', 'antigravity') || !!settings.value.geminiCliOAuth || state.value?.gemini?.signedIn === true,
  opencode: has('opencode') || !!(saved.value.opencodeGoApiKey || saved.value.opencodeCookie || settings.value.opencodeWorkspaceId),
  minimax: has('opencode', 'claude') || !!(saved.value.minimaxApiKey || saved.value.minimaxCookie),
  grok: has('grok') || state.value?.grok?.signedIn === true,
  cursor: has('cursor') || state.value?.cursor?.signedIn === true
}))
const visible = computed(() =>
  Object.fromEntries(ORDER.map((id) => [id, relevant.value[id] || revealed.value.has(id)]))
)
const notInstalled = computed(() => (loading.value ? [] : ORDER.filter((id) => !visible.value[id])))
function reveal(id) {
  revealed.value = new Set([...revealed.value, id])
}
const minimaxConsole = computed(() =>
  settings.value.minimaxEndpoint === 'cn'
    ? 'https://platform.minimaxi.com/console/usage'
    : 'https://platform.minimax.io/console/usage'
)

// ---- One status line per row ----
const gemini = computed(() => state.value?.gemini || null)
// Expired, and nothing will refresh it: Gemini and Antigravity usage stop.
const geminiStuck = computed(
  () =>
    gemini.value?.signedIn === true &&
    !gemini.value.tokenFresh &&
    !(settings.value.geminiCliOAuth && gemini.value.refreshable)
)
const geminiStatus = computed(() => {
  if (loading.value && !state.value) return { text: t('settings.accounts.loading', 'Loading…'), tone: 'dim' }
  const g = gemini.value
  if (!g) return { text: t('settings.accounts.gemini.readsCli', 'Reads the Gemini CLI sign-in'), tone: 'dim' }
  if (g.error) return { text: g.error, tone: 'error' }
  if (!g.signedIn) return { text: t('settings.accounts.gemini.signedOut', 'Not signed in — run gemini to sign in'), tone: 'dim' }
  if (geminiStuck.value) return { text: t('settings.accounts.row.expired', 'Sign-in expired'), tone: 'warn' }
  const who = g.email
    ? t('settings.accounts.row.signedInAs', 'Signed in as {{name}}', { name: g.email })
    : t('settings.accounts.status.ready', 'Signed in')
  return g.tokenFresh
    ? { text: who, tone: 'ok' }
    : { text: t('settings.accounts.gemini.refreshed', '{{who}} · renewed with the Gemini CLI credentials', { who }), tone: 'ok' }
})
const opencodeStatus = computed(() => {
  const key = !!saved.value.opencodeGoApiKey
  const cookie = !!saved.value.opencodeCookie
  if (key && cookie) return { text: t('settings.accounts.row.keyAndCookie', 'API key and session cookie saved'), tone: 'ok' }
  if (key) return { text: t('settings.accounts.row.keySaved', 'API key saved'), tone: 'ok' }
  if (cookie) return { text: t('settings.accounts.row.cookieSaved', 'Session cookie saved'), tone: 'ok' }
  return { text: t('settings.accounts.opencode.usesConnect', 'Uses the key OpenCode saved with /connect'), tone: 'dim' }
})
const minimaxStatus = computed(() => {
  const key = !!saved.value.minimaxApiKey
  const cookie = !!saved.value.minimaxCookie
  const where =
    settings.value.minimaxEndpoint === 'cn'
      ? t('settings.accounts.minimax.chinaShort', 'China')
      : t('settings.accounts.minimax.overseasShort', 'Overseas')
  if (!key && !cookie) return { text: t('settings.accounts.row.notSetUp', 'Not set up'), tone: 'dim' }
  const what = key && cookie
    ? t('settings.accounts.row.keyAndCookie', 'API key and session cookie saved')
    : key
      ? t('settings.accounts.row.keySaved', 'API key saved')
      : t('settings.accounts.row.cookieSaved', 'Session cookie saved')
  return { text: `${what} · ${where}`, tone: 'ok' }
})

function message(result, fallback) {
  return (typeof result?.error === 'string' && result.error) || fallback
}
function apply(result) {
  if (!result?.ok) return false
  state.value = { ...(state.value || {}), ...result }
  for (const key of Object.keys(drafts.value)) drafts.value[key] = result.settings?.[key] ?? ''
  return true
}
async function load() {
  if (!available.value) {
    loading.value = false
    return
  }
  try {
    const result = await window.shellApi.providerSettings.status()
    if (!alive) return
    if (!apply(result)) error.value = message(result, t('settings.accounts.providerSettingsFailed', 'Could not read the provider settings.'))
    else error.value = ''
  } catch {
    if (alive) error.value = t('settings.accounts.providerSettingsFailed', 'Could not read the provider settings.')
  } finally {
    if (alive) loading.value = false
  }
}
async function loadAgents() {
  try {
    const list = await window.shellApi?.listAgents?.()
    if (alive && Array.isArray(list)) agents.value = new Set(list.filter((a) => a?.available).map((a) => a.id))
  } catch {
    /* unknown: every section is shown */
  }
}
async function run(section, action, success) {
  if (busy.value) return false
  busy.value = true
  notice.value = { ...notice.value, [section]: '' }
  try {
    const result = await action()
    if (!alive) return false
    if (!apply(result)) {
      notice.value = { ...notice.value, [section]: message(result, t('settings.accounts.settingFailed', 'The setting could not be saved.')) }
      return false
    }
    if (success) notice.value = { ...notice.value, [section]: success }
    return true
  } catch {
    if (alive) notice.value = { ...notice.value, [section]: t('settings.accounts.settingFailed', 'The setting could not be saved.') }
    return false
  } finally {
    if (alive) busy.value = false
  }
}
const saveSecret = (section, name, success) => (value) =>
  run(section, () => window.shellApi.providerSettings.saveSecret(name, value), success)
const forgetSecret = (section, name) => () => run(section, () => window.shellApi.providerSettings.clearSecret(name))
function update(section, patch) {
  return run(section, () => window.shellApi.providerSettings.update(patch))
}
function commitText(section, key) {
  const value = String(drafts.value[key] ?? '').trim()
  if (value === (settings.value[key] ?? '')) return
  update(section, { [key]: value })
}
function clearText(section, key) {
  drafts.value[key] = ''
  commitText(section, key)
}
async function openLink(url) {
  try {
    await window.shellApi?.openExternal?.(url)
  } catch {
    /* nothing to open with */
  }
}
// Another window part changed an account: the sign-ins may have too.
const accountsChanged = () => load()
onMounted(() => {
  load()
  loadAgents()
  window.addEventListener('tessel:accounts-changed', accountsChanged)
})
onBeforeUnmount(() => {
  alive = false
  window.removeEventListener('tessel:accounts-changed', accountsChanged)
})
</script>

<template>
  <div v-if="available" class="provider-usage-accounts" data-test="provider-usage-accounts">
    <p v-if="error" class="usage-account-error usage-banner" role="alert">{{ error }}</p>

    <!-- ============ Gemini ============ -->
    <ProviderAccountRow
      v-if="visible.gemini"
      provider="gemini"
      icon="gemini"
      :name="NAMES.gemini"
      :status="geminiStatus.text"
      :tone="geminiStatus.tone"
      :attention="geminiStuck"
      toggle="configure"
    >
      <template v-if="geminiStuck" #note>
        <span data-test="gemini-expired-help">{{
          settings.geminiCliOAuth
            ? t('settings.accounts.gemini.expiredRun', 'Gemini and Antigravity usage can’t be read. Run gemini to sign in again.')
            : t('settings.accounts.gemini.expiredHelp', 'Gemini and Antigravity usage can’t be read. Turn on “Use Gemini CLI credentials” below, or run gemini to sign in again.')
        }}</span>
      </template>
      <label class="usage-field usage-switch">
        <span class="usage-field-text">
          <span class="usage-label">{{ t('settings.accounts.gemini.label', 'Use Gemini CLI credentials (experimental)') }}</span>
          <span class="usage-hint">{{
            t('settings.accounts.gemini.hintShort', 'Renews an expired Gemini CLI login with the CLI’s own credentials (issued to Gemini CLI, not Tessel). Off: usage is read only while the login is valid. May break if Google changes the CLI.')
          }}</span>
        </span>
        <input
          id="gemini-cli-oauth"
          type="checkbox"
          class="set-switch"
          :checked="!!settings.geminiCliOAuth"
          :disabled="busy || loading"
          data-test="gemini-cli-oauth"
          @change="update('gemini', { geminiCliOAuth: $event.target.checked })"
        />
      </label>
      <p v-if="notice.gemini" class="usage-hint" role="status">{{ notice.gemini }}</p>
    </ProviderAccountRow>

    <!-- ============ OpenCode Go ============ -->
    <ProviderAccountRow
      v-if="visible.opencode"
      provider="opencode-go"
      icon="opencode"
      :name="NAMES.opencode"
      :status="opencodeStatus.text"
      :tone="opencodeStatus.tone"
      toggle="configure"
    >
      <p v-if="!secure" class="usage-account-error">{{ t('settings.accounts.noSecureStorage', 'Secure credential storage is unavailable on this computer, so keys and cookies cannot be saved.') }}</p>
      <p v-if="unsealed" class="usage-account-error" role="alert" data-test="credentials-unsealed">{{ t('settings.accounts.unsealed', 'Your saved keys and cookies are stored unencrypted: anyone who can read your disk or a backup of it can read them. Save them again to encrypt them.') }}</p>
      <SecretField
        id="opencode-go-api-key"
        :label="t('settings.accounts.opencode.apiKey', 'OpenCode Go API key')"
        :placeholder="t('settings.accounts.opencode.apiKeyPlaceholderShort', 'Optional — blank uses /connect or OPENCODE_API_KEY')"
        :saved="!!saved.opencodeGoApiKey"
        :busy="busy || !secure"
        :save="saveSecret('opencode', 'opencodeGoApiKey')"
        :forget="forgetSecret('opencode', 'opencodeGoApiKey')"
      />
      <SecretField
        id="opencode-go-cookie"
        :label="t('settings.accounts.opencode.cookie', 'OpenCode Go session cookie')"
        :placeholder="COOKIE_EXAMPLE"
        :saved="!!saved.opencodeCookie"
        :busy="busy || !secure"
        :save="saveSecret('opencode', 'opencodeCookie')"
        :forget="forgetSecret('opencode', 'opencodeCookie')"
      >
        <p class="usage-hint">
          {{ t('settings.accounts.opencode.cookieHelpShort', 'Only for legacy console (OpenCode Black) accounts: the full Cookie header of an opencode.ai request in DevTools, with __Host-console_session.') }}
        </p>
      </SecretField>
      <div class="usage-field">
        <label class="usage-label" for="opencode-workspace">{{ t('settings.accounts.opencode.workspace', 'Workspace ID override') }}</label>
        <div class="usage-row">
          <input
            id="opencode-workspace"
            v-model="drafts.opencodeWorkspaceId"
            class="usage-input"
            type="text"
            spellcheck="false"
            :disabled="busy"
            :placeholder="t('settings.accounts.opencode.workspacePlaceholder', 'wrk_… (leave blank for automatic lookup)')"
            data-test="opencode-workspace"
            @change="commitText('opencode', 'opencodeWorkspaceId')"
            @keydown.enter.prevent="commitText('opencode', 'opencodeWorkspaceId')"
          />
          <button
            v-if="settings.opencodeWorkspaceId"
            type="button"
            class="usage-btn quiet"
            :disabled="busy"
            @click="clearText('opencode', 'opencodeWorkspaceId')"
          >
            {{ t('settings.accounts.clear', 'Clear') }}
          </button>
        </div>
        <p class="usage-hint">
          {{ t('settings.accounts.opencode.workspaceHelpShort', 'Only if the automatic lookup fails. It is in the opencode.ai URL:') }}
          <code>{{ WORKSPACE_EXAMPLE }}</code>
        </p>
      </div>
      <p v-if="notice.opencode" class="usage-hint" role="status">{{ notice.opencode }}</p>
    </ProviderAccountRow>

    <!-- ============ MiniMax ============ -->
    <ProviderAccountRow
      v-if="visible.minimax"
      provider="minimax"
      icon="minimax"
      :icon-label="NAMES.minimax"
      icon-accent="#e2367a"
      :name="NAMES.minimax"
      :status="minimaxStatus.text"
      :tone="minimaxStatus.tone"
      toggle="configure"
    >
      <template #actions>
        <button type="button" class="exit-btn" data-test="minimax-console" @click="openLink(minimaxConsole)">
          {{ t('settings.accounts.minimax.openConsole', 'Open console') }} <span aria-hidden="true">↗</span>
        </button>
      </template>
      <p v-if="!secure" class="usage-account-error">{{ t('settings.accounts.noSecureStorage', 'Secure credential storage is unavailable on this computer, so keys and cookies cannot be saved.') }}</p>
      <p v-if="unsealed" class="usage-account-error" role="alert" data-test="credentials-unsealed">{{ t('settings.accounts.unsealed', 'Your saved keys and cookies are stored unencrypted: anyone who can read your disk or a backup of it can read them. Save them again to encrypt them.') }}</p>
      <div class="usage-field">
        <label class="usage-label" for="minimax-endpoint">{{ t('settings.accounts.minimax.endpoint', 'MiniMax endpoint') }}</label>
        <ThemedSelect
          id="minimax-endpoint"
          class="usage-input"
          :model-value="settings.minimaxEndpoint || 'overseas'"
          :disabled="busy"
          data-test="minimax-endpoint"
          @update:model-value="(value) => value !== settings.minimaxEndpoint && update('minimax', { minimaxEndpoint: value })"
        >
          <option value="overseas">{{ t('settings.accounts.minimax.overseas', 'Overseas (platform.minimax.io)') }}</option>
          <option value="cn">{{ t('settings.accounts.minimax.china', 'China (platform.minimaxi.com)') }}</option>
        </ThemedSelect>
        <p class="usage-hint">{{ t('settings.accounts.minimax.endpointShort', 'The host that matches your account.') }}</p>
      </div>
      <SecretField
        id="minimax-api-key"
        :label="t('settings.accounts.minimax.apiKey', 'MiniMax API key')"
        :placeholder="t('settings.accounts.minimax.apiKeyPlaceholder', 'Paste your MiniMax API key')"
        :saved="!!saved.minimaxApiKey"
        :busy="busy || !secure"
        :forget-label="t('settings.accounts.minimax.forgetKey', 'Forget key')"
        :save="saveSecret('minimax', 'minimaxApiKey', t('settings.accounts.minimax.apiKeySaved', 'MiniMax API key saved.'))"
        :forget="forgetSecret('minimax', 'minimaxApiKey')"
      >
        <p class="usage-hint">{{ t('settings.accounts.minimax.apiKeyHelpShort', 'From your MiniMax console → API keys. Used before the cookie.') }}</p>
      </SecretField>
      <SecretField
        id="minimax-cookie"
        :label="t('settings.accounts.minimax.cookie', 'MiniMax session cookie')"
        :placeholder="t('settings.accounts.minimax.cookiePlaceholder', 'Paste the Cookie header from DevTools')"
        :saved="!!saved.minimaxCookie"
        :busy="busy || !secure"
        :forget-label="t('settings.accounts.minimax.forgetCookie', 'Forget cookie')"
        :save="saveSecret('minimax', 'minimaxCookie', t('settings.accounts.minimax.cookieSaved', 'MiniMax cookie saved.'))"
        :forget="forgetSecret('minimax', 'minimaxCookie')"
      >
        <template #help>
          <button
            type="button"
            class="usage-link"
            :aria-expanded="cookieHelp"
            data-test="minimax-cookie-help"
            @click="cookieHelp = !cookieHelp"
          >
            {{ t('settings.accounts.minimax.howToCopy', 'How to copy') }}
          </button>
        </template>
        <ol v-if="cookieHelp" class="usage-steps">
          <li v-text="t('settings.accounts.minimax.step1', 'Open {{url}} in your browser and sign in.', { url: minimaxConsole })"></li>
          <li>{{ t('settings.accounts.minimax.step2', 'Open DevTools.') }}</li>
          <li>{{ t('settings.accounts.minimax.step3', 'Go to the Network tab and enable Preserve log.') }}</li>
          <li>{{ t('settings.accounts.minimax.step4', 'Reload the page.') }}</li>
          <li>{{ t('settings.accounts.minimax.step5', 'Filter for remains and select the coding_plan/remains request.') }}</li>
          <li>{{ t('settings.accounts.minimax.step6', 'Under Request Headers, copy the Cookie value.') }}</li>
          <li>{{ t('settings.accounts.minimax.step7', 'Paste it here and click Save.') }}</li>
        </ol>
        <p class="usage-hint">{{ t('settings.accounts.minimax.cookieExpires', 'Cookie expires when you sign out in the browser.') }}</p>
      </SecretField>
      <p v-if="notice.minimax" class="usage-hint" role="status">{{ notice.minimax }}</p>
      <div class="usage-advanced">
        <button
          type="button"
          class="usage-link"
          :aria-expanded="advanced"
          aria-controls="minimax-advanced"
          data-test="minimax-advanced"
          @click="advanced = !advanced"
        >
          {{ t('settings.accounts.minimax.advancedOptions', 'Advanced options') }}
        </button>
        <div v-show="advanced" id="minimax-advanced" class="usage-advanced-body">
          <p class="usage-hint">{{ t('settings.accounts.minimax.advancedShort', 'Change these only if usage points at the wrong group or model.') }}</p>
          <div class="usage-field">
            <label class="usage-label" for="minimax-group">{{ t('settings.accounts.minimax.group', 'Group ID override') }}</label>
            <input
              id="minimax-group"
              v-model="drafts.minimaxGroupId"
              class="usage-input"
              type="text"
              spellcheck="false"
              :disabled="busy"
              :placeholder="t('settings.accounts.minimax.groupPlaceholder', 'Use group ID from cookie')"
              data-test="minimax-group"
              @change="commitText('minimax', 'minimaxGroupId')"
              @keydown.enter.prevent="commitText('minimax', 'minimaxGroupId')"
            />
          </div>
          <div class="usage-field">
            <label class="usage-label" for="minimax-models">{{ t('settings.accounts.minimax.models', 'Usage model names') }}</label>
            <input
              id="minimax-models"
              v-model="drafts.minimaxUsageModels"
              class="usage-input"
              type="text"
              spellcheck="false"
              :disabled="busy"
              :placeholder="DEFAULT_MODEL"
              data-test="minimax-models"
              @change="commitText('minimax', 'minimaxUsageModels')"
              @keydown.enter.prevent="commitText('minimax', 'minimaxUsageModels')"
            />
            <p class="usage-hint">{{ t('settings.accounts.minimax.modelsShort', 'Comma-separated.') }}</p>
          </div>
        </div>
      </div>
    </ProviderAccountRow>

    <!-- ============ Grok, Cursor ============ -->
    <SignInUsageSection v-if="visible.grok" provider="grok" :status="state?.grok || null" :loading="loading" @reload="load" />
    <SignInUsageSection v-if="visible.cursor" provider="cursor" :status="state?.cursor || null" :loading="loading" @reload="load" />

    <!-- Not installed, nothing saved: one quiet line, each name shows its row. -->
    <p v-if="notInstalled.length" class="usage-hidden" data-test="providers-not-installed">
      {{ t('settings.accounts.notInstalled', 'Not installed:') }}
      <template v-for="(id, i) in notInstalled" :key="id"
        >{{ i ? ', ' : '' }}<button
          type="button"
          class="usage-link"
          :title="t('settings.accounts.showProvider', 'Show {{name}}', { name: NAMES[id] })"
          :data-test="`reveal-${id}`"
          @click="reveal(id)"
        >{{ NAMES[id] }}</button></template
      >
    </p>
  </div>
</template>

<style scoped src="./usageAccount.css"></style>
