// Tessel: the chat view's media. A tool result's images on its card (thumbnails,
// a gone file, a host's file, "+N more", one viewer with ← / →), a pasted
// image's "[Image #N]" as a chip that opens it, a picture an answer names by
// its path shown inline (files:viewImage, size-capped; an SSH host's over its
// connection; nothing for a conversation from elsewhere), and a file dropped
// on the chat pane going to the composer's attach (an image as an image).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, provide } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import NativeChatToolLine from '../NativeChatToolLine.vue'
import NativeChatMessageRow from '../NativeChatMessageRow.vue'
import ChatMarkdown from '../ChatMarkdown.vue'
import NativeChatPaneFileDropSurface from '../NativeChatPaneFileDropSurface.vue'
import { clearLocalImageCacheForTests, localImageTarget, LOCAL_IMAGE_MAX_BYTES } from '../native-chat-local-image-src.js'
import { imageLabel, isNativeChatPastedImagePath } from '../native-chat-transcript-visibility.js'
import { createLinkRouter, setLinkRouter } from '../../../../links/openTarget.js'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QzwAEjDAGACCDAv8cI7IoAAAAAElFTkSuQmCC'

let wrapper = null
let prevApi
beforeEach(() => {
  prevApi = window.shellApi
  window.shellApi = {}
  // No observer: every image counts as near the viewport.
  vi.stubGlobal('IntersectionObserver', undefined)
  clearLocalImageCacheForTests()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  window.shellApi = prevApi
  vi.unstubAllGlobals()
  setLinkRouter(null)
  document.body.replaceChildren()
})

// Mounts `component` under the chat's file context (as the chat views provide it).
function mountIn(component, props, { context = null, localFiles = true } = {}) {
  const Host = defineComponent({
    setup() {
      provide('nativeChatFileLinkContext', context)
      provide('nativeChatLocalFiles', localFiles)
      return () => h(component, props)
    }
  })
  wrapper = mount(Host, { attachTo: document.body, global: { stubs: { transition: false } } })
  return wrapper
}

const call = { type: 'tool-call', name: 'Read', input: { file_path: 'shot.png' }, state: 'completed' }
function result(extra) {
  return { type: 'tool-result', output: '', ...extra }
}
const lightbox = () => document.querySelector('[data-test="chat-image-lightbox"]')

