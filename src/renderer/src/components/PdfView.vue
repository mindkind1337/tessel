<script setup>
// A PDF in an editor tab (pdf.js, Mozilla's PDF reader in JavaScript): its
// pages one under the other, drawn as they come into view, zoom to fit the
// width or by steps. Read-only; the file is read whole (local, SSH), and
// pdf.js never runs the PDF's scripts (isEvalSupported off, no XFA forms).
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { loadBytes } from '../office/bytes'
import { t } from '../i18n'

const props = defineProps({
  file: { type: String, required: true }
})

const error = ref('')
const loading = ref(true)
const pageCount = ref(0)
// null: fit the width of the tab; else a scale (1 = 100 %).
const zoom = ref(null)
const fitScale = ref(1)
const scale = computed(() => zoom.value || fitScale.value)
const pagesEl = ref(null)
const sizes = ref([]) // [{ w, h }] at scale 1, per page

let pdf = null
let observer = null
let resizeObs = null
const drawn = new Map() // page number -> scale it was drawn at

async function pdfjs() {
  const lib = await import('pdfjs-dist')
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  if (lib.GlobalWorkerOptions.workerSrc !== worker) lib.GlobalWorkerOptions.workerSrc = worker
  return lib
}

function close() {
  if (observer) observer.disconnect()
  observer = null
  drawn.clear()
  if (pdf) pdf.destroy().catch(() => {})
  pdf = null
}

let seq = 0
async function load() {
  const my = ++seq
  close()
  loading.value = true
  error.value = ''
  pageCount.value = 0
  sizes.value = []
  try {
    const r = await loadBytes(props.file)
    if (my !== seq) return
    if (r.error !== undefined) {
      error.value = r.error || t('editor.pdf.unreadable', 'This PDF could not be read.')
      return
    }
    const lib = await pdfjs()
    const doc = await lib.getDocument({ data: r.bytes, isEvalSupported: false, enableXfa: false }).promise
    if (my !== seq) {
      doc.destroy().catch(() => {})
      return
    }
    pdf = doc
    const list = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const vp = page.getViewport({ scale: 1 })
      list.push({ w: vp.width, h: vp.height })
    }
    if (my !== seq) return
    sizes.value = list
    pageCount.value = doc.numPages
    loading.value = false
    await nextTick()
    fit()
    watchPages()
  } catch {
    if (my === seq) error.value = t('editor.pdf.unreadable', 'This PDF could not be read.')
  } finally {
    if (my === seq) loading.value = false
  }
}

// The scale that fits the widest page in the tab.
function fit() {
  const el = pagesEl.value
  if (!el || !sizes.value.length) return
  const widest = Math.max(...sizes.value.map((s) => s.w))
  fitScale.value = Math.max(0.2, Math.min(4, (el.clientWidth - 48) / widest))
}

async function draw(n) {
  if (!pdf || drawn.get(n) === scale.value) return
  const s = scale.value
  drawn.set(n, s)
  const canvas = pagesEl.value && pagesEl.value.querySelector(`canvas[data-page="${n}"]`) // i18n-ignore
  if (!canvas) return
  const page = await pdf.getPage(n)
  const ratio = window.devicePixelRatio || 1
  const vp = page.getViewport({ scale: s * ratio })
  canvas.width = Math.floor(vp.width)
  canvas.height = Math.floor(vp.height)
  try {
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
  } catch {
    drawn.delete(n)
  }
}

function watchPages() {
  if (observer) observer.disconnect()
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) draw(Number(e.target.dataset.page))
    },
    { root: pagesEl.value, rootMargin: '600px 0px' }
  )
  for (const c of pagesEl.value.querySelectorAll('canvas[data-page]')) observer.observe(c)
}

// Zoom changed: the pages in view are drawn again at the new scale.
watch(scale, async () => {
  drawn.clear()
  await nextTick()
  watchPages()
})

const zoomText = computed(() => `${Math.round(scale.value * 100)} %`)
function zoomBy(step) {
  zoom.value = Math.max(0.25, Math.min(4, Math.round((scale.value + step) * 4) / 4))
}

watch(() => props.file, load)
onMounted(() => {
  load()
  resizeObs = new ResizeObserver(() => {
    if (!zoom.value) fit()
  })
  if (pagesEl.value) resizeObs.observe(pagesEl.value)
})
onBeforeUnmount(() => {
  seq++
  close()
  if (resizeObs) resizeObs.disconnect()
})
</script>

<template>
  <div class="pdf-view" data-test="pdf-view">
    <div class="pdf-bar">
      <span v-if="pageCount" class="pdf-pages" v-text="t('editor.pdf.pages', '{{count}} pages', { count: pageCount })"></span>
      <span class="pdf-spacer"></span>
      <button class="pdf-btn" :title="t('editor.pdf.zoomOut', 'Zoom out')" :aria-label="t('editor.pdf.zoomOut', 'Zoom out')" @click="zoomBy(-0.25)">−</button>
      <span class="pdf-zoom">{{ zoomText }}</span>
      <button class="pdf-btn" :title="t('editor.pdf.zoomIn', 'Zoom in')" :aria-label="t('editor.pdf.zoomIn', 'Zoom in')" @click="zoomBy(0.25)">+</button>
      <button class="pdf-btn" :class="{ active: !zoom }" @click="zoom = null">{{ t('editor.pdf.fitWidth', 'Fit width') }}</button>
    </div>
    <div ref="pagesEl" class="pdf-pages-wrap">
      <div v-if="error" class="fview-note error">{{ error }}</div>
      <div v-else-if="loading" class="fview-note">{{ t('editor.viewer.reading', 'Reading…') }}</div>
      <template v-else>
        <canvas
          v-for="(s, i) in sizes"
          :key="i"
          class="pdf-page"
          :data-page="i + 1"
          :style="{ width: `${Math.floor(s.w * scale)}px`, height: `${Math.floor(s.h * scale)}px` }"
        ></canvas>
      </template>
    </div>
  </div>
</template>
