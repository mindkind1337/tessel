// After Orca's NativeChatTranscriptChrome.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.),
// on NativeChatImageAttachments (+ ProviderFrameRow and NativeChatAgentControls).
// The reference loaded images through useLocalImageSrc's blob cache; Tessel's
// loader is native-chat-local-image-src.js, replaced here by a fake with the
// same contract (per-owner cache, invalidation) so the preview's own logic is
// what is tested.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const loader = vi.hoisted(() => ({ cache: new Map(), generation: null, sequence: 0, reads: 0 }))

vi.mock('../native-chat-local-image-src.js', async () => {
  const { computed, ref, toValue, watchEffect } = await import('vue')
  loader.generation = ref(0)
  return {
    useLocalImageSrc(src, filePath, _connectionId, runtimeContext) {
      const out = ref(undefined)
      watchEffect(() => {
        const raw = toValue(src)
        const context = toValue(runtimeContext)
        const generation = loader.generation.value
        if (!raw || !context) {
          out.value = undefined
          return
        }
        const key = `${context.worktreeId}\0${raw}\0${generation}`
        if (loader.cache.has(key)) {
          out.value = loader.cache.get(key)
          return
        }
        Promise.resolve().then(() => {
          loader.reads += 1
          const url = `data:image/png;base64,owner-${++loader.sequence}`
          loader.cache.set(key, url)
          out.value = url
        })
      })
      return computed(() => out.value)
    }
  }
})

import NativeChatImageAttachments from '../NativeChatImageAttachments.vue'
import ProviderFrameRow from '../ProviderFrameRow.vue'
import NativeChatAgentControls from '../NativeChatAgentControls.vue'

function runtimeContext(worktreeId) {
  return { worktreeId, worktreePath: `/repo/${worktreeId}` }
}

let wrapper = null
beforeEach(() => {
  loader.cache.clear()
  loader.generation.value = 0
  loader.sequence = 0
  loader.reads = 0
  vi.stubGlobal('IntersectionObserver', undefined)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
})

function mountImages(props) {
  wrapper = mount(NativeChatImageAttachments, { props, global: { stubs: { transition: false } } })
  return wrapper
}

