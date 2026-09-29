<script setup>
// After Orca's NativeChatPaneFileDropSurface.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// The whole chat pane, not just the input box, is where a file can be
// dropped: a file from Tessel's explorer or from the system becomes its path
// in the draft (the agent reads it; nothing is uploaded), with the
// reference's overlay while a drag is over the pane.
// Props: insertText(text) (the composer's typed insertion), disabled (no
//   composer to take it: stopped, a prompt card…), paneKey (the drop's owner:
//   a drop that lands after the pane changed is dropped), setNotice(message)
//   (why a drop was refused).
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Paperclip } from 'lucide-vue-next'
import { useNativeChatWorkspaceFileDrop } from '../../../chat/orca/composables/use-native-chat-workspace-file-drop.js'
import { t } from '../../../i18n'

const props = defineProps({
  insertText: { type: Function, default: null },
  disabled: { type: Boolean, default: false },
  paneKey: { type: String, default: '' },
  setNotice: { type: Function, default: null }
})

const PATH_MIME = 'text/x-tessel-path'
const isDragActive = ref(false)

const drop = useNativeChatWorkspaceFileDrop(() => ({
  paneKey: props.paneKey,
  disabled: props.disabled || !props.insertText,
  insertText: props.insertText,
  setNotice: props.setNotice
}))

// A drag this surface can take: a Tessel path or files from the system.
function takes(event) {
  const types = Array.from((event.dataTransfer && event.dataTransfer.types) || [])
  return !props.disabled && !!props.insertText && types.some((type) => type === PATH_MIME || type === 'Files')
}
function onDragEnter(event) {
  if (takes(event)) isDragActive.value = true
}
function onDragOver(event) {
  if (takes(event)) isDragActive.value = true
  drop.onDragOverCapture(event)
}
function onDragLeave(event) {
  // Moving between the pane's own children is not leaving it.
  const to = event.relatedTarget
  if (to instanceof Node && event.currentTarget.contains(to)) return
  isDragActive.value = false
}
function onDrop(event) {
  isDragActive.value = false
  drop.onDropCapture(event)
}

// A drop or a cancelled drag anywhere ends the hover.
function clear() {
  isDragActive.value = false
}
onMounted(() => {
  document.addEventListener('drop', clear, true)
  document.addEventListener('dragend', clear, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('drop', clear, true)
  document.removeEventListener('dragend', clear, true)
})
</script>

<template>
  <div
    class="nc-drop-surface"
    data-native-chat-drop-surface="true"
    @dragenter.capture="onDragEnter"
    @dragover.capture="onDragOver"
    @dragleave.capture="onDragLeave"
    @drop.capture="onDrop"
  >
    <slot />
    <div v-if="isDragActive" class="nc-drop-overlay" data-native-chat-drop-overlay="true">
      <div class="nc-drop-card">
        <span class="nc-drop-icon"><Paperclip :size="18" aria-hidden="true" /></span>
        <span class="nc-drop-title">{{ t('chat.orca.drop.title', 'Drop to attach to this chat') }}</span>
        <span class="nc-drop-subtitle">{{ t('chat.orca.drop.subtitle', 'Files are added to your message as paths the agent can read.') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* relative flex h-full min-h-0 min-w-0 w-full */
.nc-drop-surface {
  position: relative;
  display: flex;
  height: 100%;
  min-height: 0;
  min-width: 0;
  width: 100%;
}
/* pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/80 */
.nc-drop-overlay {
  pointer-events: none;
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--nc-background) 80%, transparent);
}
/* flex flex-col items-center gap-1 rounded-xl border border-dashed border-foreground/30 bg-card px-8 py-5 text-center shadow-floating */
.nc-drop-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  border-radius: 12px;
  border: 1px dashed color-mix(in srgb, var(--nc-foreground) 30%, transparent);
  background: var(--nc-card);
  padding: 20px 32px;
  text-align: center;
  box-shadow: 0 16px 34px rgba(0, 0, 0, 0.4);
}
/* mb-1 flex size-9 items-center justify-center rounded-full bg-foreground/10 */
.nc-drop-icon {
  margin-bottom: 4px;
  display: flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--nc-foreground) 10%, transparent);
}
/* text-sm font-medium */
.nc-drop-title {
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
}
/* text-xs text-muted-foreground */
.nc-drop-subtitle {
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
</style>
