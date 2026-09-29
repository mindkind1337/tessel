// Menu behaviour shared by the DropdownMenu parts (Radix Menu, which Orca's
// components/ui/dropdown-menu.tsx wraps; shadcn/ui, MIT, Copyright (c) 2026
// Lovecast Inc.): roving focus over the items, Home/End, typeahead, Tab kept
// in the menu, item hover focus, select-and-close, sub-menu hover intent.
import { inject, onScopeDispose, provide, ref } from 'vue'
import { MENU, MENU_CONTENT, required } from './contexts.js'
import { focusElement } from './floating.js'

export const ITEM_SELECTOR = '[data-nc-menu-item]:not([data-disabled])'
const TYPEAHEAD_RESET_MS = 1000

function textOf(el) {
  return (el.getAttribute('data-text-value') || el.textContent || '').trim()
}

// Radix's getNextMatch: a repeated letter cycles through the items it starts.
function nextMatch(items, search, current) {
  const isRepeated = search.length > 1 && Array.from(search).every((c) => c === search[0])
  const needle = (isRepeated ? search[0] : search).toLowerCase()
  const start = Math.max(current ? items.indexOf(current) : -1, 0)
  let ordered = items.slice(start).concat(items.slice(0, start))
  if (needle.length === 1) ordered = ordered.filter((el) => el !== current)
  const match = ordered.find((el) => textOf(el).toLowerCase().startsWith(needle))
  return match !== current ? match : undefined
}

/**
 * Provides the context items of one menu surface (root or sub content) use.
 * Returns { ctx, onKeydown } — the content binds onKeydown.
 */
export function provideMenuContent(contentEl) {
  const subs = new Set()
  let search = ''
  let searchTimer = null

  const items = () => (contentEl.value ? [...contentEl.value.querySelectorAll(ITEM_SELECTOR)] : [])

  const ctx = {
    contentEl,
    items,
    registerSub(sub) {
      subs.add(sub)
      return () => subs.delete(sub)
    },
    // The pointer is on an item: it takes focus and closes sibling sub-menus
    // (not one the pointer is still travelling to).
    onItemEnter(el) {
      for (const sub of subs) if (sub.triggerEl.value !== el && !sub.inGrace()) sub.close()
      if (el && document.activeElement !== el) focusElement(el)
    },
    onItemLeave() {
      for (const sub of subs) if (sub.isOpen() || sub.inGrace()) return
      if (contentEl.value && contentEl.value.contains(document.activeElement)) focusElement(contentEl.value)
    },
    isTypingAhead: () => search !== ''
  }
  provide(MENU_CONTENT, ctx)
  onScopeDispose(() => clearTimeout(searchTimer))

  function onKeydown(event) {
    const content = contentEl.value
    if (!content || !content.contains(event.target)) return
    if (event.key === 'Tab') {
      event.preventDefault()
      return
    }
    const list = items()
    const current = list.indexOf(document.activeElement)
    const isModifier = event.ctrlKey || event.altKey || event.metaKey
    if (!isModifier && event.key.length === 1 && !(event.key === ' ' && search === '')) {
      search += event.key
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => (search = ''), TYPEAHEAD_RESET_MS)
      const match = nextMatch(list, search, list[current])
      if (match) focusElement(match)
      if (event.key === ' ') event.preventDefault()
      return
    }
    let target = null
    if (event.key === 'ArrowDown') {
      target = current < 0 ? list[0] : list[Math.min(current + 1, list.length - 1)]
    } else if (event.key === 'ArrowUp') {
      target = current < 0 ? list[list.length - 1] : list[Math.max(current - 1, 0)]
    } else if (event.key === 'Home' || event.key === 'PageUp') {
      target = list[0]
    } else if (event.key === 'End' || event.key === 'PageDown') {
      target = list[list.length - 1]
    } else {
      return
    }
    event.preventDefault()
    if (target) focusElement(target)
  }

  return { ctx, onKeydown }
}

/**
 * An item's behaviour: highlight on focus, focus on mouse hover, select on
 * click / Enter / Space. `onSelect(event)` emits the cancelable select
 * event; the menu closes unless it was prevented. `afterSelect()` then runs
 * even when prevented (radio / checkbox value changes, as in Radix).
 */
export function useMenuItem({ disabled, onSelect, afterSelect }) {
  const menu = required(inject(MENU, null), 'DropdownMenuItem', 'DropdownMenu')
  const content = required(inject(MENU_CONTENT, null), 'DropdownMenuItem', 'DropdownMenuContent')
  const el = ref(null)
  const highlighted = ref(false)

  function select() {
    if (disabled()) return
    const event = new CustomEvent('nc.menuSelect', { cancelable: true })
    onSelect(event)
    if (afterSelect) afterSelect()
    if (!event.defaultPrevented) menu.close()
  }

  const handlers = {
    onPointermove(event) {
      if (event.defaultPrevented || (event.pointerType && event.pointerType !== 'mouse')) return
      if (disabled()) content.onItemLeave()
      else content.onItemEnter(event.currentTarget)
    },
    onPointerleave(event) {
      if (event.defaultPrevented || (event.pointerType && event.pointerType !== 'mouse')) return
      content.onItemLeave()
    },
    onClick(event) {
      if (event.defaultPrevented) return
      select()
    },
    onKeydown(event) {
      if (event.defaultPrevented) return
      if (event.key === ' ' && content.isTypingAhead()) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        select()
      }
    },
    onFocus() {
      highlighted.value = true
    },
    onBlur() {
      highlighted.value = false
    }
  }

  return { el, highlighted, handlers, select, menu, content }
}
