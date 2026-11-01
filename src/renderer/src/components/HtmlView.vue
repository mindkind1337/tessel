<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { RotateCw, ExternalLink, ShieldCheck, ShieldAlert } from 'lucide-vue-next'
import OrcaMenu from './OrcaMenu.vue'
import { htmlPreview, htmlPlainText } from '../htmlPreview'
import { resolveFrom, resolvePreviewImage } from '../../../shared/viewPaths'
import { openTarget } from '../links/openTarget'
import { t } from '../i18n'
const props = defineProps({ file: { type: String, required: true }, text: { type: String, default: '' }, plain: Boolean, root: { type: String, default: '' } })
const emit = defineEmits(['open'])
// The page as a real website (htmlPreviewServer.js: its folder served on this
// computer, an SSH project's files read on its host): its CSS, images and fonts
// load by their paths. The static, sanitized preview below is only for a file
// the server cannot serve (a Live Share host's, no server).
//
// Trust, as VS Code's Workspace Trust: the first time a folder's page is
// previewed, one question (do you trust the files of this folder?), answered
// once and remembered by folder. Trusted: the page's scripts run, as on a
// website (they can read the folder served and use the internet); not: the page
// shows without scripts (a restricted mode), and the shield in the toolbar
// asks again. Never decided for you.
const TRUST_KEY = 'tessel.htmlTrust'
const OLD_KEY = 'tessel.htmlScripts' // before: a list of folders with scripts on
const folderKey = () => {
  const folder = String(props.root || props.file.replace(/[\\/][^\\/]*$/, ''))
  // Old remote keys were lowercased and cannot prove which Linux directory
  // was approved. Use a new namespace and ask again instead of migrating them.
  return /^[A-Za-z]:[\\/]|^\\\\/.test(folder) ? folder.toLowerCase() : `case-sensitive:${folder}`
}
function readTrust() {
  try {
    const map = JSON.parse(localStorage.getItem(TRUST_KEY) || '{}')
    const out = map && typeof map === 'object' && !Array.isArray(map) ? map : {}
    const old = JSON.parse(localStorage.getItem(OLD_KEY) || '[]')
    if (Array.isArray(old)) for (const k of old) if (typeof k === 'string' && !(k in out)) out[k] = true
    return out
  } catch {
    return {}
  }
}
// true: trusted, false: declined, null: not asked yet.
const trustOf = (key) => {
  const v = readTrust()[key]
  return v === true ? true : v === false ? false : null
}
const trust = ref(trustOf(folderKey()))
// The question is shown while it is not answered (and again when the shield is clicked).
const asking = ref(false)
const scripts = computed(() => trust.value === true)
function decide(yes) {
  trust.value = yes
  asking.value = false
  try {
    const map = readTrust()
    map[folderKey()] = yes
    const keys = Object.keys(map)
    // Bounded: the oldest decisions go first.
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete map[k]
    localStorage.setItem(TRUST_KEY, JSON.stringify(map))
  } catch { /* the choice holds for this tab */ }
  openLive()
}
// The shield: trusted -> back to restricted at once (the safe way); restricted -> the question again.
function onShield() {
  if (trust.value === true) decide(false)
  else asking.value = true
}
const showQuestion = computed(() => trust.value === null || asking.value)
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
watch(() => [props.file, props.root, props.plain], () => {
  trust.value = trustOf(folderKey())
  asking.value = false
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
// The page's own path on its site, as an address bar shows it (/code.html).
const pagePath = computed(() => {
  try { return decodeURIComponent(new URL(live.value).pathname) } catch { return '' }
})
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
    const target = resolvePreviewImage(file, img.dataset.localSrc)
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
    <template v-else>
      <!-- Restricted mode, as VS Code's: one question about the folder, answered once. -->
      <div v-if="showQuestion" class="html-trust" role="alert" data-test="html-trust">
        <ShieldAlert :size="16" aria-hidden="true" />
        <span class="html-trust-text">{{ t('editor.html.trustQuestion', 'Do you trust the files of this folder? The scripts of a page can read the folder and use the internet, as a website does. Without trust the page shows without its scripts.') }}</span>
        <button class="html-bar-btn primary" data-test="html-trust-yes" @click="decide(true)">{{ t('editor.html.trustYes', 'Trust the folder and run scripts') }}</button>
        <button class="html-bar-btn" data-test="html-trust-no" @click="decide(false)">{{ t('editor.html.trustNo', 'Keep it without scripts') }}</button>
      </div>
      <!-- The page's address and its few actions, as icons. -->
      <div class="html-toolbar" data-test="html-live-bar">
        <span class="html-path" :title="pagePath" data-test="html-path">{{ pagePath }}</span>
        <button class="html-icon" data-test="html-reload" :title="t('editor.html.reload', 'Reload')" :aria-label="t('editor.html.reload', 'Reload')" @click="openLive"><RotateCw :size="14" /></button>
        <button class="html-icon" data-test="html-open-browser" :title="t('editor.html.openPage', 'Open in a browser tab')" :aria-label="t('editor.html.openPage', 'Open in a browser tab')" @click="openInBrowser"><ExternalLink :size="14" /></button>
        <button
          class="html-icon"
          :class="{ on: scripts }"
          data-test="html-scripts"
          :title="scripts ? t('editor.html.trustedHint', 'Trusted folder: its scripts run. Click to go back to restricted mode.') : t('editor.html.restrictedHint', 'Restricted mode: the page shows without scripts. Click to trust the folder.')"
          :aria-label="scripts ? t('editor.html.trustedHint', 'Trusted folder: its scripts run. Click to go back to restricted mode.') : t('editor.html.restrictedHint', 'Restricted mode: the page shows without scripts. Click to trust the folder.')"
          @click="onShield"
        >
          <ShieldCheck v-if="scripts" :size="14" />
          <ShieldAlert v-else :size="14" />
        </button>
      </div>
    </template>
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
.html-bar-btn:hover { background: var(--surface); }
.html-bar-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg, #fff); }
.html-blocked { border-top: 1px solid var(--border); }
/* VS Code's restricted-mode banner: the one question, over the page. */
.html-trust { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; font-size: 12px; background: color-mix(in srgb, var(--warn, #d9a441) 14%, transparent); border-bottom: 1px solid var(--border); }
.html-trust-text { flex: 1 1 320px; min-width: 0; }
/* The address and its icons (a browser's small toolbar). */
.html-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; padding: 3px 8px; border-bottom: 1px solid var(--border); }
.html-path { flex: 1; min-width: 0; padding: 0 6px; font-size: 12px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.html-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 0; border-radius: 4px; background: none; color: var(--text-dim); cursor: pointer; }
.html-icon:hover { background: var(--surface); color: var(--text); }
.html-icon.on { color: var(--accent); }
.html-plain { margin: 0; padding: 20px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; line-height: 1.6; }
</style>
