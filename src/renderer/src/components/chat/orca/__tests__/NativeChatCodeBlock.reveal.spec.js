import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { mount } from '@vue/test-utils'
import NativeChatCodeBlock, { codeBlockPath } from '../NativeChatCodeBlock.vue'

afterEach(() => {
  delete window.shellApi
})

describe('a code block that is a path', () => {
  it('is recognised only when the whole block is one local path', () => {
    expect(codeBlockPath('C:/Users/me/Downloads/livery.png')).toBe('C:/Users/me/Downloads/livery.png')
    expect(codeBlockPath('  /home/me/a.png \n')).toBe('/home/me/a.png')
    expect(codeBlockPath('npm run build')).toBe('')
    expect(codeBlockPath('C:/a.png\nC:/b.png')).toBe('')
    expect(codeBlockPath('//server/share/a.png')).toBe('')
  })
  it('gets Show in Folder next to Copy', async () => {
    const reveal = vi.fn()
    window.shellApi = { chatFiles: { reveal }, writeClipboard: vi.fn() }
    const w = mount(NativeChatCodeBlock, { slots: { default: () => h('code', 'C:/Users/me/Downloads/livery.png') } })
    await w.find('[data-test="code-reveal"]').trigger('click')
    expect(reveal).toHaveBeenCalledWith('C:/Users/me/Downloads/livery.png')
    w.unmount()
  })
  it('a command block has only Copy', () => {
    window.shellApi = { chatFiles: { reveal: vi.fn() }, writeClipboard: vi.fn() }
    const w = mount(NativeChatCodeBlock, { slots: { default: () => h('code', 'npm run build') } })
    expect(w.find('[data-test="code-reveal"]').exists()).toBe(false)
    w.unmount()
  })
})
