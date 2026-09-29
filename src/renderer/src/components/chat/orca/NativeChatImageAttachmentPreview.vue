<script setup>
// After Orca's NativeChatImageAttachmentPreview.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
// Thumbnail for a pending image, with an in-app full-size preview on click.
// Props: attachment { id, path, connectionId?, previewUrl?, pending? }.
// Emits: remove(id).
// Tessel: only shown when the composer allows images (allowImages).
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { Image as ImageIcon, Loader2, X } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { getRuntimePathBasename } from '../../../chat/orca/shared/cross-platform-path.js'
import Dialog from './ui/Dialog.vue'
import DialogContent from './ui/DialogContent.vue'
import DialogDescription from './ui/DialogDescription.vue'
import DialogTitle from './ui/DialogTitle.vue'
import { useLocalImageSrc } from './native-chat-local-image-src.js'

const props = defineProps({
  attachment: { type: Object, required: true }
})
const emit = defineEmits(['remove'])

const isOpen = ref(false)
const isNearViewport = ref(false)
const thumbnailRef = shallowRef(null)
let observer = null
onMounted(() => {
  const element = thumbnailRef.value
  if (!element) return
  if (typeof IntersectionObserver === 'undefined') {
    isNearViewport.value = true
    return
  }
  observer = new IntersectionObserver(
    ([entry]) => {
      if (entry?.isIntersecting) {
        isNearViewport.value = true
        observer?.disconnect()
      }
    },
    { rootMargin: '128px' }
  )
  observer.observe(element)
})
onBeforeUnmount(() => observer?.disconnect())

const isPending = computed(() => props.attachment.pending === true)
const localSrc = useLocalImageSrc(
  () => (!isPending.value && (isNearViewport.value || isOpen.value) ? props.attachment.path : undefined),
  () => props.attachment.path,
  () => props.attachment.connectionId
)
// The clipboard thumbnail is already in this process, so it renders with no
// round-trip; the on-disk file only wins for the full-size dialog.
const thumbnailSrc = computed(() => props.attachment.previewUrl ?? localSrc.value)
const fullSizeSrc = computed(() => localSrc.value ?? props.attachment.previewUrl)
// The reference's isNativeChatPastedImagePath (its module imports a terminal
// helper Tessel does not have).
const isPastedImage = computed(() => /^orca-paste-.+\.png$/i.test(getRuntimePathBasename(props.attachment.path)))
const filename = computed(() =>
  isPastedImage.value
    ? t('chat.orca.composer.pastedImageLabel', 'Pasted image')
    : getRuntimePathBasename(props.attachment.path)
)
const pendingLabel = computed(() => t('chat.orca.composer.imageSaving', 'Saving pasted image…'))
const label = computed(() => (isPending.value ? pendingLabel.value : filename.value))
const viewLabel = computed(() =>
  isPending.value
    ? pendingLabel.value
    : `${t('chat.orca.composer.viewAttachment', 'View image')}: ${label.value}`
)
</script>

<template>
  <div ref="thumbnailRef" class="nc-attachment">
    <button
      type="button"
      class="nc-attachment-thumb"
      :aria-label="viewLabel"
      :aria-busy="isPending"
      :title="label"
      @click="isOpen = true"
    >
      <img
        v-if="thumbnailSrc"
        :src="thumbnailSrc"
        :alt="label"
        :class="['nc-attachment-img', { 'nc-attachment-img--pending': isPending }]"
      />
      <ImageIcon v-else class="nc-attachment-icon" />
    </button>
    <span v-if="isPending" class="nc-attachment-pending">
      <Loader2 class="nc-attachment-spinner nc-animate-spin" />
    </span>
    <button
      type="button"
      class="nc-attachment-remove"
      :aria-label="t('chat.orca.composer.removeAttachment', 'Remove attachment')"
      @click="emit('remove', attachment.id)"
    >
      <X class="nc-attachment-remove-icon" />
    </button>
  </div>
  <Dialog v-model:open="isOpen">
    <DialogContent class="nc-attachment-dialog">
      <DialogTitle class="nc-attachment-dialog-title">{{ label }}</DialogTitle>
      <DialogDescription class="nc-ui-sr-only">
        {{ t('chat.orca.composer.imagePreview', 'Full-size image preview') }}
      </DialogDescription>
      <div class="nc-attachment-dialog-body nc-ui-scrollbar-sleek">
        <img v-if="fullSizeSrc" :src="fullSizeSrc" :alt="label" class="nc-attachment-full" />
        <div v-else class="nc-attachment-empty">
          <template v-if="isPending">
            <Loader2 class="nc-attachment-empty-icon nc-animate-spin" />
            {{ pendingLabel }}
          </template>
          <template v-else>
            <ImageIcon class="nc-attachment-empty-icon" />
            {{ t('chat.orca.composer.imagePreviewUnavailable', 'Preview unavailable') }}
          </template>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
