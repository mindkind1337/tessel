<script setup>
import { computed, ref } from 'vue'
import OrcaMenu from './OrcaMenu.vue'
import { htmlPreview, htmlPlainText } from '../htmlPreview'
import { resolveFrom } from '../../../shared/viewPaths'
import { openTarget } from '../links/openTarget'
import { t } from '../i18n'
const props = defineProps({ file: { type: String, required: true }, text: { type: String, default: '' }, plain: Boolean })
const emit = defineEmits(['open'])
const src = computed(() => props.plain ? '' : htmlPreview(props.text))
const plainText = computed(() => props.plain ? htmlPlainText(props.text) : '')
const menu = ref(null)
const menuItems = computed(() => {
  const target = menu.value?.target
  if (!target) return []
  return /^https?:/i.test(target)
    ? [{ type: 'item', label: t('editor.html.openBrowser', 'Open in browser'), onSelect: () => openTarget(target, { builtin: true }) }]
    : [{ type: 'item', label: t('editor.html.openTab', 'Open in new tab'), onSelect: () => emit('open', target) }]
})
function loaded(event) {
  const doc = event.target.contentDocument
  if (!doc) return
  const file = props.file
  doc.addEventListener('contextmenu', (e) => {
    const a = e.target.closest?.('a[data-tessel-href]')
    if (!a) return
    const href = a.dataset.tesselHref
    if (href.startsWith('#')) return
    const target = /^https?:/i.test(href) ? href : resolveFrom(file, href)
    if (!target) return
    e.preventDefault()
    const rect = event.target.getBoundingClientRect()
    menu.value = { x: rect.left + e.clientX, y: rect.top + e.clientY, target }
  })
  doc.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[data-tessel-href]')
    if (!a) return
    e.preventDefault()
    const href = a.dataset.tesselHref
    if (href.startsWith('#')) {
      try { doc.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView() } catch { /* malformed fragment */ }
    } else if (/^https?:/i.test(href)) openTarget(href, { event: e })
    else {
      const target = resolveFrom(file, href)
      if (target) emit('open', target)
    }
  })
  for (const img of [...doc.querySelectorAll('img[data-local-src]')].slice(0, 100)) {
    const target = resolveFrom(file, img.dataset.localSrc)
    if (!target) continue
    window.shellApi?.viewImage?.(target).then((r) => {
      if (r?.ok && /^data:image\//.test(r.dataUrl)) img.src = r.dataUrl
    }).catch(() => {})
  }
}
</script>

<template>
  <pre v-if="plain" class="html-plain" data-test="html-plain">{{ plainText }}</pre>
  <div v-else class="html-view">
    <div class="html-note">{{ t('editor.html.static', 'HTML preview · scripts and external resources are disabled') }}</div>
    <iframe :srcdoc="src" sandbox="allow-same-origin" referrerpolicy="no-referrer" :title="t('editor.html.preview', 'HTML preview')" @load="loaded" />
    <OrcaMenu :open="!!menu" :anchor="menu" :items="menuItems" @close="menu = null" />
  </div>
</template>

<style scoped>
.html-view { height: 100%; min-height: 0; display: flex; flex-direction: column; }
iframe { flex: 1; min-height: 0; width: 100%; border: 0; background: white; color-scheme: light; }
.html-note { padding: 5px 10px; font-size: 11px; opacity: .65; flex: 0 0 auto; }
.html-plain { margin: 0; padding: 20px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; line-height: 1.6; }
</style>
