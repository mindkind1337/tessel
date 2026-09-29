<script setup>
// Design Mode over a browser pane's page: pick elements in the page, say what
// should change on each, then send it all to an agent (or copy it).
// After Orca's Annotate + Grab (MIT, Copyright (c) 2026 Lovecast Inc.):
// src/renderer/src/components/browser-pane/annotate/useGrabMode.ts,
// use-browser-page-grab-annotations.ts, pending-browser-annotation-card.tsx,
// browser-page-annotation-tray.tsx, browser-page-grab-toast.tsx and
// assemble-chrome/browser-page-chrome-banners.tsx.
// The page is untrusted: everything that comes from it is shown as text.
import { ref, reactive, computed, watch, nextTick, inject, onMounted, onBeforeUnmount } from 'vue'
import {
  Crosshair,
  MessageSquarePlus,
  Send,
  Copy,
  CircleCheck,
  Trash2,
  Pencil,
  PencilLine,
  MessageCircleQuestionMark,
  Image,
  Camera,
  CornerDownLeft,
  X
} from 'lucide-vue-next'
import { t } from '../i18n'
import { notesDelivery } from '../notesDelivery'
import { formatElementContext } from '../../../shared/browserContext'
import {
  MAX_ITEMS,
  MAX_COMMENT,
  canAdd,
  addElementItem,
  addScreenshotItem,
  updateItem,
  removeItem,
  removeItems,
  payloadName,
  fileName,
  buildFeedbackMessage
} from '../browser/designMode'

const props = defineProps({
  guestId: { type: Number, default: null },
  pageUrl: { type: String, default: '' },
  pageTitle: { type: String, default: '' },
  paneId: { type: String, default: '' }
})
const emit = defineEmits(['active'])

const ctx = inject('panelCtx', null)
const api = () => (window.shellApi && window.shellApi.browser) || null

const active = ref(false)
const items = reactive([])
const pending = ref(null) // { payload, screenshot }
const pendingComment = ref('')
const pendingIntent = ref('change')
const pendingThumb = ref(null) // data URL of the element's screenshot
const pickError = ref('') // shown in the banner; the mode stays on
const flash = ref(null) // { text, kind }
const copiedAll = ref(false)
const commentEl = ref(null)
const rootEl = ref(null)

// Edit one tray row at a time.
const editingId = ref(null)
const editComment = ref('')
const editIntent = ref('change')

// Send menu (agent panes of the workspace).
const sendOpen = ref(false)
const sendBtn = ref(null)
const sendMenu = ref(null)
const sendPos = ref({ top: 0, right: 0 })
const targets = ref([])

const thumbs = reactive({}) // item id -> data URL

let gen = 0 // bumps on every stop: a pick that resolves late is ignored
let pickingGuest = null
let cardSeq = 0
let flashTimer = null
let copiedTimer = null
let alive = true

const intentOptions = computed(() => [
  { value: 'change', label: t('browserDesign.intent.change', 'Change'), icon: PencilLine },
  { value: 'question', label: t('browserDesign.intent.question', 'Question'), icon: MessageCircleQuestionMark }
])
const intentLabel = (v) => (v === 'question' ? t('browserDesign.intent.question', 'Question') : t('browserDesign.intent.change', 'Change'))

const full = computed(() => !canAdd(items))
const pendingName = computed(() => (pending.value ? payloadName(pending.value.payload) : ''))
const pendingSelector = computed(() => {
  const el = pending.value && pending.value.payload && pending.value.payload.element
  return el ? String(el.selector || '') : ''
})
const pendingTrimmed = computed(() => pendingComment.value.trim())
// Until the thumbnail loads (or when it cannot): the file's name.
const shotSavedText = computed(() => {
  const shot = pending.value && pending.value.screenshot
  return shot ? t('browserDesign.card.shotSaved', 'Screenshot saved: {{name}}', { name: fileName(shot.path) }) : ''
})

const trayTitle = computed(() => {
  const n = items.length
  return n === 1
    ? t('browserDesign.tray.count', '{{count}} annotation', { count: n })
    : t('browserDesign.tray.count', '{{count}} annotations', { count: n })
})

