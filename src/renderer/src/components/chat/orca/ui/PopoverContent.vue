<script setup>
// After Orca's components/ui/popover.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * PopoverContent: role="dialog", teleported to <body> (or portalContainer)
 * with classes "nc-root nc-ui-popover-content", placed next to the trigger
 * (or PopoverAnchor), flipped / shifted to stay in the viewport, and
 * repositioned on scroll / resize while open.
 * Props: side 'top' | 'right' | 'bottom' | 'left' (default 'bottom'),
 *   align 'start' | 'center' | 'end' (default 'center'), sideOffset (4),
 *   alignOffset (0), avoidCollisions (true), collisionPadding (0),
 *   portalContainer (HTMLElement | selector, default body).
 * Emits (each gets a cancelable event: call event.preventDefault() to keep
 *   the default from happening):
 *   openAutoFocus (default: focus the first tabbable inside, else the content),
 *   closeAutoFocus (default: focus the trigger, unless closed by an outside
 *     pointer down), escapeKeyDown (the KeyboardEvent; default: close),
 *   pointerDownOutside / focusOutside / interactOutside (default: close).
 * Closes on Escape, pointer down outside (the trigger excluded), focus outside.
 * Attributes (aria-label, @pointerenter, @wheel…) and class go to the content
 * element; a consumer's scoped class applies (its scope attribute is copied).
 * Wheel shim: with class "popover-scroll-content" (also 15rem max height and
 * its own scroll) or "popover-wheel-scroll" (shim only), a wheel over the
 * content scrolls the nearest vertical scroller between the target and the
 * content, unless a listener already called event.preventDefault().
 * Exposed: el (the content element or null), updatePosition().
 */
import { computed, inject, onBeforeUnmount, shallowRef, watch } from 'vue'
import { POPOVER, required } from './contexts.js'
import { cancelableEvent, useParentScopeAttrs } from './primitive.js'
import { focusElement, focusFirst, trapTab, useDismissableLayer, useFloatingPosition } from './floating.js'
import { handlePopoverWheel } from './popover-wheel.js'
import './ui.css'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  side: { type: String, default: 'bottom' },
  align: { type: String, default: 'center' },
  sideOffset: { type: Number, default: 4 },
  alignOffset: { type: Number, default: 0 },
  avoidCollisions: { type: Boolean, default: true },
  collisionPadding: { type: Number, default: 0 },
  portalContainer: { type: [Object, String], default: null }
})
const emit = defineEmits([
  'openAutoFocus',
  'closeAutoFocus',
  'escapeKeyDown',
  'pointerDownOutside',
  'focusOutside',
  'interactOutside'
])

const ctx = required(inject(POPOVER, null), 'PopoverContent', 'Popover')
const scopeAttrs = useParentScopeAttrs()
const contentEl = shallowRef(null)
const isOpen = computed(() => ctx.open.value)
let interactedOutside = false

const position = useFloatingPosition(
  () => ctx.anchorEl.value || ctx.triggerEl.value,
  contentEl,
  () => isOpen.value,
  () => ({
    side: props.side,
    align: props.align,
    sideOffset: props.sideOffset,
    alignOffset: props.alignOffset,
    avoidCollisions: props.avoidCollisions,
    collisionPadding: props.collisionPadding
  })
)

useDismissableLayer(() => isOpen.value && !!contentEl.value, {
  elements: () => [contentEl.value],
  modal: () => ctx.modal.value,
  // A pointer down on the trigger is the trigger's own toggle.
  excludes: (target, kind) => kind === 'pointer' && !!ctx.triggerEl.value && ctx.triggerEl.value.contains(target),
  onEscapeKeyDown: (event) => emit('escapeKeyDown', event),
  onPointerDownOutside: (event) => {
    emit('pointerDownOutside', event)
    emit('interactOutside', event)
    if (!event.defaultPrevented) interactedOutside = true
  },
  onFocusOutside: (event) => {
    // A modal popover keeps focus inside instead.
    if (ctx.modal.value) {
      event.preventDefault()
      focusElement(contentEl.value)
      return
    }
    emit('focusOutside', event)
    emit('interactOutside', event)
    if (!event.defaultPrevented) interactedOutside = true
  },
  onDismiss: () => ctx.setOpen(false)
})

