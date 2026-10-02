<script setup>
// A web page in a tab of the side panel (its + button): the browser pane
// itself (BrowserPane.vue, the same <webview> and guards), without its pane
// header. Its pane context is App's, except what belongs to the pane grid:
// it is "active" while its tab is shown and clicked, it closes as a tab, and
// a link opened in a new pane opens in a new side tab instead.
import { ref, provide, inject, watch, onMounted, nextTick } from 'vue'
import BrowserPane from './BrowserPane.vue'

const props = defineProps({
  // { id, url, title }: kept by App (saved with the layout).
  node: { type: Object, required: true },
  // Its tab is the one shown.
  active: { type: Boolean, default: false }
})
const emit = defineEmits(['close', 'open-tab'])

const parent = inject('panelCtx', null) || {}
const activeId = ref(props.active ? props.node.id : null)
watch(
  () => props.active,
  (a) => {
    activeId.value = a ? props.node.id : null
  }
)
// A pane of the grid taking the keyboard back: this page is not the active one.
if (parent.activeId) {
  watch(parent.activeId, () => {
    activeId.value = null
  })
}

provide('panelCtx', {
  activeId,
  maximizedId: ref(null),
  highlightId: ref(null),
  setActive: (id) => {
    activeId.value = id
  },
  toggleMaximize: () => {},
  beginPaneDrag: () => {},
  closeLeaf: () => emit('close'),
  openBrowserPane: (url) => emit('open-tab', url),
  toast: parent.toast,
  openExternal: parent.openExternal,
  browserPorts: parent.browserPorts
})

const pane = ref(null)
// A new page: the address bar takes the keyboard.
onMounted(() => {
  if (props.active && !props.node.url) nextTick(() => pane.value && pane.value.focusAddress())
})
</script>

<template>
  <BrowserPane ref="pane" :node="node" in-side-panel />
</template>
