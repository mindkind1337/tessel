<script setup>
// After Orca's NativeChatTranscriptChrome.tsx, TranscriptImagePreview (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * One image of a message: a thumbnail (opens a full-size dialog) while near
 * the viewport and loadable, else a chip with its name. The observed element
 * stays the same when the thumbnail appears (one root div).
 * Props: block (image-ref), runtimeContext (worktree context; null =
 *   unresolved, undefined = pending).
 * The image source comes from ./native-chat-local-image-src.js (Tessel's
 * loader; it yields nothing today, the engine sends text only).
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { Image as ImageIcon } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui'
import { useLocalImageSrc } from './native-chat-local-image-src.js'
import {
  basename,
  isNativeChatPastedImagePath,
  observeTranscriptVisibility,
  renderableImageSource
} from './native-chat-transcript-visibility.js'

const props = defineProps({
  block: { type: Object, required: true },
  runtimeContext: { type: Object, default: undefined }
})

const open = ref(false)
const near = ref(false)
const thumbnailErrorSrc = ref(null)
const dialogErrorSrc = ref(null)
const root = shallowRef(null)

const source = computed(() => props.block.url?.trim() || props.block.path)
const filePath = computed(() => props.block.path ?? source.value ?? '')
const external = computed(() => renderableImageSource(source.value))
const leaseActive = computed(() => near.value || open.value)
const localSrc = useLocalImageSrc(
  () =>
    leaseActive.value && !external.value && props.runtimeContext !== undefined
      ? source.value
      : undefined,
  () => filePath.value,
  () => props.runtimeContext?.connectionId,
  () => props.runtimeContext
)
const displaySrc = computed(() =>
  external.value && leaseActive.value ? source.value : localSrc.value
)
const label = computed(
  () =>
    props.block.alt?.trim() ||
    (props.block.path && isNativeChatPastedImagePath(props.block.path)
      ? t('chat.orca.composer.pastedImageLabel', 'Pasted image')
      : props.block.path
        ? basename(props.block.path)
        : 'Image')
)
const viewImageLabel = computed(() => t('chat.orca.composer.viewAttachment', 'View image'))
const previewDescription = computed(() =>
  t('chat.orca.composer.imagePreview', 'Full-size image preview')
)

let stopObserving = null
onMounted(() => {
  if (root.value) stopObserving = observeTranscriptVisibility(root.value, (v) => (near.value = v))
})
onBeforeUnmount(() => stopObserving?.())

const showPreview = computed(
  () =>
    leaseActive.value &&
    Boolean(displaySrc.value) &&
    displaySrc.value !== thumbnailErrorSrc.value &&
    Boolean(source.value) &&
    (external.value || props.runtimeContext !== null)
)
</script>

<template>
  <div ref="root" :class="{ 'nc-image-preview': showPreview }">
    <template v-if="showPreview">
      <button
        type="button"
        class="nc-image-thumb"
        :aria-label="`${viewImageLabel}: ${label}`"
        :title="label"
        @click="open = true"
      >
        <img
          :src="displaySrc"
          :alt="label"
          loading="lazy"
          class="nc-image-thumb-img"
          @error="thumbnailErrorSrc = displaySrc ?? null"
        />
      </button>
      <Dialog v-model:open="open">
        <DialogContent class="nc-image-dialog">
          <DialogTitle class="nc-image-dialog-title">{{ label }}</DialogTitle>
          <DialogDescription class="nc-ui-sr-only">{{ previewDescription }}</DialogDescription>
          <div class="nc-image-dialog-body nc-scrollbar-sleek">
            <img
              v-if="displaySrc && displaySrc !== dialogErrorSrc"
              :src="displaySrc"
              :alt="label"
              class="nc-image-dialog-img"
              @error="dialogErrorSrc = displaySrc"
            />
            <div v-else class="nc-image-chip" :title="label">
              <ImageIcon class="nc-image-chip-icon" aria-hidden="true" />
              <span class="nc-image-chip-name">{{ label }}</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </template>
    <div v-else class="nc-image-chip" :title="label">
      <ImageIcon class="nc-image-chip-icon" aria-hidden="true" />
      <span class="nc-image-chip-name">{{ label }}</span>
    </div>
  </div>
</template>

<style scoped>
.nc-image-preview {
  position: relative;
  width: 80px;
  height: 80px;
  flex-shrink: 0;
}
.nc-image-thumb {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 0;
  border-radius: 6px;
  border: 1px solid var(--nc-border);
  background: var(--nc-background);
  transition-property: color, background-color, border-color;
  transition-duration: 150ms;
}
.nc-image-thumb:hover {
  border-color: var(--nc-ring);
}
.nc-image-thumb:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-image-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.nc-image-chip {
  display: flex;
  max-width: 100%;
  align-items: center;
  gap: 6px;
  border-radius: 6px;
  border: 1px solid var(--nc-border);
  background: var(--nc-background);
  padding: 4px 8px;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
.nc-image-chip-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.nc-image-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-image-dialog {
  display: flex;
  max-height: 90vh;
  max-width: min(90vw, 56rem);
  flex-direction: column;
  gap: 12px;
  border-color: var(--nc-border);
  background: var(--nc-background);
  padding: 12px;
}
.nc-image-dialog-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 20px;
}
.nc-image-dialog-body {
  display: flex;
  min-height: 0;
  align-items: center;
  justify-content: center;
  overflow: auto;
  border-radius: 6px;
  background: color-mix(in srgb, var(--nc-muted) 20%, transparent);
  padding: 8px;
}
.nc-image-dialog-img {
  max-height: 75vh;
  max-width: 100%;
  object-fit: contain;
}
</style>
