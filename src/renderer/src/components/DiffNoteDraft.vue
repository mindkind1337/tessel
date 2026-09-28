<script setup>
// The composer for a new review note, inline under a diff line (after Orca's
// DiffCommentDraftCard.tsx, MIT, Copyright (c) 2026 Lovecast Inc.): Enter
// (or Ctrl+Enter) adds it, Shift+Enter is a new line, Esc cancels; a click
// elsewhere cancels an empty draft.
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import LucideIcon from './LucideIcon.vue'
import { t } from '../i18n'

const props = defineProps({
  lineNumber: { type: Number, required: true },
  startLine: { type: Number, default: null },
  placeholder: { type: String, default: null },
  onCancel: { type: Function, required: true },
  // (body) -> Promise<boolean>
  onSubmit: { type: Function, required: true },
  onResize: { type: Function, default: null }
})

const body = ref('')
const submitting = ref(false)
const cardEl = ref(null)
const textEl = ref(null)
const headerLabel = computed(() =>
  props.startLine && props.startLine !== props.lineNumber
    ? t('notes.draft.lines', 'Lines {{start}}-{{end}}', { start: props.startLine, end: props.lineNumber })
    : t('notes.draft.line', 'Line {{line}}', { line: props.lineNumber })
)
const shownPlaceholder = computed(() => props.placeholder || t('notes.draft.placeholder', 'Add note for the AI'))
const canSubmit = computed(() => !submitting.value && /\S/.test(body.value))

function resizeTextarea() {
  const ta = textEl.value
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = `${Math.min(240, Math.max(56, ta.scrollHeight + 2))}px`
  if (props.onResize) props.onResize()
}

async function submit() {
  if (!canSubmit.value) return
  if (textEl.value) textEl.value.focus()
  submitting.value = true
  let ok = false
  try {
    ok = await props.onSubmit(body.value.trim())
  } catch {
    ok = false
  }
  if (!ok) submitting.value = false
}

function onKeydown(e) {
  e.stopPropagation()
  if (e.key === 'Escape') {
    e.preventDefault()
    if (!submitting.value) props.onCancel()
    return
  }
  const isEnter = e.key === 'Enter' && !e.isComposing
  if (isEnter && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
    e.preventDefault()
    if (!submitting.value) submit()
  }
}

function onDocumentMouseDown(e) {
  const card = cardEl.value
  if (!card || card.contains(e.target)) return
  // Keep a draft with text when the user clicks another line's add button.
  if (/\S/.test(body.value)) return
  props.onCancel()
}

let ro = null
onMounted(async () => {
  await nextTick()
  if (textEl.value) textEl.value.focus()
  requestAnimationFrame(() => textEl.value && textEl.value.focus())
  document.addEventListener('mousedown', onDocumentMouseDown)
  if (typeof ResizeObserver !== 'undefined' && cardEl.value) {
    ro = new ResizeObserver(() => props.onResize && props.onResize())
    ro.observe(cardEl.value)
  }
  if (props.onResize) props.onResize()
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown)
  if (ro) ro.disconnect()
})
</script>

<template>
  <div
    ref="cardEl"
    class="orca-diff-comment-popover orca-diff-comment-draft-card"
    role="region"
    :aria-label="headerLabel"
    data-test="diff-note-draft"
    @mousedown.stop
    @click.stop
  >
    <div class="orca-diff-comment-content-col orca-gap-2">
      <div class="orca-diff-comment-popover-label">{{ headerLabel }}</div>
      <textarea
        ref="textEl"
        v-model="body"
        class="orca-diff-comment-popover-textarea"
        :placeholder="shownPlaceholder"
        rows="3"
        data-test="diff-note-input"
        @input="resizeTextarea"
        @keydown="onKeydown"
      ></textarea>
      <div class="orca-diff-comment-popover-footer">
        <button type="button" class="orca-btn-ghost" :disabled="submitting" @click="onCancel()">
          {{ t('notes.draft.cancel', 'Cancel') }}
        </button>
        <button
          type="button"
          class="orca-btn-primary"
          :aria-label="t('notes.draft.add', 'Add note')"
          :disabled="!canSubmit"
          data-test="diff-note-add"
          @click="submit"
        >
          {{ submitting ? t('notes.draft.adding', 'Adding...') : t('notes.draft.add', 'Add note') }}
          <LucideIcon v-if="!submitting" name="cornerDownLeft" :size="12" class="orca-kbd-icon" />
        </button>
      </div>
    </div>
  </div>
</template>
