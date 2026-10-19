<script setup>
// An image at its natural size (scaled down to fit the window), in a popup
// over a dimmed backdrop. Esc, the round × or a click on the backdrop closes
// it; focus goes into it and back to what opened it (Dialog).
// Props: open (v-model:open), src (a blob:/data: URL made in the window,
//   never a file path), label (the image's name).
// Tessel: a gallery (items, v-model:index): every image of a message or of a
//   tool's result, ← / → (or the arrows) between them. An item is { src?,
//   path?, label, file? }: src shown as is; else its path read like a
//   thumbnail's (native-chat-local-image-src.js, a host's over its
//   connection); file: the path to open in an image tab when it has one.
//   The bar under it: Copy image, Save as…, Open in an image tab
//   (native-chat-image-actions.js).
import { computed, inject, ref, toValue, watch } from 'vue'
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, X } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui'
import { renderableImageSource } from './native-chat-transcript-visibility.js'
import { localImageTarget, useLocalImageSrc } from './native-chat-local-image-src.js'
import { copyChatImage, openChatImageInTab, saveChatImage } from './native-chat-image-actions.js'
import { fullImageUrlFor } from '../../../chat/orca/native-chat-images.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  src: { type: String, default: '' },
  label: { type: String, default: '' },
  items: { type: Array, default: null },
  index: { type: Number, default: 0 }
})
const emit = defineEmits(['update:open', 'update:index'])

const count = computed(() => (Array.isArray(props.items) ? props.items.length : 0))
const at = computed(() => (count.value ? Math.min(Math.max(0, props.index), count.value - 1) : 0))
const item = computed(() => (count.value ? props.items[at.value] || {} : { src: props.src, label: props.label }))
const shownLabel = computed(() => item.value.label || props.label || t('chat.orca.markdown.image', 'Image'))
// An item known by its path only: read while it shows.
const pathSrc = useLocalImageSrc(() => (props.open && !item.value.src && item.value.path ? item.value.path : undefined))
const rawSrc = computed(() => (item.value.src ? fullImageUrlFor(item.value.src) || item.value.src : pathSrc.value || ''))
const safeSrc = computed(() => (renderableImageSource(rawSrc.value) ? rawSrc.value : ''))
const positionText = computed(() => t('chat.orca.imageLightbox.position', '{{n}} of {{total}}', { n: at.value + 1, total: count.value }))
const closeLabel = computed(() => t('chat.orca.imageLightbox.close', 'Close image preview'))

function go(step) {
  if (count.value < 2) return
  emit('update:index', (at.value + step + count.value) % count.value)
}
function onKeydown(event) {
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    go(-1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    go(1)
  }
}