describe("a tool card's images", () => {
  it('shows thumbnails, a calm chip for a gone file and "+N more", no empty output box', async () => {
    mountIn(NativeChatToolLine, {
      block: call,
      result: result({
        images: [
          { type: 'image-ref', alt: 'one.png', url: PNG, source: 'tool' },
          { type: 'image-ref', alt: 'two.png', url: PNG2, source: 'tool' },
          { type: 'image-ref', alt: 'gone.png', path: 'C:\\tmp\\gone.png', missing: true, source: 'tool' }
        ],
        imagesMore: 2
      })
    })
    await flushPromises()
    const thumbs = wrapper.findAll('[data-test="nc-image-thumb"]')
    expect(thumbs.map((t) => t.find('img').attributes('src'))).toEqual([PNG, PNG2])
    expect(thumbs[0].find('img').attributes('decoding')).toBe('async')
    expect(wrapper.find('[data-test="nc-image-missing"]').text()).toBe('Image no longer on disk')
    expect(wrapper.find('[data-test="nc-image-more"]').text()).toBe('+2 more images')
    // The input's detail only: no box for an empty output.
    expect(wrapper.findAll('pre')).toHaveLength(1)
  })

  it('opens one viewer for them all, ← / → between them', async () => {
    mountIn(NativeChatToolLine, {
      block: call,
      result: result({
        output: 'Read 2 images',
        images: [
          { type: 'image-ref', alt: 'one.png', url: PNG },
          { type: 'image-ref', alt: 'two.png', url: PNG2 }
        ]
      })
    })
    await flushPromises()
    expect(wrapper.findAll('pre').at(-1).text()).toBe('Read 2 images')
    await wrapper.findAll('[data-test="nc-image-thumb"]')[1].trigger('click')
    await flushPromises()
    expect(lightbox().querySelector('img').getAttribute('src')).toBe(PNG2)
    expect(lightbox().querySelector('[data-test="chat-image-lightbox-count"]').textContent).toBe('2 of 2')
    lightbox().querySelector('[data-test="chat-image-lightbox-next"]').click()
    await flushPromises()
    expect(lightbox().querySelector('img').getAttribute('src')).toBe(PNG)
    lightbox().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await flushPromises()
    expect(lightbox().querySelector('img').getAttribute('src')).toBe(PNG2)
    for (const action of ['copy', 'save', 'tab']) expect(lightbox().querySelector(`[data-test="chat-image-lightbox-${action}"]`)).not.toBeNull()
  })

  it("reads a host's image over its connection in an SSH pane", async () => {
    const viewImage = vi.fn(async () => ({ ok: true, dataUrl: PNG }))
    window.shellApi = { viewImage }
    mountIn(
      NativeChatToolLine,
      { block: call, result: result({ images: [{ type: 'image-ref', alt: 'shot.png', path: '/home/me/app/shot.png', remote: true }] }) },
      { context: { remote: true, remoteRoot: 'ssh://ssh-box/home/me/app', worktreePath: 'ssh://ssh-box/home/me/app' } }
    )
    await flushPromises()
    expect(viewImage).toHaveBeenCalledWith('ssh://ssh-box/home/me/app/shot.png', { maxBytes: LOCAL_IMAGE_MAX_BYTES })
    expect(wrapper.find('[data-test="nc-image-thumb"] img').attributes('src')).toBe(PNG)
  })

  it('Open in a tab hands a copy of the image to the router as an editor tab', async () => {
    const imageViewCopy = vi.fn(async () => ({ ok: true, path: 'C:\\Temp\\tessel-chat-images\\abc.png' }))
    window.shellApi = { chat: { imageViewCopy } }
    const openInEditor = vi.fn(async () => true)
    setLinkRouter(createLinkRouter({ openInEditor }))
    mountIn(NativeChatToolLine, { block: call, result: result({ images: [{ type: 'image-ref', alt: 'one.png', url: PNG }] }) })
    await flushPromises()
    await wrapper.find('[data-test="nc-image-thumb"]').trigger('click')
    await flushPromises()
    lightbox().querySelector('[data-test="chat-image-lightbox-tab"]').click()
    await flushPromises()
    expect(imageViewCopy).toHaveBeenCalledWith({ dataUrl: PNG })
    expect(openInEditor).toHaveBeenCalledWith(expect.objectContaining({ file: 'C:\\Temp\\tessel-chat-images\\abc.png' }))
  })
})

