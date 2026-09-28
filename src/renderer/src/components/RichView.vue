<!-- i18n-pending: text here does not go through t() yet -->
<script setup>
// The rendered view of an editor tab (Orca's view modes, after its
// MarkdownPreview.tsx, MermaidViewer, CsvViewer and ImageViewer; MIT,
// Copyright (c) 2026 Lovecast Inc.): Markdown (sanitized with DOMPurify,
// Mermaid blocks drawn), a Mermaid diagram, a CSV/TSV table, or an image.
// The text comes from the tab's document, so it follows unsaved edits.
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { parseTable } from '../../../shared/fileKinds'
import { renderMarkdown, renderMermaid } from '../markdownView'
import { resolveFrom } from '../../../shared/viewPaths'

const props = defineProps({
  file: { type: String, required: true },
  // 'markdown' | 'mermaid' | 'table' | 'image'
  kind: { type: String, required: true },
  text: { type: String, default: '' }
})
const emit = defineEmits(['open'])

const bodyEl = ref(null)
const markdownHtml = computed(() => (props.kind === 'markdown' ? renderMarkdown(props.text) : ''))
const table = computed(() => {
  if (props.kind !== 'table') return null
  const { rows } = parseTable(props.text, props.file)
  return { head: rows[0] || [], body: rows.slice(1, 5001), more: Math.max(0, rows.length - 5001) }
})
const mermaidSvg = ref('')
const mermaidError = ref('')
const imageUrl = ref('')
const imageError = ref('')

function isDark() {
  const c = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)
  if (!c) return true
  const [r, g, b] = c.map(Number)
  return 0.299 * r + 0.587 * g + 0.114 * b < 128
}

let drawSeq = 0
async function afterRender() {
  const my = ++drawSeq
  if (props.kind === 'mermaid') {
    mermaidError.value = ''
    const r = await renderMermaid(props.text, { dark: isDark() })
    if (my !== drawSeq) return
    if (r.error) mermaidError.value = r.error
    else mermaidSvg.value = r.svg
    return
  }
  const root = bodyEl.value
  if (!root || props.kind !== 'markdown') return
  for (const el of root.querySelectorAll('.md-mermaid[data-mermaid]')) {
    let src = ''
    try {
      src = decodeURIComponent(el.getAttribute('data-mermaid') || '')
    } catch {
      src = ''
    }
    el.removeAttribute('data-mermaid')
    renderMermaid(src, { dark: isDark() }).then((r) => {
      if (r.error) {
        el.classList.add('error')
        el.textContent = `Diagram error: ${r.error}`
      } else el.innerHTML = r.svg
    })
  }
  for (const img of root.querySelectorAll('img[data-local-src]')) {
    const target = resolveFrom(props.file, img.getAttribute('data-local-src'))
    img.removeAttribute('data-local-src')
    if (!target || !window.shellApi.viewImage) continue
    window.shellApi.viewImage(target).then((r) => {
      if (r && r.ok && r.dataUrl) img.setAttribute('src', r.dataUrl)
    })
  }
}

async function loadImage() {
  imageUrl.value = ''
  imageError.value = ''
  let r = null
  try {
    r = window.shellApi && window.shellApi.viewImage ? await window.shellApi.viewImage(props.file) : null
  } catch (err) {
    r = { ok: false, error: err && err.message }
  }
  if (r && r.ok && r.dataUrl) imageUrl.value = r.dataUrl
  else imageError.value = (r && r.error) || 'The image could not be read.'
}

let renderTimer = 0
watch(
  () => [props.text, props.kind],
  () => {
    // Typing in Source, then back: render once the text settles.
    clearTimeout(renderTimer)
    renderTimer = setTimeout(async () => {
      await nextTick()
      afterRender()
    }, 150)
  }
)
watch(
  () => props.file,
  () => props.kind === 'image' && loadImage()
)
onMounted(async () => {
  if (props.kind === 'image') return loadImage()
  await nextTick()
  afterRender()
})

// Links: the web outside, a heading here, a file in Tessel.
function onBodyClick(e) {
  const a = e.target.closest && e.target.closest('a[href]')
  if (!a || !bodyEl.value || !bodyEl.value.contains(a)) return
  e.preventDefault()
  const href = a.getAttribute('href') || ''
  if (/^(https?:|mailto:)/i.test(href)) {
    if (window.shellApi.openExternal) window.shellApi.openExternal(href)
    return
  }
  if (href.startsWith('#')) {
    const id = decodeURIComponent(href.slice(1))
    const t = [...bodyEl.value.querySelectorAll('[id]')].find((el) => el.id === id)
    if (t) t.scrollIntoView({ block: 'start' })
    return
  }
  const target = resolveFrom(props.file, href)
  if (target) emit('open', target)
}
</script>

<template>
  <div ref="bodyEl" class="fview-body ed-rich" :data-kind="kind" data-test="rich-view" @click="onBodyClick">
    <!-- eslint-disable-next-line vue/no-v-html (sanitized by DOMPurify, markdownView.js) -->
    <article v-if="kind === 'markdown'" class="fview-md" v-html="markdownHtml"></article>
    <div v-else-if="kind === 'mermaid'" class="fview-mermaid">
      <div v-if="mermaidError" class="fview-note error">Diagram error: {{ mermaidError }}</div>
      <!-- eslint-disable-next-line vue/no-v-html (sanitized SVG) -->
      <div v-else-if="mermaidSvg" class="md-mermaid" v-html="mermaidSvg"></div>
      <div v-else class="fview-note">Drawing…</div>
    </div>
    <div v-else-if="table" class="fview-table-wrap">
      <table class="fview-table">
        <thead>
          <tr>
            <th class="fview-rownum">#</th>
            <th v-for="(h, i) in table.head" :key="i">{{ h }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in table.body" :key="i">
            <td class="fview-rownum">{{ i + 1 }}</td>
            <td v-for="(c, j) in r" :key="j">{{ c }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="table.more" class="fview-note">{{ table.more }} more rows not shown. Source shows them all.</div>
    </div>
    <div v-else-if="kind === 'image'" class="fview-image" data-test="image-view">
      <div v-if="imageError" class="fview-note error">{{ imageError }}</div>
      <img v-else-if="imageUrl" :src="imageUrl" :alt="file.split(/[\\/]/).pop()" draggable="false" />
      <div v-else class="fview-note">Reading…</div>
    </div>
  </div>
</template>
