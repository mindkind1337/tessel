<script setup>
// After Orca's components/ui/dropdown-menu.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DropdownMenuContent: role="menu", teleported to <body> with classes
 * "nc-root nc-ui-menu-content", placed against the trigger (flip / shift in
 * the viewport, max-height = the room left), repositioned while open.
 * Keyboard: ArrowUp / ArrowDown move between enabled items (no wrap),
 * Home / End, typeahead on item text (or an item's text-value), Tab stays,
 * Escape closes and focus returns to the trigger.
 * Props: side (default 'bottom'), align ('center'), sideOffset (4),
 *   alignOffset (0), avoidCollisions (true), collisionPadding (0).
 * Emits (cancelable, event.preventDefault() keeps the default):
 *   openAutoFocus (default: first item when opened from the keyboard, else
 *   the menu), closeAutoFocus (default: back to the trigger), escapeKeyDown,
 *   pointerDownOutside, focusOutside, interactOutside.
 * Class and attributes go to the menu element.
 */
import { computed, inject, shallowRef, watch } from 'vue'
import { MENU, required } from './contexts.js'
import { cancelableEvent, useParentScopeAttrs } from './primitive.js'
import { focusElement, isUsingKeyboard, useDismissableLayer, useFloatingPosition } from './floating.js'
import { provideMenuContent } from './menu.js'
import './ui.css'
import './menu.css'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  side: { type: String, default: 'bottom' },
  align: { type: String, default: 'center' },
  sideOffset: { type: Number, default: 4 },
  alignOffset: { type: Number, default: 0 },
  avoidCollisions: { type: Boolean, default: true },
  collisionPadding: { type: Number, default: 0 }
})
const emit = defineEmits([
  'openAutoFocus',
  'closeAutoFocus',
  'escapeKeyDown',
  'pointerDownOutside',
  'focusOutside',
  'interactOutside'
])

const menu = required(inject(MENU, null), 'DropdownMenuContent', 'DropdownMenu')
const scopeAttrs = useParentScopeAttrs()
const contentEl = shallowRef(null)
const isOpen = computed(() => menu.open.value)
const { ctx: contentCtx, onKeydown } = provideMenuContent(contentEl)
let interactedOutside = false

const position = useFloatingPosition(
  () => menu.triggerEl.value,
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
  modal: () => menu.modal.value,
  // The trigger's own pointer down toggles the menu.
  excludes: (target, kind) => kind === 'pointer' && !!menu.triggerEl.value && menu.triggerEl.value.contains(target),
  onEscapeKeyDown: (event) => emit('escapeKeyDown', event),
  onPointerDownOutside: (event) => {
    emit('pointerDownOutside', event)
    emit('interactOutside', event)
    const original = event.detail.originalEvent
    const rightClick = original.button === 2 || (original.button === 0 && original.ctrlKey)
    if (!menu.modal.value || rightClick) interactedOutside = true
  },
  onFocusOutside: (event) => {
    // A modal menu never closes because focus moved.
    if (menu.modal.value) {
      event.preventDefault()
      return
    }
    emit('focusOutside', event)
    emit('interactOutside', event)
    if (!event.defaultPrevented) interactedOutside = true
  },
  onDismiss: () => menu.close()
})

watch(contentEl, (el, previous) => {
  if (el && !previous) {
    interactedOutside = false
    const event = cancelableEvent('nc.openAutoFocus')
    emit('openAutoFocus', event)
    if (event.defaultPrevented) return
    const first = isUsingKeyboard() ? contentCtx.items()[0] : null
    focusElement(first || el)
  }
}, { flush: 'post' })
watch(isOpen, (open, was) => {
  if (!open && was) {
    const event = cancelableEvent('nc.closeAutoFocus')
    emit('closeAutoFocus', event)
    if (!event.defaultPrevented && !interactedOutside) focusElement(menu.triggerEl.value)
    interactedOutside = false
  }
})

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
  <Teleport to="body">
    <Transition name="nc-ui">
      <div
        v-if="isOpen"
        v-bind="{ ...scopeAttrs, ...$attrs }"
        :id="menu.contentId"
        ref="contentEl"
        role="menu"
        aria-orientation="vertical"
        tabindex="-1"
        :aria-labelledby="menu.triggerId"
        data-slot="dropdown-menu-content"
        :data-state="isOpen ? 'open' : 'closed'"
        :data-side="position.side"
        :data-align="position.align"
        class="nc-root nc-ui-menu-content nc-ui-menu-content--scroll nc-ui-scrollbar-sleek nc-ui-animate-in nc-ui-slide"
        :style="style"
        @keydown="onKeydown"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>
