<script setup>
// The chat's input: Enter sends, Shift+Enter makes a new line, Esc stops the
// agent while it works. A message sent while it works waits for the end of
// the turn (the main process queues it). After Orca's
// NativeChatComposer.tsx (MIT, Copyright (c) 2026 Lovecast Inc.), written
// for Vue.
import { computed, nextTick, ref, watch } from 'vue'
import { SendHorizontal, Square } from 'lucide-vue-next'
import { t } from '../../i18n'

const props = defineProps({
  modelValue: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  // Why nothing can be sent now ('' = it can).
  disabledReason: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'send', 'interrupt'])

const inputEl = ref(null)
const composing = ref(false)

const disabled = computed(() => !!props.disabledReason)
const canSend = computed(() => !disabled.value && props.modelValue.trim().length > 0)
const placeholder = computed(() => {
  if (props.disabledReason) return props.disabledReason
  if (props.busy) return t('chat.composer.placeholderBusy', 'Message Claude (sent when the turn ends)…')
  return t('chat.composer.placeholder', 'Message Claude…')
})

function onInput(e) {
  emit('update:modelValue', e.target.value)
  autoGrow()
}

function autoGrow() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px` // i18n-ignore
}
watch(
  () => props.modelValue,
  () => nextTick(autoGrow)
)

function send() {
  if (!canSend.value) return
  emit('send', props.modelValue)
}

function onKeydown(e) {
  if (composing.value || e.isComposing) return
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault()
    send()
    return
  }
  if (e.key === 'Escape' && props.busy) {
    e.preventDefault()
    e.stopPropagation()
    emit('interrupt')
  }
}

defineExpose({
  focus: () => inputEl.value && inputEl.value.focus(),
  el: () => inputEl.value
})
</script>

<template>
  <div class="chat-composer" :class="{ disabled }" data-test="chat-composer">
    <textarea
      ref="inputEl"
      class="chat-input"
      data-test="chat-input"
      rows="1"
      :value="modelValue"
      :disabled="disabled"
      :placeholder="placeholder"
      :aria-label="t('chat.composer.label', 'Message')"
      spellcheck="true"
      @input="onInput"
      @keydown="onKeydown"
      @compositionstart="composing = true"
      @compositionend="composing = false"
    ></textarea>
    <div class="chat-composer-actions">
      <button
        v-if="busy"
        type="button"
        class="chat-icon-btn stop"
        data-test="chat-interrupt"
        :title="t('chat.composer.interruptHint', 'Stop the agent (Esc)')"
        :aria-label="t('chat.composer.interrupt', 'Interrupt')"
        @click="emit('interrupt')"
      >
        <Square :size="13" fill="currentColor" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="chat-icon-btn send"
        data-test="chat-send"
        :disabled="!canSend"
        :title="t('chat.composer.sendHint', 'Send (Enter) · new line: Shift+Enter')"
        :aria-label="t('chat.composer.send', 'Send')"
        @click="send"
      >
        <SendHorizontal :size="15" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-composer {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  margin: 0 10px 10px;
  padding: 6px 6px 6px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
}

.chat-composer:focus-within {
  border-color: color-mix(in srgb, var(--ui-accent) 55%, var(--border-strong));
}

.chat-composer.disabled {
  opacity: 0.7;
}

.chat-input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 22px;
  max-height: 200px;
  padding: 3px 0;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--text-strong);
  font: inherit;
  font-size: 13px;
  line-height: 1.45;
}

.chat-input::placeholder {
  color: var(--text-dim);
}

.chat-composer-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
}

.chat-icon-btn {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}

.chat-icon-btn.send:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 25%, var(--surface-2));
  color: var(--text-strong);
}

.chat-icon-btn.stop {
  background: color-mix(in srgb, var(--danger) 18%, var(--surface-2));
  color: var(--danger);
}

.chat-icon-btn:hover:not(:disabled) {
  filter: brightness(1.15);
}

.chat-icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