/* relative size-14 shrink-0 */
.nc-attachment {
  position: relative;
  width: 56px;
  height: 56px;
  flex-shrink: 0;
}
/* flex size-full items-center justify-center overflow-hidden rounded-md border
   border-border bg-background transition-colors hover:border-ring
   focus-visible:ring-2 focus-visible:ring-ring */
.nc-attachment-thumb {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--nc-border);
  border-radius: 6px;
  background: var(--nc-background);
  cursor: pointer;
  transition: color 150ms, background-color 150ms, border-color 150ms;
}
.nc-attachment-thumb:hover {
  border-color: var(--nc-ring);
}
.nc-attachment-thumb:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-attachment-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.nc-attachment-img--pending {
  opacity: 0.5;
}
/* size-5 text-muted-foreground */
.nc-attachment-icon {
  width: 20px;
  height: 20px;
  color: var(--nc-muted-foreground);
}
/* pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/50 */
.nc-attachment-pending {
  pointer-events: none;
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: color-mix(in srgb, var(--nc-background) 50%, transparent);
}
.nc-attachment-spinner {
  width: 16px;
  height: 16px;
  color: var(--nc-muted-foreground);
}
/* absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full
   border border-border bg-background text-muted-foreground shadow-xs
   hover:bg-accent hover:text-accent-foreground */
.nc-attachment-remove {
  position: absolute;
  right: -6px;
  top: -6px;
  display: flex;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--nc-border);
  border-radius: 9999px;
  background: var(--nc-background);
  color: var(--nc-muted-foreground);
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  cursor: pointer;
  transition: color 150ms, background-color 150ms;
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
  width: 12px;
  height: 12px;
}
/* flex max-h-[90vh] max-w-[90vw] flex-col gap-3 border-border bg-background p-3 sm:max-w-4xl */
.nc-attachment-dialog {
  display: flex;
  max-height: 90vh;
  max-width: 90vw;
  flex-direction: column;
  gap: 12px;
  border-color: var(--nc-border);
  background: var(--nc-background);
  padding: 12px;
}
@media (min-width: 640px) {
  .nc-attachment-dialog {
    max-width: 56rem;
  }
}
/* truncate text-sm */
.nc-attachment-dialog-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 20px;
}
/* flex min-h-0 items-center justify-center overflow-auto rounded-md bg-muted/20 p-2 */
.nc-attachment-dialog-body {
  display: flex;
  min-height: 0;
  align-items: center;
  justify-content: center;
  overflow: auto;
  border-radius: 6px;
  background: color-mix(in srgb, var(--nc-muted) 20%, transparent);
  padding: 8px;
}
.nc-attachment-full {
  max-height: 75vh;
  max-width: 100%;
  object-fit: contain;
}
/* flex items-center gap-2 py-12 text-sm text-muted-foreground */
.nc-attachment-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 48px 0;
  font-size: 14px;
  line-height: 20px;
  color: var(--nc-muted-foreground);
}
.nc-attachment-empty-icon {
  width: 16px;
  height: 16px;
}
</style>
