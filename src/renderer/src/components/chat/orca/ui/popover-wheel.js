// After Orca's components/ui/popover.tsx wheel shim (shadcn/ui, MIT,
// Copyright (c) 2026 Lovecast Inc.): a wheel over an opted-in popover
// scrolls the nearest vertical scroller between the target and the content.

/**
 * Nearest scrollable element between the wheel target and the popover content,
 * inclusive of both. Returns null when nothing in that chain can scroll.
 */
export function resolvePopoverScroller(target, content) {
  let node = target && typeof target.nodeType === 'number' ? target : null
  while (node && node !== content.parentNode) {
    if (node.nodeType === 1 && node.scrollHeight > node.clientHeight) {
      const overflowY = getComputedStyle(node).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll') return node
    }
    node = node.parentNode
  }
  return null
}

export function handlePopoverWheel(event, content) {
  if (event.defaultPrevented || !event.target || !content.contains(event.target)) return

  // Why two markers: `popover-scroll-content` also imposes a 15rem max-height and its
  // own overflow, while `popover-wheel-scroll` opts into the shim alone.
  if (!content.classList.contains('popover-scroll-content') && !content.classList.contains('popover-wheel-scroll')) {
    return
  }

  const el = resolvePopoverScroller(event.target, content)
  if (!el) return

  const LINE = typeof WheelEvent !== 'undefined' ? WheelEvent.DOM_DELTA_LINE : 1
  const PAGE = typeof WheelEvent !== 'undefined' ? WheelEvent.DOM_DELTA_PAGE : 2
  const delta =
    event.deltaMode === LINE ? event.deltaY * 16 : event.deltaMode === PAGE ? event.deltaY * el.clientHeight : event.deltaY
  const maxScrollTop = el.scrollHeight - el.clientHeight
  const nextScrollTop = Math.max(0, Math.min(maxScrollTop, el.scrollTop + delta))

  // Why: a modal layer's scroll lock can swallow native wheel scrolling in portaled popovers.
  if (nextScrollTop !== el.scrollTop) {
    event.preventDefault()
    el.scrollTop = nextScrollTop
  }
}
