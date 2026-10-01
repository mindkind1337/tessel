// After Orca's NativeChatMessageRail.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
// No @testing-library/user-event here: hover, press, click and keys are
// dispatched as the browser sequences them (a focused button's Enter is a click).
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import NativeChatMessageRail from '../NativeChatMessageRail.vue'

let wrapper = null
afterEach(() => {
  try {
    wrapper?.unmount()
  } finally {
    wrapper = null
    document.body.replaceChildren()
  }
})
// jsdom has no scrollIntoView; without layout it would be a no-op anyway.
let restoreScrollIntoView = () => {}
beforeAll(() => {
  if (Element.prototype.scrollIntoView) return
  Element.prototype.scrollIntoView = function scrollIntoView() {}
  restoreScrollIntoView = () => delete Element.prototype.scrollIntoView
})
afterAll(() => restoreScrollIntoView())

const items = Array.from({ length: 3 }, (_, index) => ({
  id: `prompt-${index}`,
  text: `Prompt ${index}`,
  slotIndex: index,
  hasImages: false
}))
const overflowItems = Array.from({ length: 20 }, (_, index) => ({
  id: `overflow-prompt-${index}`,
  text: `Overflow prompt ${index}`,
  slotIndex: index,
  hasImages: false
}))
const unloadedItems = [{ id: 'unloaded-prompt', text: 'Unloaded prompt', slotIndex: null, hasImages: false }, ...items]

async function flush(ticks = 4) {
  for (let tick = 0; tick < ticks; tick += 1) await nextTick()
}
async function waitFor(assertion, timeoutMs = 1000) {
  const started = Date.now()
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}
function button(name) {
  const found = Array.from(document.querySelectorAll('button')).find(
    (element) => (element.getAttribute('aria-label') ?? element.textContent).trim() === name
  )
  if (!found) throw new Error(`no button named ${name}`)
  return found
}
const trigger = () => button('Your messages')
const dialog = () => document.querySelector('[role="dialog"]')

async function hover(element) {
  element.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))
  await flush()
}
async function unhover(element) {
  element.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))
  await flush()
}
async function pressDown(element) {
  element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  element.focus()
  await flush()
}
async function release(element) {
  element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
  element.click()
  await flush()
}
async function click(element) {
  await pressDown(element)
  await release(element)
}
/** Enter on a focused button activates it. */
async function enter() {
  document.activeElement.click()
  await flush()
}
async function escape() {
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await flush()
}

function mountRail(props) {
  wrapper = mount(NativeChatMessageRail, {
    props: { scrollRef: document.createElement('div'), ...props },
    attachTo: document.body
  })
  return wrapper
}

/** Stands in for the transcript: an unloaded pick stays pending until settled. */
const PagingRail = defineComponent({
  setup(_props, { expose }) {
    const pendingId = ref(null)
    expose({ settle: () => (pendingId.value = null) })
    return () =>
      h(NativeChatMessageRail, {
        rail: { items: unloadedItems, ticks: unloadedItems, activeId: null, visible: true },
        scrollRef: document.createElement('div'),
        pendingId: pendingId.value,
        onSelect: (item) => (pendingId.value = item.slotIndex === null ? item.id : null)
      })
  }
})

