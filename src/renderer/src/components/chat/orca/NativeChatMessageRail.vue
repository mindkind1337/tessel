<script setup>
// After Orca's NativeChatMessageRail.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * The rail itself: a column of ticks down the right edge of the transcript, one
 * per user message, with a hover panel that previews them and jumps on click.
 * Props: rail (what useNativeChatMessageRail returns — { ticks, items, activeId,
 *   visible }, refs or plain values), scrollRef (the transcript's scroll
 *   element, or a ref to it), pendingId (a tick whose older history is still
 *   paging in).
 * Emits: select(item), readerScroll() (the reader scrolled the transcript
 *   through the rail).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, unref, watch } from 'vue'
import { t } from '../../../i18n'
import { Popover, PopoverContent, PopoverTrigger } from './ui/index.js'
import NativeChatMessageRailItems from './NativeChatMessageRailItems.vue'

const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2
/** Nominal line height for line-mode wheel deltas, which arrive as ~3 per notch. */
const WHEEL_LINE_PX = 16

const props = defineProps({
  rail: { type: Object, required: true },
  scrollRef: { type: null, default: null },
  pendingId: { type: String, default: null }
})
const emit = defineEmits(['select', 'readerScroll'])

const ticks = computed(() => unref(props.rail.ticks) ?? [])
const items = computed(() => unref(props.rail.items) ?? [])
const activeId = computed(() => unref(props.rail.activeId) ?? null)
const visible = computed(() => unref(props.rail.visible) === true)
const label = computed(() => t('chat.orca.railLabel', 'Your messages'))

// A short pane: only the ticks its height holds (3 px each, 8 px apart),
// spread over the conversation and always with the current one, instead of a
// column running over the composer.
const TICK_STEP = 11
const railEl = ref(null)
const railHeight = ref(0)
let railObserver = null
onMounted(() => {
  if (typeof ResizeObserver !== 'function') return
  railObserver = new ResizeObserver((entries) => {
    railHeight.value = entries[0]?.contentRect?.height || 0
  })
  watch(railEl, (el, old) => {
    if (old) railObserver.unobserve(old)
    if (el) railObserver.observe(el)
  }, { immediate: true })
})
onBeforeUnmount(() => railObserver?.disconnect())
const shownTicks = computed(() => fitTicks(ticks.value, activeId.value, railHeight.value))
function fitTicks(list, active, height) {
  if (!height) return list
  const fit = Math.floor((height + 8) / TICK_STEP)
  if (list.length <= fit) return list
  if (fit < 1) return []
  const picked = new Set(fit === 1 ? [list.length - 1] : Array.from({ length: fit }, (_, i) => Math.round((i * (list.length - 1)) / (fit - 1))))
  const at = list.findIndex((item) => item.id === active)
  if (at >= 0 && !picked.has(at)) {
    let near = -1
    for (const i of picked) if (near < 0 || Math.abs(i - at) < Math.abs(near - at)) near = i
    picked.delete(near)
    picked.add(at)
  }
  return list.filter((_, i) => picked.has(i))
}

// Hover preserves focus; activation enters the focus-managed prompt picker.
const mode = ref(null)
// A pick that pages history in keeps the list open, its item pulsing, until the
// jump lands or is abandoned; then it closes as any pick does.
const heldId = ref(null)
function releaseHeld() {
  if (heldId.value !== null && (heldId.value !== props.pendingId || mode.value === null)) {
    heldId.value = null
    mode.value = null
  }
}
// The reference checks this on every render; here, whenever the pending pick
// or the mode changes (the pick itself arrives with the parent's next render).
watch([() => props.pendingId, mode], releaseHeld)

let closeTimer = null
let restoreFocus = false
const open = computed(() => mode.value !== null)

