<script setup>
// Account rows and quiet maintenance actions are inspired by Orca's MIT
// AccountsPane (Lovecast, 2026). This Vue implementation is independent.
import { computed, onBeforeUnmount, onMounted, ref, inject } from 'vue'
import ProviderAccountRow from './ProviderAccountRow.vue'
import PanelState from './ui/PanelState.vue'
import { t, intlLocale } from '../i18n'
import { applyAccountList, panesOnAccount } from '../accountChoices'
import { planInfo } from '../claudePlan'

const emit = defineEmits(['changed'])
const providers = ref([])
const loading = ref(true)
// The accounts could not be read (the list), or an action failed: each has
// its own sentence; the raw message is behind Details.
const loadError = ref('')
const error = ref('')
const retrying = ref(false)
const notice = ref('')
const busy = ref({})
const jobs = ref({})
const jobErrors = ref({})
const copied = ref('')
const removeTarget = ref(null)
const names = { claude: 'Claude Code', codex: 'Codex' } // i18n-ignore
const available = computed(() => !!window.shellApi?.accounts?.list)
// An older version's Claude account switch, waiting for the Claude sessions
// it started: the window restarts them (App's finishClaudeSwitch).
const switchPending = computed(() => providers.value.some((p) => p.provider === 'claude' && p.switchPending))
const finishClaudeSwitch = inject('finishClaudeSwitch', null)
function finishSwitch() {
  if (window.shellApi?.log) window.shellApi.log('info', 'Claude account switch: Settings button clicked')
  if (finishClaudeSwitch) finishClaudeSwitch()
  else window.dispatchEvent(new CustomEvent('tessel:finish-claude-switch'))
}
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
// The system sign-in is the same person as an added account (same address)
// and that account is the one new sessions use: one row, the added one (its
// own folder, checked). The system row comes back when that account is
// removed or another one is picked, since new sessions then use the system
// sign-in. Kept when no address is known on either side.
function systemCovered(provider) {
  const address = typeof provider.system?.email === 'string' ? provider.system.email.trim().toLowerCase() : ''
  if (!address || provider.selectedId == null) return false
  return (provider.accounts || []).some((a) => a.id === provider.selectedId && typeof a.email === 'string' && a.email.trim().toLowerCase() === address)
}
function rows(provider) {
  return [
    ...(provider.system && !systemCovered(provider)
      ? [
          {
            ...provider.system,
            id: null,
            // Named by its address when known; else its own label, or "System
            // default" (named in English by main) in the interface's language.
            label:
              provider.system.email ||
              (provider.system.label && provider.system.label !== 'System default' // i18n-ignore
                ? provider.system.label
                : t('settings.accounts.systemDefault', 'System default')),
            system: true
          }
        ]
      : []),
    ...(provider.accounts || [])
  ]
}
// A first read that failed still lists the providers, said not read, so the
// page keeps its rows (the error and Retry above them).
const shownProviders = computed(() =>
  providers.value.length || !loadError.value
    ? providers.value
    : ['claude', 'codex'].map((provider) => ({ provider, placeholder: true, accounts: [] }))
)
function selected(provider, account) {
  return provider.selectedId === account.id
}
// The row's one status line: the account new sessions use and whether it is signed in.
function current(provider) {
  const list = rows(provider)
  return list.find((account) => selected(provider, account)) || list[0] || null
}
// A Claude account's subscription as Anthropic last reported it
// (claudePlan.js), or null (not checked yet, or another provider).
function planOf(account) {
  return account && account.subscription ? planInfo(account.subscription) : null
}
// Its plan as shown: the checked one, else what its login file says.
function planText(account) {
  const info = planOf(account)
  return info ? info.plan || '' : account.plan || ''
}
function rowStatus(provider) {
  if (provider.error || provider.placeholder) return t('settings.accounts.row.readFailed', 'Accounts could not be read')
  const account = current(provider)
  if (!account) return t('settings.accounts.row.none', 'No account yet')
  const info = planOf(account)
  return t('settings.accounts.row.newSessions', 'New sessions: {{account}} · {{status}}', {
    account: accountName(account),
    // The account new sessions use has no subscription: that first.
    status: account.status === 'ready' && info?.attention ? info.warnText : statusLabel(account.status)
  })
}
function rowTone(provider) {
  if (provider.error || provider.placeholder) return 'warn'
  const account = current(provider)
  const status = account?.status
  if (status === 'ready' && planOf(account)?.attention) return 'warn'
  return status === 'ready' ? 'ok' : status === 'missing' ? 'warn' : 'dim'
}
// Open its details by themselves only when something needs the person.
function rowAttention(provider) {
  return (
    !!provider.error ||
    current(provider)?.status === 'missing' ||
    !!planOf(current(provider))?.attention ||
    jobs.value[provider.provider]?.state === 'error'
  )
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
    provider === 'claude'
      ? t('settings.accounts.updatedClaudeSessions', 'New Claude sessions will use this account; open ones keep theirs.')
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
    // The launchers' account choices follow what is shown here.
    applyAccountList(result)
    if (!alive || request !== loadRequest) return
    providers.value = (Array.isArray(result.providers) ? result.providers : []).map((provider) => {
      const previous = providers.value.find((entry) => entry.provider === provider.provider)
      // A failed read is not an empty account collection. Retain known rows
      // and disable mutations until a successful refresh clears the error.
      return provider.error && previous ? { ...previous, error: provider.error } : provider
    })
    loadError.value = ''
    error.value = ''
    mergeJobs(result.jobs)
  } catch (err) {
    if (alive && request === loadRequest)
      loadError.value = message(err, t('settings.accounts.readFailed', 'Could not read your accounts.'))
  } finally {
    if (alive && request === loadRequest) loading.value = false
  }
}
async function retry() {
  if (retrying.value) return
  retrying.value = true
  try {
    await load()
  } finally {
    if (alive) retrying.value = false
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
// Open panes on the account being removed: their session loses its sign-in.
const removeInUse = computed(() => {
  const target = removeTarget.value
  const count = target ? panesOnAccount(target.provider, target.account.id) : 0
  if (!count) return ''
  return count === 1
    ? t('settings.accounts.removeInUseOne', 'An open pane runs on this account: it stops working once the account is removed. Close it first, or let it finish.')
    : t('settings.accounts.removeInUse', '{{count}} open panes run on this account: they stop working once it is removed. Close them first, or let them finish.', { count })
})
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
          // Its subscription is checked now (its login file's plan may be old).
          if (provider === 'claude') window.shellApi.accounts?.checkPlans?.({ force: true })?.catch?.(() => {})
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
// A Claude account's subscription checked again (main's claudePlanCheck.js):
// the rows read again.
let stopPlans = null
onMounted(() => {
  load()
  try {
    stopPlans = window.shellApi?.accounts?.onPlansChanged?.(() => load()) || null
  } catch {
    stopPlans = null
  }
})
onBeforeUnmount(() => {
  alive = false
  clearTimeout(pollTimer)
  if (typeof stopPlans === 'function') stopPlans()
})
</script>

<template>
  <div class="provider-accounts" data-test="provider-accounts" :aria-busy="loading">
    <p v-if="!available" class="accounts-empty">
      {{ t('settings.accounts.unavailable', 'Account management is not available in this version.') }}
    </p>
    <!-- The first read: placeholder rows, never an empty list. -->
    <template v-else-if="loading && !providers.length">
      <p class="sr-only" role="status">{{ t('settings.accounts.reading', 'Reading accounts…') }}</p>
      <div v-for="i in 2" :key="i" class="sl-skeleton prov-skel" aria-hidden="true" data-test="accounts-skeleton">
        <span class="sl-skel-icon"></span>
        <span class="sl-skel-lines"><span></span><span></span></span>
      </div>
    </template>
    <div v-if="loadError" class="accounts-load-error" data-test="accounts-load-error">
      <PanelState kind="error" :text="t('settings.accounts.readFailed', 'Could not read your accounts.')" :busy="retrying" @retry="retry" />
      <details class="set-more accounts-raw">
        <summary>{{ t('settings.common.details', 'Details') }}</summary>
        <p>{{ loadError }}</p>
      </details>
    </div>
    <div v-if="error" class="set-callout warn accounts-callout" role="alert" data-test="accounts-action-error">
      <span class="set-callout-text">{{ t('settings.accounts.actionFailed', 'The account action could not be completed.') }}</span>
      <details class="set-more accounts-raw">
        <summary>{{ t('settings.common.details', 'Details') }}</summary>
        <p>{{ error }}</p>
      </details>
    </div>
    <p v-if="notice" class="set-callout info accounts-callout accounts-notice" role="status">
      <span class="set-callout-text">{{ notice }}</span>
    </p>
    <div v-if="switchPending" class="set-callout info accounts-callout" role="status" data-test="claude-switch-pending">
      <span class="set-callout-text">{{ t('settings.accounts.switchPending', 'Claude sessions started before the update still use the system sign-in. Restart them so each runs on its own account (conversations resumed).') }}</span>
      <button type="button" class="exit-btn small" data-test="claude-switch-finish" @click="finishSwitch">
        {{ t('settings.accounts.switchRestart', 'Restart Claude sessions') }}
      </button>
    </div>
    <ProviderAccountRow
      v-for="provider in shownProviders"
      :key="provider.provider"
      :provider="provider.provider"
      :icon="provider.provider"
      :name="names[provider.provider] || provider.provider"
      :status="rowStatus(provider)"
      :tone="rowTone(provider)"
      :attention="rowAttention(provider)"
      :has-details="!provider.placeholder"
    >
      <template #actions>
        <button
          v-if="provider.error"
          type="button"
          class="exit-btn"
          data-test="provider-retry"
          @click="load"
        >
          {{ t('settings.accounts.retry', 'Retry') }}
        </button>
        <button
          type="button"
          class="exit-btn"
          :disabled="provider.placeholder || isBusy(provider.provider)"
          data-test="account-add"
          @click="startLogin(provider.provider)"
        >
          {{ t('settings.accounts.add', 'Add account') }}
        </button>
      </template>
      <!-- A failed read: the row says so; what was wrong is behind Details. -->
      <template v-if="provider.error" #note>
        <div class="accounts-note" role="alert">
          <details class="set-more accounts-raw">
            <summary>{{ t('settings.common.details', 'Details') }}</summary>
            <p>{{ provider.error }}</p>
          </details>
        </div>
      </template>
      <template #live>
        <div
          v-if="jobs[provider.provider]"
          class="account-login"
          :data-state="jobs[provider.provider].state"
          aria-live="polite"
        >
          <template v-if="jobs[provider.provider].state === 'running'">
            <p>
              <span class="account-pulse" aria-hidden="true"></span
              ><span v-text="t('settings.accounts.waiting', 'Waiting for {{name}} sign-in…', { name: names[provider.provider] })"></span
              ><span class="account-scope">{{ t('settings.accounts.finishInBrowserShort', 'Finish in your browser; you can close Settings.') }}</span>
            </p>
            <div class="account-login-actions">
              <template v-if="safeLoginUrl(jobs[provider.provider])"
                ><button
                  type="button"
                  class="exit-btn small"
                  data-test="account-login-open"
                  @click="openLogin(jobs[provider.provider])"
                >
                  {{ t('settings.accounts.openSignIn', 'Open sign-in') }}</button
                ><button
                  type="button"
                  class="exit-btn small"
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
                class="exit-btn small"
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
          <div v-else-if="jobs[provider.provider].state === 'error'" class="accounts-job-error" role="alert">
            <span class="tag tag-warn">{{ t('settings.accounts.signInFailedShort', 'Sign-in failed') }}</span>
            <span class="account-scope">{{ t('settings.accounts.tryAgain', 'Try again with Add account or Sign in again.') }}</span>
            <details v-if="jobs[provider.provider].error" class="set-more accounts-raw">
              <summary>{{ t('settings.common.details', 'Details') }}</summary>
              <p>{{ jobs[provider.provider].error }}</p>
            </details>
          </div>
          <p v-else-if="jobs[provider.provider].state === 'cancelled'" class="account-scope">
            {{ t('settings.accounts.signInCancelled', 'Sign-in cancelled.') }}
          </p>
          <p v-else class="account-scope">{{ t('settings.accounts.signInComplete', 'Sign-in complete.') }}</p>
          <div v-if="jobErrors[provider.provider]" class="accounts-job-error" role="alert">
            <span class="tag tag-warn">{{ t('settings.accounts.progressFailedShort', 'Progress not read') }}</span>
            <details class="set-more accounts-raw">
              <summary>{{ t('settings.common.details', 'Details') }}</summary>
              <p>{{ jobErrors[provider.provider] }}</p>
            </details>
          </div>
        </div>
      </template>

      <!-- Details: the accounts to switch between. -->
      <div v-if="provider.provider === 'claude'" class="account-scope">
        <p>{{ t('settings.accounts.scopeClaudeShort', 'Each Claude session keeps the account it started with; the checked one is used for new sessions.') }}</p>
        <details class="set-more">
          <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
          <p>{{ t('settings.accounts.scopeClaudeMore', 'You can pick another one when you start a session. Conversations, settings, MCP servers and skills are shared between accounts.') }}</p>
        </details>
      </div>
      <p v-else class="account-scope">
        {{ t('settings.accounts.scopeCodexShort', 'New Codex terminals use the selected account; open ones keep theirs.') }}
      </p>
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
            <span class="account-check" aria-hidden="true"></span>
            <span class="account-info">
              <span class="account-title"
                ><span>{{ accountName(account) }}</span
                ><span v-if="account.system && account.email" class="tag tag-scope" data-test="account-system-tag">{{ t('settings.accounts.systemTag', 'System sign-in') }}</span
                ><span v-if="selected(provider, account)" class="tag tag-info">{{ t('settings.accounts.forNewSessions', 'New sessions') }}</span></span
              >
              <span class="account-meta"
                ><span v-if="account.email && account.email !== accountName(account)">{{ account.email }}</span
                ><span v-if="account.organization">{{ account.organization }}</span
                ><span v-if="planText(account)" data-test="account-plan" :title="planOf(account)?.title">{{ planText(account) }}</span
                ><span v-if="planOf(account)?.warnText" class="account-plan-warn" data-test="account-plan-warn" :title="planOf(account).title">{{ planOf(account).warnText }}</span
                ><span v-if="planOf(account)?.trialText" data-test="account-plan-trial">{{ planOf(account).trialText }}</span
                ><span class="account-status" :class="account.status">{{ statusLabel(account.status) }}</span
                ><span
                  v-if="lastLogin(account.lastLoginAt)"
                  v-text="t('settings.accounts.lastSignedIn', 'Last signed in {{date}}', { date: lastLogin(account.lastLoginAt) })"
                ></span
              ></span>
            </span>
          </button>
          <div v-if="!account.system" class="account-actions">
            <button
              type="button"
              class="exit-btn small"
              :disabled="isBusy(provider.provider)"
              data-test="account-reauth"
              :aria-label="t('settings.accounts.reauthLabel', 'Sign in again to {{account}}', { account: accountName(account) })"
              @click="startLogin(provider.provider, account.id)"
            >
              {{ t('settings.accounts.reauth', 'Sign in again') }}
            </button>
            <button
              type="button"
              class="exit-btn small danger"
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
      <!-- Added accounts keep their sign-in the way the CLI does: a readable
           file, not sealed by the OS. Said where they are managed. -->
      <div
        v-if="provider.accounts?.length"
        class="set-callout warn accounts-callout"
        role="note"
        data-test="accounts-unsealed"
      >
        <span
          class="set-callout-text"
          v-text="t('settings.accounts.unsealedShort', 'Sign-ins added here are stored unencrypted, as {{name}} keeps its own.', { name: names[provider.provider] || provider.provider })"
        ></span>
        <details class="set-more">
          <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
          <p>{{ t('settings.accounts.unsealedMore', 'They are files in your Windows user folder: anyone who can read your disk or a backup of it can use them.') }}</p>
        </details>
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
          {{ t('settings.accounts.removeDefault', 'New sessions use this account. Once it is removed, they use the system’s sign-in.') }}
        </p>
        <p v-if="removeInUse" class="account-scope account-in-use" data-test="account-remove-in-use">{{ removeInUse }}</p>
        <div class="account-confirm-actions">
          <button
            type="button"
            class="exit-btn"
            :disabled="!!busy[provider.provider]"
            data-test="account-remove-cancel"
            @click="removeTarget = null"
          >
            {{ t('settings.accounts.keep', 'Keep account') }}</button
          ><button
            type="button"
            class="exit-btn danger"
            :disabled="isBusy(provider.provider)"
            data-test="account-remove-confirm"
            @click="removeAccount"
          >
            {{ t('settings.accounts.removeAccount', 'Remove account') }}
          </button>
        </div>
      </div>
    </ProviderAccountRow>
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
.accounts-empty {
  padding: 12px 0;
  color: var(--text-dim);
  line-height: 1.5;
}
.account-scope {
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.45;
}
/* While the accounts are read: rows the size of the real ones. */
.prov-skel {
  min-height: 58px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.prov-skel:first-of-type {
  border-top: 0;
}
.accounts-load-error {
  padding-bottom: 8px;
}
.accounts-load-error :deep(.ps) {
  padding: 12px 0 4px;
}
/* A raw message, behind Details. */
.accounts-raw p {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.accounts-callout {
  margin: 10px 0 2px;
}
.accounts-callout > .exit-btn {
  flex: none;
  white-space: nowrap;
}
/* Learn more, once open, under the sentence. */
.accounts-callout > details[open] {
  flex-basis: 100%;
}
.accounts-job-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
.accounts-job-error .accounts-raw {
  flex-basis: 100%;
}
/* Accounts: a plain list, one line each, no box around each one. */
.account-rows {
  display: grid;
  gap: 2px;
}
.account-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 6px;
  padding: 6px 8px;
  margin: 0 -8px;
}
.account-row:hover {
  background: var(--surface-3);
}
.account-select {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 10px;
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
/* A radio: the selected account has a filled dot. */
.account-check {
  position: relative;
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  margin-top: 1px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
}
.selected .account-check {
  border-color: var(--accent);
}
.selected .account-check::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--accent);
}
.account-info {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.account-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--text-strong);
  font-size: 12.5px;
}
.account-title > span:first-child,
.account-meta > span {
  overflow-wrap: anywhere;
}
.account-meta {
  display: flex;
  flex-wrap: wrap;
  color: var(--text-dim);
  font-size: 11px;
}
.account-meta > span + span::before {
  content: '·';
  margin: 0 6px;
}
.account-status.missing {
  color: var(--warn);
}
/* No subscription, or a payment issue (claudePlan.js). */
.account-plan-warn {
  color: var(--warn);
  font-weight: 600;
}
.account-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.exit-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.account-select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* Confirmation and sign-in progress: a tinted strip, not a box in a box. */
.account-confirm,
.account-login {
  padding: 8px 10px;
  border-left: 2px solid var(--border-strong);
  border-radius: 0 6px 6px 0;
  background: color-mix(in srgb, var(--surface-3) 50%, transparent);
  line-height: 1.5;
}
.account-confirm {
  border-left-color: var(--danger);
}
.account-login {
  margin: 8px 0 0 28px;
}
.account-login[data-state='running'] {
  border-left-color: var(--accent);
}
.account-login p > .account-scope {
  margin-left: 8px;
}
.account-confirm .account-scope {
  margin-top: 4px;
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
.account-confirm .account-in-use {
  color: var(--warn);
}
.account-pulse {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  margin: 0 6px 1px 0;
}
@media (max-width: 520px) {
  .account-row {
    flex-wrap: wrap;
  }
  .account-actions {
    margin-left: 24px;
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
