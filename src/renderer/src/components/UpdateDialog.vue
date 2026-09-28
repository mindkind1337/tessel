<script setup>
// "Restart and update" confirmation: what's new, and what happens to the panes.
import { ref, computed, onMounted } from 'vue'
import { t } from '../i18n'

const props = defineProps({
  status: { type: Object, required: true },
  panes: { type: Number, default: 0 },
  installing: { type: Boolean, default: false }
})
const emit = defineEmits(['install', 'close'])

const headText = computed(() => t('app.update.title', 'Update to Tessel {{version}}', { version: props.status.version }))
const currentText = computed(() =>
  t('app.update.current', 'You have version {{version}}. The new version is downloaded and ready.', {
    version: props.status.current
  })
)
const panesText = computed(() =>
  props.panes === 1
    ? t('app.update.panesOne', 'Your 1 pane reopens where it was, with their recent output, and Claude and Codex resume their conversations.'
      )
    : t('app.update.panesOther', 'Your {{count}} panes reopen where they were, with their recent output, and Claude and Codex resume their conversations.',
        { count: props.panes }
      )
)

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
      :aria-label="t('app.update.label', 'Update Tessel')"
      tabindex="-1"
      @keydown.escape.prevent.stop="!installing && emit('close')"
    >
      <div class="help-head">
        <span>{{ headText }}</span>
      </div>

      <p class="update-line">
        {{ currentText }}
      </p>

      <pre v-if="status.notes" class="update-notes">{{ status.notes }}</pre>

      <p class="update-line">
        {{ t('app.update.willRestart', 'Tessel will close, install the update and open again.') }}
        <template v-if="panes">
          {{ panesText }}
        </template>
      </p>
      <p class="update-line dim">
        {{
          t('app.update.warning', "Programs running in the terminals are stopped. Let an agent finish what it's doing first. Windows may ask for permission to install."
          )
        }}
      </p>

      <div class="update-actions">
        <button class="exit-btn" :disabled="installing" @click="emit('close')">
          {{ t('app.update.later', 'Later') }}
        </button>
        <button class="exit-btn primary" :disabled="installing" @click="emit('install')">
          {{ installing ? t('app.update.restarting', 'Restarting…') : t('app.update.restart', 'Restart and update') }}
        </button>
      </div>
    </div>
  </div>
</template>