const bannerText = computed(() => {
  if (pickError.value) return pickError.value
  if (pending.value) return t('browserDesign.banner.pending', 'Add feedback for the selected element.')
  const n = items.length
  if (n === 1) return t('browserDesign.banner.ready', '{{count}} annotation ready. Select another element or send all feedback.', { count: n })
  if (n > 1) return t('browserDesign.banner.ready', '{{count}} annotations ready. Select another element or send all feedback.', { count: n })
  return t('browserDesign.banner.idle', 'Click an element to add feedback for the agent.')
})

function notReady() {
  showFlash(t('browserDesign.notReady', "This page isn't ready for element selection yet."), 'error')
}

function showFlash(text, kind = 'success') {
  if (!alive) return
  clearTimeout(flashTimer)
  flash.value = { text, kind }
  flashTimer = setTimeout(() => (flash.value = null), kind === 'error' ? 4000 : 2000)
}

function setActive(on) {
  if (active.value === on) return
  active.value = on
  emit('active', on)
}

// --- The pick loop -----------------------------------------------------------

function start() {
  const b = api()
  if (!b || props.guestId == null) return notReady()
  pickError.value = ''
  setActive(true)
  arm()
}

// Wait for one click in the page. Resolves when the user picks an element,
// presses Escape in the page, or we cancel.
async function arm() {
  const b = api()
  if (!active.value || pending.value || !b) return
  const guest = props.guestId
  if (guest == null) {
    stop()
    return notReady()
  }
  const my = ++gen
  pickingGuest = guest
  let res
  try {
    res = await b.pick(guest)
  } catch (err) {
    res = { ok: false, code: 'failed', error: err && err.message }
  }
  if (my !== gen) return // stopped or re-armed meanwhile
  pickingGuest = null
  if (!alive || !active.value || guest !== props.guestId) return
  if (!res || res.ok === false) {
    pickError.value =
      res && res.code === 'no-page'
        ? t('browserDesign.notReady', "This page isn't ready for element selection yet.")
        : t('browserDesign.grabFailed', 'Grab failed: {{error}}', {
            error: (res && res.error) || t('browserDesign.unknownError', 'Unknown error')
          })
    return
  }
  if (res.cancelled) {
    // Escape in the page: Design Mode ends.
    stop()
    return
  }
  if (!res.payload || !res.payload.element) {
    arm()
    return
  }
  pickError.value = ''
  openPending(res.payload, res.screenshot || null)
}

function retry() {
  pickError.value = ''
  arm()
}

function stop() {
  gen++
  const b = api()
  if (pickingGuest != null && b && typeof b.cancelPick === 'function') {
    try {
      Promise.resolve(b.cancelPick(pickingGuest)).catch(() => {})
    } catch {
      // The page is gone: nothing to cancel.
    }
  }
  pickingGuest = null
  pending.value = null
  pickError.value = ''
  setActive(false)
}

function toggle() {
  if (active.value) stop()
  else start()
}

// --- The pending card --------------------------------------------------------

function openPending(payload, screenshot) {
  const card = ++cardSeq
  pending.value = { payload, screenshot }
  pendingComment.value = ''
  pendingIntent.value = 'change'
  pendingThumb.value = null
  if (screenshot && screenshot.path) loadThumb(screenshot.path).then((src) => {
    if (pending.value && card === cardSeq) pendingThumb.value = src // still this card
  })
  nextTick(() => commentEl.value && commentEl.value.focus())
}

async function loadThumb(path) {
  const view = window.shellApi && window.shellApi.viewImage
  if (typeof view !== 'function') return null
  try {
    const r = await view(path)
    return r && r.ok && typeof r.dataUrl === 'string' && r.dataUrl.startsWith('data:image/') ? r.dataUrl : null
  } catch {
    return null
  }
}

function addPending() {
  if (!pending.value) return
  const { payload, screenshot } = pending.value
  const r = addElementItem(items, { payload, comment: pendingComment.value, intent: pendingIntent.value, screenshot })
  if (!r.ok) {
    if (r.reason === 'full') showFlash(fullText(), 'error')
    return
  }
  if (pendingThumb.value) thumbs[r.item.id] = pendingThumb.value
  pending.value = null
  showFlash(t('browserDesign.added', 'Annotation added'))
  arm()
}

function cancelPending() {
  pending.value = null
  arm()
}

function onCommentKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancelPending()
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    e.stopPropagation()
    if (pendingTrimmed.value && !full.value) addPending()
  }
}

