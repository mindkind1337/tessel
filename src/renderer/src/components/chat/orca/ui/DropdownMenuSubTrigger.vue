<script setup>
// After Orca's components/ui/dropdown-menu.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DropdownMenuSubTrigger: role="menuitem" with aria-haspopup="menu",
 * aria-expanded, aria-controls, data-state 'open' | 'closed', and a right
 * chevron.
 * Props: inset, disabled, textValue, hideChevron (a sub-menu flipped to the
 *   left would make a right chevron misleading).
 */
import { inject, ref } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { MENU_SUB, required } from './contexts.js'
import { bindWith, elementOf } from './primitive.js'
import { focusElement } from './floating.js'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  inset: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  textValue: { type: String, default: undefined },
  hideChevron: { type: Boolean, default: false }
})

const sub = required(inject(MENU_SUB, null), 'DropdownMenuSubTrigger', 'DropdownMenuSub')
const content = sub.parent
const highlighted = ref(false)

function setEl(value) {
  sub.triggerEl.value = elementOf(value)
}

const isMouse = (event) => !event.pointerType || event.pointerType === 'mouse'

const handlers = {
  onPointermove(event) {
    if (event.defaultPrevented || !isMouse(event)) return
    if (props.disabled) {
      content.onItemLeave()
      return
    }
    sub.cancelGrace()
    content.onItemEnter(event.currentTarget)
    sub.openSoon()
  },
  onPointerleave(event) {
    if (event.defaultPrevented || !isMouse(event)) return
    sub.cancelOpen()
    if (sub.isOpen()) sub.startGrace()
    else content.onItemLeave()
  },
  onClick(event) {
    if (event.defaultPrevented || props.disabled) return
    focusElement(event.currentTarget)
    if (!sub.isOpen()) sub.setOpen(true)
  },
  onKeydown(event) {
    if (event.defaultPrevented || props.disabled) return
    if (event.key === ' ' && content.isTypingAhead()) return
    if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      // The sub content focuses its first item when it mounts (keyboard).
      if (!sub.isOpen()) sub.setOpen(true)
      else {
        const first = document.getElementById(sub.contentId)?.querySelector('[data-nc-menu-item]:not([data-disabled])')
        focusElement(first)
      }
    }
  },
  onFocus() {
    highlighted.value = true
  },
  onBlur() {
    highlighted.value = false
  }
}
</script>

<template>
  <div
    :ref="setEl"
    v-bind="
      bindWith(
        { role: 'menuitem', ...$attrs },
        {
          id: sub.triggerId,
          tabindex: -1,
          'aria-haspopup': 'menu',
          'aria-expanded': sub.open.value ? 'true' : 'false',
          'aria-controls': sub.open.value ? sub.contentId : undefined,
          'data-state': sub.open.value ? 'open' : 'closed',
          'data-slot': 'dropdown-menu-sub-trigger',
          'data-nc-menu-item': '',
          'data-inset': inset ? '' : undefined,
          'data-disabled': disabled ? '' : undefined,
          'aria-disabled': disabled ? 'true' : undefined,
          'data-highlighted': highlighted ? '' : undefined,
          'data-text-value': textValue
        },
        handlers
      )
    "
    class="nc-ui-menu-sub-trigger"
  >
    <slot />
    <ChevronRight v-if="!hideChevron" class="nc-ui-menu-chevron size-4" />
  </div>
</template>
