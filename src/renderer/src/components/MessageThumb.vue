<script setup>
// One image a message holds or names, as a thumbnail outside the chat (the
// Conversations tab and its Media view, Past conversations): WP3's images
// contract (historyAttachments.js) { key, dataUrl?, name, mime, bytes } |
// { path, missing: true } | { path, remote: true }, or a local image file
// (path). Its bytes are asked for only once it comes into view (load(image)
// -> { ok, dataUrl }), never before; a click opens it in Tessel's image viewer
// (the link router's lightbox).
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ImageIcon, ImageOff } from 'lucide-vue-next'
import { openTarget } from '../links/openTarget'
import { t } from '../i18n'

const props = defineProps({
  image: { type: Object, required: true },
  // image -> Promise<{ ok, dataUrl }> (null: only an image given with its data shows).
  load: { type: Function, default: null },
  size: { type: Number, default: 64 }
})

const src = ref(typeof props.image.dataUrl === 'string' && props.image.dataUrl.startsWith('data:image/') ? props.image.dataUrl : '')
const failed = ref(false)
const el = ref(null)
let observer = null
let asked = false

const gone = computed(() => !!props.image.missing)
const remote = computed(() => !!props.image.remote)
const name = computed(() => props.image.name || String(props.image.path || '').split(/[\\/]/).pop() || t('conversations.media.image', 'Image'))
const title = computed(() =>
  gone.value
    ? t('conversations.media.imageGone', '{{name}}: no longer on this computer', { name: name.value })
    : remote.value
      ? t('conversations.media.imageRemote', '{{name}}: on the SSH host', { name: name.value })
      : name.value
)

async function fetchIt() {
  if (asked || src.value || gone.value || remote.value || typeof props.load !== 'function') return
  asked = true
  try {
    const res = await props.load(props.image)
    if (res && res.ok && typeof res.dataUrl === 'string' && res.dataUrl.startsWith('data:image/')) src.value = res.dataUrl
    else failed.value = true
  } catch {
    failed.value = true
  }
}
function watchView() {
  if (src.value || !el.value) return
  if (typeof IntersectionObserver !== 'function') return void fetchIt()
  observer = new IntersectionObserver(
    (list) => {
      if (list.some((x) => x.isIntersecting)) {
        observer.disconnect()
        observer = null
        fetchIt()
      }
    },
    { rootMargin: '200px' }
  )
  observer.observe(el.value)
}
onMounted(watchView)
onBeforeUnmount(() => observer && observer.disconnect())
watch(
  () => props.image,
  (img) => {
    if (img && typeof img.dataUrl === 'string' && img.dataUrl.startsWith('data:image/')) src.value = img.dataUrl
  }
)

function open(event) {
  event.stopPropagation()
  if (src.value) openTarget({ src: src.value }, { event, label: name.value })
}
</script>

<template>
  <button
    ref="el"
    type="button"
    class="mt-thumb"
    :class="{ gone: gone || remote || failed, loaded: !!src }"
    :style="{ width: size + 'px', height: size + 'px' }"
    :title="title"
    :aria-label="title"
    :disabled="!src"
    data-test="message-thumb"
    @click="open"
  >
    <img v-if="src" :src="src" :alt="name" class="mt-img" loading="lazy" />
    <ImageOff v-else-if="gone || failed" :size="16" aria-hidden="true" />
    <ImageIcon v-else :size="16" aria-hidden="true" />
  </button>
</template>

<style scoped>
.mt-thumb {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-dim);
  cursor: zoom-in;
}
.mt-thumb:disabled {
  cursor: default;
}
.mt-thumb.gone {
  border-style: dashed;
}
.mt-thumb:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.mt-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