async function copyElement() {
  if (!pending.value) return
  if (await writeClipboard(formatElementContext(pending.value.payload))) showFlash(t('browserDesign.copied', 'Copied'))
}

const fullText = () => t('browserDesign.full', 'You can add up to {{max}} annotations. Send or clear some first.', { max: MAX_ITEMS })

// --- Page screenshot ---------------------------------------------------------

async function screenshot() {
  const b = api()
  if (!b || props.guestId == null) return notReady()
  if (full.value) return showFlash(fullText(), 'error')
  let res
  try {
    res = await b.screenshot(props.guestId)
  } catch {
    res = null
  }
  if (!alive) return
  if (!res || !res.ok || !res.screenshot) {
    showFlash(t('browserDesign.screenshotFailed', 'Could not take a screenshot of the page.'), 'error')
    return
  }
  const r = addScreenshotItem(items, res.screenshot)
  if (!r.ok) {
    if (r.reason === 'full') showFlash(fullText(), 'error')
    return
  }
  showFlash(t('browserDesign.screenshotAdded', 'Screenshot added'))
  loadThumb(res.screenshot.path).then((src) => {
    if (src) thumbs[r.item.id] = src
  })
}

async function copyImage(item) {
  const b = api()
  if (!b || !item.screenshot) return
  try {
    const r = await b.copyImage(item.screenshot.path)
    if (r && r.ok) showFlash(t('browserDesign.imageCopied', 'Image copied'))
    else showFlash(t('browserDesign.imageCopyFailed', 'Could not copy the image.'), 'error')
  } catch {
    showFlash(t('browserDesign.imageCopyFailed', 'Could not copy the image.'), 'error')
  }
}

// --- The tray ----------------------------------------------------------------

const rowName = (item) => (item.kind === 'element' ? payloadName(item.payload) : t('browserDesign.pageScreenshot', 'Page screenshot'))

function startEdit(item) {
  editingId.value = item.id
  editComment.value = item.comment
  editIntent.value = item.intent
}
function cancelEdit() {
  editingId.value = null
}
function saveEdit() {
  if (!editingId.value) return
  if (updateItem(items, editingId.value, { comment: editComment.value, intent: editIntent.value })) editingId.value = null
}
function onEditKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancelEdit()
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.tagName === 'TEXTAREA') {
    e.preventDefault()
    e.stopPropagation()
    saveEdit()
  }
}
const editCanSave = (item) => item.kind !== 'element' || !!editComment.value.trim()

function deleteItem(item) {
  removeItem(items, item.id)
  delete thumbs[item.id]
}
function clearAll() {
  items.splice(0)
  for (const k of Object.keys(thumbs)) delete thumbs[k]
}
// A delete or clear while a row is mid-edit must not leave edit state behind.
watch(
  () => items.length,
  () => {
    if (editingId.value && !items.some((i) => i.id === editingId.value)) editingId.value = null
    if (!items.length) closeSend()
  }
)

function message() {
  return buildFeedbackMessage({ url: props.pageUrl, title: props.pageTitle, viewport: null, items })
}

async function writeClipboard(text) {
  try {
    if (window.shellApi && typeof window.shellApi.writeClipboard === 'function') {
      await window.shellApi.writeClipboard(text)
      return true
    }
  } catch {
    // fall through
  }
  showFlash(t('browserDesign.copyFailed', 'Could not copy to the clipboard.'), 'error')
  return false
}

async function copyAll() {
  if (!items.length) return
  if (!(await writeClipboard(message()))) return
  copiedAll.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copiedAll.value = false), 1500)
}

// --- Send to an agent --------------------------------------------------------

function toggleSend() {
  if (sendOpen.value) return closeSend()
  if (!items.length) return
  const d = notesDelivery()
  targets.value = d ? d.targets() : []
  const r = sendBtn.value && sendBtn.value.getBoundingClientRect()
  if (r) sendPos.value = { top: Math.round(r.bottom + 4), right: Math.max(4, Math.round(window.innerWidth - r.right)) }
  sendOpen.value = true
  nextTick(() => document.addEventListener('mousedown', onOutside, true))
}
function closeSend() {
  sendOpen.value = false
  document.removeEventListener('mousedown', onOutside, true)
}
function onOutside(e) {
  if (sendBtn.value && sendBtn.value.contains(e.target)) return
  if (sendMenu.value && sendMenu.value.contains(e.target)) return
  closeSend()
}

