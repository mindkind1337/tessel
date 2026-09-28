<script setup>
// A saved review note, inline under its diff line (after Orca's
// DiffCommentCard.tsx and diff-comment-zone-card.tsx, MIT, Copyright (c) 2026
// Lovecast Inc.): "Note line 12", then its actions (send this note to an
// agent, edit, delete) and the text.
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import LucideIcon from './LucideIcon.vue'
import NotesSendMenu from './NotesSendMenu.vue'
import { formatDiffComments } from '../../../shared/sourceControl'
import { t } from '../i18n'

const props = defineProps({
  note: { type: Object, required: true },
  onDelete: { type: Function, required: true },
  // (body) -> Promise<boolean>
  onSave: { type: Function, required: true },
  onDelivered: { type: Function, default: null },
  onResize: { type: Function, default: null }
})

const editing = ref(false)
const draft = ref('')
const submitting = ref(false)
const cardEl = ref(null)
const textEl = ref(null)
const metaText = computed(() => {
  const n = props.note
  const sent = !!n.sentAt
  if (n.startLine !== undefined && n.startLine !== null && n.startLine !== n.lineNumber) {
    const vars = { start: n.startLine, end: n.lineNumber }
    return sent
      ? t('notes.card.linesSent', 'Note lines {{start}}-{{end}} sent', vars)
      : t('notes.card.lines', 'Note lines {{start}}-{{end}}', vars)
  }
  const vars = { line: n.lineNumber }
  return sent ? t('notes.card.lineSent', 'Note line {{line}} sent', vars) : t('notes.card.line', 'Note line {{line}}', vars)
})
const scopes = computed(() => [
  { id: 'note', label: t('notes.card.thisNote', 'This note'), notes: props.note.sentAt ? [] : [props.note], prompt: formatDiffComments([props.note]) }
])
const canSubmit = computed(() => !submitting.value && draft.value.trim().length > 0 && draft.value.trim() !== props.note.body)

async function startEdit() {
  draft.value = props.note.body
  editing.value = true
  await nextTick()
  if (textEl.value) {
    textEl.value.focus()
    textEl.value.setSelectionRange(draft.value.length, draft.value.length)
  }
  if (props.onResize) props.onResize()
}
function cancel() {
  editing.value = false
  draft.value = props.note.body
  nextTick(() => props.onResize && props.onResize())
}
async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    if (await props.onSave(draft.value.trim())) {
      editing.value = false
      nextTick(() => props.onResize && props.onResize())
    }
  } finally {
    submitting.value = false
  }
}
function onKeydown(e) {
  e.stopPropagation()
  if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
    return
  }
  if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}

let ro = null
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && cardEl.value) {
    ro = new ResizeObserver(() => props.onResize && props.onResize())
    ro.observe(cardEl.value)
  }
})
onBeforeUnmount(() => ro && ro.disconnect())
</script>

<template>
  <div ref="cardEl" class="orca-diff-comment-card" data-test="diff-note-card" @mousedown.stop>
    <div class="orca-diff-comment-content-col">
      <div class="orca-diff-comment-header">
        <div class="orca-diff-comment-meta-group">{{ metaText }}</div>
        <div v-if="!editing" class="orca-diff-comment-actions-pill">
          <NotesSendMenu
            :scopes="scopes"
            trigger-class="orca-diff-comment-edit orca-diff-comment-pill-btn"
            :disabled-tooltip="t('notes.card.alreadySent', 'Note already sent')"
            @delivered="(n) => onDelivered && onDelivered(n)"
          />
          <span class="orca-diff-comment-pill-divider"></span>
          <button type="button" class="orca-diff-comment-pill-btn" :title="t('notes.card.edit', 'Edit note')" :aria-label="t('notes.card.edit', 'Edit note')" @click.prevent.stop="startEdit">
            <LucideIcon name="pencil" :size="12" />
          </button>
          <span class="orca-diff-comment-pill-divider"></span>
          <button
            type="button"
            class="orca-diff-comment-pill-btn orca-diff-comment-pill-btn-danger"
            :title="t('notes.card.delete', 'Delete note')"
            :aria-label="t('notes.card.delete', 'Delete note')"
            data-test="diff-note-delete"
            @click.prevent.stop="onDelete()"
          >
            <LucideIcon name="trash" :size="12" />
          </button>
        </div>
      </div>
      <div v-if="editing" class="orca-edit-col">
        <textarea ref="textEl" v-model="draft" class="orca-diff-comment-popover-textarea" rows="3" @keydown="onKeydown"></textarea>
        <div class="orca-diff-comment-popover-footer">
          <button type="button" class="orca-btn-ghost" :disabled="submitting" @click="cancel">
            {{ t('notes.card.cancel', 'Cancel') }}
          </button>
          <button
            type="button"
            class="orca-btn-primary"
            :disabled="!canSubmit"
            :title="submitting ? t('notes.card.saving', 'Saving…') : undefined"
            @click="submit"
          >
            {{ t('notes.card.save', 'Save') }}
            <LucideIcon name="cornerDownLeft" :size="12" class="orca-kbd-icon" />
          </button>
        </div>
      </div>
      <div v-else class="orca-diff-comment-body">{{ note.body }}</div>
    </div>
  </div>
</template>
