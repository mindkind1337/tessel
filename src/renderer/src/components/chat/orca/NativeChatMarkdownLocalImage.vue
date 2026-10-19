<script setup>
// Tessel: a picture an agent's answer names by its path (![shot](C:\p\shot.png),
// a relative one, an SSH host's): shown inline once near the viewport, read
// through ./native-chat-local-image-src.js (the chat's file context, a size
// cap). A click opens it in the window's image viewer (Tessel's link router).
// Until it is read, or when it cannot be (gone, too large, outside what this
// chat may read), the link it was stays: its text, opening the file.
// Props: path (the picture's data-local-src: a path, a file: URL or the
//   chat's file href), alt, variant ('document' | 'compact'), link (a
//   function giving the link's vnode).
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { t } from '../../../i18n'
import { useLocalImageSrc } from './native-chat-local-image-src.js'
import { observeTranscriptVisibility } from './native-chat-transcript-visibility.js'
import { openChatImage } from './native-chat-image-actions.js'

const props = defineProps({
  path: { type: String, required: true },
  alt: { type: String, default: '' },
  variant: { type: String, default: 'document' },
  link: { type: Function, required: true }
})

const near = ref(false)
const failed = ref(false)
const root = shallowRef(null)
const src = useLocalImageSrc(() => (near.value ? props.path : undefined))
const label = computed(() => props.alt.trim() || t('chat.orca.markdown.image', 'Image'))
const expandLabel = computed(() => t('chat.orca.markdown.expandImage', 'Expand image'))

let stop = null
onMounted(() => {
  if (root.value) stop = observeTranscriptVisibility(root.value, (v) => (near.value = near.value || v))
})
onBeforeUnmount(() => stop?.())

function open(event) {
  event.stopPropagation()
  event.preventDefault()
  if (src.value) openChatImage({ src: src.value }, { label: label.value, event })
}
const Link = () => props.link()
</script>

<template>
  <span ref="root" class="nc-md-local-image" :class="`is-${variant}`">
    <button
      v-if="src && !failed"
      type="button"
      class="nc-md-local-image__btn"
      :aria-label="`${expandLabel}: ${label}`"
      :title="label"
      data-test="nc-md-local-image"
      @click="open"
    >
      <img :src="src" :alt="alt" decoding="async" class="nc-md-local-image__img" @error="failed = true" />
    </button>
    <Link v-else />
  </span>
</template>

<style scoped>
.nc-md-local-image {
  display: inline;
}
.nc-md-local-image__btn {
  display: block;
  max-width: 100%;
  margin: 12px 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
  text-align: left;
}
.is-compact .nc-md-local-image__btn {
  margin: 4px 0;
}
.nc-md-local-image__img {
  max-width: 100%;
  max-height: 384px;
  object-fit: contain;
  border-radius: 6px;
  outline: 1px solid rgb(255 255 255 / 0.1);
}
.is-compact .nc-md-local-image__img {
  max-height: 128px;
  border-radius: 4px;
}
</style>
