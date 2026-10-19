<script setup>
// After Orca's NativeChatTranscriptChrome.tsx, NativeChatImageAttachments (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * A message's images: name chips, or thumbnails when previews are enabled.
 * Props: blocks (the message's prose blocks; only image-ref ones show),
 *   runtimeContext (worktree context; null = unresolved; leave unset when
 *   unknown), enablePreview (default: runtimeContext was given).
 * Renders nothing without images.
 * Tessel: a history message's other files (file-ref blocks) follow as file
 * chips (NativeChatFileChip). One viewer for all of them (a gallery: ← / →
 * between the images, Copy, Save as, Open in a tab). An image-ref with
 * `more` (and the more prop: a tool result's imagesMore) ends them with
 * "+N more images". variant 'tool': a tool result's images (bigger
 * thumbnails in a grid).
 * Exposed: openImage(n) — the viewer at the n-th image (1-based; "[Image #n]"
 *   in the message's text names it: pasted images first).
 */
import { computed, ref } from 'vue'
import { Image as ImageIcon } from 'lucide-vue-next'
import { t } from '../../../i18n'
import NativeChatTranscriptImagePreview from './NativeChatTranscriptImagePreview.vue'
import NativeChatImageLightbox from './NativeChatImageLightbox.vue'
import NativeChatFileChip from './NativeChatFileChip.vue'
import {
  basename,
  imageLabel,
  isNativeChatPastedImagePath,
  renderableImageSource,
  transcriptImageIdentity
} from './native-chat-transcript-visibility.js'

const props = defineProps({
  blocks: { type: Array, required: true },
  runtimeContext: { type: Object, default: undefined },
  enablePreview: { type: Boolean, default: (raw) => raw.runtimeContext !== undefined },
  more: { type: Number, default: 0 },
  variant: { type: String, default: 'message' }
})

// Keys stay unique when the same image appears twice.
const images = computed(() => {
  const counts = new Map()
  return props.blocks
    .filter((block) => block.type === 'image-ref' && !block.more)
    .map((image) => {
      const label = image.alt ?? image.path ?? image.url ?? 'Image'
      const keyBase = `${label}-${image.url ?? ''}-${image.path ?? ''}`
      const occurrence = counts.get(keyBase) ?? 0
      counts.set(keyBase, occurrence + 1)
      const name =
        image.source === 'pasted' || (image.path && isNativeChatPastedImagePath(image.path))
          ? t('chat.orca.composer.pastedImageLabel', 'Pasted image')
          : image.path
            ? basename(image.path)
            : label
      // Tessel: an image this window holds (a sent image's thumbnail) shows as one.
      const preview = props.enablePreview || renderableImageSource(image.url)
      return { image, label, name, keyBase, occurrence, preview }
    })
})
const moreCount = computed(
  () => (props.more > 0 ? props.more : 0) + props.blocks.reduce((n, b) => n + (b.type === 'image-ref' && b.more > 0 ? b.more : 0), 0)
)
const moreText = computed(() =>
  moreCount.value === 1
    ? t('chat.orca.image.moreOne', '+1 more image')
    : t('chat.orca.image.more', '+{{count}} more images', { count: moreCount.value })
)
const files = computed(() => props.blocks.filter((block) => block.type === 'file-ref'))

// The viewer's images: those that can show (not a file gone from disk).
// A host's or a local file is read again by the viewer (from the cache).
const gallery = computed(() =>
  images.value
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry }) => entry.preview && !entry.image.missing)
    .map(({ entry, i }) => {
      const img = entry.image
      const src = renderableImageSource(img.url) ? img.url : ''
      const path = src ? null : img.url?.trim() || img.path || null
      return { i, src, path, file: img.path && !img.missing ? img.path : null, label: imageLabel(img) }
    })
)
const galleryOpen = ref(false)
const galleryIndex = ref(0)
function openAt(i) {
  const at = gallery.value.findIndex((g) => g.i === i)
  if (at < 0) return false
  galleryIndex.value = at
  galleryOpen.value = true
  return true
}
const opener = (i) => () => openAt(i)

// "[Image #n]": the n-th pasted image when the message has pasted ones, else
// its n-th image. -> whether the viewer opened.
function openImage(n) {
  if (!Number.isSafeInteger(n) || n < 1) return false
  const pasted = images.value.map((entry, i) => ({ entry, i })).filter(({ entry }) => entry.image.source === 'pasted')
  const list = pasted.length ? pasted : images.value.map((entry, i) => ({ entry, i }))
  const hit = list[n - 1]
  return hit ? openAt(hit.i) : false
}
defineExpose({ openImage })
</script>

<template>
  <div
    v-if="images.length > 0 || files.length > 0 || moreCount > 0"
    :class="['nc-image-attachments', variant === 'tool' ? 'is-tool' : null]"
    :data-test="variant === 'tool' ? 'nc-tool-images' : undefined"
  >
    <template v-for="(entry, i) in images" :key="`${entry.keyBase}-${entry.preview ? transcriptImageIdentity(entry.image, runtimeContext) : ''}-${entry.occurrence}`">
      <NativeChatTranscriptImagePreview
        v-if="entry.preview"
        :block="entry.image"
        :runtime-context="runtimeContext"
        :on-open="opener(i)"
        :variant="variant"
      />
      <div v-else class="nc-image-chip" :title="entry.label" data-test="nc-image-chip">
        <ImageIcon class="nc-image-chip-icon" aria-hidden="true" />
        <span class="nc-image-chip-name">{{ entry.name }}</span>
      </div>
    </template>
    <div v-if="moreCount > 0" class="nc-image-chip nc-image-more" data-test="nc-image-more">{{ moreText }}</div>
    <NativeChatFileChip v-for="(file, i) in files" :key="`file-${i}-${file.path ?? ''}-${file.name}`" :block="file" />
    <NativeChatImageLightbox
      v-if="gallery.length"
      v-model:open="galleryOpen"
      v-model:index="galleryIndex"
      :items="gallery"
    />
  </div>
</template>

<style scoped>
.nc-image-attachments {
  margin-bottom: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.nc-image-attachments.is-tool {
  margin-bottom: 0;
  align-items: flex-start;
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
.nc-image-more {
  align-self: center;
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
