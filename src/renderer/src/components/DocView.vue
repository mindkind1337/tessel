<script setup>
// A Word, PowerPoint or OpenDocument file in an editor tab, read-only
// (office/docs.js): a document's headings, paragraphs, lists and tables, or a
// presentation's slides one under the other. Only the text: no formatting
// beyond bold, italic and underline, no pictures or charts.
import { ref, watch, onMounted } from 'vue'
import { readDocument, readSlides } from '../office/docs'
import { loadBytes } from '../office/bytes'
import { extOf } from '../../../shared/fileKinds'
import { openTarget } from '../links/openTarget'
import { t } from '../i18n'

const props = defineProps({
  file: { type: String, required: true },
  // 'doc' (.docx / .odt) or 'slides' (.pptx / .odp)
  kind: { type: String, required: true }
})

const blocks = ref([])
const slides = ref([])
const error = ref('')
const loading = ref(true)

let seq = 0
async function load() {
  const my = ++seq
  loading.value = true
  error.value = ''
  blocks.value = []
  slides.value = []
  try {
    const r = await loadBytes(props.file)
    if (my !== seq) return
    if (r.error !== undefined) {
      error.value = r.error || t('editor.doc.unreadable', 'This document could not be read.')
      return
    }
    const ext = extOf(props.file)
    if (props.kind === 'slides') {
      const res = await readSlides(r.bytes, ext)
      if (my === seq) slides.value = res.slides
    } else {
      const res = await readDocument(r.bytes, ext)
      if (my === seq) blocks.value = res.blocks
    }
  } catch {
    if (my === seq) error.value = t('editor.doc.unreadable', 'This document could not be read.')
  } finally {
    if (my === seq) loading.value = false
  }
}
watch(() => [props.file, props.kind], load)
onMounted(load)

const tagOf = (b) => (/^h[1-6]$/.test(b.style) ? b.style : 'p')
function openLink(e, href) {
  e.preventDefault()
  if (href) openTarget(href, { event: e })
}
</script>

<template>
  <div class="doc-view" data-test="doc-view">
    <div v-if="error" class="fview-note error">{{ error }}</div>
    <div v-else-if="loading" class="fview-note">{{ t('editor.viewer.reading', 'Reading…') }}</div>
    <template v-else>
      <div class="doc-readonly">{{ t('editor.sheet.readOnly', 'Read-only') }}</div>
      <template v-if="kind === 'slides'">
        <div v-if="!slides.length" class="fview-note">{{ t('editor.doc.noSlides', 'This presentation has no slide.') }}</div>
        <section v-for="(s, si) in slides" :key="si" class="doc-page doc-slide">
          <div class="doc-slide-num" v-text="t('editor.doc.slide', 'Slide {{n}}', { n: si + 1 })"></div>
          <component :is="tagOf(b)" v-for="(b, bi) in s.blocks" :key="bi" :class="['doc-p', b.style === 'li' && 'doc-li']" :style="b.style === 'li' ? { marginLeft: `${(b.level + 1) * 20}px` } : null">
            <template v-for="(r, ri) in b.runs" :key="ri"
              ><a v-if="r.href" :href="r.href" :class="{ 'doc-b': r.b, 'doc-i': r.i }" @click="openLink($event, r.href)">{{ r.text }}</a
              ><span v-else :class="{ 'doc-b': r.b, 'doc-i': r.i, 'doc-u': r.u }">{{ r.text }}</span></template
            >
          </component>
        </section>
      </template>
      <article v-else class="doc-page">
        <div v-if="!blocks.length" class="fview-note">{{ t('editor.doc.empty', 'This document has no text.') }}</div>
        <template v-for="(b, bi) in blocks" :key="bi">
          <table v-if="b.type === 'table'" class="fview-table doc-table">
            <tbody>
              <tr v-for="(row, i) in b.rows" :key="i">
                <td v-for="(c, j) in row" :key="j">{{ c }}</td>
              </tr>
            </tbody>
          </table>
          <component :is="tagOf(b)" v-else :class="['doc-p', b.style === 'li' && 'doc-li']" :style="b.style === 'li' ? { marginLeft: `${(b.level + 1) * 20}px` } : null">
            <template v-for="(r, ri) in b.runs" :key="ri"
              ><a v-if="r.href" :href="r.href" :class="{ 'doc-b': r.b, 'doc-i': r.i }" @click="openLink($event, r.href)">{{ r.text }}</a
              ><span v-else :class="{ 'doc-b': r.b, 'doc-i': r.i, 'doc-u': r.u }">{{ r.text }}</span></template
            >
          </component>
        </template>
      </article>
    </template>
  </div>
</template>
