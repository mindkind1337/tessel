<script setup>
// After Orca's NativeChatQueuedMessageList.tsx and NativeChatQueuedMessageCard.tsx
// (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// Messages sent while the agent works wait here, between the transcript and
// the composer, as one box of cards: never in the transcript (a card becomes
// a message row only once it goes out). Each card can be sent now, edited in
// place (Enter saves, Shift+Enter a new line, Esc cancels) or deleted. Tessel
// edits in place where the reference moves the text back into the composer:
// the card keeps its turn in the queue.
// Props: cards ([{ id, text, caption?, imageCount? }], in queue order),
//   canSendNow (Send now is offered), sendNowTitle (its tooltip), and the
//   actions, each -> Promise<{ ok }> (a failure is the caller's to say):
//   sendNow(id), edit(id, text), remove(id); focusComposer() (focus goes there
//   when the card that had it goes away).
import { nextTick, ref } from 'vue'
import { Check, CornerDownRight, ListEnd, Pencil, Trash2, X } from 'lucide-vue-next'
import { Button } from './ui/index.js'
import { t } from '../../../i18n'

const props = defineProps({
  cards: { type: Array, default: () => [] },
  canSendNow: { type: Boolean, default: false },
  sendNowTitle: { type: String, default: '' },
  sendNow: { type: Function, default: null },
  edit: { type: Function, default: null },
  remove: { type: Function, default: null },
  focusComposer: { type: Function, default: null }
})

const rootRef = ref(null)
const editingId = ref(null)
const editText = ref('')
const editorRef = ref(null)
// One action per card at a time: a double click is not a second request.
const busy = ref(new Set())

function setBusy(id, on) {
  const next = new Set(busy.value)
  if (on) next.add(id)
  else next.delete(id)
  busy.value = next
}
async function act(id, run) {
  if (busy.value.has(id)) return null
  const hadFocus = !!(rootRef.value && rootRef.value.contains(document.activeElement))
  setBusy(id, true)
  let res = null
  try {
    res = await run()
  } catch {
    res = { ok: false }
  } finally {
    setBusy(id, false)
  }
  // Only when the focus was on the cards: never taken from where the user went.
  await nextTick()
  const active = document.activeElement
  if (hadFocus && props.focusComposer && (!active || active === document.body || !rootRef.value || !rootRef.value.contains(active))) props.focusComposer()
  return res
}

function startEdit(card) {
  editingId.value = card.id
  editText.value = card.text
  nextTick(() => {
    const el = Array.isArray(editorRef.value) ? editorRef.value[0] : editorRef.value
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  })
}
function cancelEdit() {
  editingId.value = null
  editText.value = ''
}
async function saveEdit(card) {
  const text = editText.value
  // An emptied card (no image either) is a delete.
  if (!text.trim() && !card.imageCount) return onRemove(card)
  if (text === card.text) return cancelEdit()
  const res = await act(card.id, () => (props.edit ? props.edit(card.id, text) : { ok: false }))
  if (res && res.ok !== false && editingId.value === card.id) cancelEdit()
}
function onEditorKeydown(event, card) {
  if (event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    cancelEdit()
    props.focusComposer && props.focusComposer()
  } else if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void saveEdit(card)
  }
}
function onRemove(card) {
  if (editingId.value === card.id) cancelEdit()
  return act(card.id, () => (props.remove ? props.remove(card.id) : { ok: false }))
}
function onSendNow(card) {
  if (editingId.value === card.id) cancelEdit()
  return act(card.id, () => (props.sendNow ? props.sendNow(card.id) : { ok: false }))
}
function imagesText(n) {
  return n === 1 ? t('chat.orca.queued.imageOne', '+ 1 image') : t('chat.orca.queued.imageMany', '+ {{count}} images', { count: n })
}
</script>

