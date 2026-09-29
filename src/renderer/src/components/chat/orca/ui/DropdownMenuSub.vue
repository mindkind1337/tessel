<script setup>
// After Orca's components/ui/dropdown-menu.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DropdownMenuSub (renders no element): a nested menu inside a
 * DropdownMenuContent. Parts: DropdownMenuSubTrigger, DropdownMenuSubContent.
 * Opens on hover (100ms), click, ArrowRight / Enter / Space; closes on
 * ArrowLeft, when another item of the parent menu is hovered (after a 300ms
 * grace while the pointer travels to it), and with the whole menu.
 * Props: open (v-model:open; leave unset for uncontrolled), defaultOpen.
 * Emits: update:open (Boolean).
 */
import { inject, onBeforeUnmount, provide, shallowRef, useId } from 'vue'
import { MENU_CONTENT, MENU_SUB, required } from './contexts.js'
import { useControllableOpen } from './primitive.js'

const props = defineProps({
  open: { type: Boolean, default: undefined },
  defaultOpen: { type: Boolean, default: false }
})
const emit = defineEmits(['update:open'])

const parent = required(inject(MENU_CONTENT, null), 'DropdownMenuSub', 'DropdownMenuContent')
const open = useControllableOpen(props, emit)
const triggerEl = shallowRef(null)
let openTimer = null
let graceTimer = null

function clearTimers() {
  clearTimeout(openTimer)
  clearTimeout(graceTimer)
  openTimer = null
  graceTimer = null
}

const sub = {
  open: open.value,
  setOpen(next) {
    clearTimers()
    open.set(next)
  },
  isOpen: () => open.value.value,
  close: () => sub.setOpen(false),
  triggerEl,
  triggerId: useId(),
  contentId: useId(),
  parent,
  openSoon() {
    if (open.value.value || openTimer) return
    openTimer = setTimeout(() => sub.setOpen(true), 100)
  },
  cancelOpen() {
    clearTimeout(openTimer)
    openTimer = null
  },
  // The pointer left the trigger: it may be on its way to the sub content.
  startGrace() {
    clearTimeout(graceTimer)
    graceTimer = setTimeout(() => {
      graceTimer = null
      if (triggerEl.value && triggerEl.value.matches(':hover')) return
      sub.close()
    }, 300)
  },
  cancelGrace() {
    clearTimeout(graceTimer)
    graceTimer = null
  },
  inGrace: () => graceTimer !== null
}

const unregister = parent.registerSub(sub)
onBeforeUnmount(() => {
  clearTimers()
  unregister()
})

provide(MENU_SUB, sub)
</script>

<template>
  <slot :open="open.value.value" />
</template>