function cancelClose() {
  if (closeTimer !== null) clearTimeout(closeTimer)
  closeTimer = null
}
function leavePreview() {
  cancelClose()
  if (mode.value === 'hover') closeTimer = setTimeout(() => (mode.value = null), 120)
}
onBeforeUnmount(() => {
  if (closeTimer !== null) clearTimeout(closeTimer)
})

function onOpenChange(next) {
  cancelClose()
  if (next) restoreFocus = true
  mode.value = next ? 'interactive' : null
}
function onPointerEnter(event) {
  if (event.pointerType === 'touch') return
  cancelClose()
  if (mode.value === null) restoreFocus = false
  mode.value = mode.value ?? 'hover'
}
function onTriggerClick(event) {
  cancelClose()
  if (mode.value === 'hover') {
    event.preventDefault()
    restoreFocus = true
    mode.value = 'interactive'
  }
}
// The rail overlays the transcript without being inside it, so a wheel
// here would otherwise land on nothing and freeze the scroll. Deltas
// arrive in lines or pages on some platforms, not only in pixels.
function onWheel(event) {
  const element = unref(props.scrollRef)
  if (!element) return
  const scale =
    event.deltaMode === WHEEL_DELTA_LINE
      ? WHEEL_LINE_PX
      : event.deltaMode === WHEEL_DELTA_PAGE
        ? element.clientHeight
        : 1
  element.scrollTop += event.deltaY * scale
  emit('readerScroll')
}
function onContentFocus() {
  cancelClose()
  restoreFocus = true
  mode.value = 'interactive'
}
function onCloseAutoFocus(event) {
  if (!restoreFocus) event.preventDefault()
}
function onSelect(item) {
  emit('select', item)
  if (item.slotIndex === null) {
    heldId.value = item.id
    // The parent's pending pick reaches this prop on its next render.
    nextTick(releaseHeld)
  } else {
    mode.value = null
  }
}
</script>

<template>
  <Popover v-if="visible" :open="open" @update:open="onOpenChange">
    <PopoverTrigger as-child>
      <button
        type="button"
        ref="railEl"
        data-native-chat-rail
        :aria-label="label"
        class="nc-rail"
        @pointerenter="onPointerEnter"
        @pointerleave="leavePreview"
        @click="onTriggerClick"
        @wheel="onWheel"
      >
        <span
          v-for="item in shownTicks"
          :key="item.id"
          aria-hidden="true"
          :class="['nc-rail__tick', item.id === activeId ? 'nc-rail__tick--active' : 'nc-rail__tick--idle']"
        />
      </button>
    </PopoverTrigger>
    <PopoverContent
      side="left"
      align="center"
      :aria-label="label"
      class="nc-rail-panel"
      @pointerenter="cancelClose"
      @pointerleave="leavePreview"
      @focusin="onContentFocus"
      @open-auto-focus="(event) => event.preventDefault()"
      @close-auto-focus="onCloseAutoFocus"
    >
      <NativeChatMessageRailItems
        :mode="mode"
        :items="items"
        :active-id="activeId"
        :pending-id="pendingId"
        @select="onSelect"
      />
    </PopoverContent>
  </Popover>
</template>

<style scoped>
.nc-rail {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 14px;
  z-index: 10;
  display: flex;
  width: 16px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: default;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.nc-rail:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-rail__tick {
  height: 3px;
  flex-shrink: 0;
  border-radius: 9999px;
  transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-rail__tick--active {
  width: 20px;
  background: color-mix(in srgb, var(--nc-foreground) 30%, transparent);
}
.nc-rail:hover .nc-rail__tick--active {
  background: color-mix(in srgb, var(--nc-foreground) 70%, transparent);
}
.nc-rail__tick--idle {
  width: 12px;
  background: color-mix(in srgb, var(--nc-foreground) 10%, transparent);
}
.nc-rail:hover .nc-rail__tick--idle {
  background: color-mix(in srgb, var(--nc-foreground) 25%, transparent);
}
.nc-rail-panel {
  box-sizing: border-box;
  width: 288px;
  padding: 4px;
}
</style>
