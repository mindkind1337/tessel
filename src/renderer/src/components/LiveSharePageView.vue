<script setup>
// Live Share, as a guest: one of the host's browser pages ("See my browser
// pages"), live: the frames the host's Tessel sends, the page's title and
// its address as guests get it (scheme, host and path; ?… and #… for the
// rest). The page is watched only while this view is on screen (in the
// window, the window shown): nothing comes otherwise. With "Use my browser
// pages", your clicks, wheel, keys and text go to the host's page: it acts
// in the host's browser, signed in as the host (said in the bar); what the
// host's Tessel refuses (the right button, the browser's own keys, too many
// at once) is said. "Open this address in my own browser" opens its origin
// and path in yours (http(s) only; not for an address of the host's
// computer or network), after you saw the whole address and said yes: none
// of the host's sessions comes with it.
// As on the host's screen, the page is a tab of its own above the panes
// (paneViews.js isTabLeaf): its header is then the line of tabs, and its
// address goes in the bar under it.
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ExternalLink, Globe, MousePointerClick } from 'lucide-vue-next'
import { externalPageUrl } from '../../../shared/livePageUrl'
import { t } from '../i18n'
import ViewTabs from './ViewTabs.vue'

const props = defineProps({ node: { type: Object, required: true } })
const ctx = inject('panelCtx')
const askConfirm = inject('askConfirm', null)

const source = computed(() => (ctx.liveSharePageSource ? ctx.liveSharePageSource(props.node.id) : null))
const info = computed(() => (source.value ? source.value.info() : null))
const host = computed(() => (info.value && info.value.host) || (props.node.liveShare && props.node.liveShare.host) || '?')
const isActive = computed(() => !!ctx.activeId && ctx.activeId.value === props.node.id)
const isMaximized = computed(() => !!ctx.maximizedId && ctx.maximizedId.value === props.node.id)
// The tabs above the panes, while this page is one of them (App.vue).
const viewTabs = computed(() => (ctx.paneTabs ? ctx.paneTabs(props.node.id) : null))

// --- What comes from the host --------------------------------------------------------
const rootEl = ref(null)
const imgEl = ref(null)
const frameUrl = ref('')
const meta = ref({ title: '', url: '' })
// 'waiting' | 'live' | 'paused' | 'ended' | 'refused'
const status = ref('waiting')
const reason = ref('')
const notice = ref('')
let lastSeq = 0
let noticeTimer = 0
function setFrame(m) {
  if (!m || !(m.seq > lastSeq) || !m.jpeg) return
  lastSeq = m.seq
  const url = URL.createObjectURL(new Blob([m.jpeg], { type: 'image/jpeg' }))
  if (frameUrl.value) URL.revokeObjectURL(frameUrl.value)
  frameUrl.value = url
  meta.value = m.meta && typeof m.meta === 'object' ? { title: m.meta.title || '', url: m.meta.url || '' } : { title: '', url: '' }
  // Its tab says it too (ViewTabs.vue), also once this page is out of sight.
  if (props.node.liveShare) {
    props.node.liveShare.pageTitle = meta.value.title
    props.node.liveShare.pageUrl = meta.value.url
  }
  status.value = 'live'
  reason.value = ''
}
function say(text) {
  notice.value = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (notice.value = ''), 4000)
}
const REFUSED = {
  button: () => t('liveShare.page.refused.button', 'Only the left mouse button is sent (a right-click menu would open on the host’s screen).'),
  key: () => t('liveShare.page.refused.key', 'That key is not sent: it belongs to the host’s browser or Tessel (paste, copy, close, devtools, save, print…).'),
  url: () => t('liveShare.page.refused.url', 'Only web addresses (http and https) can be opened.'),
  too_long: () => t('liveShare.page.refused.tooLong', 'Too much text at once.'),
  password: () => t('liveShare.page.refused.password', 'Text is never typed into a password field from Live Share.'),
  agent: () => t('liveShare.page.refused.agent', 'An agent is using this page: wait until it is done.'),
  hidden: () => t('liveShare.page.refused.hidden', 'The host hid this page from guests.'),
  forbidden: () => t('liveShare.page.refused.forbidden', '{{host}} no longer lets you use their pages.', { host: host.value }),
  busy: () => t('liveShare.page.refused.busy', 'The page’s devtools are open on the host: input waits until they are closed.')
}
function onEvent(m) {
  if (!m) return
  if (m.state === 'paused') {
    status.value = 'paused'
    reason.value = m.reason || 'hidden'
    if (frameUrl.value) URL.revokeObjectURL(frameUrl.value)
    frameUrl.value = ''
  } else if (m.state === 'ended') {
    status.value = 'ended'
    reason.value = m.reason || 'gone'
    if (frameUrl.value) URL.revokeObjectURL(frameUrl.value)
    frameUrl.value = ''
  } else if (m.state === 'input') {
    if (m.notice === 'limit') return say(t('liveShare.page.limit', '{{host}}’s Tessel limits how fast guests click and type: slow down a moment.', { host: host.value }))
    const code = m.code || (Array.isArray(m.refused) && m.refused[0])
    if (code && REFUSED[code]) say(REFUSED[code]())
    else if (code) say(t('liveShare.page.refused.other', 'The host’s page did not take that.'))
  }
}