function sendTo(target) {
  const d = notesDelivery()
  if (!d || target.disabledReason || !items.length) return
  const ids = items.map((i) => i.id)
  const text = message()
  const agent = target.label
  closeSend()
  d.send(target.id, text, {
    onDelivered: () => {
      removeItems(items, ids)
      for (const id of ids) delete thumbs[id]
      showFlash(t('browserDesign.sent', 'Feedback sent to {{agent}}', { agent }))
    },
    onFailed: () => showFlash(t('browserDesign.sendFailed', 'The feedback could not be sent to {{agent}}.', { agent }), 'error')
  })
}

// --- Keys, page changes, lifetime ---------------------------------------------

// Escape in Tessel (not in a text field) ends the pending card, then the mode.
// Only for the pane in use, so one Escape does not stop every browser pane.
function onKey(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  if (sendOpen.value) {
    e.preventDefault()
    closeSend()
    return
  }
  if (!active.value && !pending.value) return
  if (ctx && ctx.activeId && props.paneId && ctx.activeId.value !== props.paneId) return
  const el = e.target
  if (el && el.closest && el.closest('textarea, input, select, [contenteditable="true"]')) return
  e.preventDefault()
  if (pending.value) cancelPending()
  else stop()
}

// A new page (the guest was replaced or reloaded): the old pick is over.
watch(
  () => props.guestId,
  () => {
    if (active.value || pickingGuest != null) stop()
  }
)

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  alive = false
  stop()
  clearTimeout(flashTimer)
  clearTimeout(copiedTimer)
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('mousedown', onOutside, true)
})

defineExpose({ toggle, stop, screenshot, isActive: () => active.value })
</script>

