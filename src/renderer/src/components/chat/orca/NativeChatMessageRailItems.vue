<script setup>
// After Orca's NativeChatMessageRail.tsx (NativeChatMessageRailItems, internal to
// the rail; MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * The rail's hover / interactive list of the reader's messages.
 * Props: mode ('hover' | 'interactive' | null), items, activeId, pendingId.
 * Emits: select(item).
 */
import { onMounted, ref, watch } from 'vue'
import { t } from '../../../i18n'

const props = defineProps({
  mode: { type: String, default: null },
  items: { type: Array, required: true },
  activeId: { type: String, default: null },
  pendingId: { type: String, default: null }
})
const emit = defineEmits(['select'])

const listRef = ref(null)
let previousMode = null

function railItemLabel(item) {
  if (item.text.length > 0) return item.text
  return item.hasImages
    ? t('chat.orca.railImageMessage', 'Image attachment')
    : t('chat.orca.railEmptyMessage', 'Message')
}

function currentItem() {
  return listRef.value?.querySelector('button[data-current="true"]') ?? null
}

// Reveal the lit row when the list opens or its rows shift — not when a hover
// preview turns interactive, which a press on an item does: moving the list
// then slides the item out from under the pointer and the click is lost. Nor
// while a picked item pages in: each landed page shifts the rows under it.
function revealCurrent() {
  const open = props.mode !== null
  if (open && props.activeId !== null && props.items.length > 0 && props.pendingId === null) {
    currentItem()?.scrollIntoView({ block: 'nearest' })
  }
}

// Entering interactive from the rail moves focus into the list; entering it by
// focusing an item already put focus where the reader chose.
function focusOnInteractive() {
  const list = listRef.value
  if (
    props.mode === 'interactive' &&
    previousMode !== 'interactive' &&
    !list?.contains(document.activeElement)
  ) {
    const focusTarget =
      (props.activeId === null ? null : currentItem()) ?? list?.querySelector('button')
    focusTarget?.focus({ preventScroll: true })
  }
  previousMode = props.mode
}

onMounted(() => {
  revealCurrent()
  focusOnInteractive()
})
watch(
  [() => props.activeId, () => props.items, () => props.mode !== null, () => props.pendingId],
  revealCurrent,
  { flush: 'post' }
)
watch([() => props.activeId, () => props.mode], focusOnInteractive, { flush: 'post' })
</script>

<template>
  <ul ref="listRef" class="nc-scrollbar-sleek nc-rail-items">
    <li v-for="item in items" :key="item.id">
      <button
        type="button"
        :aria-current="item.id === activeId ? 'true' : undefined"
        :aria-busy="item.id === pendingId ? 'true' : undefined"
        :data-current="item.id === activeId ? 'true' : 'false'"
        :class="['nc-rail-items__button', { 'nc-rail-items__button--current': item.id === activeId }]"
        @click="emit('select', item)"
      >
        <span
          :class="[
            'nc-rail-items__label',
            item.id === activeId ? 'nc-rail-items__label--current' : 'nc-rail-items__label--muted',
            { 'nc-animate-pulse': item.id === pendingId }
          ]"
          >{{ railItemLabel(item) }}</span
        >
      </button>
    </li>
  </ul>
</template>

<style scoped>
.nc-rail-items {
  max-height: 256px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-x: hidden;
  overflow-y: auto;
}
.nc-rail-items__button {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  margin: 0;
  border: 0;
  border-radius: 6px;
  padding: 6px 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  /* transition-colors */
  transition-property: color, background-color, border-color, text-decoration-color, fill, stroke;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  transition-duration: 150ms;
}
.nc-rail-items__button:hover {
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
.nc-rail-items__button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-rail-items__button--current {
  background: var(--nc-accent);
}
.nc-rail-items__label {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.375;
}
.nc-rail-items__label--current {
  color: var(--nc-foreground);
}
.nc-rail-items__label--muted {
  color: var(--nc-muted-foreground);
}
</style>
