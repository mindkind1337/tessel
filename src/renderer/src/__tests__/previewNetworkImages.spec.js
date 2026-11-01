import { it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import RichView from '../components/RichView.vue'

it('does not read a network image merely by rendering Markdown from disk', async () => {
  const previous = window.shellApi
  window.shellApi = { viewImage: vi.fn(async () => ({ ok: false })) }
  const wrapper = mount(RichView, { props: { file: 'C:\\docs\\README.md', kind: 'markdown', text: '<img src="\\\\host.invalid\\share\\pixel.png">' } })
  try {
    await flushPromises()
    expect(window.shellApi.viewImage).not.toHaveBeenCalled()
  } finally { wrapper.unmount(); window.shellApi = previous }
})
