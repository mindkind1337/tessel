<script setup>
// After Orca's NativeChatView.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// A chat pane's conversation: the file drop surface around the structured
// session (Tessel's chats are always structured: no terminal bridge). The
// design tokens (--nc-*) start here, on .nc-root.
// Props: those of NativeChatStructuredSession (passed through).
// Exposed: the session's (focusComposer, focusPendingApproval, …).
import { computed, shallowRef, useAttrs } from 'vue'
import './orca-tokens.css'
import NativeChatPaneFileDropSurface from './NativeChatPaneFileDropSurface.vue'
import NativeChatStructuredSession from './NativeChatStructuredSession.vue'

defineOptions({ inheritAttrs: false })
const attrs = useAttrs()
const sessionRef = shallowRef(null)

// A dropped file's path goes into the draft; not while nothing can be typed.
const dropDisabled = computed(() => !!attrs['disabled-reason'] || !!attrs.disabledReason)
const paneKey = computed(() => (attrs.node && attrs.node.id) || '')
function insertText(text) {
  return sessionRef.value ? sessionRef.value.insertTypedText(text) : false
}
function setNotice(message) {
  if (sessionRef.value) sessionRef.value.setNotice(message)
}

defineExpose({
  openMenuAt: (x, y) => sessionRef.value?.openMenuAt?.(x, y),
  focusComposer: () => sessionRef.value?.focusComposer() ?? false,
  focusPendingApproval: () => sessionRef.value?.focusPendingApproval() ?? false,
  hasPendingApproval: () => sessionRef.value?.hasPendingApproval() ?? false,
  composerEl: () => sessionRef.value?.composerEl() ?? null
})
</script>

<template>
  <div class="nc-root nc-view" data-native-chat-view="true">
    <NativeChatPaneFileDropSurface :insert-text="insertText" :set-notice="setNotice" :disabled="dropDisabled" :pane-key="paneKey">
      <NativeChatStructuredSession ref="sessionRef" v-bind="attrs" />
    </NativeChatPaneFileDropSurface>
  </div>
</template>

<style scoped>
.nc-view {
  display: flex;
  flex: 1 1 0%;
  min-height: 0;
  min-width: 0;
  width: 100%;
  font-size: 14px;
}
</style>
