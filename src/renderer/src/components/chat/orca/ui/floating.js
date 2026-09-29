// Floating-content plumbing for the ui/ primitives (what Radix's Popper,
// DismissableLayer and FocusScope give Orca's shadcn/ui components, shadcn/ui,
// MIT, Copyright (c) 2026 Lovecast Inc.), by hand: no @floating-ui.
//
// - computeFloatingPosition: side/align/sideOffset/alignOffset placement in
//   viewport coordinates, flipped to the other side when it does not fit and
//   shifted along the other axis to stay inside the viewport.
// - useFloatingPosition: keeps a teleported element next to its anchor while
//   open (scroll, resize, size changes).
// - useDismissableLayer: one stack of open layers; Escape goes to the top one,
//   a pointer down / focus outside a layer (and every layer above it)
//   dismisses it; a "modal" layer blocks pointer events outside itself.
// - Focus helpers: tabbable elements, first focus, Tab trapping.
import { onScopeDispose, reactive, watch } from 'vue'

const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

function viewportSize() {
  const doc = typeof document !== 'undefined' ? document.documentElement : null
  return {
    width: (doc && doc.clientWidth) || window.innerWidth || 0,
    height: (doc && doc.clientHeight) || window.innerHeight || 0
  }
}

function clamp(value, min, max) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

function mainPosition(side, anchor, size, offset) {
  if (side === 'top') return anchor.top - offset - size.height
  if (side === 'bottom') return anchor.top + anchor.height + offset
  if (side === 'left') return anchor.left - offset - size.width
  return anchor.left + anchor.width + offset
}

// How far the floating element would stick out of the viewport on its side.
function mainOverflow(side, anchor, size, offset, viewport, padding) {
  const start = mainPosition(side, anchor, size, offset)
  if (side === 'top') return padding - start
  if (side === 'left') return padding - start
  if (side === 'bottom') return start + size.height - (viewport.height - padding)
  return start + size.width - (viewport.width - padding)
}

/**
 * anchor: { left, top, width, height } (viewport px); size: { width, height }
 * of the floating element; returns { x, y, side, align, availableWidth,
 * availableHeight, arrowOffset, transformOrigin }.
 */
export function computeFloatingPosition({
  anchor,
  size,
  side = 'bottom',
  align = 'center',
  sideOffset = 0,
  alignOffset = 0,
  avoidCollisions = true,
  collisionPadding = 0,
  viewport = viewportSize()
}) {
  const padding = typeof collisionPadding === 'number' ? collisionPadding : 0
  let placed = side
  if (avoidCollisions) {
    const overflow = mainOverflow(side, anchor, size, sideOffset, viewport, padding)
    if (overflow > 0) {
      const other = OPPOSITE[side]
      const otherOverflow = mainOverflow(other, anchor, size, sideOffset, viewport, padding)
      if (otherOverflow < overflow) placed = other
    }
  }
  const vertical = placed === 'top' || placed === 'bottom'
  const main = mainPosition(placed, anchor, size, sideOffset)
  const crossStart = vertical ? anchor.left : anchor.top
  const crossLength = vertical ? anchor.width : anchor.height
  const crossSize = vertical ? size.width : size.height
  let cross =
    align === 'start'
      ? crossStart
      : align === 'end'
        ? crossStart + crossLength - crossSize
        : crossStart + (crossLength - crossSize) / 2
  cross += align === 'end' ? -alignOffset : alignOffset
  if (avoidCollisions) {
    const limit = (vertical ? viewport.width : viewport.height) - padding - crossSize
    cross = clamp(cross, padding, limit)
  }
  const x = vertical ? cross : main
  const y = vertical ? main : cross
  const availableHeight = vertical
    ? placed === 'top'
      ? anchor.top - sideOffset - padding
      : viewport.height - (anchor.top + anchor.height) - sideOffset - padding
    : viewport.height - padding * 2
  const availableWidth = vertical
    ? viewport.width - padding * 2
    : placed === 'left'
      ? anchor.left - sideOffset - padding
      : viewport.width - (anchor.left + anchor.width) - sideOffset - padding
  // Where the anchor's centre falls along the floating element (arrows).
  const arrowOffset = crossStart + crossLength / 2 - cross
  const originCross = align === 'start' ? '0%' : align === 'end' ? '100%' : '50%'
  const transformOrigin = vertical
    ? `${originCross} ${placed === 'top' ? '100%' : '0%'}`
    : `${placed === 'left' ? '100%' : '0%'} ${originCross}`
  return {
    x: Math.round(x),
    y: Math.round(y),
    side: placed,
    align,
    availableWidth: Math.max(0, Math.floor(availableWidth)),
    availableHeight: Math.max(0, Math.floor(availableHeight)),
    arrowOffset,
    transformOrigin
  }
}