// --- Watched only while on screen ----------------------------------------------------
const inView = ref(false)
const shown = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
let observer = null
const onVisibility = () => (shown.value = document.visibilityState !== 'hidden')
const wanted = computed(() => {
  const i = info.value
  return !!(source.value && i && i.joined && i.canView && !i.outdated && inView.value && shown.value)
})
let watching = false
const watchCode = ref('')
async function setWatching(on) {
  const src = source.value
  if (!src || on === watching) return
  watching = on
  if (!on) {
    src.watch(false)
    return
  }
  lastSeq = 0
  status.value = 'waiting'
  const r = await src.watch(true)
  if (!watching) return
  watchCode.value = r && r.ok ? '' : (r && r.code) || 'failed'
}
watch(wanted, (on) => setWatching(on))

let offFrame = null
let offEvent = null
onMounted(() => {
  const src = source.value
  if (src) {
    offFrame = src.onFrame(setFrame)
    offEvent = src.onEvent(onEvent)
  }
  if (typeof IntersectionObserver === 'function' && rootEl.value) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) inView.value = e.isIntersecting && e.intersectionRatio > 0
    })
    observer.observe(rootEl.value)
  } else inView.value = true
  document.addEventListener('visibilitychange', onVisibility)
  if (wanted.value) setWatching(true)
})
onBeforeUnmount(() => {
  setWatching(false)
  offFrame?.()
  offEvent?.()
  observer?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
  clearTimeout(noticeTimer)
  clearTimeout(flushTimer)
  if (frameUrl.value) URL.revokeObjectURL(frameUrl.value)
})

// --- What the view says instead of the page ----------------------------------------
const overlay = computed(() => {
  const i = info.value
  if (!source.value || !i) return t('liveShare.page.unavailable', 'This page is not available.')
  if (i.ended) return t('liveShare.access.ended', 'The Live Share session ended.')
  if (i.outdated) return t('liveShare.page.outdated', '{{host}}’s Tessel is too old to share its browser pages: the host needs to update Tessel.', { host: host.value })
  if (!i.canView || watchCode.value === 'forbidden') return t('liveShare.page.noRight', '{{host}} has not let you see their browser pages.', { host: host.value })
  if (!i.joined) return t('liveShare.page.reconnecting', 'Reconnecting to {{host}}…', { host: host.value })
  if (status.value === 'ended') return reason.value === 'stopped' ? t('liveShare.page.stopped', '{{host}} stopped sharing this page.', { host: host.value }) : t('liveShare.page.gone', 'This page is no longer shared.')
  if (status.value === 'paused') return reason.value === 'limit' ? t('liveShare.page.busy', '{{host}}’s Tessel shows a few pages at once: this one waits for a place.', { host: host.value }) : t('liveShare.page.hiddenByHost', 'Hidden by the host')
  if (status.value === 'waiting' || !frameUrl.value) return t('liveShare.page.waiting', 'Waiting for the page…')
  return ''
})
const canUse = computed(() => !!(info.value && info.value.canUse && info.value.joined && status.value === 'live'))
const useLine = computed(() => t('liveShare.page.useLine', 'Your clicks and keys act in {{host}}’s browser, signed in as {{host}}.', { host: host.value }))
const viewLine = computed(() => t('liveShare.page.viewLine', 'View only: {{host}}’s page, live.', { host: host.value }))

