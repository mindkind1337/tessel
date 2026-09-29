<script setup>
// After Orca's components/ui/dropdown-menu.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DropdownMenuSubContent: role="menu" of a DropdownMenuSub, teleported to
 * <body> with classes "nc-root nc-ui-menu-content", placed to the right of
 * its trigger (flipped left when it does not fit), top-aligned.
 * Same keyboard as DropdownMenuContent, plus ArrowLeft closes it and focuses
 * its trigger; Escape closes the whole menu.
 * Props: sideOffset (0), alignOffset (0), avoidCollisions (true),
 *   collisionPadding (0).
 * Emits: escapeKeyDown, pointerDownOutside, focusOutside (cancelable).
 */
import { computed, inject, shallowRef, watch } from 'vue'
import { MENU, MENU_SUB, required } from './contexts.js'
import { useParentScopeAttrs } from './primitive.js'
import { focusElement, isUsingKeyboard, useDismissableLayer, useFloatingPosition } from './floating.js'
import { provideMenuContent } from './menu.js'
import './ui.css'
import './menu.css'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  sideOffset: { type: Number, default: 0 },
  alignOffset: { type: Number, default: 0 },
  avoidCollisions: { type: Boolean, default: true },
  collisionPadding: { type: Number, default: 0 }
})
const emit = defineEmits(['escapeKeyDown', 'pointerDownOutside', 'focusOutside'])

const menu = required(inject(MENU, null), 'DropdownMenuSubContent', 'DropdownMenu')
const sub = required(inject(MENU_SUB, null), 'DropdownMenuSubContent', 'DropdownMenuSub')
const scopeAttrs = useParentScopeAttrs()
const contentEl = shallowRef(null)
const isOpen = computed(() => menu.open.value && sub.open.value)
const { ctx: contentCtx, onKeydown: onMenuKeydown } = provideMenuContent(contentEl)

const position = useFloatingPosition(
  () => sub.triggerEl.value,
  contentEl,
  () => isOpen.value,
  () => ({
    side: 'right',
    align: 'start',
    sideOffset: props.sideOffset,
    alignOffset: props.alignOffset,
    avoidCollisions: props.avoidCollisions,
    collisionPadding: props.collisionPadding
  })
)

useDismissableLayer(() => isOpen.value && !!contentEl.value, {
  elements: () => [contentEl.value],
  excludes: (target) => !!sub.triggerEl.value && sub.triggerEl.value.contains(target),
  onEscapeKeyDown: (event) => {
    emit('escapeKeyDown', event)
    if (event.defaultPrevented) return
    // Radix: Escape in a sub-menu closes the whole menu.
    event.preventDefault()
    menu.close()
  },
  onPointerDownOutside: (event) => emit('pointerDownOutside', event),
  onFocusOutside: (event) => emit('focusOutside', event),
  onDismiss: () => sub.close()
})

watch(contentEl, (el, previous) => {
  if (el && !previous && isUsingKeyboard()) focusElement(contentCtx.items()[0] || el)
}, { flush: 'post' })

function onKeydown(event) {
  if (event.key === 'ArrowLeft' && contentEl.value && contentEl.value.contains(event.target)) {
    event.preventDefault()
    sub.close()
    focusElement(sub.triggerEl.value)
    return
  }
  onMenuKeydown(event)
}

const style = computed(() => ({
  position: 'fixed',
  left: `${position.x}px`,
  top: `${position.y}px`,
  '--nc-available-width': `${position.availableWidth}px`,
  '--nc-available-height': `${position.availableHeight}px`,
  '--nc-transform-origin': position.transformOrigin
}))
</script>

<template>
  <Teleport to="body">
    <Transition name="nc-ui">
      <div
        v-if="isOpen"
        v-bind="{ ...scopeAttrs, ...$attrs }"
        :id="sub.contentId"
        ref="contentEl"
        role="menu"
        aria-orientation="vertical"
        tabindex="-1"
        :aria-labelledby="sub.triggerId"
        data-slot="dropdown-menu-sub-content"
        :data-state="isOpen ? 'open' : 'closed'"
        :data-side="position.side"
        :data-align="position.align"
        class="nc-root nc-ui-menu-content nc-ui-animate-in nc-ui-slide"
        :style="style"
        @keydown="onKeydown"
        @pointerenter="sub.cancelGrace()"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>
