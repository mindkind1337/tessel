<script setup>
// An agent's approval card (an account switch, a terminal command) that
// ended without the user's answer while it was on screen: its time ran out,
// the agent's call went away, or Tessel stopped waiting for it. It shows
// this for a few seconds in its place (App.vue closes it), with no Allow: a
// click on it never looks like it did something.
import { nextTick, onMounted, ref } from 'vue'
import { t } from '../i18n'

const emit = defineEmits(['close'])
const okEl = ref(null)
onMounted(() => nextTick(() => okEl.value?.focus()))
</script>

<template>
  <div class="help-backdrop confirm-backdrop" data-test="agent-approval-expired" @pointerdown.self="emit('close')">
    <div class="help-card confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="aae-title" @focusin.stop @keydown.escape.prevent.stop="emit('close')">
      <h2 id="aae-title" class="confirm-title">{{ t('app.agentApproval.expiredTitle', 'This request expired') }}</h2>
      <p class="confirm-text">{{ t('app.agentApproval.expiredText', 'Nothing was done: the agent can ask again if it still needs it.') }}</p>
      <div class="confirm-actions">
        <button ref="okEl" class="confirm-btn" data-test="agent-approval-expired-ok" @click="emit('close')">{{ t('app.agentApproval.expiredOk', 'OK') }}</button>
      </div>
    </div>
  </div>
</template>