<template>
  <!-- Stays mounted while empty, so the first card is announced. -->
  <div ref="rootRef" aria-live="polite" class="nc-queued-wrap">
    <div v-if="cards.length" class="nc-queued" data-test="chat-queued">
      <ul class="nc-queued-list" :aria-label="t('chat.orca.queued.listLabel', 'Messages waiting for the end of the turn')">
        <li v-for="card in cards" :key="card.id" class="nc-queued-card" data-test="chat-queued-card" :data-queued-id="card.id">
          <ListEnd class="nc-queued-icon" aria-hidden="true" />
          <div v-if="editingId === card.id" class="nc-queued-edit">
            <textarea
              ref="editorRef"
              v-model="editText"
              class="nc-queued-editor"
              data-test="chat-queued-editor"
              rows="2"
              :aria-label="t('chat.orca.queued.editLabel', 'Edit the waiting message')"
              @keydown="onEditorKeydown($event, card)"
            ></textarea>
            <span class="nc-queued-actions">
              <Button type="button" variant="ghost" size="xs" data-test="chat-queued-save" :disabled="busy.has(card.id)" @click="saveEdit(card)">
                <Check class="nc-size-3" aria-hidden="true" />
                {{ t('chat.orca.queued.save', 'Save') }}
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" data-test="chat-queued-cancel" :aria-label="t('chat.orca.queued.cancel', 'Cancel')" :title="t('chat.orca.queued.cancel', 'Cancel')" @click="cancelEdit">
                <X class="nc-size-3" aria-hidden="true" />
              </Button>
            </span>
          </div>
          <template v-else>
            <div class="nc-queued-body">
              <p class="nc-queued-text" data-test="chat-queued-text" :title="card.text">{{ card.text }}</p>
              <p v-if="card.caption || card.imageCount" class="nc-queued-caption" data-test="chat-queued-caption">
                <span v-if="card.imageCount">{{ imagesText(card.imageCount) }}</span>
                <span v-if="card.caption">{{ card.caption }}</span>
              </p>
            </div>
            <span class="nc-queued-actions">
              <Button
                v-if="canSendNow"
                type="button"
                variant="ghost"
                size="xs"
                data-test="chat-queued-send-now"
                :disabled="busy.has(card.id)"
                :title="sendNowTitle || t('chat.orca.queued.sendNowHint', 'Send it now, without waiting for the end of the turn')"
                @click="onSendNow(card)"
              >
                <CornerDownRight class="nc-size-3" aria-hidden="true" />
                {{ t('chat.orca.queued.sendNow', 'Send now') }}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-test="chat-queued-edit"
                :disabled="busy.has(card.id)"
                :aria-label="t('chat.orca.queued.edit', 'Edit message')"
                :title="t('chat.orca.queued.edit', 'Edit message')"
                @click="startEdit(card)"
              >
                <Pencil class="nc-size-3" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-test="chat-queued-delete"
                :disabled="busy.has(card.id)"
                :aria-label="t('chat.orca.queued.delete', 'Delete')"
                :title="t('chat.orca.queued.delete', 'Delete')"
                @click="onRemove(card)"
              >
                <Trash2 class="nc-size-3" aria-hidden="true" />
              </Button>
            </span>
          </template>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.nc-queued-wrap {
  flex-shrink: 0;
}
/* mx-auto w-full max-w-4xl px-4 py-1, one bordered box of rows */
.nc-queued {
  box-sizing: border-box;
  width: 100%;
  max-width: 56rem;
  margin: 0 auto;
  padding: 4px 16px;
}
.nc-queued-list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 12rem;
  overflow-y: auto;
  border: 1px solid var(--nc-border);
  border-radius: 6px;
  background: var(--nc-card, var(--nc-background));
  color: var(--nc-card-foreground, var(--nc-foreground));
}
.nc-queued-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  min-width: 0;
}
.nc-queued-card + .nc-queued-card {
  border-top: 1px solid var(--nc-border);
}
.nc-queued-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--nc-muted-foreground);
}
.nc-queued-body {
  flex: 1 1 auto;
  min-width: 0;
}
.nc-queued-text {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 18px;
}
.nc-queued-caption {
  display: flex;
  gap: 6px;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--nc-muted-foreground);
  font-size: 12px;
  line-height: 16px;
}
.nc-queued-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
}
.nc-queued-edit {
  display: flex;
  flex: 1 1 auto;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}
.nc-queued-editor {
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
  resize: vertical;
  max-height: 10rem;
  padding: 4px 6px;
  border: 1px solid var(--nc-border);
  border-radius: 4px;
  background: var(--nc-background);
  color: var(--nc-foreground);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
}
.nc-queued-editor:focus {
  outline: 2px solid var(--nc-ring, var(--accent, #6aa0ff));
  outline-offset: -1px;
}
.nc-size-3 {
  width: 12px;
  height: 12px;
}
</style>