/**
 * Keeps `floating` (a ref to the teleported element) placed next to
 * `anchor()` while `isOpen()`. `options()` returns side/align/sideOffset/
 * alignOffset/avoidCollisions/collisionPadding. Returns a reactive
 * { x, y, side, align, availableWidth, availableHeight, arrowOffset,
 * transformOrigin, update }.
 */
export function useFloatingPosition(anchor, floating, isOpen, options) {
  const initial = options()
  const state = reactive({
    x: 0,
    y: 0,
    side: initial.side || 'bottom',
    align: initial.align || 'center',
    availableWidth: 0,
    availableHeight: 0,
    arrowOffset: 0,
    transformOrigin: '50% 50%',
    update
  })
  let observer = null
  let listening = false

  function update() {
    const anchorEl = anchor()
    const el = floating.value
    if (!anchorEl || !el) return
    const rect = anchorEl.getBoundingClientRect()
    // offsetWidth/Height: the untransformed size (the zoom-in animation
    // scales the element while it opens).
    const size = { width: el.offsetWidth, height: el.offsetHeight }
    Object.assign(
      state,
      computeFloatingPosition({
        anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        size,
        ...options()
      })
    )
  }

  function start() {
    if (listening) return
    listening = true
    window.addEventListener('scroll', update, { capture: true, passive: true })
    window.addEventListener('resize', update)
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => update())
      if (floating.value) observer.observe(floating.value)
      const anchorEl = anchor()
      if (anchorEl) observer.observe(anchorEl)
    }
  }

  function stop() {
    if (!listening) return
    listening = false
    window.removeEventListener('scroll', update, { capture: true })
    window.removeEventListener('resize', update)
    if (observer) observer.disconnect()
    observer = null
  }

  watch(
    [() => isOpen(), () => floating.value, () => anchor()],
    ([open, el]) => {
      stop()
      if (open && el) {
        update()
        start()
      }
    },
    { flush: 'post', immediate: true }
  )
  watch(options, () => update(), { deep: true, flush: 'post' })
  onScopeDispose(stop)
  return state
}

// ---------------------------------------------------------------------------
// Dismissable layers.

const layers = []
let listening = false
let bodyPointerEventsBefore = null

function modalIndex() {
  for (let i = layers.length - 1; i >= 0; i--) if (layers[i].modal()) return i
  return -1
}

function insideLayerOrAbove(index, target) {
  for (let i = index; i < layers.length; i++) if (layers[i].contains(target)) return true
  return false
}

function onKeyDown(event) {
  if (event.key !== 'Escape') return
  const top = layers[layers.length - 1]
  if (!top) return
  top.onEscapeKeyDown(event)
  if (!event.defaultPrevented) {
    event.preventDefault()
    top.onDismiss('escape')
  }
}

function dismissOutside(event, kind) {
  const target = event.target
  const blockedBelow = modalIndex()
  for (const layer of [...layers].reverse()) {
    const index = layers.indexOf(layer)
    if (index < 0 || index < blockedBelow) break
    if (insideLayerOrAbove(index, target)) continue
    if (layer.excludes(target, kind)) continue
    const custom = new CustomEvent(kind === 'pointer' ? 'nc.pointerDownOutside' : 'nc.focusOutside', {
      cancelable: true,
      detail: { originalEvent: event }
    })
    if (kind === 'pointer') layer.onPointerDownOutside(custom)
    else layer.onFocusOutside(custom)
    if (!custom.defaultPrevented) layer.onDismiss(kind)
  }
}

const onPointerDown = (event) => dismissOutside(event, 'pointer')
const onFocusIn = (event) => dismissOutside(event, 'focus')

