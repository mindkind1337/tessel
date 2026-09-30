<script setup>
import { ref, onMounted, onUpdated, onBeforeUnmount, nextTick } from 'vue'
defineProps({ title: { type: String, default: '' } })
const emit = defineEmits(['close'])
const element = ref(null)
const previousFocus = document.activeElement
function setRoles() { element.value?.querySelectorAll('.ctx-menu-item').forEach(item => item.setAttribute('role', 'menuitem')) }
function clamp() {
  if (!element.value) return
  const r = element.value.getBoundingClientRect()
  if (r.right > innerWidth) element.value.style.left = Math.max(4, innerWidth - r.width - 4) + 'px'
  if (r.bottom > innerHeight) element.value.style.top = Math.max(4, innerHeight - r.height - 4) + 'px'
}
function keyboard(event) {
  const items = [...element.value.querySelectorAll('.ctx-menu-item:not(:disabled)')]
  const index = items.indexOf(document.activeElement)
  let target
  if (event.key === 'ArrowDown') target = items[(index + 1) % items.length]
  else if (event.key === 'ArrowUp') target = items[(index < 0 ? items.length : index) - 1] || items.at(-1)
  else if (event.key === 'Home') target = items[0]
  else if (event.key === 'End') target = items.at(-1)
  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close'); previousFocus?.focus({ preventScroll: true }); return }
  else if (event.key === 'Tab') { emit('close'); previousFocus?.focus({ preventScroll: true }); return }
  if (target) { event.preventDefault(); target.focus() }
}
function outside(event) { if (!element.value?.contains(event.target)) emit('close') }
onMounted(async () => {
  await nextTick()
  if (!element.value) return
  setRoles()
  element.value.focus({ preventScroll: true })
  clamp()
  document.addEventListener('mousedown', outside)
})
onBeforeUnmount(() => document.removeEventListener('mousedown', outside))
onUpdated(() => { setRoles(); clamp() })
defineExpose({
  focus: options => element.value?.focus(options),
  contains: target => element.value?.contains(target),
  getBoundingClientRect: () => element.value.getBoundingClientRect()
})
</script>

<template>
  <div ref="element" class="ctx-menu" role="menu" :aria-label="title || undefined" tabindex="-1" @mousedown.stop @keydown="keyboard">
    <slot />
  </div>
</template>

<style scoped>
.ctx-menu { width: max-content; max-width: calc(100vw - 8px); }
</style>
