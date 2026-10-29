<script setup>
// An audio or video file in an editor tab: Chromium's own player (read whole
// into a blob: URL, so a file of an SSH project plays too; the size cap of
// an image applies).
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { loadBytes } from '../office/bytes'
import { t } from '../i18n'

const props = defineProps({
  file: { type: String, required: true },
  // 'audio' | 'video'
  kind: { type: String, required: true }
})

const url = ref('')
const error = ref('')
const loading = ref(true)

function release() {
  if (url.value) URL.revokeObjectURL(url.value)
  url.value = ''
}
let seq = 0
async function load() {
  const my = ++seq
  release()
  loading.value = true
  error.value = ''
  const r = await loadBytes(props.file)
  if (my !== seq) return
  loading.value = false
  if (r.error !== undefined) {
    error.value = r.error || t('editor.media.unreadable', 'This file could not be read.')
    return
  }
  url.value = URL.createObjectURL(new Blob([r.bytes], { type: r.mime }))
}
function failed() {
  error.value = t('editor.media.cannotPlay', 'This file cannot be played here (its format is not supported).')
}
watch(() => props.file, load)
onMounted(load)
onBeforeUnmount(() => {
  seq++
  release()
})
</script>

<template>
  <div class="media-view" data-test="media-view">
    <div v-if="error" class="fview-note error">{{ error }}</div>
    <div v-else-if="loading" class="fview-note">{{ t('editor.viewer.reading', 'Reading…') }}</div>
    <video v-else-if="kind === 'video' && url" :src="url" controls @error="failed"></video>
    <audio v-else-if="url" :src="url" controls @error="failed"></audio>
  </div>
</template>
