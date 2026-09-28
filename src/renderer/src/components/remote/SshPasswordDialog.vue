<script setup>
// The SSH password / passphrase dialog, ported from Orca's
// SshPassphraseDialog.tsx (MIT, Copyright (c) 2026 Lovecast Inc.): one prompt
// at a time from the queue, Enter submits, Esc or Cancel cancels, the answer
// goes to main in one call and the field is emptied right after. The secret
// only lives in this field; it is never logged or kept.
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../../i18n'
import {
  sshCredentialState,
  submitSshCredential,
  initSshCredentials,
  stopSshCredentials
} from '../../sshCredentials'
import './remoteHosts.css'

const request = computed(() => sshCredentialState.queue[0] || null)
const value = ref('')
const submitting = ref(false)
const failed = ref('')
const inputEl = ref(null)

const kind = computed(() => (request.value ? request.value.kind : 'password'))
const isPassword = computed(() => kind.value === 'password')
const isKeyboardInteractive = computed(() => kind.value === 'keyboard-interactive')
const targetLabel = computed(() => (request.value ? request.value.label || request.value.detail : ''))
const detail = computed(() => (request.value ? request.value.detail || request.value.label : ''))

const title = computed(() =>
  isKeyboardInteractive.value
    ? t('remote.credential.titleVerification', 'SSH Verification')
    : isPassword.value
      ? t('remote.credential.titlePassword', 'SSH Password')
      : t('remote.credential.titlePassphrase', 'SSH Key Passphrase')
)
const description = computed(() =>
  isKeyboardInteractive.value
    ? t('remote.credential.descVerification', 'Complete the verification challenge for')
    : isPassword.value
      ? t('remote.credential.descPassword', 'Enter the password for')
      : t('remote.credential.descPassphrase', 'Enter the passphrase for')
)
const fieldLabel = computed(() =>
  isKeyboardInteractive.value
    ? detail.value
    : isPassword.value
      ? t('remote.credential.passwordFor', 'Password for {{value0}}', { value0: detail.value })
      : t('remote.credential.passphraseFor', 'Passphrase for {{value0}}', { value0: detail.value })
)
const placeholder = computed(() =>
  isKeyboardInteractive.value
    ? t('remote.credential.placeholderResponse', 'Enter response')
    : isPassword.value
      ? t('remote.credential.placeholderPassword', 'Enter password')
      : t('remote.credential.placeholderPassphrase', 'Enter passphrase')
)
const submitLabel = computed(() =>
  isKeyboardInteractive.value
    ? t('remote.credential.continue', 'Continue')
    : isPassword.value
      ? t('remote.credential.connect', 'Connect')
      : t('remote.credential.unlock', 'Unlock')
)
const retryText = computed(() => {
  if (!request.value || !request.value.retry) return ''
  return kind.value === 'passphrase'
    ? t('remote.credential.badPassphrase', 'Bad passphrase, try again.')
    : t('remote.credential.denied', 'Permission denied, please try again.')
})
// Keyboard-interactive servers may accept an empty answer (a push MFA);
// passwords and passphrases are never empty.
const canSubmit = computed(() => !submitting.value && (isKeyboardInteractive.value || value.value.length > 0))

function focusInput() {
  nextTick(() => {
    requestAnimationFrame(() => {
      if (inputEl.value) inputEl.value.focus()
    })
  })
}

watch(
  () => request.value && request.value.promptId,
  (id) => {
    value.value = ''
    submitting.value = false
    failed.value = ''
    if (id) focusInput()
  },
  { immediate: true }
)

async function submit() {
  const req = request.value
  if (!req || !canSubmit.value) return
  submitting.value = true
  failed.value = ''
  let secret = value.value
  value.value = ''
  try {
    const res = await submitSshCredential(req, secret)
    secret = ''
    if (!res || !res.ok) {
      if (res && res.error === 'stale') return
      failed.value = t('remote.credential.submitFailed', 'Failed to submit SSH credential')
      submitting.value = false
      focusInput()
    }
  } catch {
    secret = ''
    failed.value = t('remote.credential.submitFailed', 'Failed to submit SSH credential')
    submitting.value = false
    focusInput()
  }
}

async function cancel() {
  const req = request.value
  if (!req || submitting.value) return
  submitting.value = true
  value.value = ''
  try {
    const res = await submitSshCredential(req, null)
    if (!res || (!res.ok && res.error !== 'stale')) {
      failed.value = t('remote.credential.cancelFailed', 'Failed to cancel SSH credential request')
      submitting.value = false
    }
  } catch {
    failed.value = t('remote.credential.cancelFailed', 'Failed to cancel SSH credential request')
    submitting.value = false
  }
}

function onKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault()
    submit()
  }
}

onMounted(() => initSshCredentials())
onBeforeUnmount(() => {
  value.value = ''
  stopSshCredentials()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="request" class="rh-backdrop ssh-cred-backdrop" @pointerdown.self="cancel">
      <div
        class="rh-dialog ssh-cred-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-cred-title"
        aria-describedby="ssh-cred-desc"
        data-test="ssh-credential-dialog"
        @keydown.escape.stop.prevent="cancel"
      >
        <div class="ssh-cred-head">
          <h2 id="ssh-cred-title" class="ssh-cred-title">{{ title }}</h2>
          <p id="ssh-cred-desc" class="ssh-cred-desc">
            {{ description }} <span class="ssh-cred-target">{{ targetLabel }}</span>
          </p>
        </div>
        <div>
          <label for="ssh-credential-input" class="ssh-cred-label">{{ fieldLabel }}</label>
          <input
            id="ssh-credential-input"
            ref="inputEl"
            v-model="value"
            class="ssh-cred-input"
            type="password"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            :placeholder="placeholder"
            :disabled="submitting"
            data-test="ssh-credential-input"
            @keydown="onKeydown"
          />
          <p v-if="retryText" class="ssh-cred-error" role="alert" data-test="ssh-credential-retry">{{ retryText }}</p>
          <p v-if="failed" class="ssh-cred-error" role="alert">{{ failed }}</p>
        </div>
        <div class="ssh-cred-foot">
          <button type="button" class="rh-btn ssh-cred-btn" :disabled="submitting" data-test="ssh-credential-cancel" @click="cancel">
            {{ t('remote.credential.cancel', 'Cancel') }}
          </button>
          <button
            type="button"
            class="rh-btn primary ssh-cred-btn"
            :disabled="!canSubmit"
            data-test="ssh-credential-submit"
            @click="submit"
          >
            {{ submitLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
