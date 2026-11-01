<script setup>
// Settings > Tessel account: the optional account on tesselcode.com (main's
// tesselAccount.js). Logging in, creating an account and a forgotten password all
// happen on a web page in the person's browser, so no password ever reaches this page.
// A token does not either: only who is signed in.
import { ref, watch, inject, onBeforeUnmount } from 'vue'
import { CircleUser, Laptop, Mail } from 'lucide-vue-next'
import { t } from '../../i18n'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { shown } = useSettingsShell()
const askConfirm = inject('askConfirm', null)

const POLL_MS = 1500
const state = ref(null) // { signedIn, user, signingIn, offline, error }
const busy = ref(false)
const notice = ref('')
const missing = ref(false) // the page is newer than the background code
let timer = null
let left = false

const api = () => window.shellApi?.tesselAccount

const errorText = (code) =>
  ({
    denied: () => t('settings.tesselAccount.error.denied', 'The sign-in was refused. Nothing changed.'),
    accountExists: () => t('settings.tesselAccount.error.accountExists', 'An account already uses this address. Log in another way: with Google, or with your password. If you have none, use "Forgot password" on the log-in page.'),
    expired: () => t('settings.tesselAccount.error.expired', 'The sign-in took too long. Try again.'),
    offline: () => t('settings.tesselAccount.error.offline', 'Tessel could not reach its server. Check your connection and try again.'),
    refused: () => t('settings.tesselAccount.error.refused', 'The server refused this sign-in. Try again.'),
    noSecureStorage: () => t('settings.tesselAccount.error.noSecureStorage', 'Secure storage is not available on this computer, so Tessel cannot keep you signed in.'),
    rateLimited: () => t('settings.tesselAccount.error.rateLimited', 'Too many tries. Wait a minute, then try again.'),
    signedOut: () => t('settings.tesselAccount.error.signedOut', 'Your session ended. Sign in again.'),
    failed: () => t('settings.tesselAccount.error.failed', 'That did not work. Try again.')
  }[code] || (() => ''))()

function stopPolling() {
  clearTimeout(timer)
  timer = null
}

function follow() {
  stopPolling()
  if (left || !state.value?.signingIn) return
  timer = setTimeout(async () => {
    try {
      state.value = await api().status()
    } catch {
      /* the next look */
    }
    follow()
  }, POLL_MS)
}

async function refresh(check) {
  if (!api()) {
    missing.value = true
    return
  }
  try {
    state.value = await api().status({ check })
    follow()
  } catch {
    /* shown as it was */
  }
}

async function act(run) {
  busy.value = true
  notice.value = ''
  try {
    const res = await run()
    state.value = res
    follow()
    return res
  } catch {
    state.value = { ...(state.value || {}), error: 'failed' }
    return null
  } finally {
    busy.value = false
  }
}

const signIn = () => act(() => api().signIn())
const cancel = () => act(() => api().cancel())
const signOut = () => act(() => api().signOut())

async function sendPasswordLink() {
  const res = await act(() => api().passwordLink())
  if (res?.done === 'linkSent') notice.value = t('settings.tesselAccount.linkSent', 'The email is on its way. Its link works for 30 minutes.')
}

async function removeAccount() {
  const message = {
    title: t('settings.tesselAccount.deleteConfirm', 'Delete your Tessel account?'),
    detail: t('settings.tesselAccount.deleteDetail', 'Your email address and name are erased from the server and you are signed out. This cannot be undone. Your settings, projects and Google connections on this computer are not touched.'),
    confirmLabel: t('settings.tesselAccount.delete', 'Delete my account'),
    danger: true
  }
  const ok = askConfirm ? await askConfirm(message) : window.confirm(message.title)
  if (!ok) return
  const res = await act(() => api().delete())
  if (res?.deleted) notice.value = t('settings.tesselAccount.deleted', 'Your account was deleted.')
}

const openPrivacy = () => window.shellApi?.openExternal?.('https://tesselcode.com/privacy')

// Asks the server only when the page opens, not while Settings stays in the background.
watch(
  () => shown('tessel-account'),
  (open) => {
    if (open) refresh(true)
    else stopPolling()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  left = true
  stopPolling()
})
</script>

