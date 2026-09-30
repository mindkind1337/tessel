// After Orca's NativeChatImageAttachmentPreview.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
// Tessel's chip: a tiny thumbnail, the name, the pixel size, × to remove; a
// click opens the full image in a popup (never from a file path).
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import NativeChatImageAttachmentPreview from '../NativeChatImageAttachmentPreview.vue'

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

function renderPreview(attachment) {
  wrapper = mount(NativeChatImageAttachmentPreview, {
    props: { attachment },
    attachTo: document.body
  })
  return wrapper
}
const lightbox = () => document.querySelector('[data-test="chat-image-lightbox"]')

describe('NativeChatImageAttachmentPreview', () => {
  it('shows a spinner while the image is saved, then the thumbnail, the name and the pixel size', async () => {
    renderPreview({ id: 'a1', name: 'image.png', previewUrl: 'blob:clipboard-1', pending: true })
    expect(document.querySelector('.nc-animate-spin')).toBeTruthy()
    expect(document.querySelector('button[aria-label="Saving pasted image…"]').disabled).toBe(true)
    await wrapper.setProps({
      attachment: { id: 'a1', imageId: 'img_1', name: 'image.png', width: 688, height: 478, previewUrl: 'data:image/png;base64,AAAA', fullUrl: 'blob:full-1' }
    })
    expect(document.querySelector('.nc-animate-spin')).toBeNull()
    expect(document.querySelector('.nc-attachment-img').getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(wrapper.find('[data-test="chat-attachment-name"]').text()).toBe('image.png')
    expect(wrapper.find('[data-test="chat-attachment-size"]').text()).toBe('688×478')
  })

  it('opens the full image in a popup and closes it with Esc, focus back on the chip', async () => {
    renderPreview({ id: 'a1', name: 'shot.png', width: 10, height: 10, previewUrl: 'data:image/png;base64,AAAA', fullUrl: 'blob:full-1' })
    const chip = document.querySelector('button[aria-label="View image: shot.png"]')
    chip.focus()
    chip.click()
    await flushPromises()
    expect(lightbox()).toBeTruthy()
    expect(lightbox().querySelector('img').getAttribute('src')).toBe('blob:full-1')
    expect(lightbox().contains(document.activeElement)).toBe(true)
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(lightbox()).toBeNull()
    expect(document.activeElement).toBe(chip)
  })

  it('closes with the round ×', async () => {
    renderPreview({ id: 'a1', name: 'shot.png', fullUrl: 'blob:full-1' })
    document.querySelector('button[aria-label="View image: shot.png"]').click()
    await flushPromises()
    const close = document.querySelector('[data-test="chat-image-lightbox-close"]')
    expect(close.getAttribute('aria-label')).toBe('Close image preview')
    close.click()
    await flushPromises()
    expect(lightbox()).toBeNull()
  })

  it('never shows a file path as an image', async () => {
    renderPreview({ id: 'a1', name: 'x.png', previewUrl: 'file:///C:/x.png', fullUrl: 'C:\\x.png' })
    expect(document.querySelector('.nc-attachment-img')).toBeNull()
    document.querySelector('button[aria-label="View image: x.png"]').click()
    await flushPromises()
    expect(lightbox().querySelector('img')).toBeNull()
    expect(lightbox().textContent).toContain('Preview unavailable')
  })

  it('removes by id', async () => {
    renderPreview({ id: 'a1', name: 'shot.png' })
    await wrapper.find('[data-test="chat-attachment-remove"]').trigger('click')
    expect(wrapper.emitted('remove')).toEqual([['a1']])
  })
})
