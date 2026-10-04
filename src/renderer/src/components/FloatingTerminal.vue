<script setup>
// The floating terminal's panel (floatingTerminal.js has its state): it
// slides down from the top of the workspace over the panes, a real Tessel
// terminal (TerminalPane) that is not one of the grid's panes. Its height is
// dragged at its bottom edge. Hidden, it stays mounted off screen (like a
// hidden workspace, style.css), so its terminal keeps its screen and runs on.
// After Orca's src/renderer/src/components/floating-terminal/
// FloatingTerminalPanel.tsx and use-floating-terminal-focus-lifecycle.ts
// (MIT, Copyright (c) 2026 Lovecast Inc.): shown, it takes the keyboard;
// hidden, the keyboard goes back where it was.
import { ref, computed, inject, provide, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import TerminalPane from './TerminalPane.vue'
import { trackPointerDrag } from '../browser/webviewPassthrough'
import { t } from '../i18n'

const props = defineProps({
  // createFloatingTerminal()'s result.
  ctl: { type: Object, required: true }
})
const emit = defineEmits(['restore-focus'])

const rootEl = ref(null)
const state = props.ctl.state
const leaf = computed(() => state.leaf)
// Its terminal has the keyboard (its pane shows as the active one); kept in
// its state so App.vue's grid panes leave the keyboard to it.
const focused = computed({
  get: () => !!state.keyboard,
  set: (v) => {
    state.keyboard = !!v
  }
})
const activeId = computed(() => (focused.value && state.open && leaf.value ? leaf.value.id : null))

// Its pane's actions are its own: no split, maximize or drag in the grid,
// typing goes to its terminal only (never multi-write), close stops it.
const parent = inject('panelCtx', {})
provide('panelCtx', {
  ...parent,
  // (Its pane's header and menu leave out maximize, split and open here.)
  floating: true,
  floatingHasKeyboard: null,
  activeId,
  maximizedId: ref(null),
  broadcast: ref(false),
  highlightId: parent.highlightId || ref(null),
  routeInput: (id, data) => window.shellApi.writePty(id, data),
  setActive: () => {
    focused.value = true
  },
  splitLeaf: null,
  toggleMaximize: null,
  beginPaneDrag: null,
  closeLeaf: () => props.ctl.close(),
  restartLeaf: () => props.ctl.restart(),
  otherPanes: parent.otherPanes || (() => [])
})

// --- Height (dragged at the bottom edge) ------------------------------------
const dragHeight = ref(null)
const shownHeight = computed(() => (dragHeight.value != null ? dragHeight.value : state.height))
const resizing = ref(false)

function onResizeDown(e) {
  if (e.button !== 0) return
  e.preventDefault()
  const area = rootEl.value && rootEl.value.parentElement
  if (!area) return
  const box = area.getBoundingClientRect()
  if (!box.height) return
  resizing.value = true
  trackPointerDrag(e, {
    onMove: (ev) => {
      dragHeight.value = Math.min(0.95, Math.max(0.1, (ev.clientY - box.top) / box.height))
    },
    onEnd: () => {
      resizing.value = false
      if (dragHeight.value != null) props.ctl.setHeight(dragHeight.value)
      dragHeight.value = null
    }
  })
}

// Keyboard: up and down in steps, for the handle's keyboard users.
function onResizeKey(e) {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault()
    props.ctl.setHeight(state.height + (e.key === 'ArrowDown' ? 0.05 : -0.05))
  }
}

// --- Focus: taken when shown, given back when hidden -------------------------
let before = null

function focusTerminal() {
  const ta = rootEl.value && rootEl.value.querySelector('.xterm-helper-textarea')
  if (ta) ta.focus()
}

// Where the keyboard was not chosen by the user: nowhere, or the button
// that shows and hides this panel (clicking it focuses it).
function nowhere(el) {
  return !el || el === document.body || !!(el.closest && el.closest('[data-test="floating-terminal-toggle"]'))
}

