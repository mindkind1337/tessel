// A sent message's images on the window's side: names, the registry of shown
// images (blob:/data: made here, never a file path), the journal adapter's
// image blocks, and the message row's thumbnails (a chip after a reload).
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import {
  clearChatImagesForTests,
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