<template>
  <div ref="rootEl" class="dm" data-test="design-mode">
    <div v-if="active" class="dm-banner" :class="{ error: !!pickError }" role="status" data-test="design-banner">
      <Crosshair :size="14" class="dm-banner-icon" aria-hidden="true" />
      <span class="dm-banner-text">{{ bannerText }}</span>
      <button v-if="pickError" type="button" class="dm-btn ghost" data-test="design-retry" @click="retry">
        {{ t('browserDesign.retry', 'Try again') }}
      </button>
      <button
        type="button"
        class="dm-btn ghost"
        :title="t('browserDesign.stopTitle', 'Leave Design Mode (Esc)')"
        data-test="design-cancel"
        @click="stop"
      >
        {{ t('browserDesign.cancel', 'Cancel') }}
      </button>
    </div>

    <div v-if="flash" class="dm-flash" :class="flash.kind" role="status" data-test="design-flash">
      <CircleCheck v-if="flash.kind !== 'error'" :size="14" aria-hidden="true" />
      <X v-else :size="14" aria-hidden="true" />
      <span>{{ flash.text }}</span>
    </div>

    <div
      v-if="pending"
      class="dm-card"
      role="dialog"
      :aria-label="t('browserDesign.card.aria', 'Add browser annotation')"
      data-test="design-card"
    >
      <div class="dm-card-head">
        <div class="dm-card-id">
          <div class="dm-card-name">{{ pendingName }}</div>
          <div class="dm-mono">{{ pendingSelector }}</div>
        </div>
        <button
          type="button"
          class="dm-icon-btn"
          :title="t('browserDesign.card.copyContext', 'Copy this element for an agent')"
          :aria-label="t('browserDesign.card.copyContext', 'Copy this element for an agent')"
          data-test="design-copy-element"
          @click="copyElement"
        >
          <Copy :size="14" />
        </button>
      </div>
      <div v-if="pending.screenshot" class="dm-shot">
        <img v-if="pendingThumb" :src="pendingThumb" :alt="t('browserDesign.card.shotAlt', 'Screenshot of the element')" />
        <span v-else class="dm-dim">{{ shotSavedText }}</span>
      </div>
      <textarea
        ref="commentEl"
        v-model="pendingComment"
        class="dm-textarea"
        :maxlength="MAX_COMMENT"
        :placeholder="t('browserDesign.card.placeholder', 'Describe what the agent should change here...')"
        :aria-label="t('browserDesign.card.comment', 'Annotation comment')"
        data-test="design-comment"
        @keydown="onCommentKey"
      ></textarea>
      <div class="dm-label">{{ t('browserDesign.intent.title', 'Intent') }}</div>
      <div class="dm-toggle" role="radiogroup" :aria-label="t('browserDesign.intent.aria', 'Annotation intent')">
        <button
          v-for="o in intentOptions"
          :key="o.value"
          type="button"
          role="radio"
          :aria-checked="pendingIntent === o.value"
          :class="{ on: pendingIntent === o.value }"
          :data-test="`design-intent-${o.value}`"
          @click="pendingIntent = o.value"
        >
          <component :is="o.icon" :size="13" aria-hidden="true" />
          <span>{{ o.label }}</span>
        </button>
      </div>
      <div v-if="full" class="dm-note">{{ fullText() }}</div>
      <div class="dm-actions">
        <button type="button" class="dm-btn ghost" data-test="design-card-cancel" @click="cancelPending">
          {{ t('browserDesign.cancel', 'Cancel') }}
        </button>
        <button
          type="button"
          class="dm-btn primary"
          :disabled="!pendingTrimmed || full"
          :title="t('browserDesign.card.addTitle', 'Add (Ctrl+Enter)')"
          data-test="design-add"
          @click="addPending"
        >
          <MessageSquarePlus :size="13" aria-hidden="true" />
          <span>{{ t('browserDesign.card.add', 'Add') }}</span>
          <span class="dm-kbd" aria-hidden="true">Ctrl <CornerDownLeft :size="11" /></span>
        </button>
      </div>
    </div>

    <div v-if="items.length" class="dm-tray" data-test="design-tray">
      <div class="dm-tray-head">
        <MessageSquarePlus :size="14" class="dm-dim" aria-hidden="true" />
        <div class="dm-tray-title">{{ trayTitle }}</div>
        <button
          ref="sendBtn"
          type="button"
          class="dm-btn outline"
          :title="t('browserDesign.tray.sendTitle', 'Send feedback to an agent')"
          aria-haspopup="menu"
          :aria-expanded="sendOpen"
          data-test="design-send"
          @mousedown.stop
          @click.stop="toggleSend"
        >
          <Send :size="12" aria-hidden="true" />
          <span>{{ t('browserDesign.tray.send', 'Send') }}</span>
        </button>
        <button
          type="button"
          class="dm-btn outline"
          :title="t('browserDesign.tray.copyTitle', 'Copy all feedback as text')"
          data-test="design-copy-all"
          @click="copyAll"
        >
          <CircleCheck v-if="copiedAll" :size="12" aria-hidden="true" />
          <Copy v-else :size="12" aria-hidden="true" />
          <span>{{ copiedAll ? t('browserDesign.copied', 'Copied') : t('browserDesign.tray.copy', 'Copy') }}</span>
        </button>
        <button
          type="button"
          class="dm-icon-btn"
          :title="t('browserDesign.tray.clear', 'Clear annotations')"
          :aria-label="t('browserDesign.tray.clear', 'Clear annotations')"
          data-test="design-clear"
          @click="clearAll"
        >
          <Trash2 :size="13" />
        </button>
      </div>
      <div class="dm-tray-list">
        <div v-for="(item, index) in items" :key="item.id" class="dm-row" data-test="design-row">
          <div class="dm-num">{{ index + 1 }}</div>
          <div v-if="editingId === item.id" class="dm-row-body" @keydown="onEditKey">
            <textarea
              v-model="editComment"
              class="dm-textarea small"
              :maxlength="MAX_COMMENT"
              :aria-label="t('browserDesign.card.comment', 'Annotation comment')"
              :placeholder="item.kind === 'element' ? '' : t('browserDesign.tray.optionalComment', 'Add a comment (optional)')"
              data-test="design-edit-comment"
            ></textarea>
            <div class="dm-toggle small" role="radiogroup" :aria-label="t('browserDesign.intent.aria', 'Annotation intent')">
              <button
                v-for="o in intentOptions"
                :key="o.value"
                type="button"
                role="radio"
                :aria-checked="editIntent === o.value"
                :class="{ on: editIntent === o.value }"
                @click="editIntent = o.value"
              >
                <component :is="o.icon" :size="12" aria-hidden="true" />
                <span>{{ o.label }}</span>
              </button>
            </div>
            <div class="dm-actions">
              <button type="button" class="dm-btn ghost" @click="cancelEdit">{{ t('browserDesign.cancel', 'Cancel') }}</button>
              <button type="button" class="dm-btn primary" :disabled="!editCanSave(item)" data-test="design-save" @click="saveEdit">
                {{ t('browserDesign.tray.save', 'Save') }}
              </button>
            </div>
          </div>
          <template v-else>
            <div class="dm-row-body">
              <div class="dm-row-name">
                <Camera v-if="item.kind === 'screenshot'" :size="12" aria-hidden="true" />
                <span>{{ rowName(item) }}</span>
              </div>
              <img v-if="item.kind === 'screenshot' && thumbs[item.id]" class="dm-row-shot" :src="thumbs[item.id]" :alt="t('browserDesign.pageScreenshot', 'Page screenshot')" />
              <div v-if="item.comment" class="dm-row-comment">{{ item.comment }}</div>
              <div v-else class="dm-row-comment dm-dim">{{ t('browserDesign.tray.noComment', 'No comment') }}</div>
              <div class="dm-row-intent">{{ intentLabel(item.intent) }}</div>
            </div>
            <div class="dm-row-tools">
              <button
                v-if="item.screenshot"
                type="button"
                class="dm-icon-btn"
                :title="t('browserDesign.tray.copyImage', 'Copy image')"
                :aria-label="t('browserDesign.tray.copyImage', 'Copy image')"
                data-test="design-copy-image"
                @click="copyImage(item)"
              >
                <Image :size="12" />
              </button>
              <button
                type="button"
                class="dm-icon-btn"
                :title="t('browserDesign.tray.edit', 'Edit annotation {{n}}', { n: index + 1 })"
                :aria-label="t('browserDesign.tray.edit', 'Edit annotation {{n}}', { n: index + 1 })"
                data-test="design-edit"
                @click="startEdit(item)"
              >
                <Pencil :size="12" />
              </button>
              <button
                type="button"
                class="dm-icon-btn"
                :title="t('browserDesign.tray.delete', 'Delete annotation {{n}}', { n: index + 1 })"
                :aria-label="t('browserDesign.tray.delete', 'Delete annotation {{n}}', { n: index + 1 })"
                data-test="design-delete"
                @click="deleteItem(item)"
              >
                <Trash2 :size="12" />
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="sendOpen"
        ref="sendMenu"
        class="ctx-menu dm-send-menu"
        role="menu"
        :style="{ top: sendPos.top + 'px', right: sendPos.right + 'px' }"
        data-test="design-send-menu"
      >
        <div class="dm-menu-label">{{ t('browserDesign.send.to', 'Send feedback to') }}</div>
        <button
          v-for="tg in targets"
          :key="tg.id"
          type="button"
          class="ctx-menu-item dm-target"
          role="menuitem"
          :disabled="!!tg.disabledReason"
          :title="tg.disabledReason || tg.hint || ''"
          data-test="design-send-target"
          @click="sendTo(tg)"
        >
          <span class="dm-target-name">{{ tg.label }}</span>
          <span class="dm-target-state">{{ tg.disabledReason || tg.stateLabel }}</span>
        </button>
        <div v-if="!targets.length" class="dm-menu-empty">{{ t('browserDesign.send.noAgent', 'No agent in this project') }}</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* Covers the page area without taking its clicks: only the banner, card,
   tray and messages catch the mouse. */
