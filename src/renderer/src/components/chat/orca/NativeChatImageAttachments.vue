<script setup>
// After Orca's NativeChatTranscriptChrome.tsx, NativeChatImageAttachments (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * A message's images: name chips, or thumbnails when previews are enabled.
 * Props: blocks (the message's prose blocks; only image-ref ones show),
 *   runtimeContext (worktree context; null = unresolved; leave unset when
 *   unknown), enablePreview (default: runtimeContext was given).
 * Renders nothing without images.
 */
import { computed } from 'vue'
import { Image as ImageIcon } from 'lucide-vue-next'
import { t } from '../../../i18n'
import NativeChatTranscriptImagePreview from './NativeChatTranscriptImagePreview.vue'
import {
  basename,
  isNativeChatPastedImagePath,
  renderableImageSource,
  transcriptImageIdentity
} from './native-chat-transcript-visibility.js'

const props = defineProps({
  blocks: { type: Array, required: true },
  runtimeContext: { type: Object, default: undefined },
  enablePreview: { type: Boolean, default: (raw) => raw.runtimeContext !== undefined }
})

// Keys stay unique when the same image appears twice.
const images = computed(() => {
  const counts = new Map()
  return props.blocks
    .filter((block) => block.type === 'image-ref')
    .map((image) => {
      const label = image.alt ?? image.path ?? image.url ?? 'Image'
      const keyBase = `${label}-${image.url ?? ''}-${image.path ?? ''}`
      const occurrence = counts.get(keyBase) ?? 0
      counts.set(keyBase, occurrence + 1)
      const name =
        image.path && isNativeChatPastedImagePath(image.path)
          ? t('chat.orca.composer.pastedImageLabel', 'Pasted image')
          : image.path
            ? basename(image.path)
            : label
      // Tessel: an image this window holds (a sent image's thumbnail) shows as one.
      const preview = props.enablePreview || renderableImageSource(image.url)
      return { image, label, name, keyBase, occurrence, preview }
    })
})
</script>

<template>
  <div v-if="images.length > 0" class="nc-image-attachments">
    <template v-for="entry in images" :key="`${entry.keyBase}-${entry.preview ? transcriptImageIdentity(entry.image, runtimeContext) : ''}-${entry.occurrence}`">
      <NativeChatTranscriptImagePreview v-if="entry.preview" :block="entry.image" :runtime-context="runtimeContext" />
      <div v-else class="nc-image-chip" :title="entry.label" data-test="nc-image-chip">
        <ImageIcon class="nc-image-chip-icon" aria-hidden="true" />
        <span class="nc-image-chip-name">{{ entry.name }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.nc-image-attachments {
  margin-bottom: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
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
</style>
