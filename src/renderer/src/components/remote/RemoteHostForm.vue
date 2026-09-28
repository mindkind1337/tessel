<script setup>
// Add / edit an SSH host, ported from Orca's SshTargetForm.tsx and
// SshHostAdvancedFields.tsx (MIT, Copyright (c) 2026 Lovecast Inc.). The
// relay-only options (connection reuse, keeping terminals alive until reset,
// the timeout after disconnect) are not offered: Tessel runs ssh.exe in a
// pane, without Orca's remote relay.
import { ref, computed, onMounted, nextTick } from 'vue'
import { FileKey, ChevronDown, X } from 'lucide-vue-next'
import { t } from '../../i18n'
import { applyParsedSshHostInput, hasAdvancedValues, isFormDirty } from '../../remoteHosts'
import './remoteHosts.css'

const props = defineProps({
  initial: { type: Object, required: true },
  editing: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
  error: { type: String, default: '' }
})
const emit = defineEmits(['save', 'close'])

const form = ref({ ...props.initial })
const baseline = { ...props.initial }
const advancedOpen = ref(hasAdvancedValues(props.initial))
const dialogEl = ref(null)
const hostEl = ref(null)

const editingLabel = computed(() => form.value.label.trim())
const endpointSummary = computed(() => {
  const host = form.value.host.trim()
  if (!host) return editingLabel.value
  const user = form.value.username.trim()
  const port = form.value.port.trim()
  const userHost = user ? `${user}@${host}` : host
  return port ? `${userHost}:${port}` : userHost
})
const showChip = computed(
  () =>
    props.editing &&
    (editingLabel.value !== '' || (endpointSummary.value !== '' && endpointSummary.value !== editingLabel.value))
)
const showEndpoint = computed(() => endpointSummary.value !== '' && endpointSummary.value !== editingLabel.value)

function onHostBlur() {
  form.value = applyParsedSshHostInput(form.value)
}

function submit() {
  if (props.saving) return
  emit('save', { ...form.value })
}

// Outside clicks are easy to hit by accident with a long form: they close it
// only while nothing was changed (Escape, Cancel and × always close).
function onBackdrop() {
  if (!isFormDirty(form.value, baseline)) emit('close')
}

