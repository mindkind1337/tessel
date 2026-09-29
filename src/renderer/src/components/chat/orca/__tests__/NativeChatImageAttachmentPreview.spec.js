// After Orca's NativeChatImageAttachmentPreview.test.tsx and the image case of
// native-chat-composer-autogrow.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, toValue } from 'vue'

const mocks = vi.hoisted(() => ({ calls: [], value: undefined }))
vi.mock('../native-chat-local-image-src.js', () => ({
  useLocalImageSrc: (src, path, connectionId) => {
    mocks.calls.push([toValue(src), toValue(path), toValue(connectionId)])
    return computed(() => {
      mocks.calls.push([toValue(src), toValue(path), toValue(connectionId)])
      return typeof mocks.value === 'function' ? mocks.value(toValue(src)) : mocks.value
    })
  }
}))

import NativeChatImageAttachmentPreview from '../NativeChatImageAttachmentPreview.vue'

let wrapper = null
beforeEach(() => {
  mocks.calls = []
  mocks.value = undefined
  vi.stubGlobal('IntersectionObserver', undefined)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function renderPreview(attachment) {
  wrapper = mount(NativeChatImageAttachmentPreview, {
    props: { attachment },
    attachTo: document.body,
    global: { stubs: { transition: false } }
  })
  return wrapper
}

describe('NativeChatImageAttachmentPreview', () => {
  it('shows the clipboard thumbnail and a spinner while pending', () => {
    renderPreview({ id: 'a1', path: '', previewUrl: 'blob:clipboard-1', pending: true })
    expect(document.querySelector('.nc-animate-spin')).toBeTruthy()
    const img = document.querySelector('img[alt="Saving pasted image…"]')
    expect(img.getAttribute('src')).toBe('blob:clipboard-1')
  })

  it('renders no spinner once the attachment has settled', () => {
    mocks.value = 'blob:on-disk-1'
    renderPreview({ id: 'a1', path: '/tmp/example.png' })
    expect(document.querySelector('.nc-animate-spin')).toBeFalsy()
  })

  it('does not read the on-disk file while the attachment is pending', () => {
    renderPreview({ id: 'a1', path: '', previewUrl: 'blob:clipboard-1', pending: true })
    expect(mocks.calls[0]).toEqual([undefined, '', undefined])
    expect(mocks.calls.every(([src]) => src === undefined)).toBe(true)
  })

  it('renders a thumbnail and opens a full-size preview when clicked', async () => {
    mocks.value = (src) => (src ? 'blob:attachment-preview' : undefined)
    renderPreview({ id: 'image-1', path: '/tmp/example.png' })
    await flushPromises()
    expect(document.querySelector('img[alt="example.png"]')).toBeTruthy()
    await wrapper.find('button[aria-label="View image: example.png"]').trigger('click')
    await flushPromises()
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog.textContent).toContain('example.png')
  })

  it('says the preview is unavailable when no image source exists', async () => {
    renderPreview({ id: 'image-1', path: 'C:\\shots\\a.png' })
    await wrapper.find('button[aria-label="View image: a.png"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[role="dialog"]').textContent).toContain('Preview unavailable')
  })

  it('removes by id', async () => {
    renderPreview({ id: 'image-1', path: '/tmp/example.png' })
    await wrapper.find('button[aria-label="Remove attachment"]').trigger('click')
    expect(wrapper.emitted('remove')[0]).toEqual(['image-1'])
  })
})
