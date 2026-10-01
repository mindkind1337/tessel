<script setup>
// Settings > AI provider accounts, after Claude Code and Codex: the providers
// whose sign-in Tessel does not manage, only reads for usage (Gemini, OpenCode
// Go, MiniMax, Grok, Cursor), in Orca's order and words (AccountsPane.tsx,
// accounts-pane-provider-setting-sections.tsx, accounts-pane-minimax-*.tsx,
// GrokAccountsSection.tsx, CursorAccountsSection.tsx; MIT, Copyright (c) 2026
// Lovecast Inc.). Keys and cookies go to the main process and stay there
// (encrypted); this page only learns whether each one is saved.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import BrandIcon from './BrandIcon.vue'
import SecretField from './SecretField.vue'
import SignInUsageSection from './SignInUsageSection.vue'
import ThemedSelect from './ui/ThemedSelect.vue'
import { t } from '../i18n'

// Product names and examples, the same in every language.
const NAMES = { opencode: 'OpenCode Go', minimax: 'MiniMax' } // i18n-ignore
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
const available = computed(() => !!window.shellApi?.providerSettings?.status)
let alive = true

const settings = computed(() => state.value?.settings || {})
const saved = computed(() => state.value?.saved || {})
const secure = computed(() => state.value?.secure !== false)
const has = (...ids) => !agents.value || ids.some((id) => agents.value.has(id))
// Orca shows every section; Tessel shows a provider when its agent is
// installed here, or when something is already set or signed in for it.
const visible = computed(() => ({
  gemini: has('gemini', 'antigravity') || !!settings.value.geminiCliOAuth,
  opencode: has('opencode') || !!(saved.value.opencodeGoApiKey || saved.value.opencodeCookie || settings.value.opencodeWorkspaceId),
  minimax: has('opencode', 'claude') || !!(saved.value.minimaxApiKey || saved.value.minimaxCookie),
  grok: has('grok') || state.value?.grok?.signedIn === true,
  cursor: has('cursor') || state.value?.cursor?.signedIn === true
}))
const minimaxConsole = computed(() =>
  settings.value.minimaxEndpoint === 'cn'
    ? 'https://platform.minimaxi.com/console/usage'
    : 'https://platform.minimax.io/console/usage'
)
const minimaxConfigured = computed(() => !!(saved.value.minimaxApiKey || saved.value.minimaxCookie))

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
    <p v-if="error" class="usage-account-error" role="alert">{{ error }}</p>

    <!-- ============ Gemini ============ -->
    <section v-if="visible.gemini" class="usage-account" data-provider="gemini" aria-labelledby="usage-account-gemini">
      <h4 id="usage-account-gemini" class="usage-account-heading"><BrandIcon kind="gemini" :size="16" />Gemini</h4>
      <p class="usage-account-desc">{{ t('settings.accounts.gemini.desc', 'Configure Gemini provider settings.') }}</p>
      <div class="usage-setting usage-switch">
        <div>
          <label class="usage-label" for="gemini-cli-oauth">{{
            t('settings.accounts.gemini.label', 'Use Gemini CLI credentials (experimental)')
          }}</label>
          <p class="usage-account-dim">
            {{ t('settings.accounts.gemini.hint', 'Extracts OAuth credentials from your local Gemini CLI installation to authenticate with Google for this computer. This uses credentials issued to the Gemini CLI app, not Tessel. May break if Google updates the CLI. Use at your own risk.') }}
          </p>
          <p class="usage-account-dim">
            {{ t('settings.accounts.gemini.offHint', 'When off, Tessel reads Gemini usage only while the Gemini CLI login is still valid, and never refreshes it.') }}
          </p>
        </div>
        <input
          id="gemini-cli-oauth"
          type="checkbox"
          role="switch"
          :checked="!!settings.geminiCliOAuth"
          :disabled="busy || loading"
          data-test="gemini-cli-oauth"
          @change="update('gemini', { geminiCliOAuth: $event.target.checked })"
        />
      </div>
      <p v-if="notice.gemini" class="usage-account-dim" role="status">{{ notice.gemini }}</p>
    </section>

    <!-- ============ OpenCode Go ============ -->
    <section v-if="visible.opencode" class="usage-account" data-provider="opencode-go" aria-labelledby="usage-account-opencode">
      <h4 id="usage-account-opencode" class="usage-account-heading"><BrandIcon kind="opencode" :size="16" />{{ NAMES.opencode }}</h4>
      <p class="usage-account-desc">{{ t('settings.accounts.opencode.desc', 'Configure OpenCode Go provider settings.') }}</p>
      <p v-if="!secure" class="usage-account-error">{{ t('settings.accounts.noSecureStorage', 'Secure credential storage is unavailable on this computer, so keys and cookies cannot be saved.') }}</p>
      <SecretField
        id="opencode-go-api-key"
        :label="t('settings.accounts.opencode.apiKey', 'OpenCode Go API key')"
        :placeholder="t('settings.accounts.opencode.apiKeyPlaceholder', 'Leave blank to use the key saved by /connect or OPENCODE_API_KEY')"
        :saved="!!saved.opencodeGoApiKey"
        :busy="busy || !secure"
        :save="saveSecret('opencode', 'opencodeGoApiKey')"
        :forget="forgetSecret('opencode', 'opencodeGoApiKey')"
      >
        <p class="usage-account-dim">{{ t('settings.accounts.opencode.apiKeyDesc', 'Optional override. Tessel otherwise uses the key OpenCode saved when you ran /connect, then OPENCODE_API_KEY.') }}</p>
        <p class="usage-account-dim">{{ t('settings.accounts.opencode.apiKeyHelp', 'Used for OpenCode Go usage in the status bar. The session cookie below is only needed for legacy console (OpenCode Black) accounts.') }}</p>
      </SecretField>
      <SecretField
        id="opencode-go-cookie"
        :label="t('settings.accounts.opencode.cookie', 'OpenCode Go session cookie')"
        :placeholder="COOKIE_EXAMPLE"
        :saved="!!saved.opencodeCookie"
        :busy="busy || !secure"
        :save="saveSecret('opencode', 'opencodeCookie')"
        :forget="forgetSecret('opencode', 'opencodeCookie')"
      >
        <p class="usage-account-dim">
          {{ t('settings.accounts.opencode.cookieHelp', 'Paste the full Cookie header from your browser’s DevTools → Network → any opencode.ai request, including __Host-console_session (e.g.') }}
          <code>{{ COOKIE_EXAMPLE }}</code>{{ t('settings.accounts.opencode.cookieHelpEnd', '). The auth cookie still covers workspace discovery; auth alone is not enough for usage.') }}
        </p>
      </SecretField>
      <div class="usage-setting">
        <label class="usage-label" for="opencode-workspace">{{ t('settings.accounts.opencode.workspace', 'Workspace ID override') }}</label>
        <p class="usage-account-dim">{{ t('settings.accounts.opencode.workspaceDesc', 'Optional workspace ID override if the automatic lookup fails.') }}</p>
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
        <p class="usage-account-dim">
          {{ t('settings.accounts.opencode.workspaceHelp', 'Find this in the URL after logging into opencode.ai (e.g.') }}
          <code>{{ WORKSPACE_EXAMPLE }}</code>).
        </p>
      </div>
      <p v-if="notice.opencode" class="usage-account-dim" role="status">{{ notice.opencode }}</p>
    </section>

    <!-- ============ MiniMax ============ -->
    <section v-if="visible.minimax" class="usage-account" data-provider="minimax" aria-labelledby="usage-account-minimax">
      <header class="usage-account-head">
        <div>
          <h4 id="usage-account-minimax"><BrandIcon kind="minimax" :label="NAMES.minimax" accent="#e2367a" :size="16" />{{ NAMES.minimax }}</h4>
          <p class="usage-account-desc">{{ t('settings.accounts.minimax.desc', 'Configure MiniMax usage tracking for your account.') }}</p>
        </div>
        <button type="button" class="usage-link" data-test="minimax-console" @click="openLink(minimaxConsole)">
          {{ t('settings.accounts.minimax.openConsole', 'Open console') }} <span aria-hidden="true">↗</span>
        </button>
      </header>
      <div class="usage-account-card" :class="{ ready: minimaxConfigured }">
        <span class="usage-account-shield" aria-hidden="true">{{ minimaxConfigured ? '✓' : '○' }}</span>
        <div class="usage-account-body">
          <p class="usage-account-name" data-test="minimax-state">
            {{ minimaxConfigured ? t('settings.accounts.minimax.stored', 'Stored locally') : t('settings.accounts.minimax.notSet', 'Credentials not set') }}
          </p>
          <p class="usage-account-dim">{{ t('settings.accounts.minimax.storage', 'Stored locally (encrypted) and sent to the selected MiniMax endpoint for usage refreshes.') }}</p>
        </div>
      </div>
      <p v-if="!secure" class="usage-account-error">{{ t('settings.accounts.noSecureStorage', 'Secure credential storage is unavailable on this computer, so keys and cookies cannot be saved.') }}</p>
      <div class="usage-setting">
        <label class="usage-label" for="minimax-endpoint">{{ t('settings.accounts.minimax.endpoint', 'MiniMax endpoint') }}</label>
        <p class="usage-account-dim">{{ t('settings.accounts.minimax.endpointDesc', 'Pick the host that matches your account. Both overseas (platform.minimax.io) and China (platform.minimaxi.com) accept either a session cookie or an API key.') }}</p>
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
      </div>
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
        <p class="usage-account-dim">{{ t('settings.accounts.minimax.cookieHelp', 'Open the selected console, sign in, then copy the Cookie request header from DevTools (Network → any remains request → Cookie).') }}</p>
        <p class="usage-account-dim">{{ t('settings.accounts.minimax.cookieExpires', 'Cookie expires when you sign out in the browser.') }}</p>
      </SecretField>
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
        <p class="usage-account-dim">{{ t('settings.accounts.minimax.apiKeyHelp', 'Copy the API key from your MiniMax console → API keys. A saved API key takes priority over the cookie; use Forget key to switch back to the cookie.') }}</p>
      </SecretField>
      <p v-if="notice.minimax" class="usage-account-dim" role="status">{{ notice.minimax }}</p>
      <div class="usage-advanced">
        <p class="usage-account-title">{{ t('settings.accounts.minimax.advanced', 'Advanced') }}</p>
        <p class="usage-account-dim">{{ t('settings.accounts.minimax.advancedDesc', 'Leave these defaults alone unless MiniMax usage refresh points at the wrong workspace or model.') }}</p>
        <div class="usage-setting">
          <label class="usage-label" for="minimax-group">{{ t('settings.accounts.minimax.group', 'Group ID override') }}</label>
          <p class="usage-account-dim">{{ t('settings.accounts.minimax.groupDesc', 'Optional. Leave blank to use minimax_group_id_v2 from the cookie.') }}</p>
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
        <div class="usage-setting">
          <label class="usage-label" for="minimax-models">{{ t('settings.accounts.minimax.models', 'Usage model names') }}</label>
          <p class="usage-account-dim">{{ t('settings.accounts.minimax.modelsDesc', 'Optional comma-separated model names. Leave as general unless MiniMax returns a model-specific error.') }}</p>
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
        </div>
      </div>
    </section>

    <!-- ============ Grok, Cursor ============ -->
    <SignInUsageSection v-if="visible.grok" provider="grok" :status="state?.grok || null" :loading="loading" @reload="load" />
    <SignInUsageSection v-if="visible.cursor" provider="cursor" :status="state?.cursor || null" :loading="loading" @reload="load" />
  </div>
</template>

<style scoped src="./usageAccount.css"></style>
<style scoped>
.usage-account-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 600;
}
</style>
