<script>
export default { name: 'SplitNode' }
</script>

<script setup>
import { ref } from 'vue'
import { t } from '../i18n'
import TerminalPane from './TerminalPane.vue'
import EditorPane from './EditorPane.vue'
import BrowserPane from './BrowserPane.vue'
import ChatPane from './chat/ChatPane.vue'

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
// Keyboard: the arrow keys move a divider by 2% (each pane keeps at least
// 5% of the split).
function onDividerKey(e, i) {
  const isRow = props.node.dir === 'row'
  const back = isRow ? 'ArrowLeft' : 'ArrowUp'
  const fwd = isRow ? 'ArrowRight' : 'ArrowDown'
  if (e.key !== back && e.key !== fwd) return
  e.preventDefault()
  e.stopPropagation()
  const sizes = props.node.sizes
  const step = e.key === fwd ? 2 : -2
  const a = sizes[i] + step
  const b = sizes[i + 1] - step
  if (a < 5 || b < 5) return
  sizes[i] = a
  sizes[i + 1] = b
  notifyLayoutChange()
}

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
  <!-- Leaf: a code editor or a browser page (no terminal), or a real terminal -->
  <EditorPane v-if="node.type === 'leaf' && node.kind === 'editor'" :key="node.id" :node="node" />
  <BrowserPane v-else-if="node.type === 'leaf' && node.kind === 'browser'" :key="node.id" :node="node" />
  <ChatPane v-else-if="node.type === 'leaf' && node.kind === 'chat'" :key="node.id" :node="node" />
  <TerminalPane v-else-if="node.type === 'leaf'" :key="node.id + ':' + (node.gen || 0)" :node="node" />

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
        role="separator"
        tabindex="0"
        :aria-orientation="node.dir === 'row' ? 'vertical' : 'horizontal'"
        :aria-label="t('app.split.resize', 'Resize panes (arrow keys)')"
        @pointerdown="startDrag($event, i)"
        @keydown="onDividerKey($event, i)"
      ></div>
    </template>
  </div>
</template>
