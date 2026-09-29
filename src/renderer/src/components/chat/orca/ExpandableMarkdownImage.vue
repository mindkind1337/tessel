<script setup>
// After Orca's components/sidebar/MarkdownImageLightbox.tsx, ExpandableMarkdownImage (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Inline markdown image that opens a viewport-centered lightbox on click.
 * The dialog primitive owns modal focus, Escape, and focus restoration.
 * Props: src, alt, variant ('document': up to 384px high; 'compact': 128px,
 *   tighter margins — the reference passed these as class names).
 */
import { computed, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { Button, Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from './ui'

const props = defineProps({
  src: { type: String, required: true },
  alt: { type: String, default: undefined },
  variant: { type: String, default: 'document' }
})

const open = ref(false)
const label = computed(() => props.alt?.trim() || t('chat.orca.markdown.image', 'Image'))
const expandLabel = computed(() => t('chat.orca.markdown.expandImage', 'Expand image'))
const closeLabel = computed(() => t('chat.orca.markdown.close', 'Close'))
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <button
        type="button"
        class="nc-expand-trigger"
        :class="`is-${variant}`"
        :aria-label="expandLabel"
        @click="(event) => event.stopPropagation()"
      >
        <img :src="src" :alt="alt ?? ''" :class="['nc-expand-inline', `is-${variant}`]" />
      </button>
    </DialogTrigger>
    <DialogContent :show-close-button="false" class="nc-expand-dialog">
      <DialogTitle class="nc-ui-sr-only">{{ label }}</DialogTitle>
      <div class="nc-expand-head">
        <span class="nc-expand-label">{{ label }}</span>
        <DialogClose as-child>
          <Button type="button" variant="ghost" size="icon-sm" :aria-label="closeLabel">
            <X class="nc-expand-close-icon" />
          </Button>
        </DialogClose>
      </div>
      <div class="nc-expand-body">
        <img :src="src" :alt="label" class="nc-expand-full" />
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.nc-expand-trigger {
  display: block;
  max-width: 100%;
  margin: 12px 0;
  cursor: zoom-in;
  border: 0;
  background: transparent;
  padding: 0;
  text-align: left;
}
.nc-expand-trigger.is-compact {
  margin: 4px 0;
}
.nc-expand-inline {
  pointer-events: none;
  max-width: 100%;
  object-fit: contain;
}
.nc-expand-inline.is-document {
  max-height: 384px;
  border-radius: 6px;
  outline: 1px solid rgb(255 255 255 / 0.1);
}
.nc-expand-inline.is-compact {
  max-height: 128px;
  border-radius: 4px;
  outline: 1px solid color-mix(in srgb, var(--nc-border) 70%, transparent);
}
.nc-expand-dialog {
  display: flex;
  height: 90dvh;
  width: 90vw;
  max-width: 90vw;
  flex-direction: column;
  gap: 0;
  overflow: hidden;
  padding: 0;
}
.nc-expand-head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--nc-border);
  padding: 8px 12px;
}
.nc-expand-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  color: var(--nc-foreground);
}
.nc-expand-close-icon {
  width: 16px;
  height: 16px;
}
.nc-expand-body {
  display: flex;
  min-height: 0;
  flex: 1 1 0%;
  align-items: center;
  justify-content: center;
  overflow: auto;
  background: color-mix(in srgb, var(--nc-muted) 20%, transparent);
  padding: 16px;
}
.nc-expand-full {
  max-height: 100%;
  max-width: 100%;
  border-radius: 6px;
  object-fit: contain;
}
</style>