// --- Open the address in your own browser --------------------------------------------
const external = computed(() => externalPageUrl(meta.value.url))
const externalTitle = computed(() => {
  if (external.value.ok) return t('liveShare.page.openHint', 'Open {{url}} in your own browser (none of {{host}}’s sessions comes with it)', { url: external.value.url, host: host.value })
  if (external.value.reason === 'local') return t('liveShare.page.openLocal', 'This address only works on the host’s computer or network.')
  return t('liveShare.page.openNone', 'Only web addresses (http and https) can be opened.')
})
async function openExternal() {
  const target = external.value
  if (!target.ok || !window.shellApi || !window.shellApi.openExternal) return
  // The whole address first: it comes from the host's page.
  const question = {
    title: t('liveShare.page.openAsk', 'Open this address in your browser?'),
    text: t('liveShare.page.openAskText', '{{url}} comes from {{host}}’s page. None of {{host}}’s sessions or cookies comes with it.', { url: target.url, host: host.value }),
    confirmLabel: t('liveShare.page.openConfirm', 'Open')
  }
  const ok = askConfirm ? await askConfirm(question) : window.confirm(`${question.title} ${question.text}`)
  if (ok !== true) return
  window.shellApi.openExternal(target.url)
}

// --- Your input on it ("Use my browser pages") ---------------------------------------
// Moves at most 30 a second (the latest), the rest in order, sent every
// 50 ms, 50 events a message at most.
let queue = []
let flushTimer = 0
let pendingMove = null
let lastMoveAt = 0
function flush() {
  flushTimer = 0
  if (pendingMove) {
    queue.push(pendingMove)
    pendingMove = null
    lastMoveAt = Date.now()
  }
  if (!queue.length || !source.value) return
  const batch = queue.slice(0, 50)
  queue = queue.slice(50)
  source.value.input(batch)
  if (queue.length || pendingMove) flushTimer = setTimeout(flush, 50)
}
function push(event) {
  if (!canUse.value) return
  if (event.type === 'mouse' && event.action === 'move') {
    pendingMove = event
    if (!flushTimer) flushTimer = setTimeout(flush, Math.max(0, lastMoveAt + 33 - Date.now()))
    return
  }
  if (pendingMove) {
    queue.push(pendingMove)
    pendingMove = null
  }
  queue.push(event)
  if (queue.length > 200) queue = queue.slice(-200)
  if (!flushTimer) flushTimer = setTimeout(flush, 50)
}
function point(e) {
  const r = imgEl.value ? imgEl.value.getBoundingClientRect() : null
  if (!r || r.width <= 0 || r.height <= 0) return null
  const x = (e.clientX - r.left) / r.width
  const y = (e.clientY - r.top) / r.height
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
}
const mods = (e) => ({ ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey })
function onMouse(e, action) {
  if (!canUse.value) return
  const p = point(e)
  if (!p) return
  if (action !== 'move' && e.button !== 0) {
    if (action === 'down') say(REFUSED.button())
    return
  }
  if (action === 'down') rootEl.value?.focus()
  push({ type: 'mouse', action, x: p.x, y: p.y, modifiers: mods(e), ...(action === 'move' ? { buttons: e.buttons & 1 ? 1 : 0 } : { button: 'left', clicks: Math.min(3, Math.max(1, e.detail || 1)) }) })
}
function onWheel(e) {
  if (!canUse.value) return
  const p = point(e)
  if (!p) return
  e.preventDefault()
  const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1
  push({ type: 'mouse', action: 'wheel', x: p.x, y: p.y, dx: Math.max(-2000, Math.min(2000, e.deltaX * k)), dy: Math.max(-2000, Math.min(2000, e.deltaY * k)), modifiers: mods(e) })
}
function onKey(e) {
  if (!canUse.value || e.isComposing) return
  // Tessel's own shortcuts with Ctrl+Shift stay Tessel's.
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return push({ type: 'text', text: e.key })
  push({ type: 'key', key: e.key, modifiers: mods(e) })
}
function onPaste(e) {
  if (!canUse.value) return
  e.preventDefault()
  say(REFUSED.key())
}

function activate() {
  if (ctx.setActive) ctx.setActive(props.node.id)
}
</script>

