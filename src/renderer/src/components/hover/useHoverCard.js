// The open / close logic of Orca's HoverCard (components/ui/hover-card.tsx,
// a Radix HoverCard; MIT, Copyright (c) 2026 Lovecast Inc.), for Vue: the
// card opens after `openDelay` when the pointer (not a touch) rests on its
// trigger or the trigger takes the focus, and closes `closeDelay` after the
// pointer leaves both the trigger and the card, so the pointer can travel
// onto the card. Tessel adds what Radix gets from its layers: Esc, a scroll,
// a right-click or a drag close it, and only one hover card is open at a time
// (opening one closes the other, like Radix's single dismissable layer).
import { ref, onBeforeUnmount } from 'vue'

let current = null

// Closes whichever hover card is open (a menu or a dialog opening).
export function closeOpenHoverCard() {
  if (current) current.close()
}

export function useHoverCard(options = {}) {
  const openDelay = options.openDelay ?? 250
  const closeDelay = options.closeDelay ?? 120
  const disabled = options.disabled || (() => false)
  // Children of the trigger that own their own hover card (the plug, the
  // agent rows): resting on them closes this one.
  const ignore = options.ignore || null

  const open = ref(false)
  const anchor = ref(null)
  const contentEl = ref(null)
  let openTimer = 0
  let closeTimer = 0
  let pending = false
  // After Esc or a right-click the card stays closed until the pointer leaves.
  let suppressed = false

  const self = { dismiss, close: () => hide(0) }

  function clearTimers() {
    clearTimeout(openTimer)
    clearTimeout(closeTimer)
    openTimer = closeTimer = 0
    pending = false
  }

  function listen(on) {
    const method = on ? 'addEventListener' : 'removeEventListener'
    document[method]('keydown', onKey, true)
    window[method]('scroll', onScroll, true)
    window[method]('blur', dismiss)
  }

  function setOpen(next) {
    if (next === open.value) return
    if (next) {
      if (current && current !== self) current.dismiss()
      current = self
      listen(true)
    } else {
      if (current === self) current = null
      listen(false)
    }
    open.value = next
  }

  function show(delay = openDelay) {
    if (suppressed || disabled()) return
    clearTimeout(closeTimer)
    closeTimer = 0
    if (open.value || pending) return
    if (delay <= 0) return setOpen(true)
    pending = true
    openTimer = setTimeout(() => {
      pending = false
      setOpen(true)
    }, delay)
  }

  function hide(delay = closeDelay) {
    clearTimeout(openTimer)
    openTimer = 0
    pending = false
    if (!open.value) return
    clearTimeout(closeTimer)
    if (delay <= 0) return setOpen(false)
    closeTimer = setTimeout(() => setOpen(false), delay)
  }

  function dismiss() {
    suppressed = true
    clearTimers()
    setOpen(false)
  }

  function onKey(e) {
    if (e.key === 'Escape') dismiss()
  }

  function onScroll(e) {
    // The card scrolls its own long content without closing.
    const el = contentEl.value
    if (el && e.target instanceof Node && el.contains(e.target)) return
    dismiss()
  }

  function inside(node) {
    if (!(node instanceof Node)) return false
    return !!((anchor.value && anchor.value.contains(node)) || (contentEl.value && contentEl.value.contains(node)))
  }

  function ignored(target) {
    return !!(ignore && target instanceof Element && target.closest(ignore) && anchor.value && anchor.value.contains(target.closest(ignore)))
  }

  // Why pointerover and not pointerenter: pointerover carries the element
  // under the pointer, so a child that owns its own card (the plug, an agent
  // row) can close this one and never race it open.
  const triggerListeners = {
    pointerover(e) {
      if (e.pointerType === 'touch') return
      anchor.value = e.currentTarget
      if (ignored(e.target)) {
        clearTimers()
        setOpen(false)
        return
      }
      show()
    },
    pointerleave(e) {
      if (e.pointerType === 'touch') return
      suppressed = false
      if (inside(e.relatedTarget)) return
      hide()
    },
    focusin(e) {
      anchor.value = e.currentTarget
      if (ignored(e.target)) return
      show()
    },
    focusout(e) {
      suppressed = false
      if (inside(e.relatedTarget)) return
      hide()
    },
    contextmenu: dismiss,
    dragstart: dismiss
  }

  const contentListeners = {
    pointerenter(e) {
      if (e.pointerType === 'touch') return
      clearTimeout(closeTimer)
      closeTimer = 0
    },
    pointerleave(e) {
      if (e.pointerType === 'touch') return
      if (inside(e.relatedTarget)) return
      hide()
    },
    focusout(e) {
      if (inside(e.relatedTarget)) return
      hide()
    }
  }

  onBeforeUnmount(() => {
    clearTimers()
    setOpen(false)
  })

  return { open, anchor, contentEl, show, hide, dismiss, triggerListeners, contentListeners }
}
