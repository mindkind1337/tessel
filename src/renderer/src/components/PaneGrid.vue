<script>
export default { name: 'PaneGrid' }
</script>

<script setup>
// A view's grid of terminals and agents (the Terminal tab). Every pane is
// drawn in one flat list, keyed by its id and placed where its split puts it
// (paneGrid.js gridLayout), with the dividers on top: a pane split, closed,
// moved or tiled again (auto-tile) never mounts again, so its terminal is not
// rebuilt and its screen not replayed. A nested split of the tree mounted
// its panes again each time one moved to another split.
import { ref, computed, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { trackPointerDrag } from '../browser/webviewPassthrough'
import { writeViewSizes } from '../paneViews'
import { gridLayout, cssLength, pxLength, shareOf } from '../paneGrid'
import SplitNode from './SplitNode.vue'

const props = defineProps({
  node: { type: Object, required: true }
})

const rootEl = ref(null)
const dragKey = ref('')
const MIN_PANE_WIDTH = 325
const MIN_PANE_HEIGHT = 156
let layoutFrame = 0

const styleOf = (r) => ({ left: cssLength(r.x), top: cssLength(r.y), width: cssLength(r.w), height: cssLength(r.h) })

// The panes in the order they first came: one that comes or goes never moves
// the others in the page (a moved element would lose its focus).
let order = []
const layout = computed(() => gridLayout(props.node))
const tiles = computed(() => {
  const byId = new Map(layout.value.tiles.map((tile) => [tile.leaf.id, tile]))
  order = order.filter((id) => byId.has(id))
  for (const id of byId.keys()) if (!order.includes(id)) order.push(id)
  return order.map((id) => {
    const tile = byId.get(id)
    return { id, leaf: tile.leaf, style: styleOf(tile.rect) }
  })
})
const dividers = computed(() => layout.value.dividers.map((d) => ({ ...d, style: styleOf(d.rect) })))

function notifyLayoutChange() {
  if (layoutFrame) cancelAnimationFrame(layoutFrame)
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0
    window.dispatchEvent(new Event('terminal-layout-change'))
  })
}
onBeforeUnmount(() => layoutFrame && cancelAnimationFrame(layoutFrame))

// The user resized the panes on both sides of divider `i` of `split` (an
// agent's terminal then stays open, and the layout is theirs: App.vue).
function userResized(split, i) {
  const ids = []
  const walk = (n) => (n.type === 'leaf' ? ids.push(n.id) : (n.children || []).forEach(walk))
  for (const c of split.children.slice(i, i + 2)) walk(c)
  window.dispatchEvent(new CustomEvent('tessel-panes-resized', { detail: { ids } }))
}

const sharesOf = (split) => split.children.map((_, i) => shareOf(split, i))

// Keyboard: the arrow keys move a divider by 2% (each pane keeps at least
// 5% of the split).
function onDividerKey(e, d) {
  const isRow = d.dir === 'row'
  const back = isRow ? 'ArrowLeft' : 'ArrowUp'
  const fwd = isRow ? 'ArrowRight' : 'ArrowDown'
  if (e.key !== back && e.key !== fwd) return
  e.preventDefault()
  e.stopPropagation()
  const sizes = sharesOf(d.split)
  const step = e.key === fwd ? 2 : -2
  const a = sizes[d.index] + step
  const b = sizes[d.index + 1] - step
  if (a < 5 || b < 5) return
  sizes[d.index] = a
  sizes[d.index + 1] = b
  d.split.sizes = sizes
  userResized(d.split, d.index)
  // A worktree's view of a split: the split itself takes the move.
  writeViewSizes(d.split)
  notifyLayoutChange()
}

// Drag the divider between child i and i+1 of its split: only that pair
// changes (their sum stays), so the other panes of the split stay put.
function startDrag(e, d) {
  if (e.button !== undefined && e.button !== 0) return
  e.preventDefault()
  const room = rootEl.value && rootEl.value.getBoundingClientRect()
  if (!room) return
  const isRow = d.dir === 'row'
  const line = e.currentTarget.getBoundingClientRect()
  const thick = (isRow ? line.width : line.height) || 0
  const n = d.split.children.length
  // The split's own length on screen, less its dividers: what its sizes share.
  const total = pxLength(isRow ? d.splitRect.w : d.splitRect.h, isRow ? room.width : room.height, thick) - (n - 1) * thick
  if (!(total > 0)) return
  const start = isRow ? e.clientX : e.clientY
  const sizes = sharesOf(d.split)
  const sum = sizes.reduce((s, v) => s + v, 0)
  const i = d.index
  const a0 = sizes[i]
  const pairSum = a0 + sizes[i + 1]
  const min = Math.min(pairSum / 2, ((isRow ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT) / total) * sum)
  let moved = false
  dragKey.value = d.key

  const move = (ev) => {
    const pos = isRow ? ev.clientX : ev.clientY
    const a = Math.max(min, Math.min(pairSum - min, a0 + ((pos - start) / total) * sum))
    if (!moved) {
      if (Math.abs(pos - start) < 1) return
      moved = true
      userResized(d.split, i)
    }
    const next = sizes.slice()
    next[i] = a
    next[i + 1] = pairSum - a
    d.split.sizes = next
    writeViewSizes(d.split)
    notifyLayoutChange()
  }
  const up = () => {
    dragKey.value = ''
    if (layoutFrame) {
      cancelAnimationFrame(layoutFrame)
      layoutFrame = 0
    }
    window.dispatchEvent(new Event('terminal-layout-change'))
  }
  // Browser pages let the pointer through while it runs, and it ends even
  // when the button is let go over a page or outside the window
  // (browser/webviewPassthrough.js).
  trackPointerDrag(e, { onMove: move, onEnd: up })
}
</script>

<template>
  <div ref="rootEl" class="pane-grid">
    <div v-for="tile in tiles" :key="tile.id" class="pane-tile" :style="tile.style">
      <SplitNode :node="tile.leaf" />
    </div>
    <div
      v-for="d in dividers"
      :key="d.key"
      class="divider"
      :class="[d.dir, { dragging: dragKey === d.key }]"
      :style="d.style"
      role="separator"
      tabindex="0"
      :aria-orientation="d.dir === 'row' ? 'vertical' : 'horizontal'"
      :aria-label="t('app.split.resize', 'Resize panes (arrow keys)')"
      @pointerdown="startDrag($event, d)"
      @keydown="onDividerKey($event, d)"
    ></div>
  </div>
</template>
