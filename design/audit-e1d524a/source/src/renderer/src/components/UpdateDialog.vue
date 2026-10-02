<script setup>
// "Restart and update" confirmation: what's new, and what happens to the panes.
import { ref, onMounted } from 'vue'

defineProps({
  status: { type: Object, required: true },
  panes: { type: Number, default: 0 },
  installing: { type: Boolean, default: false }
})
const emit = defineEmits(['install', 'close'])

const cardEl = ref(null)
onMounted(() => {
  if (cardEl.value) cardEl.value.focus()
})
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="!installing && emit('close')">
    <div
      ref="cardEl"
      class="help-card update-card"
      role="dialog"
      aria-label="Update Tessel"
      tabindex="-1"
      @keydown.escape.prevent.stop="!installing && emit('close')"
    >
      <div class="help-head">
        <span>Update to Tessel {{ status.version }}</span>
      </div>

      <p class="update-line">
        You have version {{ status.current }}. The new version is downloaded and ready.
      </p>

      <pre v-if="status.notes" class="update-notes">{{ status.notes }}</pre>

      <p class="update-line">
        Tessel will close, install the update and open again.
        <template v-if="panes">
          Your {{ panes }} {{ panes === 1 ? 'pane reopens' : 'panes reopen' }} where
          {{ panes === 1 ? 'it was' : 'they were' }}, with their recent output, and Claude and Codex
          resume their conversations.
        </template>
      </p>
      <p class="update-line dim">
        Programs running in the terminals are stopped. Let an agent finish what it's doing first.
        Windows may ask for permission to install.
      </p>

      <div class="update-actions">
        <button class="exit-btn" :disabled="installing" @click="emit('close')">Later</button>
        <button class="exit-btn primary" :disabled="installing" @click="emit('install')">
          {{ installing ? 'Restarting…' : 'Restart and update' }}
        </button>
      </div>
    </div>
  </div>
</template>
