// Port of Orca's components/ui/popover-wheel-scroll.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.).
// Vue listeners are native (not React's passive delegated synthetic events),
// so a consumer's event.preventDefault() is the real one: the three
// "consumer / capture / descendant cancellation" cases check that the shim
// then leaves the scroller alone. The React ref-callback cases become the
// exposed element and the listener's removal on unmount.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config, mount } from '@vue/test-utils'
import { h, ref } from 'vue'
import Popover from '../ui/Popover.vue'
import PopoverContent from '../ui/PopoverContent.vue'
import PopoverTrigger from '../ui/PopoverTrigger.vue'

// Real <Transition>: the stub would wrap the teleported content in an element.
config.global.stubs.transition = false

let wrapper = null

/** jsdom reports 0 for layout, so scroll geometry has to be defined per element. */
function makeScrollable(el, scrollHeight, clientHeight) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
}

function wheel(el, deltaY) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
  el.dispatchEvent(event)
  return event
}

function renderPopover(contentClass, nested, { onWheel, onWheelCapture, innerOnWheel, contentRef, portalContainer } = {}) {
  const inner = () => h('div', { 'data-testid': 'inner', onWheel: innerOnWheel }, 'tall')
  wrapper = mount(
    {
      setup() {
        return () =>
          h(Popover, { open: true }, () => [
            h(PopoverTrigger, null, () => 'open'),
            h(
              PopoverContent,
              {
                class: contentClass,
                onWheel,
                onWheelCapture,
                ref: contentRef,
                portalContainer
              },
              () =>
                nested ? h('div', { 'data-testid': 'viewport', style: { overflowY: 'auto' } }, [inner()]) : inner()
            )
          ])
      }
    },
    { attachTo: document.body }
  )
}

const q = (selector) => document.querySelector(selector)

