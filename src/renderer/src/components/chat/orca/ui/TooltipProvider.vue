<script setup>
// After Orca's components/ui/tooltip.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * TooltipProvider (renders no element): shared timing for the Tooltips
 * inside it. Optional: a Tooltip without a provider waits 400ms, the
 * reference app's own provider value.
 * Props: delayDuration (ms before a hovered trigger opens, default 0 like the
 *   reference wrapper), skipDelayDuration (ms after a tooltip closes during
 *   which the next one opens at once, default 300), disableHoverableContent
 *   (default true: tooltips are labels, the pointer never keeps them open).
 * <TooltipProvider :delay-duration="400"><App /></TooltipProvider>
 */
import { computed, onBeforeUnmount, provide, ref } from 'vue'
import { TOOLTIP_PROVIDER } from './contexts.js'

const props = defineProps({
  delayDuration: { type: Number, default: 0 },
  skipDelayDuration: { type: Number, default: 300 },
  disableHoverableContent: { type: Boolean, default: true }
})

const isOpenDelayed = ref(true)
let skipTimer = null

provide(TOOLTIP_PROVIDER, {
  delayDuration: computed(() => props.delayDuration),
  disableHoverableContent: computed(() => props.disableHoverableContent),
  isOpenDelayed,
  onOpen() {
    clearTimeout(skipTimer)
    isOpenDelayed.value = false
  },
  onClose() {
    clearTimeout(skipTimer)
    skipTimer = setTimeout(() => (isOpenDelayed.value = true), props.skipDelayDuration)
  }
})

onBeforeUnmount(() => clearTimeout(skipTimer))
</script>

<template>
  <slot />
</template>
