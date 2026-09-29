// Browser pages during Tessel's own drags (browser/webviewPassthrough.js):
// they let the pointer through while a drag runs, and every drag ends, even
// when its release is never seen (let go over a page, outside the window).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { acquirePassthrough, passthroughActive, registerWebview, trackPointerDrag } from '../browser/webviewPassthrough'
import SplitNode from '../components/SplitNode.vue'

function pointer(type, props = {}) {
  const e = new Event(type, { bubbles: true })
  Object.assign(e, props)
  return e
}

describe('webviewPassthrough', () => {
  const cleanups = []
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
    expect(passthroughActive()).toBe(false)
  })

  it('pages let the pointer through while any drag holds them, back when the last ends', () => {
    const a = document.createElement('webview')
    const off = registerWebview(a)
    cleanups.push(off)
    expect(a.style.pointerEvents).toBe('')
    const r1 = acquirePassthrough()
    const r2 = acquirePassthrough()
    expect(a.style.pointerEvents).toBe('none')
    // A page shown mid-drag follows at once.
    const b = document.createElement('webview')
    const offB = registerWebview(b)
    expect(b.style.pointerEvents).toBe('none')
    r1()
    r1()
    expect(a.style.pointerEvents).toBe('none')
    r2()
    expect(a.style.pointerEvents).toBe('')
    expect(b.style.pointerEvents).toBe('')
    offB()
  })

  it('a page taken away mid-drag gets its pointer back', () => {
    const a = document.createElement('webview')
    const off = registerWebview(a)
    const release = acquirePassthrough()
    off()
    expect(a.style.pointerEvents).toBe('')
    release()
  })

  for (const [name, end] of [
    ['the release', () => window.dispatchEvent(pointer('pointerup'))],
    ['a cancel', () => window.dispatchEvent(pointer('pointercancel'))],
    ['the window losing focus', () => window.dispatchEvent(new Event('blur'))],
    ['a mouse move with no button held (a release that was missed)', () => window.dispatchEvent(pointer('pointermove', { pointerType: 'mouse', buttons: 0 }))]
  ]) {
    it(`a drag ends on ${name}`, () => {
      const page = document.createElement('webview')
      cleanups.push(registerWebview(page))
      const handle = document.createElement('div')
      handle.setPointerCapture = vi.fn()
      handle.releasePointerCapture = vi.fn()
      handle.hasPointerCapture = vi.fn(() => true)
      const onMove = vi.fn()
      const onEnd = vi.fn()
      trackPointerDrag({ currentTarget: handle, pointerId: 3 }, { onMove, onEnd })
      expect(handle.setPointerCapture).toHaveBeenCalledWith(3)
      expect(page.style.pointerEvents).toBe('none')
      window.dispatchEvent(pointer('pointermove', { pointerType: 'mouse', buttons: 1, clientX: 5 }))
      expect(onMove).toHaveBeenCalledTimes(1)
      end()
      expect(onEnd).toHaveBeenCalledTimes(1)
      expect(handle.releasePointerCapture).toHaveBeenCalledWith(3)
      expect(page.style.pointerEvents).toBe('')
      // Nothing after the end.
      window.dispatchEvent(pointer('pointermove', { pointerType: 'mouse', buttons: 1 }))
      window.dispatchEvent(pointer('pointerup'))
      expect(onMove).toHaveBeenCalledTimes(1)
      expect(onEnd).toHaveBeenCalledTimes(1)
    })
  }

  it('the returned function ends a drag now; a handle that cannot capture still works', () => {
    const handle = document.createElement('div')
    handle.setPointerCapture = () => {
      throw new Error('no')
    }
    const onEnd = vi.fn()
    const stop = trackPointerDrag({ currentTarget: handle, pointerId: 1 }, { onEnd })
    expect(passthroughActive()).toBe(true)
    stop()
    stop()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
})

describe('SplitNode divider drag', () => {
  // A split of two empty splits: only the divider matters here.
  const emptySplit = (id) => reactive({ type: 'split', id, dir: 'row', sizes: [], children: [] })

  it('resizes, lets the pages through while dragging, and a cancelled drag ends (no stuck resize)', async () => {
    const page = document.createElement('webview')
    const off = registerWebview(page)
    const node = reactive({ type: 'split', id: 's', dir: 'row', sizes: [50, 50], children: [emptySplit('a'), emptySplit('b')] })
    const wrapper = mount(SplitNode, { props: { node }, attachTo: document.body })
    const container = wrapper.find('.split').element
    container.getBoundingClientRect = () => ({ width: 1000, height: 600, left: 0, top: 0, right: 1000, bottom: 600 })
    const divider = wrapper.find('.divider')
    divider.element.setPointerCapture = vi.fn()
    divider.element.dispatchEvent(pointer('pointerdown', { clientX: 500, clientY: 10, pointerId: 1, pointerType: 'mouse', buttons: 1 }))
    await wrapper.vm.$nextTick()
    expect(divider.classes()).toContain('dragging')
    expect(page.style.pointerEvents).toBe('none')
    window.dispatchEvent(pointer('pointermove', { pointerType: 'mouse', buttons: 1, clientX: 600, clientY: 10 }))
    expect(node.sizes[0]).toBeCloseTo(60)
    expect(node.sizes[1]).toBeCloseTo(40)

    window.dispatchEvent(pointer('pointercancel'))
    await wrapper.vm.$nextTick()
    expect(divider.classes()).not.toContain('dragging')
    expect(page.style.pointerEvents).toBe('')
    // The pointer moving on afterwards resizes nothing.
    window.dispatchEvent(pointer('pointermove', { pointerType: 'mouse', buttons: 0, clientX: 800, clientY: 10 }))
    expect(node.sizes[0]).toBeCloseTo(60)
    wrapper.unmount()
    off()
  })
})
