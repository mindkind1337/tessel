<script setup>
// After Orca's NativeChatComposer.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
// The chat's rich input. Keyed on paneKey like the reference: a pane switch
// remounts the pane composer (its IME state, caret and picker start fresh;
// the draft comes back from the pane's cache).
//
// Props (native-chat-composer-props.js): paneKey, agent, agentName,
//   v-model (the draft), isWorking, disabledReason, sendBlockedReason, send,
//   setOption, onOptionCommand, chatLaunchYolo, maxPermissions, commands,
//   conversationCommands, skillsOptions, allowImages, contextUsage,
//   sessionOptionsSurface, sessionOptionsSnapshot, sessionOptionsPickerRequest,
//   sessionOptionsProps, readClipboardText, pathForFile.
// Emits: update:modelValue(draft), interrupt (Stop, or Escape while working),
//   error(message | null) (a refused send or option; null once one succeeds),
//   attach (unused: + opens the image picker itself), slashCommand(command), sent(text) (the
//   session confirmed it: the draft was cleared if unchanged since).
// Slot: session-options (replaces the default session option pickers).
// Exposed: focus(), insertTypedText(text), handlePasteEvent(event),
//   pasteFromClipboard(), and Tessel's: draft (the current text), setDraft(text), send(),
//   attachResolvedPaths(paths), el() (the editable element).
import { shallowRef } from 'vue'
import { nativeChatComposerProps } from './native-chat-composer-props.js'
import NativeChatComposerPane from './NativeChatComposerPane.vue'

// Listeners (interrupt, error…) fall through to the pane (no comment before
// the root element: it would make the root a fragment). v-model's update does
// not (Vue keeps onUpdate:modelValue for a component with a modelValue prop),
// so it is forwarded.
const props = defineProps(nativeChatComposerProps)
const emit = defineEmits(['update:modelValue'])
const pane = shallowRef(null)

defineExpose({
  focus: () => pane.value?.focus() ?? false,
  insertTypedText: (text) => pane.value?.insertTypedText(text) ?? false,
  handlePasteEvent: (event) => pane.value?.handlePasteEvent(event),
  pasteFromClipboard: () => pane.value?.pasteFromClipboard(),
  get draft() {
    return pane.value?.draft
  },
  setDraft: (text) => pane.value?.setDraft(text),
  send: () => pane.value?.send(),
  attachResolvedPaths: (...args) => pane.value?.attachResolvedPaths(...args) ?? false,
  el: () => pane.value?.el() ?? null
})
</script>

<template>
  <NativeChatComposerPane
    :key="paneKey"
    ref="pane"
    v-bind="props"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template v-for="(_, name) in $slots" #[name]="scope">
      <slot :name="name" v-bind="scope || {}" />
    </template>
  </NativeChatComposerPane>
</template>
