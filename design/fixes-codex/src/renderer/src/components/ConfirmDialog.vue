<script setup>
// A confirmation in Tessel's own look, instead of the operating system's
// window.confirm (which ignores the theme). Enter confirms, Esc cancels.
import { ref, onMounted } from 'vue'

defineProps({
  title: { type: String, required: true },
  text: { type: String, default: '' },
  confirmLabel: { type: String, default: 'OK' },
  // Optional second choice (answers 'alt'); Cancel still means "not now".
  altLabel: { type: String, default: '' },
  danger: { type: Boolean, default: false }
})
const emit = defineEmits(['answer'])
const okEl = ref(null)

onMounted(() => okEl.value && okEl.value.focus())
</script>

<template>
  <div class="help-backdrop confirm-backdrop" @pointerdown.self="emit('answer', false)">
    <div
      class="help-card confirm-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-text"
      @keydown.escape.prevent.stop="emit('answer', false)"
    >
      <h2 id="confirm-title" class="confirm-title">{{ title }}</h2>
      <p v-if="text" id="confirm-text" class="confirm-text">{{ text }}</p>
      <div class="confirm-actions">
        <button class="confirm-btn" @click="emit('answer', false)">Cancel</button>
        <button v-if="altLabel" class="confirm-btn" @click="emit('answer', 'alt')">{{ altLabel }}</button>
        <button
          ref="okEl"
          class="confirm-btn primary"
          :class="{ danger }"
          @click="emit('answer', true)"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
