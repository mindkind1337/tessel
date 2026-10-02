<script setup>
// A pasted key or cookie in Settings > AI provider accounts: it goes to the
// main process (encrypted there) and never comes back; the field shows only
// whether one is saved. After Orca's accounts-pane-minimax-credentials.tsx
// (MIT, Copyright (c) 2026 Lovecast Inc.).
import { ref } from 'vue'
import { t } from '../i18n'

const props = defineProps({
  id: { type: String, required: true },
  label: { type: String, required: true },
  placeholder: { type: String, default: '' },
  saved: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  forgetLabel: { type: String, default: '' },
  // async (value) => boolean: true once saved.
  save: { type: Function, required: true },
  forget: { type: Function, required: true }
})
const draft = ref('')

async function submit() {
  const value = draft.value.trim()
  if (!value || props.busy) return
  if (await props.save(value)) draft.value = ''
}
async function clear() {
  if (props.busy) return
  await props.forget()
  draft.value = ''
}
</script>

<template>
  <div class="usage-field" :data-secret="id">
    <div class="usage-label">
      <label :for="id">{{ label }}</label>
      <span class="usage-saved" :class="{ on: saved }" data-test="secret-state">{{
        saved ? t('settings.accounts.secretSaved', 'Saved') : t('settings.accounts.notSaved', 'Not saved')
      }}</span>
      <slot name="help" />
    </div>
    <div class="usage-row">
      <input
        :id="id"
        v-model="draft"
        class="usage-input"
        type="password"
        autocomplete="off"
        spellcheck="false"
        :disabled="busy"
        :placeholder="placeholder"
        data-test="secret-input"
        @keydown.enter.prevent="submit"
      />
      <button
        type="button"
        class="usage-btn"
        :disabled="busy || !draft.trim()"
        data-test="secret-save"
        @click="submit"
      >
        {{ saved ? t('settings.accounts.replace', 'Replace') : t('settings.accounts.save', 'Save') }}
      </button>
      <button
        v-if="saved"
        type="button"
        class="usage-btn quiet"
        :disabled="busy"
        data-test="secret-forget"
        @click="clear"
      >
        {{ forgetLabel || t('settings.accounts.forget', 'Forget') }}
      </button>
    </div>
    <slot />
  </div>
</template>

<style scoped src="./usageAccount.css"></style>
