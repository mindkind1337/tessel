<script setup>
// A confirmation in Tessel's own look, instead of the operating system's
// window.confirm (which ignores the theme). Enter confirms, Esc cancels.
import { ref, onMounted, onUnmounted } from 'vue'
import { t } from '../i18n'

defineProps({
  title: { type: String, required: true },
  text: { type: String, default: '' },
  confirmLabel: { type: String, default: 'OK' },
  // Optional second choice (answers 'alt'); Cancel still means "not now".
  altLabel: { type: String, default: '' },
  danger: { type: Boolean, default: false },
  // A command shown exactly as it will run, and labelled facts about it
  // ([{ label, value }]: its shell, where it comes from).
  code: { type: String, default: '' },
  details: { type: Array, default: () => [] }
})
const emit = defineEmits(['answer'])
const okEl = ref(null)
const dialog = ref(null)
let previousFocus = null

onMounted(() => {
  previousFocus = document.activeElement
  okEl.value?.focus()
})
onUnmounted(() => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})

function trapTab(event) {
  const buttons = [...(dialog.value?.querySelectorAll('button:not(:disabled)') || [])]
  const first = buttons[0]
  const last = buttons.at(-1)
  if (!first) {
    event.preventDefault()
    return
  }
  if (!dialog.value.contains(document.activeElement)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
</script>

<template>
  <div class="help-backdrop confirm-backdrop" @pointerdown.self="emit('answer', false)">
    <div
      ref="dialog"
      class="help-card confirm-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-text"
      @focusin.stop
      @keydown.escape.prevent.stop="emit('answer', false)"
      @keydown.tab.stop="trapTab"
    >
      <h2 id="confirm-title" class="confirm-title">{{ title }}</h2>
      <p v-if="text" id="confirm-text" class="confirm-text">{{ text }}</p>
      <pre v-if="code" class="confirm-code" data-test="confirm-code">{{ code }}</pre>
      <dl v-if="details.length" class="confirm-details">
        <template v-for="d in details" :key="d.label">
          <dt>{{ d.label }}</dt>
          <dd>{{ d.value }}</dd>
        </template>
      </dl>
      <div class="confirm-actions">
        <button class="confirm-btn" @click="emit('answer', false)">{{ t('app.confirm.cancel', 'Cancel') }}</button>
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
