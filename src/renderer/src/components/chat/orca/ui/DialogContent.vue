<script setup>
// After Orca's components/ui/dialog.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DialogContent: the overlay (modal only) and the panel, teleported to
 * <body> with classes "nc-root nc-ui-dialog-overlay" / "nc-root
 * nc-ui-dialog-content". The panel has role="dialog", aria-modal,
 * aria-labelledby (DialogTitle) and aria-describedby (DialogDescription).
 * Escape and a pointer down outside the panel (the overlay) close it; Tab is
 * trapped inside; focus goes to the first tabbable inside on open and back
 * to the trigger (else to what had focus before) on close.
 * Props: showCloseButton (default true: the top-right X, labelled "Close"),
 *   overlayClass.
 * Emits (cancelable, event.preventDefault() keeps the default):
 *   openAutoFocus, closeAutoFocus, escapeKeyDown (KeyboardEvent),
 *   pointerDownOutside, interactOutside.
 * Class and attributes go to the panel.
 */
import { computed, inject, shallowRef, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { t } from '../../../../i18n'
import { DIALOG, required } from './contexts.js'
import { cancelableEvent, useParentScopeAttrs } from './primitive.js'
import { focusElement, focusFirst, trapTab, useDismissableLayer } from './floating.js'
import DialogClose from './DialogClose.vue'
import './ui.css'

defineOptions({ inheritAttrs: false })
defineProps({
  showCloseButton: { type: Boolean, default: true },
  overlayClass: { type: [String, Array, Object], default: undefined }
})
const emit = defineEmits(['openAutoFocus', 'closeAutoFocus', 'escapeKeyDown', 'pointerDownOutside', 'interactOutside'])

const ctx = required(inject(DIALOG, null), 'DialogContent', 'Dialog')
const scopeAttrs = useParentScopeAttrs()
const contentEl = shallowRef(null)
const isOpen = computed(() => ctx.open.value)
let focusedBefore = null

useDismissableLayer(() => isOpen.value && !!contentEl.value, {
  elements: () => [contentEl.value],
  modal: () => ctx.modal.value,
  onEscapeKeyDown: (event) => emit('escapeKeyDown', event),
  onPointerDownOutside: (event) => {
    emit('pointerDownOutside', event)
    emit('interactOutside', event)
  },
  onFocusOutside: (event) => {
    // Modal: focus stays inside.
    if (ctx.modal.value) {
      event.preventDefault()
      focusElement(contentEl.value)
    }
  },
  onDismiss: () => ctx.setOpen(false)
})

watch(contentEl, (el, previous) => {
  if (el && !previous) {
    focusedBefore = document.activeElement
    const event = cancelableEvent('nc.openAutoFocus')
    emit('openAutoFocus', event)
    if (!event.defaultPrevented) focusFirst(el)
  }
}, { flush: 'post' })
watch(isOpen, (open, was) => {
  if (!open && was) {
    const event = cancelableEvent('nc.closeAutoFocus')
    emit('closeAutoFocus', event)
    if (!event.defaultPrevented) {
      const target = ctx.triggerEl.value || (focusedBefore && focusedBefore.isConnected ? focusedBefore : null)
      focusElement(target)
    }
    focusedBefore = null
  }
})

function onKeydown(event) {
  if (ctx.modal.value) trapTab(event, contentEl.value)
}

const closeLabel = computed(() => t('chat.orca.ui.close', 'Close'))
</script>

<template>
  <Teleport to="body">
    <Transition name="nc-ui">
      <div
        v-if="isOpen && ctx.modal.value"
        v-bind="scopeAttrs"
        data-slot="dialog-overlay"
        :data-state="isOpen ? 'open' : 'closed'"
        :class="['nc-root nc-ui-dialog-overlay nc-ui-animate-in', overlayClass]"
      />
    </Transition>
    <Transition name="nc-ui">
      <div
        v-if="isOpen"
        v-bind="{ ...scopeAttrs, ...$attrs }"
        :id="ctx.contentId"
        ref="contentEl"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        :aria-labelledby="ctx.titleId"
        :aria-describedby="ctx.descriptionId"
        data-slot="dialog-content"
        :data-state="isOpen ? 'open' : 'closed'"
        class="nc-root nc-ui-dialog-content nc-ui-animate-in"
        @keydown="onKeydown"
      >
        <slot />
        <DialogClose v-if="showCloseButton" class="nc-ui-dialog-close">
          <X />
          <span class="nc-ui-sr-only">{{ closeLabel }}</span>
        </DialogClose>
      </div>
    </Transition>
  </Teleport>
</template>

<style>
/* A deeper scrim + 2px blur: a flat 50% black disappears into a dark canvas. */
.nc-ui-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 450;
  background: rgb(0 0 0 / 0.55);
  backdrop-filter: blur(2px);
  pointer-events: auto;
  --nc-ui-enter-opacity: 0;
  --nc-ui-exit-opacity: 0;
}
/* Translucent surface, solid 14% border and dual shadow (the reference's
   dark: values); minmax(0,1fr) keeps a long unbreakable title inside. */
.nc-ui-dialog-content {
  box-sizing: border-box;
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 450;
  display: grid;
  width: 100%;
  max-width: calc(100% - 2rem);
  grid-template-columns: minmax(0, 1fr);
  translate: -50% -50%;
  gap: 16px;
  border-radius: 8px;
  border: 1px solid rgb(255 255 255 / 0.14);
  background: rgba(23, 23, 23, 0.96);
  padding: 24px;
  color: var(--nc-foreground);
  box-shadow: 0 24px 72px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(40px);
  outline: none;
  pointer-events: auto;
  --nc-ui-duration: 200ms;
  --nc-ui-enter-opacity: 0;
  --nc-ui-enter-scale: 0.95;
  --nc-ui-exit-opacity: 0;
  --nc-ui-exit-scale: 0.95;
  -webkit-app-region: no-drag;
}
@media (min-width: 640px) {
  .nc-ui-dialog-content {
    max-width: 32rem;
  }
}
.nc-ui-dialog-close {
  position: absolute;
  top: 16px;
  right: 16px;
  display: inline-flex;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 2px;
  background: transparent;
  color: inherit;
  cursor: default;
  opacity: 0.7;
  transition: opacity 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-ui-dialog-close:hover {
  opacity: 1;
}
.nc-ui-dialog-close:focus {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-background), 0 0 0 4px var(--nc-ring);
}
.nc-ui-dialog-close:disabled {
  pointer-events: none;
}
.nc-ui-dialog-close svg {
  pointer-events: none;
  flex-shrink: 0;
}
.nc-ui-dialog-close svg:not([class*='size-']) {
  width: 16px;
  height: 16px;
}
</style>
