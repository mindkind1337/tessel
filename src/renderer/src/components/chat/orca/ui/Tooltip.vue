<script setup>
// After Orca's components/ui/tooltip.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Tooltip (Radix Tooltip.Root; renders no element). Parts: TooltipTrigger,
 * TooltipContent. Opens on hover (after delayDuration) and on keyboard focus;
 * closes on pointer leave, blur, click / pointer down on the trigger, Escape,
 * and when a scroll moves the trigger. One tooltip open at a time.
 * Props: open (v-model:open; leave unset for uncontrolled), defaultOpen,
 *   delayDuration (overrides the provider's), disableHoverableContent.
 * Emits: update:open (Boolean).
 * <Tooltip>
 *   <TooltipTrigger as-child><Button variant="ghost" size="icon-sm" :aria-label="label"><Plus /></Button></TooltipTrigger>
 *   <TooltipContent side="top" :side-offset="4">{{ label }}</TooltipContent>
 * </Tooltip>
 */
import { computed, inject, onBeforeUnmount, provide, ref, shallowRef, useId, watch } from 'vue'
import { TOOLTIP, TOOLTIP_PROVIDER } from './contexts.js'
import { useControllableOpen } from './primitive.js'
import { closeOtherTooltips, registerOpenTooltip, unregisterOpenTooltip } from './tooltip-registry.js'

const props = defineProps({
  open: { type: Boolean, default: undefined },
  defaultOpen: { type: Boolean, default: false },
  delayDuration: { type: Number, default: undefined },
  disableHoverableContent: { type: Boolean, default: undefined }
})
const emit = defineEmits(['update:open'])

// Without a provider: the reference app's <TooltipProvider delayDuration={400}>.
const provider = inject(TOOLTIP_PROVIDER, null) || {
  delayDuration: computed(() => 400),
  disableHoverableContent: computed(() => true),
  isOpenDelayed: ref(true),
  onOpen() {},
  onClose() {}
}

const open = useControllableOpen(props, emit)
const wasOpenDelayed = ref(false)
const triggerEl = shallowRef(null)
const delay = computed(() => props.delayDuration ?? provider.delayDuration.value)
let openTimer = null

function setOpen(next) {
  clearTimeout(openTimer)
  if (next === open.value.value) return
  if (next) {
    provider.onOpen()
    closeOtherTooltips(close)
  } else {
    provider.onClose()
  }
  open.set(next)
}
function close() {
  wasOpenDelayed.value = false
  setOpen(false)
}
watch(open.value, (isOpen) => {
  if (isOpen) registerOpenTooltip(close)
  else unregisterOpenTooltip(close)
}, { immediate: true })

provide(TOOLTIP, {
  open: open.value,
  contentId: useId(),
  triggerEl,
  state: computed(() => (open.value.value ? (wasOpenDelayed.value ? 'delayed-open' : 'instant-open') : 'closed')),
  onTriggerEnter() {
    if (provider.isOpenDelayed.value) {
      clearTimeout(openTimer)
      openTimer = setTimeout(() => {
        wasOpenDelayed.value = true
        setOpen(true)
      }, delay.value)
    } else {
      wasOpenDelayed.value = false
      setOpen(true)
    }
  },
  onTriggerLeave() {
    clearTimeout(openTimer)
    // disableHoverableContent (the default): the pointer never keeps a label open.
    close()
  },
  onOpen() {
    wasOpenDelayed.value = false
    setOpen(true)
  },
  onClose: close
})

onBeforeUnmount(() => {
  clearTimeout(openTimer)
  unregisterOpenTooltip(close)
})
</script>

<template>
  <slot />
</template>
