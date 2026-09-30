// A sent message's images on the window's side: names, the registry of shown
// images (blob:/data: made here, never a file path), the journal adapter's
// image blocks, and the message row's thumbnails (a chip after a reload).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nativeChatRowRendersContent } from '../shared/native-chat-row-content.js'
import {
  clearChatImagesForTests,
  fileRefBlocks,
  fileSizeLabel,
  fullImageUrlFor,
  imagePixelSize,
  imageRefBlocks,
  nextPastedImageName,
  registerChatImage
} from '../native-chat-images.js'
import { createJournalAdapter } from '../adapter/journalAdapter'
import { reduceStructuredAgentSession, EMPTY_STRUCTURED_AGENT_SESSION } from '../shared/structured-agent-session-reducer.js'
import { projectStructuredAgentSessionMessages } from '../structured-agent-session-message-projection.js'
import NativeChatImageAttachments from '../../../components/chat/orca/NativeChatImageAttachments.vue'

afterEach(() => {
  clearChatImagesForTests()
  document.body.replaceChildren()
})

function userMessage(event) {
  const adapter = createJournalAdapter({ now: () => 1000 })
  let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, { type: 'event', event: adapter.snapshotEvent() }, 1000)
  const out = adapter.apply(event)
  if (out) state = reduceStructuredAgentSession(state, { type: 'event', event: out }, 1000)
  return projectStructuredAgentSessionMessages(state.items, [], state.submissions).find((m) => m.role === 'user')
}

describe('chat images (window side)', () => {
  it('names pasted images image.png, image-2.png… and shows a pixel size', () => {
    expect(nextPastedImageName([])).toBe('image.png')
    expect(nextPastedImageName(['image.png'])).toBe('image-2.png')
    expect(nextPastedImageName(['image.png', 'image-2.png', 'a.png'])).toBe('image-3.png')
    expect(nextPastedImageName(['image.jpg'], 'jpg')).toBe('image-2.jpg')
    expect(imagePixelSize(688, 478)).toBe('688×478')
    expect(imagePixelSize(0, 0)).toBe('')
  })

  it('a live message shows its thumbnails; a reloaded one names its images', () => {
    registerChatImage('img_a', { fullUrl: 'blob:full-a', thumbUrl: 'data:image/png;base64,AAAA', name: 'image.png', width: 688, height: 478 })
    const event = {
      type: 'user',
      id: 'u1',
      text: 'look',
      origin: 'user',
      status: 'sent',
      images: [
        { id: 'img_a', name: 'image.png', width: 688, height: 478 },
        { id: 'img_gone', name: 'shot.webp', width: 20, height: 10 }
      ]
    }
    const live = userMessage(event)
    expect(live.blocks).toEqual([
      { type: 'image-ref', alt: 'image.png', url: 'data:image/png;base64,AAAA' },
      { type: 'image-ref', alt: 'shot.webp' },
      { type: 'text', text: 'look' }
    ])
    expect(fullImageUrlFor('data:image/png;base64,AAAA')).toBe('blob:full-a')
    // Images only: no empty text block.
    expect(userMessage({ ...event, text: '' }).blocks.map((b) => b.type)).toEqual(['image-ref', 'image-ref'])
    // A teammate's message never carries images.
    expect(userMessage({ ...event, origin: 'team' }).blocks.map((b) => b.type)).toEqual(['text'])
    clearChatImagesForTests()
    expect(imageRefBlocks(event.images)).toEqual([
      { type: 'image-ref', alt: 'image.png' },
      { type: 'image-ref', alt: 'shot.webp' }
    ])
  })

  it('the message row shows a thumbnail that opens the full image, and a chip for the rest', async () => {
    registerChatImage('img_a', { fullUrl: 'blob:full-a', thumbUrl: 'data:image/png;base64,AAAA', name: 'image.png' })
    const blocks = imageRefBlocks([
      { id: 'img_a', name: 'image.png' },
      { id: 'img_b', name: 'old.png' }
    ])
    const wrapper = mount(NativeChatImageAttachments, { props: { blocks }, attachTo: document.body })
    await flushPromises()
    const thumb = wrapper.find('button[aria-label="View image: image.png"]')
    expect(thumb.find('img').attributes('src')).toBe('data:image/png;base64,AAAA')
    expect(wrapper.find('[data-test="nc-image-chip"]').text()).toBe('old.png')
    await thumb.trigger('click')
    await flushPromises()
    const box = document.querySelector('[data-test="chat-image-lightbox"]')
    expect(box.querySelector('img').getAttribute('src')).toBe('blob:full-a')
    wrapper.unmount()
  })
})

