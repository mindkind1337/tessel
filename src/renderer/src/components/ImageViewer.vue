<script setup>
// An image shown over Tessel ([Image #N] clicked in a Claude Code pane):
// fitted to the window, full size on click (scroll to move around). Esc, a
// click beside it or ✕ closes it; "Open in viewer" hands it to the system's
// image app.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'

const props = defineProps({
  src: { type: String, required: true },
  title: { type: String, default: null },
  file: { type: String, default: null }
})
const emit = defineEmits(['close'])
const shownTitle = computed(() => props.title || t('editor.image.title', 'Image'))

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
  <!-- A card in the middle of the window, below its title bar: the window's
       own close button never sits where this viewer's is (closing Tessel by
       mistake). Esc, the card's ×, or a click beside it closes it. -->
  <div class="imgview-backdrop" role="dialog" aria-modal="true" :aria-label="shownTitle" @mousedown.self="emit('close')">
    <div class="imgview-card">
    <div class="imgview-bar">
      <span class="imgview-title">{{ shownTitle }}</span>
      <span v-if="size" class="imgview-size">{{ size }}</span>
      <span class="imgview-hint">{{
        fullSize ? t('editor.image.clickToFit', 'Click to fit') : t('editor.image.clickFullSize', 'Click to see full size')
      }}</span>
      <button v-if="file" type="button" class="imgview-btn" @click="openOutside">
        {{ t('editor.image.openInViewer', 'Open in viewer') }}
      </button>
      <button
        ref="closeBtn"
        type="button"
        class="imgview-btn imgview-close"
        :title="t('editor.image.closeEsc', 'Close (Esc)')"
        :aria-label="t('editor.image.close', 'Close')"
        @click="emit('close')"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
    </div>
    <div class="imgview-stage" :class="{ full: fullSize }" @mousedown.self="emit('close')">
      <img :src="src" :alt="shownTitle" class="imgview-img" draggable="false" @load="onLoad" @click="fullSize = !fullSize" />
    </div>
    </div>
  </div>
</template>
