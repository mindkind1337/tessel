<script setup>
// A file shown in Tessel (after Orca's viewers): Markdown rendered or as its
// source, Mermaid diagrams, CSV/TSV as a table, JSON formatted, images, and
// any other text with line numbers. Read-only. "Open in editor" hands it to
// your editor; Esc or ✕ closes it. PDFs open in their own window (App).
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { fileKind, parseTable, formatJson } from '../../../shared/fileKinds'
import { renderMarkdown, renderMermaid } from '../markdownView'
import { resolveFrom } from '../../../shared/viewPaths'
import { t, intlLocale } from '../i18n'

const props = defineProps({
  file: { type: String, required: true },
  // How it is named in the title bar (a path relative to the project).
  label: { type: String, default: '' },
  // Scroll to this line (text files), from a file:line link.
  line: { type: Number, default: null }
})
const emit = defineEmits(['close', 'open-editor', 'open-external', 'open'])

const kind = computed(() => fileKind(props.file))
const name = computed(() => props.label || props.file.split(/[\\/]/).pop())
const loading = ref(true)
const error = ref('')
const text = ref('')
const imageUrl = ref('')
const size = ref(0)
// Rendered (Preview, Diagram, Table) or the file as it is (Source).
const mode = ref('rich')
const hasRich = computed(() => ['markdown', 'mermaid', 'table'].includes(kind.value))
const richLabel = computed(() => {
  if (kind.value === 'mermaid') return t('editor.viewer.diagram', 'Diagram')
  if (kind.value === 'table') return t('editor.viewer.table', 'Table')
  return t('editor.viewer.preview', 'Preview')
})

const bodyEl = ref(null)
const closeBtn = ref(null)

async function load() {
  loading.value = true
  error.value = ''
  text.value = ''
  imageUrl.value = ''
  let res = null
  try {
    res = await window.shellApi.viewFile(props.file)
  } catch (err) {
    res = { ok: false, error: err && err.message }
  }
  loading.value = false
  if (!res || !res.ok) {
    error.value = (res && res.error) || t('editor.viewer.fileUnreadable', 'The file could not be read.')
    return
  }
  size.value = res.size || 0
  if (res.kind === 'image') imageUrl.value = res.dataUrl
  else text.value = res.text || ''
  await nextTick()
  afterRender()
}

// --- What is shown -------------------------------------------------------------
const markdownHtml = computed(() => (kind.value === 'markdown' && mode.value === 'rich' ? renderMarkdown(text.value) : ''))
const table = computed(() => {
  if (kind.value !== 'table' || mode.value !== 'rich') return null
  const { rows } = parseTable(text.value, props.file)
  return { head: rows[0] || [], body: rows.slice(1, 5001), more: Math.max(0, rows.length - 5001) }
})
const json = computed(() => (kind.value === 'json' ? formatJson(text.value, props.file) : null))
const plainLines = computed(() => {
  const src = kind.value === 'json' && json.value ? json.value.text : text.value
  return src.split(/\r?\n/)
})
const showPlain = computed(
  () => !loading.value && !error.value && kind.value !== 'image' && (mode.value === 'source' || !hasRich.value)
)
const mermaidSvg = ref('')
const mermaidError = ref('')

function isDark() {
  const c = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)
  if (!c) return true
  const [r, g, b] = c.map(Number)
  return 0.299 * r + 0.587 * g + 0.114 * b < 128
}

// Diagrams, local images, the line to show: once the content is in the page.
async function afterRender() {
  if (kind.value === 'mermaid' && mode.value === 'rich') {
    mermaidSvg.value = ''
    mermaidError.value = ''
    const r = await renderMermaid(text.value, { dark: isDark() })
    if (r.error) mermaidError.value = r.error
    else mermaidSvg.value = r.svg
  }
  const root = bodyEl.value
  if (!root) return
  if (kind.value === 'markdown' && mode.value === 'rich') {
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
          el.textContent = t('editor.viewer.diagramError', 'Diagram error: {{error}}', { error: r.error })
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
  if (props.line && showPlain.value) {
    const el = root.querySelector(`[data-line="${props.line}"]`) // i18n-ignore
    if (el) el.scrollIntoView({ block: 'center' })
  }
}
watch(mode, async () => {
  await nextTick()
  afterRender()
})
watch(() => props.file, load)

// Links in a Markdown file: the web outside, a heading here, a file in Tessel.
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
    const target = [...bodyEl.value.querySelectorAll('[id]')].find((el) => el.id === id)
    if (target) target.scrollIntoView({ block: 'start' })
    return
  }
  const target = resolveFrom(props.file, href)
  if (target) emit('open', target)
}