describe('pasted images', () => {
  it('names Tessel\'s paste copies and the transcript\'s pasted source "Pasted image"', () => {
    expect(isNativeChatPastedImagePath('C:\\Users\\me\\AppData\\Local\\Temp\\tessel-paste\\chat\\img_0123456789abcdef01234567.png')).toBe(true)
    expect(isNativeChatPastedImagePath('C:\\Users\\me\\AppData\\Local\\Temp\\tessel-paste\\image-1712345678.png')).toBe(true)
    expect(isNativeChatPastedImagePath('C:\\shots\\orca-paste-1.png')).toBe(true)
    expect(isNativeChatPastedImagePath('C:\\repo\\img_0123456789abcdef01234567.png')).toBe(false)
    expect(imageLabel({ type: 'image-ref', alt: 'image.png', source: 'pasted' })).toBe('Pasted image')
    expect(imageLabel({ type: 'image-ref', alt: 'chart.png', source: 'tool' })).toBe('chart.png')
  })

  it('"[Image #N]" is a chip that opens that image', async () => {
    const message = {
      id: 'u1',
      role: 'user',
      blocks: [
        { type: 'image-ref', alt: 'image.png', url: PNG, source: 'pasted' },
        { type: 'image-ref', alt: 'image-2.png', url: PNG2, source: 'pasted' },
        { type: 'text', text: 'compare [Image #1] with [Image #2], keep `[Image #3]`' }
      ]
    }
    mountIn(NativeChatMessageRow, { message, runtimeContext: null })
    await flushPromises()
    const chips = wrapper.findAll('[data-test="cm-image-marker"]')
    expect(chips.map((c) => c.text())).toEqual(['Image #1', 'Image #2'])
    expect(wrapper.find('code').text()).toBe('[Image #3]')
    await chips[1].trigger('click')
    await flushPromises()
    expect(lightbox().querySelector('img').getAttribute('src')).toBe(PNG2)
  })

  it('leaves the words alone when the message shows no image', async () => {
    mountIn(NativeChatMessageRow, { message: { id: 'u2', role: 'user', blocks: [{ type: 'text', text: 'see [Image #1]' }] }, runtimeContext: null })
    await flushPromises()
    expect(wrapper.find('[data-test="cm-image-marker"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('[Image #1]')
  })
})

describe('pictures named by their path', () => {
  it('maps a path to what may be read, or nothing', () => {
    const local = { worktreePath: 'C:\\repo' }
    const ssh = { remote: true, remoteRoot: 'ssh://ssh-box/home/me/app', worktreePath: 'ssh://ssh-box/home/me/app' }
    expect(localImageTarget('C:\\shots\\a.png', null)).toBe('C:\\shots\\a.png')
    expect(localImageTarget('docs/a.png', local)).toBe('C:\\repo\\docs\\a.png')
    expect(localImageTarget('file:///C:/shots/a.png', null)).toBe('C:/shots/a.png')
    expect(localImageTarget('../a.png', local)).toBeNull()
    expect(localImageTarget('\\\\server\\share\\a.png', null)).toBeNull()
    expect(localImageTarget('https://example.com/a.png', local)).toBeNull()
    expect(localImageTarget('C:\\notes.txt', null)).toBeNull()
    expect(localImageTarget('C:\\shots\\a.png', null, { localFiles: false })).toBeNull()
    expect(localImageTarget('/home/me/x.png', ssh)).toBe('ssh://ssh-box/home/me/x.png')
    expect(localImageTarget('out/x.png', ssh)).toBe('ssh://ssh-box/home/me/app\\out\\x.png')
    expect(localImageTarget('C:\\shots\\a.png', ssh)).toBeNull()
  })

  it('shows one inline once read (size-capped), opening it in the viewer', async () => {
    const viewImage = vi.fn(async () => ({ ok: true, dataUrl: PNG }))
    window.shellApi = { viewImage }
    const showImage = vi.fn()
    setLinkRouter(createLinkRouter({ showImage }))
    mountIn(ChatMarkdown, { variant: 'document', content: 'Here: ![the chart](C:\\shots\\chart.png)', onLinkClick: vi.fn() }, { context: { worktreePath: 'C:\\repo' } })
    await flushPromises()
    expect(viewImage).toHaveBeenCalledWith('C:\\shots\\chart.png', { maxBytes: LOCAL_IMAGE_MAX_BYTES })
    const img = wrapper.find('[data-test="nc-md-local-image"] img')
    expect(img.attributes('src')).toBe(PNG)
    await wrapper.find('[data-test="nc-md-local-image"]').trigger('click')
    await flushPromises()
    expect(showImage).toHaveBeenCalledWith(expect.objectContaining({ src: PNG, title: 'the chart' }))
  })

  it('stays a link when it cannot be read, and reads nothing for a conversation from elsewhere', async () => {
    const viewImage = vi.fn(async () => ({ ok: false, error: 'too large' }))
    window.shellApi = { viewImage }
    mountIn(ChatMarkdown, { variant: 'document', content: '![big](C:\\shots\\big.png)' })
    await flushPromises()
    expect(wrapper.find('[data-test="nc-md-local-image"]').exists()).toBe(false)
    expect(wrapper.find('a').text()).toBe('big')
    wrapper.unmount()
    viewImage.mockClear()
    mountIn(ChatMarkdown, { variant: 'document', content: '![x](C:\\shots\\x.png)' }, { localFiles: false })
    await flushPromises()
    expect(viewImage).not.toHaveBeenCalled()
  })
})

describe('a file dropped on the chat pane', () => {
  it("goes to the composer's attach (an image becomes an attached image), not typed text", async () => {
    const attachResolvedPaths = vi.fn(() => true)
    const insertText = vi.fn()
    window.shellApi = { pathForFile: () => 'C:\\shots\\shot.png' }
    wrapper = mount(NativeChatPaneFileDropSurface, {
      props: { attachResolvedPaths, insertText, paneKey: 'p1' },
      slots: { default: '<textarea data-native-file-drop-target="composer"></textarea>' }
    })
    const file = { name: 'shot.png' }
    await wrapper.find('textarea').trigger('drop', { dataTransfer: { types: ['Files'], getData: () => '', files: [file], effectAllowed: 'copy' } })
    expect(attachResolvedPaths).toHaveBeenCalledWith(['C:\\shots\\shot.png'], undefined, expect.objectContaining({ files: [file] }))
    expect(insertText).not.toHaveBeenCalled()
  })
})
