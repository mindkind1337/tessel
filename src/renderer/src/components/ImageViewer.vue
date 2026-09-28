<!-- i18n-pending: text here does not go through t() yet -->
<script setup>
// An image shown over Tessel ([Image #N] clicked in a Claude Code pane):
// fitted to the window, full size on click (scroll to move around). Esc, a
// click beside it or ✕ closes it; "Open in viewer" hands it to the system's
// image app.
import { ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  src: { type: String, required: true },
  title: { type: String, default: 'Image' },
  file: { type: String, default: null }
})
const emit = defineEmits(['close'])

const fullSize = ref(false)
const size = ref('')
const closeBtn = ref(null)

function onLoad(e) {
  const img = e.target
  size.value = `${img.naturalWidth} × ${img.naturalHeight}`
}
function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}
function openOutside() {
  if (props.file && window.shellApi.openImageExternally) window.shellApi.openImageExternally(props.file)
}
onMounted(() => {
  window.addEventListener('keydown', onKey, true)
  if (closeBtn.value) closeBtn.value.focus()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div class="imgview-backdrop" role="dialog" aria-modal="true" :aria-label="title" @mousedown.self="emit('close')">
    <div class="imgview-bar">
      <span class="imgview-title">{{ title }}</span>
      <span v-if="size" class="imgview-size">{{ size }}</span>
      <span class="imgview-hint">{{ fullSize ? 'Click to fit' : 'Click to see full size' }}</span>
      <button v-if="file" type="button" class="imgview-btn" @click="openOutside">Open in viewer</button>
      <button ref="closeBtn" type="button" class="imgview-btn imgview-close" title="Close (Esc)" aria-label="Close" @click="emit('close')">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
    </div>
    <div class="imgview-stage" :class="{ full: fullSize }" @mousedown.self="emit('close')">
      <img :src="src" :alt="title" class="imgview-img" draggable="false" @load="onLoad" @click="fullSize = !fullSize" />
    </div>
  </div>
</template>
