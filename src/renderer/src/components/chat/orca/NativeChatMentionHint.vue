<script setup>
// After Orca's NativeChatAutocompleteMenus.tsx, NativeChatMentionHint (MIT, Copyright (c) 2026 Lovecast Inc.)
// The "@file" hint above the composer; accepted on pointer down so the
// textarea keeps the focus. Tessel: with the project's files that match
// (items), a list of them instead (Up/Down, Enter or Tab, a click).
// Props: query, items (relative paths), activeIndex, listboxId.
// Emits: accept(path?) (no path: the typed query as is).
import { onMounted, shallowRef, watch } from 'vue'
import { FileText } from 'lucide-vue-next'
import { t } from '../../../i18n'

const props = defineProps({
  query: { type: String, default: '' },
  items: { type: Array, default: () => [] },
  activeIndex: { type: Number, default: 0 },
  listboxId: { type: String, default: '' }
})
const emit = defineEmits(['accept'])
const rootRef = shallowRef(null)

function accept(event, path) {
  event.preventDefault()
  emit('accept', path)
}
// Path shown as its name, then its folder.
const nameOf = (path) => String(path).split(/[\\/]/).pop()
const folderOf = (path) => String(path).split(/[\\/]/).slice(0, -1).join('/')

function scrollActiveIntoView() {
  const active = rootRef.value?.querySelector('[aria-selected="true"]')
  active?.scrollIntoView?.({ block: 'nearest' })
}
onMounted(scrollActiveIntoView)
watch([() => props.activeIndex, () => props.items], scrollActiveIntoView, { flush: 'post' })
</script>

<template>
  <div
    v-if="items.length"
    :id="listboxId || undefined"
    ref="rootRef"
    role="listbox"
    class="nc-mention-list nc-ui-scrollbar-sleek"
    :aria-label="t('chat.orca.composer.mentionFiles', 'Files to reference')"
    data-test="chat-mention-list"
  >
    <button
      v-for="(path, index) in items"
      :id="listboxId ? `${listboxId}-mention-${index}` : undefined"
      :key="path"
      type="button"
      role="option"
      :aria-selected="index === activeIndex"
      :class="['nc-mention-option', { 'nc-mention-option--selected': index === activeIndex }]"
      :title="path"
      @pointerdown="accept($event, path)"
    >
      <FileText class="nc-mention-icon" aria-hidden="true" />
      <span class="nc-mention-name">{{ nameOf(path) }}</span>
      <span v-if="folderOf(path)" class="nc-mention-folder">{{ folderOf(path) }}</span>
    </button>
  </div>
  <button v-else type="button" class="nc-mention-hint" @pointerdown="accept($event)">
    {{ t('chat.orca.composer.mentionHint', 'Referencing file:') }}
    <span class="nc-mention-query">@{{ query || '…' }}</span>
  </button>
</template>

<style scoped>
/* absolute bottom-full left-3 right-3 z-20 mb-1 flex w-auto items-center gap-2
   rounded-md border border-border bg-popover px-3 py-1.5 text-left text-xs
   text-muted-foreground shadow-md sm:left-4 sm:right-4.
   Why z-20: matches the slash picker. The composer shell below is a paint
   containment boundary, so it paints at z-index 0 in tree order and would
   otherwise cover this hint's drop shadow. */
.nc-mention-hint {
  position: absolute;
  bottom: 100%;
  left: 12px;
  right: 12px;
  z-index: 20;
  margin-bottom: 4px;
  display: flex;
  width: auto;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  border: 1px solid var(--nc-border);
  border-radius: 6px;
  background: var(--nc-popover);
  padding: 6px 12px;
  text-align: left;
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
  box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  cursor: pointer;
}
@media (min-width: 640px) {
  .nc-mention-hint {
    left: 16px;
    right: 16px;
  }
}
/* font-medium text-foreground */
.nc-mention-query {
  font-weight: 500;
  color: var(--nc-foreground);
}
/* The file list: the slash picker's box. */
.nc-mention-list {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  z-index: 20;
  margin-bottom: 4px;
  max-height: 288px;
  overflow-y: auto;
  box-sizing: border-box;
  border: 1px solid var(--nc-border);
  border-radius: 8px;
  background: var(--nc-popover);
  padding: 4px;
  box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
}
.nc-mention-option {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  padding: 4px 8px;
  text-align: left;
  font: inherit;
  font-size: 13px;
  color: var(--nc-foreground);
  cursor: pointer;
}
.nc-mention-option--selected {
  border-color: var(--nc-border);
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
.nc-mention-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--nc-muted-foreground);
}
.nc-mention-name {
  flex-shrink: 0;
  font-weight: 500;
}
.nc-mention-folder {
  min-width: 0;
  overflow: hidden;
  color: var(--nc-muted-foreground);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
