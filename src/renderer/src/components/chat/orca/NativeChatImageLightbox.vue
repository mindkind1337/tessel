<script setup>
// An attached image at its natural size (scaled down to fit the window), in
// a popup over a dimmed backdrop. Esc, the round × or a click on the backdrop
// closes it; focus goes into it and back to what opened it (Dialog).
// Props: open (v-model:open), src (a blob:/data: URL made in the window,
//   never a file path), label (the image's name).
import { computed } from 'vue'
import { X } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui'
import { renderableImageSource } from './native-chat-transcript-visibility.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  src: { type: String, default: '' },
  label: { type: String, default: '' }
})
const emit = defineEmits(['update:open'])

const safeSrc = computed(() => (renderableImageSource(props.src) ? props.src : ''))
const closeLabel = computed(() => t('chat.orca.imageLightbox.close', 'Close image preview'))
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent :show-close-button="false" class="nc-lightbox" data-test="chat-image-lightbox">
      <DialogTitle class="nc-ui-sr-only">{{ label }}</DialogTitle>
      <DialogDescription class="nc-ui-sr-only">
        {{ t('chat.orca.composer.imagePreview', 'Full-size image preview') }}
      </DialogDescription>
      <img v-if="safeSrc" :src="safeSrc" :alt="label" class="nc-lightbox-img" />
      <div v-else class="nc-lightbox-empty">
        {{ t('chat.orca.composer.imagePreviewUnavailable', 'Preview unavailable') }}
      </div>
      <DialogClose class="nc-lightbox-close" :aria-label="closeLabel" :title="closeLabel" data-test="chat-image-lightbox-close">
        <X class="nc-lightbox-close-icon" aria-hidden="true" />
      </DialogClose>
    </DialogContent>
  </Dialog>
</template>

<style>
/* Teleported to <body>: not scoped. The panel hugs the image. */
.nc-ui-dialog-content.nc-lightbox {
  display: block;
  width: auto;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  padding: 8px;
  border-radius: 12px;
  background: rgba(20, 20, 20, 0.97);
  overflow: visible;
}
.nc-lightbox-img {
  display: block;
  max-width: calc(100vw - 64px);
  max-height: calc(100vh - 64px);
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 6px;
}
.nc-lightbox-empty {
  padding: 48px 64px;
  font-size: 13px;
  color: var(--nc-muted-foreground, #9a9a9a);
}
.nc-lightbox-close {
  position: absolute;
  top: -10px;
  right: -10px;
  display: flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid rgb(255 255 255 / 0.18);
  border-radius: 9999px;
  background: #2a2a2a;
  color: #e6e6e6;
  cursor: pointer;
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.4);
}
.nc-lightbox-close:hover {
  background: #3a3a3a;
}
.nc-lightbox-close:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring, #6aa0ff);
}
.nc-lightbox-close-icon {
  width: 14px;
  height: 14px;
}
</style>
