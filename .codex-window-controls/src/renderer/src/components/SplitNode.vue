<script>
export default { name: 'SplitNode' }
</script>

<script setup>
import { ref } from 'vue'
import TerminalPane from './TerminalPane.vue'

const props = defineProps({
  node: { type: Object, required: true }
})

const containerEl = ref(null)
const dragIndex = ref(-1)
const MIN_PANE_WIDTH = 325
const MIN_PANE_HEIGHT = 156
let layoutFrame = 0

function notifyLayoutChange() {
  if (layoutFrame) cancelAnimationFrame(layoutFrame)
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0
    window.dispatchEvent(new Event('terminal-layout-change'))
  })
}

// Drag the divider that sits between child `i` and child `i+1`. We move the
// boundary by adjusting only that adjacent pair, keeping their combined size
// constant — so other panes in the row/column stay put.
function startDrag(e, i) {
  e.preventDefault()
  const el = containerEl.value
  if (!el) return
  const isRow = props.node.dir === 'row'
  const total = isRow ? el.getBoundingClientRect().width : el.getBoundingClientRect().height
  const start = isRow ? e.clientX : e.clientY
  const sizes = props.node.sizes
  const a0 = sizes[i]
  const b0 = sizes[i + 1]
  const pairSum = a0 + b0
  dragIndex.value = i

  const move = (ev) => {
    const pos = isRow ? ev.clientX : ev.clientY
    const deltaPct = ((pos - start) / total) * 100
    let a = a0 + deltaPct
    const minPixels = isRow ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT
    const min = Math.min(pairSum / 2, (minPixels / total) * 100)
    a = Math.max(min, Math.min(pairSum - min, a))
    const next = sizes.slice()
    next[i] = a
    next[i + 1] = pairSum - a
    props.node.sizes = next
    notifyLayoutChange()
  }
  const up = () => {
    dragIndex.value = -1
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (layoutFrame) {
      cancelAnimationFrame(layoutFrame)
      layoutFrame = 0
    }
    window.dispatchEvent(new Event('terminal-layout-change'))
    notifyLayoutChange()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
</script>

<template>
  <!-- Leaf: a real terminal -->
  <TerminalPane v-if="node.type === 'leaf'" :node="node" />

  <!-- Split: N children separated by draggable dividers -->
  <div v-else ref="containerEl" class="split" :class="node.dir">
    <template v-for="(child, i) in node.children" :key="child.id">
      <div class="node" :style="{ flexGrow: node.sizes[i], flexBasis: 0, flexShrink: 1 }">
        <SplitNode :node="child" />
      </div>
      <div
        v-if="i < node.children.length - 1"
        class="divider"
        :class="[node.dir, { dragging: dragIndex === i }]"
        @pointerdown="startDrag($event, i)"
      ></div>
    </template>
  </div>
</template>