// Focus on open / close (Radix FocusScope + Popover's onCloseAutoFocus).
watch(contentEl, (el, previous) => {
  if (el && !previous) {
    interactedOutside = false
    const event = cancelableEvent('nc.openAutoFocus')
    emit('openAutoFocus', event)
    if (!event.defaultPrevented && !el.contains(document.activeElement)) focusFirst(el)
  }
}, { flush: 'post' })
watch(isOpen, (open, was) => {
  if (!open && was) {
    const event = cancelableEvent('nc.closeAutoFocus')
    emit('closeAutoFocus', event)
    if (!event.defaultPrevented && !interactedOutside) focusElement(ctx.triggerEl.value)
    interactedOutside = false
  }
})

// The wheel shim listens where the content is teleported, like the
// reference's portal container listener, so it runs after listeners on
// the content and its children. A function ref attaches it as the element
// mounts (a watcher would only run after the render).
let wheelTarget = null
function onWheel(event) {
  if (contentEl.value) handlePopoverWheel(event, contentEl.value)
}
function detachWheel() {
  if (wheelTarget) wheelTarget.removeEventListener('wheel', onWheel)
  wheelTarget = null
}
function setContentEl(el) {
  if (el === contentEl.value) return
  detachWheel()
  contentEl.value = el
  if (!el) return
  const container = props.portalContainer
  wheelTarget =
    (typeof container === 'string' ? document.querySelector(container) : container) || el.ownerDocument.body
  wheelTarget.addEventListener('wheel', onWheel, { passive: false })
}
onBeforeUnmount(detachWheel)

function onKeydown(event) {
  if (ctx.modal.value) trapTab(event, contentEl.value)
}

const style = computed(() => ({
  position: 'fixed',
  left: `${position.x}px`,
  top: `${position.y}px`,
  '--nc-available-width': `${position.availableWidth}px`,
  '--nc-available-height': `${position.availableHeight}px`,
  '--nc-transform-origin': position.transformOrigin
}))

defineExpose({ el: contentEl, updatePosition: () => position.update() })
</script>

<template>
  <Teleport :to="portalContainer || 'body'">
    <Transition name="nc-ui">
      <div
        v-if="isOpen"
        v-bind="{ ...scopeAttrs, ...$attrs }"
        :id="ctx.contentId"
        :ref="setContentEl"
        role="dialog"
        tabindex="-1"
        data-slot="popover-content"
        :data-state="isOpen ? 'open' : 'closed'"
        :data-side="position.side"
        :data-align="position.align"
        class="nc-root nc-ui-popover-content nc-ui-animate-in nc-ui-slide"
        :style="style"
        @keydown="onKeydown"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style>
.nc-ui-popover-content {
  box-sizing: border-box;
  z-index: 460;
  overflow: hidden;
  border-radius: 6px;
  border: 1px solid rgb(255 255 255 / 0.14);
  /* Tessel's themes are dark: the reference's dark: surface. */
  background: rgb(0 0 0 / 0.72);
  color: var(--nc-popover-foreground);
  box-shadow: 0 20px 44px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(40px);
  outline: none;
  /* Clickable above a modal layer (the body then has pointer-events: none). */
  pointer-events: auto;
  transform-origin: var(--nc-transform-origin);
  --nc-ui-enter-opacity: 0;
  --nc-ui-enter-scale: 0.95;
  --nc-ui-exit-opacity: 0;
  --nc-ui-exit-scale: 0.95;
  /* Electron's title-bar drag region would swallow clicks otherwise. */
  -webkit-app-region: no-drag;
}
.nc-ui-popover-content.popover-scroll-content {
  color-scheme: dark;
  max-height: min(15rem, var(--nc-available-height, 15rem));
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}
</style>