function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}
function copyPath() {
  if (navigator.clipboard) navigator.clipboard.writeText(props.file).catch(() => {})
}
const sizeText = computed(() => {
  const n = size.value
  if (!n) return ''
  const num = (v) => new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }).format(v)
  if (n < 1024) return t('editor.viewer.sizeB', '{{n}} B', { n })
  if (n < 1024 * 1024) return t('editor.viewer.sizeKb', '{{n}} KB', { n: num(n / 1024) })
  return t('editor.viewer.sizeMb', '{{n}} MB', { n: num(n / 1024 / 1024) })
})

onMounted(() => {
  window.addEventListener('keydown', onKey, true)
  if (closeBtn.value) closeBtn.value.focus()
  load()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div class="fview-backdrop" role="dialog" aria-modal="true" :aria-label="name" @mousedown.self="emit('close')">
    <div class="fview-card">
      <div class="fview-bar">
        <span class="fview-title" :title="file">{{ name }}</span>
        <span v-if="sizeText" class="fview-size">{{ sizeText }}</span>
        <div v-if="hasRich && !error" class="launch-seg fview-seg" role="group" :aria-label="t('editor.viewer.howToShow', 'How to show it')">
          <button class="launch-seg-btn" :class="{ on: mode === 'rich' }" :aria-pressed="mode === 'rich'" @click="mode = 'rich'">
            {{ richLabel }}
          </button>
          <button class="launch-seg-btn" :class="{ on: mode === 'source' }" :aria-pressed="mode === 'source'" @click="mode = 'source'">
            {{ t('editor.viewer.source', 'Source') }}
          </button>
        </div>
        <span class="fview-spacer"></span>
        <button type="button" class="imgview-btn" :title="t('editor.viewer.copyPathHint', 'Copy the file\'s full path')" @click="copyPath">
          {{ t('editor.viewer.copyPath', 'Copy path') }}
        </button>
        <button
          v-if="kind !== 'image' && kind !== 'pdf'"
          type="button"
          class="imgview-btn"
          :title="t('editor.viewer.openInEditorHint', 'Edit it in Tessel\'s editor')"
          @click="emit('open-editor', { file, line })"
        >
          {{ t('editor.viewer.openInEditor', 'Open in editor') }}
        </button>
        <button
          type="button"
          class="imgview-btn"
          :title="t('editor.viewer.openInVsCodeHint', 'VS Code when installed, else the file\'s own program')"
          @click="emit('open-external', { file, line })"
        >
          {{ t('editor.viewer.openInVsCode', 'Open in VS Code') }}
        </button>
        <button
          ref="closeBtn"
          type="button"
          class="imgview-btn imgview-close"
          :title="t('editor.viewer.closeEsc', 'Close (Esc)')"
          :aria-label="t('editor.viewer.close', 'Close')"
          @click="emit('close')"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div ref="bodyEl" class="fview-body" :data-kind="kind" @click="onBodyClick">
        <div v-if="loading" class="fview-note">{{ t('editor.viewer.reading', 'Reading…') }}</div>
        <div v-else-if="error" class="fview-note error">{{ error }}</div>
        <template v-else>
          <!-- eslint-disable-next-line vue/no-v-html (sanitized by DOMPurify, markdownView.js) -->
          <article v-if="kind === 'markdown' && mode === 'rich'" class="fview-md" v-html="markdownHtml"></article>
          <div v-else-if="kind === 'mermaid' && mode === 'rich'" class="fview-mermaid">
            <div
              v-if="mermaidError"
              class="fview-note error"
              v-text="t('editor.viewer.diagramError', 'Diagram error: {{error}}', { error: mermaidError })"
            ></div>
            <!-- eslint-disable-next-line vue/no-v-html (sanitized SVG) -->
            <div v-else-if="mermaidSvg" class="md-mermaid" v-html="mermaidSvg"></div>
            <div v-else class="fview-note">{{ t('editor.viewer.drawing', 'Drawing…') }}</div>
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
            <div
              v-if="table.more"
              class="fview-note"
              v-text="t('editor.viewer.moreRows', '{{count}} more rows not shown. Source shows them all.', { count: table.more })"
            ></div>
          </div>
          <div v-else-if="kind === 'image'" class="fview-image">
            <img :src="imageUrl" :alt="name" draggable="false" />
          </div>
          <template v-if="showPlain">
            <div v-if="json && json.error" class="fview-note error">{{ json.error }}</div>
            <pre class="fview-code"><code><span
              v-for="(l, i) in plainLines"
              :key="i"
              class="fview-line"
              :class="{ hl: line === i + 1 }"
              :data-line="i + 1"
            ><span class="fview-ln">{{ i + 1 }}</span>{{ l || ' ' }}</span></code></pre>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>