function syncGlobals() {
  const doc = typeof document !== 'undefined' ? document : null
  if (!doc) return
  if (layers.length && !listening) {
    listening = true
    doc.addEventListener('keydown', onKeyDown, true)
    doc.addEventListener('pointerdown', onPointerDown, true)
    doc.addEventListener('focusin', onFocusIn, true)
  } else if (!layers.length && listening) {
    listening = false
    doc.removeEventListener('keydown', onKeyDown, true)
    doc.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('focusin', onFocusIn, true)
  }
  // Radix's disableOutsidePointerEvents: the body stops taking the pointer
  // while a modal layer is open; the layer itself sets pointer-events: auto.
  const anyModal = layers.some((layer) => layer.modal())
  if (anyModal && bodyPointerEventsBefore === null) {
    bodyPointerEventsBefore = doc.body.style.pointerEvents
    doc.body.style.pointerEvents = 'none'
  } else if (!anyModal && bodyPointerEventsBefore !== null) {
    doc.body.style.pointerEvents = bodyPointerEventsBefore
    bodyPointerEventsBefore = null
  }
}

/**
 * Registers a layer while `active()` is true. Options: elements() → the
 * layer's elements (content, and for some the trigger via excludes),
 * modal() → blocks pointer events outside, excludes(target, kind) → targets
 * that are neither inside nor outside (a popover's own trigger),
 * onEscapeKeyDown(event), onPointerDownOutside(customEvent),
 * onFocusOutside(customEvent), onDismiss(reason).
 */
export function useDismissableLayer(active, opts) {
  const noop = () => {}
  const layer = {
    contains: (target) =>
      !!target && opts.elements().some((el) => el && (el === target || (target.nodeType && el.contains(target)))),
    modal: () => !!(opts.modal && opts.modal()),
    excludes: (target, kind) => !!(opts.excludes && opts.excludes(target, kind)),
    onEscapeKeyDown: opts.onEscapeKeyDown || noop,
    onPointerDownOutside: opts.onPointerDownOutside || noop,
    onFocusOutside: opts.onFocusOutside || noop,
    onDismiss: opts.onDismiss || noop
  }
  function add() {
    if (!layers.includes(layer)) layers.push(layer)
    syncGlobals()
  }
  function remove() {
    const index = layers.indexOf(layer)
    if (index >= 0) layers.splice(index, 1)
    syncGlobals()
  }
  watch(
    () => [active(), layer.modal()],
    ([on]) => {
      if (on) add()
      else remove()
    },
    { immediate: true }
  )
  onScopeDispose(remove)
  return { isTop: () => layers[layers.length - 1] === layer }
}

// For tests and for callers that must know whether an Escape is theirs.
export function openLayerCount() {
  return layers.length
}

// ---------------------------------------------------------------------------
// Focus.

const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable=""]',
  '[contenteditable="true"]'
].join(',')

export function tabbables(container) {
  if (!container) return []
  return [...container.querySelectorAll(TABBABLE)].filter(
    (el) => !el.closest('[hidden]') && el.getAttribute('tabindex') !== '-1' && !el.closest('[inert]')
  )
}

export function focusElement(el) {
  if (el && typeof el.focus === 'function') el.focus({ preventScroll: true })
}

// Radix FocusScope's mount focus: first tabbable (links last), else the container.
export function focusFirst(container) {
  const list = tabbables(container)
  const first = list.find((el) => el.tagName !== 'A') || list[0]
  focusElement(first || container)
}

// Keeps Tab / Shift+Tab inside `container`.
export function trapTab(event, container) {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
  const list = tabbables(container)
  if (!list.length) {
    event.preventDefault()
    focusElement(container)
    return
  }
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  if (event.shiftKey && (active === first || active === container)) {
    event.preventDefault()
    focusElement(last)
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    focusElement(first)
  }
}

// Radix tracks whether the last interaction was the keyboard (menus focus
// their first item only when opened from the keyboard).
let usingKeyboard = false
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => (usingKeyboard = true), true)
  document.addEventListener('pointerdown', () => (usingKeyboard = false), true)
  document.addEventListener('pointermove', () => (usingKeyboard = false), true)
}
export function isUsingKeyboard() {
  return usingKeyboard
}