watch(
  () => state.open,
  (open) => {
    const el = document.activeElement
    const inside = !!(el && rootEl.value && rootEl.value.contains(el))
    if (open) {
      before = !nowhere(el) && !inside ? el : null
      focused.value = true
      nextTick(focusTerminal)
      return
    }
    focused.value = false
    // Only when the keyboard was in it: something else chosen meanwhile
    // (a pane clicked below it) keeps the keyboard.
    if (inside || nowhere(el)) {
      if (inside && typeof el.blur === 'function') el.blur()
      if (before && before.isConnected && typeof before.focus === 'function') before.focus()
      else emit('restore-focus')
    }
    before = null
  }
)

// Its terminal comes (started or re-attached) while it is shown.
watch(leaf, (l) => {
  if (l && state.open && focused.value) nextTick(focusTerminal)
})

// The keyboard moved out of it to a grid pane: it is no longer the active
// one; back into it: it is. A dialog, menu or the palette taking the keyboard
// for a moment changes nothing: closed, it gives the keyboard back here.
function onFocusIn(e) {
  if (!rootEl.value || !e.target) return
  if (rootEl.value.contains(e.target)) focused.value = true
  else if (e.target.closest && e.target.closest('.pane, .ws-layer')) focused.value = false
}
onMounted(() => document.addEventListener('focusin', onFocusIn))
onBeforeUnmount(() => document.removeEventListener('focusin', onFocusIn))
</script>

<template>
  <div
    ref="rootEl"
    class="floating-term"
    :class="{ open: state.open, resizing }"
    :style="{ height: shownHeight * 100 + '%' }"
    :aria-hidden="!state.open"
    data-test="floating-terminal"
    role="region"
    :aria-label="t('floating.label', 'Floating terminal')"
  >
    <div class="floating-term-body">
      <TerminalPane v-if="leaf" :key="leaf.id" :node="leaf" />
      <div v-else class="floating-term-starting" data-test="floating-terminal-starting">
        {{ state.starting ? t('floating.starting', 'Starting the terminal...') : '' }}
      </div>
    </div>
    <div
      class="floating-term-handle"
      role="separator"
      aria-orientation="horizontal"
      tabindex="0"
      :aria-label="t('floating.resize', 'Resize the floating terminal')"
      :title="t('floating.resizeHint', 'Drag to resize. Ctrl+` hides it, its terminal keeps running.')"
      data-test="floating-terminal-resize"
      @pointerdown="onResizeDown"
      @keydown="onResizeKey"
    >
      <span class="floating-term-grip" aria-hidden="true"></span>
      <button
        class="floating-term-hide"
        type="button"
        data-test="floating-terminal-hide"
        :title="t('floating.hideHint', 'Hide (Ctrl+`). Its terminal keeps running.')"
        :aria-label="t('floating.hide', 'Hide the floating terminal')"
        @pointerdown.stop
        @click="ctl.hide()"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 10l4.5-4.5 4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Over the panes, their browser pages (z-index 1) and a maximized pane (100);
   under the menus and dialogs. Hidden: slid up out of sight and not drawn
   (xterm pauses an off-screen terminal), still mounted. */
.floating-term {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 120;
  display: flex;
  flex-direction: column;
  background: var(--term);
  border-bottom: 1px solid var(--border-strong);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
  transform: translateY(calc(-100% - 40px));
  visibility: hidden;
  pointer-events: none;
  transition:
    transform 0.16s ease-out,
    visibility 0s linear 0.16s;
}
.floating-term.open {
  transform: translateY(0);
  visibility: visible;
  pointer-events: auto;
  transition:
    transform 0.16s ease-out,
    visibility 0s;
}
.floating-term.resizing {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .floating-term,
  .floating-term.open {
    transition: none;
  }
}
.floating-term-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
.floating-term-starting {
  padding: 12px 14px;
  color: var(--text-dim);
  font-size: 12px;
}
.floating-term-handle {
  position: relative;
  flex: 0 0 auto;
  height: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  border-top: 1px solid var(--border);
  cursor: ns-resize;
  touch-action: none;
}
.floating-term-handle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.floating-term-grip {
  width: 36px;
  height: 3px;
  border-radius: 2px;
  background: var(--border-strong);
}
.floating-term-handle:hover .floating-term-grip,
.floating-term.resizing .floating-term-grip {
  background: var(--accent);
}
.floating-term-hide {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 14px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.floating-term-hide:hover {
  color: var(--text-strong);
  background: var(--border);
}
</style>
