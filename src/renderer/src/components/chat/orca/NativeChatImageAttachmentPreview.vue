<script setup>
// After Orca's NativeChatImageAttachmentPreview.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
// An image attached in the composer, as a compact chip: a tiny thumbnail,
// the name (bold) and the pixel size (muted); × on hover removes it. A click
// shows the image full size (NativeChatImageLightbox).
// Props: attachment { id, name, width?, height?, previewUrl?, fullUrl?, pending? }.
// Emits: remove(id).
import { computed, ref } from 'vue'
import { Image as ImageIcon, Loader2, X } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { imagePixelSize } from '../../../chat/orca/native-chat-images.js'
import { renderableImageSource } from './native-chat-transcript-visibility.js'
import NativeChatImageLightbox from './NativeChatImageLightbox.vue'

const props = defineProps({
  attachment: { type: Object, required: true }
})
const emit = defineEmits(['remove'])

const isOpen = ref(false)
const isPending = computed(() => props.attachment.pending === true)
const thumbnailSrc = computed(() => {
  const src = props.attachment.previewUrl || props.attachment.fullUrl
  return renderableImageSource(src) ? src : ''
})
const fullSizeSrc = computed(() => props.attachment.fullUrl || props.attachment.previewUrl || '')
const name = computed(() => props.attachment.name || t('chat.orca.composer.pastedImageLabel', 'Pasted image'))
const size = computed(() => imagePixelSize(props.attachment.width, props.attachment.height))
const pendingLabel = computed(() => t('chat.orca.composer.imageSaving', 'Saving pasted image…'))
const viewLabel = computed(() =>
  isPending.value ? pendingLabel.value : `${t('chat.orca.composer.viewAttachment', 'View image')}: ${name.value}`
)
</script>

<template>
  <div class="nc-attachment" :class="{ 'is-pending': isPending }" data-test="chat-attachment">
    <button
      type="button"
      class="nc-attachment-chip"
      :aria-label="viewLabel"
      :aria-busy="isPending"
      :title="name"
      :disabled="isPending"
      @click="isOpen = true"
    >
      <span class="nc-attachment-thumb">
        <Loader2 v-if="isPending" class="nc-attachment-icon nc-animate-spin" />
        <img v-else-if="thumbnailSrc" :src="thumbnailSrc" alt="" class="nc-attachment-img" />
        <ImageIcon v-else class="nc-attachment-icon" />
      </span>
      <span class="nc-attachment-name" data-test="chat-attachment-name">{{ name }}</span>
      <span v-if="size" class="nc-attachment-size" data-test="chat-attachment-size">{{ size }}</span>
    </button>
    <button
      type="button"
      class="nc-attachment-remove"
      :aria-label="`${t('chat.orca.composer.removeAttachment', 'Remove attachment')}: ${name}`"
      :title="t('chat.orca.composer.removeAttachment', 'Remove attachment')"
      data-test="chat-attachment-remove"
      @click="emit('remove', attachment.id)"
    >
      <X class="nc-attachment-remove-icon" />
    </button>
  </div>
  <NativeChatImageLightbox v-model:open="isOpen" :src="fullSizeSrc" :label="name" />
</template>

<style scoped>
/* Compact image card: the reference uses small corners, not a pill. */
.nc-attachment {
  position: relative;
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  border: 1px solid color-mix(in srgb, var(--nc-muted-foreground) 20%, var(--nc-border));
  border-radius: 5px;
  background: color-mix(in srgb, var(--nc-foreground) 8%, var(--nc-background));
  font-size: 12px;
  line-height: 16px;
  transition: border-color 150ms;
}
.nc-attachment:hover {
  border-color: color-mix(in srgb, var(--nc-foreground) 25%, var(--nc-border));
}
.nc-attachment-chip {
  box-sizing: border-box;
  max-width: 100%;
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  padding: 3px 6px 3px 4px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--nc-foreground);
  font: inherit;
  cursor: pointer;
}
.nc-attachment-chip:disabled {
  cursor: default;
}
.nc-attachment-chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-attachment-thumb {
  display: inline-flex;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 2px;
}
.nc-attachment-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.nc-attachment-icon {
  width: 12px;
  height: 12px;
  color: var(--nc-muted-foreground);
}
.nc-attachment-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.nc-attachment-size {
  flex-shrink: 0;
  color: var(--nc-muted-foreground);
}
/* The × shows on hover (and on keyboard focus), over the end of the
   text: the chip keeps its size. */
.nc-attachment-remove {
  position: absolute;
  top: 50%;
  right: 3px;
  display: inline-flex;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: color-mix(in srgb, var(--nc-foreground) 8%, var(--nc-background));
  box-shadow: -6px 0 6px color-mix(in srgb, var(--nc-foreground) 8%, var(--nc-background));
  color: var(--nc-foreground);
  opacity: 0;
  pointer-events: none;
  transform: translateY(-50%);
  cursor: pointer;
  transition: opacity 120ms;
}
.nc-attachment:hover .nc-attachment-remove,
.nc-attachment-remove:focus-visible {
  opacity: 1;
  pointer-events: auto;
}
.nc-attachment-remove:hover {
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
.nc-attachment-remove:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-attachment-remove-icon {
  width: 10px;
  height: 10px;
}
</style>