function trapTab(e) {
  const els = [...dialogEl.value.querySelectorAll('button, input')].filter((el) => !el.disabled)
  if (!els.length) return
  const first = els[0]
  const last = els[els.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

onMounted(() => nextTick(() => hostEl.value && hostEl.value.focus()))
</script>

<template>
  <div class="rh-backdrop" @pointerdown.self="onBackdrop">
    <div
      ref="dialogEl"
      class="rh-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rh-form-title"
      aria-describedby="rh-form-desc"
      @keydown.escape.stop.prevent="emit('close')"
      @keydown.tab.stop="trapTab"
    >
      <form class="rh-form" style="display: contents" @submit.prevent="submit">
        <header class="rh-dialog-head">
          <h2 id="rh-form-title" class="rh-dialog-title">
            {{ editing ? t('remote.form.editTitle', 'Edit SSH host') : t('remote.form.addTitle', 'Add SSH host') }}
          </h2>
          <p id="rh-form-desc" class="rh-dialog-desc">
            {{
              editing
                ? t('remote.form.editDescription', 'Update connection details for this machine. Changes apply on next connect.')
                : t('remote.form.addDescription', 'Add a persistent machine you can log into over SSH.')
            }}
          </p>
          <p v-if="showChip" class="rh-chip">
            {{ t('remote.form.editingPrefix', 'Editing') }}
            <strong v-if="editingLabel">{{ editingLabel }}</strong>
            <span v-if="editingLabel && showEndpoint" aria-hidden="true">·</span>
            <code v-if="showEndpoint">{{ endpointSummary }}</code>
          </p>
          <button
            type="button"
            class="rh-icon-btn rh-dialog-close"
            :aria-label="t('remote.form.close', 'Close')"
            @click="emit('close')"
          >
            <X :size="16" aria-hidden="true" />
          </button>
        </header>

        <div class="rh-dialog-body">
          <div class="rh-grid">
            <div class="rh-field">
              <label for="ssh-target-label">{{ t('remote.form.label', 'Label') }}</label>
              <input
                id="ssh-target-label"
                v-model="form.label"
                maxlength="120"
                :placeholder="t('remote.form.labelPlaceholder', 'My Server')"
              />
            </div>
            <div class="rh-field">
              <label for="ssh-target-host">{{ t('remote.form.host', 'Host or alias *') }}</label>
              <input
                id="ssh-target-host"
                ref="hostEl"
                v-model="form.host"
                spellcheck="false"
                :placeholder="t('remote.form.hostPlaceholder', 'server, deploy@server:2222, ssh://server')"
                @blur="onHostBlur"
              />
            </div>
            <div class="rh-field">
              <label for="ssh-target-username">{{ t('remote.form.username', 'Username') }}</label>
              <input
                id="ssh-target-username"
                v-model="form.username"
                spellcheck="false"
                :placeholder="t('remote.form.usernamePlaceholder', 'deploy')"
              />
            </div>
            <div class="rh-field">
              <label for="ssh-target-port">{{ t('remote.form.port', 'Port') }}</label>
              <input id="ssh-target-port" v-model="form.port" type="number" min="1" max="65535" placeholder="22" />
            </div>
            <div class="rh-field wide">
              <label for="ssh-target-identity">
                <FileKey :size="14" aria-hidden="true" />
                {{ t('remote.form.identityFile', 'Identity File') }}
              </label>
              <input
                id="ssh-target-identity"
                v-model="form.identityFile"
                spellcheck="false"
                :placeholder="t('remote.form.identityPlaceholder', '~/.ssh/id_ed25519 (leave empty for SSH agent)')"
              />
              <p class="rh-field-hint">{{ t('remote.form.identityHint', 'Optional. SSH agent is used by default.') }}</p>
            </div>
            <div class="rh-field wide">
              <button
                type="button"
                class="rh-btn ghost rh-advanced-toggle"
                :aria-expanded="advancedOpen"
                aria-controls="rh-advanced"
                @click="advancedOpen = !advancedOpen"
              >
                {{ t('remote.form.advanced', 'Advanced') }}
                <ChevronDown :size="16" aria-hidden="true" />
              </button>
              <div v-if="advancedOpen" id="rh-advanced" class="rh-advanced">
                <div class="rh-field">
                  <label for="add-ssh-proxy-command">{{ t('remote.form.proxyCommand', 'Proxy Command') }}</label>
                  <input
                    id="add-ssh-proxy-command"
                    v-model="form.proxyCommand"
                    spellcheck="false"
                    :placeholder="t('remote.form.proxyPlaceholder', 'e.g. cloudflared access ssh --hostname %h')"
                  />
                  <p class="rh-field-hint">
                    {{ t('remote.form.proxyHint', 'Optional. Used for tunneling (e.g. Cloudflare Access, ProxyCommand).') }}
                  </p>
                </div>
                <div class="rh-field">
                  <label for="add-ssh-jump-host">{{ t('remote.form.jumpHost', 'Jump Host') }}</label>
                  <input
                    id="add-ssh-jump-host"
                    v-model="form.jumpHost"
                    spellcheck="false"
                    :placeholder="t('remote.form.jumpPlaceholder', 'bastion.example.com')"
                  />
                  <p class="rh-field-hint">{{ t('remote.form.jumpHint', 'Optional. Equivalent to ProxyJump / ssh -J.') }}</p>
                </div>
              </div>
            </div>
          </div>
          <p v-if="error" class="rh-form-error" role="alert">{{ error }}</p>
        </div>

        <footer class="rh-dialog-foot">
          <button type="button" class="rh-btn" @click="emit('close')">{{ t('remote.form.cancel', 'Cancel') }}</button>
          <button type="submit" class="rh-btn primary" :disabled="saving">
            {{ editing ? t('remote.form.saveChanges', 'Save Changes') : t('remote.form.addTarget', 'Add Target') }}
          </button>
        </footer>
      </form>
    </div>
  </div>
</template>