<template>
  <div
    ref="rootEl"
    class="pane ls-page-pane"
    :class="{ active: isActive, maximized: isMaximized, highlighted: ctx.highlightId && ctx.highlightId.value === node.id }"
    :data-pane-id="node.id"
    data-pane-kind="liveshare-page"
    data-test="liveshare-page"
    tabindex="0"
    @mousedown="activate"
    @keydown="onKey"
    @paste="onPaste"
  >
    <div class="pane-nav" :class="{ 'with-view-tabs': !!viewTabs }" data-test="pane-header">
      <div class="pane-nav-left">
        <!-- A tab above the panes: its header is the line of tabs. -->
        <ViewTabs
          v-if="viewTabs"
          :leaves="viewTabs.leaves"
          :shown="viewTabs.shown"
          @select="(id, path) => ctx.selectViewTab && ctx.selectViewTab(node.id, id, path)"
          @close="(id, path) => (ctx.closeViewTab ? ctx.closeViewTab(id, path) : ctx.closeLeaf(id))"
          @keep="(id, path) => ctx.keepViewTab && ctx.keepViewTab(id, path)"
          @drag="(id, e) => id && ctx.beginPaneDrag && ctx.beginPaneDrag(id, e)"
        />
        <template v-else>
          <span class="pane-icon" :aria-label="t('liveShare.page.title', 'Browser page')"><Globe :size="15" aria-hidden="true" /></span>
          <span class="pane-title" data-test="pane-title" :title="meta.title">{{ meta.title || t('liveShare.page.title', 'Browser page') }}</span>
          <span v-if="meta.url" class="ls-page-url" data-test="liveshare-page-url" :title="meta.url">{{ meta.url }}</span>
        </template>
      </div>
      <div class="pane-nav-actions" @mousedown.stop>
        <button class="pane-nav-btn" data-test="liveshare-page-open" :disabled="!external.ok" :title="externalTitle" :aria-label="t('liveShare.page.open', 'Open this address in my own browser')" @click="openExternal">
          <ExternalLink :size="14" aria-hidden="true" />
        </button>
        <button
          v-if="ctx.toggleMaximize && !viewTabs"
          class="pane-nav-btn"
          :title="isMaximized ? t('editor.pane.restore', 'Restore pane') : t('editor.pane.maximize', 'Maximize pane')"
          :aria-label="isMaximized ? t('editor.pane.restore', 'Restore pane') : t('editor.pane.maximize', 'Maximize pane')"
          @click="ctx.toggleMaximize(node.id)"
        >
          <svg v-if="isMaximized" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>
    <div class="ls-page-bar" :class="{ use: info && info.canUse }" data-test="liveshare-page-mode">
      <MousePointerClick v-if="info && info.canUse" :size="12" aria-hidden="true" />
      <span>{{ info && info.canUse ? useLine : viewLine }}</span>
      <span v-if="viewTabs && meta.url" class="ls-page-url" data-test="liveshare-page-url" :title="meta.url">{{ meta.url }}</span>
    </div>
    <div class="ls-page-body">
      <img
        v-show="frameUrl && !overlay"
        ref="imgEl"
        class="ls-page-frame"
        :class="{ use: canUse }"
        :src="frameUrl || undefined"
        :alt="meta.title || t('liveShare.page.title', 'Browser page')"
        draggable="false"
        data-test="liveshare-page-frame"
        @mousedown="(e) => onMouse(e, 'down')"
        @mouseup="(e) => onMouse(e, 'up')"
        @mousemove="(e) => onMouse(e, 'move')"
        @wheel="onWheel"
        @contextmenu.prevent
      />
      <div v-if="overlay" class="ls-guest-note" role="status" data-test="liveshare-page-note">
        <p>{{ overlay }}</p>
      </div>
      <div v-if="notice" class="ls-page-notice" role="status" data-test="liveshare-page-notice">{{ notice }}</div>
    </div>
  </div>
</template>

<style scoped>
.ls-page-pane {
  outline: none;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.ls-page-url {
  margin-left: 8px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
  font-size: 11px;
}
.ls-page-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 11px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.ls-page-bar.use {
  color: var(--warn);
}
.ls-page-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--term);
}
.ls-page-frame {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}
.ls-page-frame.use {
  cursor: default;
}
.ls-page-notice {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  max-width: 80%;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--surface-3);
  color: var(--text);
  font-size: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
</style>