describe('NativeChatImageAttachments', () => {
  it('pools visibility observation across image refs', async () => {
    class FakeIntersectionObserver {
      static instances = []
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
      constructor() {
        FakeIntersectionObserver.instances.push(this)
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

    mountImages({
      blocks: [
        { type: 'image-ref', path: '/repo/one.png' },
        { type: 'image-ref', path: '/repo/two.png' },
        { type: 'image-ref', path: '/repo/three.png' }
      ],
      runtimeContext: runtimeContext('wt-1')
    })
    await flushPromises()

    expect(FakeIntersectionObserver.instances).toHaveLength(1)
    expect(FakeIntersectionObserver.instances[0].observe).toHaveBeenCalledTimes(3)

    wrapper.unmount()
    wrapper = null
    expect(FakeIntersectionObserver.instances[0].unobserve).toHaveBeenCalledTimes(3)
    expect(FakeIntersectionObserver.instances[0].disconnect).toHaveBeenCalledOnce()
  })

  it('preserves same-image errors but retries when the runtime owner changes', async () => {
    const blocks = [{ type: 'image-ref', path: '/repo/image.png' }]
    const ownerOne = runtimeContext('wt-1')
    mountImages({ blocks, runtimeContext: ownerOne })
    await flushPromises()
    const firstOwnerSrc = wrapper.find('img').attributes('src')
    expect(firstOwnerSrc).toBe('data:image/png;base64,owner-1')

    await wrapper.find('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)

    await wrapper.setProps({ blocks, runtimeContext: ownerOne })
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)

    await wrapper.setProps({ blocks, runtimeContext: runtimeContext('wt-2') })
    await flushPromises()
    expect(wrapper.find('img').attributes('src')).not.toBe(firstOwnerSrc)
    expect(loader.reads).toBe(2)
  })

  it('retries a failed thumbnail after the image cache refreshes', async () => {
    mountImages({
      blocks: [{ type: 'image-ref', path: '/repo/image.png' }],
      runtimeContext: runtimeContext('wt-1')
    })
    await flushPromises()
    expect(wrapper.find('img').attributes('src')).toBe('data:image/png;base64,owner-1')

    await wrapper.find('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)

    loader.generation.value += 1
    await flushPromises()
    expect(wrapper.find('img').attributes('src')).toBe('data:image/png;base64,owner-2')
  })

  it('keeps the observed element stable while a preview is materialized', async () => {
    let callback
    class FakeIntersectionObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
      constructor(next) {
        callback = next
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

    mountImages({
      blocks: [{ type: 'image-ref', path: '/repo/image.png' }],
      runtimeContext: runtimeContext('wt-1')
    })
    await flushPromises()

    const observedElement = wrapper.element.firstElementChild
    expect(observedElement).not.toBeNull()
    expect(wrapper.find('img').exists()).toBe(false)
    callback([{ target: observedElement, isIntersecting: true }], {})
    await flushPromises()

    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.element.firstElementChild).toBe(observedElement)
  })

  it('shows name chips when previews are off, and nothing without images', () => {
    mountImages({
      blocks: [
        { type: 'text', text: 'hi' },
        { type: 'image-ref', path: 'C:\\shots\\orca-paste-1.png' },
        { type: 'image-ref', path: '/tmp/a.png', alt: 'Alt text' }
      ]
    })
    const chips = wrapper.findAll('.nc-image-chip')
    expect(chips.map((c) => c.text())).toEqual(['Pasted image', 'a.png'])
    expect(chips[1].attributes('title')).toBe('Alt text')
    expect(wrapper.find('img').exists()).toBe(false)
    wrapper.unmount()
    mountImages({ blocks: [{ type: 'text', text: 'hi' }] })
    expect(wrapper.find('.nc-image-attachments').exists()).toBe(false)
  })

  it('never fetches a remote image directly', async () => {
    mountImages({
      blocks: [{ type: 'image-ref', url: 'https://example.com/x.png' }],
      runtimeContext: null
    })
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.html()).not.toContain('src="https://example.com')
  })
})

describe('ProviderFrameRow', () => {
  const block = (extra = {}) => ({
    type: 'text',
    text: 'codex · notification:warning',
    providerFrame: {
      provider: 'codex',
      kind: 'notification:warning',
      payload: { head: '{"a":1}', byteLength: 9000, digest: 'd', truncated: true, ...extra }
    }
  })

  it('shows provider, derived summary, size when truncated; the payload as text', () => {
    wrapper = mount(ProviderFrameRow, { props: { block: block() } })
    const summary = wrapper.find('summary')
    expect(summary.text()).toContain('codex')
    expect(summary.text()).toContain('notification:warning')
    expect(summary.text()).toContain('9000 bytes')
    expect(wrapper.find('pre').element.textContent).toBe('{"a":1}\n…')
  })

  it('renders nothing without a provider frame', () => {
    wrapper = mount(ProviderFrameRow, { props: { block: { type: 'text', text: 'x' } } })
    expect(wrapper.find('details').exists()).toBe(false)
  })
})

describe('NativeChatAgentControls', () => {
  it('copy, scroll to top (emitted), time in that order', async () => {
    const prev = window.shellApi
    window.shellApi = { writeClipboard: vi.fn() }
    wrapper = mount(NativeChatAgentControls, { props: { markdown: 'md', timestamp: 0 } })
    const children = Array.from(wrapper.element.children).map(
      (e) => e.getAttribute('aria-label') ?? e.tagName
    )
    expect(children[0]).toBe('Copy message')
    expect(children[1]).toBe('Scroll this message to top')
    expect(wrapper.element.children[2].tagName).toBe('TIME')
    await wrapper.findAll('button')[1].trigger('click')
    expect(wrapper.emitted('scrollToTop')).toHaveLength(1)
    window.shellApi = prev
  })
})