describe('earlier-history messages (images and files read from the agent)', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const history = {
    type: 'user',
    id: 'hist-u1',
    text: 'look\n[image]',
    origin: 'user',
    status: 'accepted',
    imported: true,
    images: [
      { name: 'image.png', mediaType: 'image/png', dataUrl: PNG },
      // Anything but a base64 image data: URL is never shown.
      { name: 'evil.svg', mediaType: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
      { name: 'remote.png', dataUrl: 'https://example.invalid/x.png' }
    ],
    files: [
      { name: 'report.pdf', mediaType: 'application/pdf', size: 2048, path: 'C:\\proj\\report.pdf' },
      { name: 'inline.txt', mediaType: 'text/plain', size: 5 }
    ]
  }

  it('the adapter gives its images and file chips, the "[image]" text kept for the rest', () => {
    const message = userMessage(history)
    expect(message.blocks).toEqual([
      { type: 'image-ref', alt: 'image.png', url: PNG },
      { type: 'image-ref', alt: 'evil.svg' },
      { type: 'image-ref', alt: 'remote.png' },
      { type: 'file-ref', name: 'report.pdf', mediaType: 'application/pdf', size: 2048, path: 'C:\\proj\\report.pdf' },
      { type: 'file-ref', name: 'inline.txt', mediaType: 'text/plain', size: 5 },
      { type: 'text', text: 'look\n[image]' }
    ])
  })

  it('shows the thumbnail (opens the lightbox) and file chips (a local one opens with the system)', async () => {
    const openFile = vi.fn(async () => ({ ok: true }))
    window.shellApi = { openFile }
    try {
      const blocks = userMessage(history).blocks.filter((b) => b.type !== 'text')
      const wrapper = mount(NativeChatImageAttachments, { props: { blocks }, attachTo: document.body })
      await flushPromises()
      const thumb = wrapper.find('button[aria-label="View image: image.png"]')
      expect(thumb.find('img').attributes('src')).toBe(PNG)
      expect(wrapper.findAll('[data-test="nc-image-chip"]').map((c) => c.text())).toEqual(['evil.svg', 'remote.png'])
      await thumb.trigger('click')
      await flushPromises()
      const box = document.querySelector('[data-test="chat-image-lightbox"]')
      expect(box.querySelector('img').getAttribute('src')).toBe(PNG)
      const chips = wrapper.findAll('[data-test="nc-file-chip"]')
      expect(chips.map((c) => c.text())).toEqual(['report.pdf2 KB', 'inline.txt5 B'])
      expect(chips[0].element.tagName).toBe('BUTTON')
      expect(chips[1].element.tagName).toBe('DIV')
      await chips[0].trigger('click')
      expect(openFile).toHaveBeenCalledWith({ file: 'C:\\proj\\report.pdf' })
      wrapper.unmount()
    } finally {
      delete window.shellApi
    }
  })

  it('a history message with only files still renders', () => {
    const message = userMessage({ ...history, text: '', images: [] })
    expect(message.blocks.map((b) => b.type)).toEqual(['file-ref', 'file-ref'])
    expect(nativeChatRowRendersContent(message.blocks)).toBe(true)
  })

  it('sizes read as B, KB, MB', () => {
    expect(fileSizeLabel(5)).toBe('5 B')
    expect(fileSizeLabel(2048)).toBe('2 KB')
    expect(fileSizeLabel(3.5 * 1024 * 1024)).toBe('3.5 MB')
    expect(fileSizeLabel(undefined)).toBe('')
    expect(fileRefBlocks([{ name: 'x', path: 'a\u0000b', size: -1 }])).toEqual([{ type: 'file-ref', name: 'x' }])
  })
})