// A short word after an action ("Copied", "Saved"), then the bar again.
const status = ref('')
let statusTimer = null
function say(text) {
  status.value = text
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => (status.value = ''), 2500)
}
watch(
  () => [props.open, at.value],
  () => (status.value = '')
)
async function copy() {
  say((await copyChatImage(safeSrc.value)) ? t('chat.orca.imageLightbox.copied', 'Image copied') : t('chat.orca.imageLightbox.copyFailed', 'The image could not be copied.'))
}
async function save() {
  const res = await saveChatImage(safeSrc.value, shownLabel.value)
  if (res && res.ok) say(t('chat.orca.imageLightbox.saved', 'Image saved'))
  else if (!res || !res.canceled) say(res && res.error ? res.error : t('chat.orca.imageLightbox.saveFailed', 'The image could not be saved.'))
}
// Its own file, as the chat's file context reads it (a host's path becomes
// its ssh:// one); none: a copy is opened.
const fileContext = inject('nativeChatFileLinkContext', null)
const localFiles = inject('nativeChatLocalFiles', true)
async function openInTab() {
  const file = item.value.file ? localImageTarget(item.value.file, toValue(fileContext), { localFiles: toValue(localFiles) !== false }) : null
  const opened = await openChatImageInTab({ src: safeSrc.value, path: file, label: shownLabel.value })
  if (opened) emit('update:open', false)
  else say(t('chat.orca.imageLightbox.openFailed', 'The image could not be opened in a tab.'))
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent :show-close-button="false" class="nc-lightbox" data-test="chat-image-lightbox" @keydown="onKeydown">
      <DialogTitle class="nc-ui-sr-only">{{ shownLabel }}</DialogTitle>
      <DialogDescription class="nc-ui-sr-only">
        {{ t('chat.orca.composer.imagePreview', 'Full-size image preview') }}
      </DialogDescription>
      <div class="nc-lightbox-stage">
        <button
          v-if="count > 1"
          type="button"
          class="nc-lightbox-nav is-prev"
          :aria-label="t('chat.orca.imageLightbox.previous', 'Previous image')"
          :title="t('chat.orca.imageLightbox.previous', 'Previous image')"
          data-test="chat-image-lightbox-prev"
          @click="go(-1)"
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <img v-if="safeSrc" :src="safeSrc" :alt="shownLabel" class="nc-lightbox-img" decoding="async" />
        <div v-else class="nc-lightbox-empty">
          {{ t('chat.orca.composer.imagePreviewUnavailable', 'Preview unavailable') }}
        </div>
        <button
          v-if="count > 1"
          type="button"
          class="nc-lightbox-nav is-next"
          :aria-label="t('chat.orca.imageLightbox.next', 'Next image')"
          :title="t('chat.orca.imageLightbox.next', 'Next image')"
          data-test="chat-image-lightbox-next"
          @click="go(1)"
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
      <div class="nc-lightbox-bar">
        <span class="nc-lightbox-label" :title="shownLabel">{{ shownLabel }}</span>
        <span v-if="count > 1" class="nc-lightbox-count" data-test="chat-image-lightbox-count">{{ positionText }}</span>
        <span v-if="status" class="nc-lightbox-status" role="status" data-test="chat-image-lightbox-status">{{ status }}</span>
        <template v-if="safeSrc">
          <button type="button" class="nc-lightbox-action" data-test="chat-image-lightbox-copy" @click="copy">
            <Copy aria-hidden="true" />{{ t('chat.orca.imageLightbox.copy', 'Copy image') }}
          </button>
          <button type="button" class="nc-lightbox-action" data-test="chat-image-lightbox-save" @click="save">
            <Download aria-hidden="true" />{{ t('chat.orca.imageLightbox.saveAs', 'Save as…') }}
          </button>
          <button type="button" class="nc-lightbox-action" data-test="chat-image-lightbox-tab" @click="openInTab">
            <ExternalLink aria-hidden="true" />{{ t('chat.orca.imageLightbox.openInTab', 'Open in a tab') }}
          </button>
        </template>
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
.nc-lightbox-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.nc-lightbox-img {
  display: block;
  max-width: calc(100vw - 64px);
  max-height: calc(100vh - 108px);
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
.nc-lightbox-nav {
  position: absolute;
  top: 50%;
  display: flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  padding: 0;
  transform: translateY(-50%);
  border: 1px solid rgb(255 255 255 / 0.18);
  border-radius: 9999px;
  background: rgb(30 30 30 / 0.85);
  color: #e6e6e6;
  cursor: pointer;
}
.nc-lightbox-nav svg {
  width: 18px;
  height: 18px;
}
.nc-lightbox-nav.is-prev {
  left: 8px;
}
.nc-lightbox-nav.is-next {
  right: 8px;
}
.nc-lightbox-nav:hover {
  background: #3a3a3a;
}
.nc-lightbox-nav:focus-visible,
.nc-lightbox-action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring, #6aa0ff);
}
.nc-lightbox-bar {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 2px 0;
  font-size: 12px;
  line-height: 16px;
  color: #cfcfcf;
}
.nc-lightbox-label {
  min-width: 0;
  max-width: 40ch;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-lightbox-count,
.nc-lightbox-status {
  flex-shrink: 0;
  color: #9a9a9a;
}
.nc-lightbox-action {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid rgb(255 255 255 / 0.14);
  border-radius: 6px;
  background: transparent;
  color: #e6e6e6;
  font: inherit;
  cursor: pointer;
}
.nc-lightbox-action svg {
  width: 13px;
  height: 13px;
}
.nc-lightbox-action:hover {
  background: rgb(255 255 255 / 0.08);
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
