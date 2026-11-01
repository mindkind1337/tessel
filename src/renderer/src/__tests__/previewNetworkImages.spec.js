import { it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import RichView from '../components/RichView.vue'
import FileViewer from '../components/FileViewer.vue'
import HtmlView from '../components/HtmlView.vue'
import { renderMarkdown } from '../markdownView'

it('does not read a network image merely by rendering Markdown from disk', async () => {
  const previous = window.shellApi
  window.shellApi = { viewImage: vi.fn(async () => ({ ok: false })) }
  const wrapper = mount(RichView, { props: { file: 'C:\\docs\\README.md', kind: 'markdown', text: '<img src="\\\\host.invalid\\share\\pixel.png">' } })
  try {
    await flushPromises()
    expect(window.shellApi.viewImage).not.toHaveBeenCalled()
  } finally { wrapper.unmount(); window.shellApi = previous }
})

it('does not read a network image in the standalone file viewer', async () => {
  const previous = window.shellApi
  window.shellApi = { viewImage: vi.fn(), viewFile: async () => ({ ok: true, kind: 'markdown', text: '<img src="\\\\host.invalid\\share\\pixel.png">' }) }
  const wrapper = mount(FileViewer, { props: { file: 'C:\\docs\\README.md' } })
  try { await flushPromises(); expect(window.shellApi.viewImage).not.toHaveBeenCalled() }
  finally { wrapper.unmount(); window.shellApi = previous }
})

it('does not read a network image in the static HTML fallback', async () => {
  const previous = window.shellApi
  window.shellApi = { viewImage: vi.fn(), previewUrl: async () => ({ ok: false }) }
  const wrapper = mount(HtmlView, { props: { file: 'C:\\docs\\index.html', text: '<p>fallback</p>' } })
  try {
    await flushPromises()
    const frame = wrapper.get('iframe')
    const doc = new DOMParser().parseFromString('<img data-local-src="\\\\host.invalid\\share\\pixel.png">', 'text/html')
    Object.defineProperty(frame.element, 'contentDocument', { value: doc, configurable: true })
    await frame.trigger('load')
    expect(window.shellApi.viewImage).not.toHaveBeenCalled()
  } finally { wrapper.unmount(); window.shellApi = previous }
})

it('removes alternate automatic resource channels from raw Markdown HTML', () => {
  const html = renderMarkdown('<img srcset="file://host.invalid/share/x.png 2x"><video src="file://host.invalid/share/v.mp4" poster="file://host.invalid/share/p.png"><source src="https://host.invalid/v.mp4"></video><audio src="file://host.invalid/share/a.mp3"></audio><table background="file://host.invalid/share/b.png"><tr><td style="background:url(https://host.invalid/x)">text</td></tr></table><svg><image href="https://host.invalid/x" /></svg>')
  const doc = new DOMParser().parseFromString(html, 'text/html')
  expect(doc.querySelector('[srcset], [src], [poster], [background], [style], image[href]')).toBeNull()
})