.dm {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 5;
  container-type: size;
  font-size: 12px;
  color: var(--text);
}
.dm > * {
  pointer-events: auto;
}
.dm-banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-3);
  color: var(--text-strong);
}
.dm-banner.error {
  background: color-mix(in srgb, var(--danger) 18%, var(--surface-2));
}
.dm-banner-icon {
  flex: none;
  color: var(--text-dim);
}
.dm-banner.error .dm-banner-icon {
  color: var(--danger);
}
.dm-banner-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-flash {
  position: absolute;
  top: 40px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 24px);
  padding: 5px 12px 5px 9px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-strong);
  font-weight: 600;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
}
.dm-flash svg {
  flex: none;
  color: var(--accent);
}
.dm-flash.error svg {
  color: var(--danger);
}
.dm-flash span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-card,
.dm-tray {
  position: absolute;
  bottom: 12px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--surface-2);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.4);
}
.dm-card {
  left: 12px;
  width: min(22rem, calc(100% - 24px));
  max-height: calc(100% - 60px);
  overflow: auto;
  padding: 12px;
  z-index: 2;
}
/* Narrow page: the card goes to the top so the tray stays visible. */
@container (max-width: 44rem) {
  .dm-card {
    bottom: auto;
    top: 40px;
  }
}
.dm-card-head {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 8px;
}
.dm-card-id {
  flex: 1;
  min-width: 0;
}
.dm-card-name {
  color: var(--text-strong);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-mono {
  margin-top: 2px;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-shot {
  margin-bottom: 8px;
}
.dm-shot img {
  display: block;
  max-width: 100%;
  max-height: 120px;
  border: 1px solid var(--border);
  border-radius: 5px;
  object-fit: contain;
  background: var(--backdrop);
}
.dm-dim {
  color: var(--text-dim);
}
.dm-textarea {
  display: block;
  width: 100%;
  height: 96px;
  resize: none;
  padding: 7px 9px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.dm-textarea.small {
  height: 64px;
  font-size: 12px;
}
.dm-textarea:focus-visible {
  border-color: var(--accent);
}
.dm-textarea::placeholder {
  color: var(--text-dim);
}
.dm-label {
  margin: 8px 0 4px;
  color: var(--text-dim);
}
.dm-toggle {
  display: flex;
  gap: 4px;
}
.dm-toggle.small {
  margin-top: 6px;
}
.dm-toggle button {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  cursor: pointer;
}
.dm-toggle.small button {
  height: 24px;
  font-size: 11px;
}
.dm-toggle button:hover {
  color: var(--text-strong);
}
.dm-toggle button.on {
  background: var(--surface-3);
  color: var(--text-strong);
  border-color: color-mix(in srgb, var(--text-strong) 25%, var(--border-strong));
}
.dm-note {
  margin-top: 8px;
  color: var(--warn);
}
.dm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 10px;
}
.dm-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.dm-btn:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text-strong);
}
.dm-btn.outline {
  border-color: var(--border-strong);
}
.dm-btn.primary {
  background: var(--accent);
  color: #0c0d10;
  font-weight: 600;
}
.dm-btn.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 85%, white);
  color: #0c0d10;
}
.dm-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.dm-kbd {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 2px;
  padding: 1px 4px;
  border: 1px solid rgba(0, 0, 0, 0.25);
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
}
.dm-icon-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.dm-icon-btn:hover {
  background: var(--surface-3);
  color: var(--text-strong);
}
.dm-tray {
  right: 12px;
  width: min(20rem, calc(100% - 24px));
  max-height: 45%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dm-tray-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px 7px 12px;
  border-bottom: 1px solid var(--border);
}
.dm-tray-title {
  flex: 1;
  min-width: 0;
  color: var(--text-strong);
  font-weight: 600;
  font-size: 13px;
}
.dm-tray-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 5px;
}
.dm-row {
  display: flex;
  gap: 8px;
  padding: 6px 7px;
  border-radius: 6px;
}
.dm-row:hover,
.dm-row:focus-within {
  background: var(--surface-3);
}
.dm-num {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--accent);
  color: #0c0d10;
  font-size: 10px;
  font-weight: 700;
}
.dm-row-body {
  flex: 1;
  min-width: 0;
}
.dm-row-name {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-strong);
  font-weight: 600;
}
.dm-row-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-row-shot {
  display: block;
  max-width: 100%;
  max-height: 70px;
  margin-top: 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.dm-row-comment {
  margin-top: 2px;
  color: var(--text-dim);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.dm-row-intent {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-dim);
}
.dm-row-tools {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 1px;
  opacity: 0;
  transition: opacity 0.12s;
}
.dm-row:hover .dm-row-tools,
.dm-row:focus-within .dm-row-tools {
  opacity: 1;
}
.dm-send-menu {
  min-width: 220px;
  max-width: 340px;
}
.dm-menu-label {
  padding: 5px 9px 4px;
  color: var(--text-dim);
  font-size: 11px;
}
.dm-target {
  gap: 12px;
}
.dm-target-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-target-state {
  flex: none;
  color: var(--text-dim);
  font-size: 11px;
}
.dm-menu-empty {
  padding: 6px 9px 8px;
  color: var(--text-dim);
}
</style>