describe('message rail interaction', () => {
  it('keeps the list open on an unloaded pick until its jump settles', async () => {
    wrapper = mount(PagingRail, { attachTo: document.body })
    await hover(trigger())
    expect(dialog()).not.toBeNull()

    await click(button('Unloaded prompt'))
    expect(dialog()).not.toBeNull()
    expect(button('Unloaded prompt').getAttribute('aria-busy')).toBe('true')

    wrapper.vm.settle()
    await waitFor(() => expect(dialog()).toBeNull())
  })

  it('closes a list held for a pending pick on Escape', async () => {
    wrapper = mount(PagingRail, { attachTo: document.body })
    await hover(trigger())
    expect(dialog()).not.toBeNull()
    await click(button('Unloaded prompt'))
    expect(dialog()).not.toBeNull()

    await escape()
    await waitFor(() => expect(dialog()).toBeNull())
  })

  it('opens from the keyboard, reaches prompts, jumps, and restores focus', async () => {
    const select = vi.fn()
    mountRail({
      rail: { items: overflowItems, ticks: overflowItems, activeId: overflowItems[12].id, visible: true },
      onSelect: select
    })
    trigger().focus()
    expect(document.activeElement).toBe(trigger())
    await enter()
    await waitFor(() => expect(document.activeElement).toBe(button('Overflow prompt 12')))
    await enter()
    expect(select).toHaveBeenCalledWith(overflowItems[12])
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
    expect(dialog()).toBeNull()
    await enter()
    await escape()
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
    expect(dialog()).toBeNull()
  })

  it('focuses the current prompt when a hover preview becomes interactive', async () => {
    mountRail({
      rail: { items: overflowItems, ticks: overflowItems, activeId: overflowItems[12].id, visible: true },
      onSelect: vi.fn()
    })
    await hover(trigger())
    expect(dialog()).not.toBeNull()
    trigger().click()
    await flush()
    expect(document.activeElement).toBe(button('Overflow prompt 12'))
  })

  it('focuses the first prompt on direct open when no prompt is current', async () => {
    mountRail({ rail: { items: overflowItems, ticks: overflowItems, activeId: null, visible: true }, onSelect: vi.fn() })
    trigger().focus()
    await enter()
    await waitFor(() => expect(document.activeElement).toBe(button('Overflow prompt 0')))
  })

  // The reference reopens content Radix still holds while its exit animation
  // runs; here the reopen comes right after the Escape, in the same frame.
  it('refocuses the current prompt when the list is reopened right after closing', async () => {
    mountRail({
      rail: { items: overflowItems, ticks: overflowItems, activeId: overflowItems[12].id, visible: true },
      onSelect: vi.fn()
    })
    trigger().focus()
    await enter()
    await escape()
    trigger().focus()
    trigger().click()
    await waitFor(() => expect(document.activeElement).toBe(button('Overflow prompt 12')))
  })

  it('preserves interactive focus when the current prompt changes', async () => {
    mountRail({
      rail: { items: overflowItems, ticks: overflowItems, activeId: overflowItems[12].id, visible: true },
      onSelect: vi.fn()
    })
    trigger().focus()
    await enter()
    const focusedPrompt = button('Overflow prompt 12')
    expect(document.activeElement).toBe(focusedPrompt)

    await wrapper.setProps({
      rail: { items: overflowItems, ticks: overflowItems, activeId: overflowItems[13].id, visible: true }
    })
    await flush()
    expect(document.activeElement).toBe(focusedPrompt)
  })

  it('keeps focus in the transcript while a hover preview opens and closes', async () => {
    const composer = document.createElement('input')
    composer.setAttribute('aria-label', 'Composer')
    document.body.append(composer)
    mountRail({ rail: { items, ticks: items, activeId: null, visible: true }, onSelect: vi.fn() })
    composer.focus()
    await hover(trigger())
    expect(dialog()).not.toBeNull()
    expect(document.activeElement).toBe(composer)
    await unhover(trigger())
    await waitFor(() => expect(dialog()).toBeNull())
    expect(document.activeElement).toBe(composer)
  })

  it.each([
    [0, 7],
    [1, 112],
    [2, 2800]
  ])('forwards wheel delta mode %i', async (deltaMode, expected) => {
    const element = document.createElement('div')
    Object.defineProperty(element, 'clientHeight', { value: 400 })
    mountRail({ rail: { items, ticks: items, activeId: null, visible: true }, scrollRef: element })
    trigger().dispatchEvent(new WheelEvent('wheel', { deltaY: 7, deltaMode, bubbles: true }))
    expect(element.scrollTop).toBe(expected)
    expect(wrapper.emitted('readerScroll')).toHaveLength(1)
  })

  it('renders nothing when the rail is not visible', () => {
    mountRail({ rail: { items, ticks: items, activeId: null, visible: false } })
    expect(document.querySelector('[data-native-chat-rail]')).toBeNull()
  })

  // jsdom has no layout, so these pin which row the panel scrolls to, not the
  // resulting offset.
  describe('opening position', () => {
    const scrolled = []
    let restoreIntoView = () => {}
    beforeEach(() => {
      scrolled.length = 0
      const had = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
      Element.prototype.scrollIntoView = vi.fn(function mockScrollIntoView() {
        scrolled.push(this)
      })
      restoreIntoView = () => Object.defineProperty(Element.prototype, 'scrollIntoView', had)
    })
    afterEach(() => restoreIntoView())

    it('scrolls the panel to the message the reader is on', async () => {
      mountRail({ rail: { items, ticks: items, activeId: items[2].id, visible: true }, onSelect: vi.fn() })
      await hover(trigger())
      expect(dialog()).not.toBeNull()
      expect(scrolled).toEqual([button('Prompt 2')])
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    })

    it('rechecks the current row when messages are inserted before it', async () => {
      mountRail({ rail: { items, ticks: items, activeId: items[2].id, visible: true }, onSelect: vi.fn() })
      await hover(trigger())
      scrolled.length = 0
      const shiftedItems = [
        { id: 'older-prompt', text: 'Older prompt', slotIndex: 0, hasImages: false },
        ...items.map((item) => ({ ...item, slotIndex: item.slotIndex + 1 }))
      ]
      await wrapper.setProps({ rail: { items: shiftedItems, ticks: shiftedItems, activeId: items[2].id, visible: true } })
      await flush()
      expect(scrolled).toEqual([button('Prompt 2')])
    })

    it('rechecks the current row when the same number of messages is reordered', async () => {
      mountRail({ rail: { items, ticks: items, activeId: items[2].id, visible: true }, onSelect: vi.fn() })
      await hover(trigger())
      scrolled.length = 0
      const reorderedItems = [items[2], items[0], items[1]]
      await wrapper.setProps({ rail: { items: reorderedItems, ticks: reorderedItems, activeId: items[2].id, visible: true } })
      await flush()
      expect(scrolled).toEqual([button('Prompt 2')])
    })

    // Pressing an item focuses it, which turns a hover preview interactive.
    // Scrolling the lit row into view then would move the list under the pointer
    // and lose the click.
    it('does not move the list or focus when a press makes a hover preview interactive', async () => {
      const select = vi.fn()
      mountRail({
        rail: { items: overflowItems, ticks: overflowItems, activeId: overflowItems[19].id, visible: true },
        onSelect: select
      })
      await hover(trigger())
      // Anti-vacuous: opening revealed the lit row.
      expect(scrolled).toEqual([button('Overflow prompt 19')])
      scrolled.length = 0

      const older = button('Overflow prompt 0')
      await pressDown(older)
      expect(scrolled).toEqual([])
      expect(document.activeElement).toBe(older)
      await release(older)
      expect(select).toHaveBeenCalledWith(overflowItems[0])
    })

    it('does not move the list while a picked message pages in', async () => {
      mountRail({ rail: { items, ticks: items, activeId: items[2].id, visible: true }, onSelect: vi.fn() })
      await hover(trigger())
      expect(scrolled).toEqual([button('Prompt 2')])
      scrolled.length = 0
      // A landed page gives every row a new slot while the pick is still pending.
      const pagedItems = items.map((item) => ({ ...item, slotIndex: item.slotIndex + 5 }))
      await wrapper.setProps({
        rail: { items: pagedItems, ticks: pagedItems, activeId: items[2].id, visible: true },
        pendingId: items[0].id
      })
      await flush()
      expect(scrolled).toEqual([])
    })

    it('reveals the lit row when the list opens from the keyboard', async () => {
      mountRail({
        rail: { items: overflowItems, ticks: overflowItems, activeId: overflowItems[12].id, visible: true },
        onSelect: vi.fn()
      })
      trigger().focus()
      await enter()
      const lit = button('Overflow prompt 12')
      await waitFor(() => expect(document.activeElement).toBe(lit))
      expect(scrolled).toContain(lit)
    })

    it('leaves the panel alone when no message is lit', async () => {
      mountRail({ rail: { items, ticks: items, activeId: null, visible: true }, onSelect: vi.fn() })
      await hover(trigger())
      expect(dialog()).not.toBeNull()
      expect(scrolled).toEqual([])
    })
  })
})

describe('message rail in a short pane', () => {
  it('shows only the ticks its height holds, spread out and with the current one', async () => {
    const prev = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(cb) {
        this.cb = cb
      }
      observe() {
        this.cb([{ contentRect: { height: 40 } }])
      }
      unobserve() {}
      disconnect() {}
    }
    try {
      mountRail({ rail: { items: overflowItems, ticks: overflowItems, activeId: overflowItems[12].id, visible: true }, onSelect: vi.fn() })
      await flush()
      const ticks = document.querySelectorAll('.nc-rail__tick')
      // 40 px holds 4 ticks (3 px each, 8 px apart), not 20.
      expect(ticks).toHaveLength(4)
      expect(document.querySelectorAll('.nc-rail__tick--active')).toHaveLength(1)
    } finally {
      globalThis.ResizeObserver = prev
    }
  })
})
