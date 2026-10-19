<script setup>
// After Orca's NativeChatTranscriptChrome.tsx, TranscriptImagePreview (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * One image of a message: a thumbnail (opens a full-size dialog) while near
 * the viewport and loadable, else a chip with its name. The observed element
 * stays the same when the thumbnail appears (one root div).
 * Props: block (image-ref), runtimeContext (worktree context; undefined =
 *   pending: nothing read yet).
 * Tessel: a sent image's thumbnail is a data: URL made in the window
 * (chat/orca/native-chat-images.js), a history or tool image its own data:
 * URL; a path goes through ./native-chat-local-image-src.js (the chat's file
 * context: this computer's file, or the SSH host's over its connection).
 * A file no longer on disk (missing) is a calm chip saying so. onOpen (a
 * gallery's: NativeChatImageAttachments) opens the viewer at this image;
 * without it, its own NativeChatImageLightbox. variant 'tool': a bigger
 * thumbnail (a tool's screenshot).
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { Image as ImageIcon, ImageOff } from 'lucide-vue-next'
import { t } from '../../../i18n'
import NativeChatImageLightbox from './NativeChatImageLightbox.vue'
import { fullImageUrlFor } from '../../../chat/orca/native-chat-images.js'
import { useLocalImageSrc } from './native-chat-local-image-src.js'
import { imageLabel, observeTranscriptVisibility, renderableImageSource } from './native-chat-transcript-visibility.js'

const props = defineProps({
  block: { type: Object, required: true },
  runtimeContext: { type: Object, default: undefined },
  onOpen: { type: Function, default: undefined },
  variant: { type: String, default: 'message' }
})

const open = ref(false)
const near = ref(false)
const thumbnailErrorSrc = ref(null)
const root = shallowRef(null)

const missing = computed(() => props.block.missing === true)
const source = computed(() => props.block.url?.trim() || props.block.path)
const filePath = computed(() => props.block.path ?? source.value ?? '')
const external = computed(() => renderableImageSource(source.value))
const leaseActive = computed(() => near.value || open.value)
const localSrc = useLocalImageSrc(
  () =>
    leaseActive.value && !external.value && !missing.value && props.runtimeContext !== undefined
      ? source.value
      : undefined,
  () => filePath.value,
  () => props.runtimeContext?.connectionId,
  () => props.runtimeContext
)
const displaySrc = computed(() =>
  external.value && leaseActive.value ? source.value : localSrc.value
)
const label = computed(() => imageLabel(props.block))
const viewImageLabel = computed(() => t('chat.orca.composer.viewAttachment', 'View image'))
const missingText = computed(() => t('chat.orca.image.missing', 'Image no longer on disk'))
// Tessel: a sent image shows its thumbnail; the popup, the full image while
// this window still has it.
const fullSrc = computed(() => fullImageUrlFor(displaySrc.value) || displaySrc.value || '')

let stopObserving = null
onMounted(() => {
  if (root.value) stopObserving = observeTranscriptVisibility(root.value, (v) => (near.value = v))
})
onBeforeUnmount(() => stopObserving?.())

const showPreview = computed(
  () =>
    !missing.value &&
    leaseActive.value &&
    Boolean(displaySrc.value) &&
    displaySrc.value !== thumbnailErrorSrc.value &&
    Boolean(source.value)
)
function onClick() {
  if (props.onOpen) props.onOpen()
  else open.value = true
}
</script>

<template>
  <div ref="root" :class="{ 'nc-image-preview': showPreview, 'is-tool': showPreview && variant === 'tool' }">
    <template v-if="showPreview">
      <button
        type="button"
        class="nc-image-thumb"
        :aria-label="`${viewImageLabel}: ${label}`"
        :title="label"
        data-test="nc-image-thumb"
        @click="onClick"
      >
        <img
          :src="displaySrc"
          :alt="label"
          loading="lazy"
          decoding="async"
          class="nc-image-thumb-img"
          @error="thumbnailErrorSrc = displaySrc ?? null"
        />
      </button>
      <NativeChatImageLightbox v-if="!onOpen" v-model:open="open" :src="fullSrc" :label="label" />
    </template>
    <div v-else-if="missing" class="nc-image-chip is-missing" :title="`${label} — ${filePath}`" data-test="nc-image-missing">
      <ImageOff class="nc-image-chip-icon" aria-hidden="true" />
      <span class="nc-image-chip-name">{{ missingText }}</span>
    </div>
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
/* A tool's screenshot: wide enough to read what it shows at a glance. */
.nc-image-preview.is-tool {
  width: 160px;
  height: 104px;
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
  cursor: zoom-in;
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
.is-tool .nc-image-thumb-img {
  object-fit: contain;
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
.nc-image-chip.is-missing {
  border-style: dashed;
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
</style>