<template>
  <section id="set-tessel-account" class="set-page" data-page="tessel-account" :hidden="!shown('tessel-account')" aria-labelledby="set-tessel-account-title">
    <header class="set-page-head">
      <h2 id="set-tessel-account-title">{{ PAGES['tessel-account'].title }}</h2>
      <p class="set-page-desc">{{ PAGES['tessel-account'].desc }}</p>
    </header>
    <div class="set-group">
      <div v-if="missing" class="set-callout warn" role="status">
        <span class="set-callout-text">{{ t('settings.tesselAccount.needsRestart', 'Restart Tessel to finish installing this page.') }}</span>
      </div>

      <div v-else class="set-card set-card-pad tessel-account-card">
        <div class="tessel-account-head">
          <span class="tessel-account-avatar"><CircleUser :size="22" aria-hidden="true" /></span>
          <template v-if="state && state.signedIn">
            <div class="tessel-account-title">
              <strong>{{ state.user.name || state.user.email }}</strong>
              <span class="set-hint tessel-account-who">{{ state.user.email }}</span>
              <span v-if="state.offline" class="set-hint">{{ t('settings.tesselAccount.offline', 'Tessel cannot reach its server right now. You stay signed in.') }}</span>
            </div>
            <button type="button" class="exit-btn tessel-account-out" :disabled="busy" @click="signOut">{{ t('settings.tesselAccount.signOut', 'Sign out') }}</button>
          </template>
          <template v-else-if="state && state.signingIn">
            <div class="tessel-account-title" role="status">
              <strong>{{ t('settings.tesselAccount.waiting', 'Finish signing in in your browser') }}</strong>
              <span class="set-hint">{{ t('settings.tesselAccount.waitingHint', 'A page opened in your browser. This page updates by itself.') }}</span>
            </div>
            <button type="button" class="exit-btn tessel-account-cancel" :disabled="busy" @click="cancel">{{ t('settings.tesselAccount.cancel', 'Cancel') }}</button>
          </template>
          <template v-else>
            <div class="tessel-account-title">
              <strong>{{ PAGES['tessel-account'].title }}</strong>
              <span class="set-hint">{{ t('settings.tesselAccount.intro', 'Sign in to get what comes with an account. It is optional: Tessel works the same without one.') }}</span>
            </div>
            <button type="button" class="exit-btn primary tessel-account-open" :disabled="busy || !state" @click="signIn">{{ t('settings.tesselAccount.open', 'Sign in to Tessel') }}</button>
          </template>
        </div>

        <div class="tessel-account-included" data-included>
          <h3 class="tessel-account-included-title">{{ t('settings.tesselAccount.included', 'Included with your account') }}</h3>
          <ul class="tessel-account-items">
            <li>
              <Laptop :size="16" aria-hidden="true" />
              <div>
                <span class="tessel-account-item-name">{{ t('settings.tesselAccount.itemSync', 'Your settings everywhere') }} <span class="tag">{{ t('settings.tesselAccount.soon', 'Soon') }}</span></span>
                <span class="set-hint">{{ t('settings.tesselAccount.itemSyncHint', 'Find your settings and projects on every computer you use, encrypted before they leave this one.') }}</span>
              </div>
            </li>
            <li>
              <Mail :size="16" aria-hidden="true" />
              <div>
                <span class="tessel-account-item-name">{{ t('settings.tesselAccount.itemGoogle', 'Gmail in one click') }}</span>
                <span class="set-hint">{{ t('settings.tesselAccount.itemGoogleHint', 'Connect Gmail, Calendar and Drive to your agents without setting up a Google client.') }}</span>
              </div>
            </li>
          </ul>
        </div>
      </div>

      <p v-if="state && state.error" class="mcpc-invalid tessel-account-error" role="alert">{{ errorText(state.error) }}</p>
      <p v-if="notice" class="mcp-notice tessel-account-notice" role="status">{{ notice }}</p>
    </div>

    <div v-if="!missing && state && state.signedIn" class="set-group">
      <div class="set-card">
        <div class="set-row">
          <div class="set-label">
            <template v-if="state.user.hasPassword">
              {{ t('settings.tesselAccount.changePassword', 'Change your password') }}
              <span class="set-hint">{{ t('settings.tesselAccount.changePasswordHint', 'We email you a link. Once you choose a new one, you sign in again on every computer.') }}</span>
            </template>
            <template v-else>
              {{ t('settings.tesselAccount.setPassword', 'Choose a password') }}
              <span class="set-hint">{{ t('settings.tesselAccount.setPasswordHint', 'To log in with an address and a password too, get a link by email.') }}</span>
            </template>
          </div>
          <button type="button" class="exit-btn tessel-account-password" :disabled="busy" @click="sendPasswordLink">{{ t('settings.tesselAccount.sendLink', 'Send the link') }}</button>
        </div>
      </div>
    </div>

    <div v-if="!missing" class="set-group">
      <h3 class="set-group-title">{{ t('settings.tesselAccount.dataTitle', 'What an account keeps') }}</h3>
      <p class="set-group-desc">
        {{ t('settings.tesselAccount.data', 'Your email address, your name, your password as a hash if you chose one and, if you use them, your Google or GitHub ID, on Tessel\'s server. Never your mail, calendar or files.') }}
        <button type="button" class="sl-link tessel-account-privacy" @click="openPrivacy">{{ t('settings.tesselAccount.privacy', 'Privacy policy') }}</button>
      </p>
      <div v-if="state && state.signedIn" class="set-card">
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.tesselAccount.delete', 'Delete my account') }}
            <span class="set-hint">{{ t('settings.tesselAccount.deleteHint', 'Erases your account from the server. Nothing on this computer changes.') }}</span>
          </div>
          <button type="button" class="exit-btn danger tessel-account-delete" :disabled="busy" @click="removeAccount">{{ t('settings.tesselAccount.deleteButton', 'Delete') }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tessel-account-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.tessel-account-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}
.tessel-account-avatar {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--surface-3);
  color: var(--text-strong);
}
.tessel-account-title {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tessel-account-title strong {
  color: var(--text-strong);
  font-size: 13.5px;
  font-weight: 600;
}
.tessel-account-who {
  user-select: text;
}
.tessel-account-included {
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.tessel-account-included-title {
  margin: 0 0 10px;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.tessel-account-items {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px 24px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.tessel-account-items li {
  display: flex;
  gap: 10px;
  color: var(--text-dim);
}
.tessel-account-items li > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tessel-account-item-name {
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
}
.tessel-account-error,
.tessel-account-notice {
  margin: 8px 0 0;
}
</style>