describe('PopoverContent wheel shim', () => {
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  it('scrolls a nested viewport when the content itself cannot scroll', () => {
    // The workspace-cleanup Filters panel: a flex column whose PopoverContent is
    // overflow-hidden, with a ScrollArea viewport above a pinned footer.
    renderPopover('popover-scroll-content', true)
    const content = q('[data-slot="popover-content"]')
    const viewport = q('[data-testid="viewport"]')
    makeScrollable(content, 800, 400)
    makeScrollable(viewport, 1000, 400)

    const event = wheel(q('[data-testid="inner"]'), 120)

    expect(viewport.scrollTop).toBe(120)
    expect(content.scrollTop).toBe(0)
    expect(event.defaultPrevented).toBe(true)
  })

  it('still scrolls the content itself when it is the scroller', () => {
    renderPopover('popover-scroll-content', false)
    const content = q('[data-slot="popover-content"]')
    // Inline because jsdom does not apply the stylesheet; in the app
    // `.popover-scroll-content` already sets `overflow-y: auto`.
    content.style.overflowY = 'auto'
    makeScrollable(content, 1000, 400)

    const event = wheel(q('[data-testid="inner"]'), 120)

    expect(content.scrollTop).toBe(120)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves popovers that did not opt in alone', () => {
    renderPopover('', true)
    const viewport = q('[data-testid="viewport"]')
    makeScrollable(viewport, 1000, 400)

    const event = wheel(q('[data-testid="inner"]'), 120)

    expect(viewport.scrollTop).toBe(0)
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores vertically clipped elements and horizontal-only scrollers', () => {
    renderPopover('popover-scroll-content', true)
    const content = q('[data-slot="popover-content"]')
    const viewport = q('[data-testid="viewport"]')
    content.style.overflowY = 'hidden'
    viewport.style.overflowY = 'hidden'
    viewport.style.overflowX = 'auto'
    makeScrollable(content, 1000, 400)
    makeScrollable(viewport, 1000, 400)
    Object.defineProperty(viewport, 'scrollWidth', { value: 1000, configurable: true })
    Object.defineProperty(viewport, 'clientWidth', { value: 400, configurable: true })

    const event = wheel(q('[data-testid="inner"]'), 120)

    expect(content.scrollTop).toBe(0)
    expect(viewport.scrollTop).toBe(0)
    expect(event.defaultPrevented).toBe(false)
  })

  it('does nothing when no element in the target chain can scroll', () => {
    renderPopover('popover-scroll-content', true)
    const content = q('[data-slot="popover-content"]')
    const viewport = q('[data-testid="viewport"]')
    content.style.overflowY = 'hidden'
    viewport.style.overflowY = 'hidden'
    makeScrollable(content, 1000, 400)
    makeScrollable(viewport, 1000, 400)

    const event = wheel(q('[data-testid="inner"]'), 120)

    expect(content.scrollTop).toBe(0)
    expect(viewport.scrollTop).toBe(0)
    expect(event.defaultPrevented).toBe(false)
  })

  it('runs for the shim-only marker, which carries no styling', () => {
    // The workspace-cleanup Filters panel needs the wheel shim but must NOT inherit
    // `.popover-scroll-content`'s 15rem max-height, which would crush its 471px column.
    renderPopover('popover-wheel-scroll', true)
    const content = q('[data-slot="popover-content"]')
    const viewport = q('[data-testid="viewport"]')
    viewport.style.overflowY = 'auto'
    makeScrollable(content, 400, 400)
    makeScrollable(viewport, 1000, 400)

    const event = wheel(q('[data-testid="inner"]'), 120)

    expect(viewport.scrollTop).toBe(120)
    expect(event.defaultPrevented).toBe(true)
  })

  it('lets a consumer prevent the shim scroll', () => {
    const onWheel = vi.fn((event) => event.preventDefault())
    const portalContainer = document.createElement('div')
    document.body.appendChild(portalContainer)
    renderPopover('popover-wheel-scroll', true, { onWheel, portalContainer })
    const viewport = q('[data-testid="viewport"]')
    viewport.style.overflowY = 'auto'
    makeScrollable(viewport, 1000, 400)

    const event = wheel(q('[data-testid="inner"]'), 120)

    expect(onWheel).toHaveBeenCalledOnce()
    expect(portalContainer.querySelector('[data-slot="popover-content"]')).not.toBeNull()
    expect(event.defaultPrevented).toBe(true)
    expect(viewport.scrollTop).toBe(0)
  })

  it('respects consumer capture cancellation', () => {
    const onWheelCapture = vi.fn((event) => event.preventDefault())
    renderPopover('popover-wheel-scroll', true, { onWheelCapture })
    const viewport = q('[data-testid="viewport"]')
    viewport.style.overflowY = 'auto'
    makeScrollable(viewport, 1000, 400)

    wheel(q('[data-testid="inner"]'), 120)

    expect(onWheelCapture).toHaveBeenCalledOnce()
    expect(viewport.scrollTop).toBe(0)
  })

  it('respects descendant cancellation', () => {
    const innerOnWheel = vi.fn((event) => event.preventDefault())
    renderPopover('popover-wheel-scroll', true, { innerOnWheel })
    const viewport = q('[data-testid="viewport"]')
    viewport.style.overflowY = 'auto'
    makeScrollable(viewport, 1000, 400)

    wheel(q('[data-testid="inner"]'), 120)

    expect(innerOnWheel).toHaveBeenCalledOnce()
    expect(viewport.scrollTop).toBe(0)
  })

  it('exposes the content element', () => {
    const contentRef = ref(null)
    renderPopover('', false, { contentRef })
    expect(contentRef.value.el).toBe(q('[data-slot="popover-content"]'))
  })

  it('removes the wheel listener on unmount', () => {
    const remove = vi.spyOn(document.body, 'removeEventListener')
    renderPopover('popover-wheel-scroll', false)
    wrapper.unmount()
    wrapper = null
    expect(remove.mock.calls.some(([type]) => type === 'wheel')).toBe(true)
    remove.mockRestore()
  })
})
