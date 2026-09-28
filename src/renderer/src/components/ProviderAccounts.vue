<script setup>
// Account rows and quiet maintenance actions are inspired by Orca's MIT
// AccountsPane (Lovecast, 2026). This Vue implementation is independent.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { t, intlLocale } from '../i18n'

const emit = defineEmits(['changed'])
const providers = ref([])
const loading = ref(true)
const error = ref('')
const notice = ref('')
const busy = ref({})
const jobs = ref({})
const jobErrors = ref({})
const copied = ref('')
const removeTarget = ref(null)
const names = { claude: 'Claude Code', codex: 'Codex' } // i18n-ignore
const available = computed(() => !!window.shellApi?.accounts?.list)
let alive = true
let pollTimer = null
let polling = false
let loadRequest = 0

function api() {
  return window.shellApi.accounts
}
function message(err, fallback = t('settings.accounts.actionFailed', 'The account action could not be completed.')) {
  return err?.message || (typeof err === 'string' && err) || fallback
}
function requireOK(result) {
  if (!result?.ok) throw new Error(message(result?.error))
  return result
}
function notifyChanged(provider) {
  emit('changed', provider)
  window.dispatchEvent(new CustomEvent('tessel:accounts-changed', { detail: { provider } }))
}
function rows(provider) {
  return [
    ...(provider.system
      ? [
          {
            ...provider.system,
            id: null,
            // The main process names it in English: show it in the interface's language.
            label:
              provider.system.label && provider.system.label !== 'System default' // i18n-ignore
                ? provider.system.label
                : t('settings.accounts.systemDefault', 'System default'),
            system: true
          }
        ]
      : []),
    ...(provider.accounts || [])
  ]
}
function selected(provider, account) {
  return provider.selectedId === account.id
}
function statusLabel(status) {
  if (status === 'ready') return t('settings.accounts.status.ready', 'Signed in')
  if (status === 'missing') return t('settings.accounts.status.missing', 'Sign-in needed')
  return t('settings.accounts.status.unverified', 'Not verified')
}
function accountName(account) {
  return account.label || account.email || t('settings.accounts.account', 'Account')
}
function lastLogin(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })
}
function isBusy(provider) {
  return (
    !!busy.value[provider] ||
    jobs.value[provider]?.state === 'running' ||
    !!providers.value.find((entry) => entry.provider === provider)?.error
  )
}
function switchNotice(provider, result) {
  notice.value =
    provider === 'claude' || result.restartRequired
      ? t('settings.accounts.updatedClaude', 'Account updated. Restart your Claude terminals when you are ready to use this sign-in.')
      : t('settings.accounts.updatedCodex', 'Account updated. New Codex terminals will use this selection.')
  if (result.warning) notice.value += ` ${result.warning}`
}
function mergeJobs(list) {
  for (const job of list || []) {
    if (names[job?.provider] && ['running', 'done', 'error', 'cancelled'].includes(job.state))
      jobs.value[job.provider] = job
  }
  schedulePoll()
}
async function load() {
  if (!available.value) {
    loading.value = false
    return
  }
  const request = ++loadRequest
  try {
    const result = requireOK(await api().list())
    if (!alive || request !== loadRequest) return
    providers.value = (Array.isArray(result.providers) ? result.providers : []).map((provider) => {
      const previous = providers.value.find((entry) => entry.provider === provider.provider)
      // A failed read is not an empty account collection. Retain known rows
      // and disable mutations until a successful refresh clears the error.
      return provider.error && previous ? { ...previous, error: provider.error } : provider
    })
    error.value = ''
    mergeJobs(result.jobs)
  } catch (err) {
    if (alive && request === loadRequest)
      error.value = message(err, t('settings.accounts.readFailed', 'Could not read your accounts.'))
  } finally {
    if (alive && request === loadRequest) loading.value = false
  }
}
async function changeAccount(provider, account) {
  if (isBusy(provider.provider) || selected(provider, account)) return
  busy.value[provider.provider] = true
  error.value = ''
  try {
    const result = requireOK(await api().select(provider.provider, account.id))
    if (!alive) return
    switchNotice(provider.provider, result)
    notifyChanged(provider.provider)
    await load()
  } catch (err) {
    if (alive) error.value = message(err)
  } finally {
    if (alive) busy.value[provider.provider] = false
  }
}
async function removeAccount() {
  const target = removeTarget.value
  if (!target || isBusy(target.provider)) return
  busy.value[target.provider] = true
  error.value = ''
  try {
    const result = requireOK(await api().remove(target.provider, target.account.id))
    if (!alive) return
    removeTarget.value = null
    notice.value = result.restartRequired
      ? t('settings.accounts.removedClaude', 'Account removed. Restart your Claude terminals when you are ready to use the restored sign-in.')
      : t('settings.accounts.removed', 'Account removed from Tessel.')
    if (result.warning) notice.value += ` ${result.warning}`
    notifyChanged(target.provider)
    await load()
  } catch (err) {
    if (alive) error.value = message(err)
  } finally {
    if (alive) busy.value[target.provider] = false
  }
}
function safeLoginUrl(job) {
  // The main process validates provider auth hosts. Reject non-HTTPS URLs
  // here too; never make a transcript or arbitrary CLI string clickable.
  try {
    const url = new URL(job?.url)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}
async function startLogin(provider, accountId) {
  if (isBusy(provider)) return
  busy.value[provider] = true
  error.value = ''
  jobErrors.value[provider] = ''
  copied.value = ''
  try {
    const result = requireOK(await api().startLogin(provider, accountId))
    if (!alive) return
    if (!result.job?.id) throw new Error(t('settings.accounts.noJob', 'The sign-in did not return a job. Try again.'))
    jobs.value[provider] = result.job
    schedulePoll()
  } catch (err) {
    if (alive) error.value = message(err)
  } finally {
    if (alive) busy.value[provider] = false
  }
}
function schedulePoll() {
  if (
    !alive ||
    pollTimer ||
    polling ||
    !Object.values(jobs.value).some((job) => job.state === 'running')
  )
    return
  pollTimer = setTimeout(pollJobs, 1000)
}
async function pollJobs() {
  pollTimer = null
  if (!alive) return
  polling = true
  let completed = false
  await Promise.all(
    Object.entries(jobs.value).map(async ([provider, job]) => {
      if (job.state !== 'running') return
      try {
        const result = requireOK(await api().loginStatus(job.id))
        if (
          !alive ||
          jobs.value[provider]?.id !== job.id ||
          jobs.value[provider]?.state !== 'running'
        )
          return
        if (!result.job?.state) throw new Error(t('settings.accounts.progressFailed', 'Could not read sign-in progress.'))
        jobs.value[provider] = result.job
        jobErrors.value[provider] = ''
        if (result.job.state === 'done') {
          completed = true
          notice.value = t('settings.accounts.saved', '{{name}} account saved. Select it below to use it.', { name: names[provider] })
          notifyChanged(provider)
        }
      } catch (err) {
        if (alive) jobErrors.value[provider] = message(err)
      }
    })
  )
  if (completed && alive) await load()
  polling = false
  schedulePoll()
}
async function cancelLogin(provider) {
  const job = jobs.value[provider]
  if (!job || busy.value[provider] || job.cancelling) return
  busy.value[provider] = true
  try {
    const result = requireOK(await api().cancelLogin(job.id))
    if (!alive) return
    jobs.value[provider] = result.job || { ...job, state: 'cancelled' }
    jobErrors.value[provider] = ''
  } catch (err) {
    if (alive) jobErrors.value[provider] = message(err)
  } finally {
    if (alive) busy.value[provider] = false
  }
}
async function openLogin(job) {
  const url = safeLoginUrl(job)
  if (!url) return
  try {
    const result = await window.shellApi.openExternal(url)
    if (result?.ok === false) throw new Error(message(result.error))
  } catch (err) {
    if (alive) jobErrors.value[job.provider] = message(err, t('settings.accounts.openFailed', 'Could not open the sign-in link.'))
  }
}
async function copyLogin(job) {
  const url = safeLoginUrl(job)
  if (!url) return
  try {
    if (window.shellApi.writeClipboard) await window.shellApi.writeClipboard(url)
    else await navigator.clipboard.writeText(url)
    if (alive) copied.value = job.id
  } catch (err) {
    if (alive) jobErrors.value[job.provider] = message(err, t('settings.accounts.copyFailed', 'Could not copy the sign-in link.'))
  }
}
onMounted(load)
onBeforeUnmount(() => {
  alive = false
  clearTimeout(pollTimer)
})
</script>

<template>
  <div class="provider-accounts" data-test="provider-accounts" :aria-busy="loading">
    <p class="accounts-intro">
      {{ t('settings.accounts.intro', 'Keep your usual sign-in, or add accounts for quick switching.') }}
    </p>
    <p v-if="!available" class="accounts-empty">
      {{ t('settings.accounts.unavailable', 'Account management is not available in this version.') }}
    </p>
    <p v-else-if="loading" class="accounts-empty" role="status">
      {{ t('settings.accounts.reading', 'Reading accounts…') }}
    </p>
    <div v-if="error" class="accounts-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="account-btn" data-test="accounts-retry" @click="load">
        {{ t('settings.accounts.retry', 'Retry') }}
      </button>
    </div>
    <p v-if="notice" class="accounts-notice" role="status">{{ notice }}</p>
    <section
      v-for="provider in providers"
      :key="provider.provider"
      class="account-provider"
      :data-provider="provider.provider"
      :aria-label="names[provider.provider] || provider.provider"
    >
      <header class="account-provider-head">
        <h4>
          <BrandIcon :kind="provider.provider" :size="16" />{{
            names[provider.provider] || provider.provider
          }}
        </h4>
        <button
          type="button"
          class="account-btn account-add"
          :disabled="isBusy(provider.provider)"
          data-test="account-add"
          @click="startLogin(provider.provider)"
        >
          {{ t('settings.accounts.add', 'Add account') }}
        </button>
      </header>
      <p class="account-scope">
        {{
          provider.provider === 'claude'
            ? t('settings.accounts.scopeClaude', 'Switching updates your system Claude sign-in. Restart existing Claude terminals to use the selected account.')
            : t('settings.accounts.scopeCodex', 'The selected account is used by new Codex terminals. Existing terminals keep their current account.')
        }}
      </p>
      <div v-if="provider.error" class="accounts-error" role="alert">
        <span
          v-text="t('settings.accounts.providerReadFailed', 'Could not read accounts: {{error}}', { error: provider.error })"
        ></span
        ><button type="button" class="account-btn" data-test="provider-retry" @click="load">
          {{ t('settings.accounts.retry', 'Retry') }}
        </button>
      </div>
      <div class="account-rows">
        <div
          v-for="account in rows(provider)"
          :key="account.id || 'system'"
          class="account-row"
          :class="{ selected: selected(provider, account) }"
          :data-account="account.id || 'system'"
        >
          <button
            type="button"
            class="account-select"
            :aria-label="t('settings.accounts.useFor', 'Use {{account}} for {{provider}}', { account: accountName(account), provider: names[provider.provider] || provider.provider })"
            :aria-pressed="selected(provider, account)"
            :disabled="isBusy(provider.provider)"
            @click="changeAccount(provider, account)"
          >
            <span class="account-check" aria-hidden="true">{{
              selected(provider, account) ? '✓' : ''
            }}</span>
            <span class="account-info">
              <span class="account-title"
                ><span>{{ accountName(account) }}</span
                ><span v-if="selected(provider, account)" class="account-badge">{{ t('settings.accounts.current', 'Current') }}</span></span
              >
              <span
                v-if="account.email && account.email !== accountName(account)"
                class="account-detail"
                >{{ account.email }}</span
              >
              <span class="account-meta"
                ><span v-if="account.organization">{{ account.organization }}</span
                ><span v-if="account.plan">{{ account.plan }}</span
                ><span class="account-status" :class="account.status">{{
                  statusLabel(account.status)
                }}</span></span
              >
              <span
                v-if="lastLogin(account.lastLoginAt)"
                class="account-last"
                v-text="t('settings.accounts.lastSignedIn', 'Last signed in {{date}}', { date: lastLogin(account.lastLoginAt) })"
              ></span>
            </span>
          </button>
          <div v-if="!account.system" class="account-actions">
            <button
              type="button"
              class="account-btn account-quiet"
              :disabled="isBusy(provider.provider)"
              data-test="account-reauth"
              :aria-label="t('settings.accounts.reauthLabel', 'Sign in again to {{account}}', { account: accountName(account) })"
              @click="startLogin(provider.provider, account.id)"
            >
              {{ t('settings.accounts.reauth', 'Sign in again') }}
            </button>
            <button
              type="button"
              class="account-btn account-quiet"
              :disabled="isBusy(provider.provider)"
              data-test="account-remove"
              :aria-label="t('settings.accounts.removeLabel', 'Remove {{account}}', { account: accountName(account) })"
              @click="removeTarget = { provider: provider.provider, account }"
            >
              {{ t('settings.accounts.remove', 'Remove') }}
            </button>
          </div>
        </div>
      </div>
      <div
        v-if="removeTarget?.provider === provider.provider"
        class="account-confirm"
        role="group"
        :aria-label="t('settings.accounts.confirmRemoval', 'Confirm account removal')"
      >
        <p>
          {{ t('settings.accounts.removePrefix', 'Remove') }} <strong>{{ accountName(removeTarget.account) }}</strong>
          {{
            provider.provider === 'codex'
              ? t('settings.accounts.removeCodexSuffix', 'and its local Codex history from Tessel? Your OpenAI account is kept.')
              : t('settings.accounts.removeClaudeSuffix', 'from Tessel? Your Claude account and conversation history are kept.')
          }}
        </p>
        <p v-if="provider.selectedId === removeTarget.account.id" class="account-scope">
          {{ t('settings.accounts.removeSelected', 'This account is selected. Removing it restores the system default for this provider.') }}
        </p>
        <div class="account-confirm-actions">
          <button
            type="button"
            class="account-btn"
            :disabled="!!busy[provider.provider]"
            data-test="account-remove-cancel"
            @click="removeTarget = null"
          >
            {{ t('settings.accounts.keep', 'Keep account') }}</button
          ><button
            type="button"
            class="account-btn account-danger"
            :disabled="isBusy(provider.provider)"
            data-test="account-remove-confirm"
            @click="removeAccount"
          >
            {{ t('settings.accounts.removeAccount', 'Remove account') }}
          </button>
        </div>
      </div>
      <div
        v-if="jobs[provider.provider]"
        class="account-login"
        :data-state="jobs[provider.provider].state"
        aria-live="polite"
      >
        <template v-if="jobs[provider.provider].state === 'running'">
          <p>
            <span class="account-pulse" aria-hidden="true"></span
            ><span v-text="t('settings.accounts.waiting', 'Waiting for {{name}} sign-in…', { name: names[provider.provider] })"></span>
          </p>
          <p class="account-scope">
            {{ t('settings.accounts.finishInBrowser', 'Finish signing in in your browser. You can close Settings while it completes.') }}
          </p>
          <div class="account-login-actions">
            <template v-if="safeLoginUrl(jobs[provider.provider])"
              ><button
                type="button"
                class="account-btn"
                data-test="account-login-open"
                @click="openLogin(jobs[provider.provider])"
              >
                {{ t('settings.accounts.openSignIn', 'Open sign-in') }}</button
              ><button
                type="button"
                class="account-btn"
                data-test="account-login-copy"
                @click="copyLogin(jobs[provider.provider])"
              >
                {{
                  copied === jobs[provider.provider].id
                    ? t('settings.accounts.linkCopied', 'Link copied')
                    : t('settings.accounts.copyLink', 'Copy link')
                }}
              </button></template
            >
            <button
              type="button"
              class="account-btn account-quiet"
              :disabled="!!busy[provider.provider] || jobs[provider.provider].cancelling"
              data-test="account-login-cancel"
              @click="cancelLogin(provider.provider)"
            >
              {{
                jobs[provider.provider].cancelling
                  ? t('settings.accounts.cancelling', 'Cancelling…')
                  : t('settings.accounts.cancelSignIn', 'Cancel sign-in')
              }}
            </button>
          </div>
        </template>
        <p
          v-else-if="jobs[provider.provider].state === 'error'"
          class="accounts-error"
          role="alert"
        >
          {{ jobs[provider.provider].error || t('settings.accounts.signInFailed', 'Sign-in failed. Try again.') }}
        </p>
        <p v-else-if="jobs[provider.provider].state === 'cancelled'" class="account-scope">
          {{ t('settings.accounts.signInCancelled', 'Sign-in cancelled.') }}
        </p>
        <p v-else class="account-scope">{{ t('settings.accounts.signInComplete', 'Sign-in complete.') }}</p>
        <p v-if="jobErrors[provider.provider]" class="accounts-error" role="alert">
          {{ jobErrors[provider.provider] }}
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.provider-accounts {
  min-width: 0;
  color: var(--text);
  font-size: 12px;
}
.provider-accounts p {
  margin: 0;
}
.accounts-intro,
.accounts-empty {
  color: var(--text-dim);
  line-height: 1.5;
}
.accounts-empty {
  padding: 12px 0;
}
.account-provider {
  margin-top: 16px;
}
.account-provider + .account-provider {
  border-top: 1px solid var(--border);
  padding-top: 16px;
}
.account-provider-head,
.account-provider-head h4 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.account-provider-head {
  justify-content: space-between;
  flex-wrap: wrap;
}
.account-provider-head h4 {
  margin: 0;
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 600;
}
.account-scope {
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.5;
}
.account-provider > .account-scope {
  margin: 6px 0 10px;
}
.account-rows {
  display: grid;
  gap: 5px;
}
.account-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
}
.account-row.selected {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}
.account-select {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 8px;
  align-items: flex-start;
  text-align: left;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.account-select:disabled {
  cursor: default;
}
.account-check {
  width: 15px;
  height: 15px;
  flex: 0 0 15px;
  margin-top: 1px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  font-size: 10px;
  display: grid;
  place-items: center;
  color: var(--accent);
}
.selected .account-check {
  border-color: var(--accent);
}
.account-info {
  display: grid;
  min-width: 0;
  gap: 3px;
}
.account-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--text-strong);
}
.account-title > span:first-child,
.account-detail,
.account-meta > span {
  overflow-wrap: anywhere;
}
.account-badge {
  color: var(--accent);
  font-size: 10px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border-radius: 3px;
  padding: 1px 4px;
}
.account-detail,
.account-meta,
.account-last {
  color: var(--text-dim);
  font-size: 11px;
}
.account-meta {
  display: flex;
  gap: 5px 10px;
  flex-wrap: wrap;
}
.account-status.missing {
  color: var(--warn);
}
.account-actions {
  display: flex;
  gap: 3px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.account-btn {
  min-height: 26px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  color: var(--text);
  background: var(--surface-2);
  font: inherit;
  font-size: 11px;
  padding: 4px 8px;
  cursor: pointer;
}
.account-btn:hover:not(:disabled) {
  color: var(--text-strong);
  background: var(--surface-3);
}
.account-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.account-btn:focus-visible,
.account-select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.account-quiet {
  border-color: transparent;
  background: transparent;
  color: var(--text-dim);
}
.account-danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
}
.account-confirm,
.account-login {
  margin-top: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  line-height: 1.5;
}
.account-confirm-actions,
.account-login-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.account-confirm-actions {
  justify-content: flex-end;
}
.account-confirm .account-scope,
.account-login .account-scope {
  margin-top: 4px;
}
.accounts-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--danger);
  overflow-wrap: anywhere;
}
.provider-accounts > .accounts-error,
.accounts-notice {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  line-height: 1.5;
}
.accounts-notice {
  color: var(--text-dim);
}
.account-pulse {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  margin: 0 5px 1px 0;
}
@media (max-width: 520px) {
  .account-row {
    flex-wrap: wrap;
  }
  .account-actions {
    margin-left: 23px;
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
