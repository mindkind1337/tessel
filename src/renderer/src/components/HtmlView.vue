<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import OrcaMenu from './OrcaMenu.vue'
import { htmlPreview, htmlPlainText } from '../htmlPreview'
import { resolveFrom } from '../../../shared/viewPaths'
import { openTarget } from '../links/openTarget'
import { t } from '../i18n'
const props = defineProps({ file: { type: String, required: true }, text: { type: String, default: '' }, plain: Boolean, root: { type: String, default: '' } })
const emit = defineEmits(['open'])
// The page as a real website (htmlPreviewServer.js: its folder served on this
// computer, an SSH project's files read on its host): its CSS, scripts, images
// and fonts load by their paths. The static, sanitized preview below is only
// for a file the server cannot serve (a Live Share host's, no server).
// Its scripts run only when turned on for this folder (remembered by folder):
// a page's scripts can read the folder served and use the internet, so it is
// for a project you trust (htmlPreviewServer.js).
const SCRIPTS_KEY = 'tessel.htmlScripts'
const folderKey = () => String(props.root || props.file.replace(/[\\/][^\\/]*$/, '')).toLowerCase()
function readTrusted() {
  try {
    const list = JSON.parse(localStorage.getItem(SCRIPTS_KEY) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}
const scripts = ref(readTrusted().includes(folderKey()))
function toggleScripts() {
  scripts.value = !scripts.value
  try {
    const rest = readTrusted().filter((k) => k !== folderKey())
    localStorage.setItem(SCRIPTS_KEY, JSON.stringify((scripts.value ? [...rest, folderKey()] : rest).slice(-200)))
  } catch { /* the choice holds for this tab */ }
  openLive()
}
// A link the page tried to follow was held back: the person decides.
const blocked = ref('')
let stopBlocked = null
const blockedHost = computed(() => {
  try { return new URL(blocked.value).host } catch { return '' }
})
const live = ref('') // the page's address, '' until known
const liveFailed = ref(false)
const version = ref(0)
let liveSeq = 0
let liveTimer = 0
async function openLive() {
  const my = ++liveSeq
  if (props.plain || !window.shellApi?.previewUrl) {
    liveFailed.value = !props.plain
    return
  }
  let r
  try {
    r = await window.shellApi.previewUrl({ file: props.file, root: props.root, text: props.text, scripts: scripts.value })
  } catch {
    r = null
  }
  if (my !== liveSeq) return
  if (r?.ok && r.url) {
    // The same address does not reload the frame: a query changes it.
    live.value = r.url
    liveFailed.value = false
    version.value++
  } else liveFailed.value = true
}
// What is typed shows after a pause (the unsaved text replaces the file on the server).
watch(() => props.text, () => {
  clearTimeout(liveTimer)
  liveTimer = setTimeout(openLive, 350)
})
watch(() => [props.file, props.plain], () => {
  scripts.value = readTrusted().includes(folderKey())
  blocked.value = ''
  openLive()
})
onMounted(() => {
  openLive()
  if (window.shellApi?.onPreviewBlocked) stopBlocked = window.shellApi.onPreviewBlocked((e) => { if (e?.url) blocked.value = String(e.url) })
})
onBeforeUnmount(() => {
  liveSeq++
  clearTimeout(liveTimer)
  if (typeof stopBlocked === 'function') stopBlocked()
})
const liveSrc = computed(() => (live.value ? `${live.value}?tessel=${version.value}` : ''))
function openInBrowser() {
  if (live.value) openTarget(live.value, { builtin: true })
}
function openBlocked() {
  const url = blocked.value
  blocked.value = ''
  if (url) openTarget(url, { builtin: true })
}
const src = computed(() => props.plain || !liveFailed.value ? '' : htmlPreview(props.text))
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
    <div v-if="liveFailed" class="html-note">{{ t('editor.html.static', 'HTML preview · scripts and external resources are disabled') }}</div>
    <div v-else class="html-note html-bar" data-test="html-live-bar">
      <span class="html-bar-text">{{ scripts ? t('editor.html.liveScripts', 'Served from the project folder · scripts on') : t('editor.html.live', 'Served from the project folder · scripts off') }}</span>
      <button class="html-bar-btn" :class="{ on: scripts }" data-test="html-scripts" :title="t('editor.html.scriptsHint', 'The page’s scripts can read this folder and use the internet, as a website does. Only for a project you trust.')" @click="toggleScripts">{{ scripts ? t('editor.html.scriptsOff', 'Turn scripts off') : t('editor.html.scriptsOn', 'Run scripts') }}</button>
      <button class="html-bar-btn" data-test="html-reload" @click="openLive">{{ t('editor.html.reload', 'Reload') }}</button>
      <button class="html-bar-btn" data-test="html-open-browser" @click="openInBrowser">{{ t('editor.html.openPage', 'Open in a browser tab') }}</button>
    </div>
    <div v-if="blocked" class="html-note html-bar html-blocked" data-test="html-blocked">
      <span class="html-bar-text" v-text="t('editor.html.blocked', 'A link to {{host}} was held back.', { host: blockedHost })"></span>
      <button class="html-bar-btn" data-test="html-blocked-open" @click="openBlocked">{{ t('editor.html.blockedOpen', 'Open it') }}</button>
      <button class="html-bar-btn" @click="blocked = ''">{{ t('editor.html.blockedClose', 'Dismiss') }}</button>
    </div>
    <iframe v-if="liveFailed" :srcdoc="src" sandbox="allow-same-origin" referrerpolicy="no-referrer" :title="t('editor.html.preview', 'HTML preview')" @load="loaded" />
    <iframe v-else-if="liveSrc" :src="liveSrc" :sandbox="scripts ? 'allow-scripts allow-same-origin allow-forms' : 'allow-same-origin'" referrerpolicy="no-referrer" :title="t('editor.html.preview', 'HTML preview')" data-test="html-live-frame" />
    <div v-else class="html-note">{{ t('editor.viewer.reading', 'Reading…') }}</div>
    <OrcaMenu :open="!!menu" :anchor="menu" :items="menuItems" @close="menu = null" />
  </div>
</template>

<style scoped>
.html-view { height: 100%; min-height: 0; display: flex; flex-direction: column; }
iframe { flex: 1; min-height: 0; width: 100%; border: 0; background: white; color-scheme: light; }
.html-note { padding: 5px 10px; font-size: 11px; opacity: .65; flex: 0 0 auto; }
.html-bar { display: flex; align-items: center; gap: 8px; opacity: 1; }
.html-bar-text { flex: 1; min-width: 0; opacity: .65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.html-bar-btn { flex: none; padding: 2px 10px; border: 1px solid var(--border); border-radius: 4px; background: none; color: var(--text); font-size: 11px; cursor: pointer; }
.html-bar-btn:hover, .html-bar-btn.on { background: var(--surface); }
.html-blocked { border-top: 1px solid var(--border); }
.html-plain { margin: 0; padding: 20px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; line-height: 1.6; }
</style>
