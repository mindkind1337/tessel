<script setup>
// After Orca's components/ui/tooltip.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * TooltipContent: role="tooltip" (its id is the trigger's aria-describedby),
 * teleported to <body> with classes "nc-root nc-ui-tooltip-content",
 * pointer-events none, above menus and popovers (z-index 90).
 * Props: side (default 'top'), align ('center'), sideOffset (0; the arrow
 *   adds its 10px like Radix), alignOffset (0), avoidCollisions (true),
 *   collisionPadding (0), showArrow (true).
 * Emits: escapeKeyDown (KeyboardEvent), pointerDownOutside (cancelable
 *   event): call event.preventDefault() to keep it open.
 */
import { computed, inject, onBeforeUnmount, shallowRef, watch } from 'vue'
import { TOOLTIP, required } from './contexts.js'
import { useParentScopeAttrs } from './primitive.js'
import { useDismissableLayer, useFloatingPosition } from './floating.js'
import './ui.css'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  side: { type: String, default: 'top' },
  align: { type: String, default: 'center' },
  sideOffset: { type: Number, default: 0 },
  alignOffset: { type: Number, default: 0 },
  avoidCollisions: { type: Boolean, default: true },
  collisionPadding: { type: Number, default: 0 },
  showArrow: { type: Boolean, default: true }
})
const emit = defineEmits(['escapeKeyDown', 'pointerDownOutside'])

const ARROW = 10
const ctx = required(inject(TOOLTIP, null), 'TooltipContent', 'Tooltip')
const scopeAttrs = useParentScopeAttrs()
const contentEl = shallowRef(null)
const isOpen = computed(() => ctx.open.value)

const position = useFloatingPosition(
  () => ctx.triggerEl.value,
  contentEl,
  () => isOpen.value,
  () => ({
    side: props.side,
    align: props.align,
    sideOffset: props.sideOffset + (props.showArrow ? ARROW : 0),
    alignOffset: props.alignOffset,
    avoidCollisions: props.avoidCollisions,
    collisionPadding: props.collisionPadding
  })
)

useDismissableLayer(() => isOpen.value && !!contentEl.value, {
  elements: () => [contentEl.value],
  onEscapeKeyDown: (event) => emit('escapeKeyDown', event),
  onPointerDownOutside: (event) => emit('pointerDownOutside', event),
  // A label never closes because focus moved.
  onFocusOutside: (event) => event.preventDefault(),
  onDismiss: () => ctx.onClose()
})

// Radix closes a tooltip when a scroll moves its trigger.
function onScroll(event) {
  const trigger = ctx.triggerEl.value
  if (trigger && event.target && event.target.contains && event.target.contains(trigger)) ctx.onClose()
}
watch(isOpen, (open) => {
  if (open) window.addEventListener('scroll', onScroll, { capture: true })
  else window.removeEventListener('scroll', onScroll, { capture: true })
}, { immediate: true })
onBeforeUnmount(() => window.removeEventListener('scroll', onScroll, { capture: true }))

const style = computed(() => ({
  position: 'fixed',
  left: `${position.x}px`,
  top: `${position.y}px`,
  '--nc-transform-origin': position.transformOrigin
}))

// The rotated square's centre sits 2px inside the edge facing the trigger.
const arrowStyle = computed(() => {
  const el = contentEl.value
  const vertical = position.side === 'top' || position.side === 'bottom'
  const length = el ? (vertical ? el.offsetWidth : el.offsetHeight) : 0
  const along = Math.max(0, Math.min(position.arrowOffset - ARROW / 2, Math.max(0, length - ARROW)))
  const inset = 'calc(100% - 7px)'
  if (position.side === 'top') return { top: inset, left: `${along}px` }
  if (position.side === 'bottom') return { bottom: inset, left: `${along}px` }
  if (position.side === 'left') return { left: inset, top: `${along}px` }
  return { right: inset, top: `${along}px` }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="nc-ui">
      <div
        v-if="isOpen"
        v-bind="{ ...scopeAttrs, ...$attrs }"
        :id="ctx.contentId"
        ref="contentEl"
        role="tooltip"
        data-slot="tooltip-content"
        :data-state="ctx.state.value"
        :data-side="position.side"
        :data-align="position.align"
        class="nc-root nc-ui-tooltip-content nc-ui-animate-in nc-ui-slide"
        :style="style"
      >
        <slot />
        <span v-if="showArrow" aria-hidden="true" class="nc-ui-tooltip-arrow" :style="arrowStyle" />
      </div>
    </Transition>
  </Teleport>
</template>

<style>
.nc-ui-tooltip-content {
  box-sizing: border-box;
  pointer-events: none;
  z-index: 90;
  width: fit-content;
  transform-origin: var(--nc-transform-origin);
  border-radius: 6px;
  background: var(--nc-foreground);
  padding: 6px 12px;
  font-size: 12px;
  line-height: 16px;
  text-wrap: balance;
  color: var(--nc-background);
  --nc-ui-enter-opacity: 0;
  --nc-ui-enter-scale: 0.95;
  --nc-ui-exit-opacity: 0;
  --nc-ui-exit-scale: 0.95;
}
.nc-ui-tooltip-arrow {
  position: absolute;
  width: 10px;
  height: 10px;
  transform: rotate(45deg);
  border-radius: 2px;
  background: var(--nc-foreground);
}
</style>
