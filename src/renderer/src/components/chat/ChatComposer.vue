<script setup>
// The chat's input: Enter sends, Shift+Enter makes a new line, Esc
// interrupts the current turn (the messages queued after it are still sent).
// A message sent while it works waits for the end of the turn (the main
// process queues it). While the agent starts, typing works but Send waits
// (sendBlockedReason says why). After Orca's
// NativeChatComposer.tsx (MIT, Copyright (c) 2026 Lovecast Inc.), written
// for Vue.
import { computed, nextTick, ref, useId, watch } from 'vue'
import { SendHorizontal, Square } from 'lucide-vue-next'
import { t } from '../../i18n'

const props = defineProps({
  // Who the messages go to (Claude, Codex).
  agentName: { type: String, default: 'Claude' }, // i18n-ignore product name
  modelValue: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  // Why nothing can be sent now ('' = it can): the input is disabled.
  disabledReason: { type: String, default: '' },
  // Why Send waits for now ('' = it does not): typing still works.
  sendBlockedReason: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'send', 'interrupt'])

const inputEl = ref(null)
// The id of the text that says why Send waits (aria-describedby).
const blockedId = `chat-send-blocked-${useId()}` // i18n-ignore
const composing = ref(false)

const disabled = computed(() => !!props.disabledReason)
const blocked = computed(() => disabled.value || !!props.sendBlockedReason)
const canSend = computed(() => !blocked.value && props.modelValue.trim().length > 0)
const placeholder = computed(() => {
  if (props.disabledReason) return props.disabledReason
  if (props.sendBlockedReason) return props.sendBlockedReason
  if (props.busy) return t('chat.composer.placeholderBusy', 'Message {{agent}} (sent when the turn ends)…', { agent: props.agentName })
  return t('chat.composer.placeholder', 'Message {{agent}}…', { agent: props.agentName })
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
      :aria-describedby="sendBlockedReason ? blockedId : undefined"
      spellcheck="true"
      @input="onInput"
      @keydown="onKeydown"
      @compositionstart="composing = true"
      @compositionend="composing = false"
    ></textarea>
    <span v-if="sendBlockedReason" :id="blockedId" class="sr-only" data-test="chat-send-blocked">{{ sendBlockedReason }}</span>
    <div class="chat-composer-actions">
      <button
        v-if="busy"
        type="button"
        class="chat-icon-btn stop"
        data-test="chat-interrupt"
        :title="t('chat.composer.interruptTurnHint', 'Interrupt the current turn (Esc). Queued messages are still sent afterwards.')"
        :aria-label="t('chat.composer.interruptTurn', 'Interrupt the current turn')"
        @click="emit('interrupt')"
      >
        <Square :size="13" fill="currentColor" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="chat-icon-btn send"
        data-test="chat-send"
        :disabled="!canSend"
        :title="sendBlockedReason || t('chat.composer.sendHint', 'Send (Enter) · new line: Shift+Enter')"
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
