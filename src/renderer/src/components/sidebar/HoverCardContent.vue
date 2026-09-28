<script setup>
// Orca's HoverCardContent (components/ui/hover-card.tsx; MIT, Copyright (c)
// 2026 Lovecast Inc.) in Vue: portaled to the body, beside its trigger
// (side "right", align "start", 8 px away like the sidebar's details card),
// flipped to the other side and kept inside the window when it would not
// fit (Radix's collision handling). The translucent surface, 14 % border,
// shadow and blur follow the dropdown-menu recipe Orca gives it.
import { ref, watch, nextTick, onBeforeUnmount } from 'vue'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  // What useHoverCard() returned.
  hc: { type: Object, required: true },
  side: { type: String, default: 'right' },
  align: { type: String, default: 'start' },
  sideOffset: { type: Number, default: 8 },
  // Orca's details card is w-80.
  width: { type: Number, default: 320 }
})

const PAD = 8
const el = ref(null)
const pos = ref({ left: -9999, top: -9999 })
const placedSide = ref(props.side)
let raf = 0
let observer = null

function place() {
  const card = el.value
  const anchor = props.hc.anchor.value
  if (!card || !anchor) return
  const r = anchor.getBoundingClientRect()
  const w = card.offsetWidth || props.width
  const h = card.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight
  let side = props.side
  let left
  let top
  if (side === 'right' || side === 'left') {
    const right = r.right + props.sideOffset
    const leftSide = r.left - props.sideOffset - w
    if (side === 'right' && right + w > vw - PAD && leftSide >= PAD) side = 'left'
    else if (side === 'left' && leftSide < PAD && right + w <= vw - PAD) side = 'right'
    left = side === 'right' ? right : leftSide
    top = props.align === 'end' ? r.bottom - h : props.align === 'center' ? r.top + r.height / 2 - h / 2 : r.top
  } else {
    const below = r.bottom + props.sideOffset
    const above = r.top - props.sideOffset - h
    if (side === 'bottom' && below + h > vh - PAD && above >= PAD) side = 'top'
    else if (side === 'top' && above < PAD && below + h <= vh - PAD) side = 'bottom'
    top = side === 'bottom' ? below : above
    left = props.align === 'end' ? r.right - w : props.align === 'center' ? r.left + r.width / 2 - w / 2 : r.left
  }
  left = Math.min(Math.max(PAD, left), Math.max(PAD, vw - w - PAD))
  top = Math.min(Math.max(PAD, top), Math.max(PAD, vh - h - PAD))
  placedSide.value = side
  pos.value = { left: Math.round(left), top: Math.round(top) }
}

function schedule() {
  cancelAnimationFrame(raf)
  nextTick(() => {
    place()
    raf = requestAnimationFrame(place)
  })
}

function setEl(node) {
  el.value = node
  props.hc.contentEl.value = node
  if (observer) observer.disconnect()
  observer = null
  if (node && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => place())
    observer.observe(node)
  }
}

watch(() => [props.hc.open.value, props.hc.anchor.value], ([open]) => open && schedule(), { immediate: true })
// A resized window moves the card along (Radix keeps it attached).
function onResize() {
  if (props.hc.open.value) place()
}
window.addEventListener('resize', onResize)
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  cancelAnimationFrame(raf)
  if (observer) observer.disconnect()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="hc.open.value"
      :ref="setEl"
      v-bind="$attrs"
      class="hover-card"
      data-slot="hover-card-content"
      data-state="open"
      :data-side="placedSide"
      :data-align="align"
      :style="{ left: pos.left + 'px', top: pos.top + 'px', width: width + 'px' }"
      @pointerenter="hc.contentListeners.pointerenter"
      @pointerleave="hc.contentListeners.pointerleave"
      @focusout="hc.contentListeners.focusout"
      @click.stop
      @dblclick.stop
      @contextmenu.stop
    >
      <slot />
    </div>
  </Teleport>
</template>
