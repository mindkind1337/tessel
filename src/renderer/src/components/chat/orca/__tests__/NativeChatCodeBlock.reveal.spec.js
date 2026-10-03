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
  it('a command that starts with a path is not a path; a path with spaces still is', () => {
    expect(codeBlockPath('/usr/bin/git status')).toBe('')
    expect(codeBlockPath('C:/tools/x.exe --flag')).toBe('')
    expect(codeBlockPath('/compact')).toBe('')
    expect(codeBlockPath('C:/Program Files/App/app.exe')).toBe('C:/Program Files/App/app.exe')
    expect(codeBlockPath('/home/me/My Files/a.png')).toBe('/home/me/My Files/a.png')
    expect(codeBlockPath('C:/Users/me/My Folder/')).toBe('C:/Users/me/My Folder/')
    expect(codeBlockPath('/home/me/notes')).toBe('/home/me/notes')
  })
  it('gets Show in Folder next to Copy', async () => {
    const reveal = vi.fn()
    window.shellApi = { chatFiles: { reveal }, writeClipboard: vi.fn() }
    const w = mount(NativeChatCodeBlock, { slots: { default: () => h('code', 'C:/Users/me/Downloads/livery.png') } })
    await w.find('[data-test="code-reveal"]').trigger('click')
    expect(reveal).toHaveBeenCalledWith('C:/Users/me/Downloads/livery.png')
    w.unmount()
  })
  it('a path Tessel cannot show is said in a toast', async () => {
    const toast = vi.fn()
    window.shellApi = { chatFiles: { reveal: vi.fn(async () => ({ ok: false, reason: 'missing' })) }, writeClipboard: vi.fn() }
    const w = mount(NativeChatCodeBlock, { slots: { default: () => h('code', 'C:/Users/me/gone.png') }, global: { provide: { panelCtx: { toast } } } })
    await w.find('[data-test="code-reveal"]').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('gone.png'), { kind: 'error' })
    w.unmount()
  })
  it('a command block has only Copy', () => {
    window.shellApi = { chatFiles: { reveal: vi.fn() }, writeClipboard: vi.fn() }
    const w = mount(NativeChatCodeBlock, { slots: { default: () => h('code', 'npm run build') } })
    expect(w.find('[data-test="code-reveal"]').exists()).toBe(false)
    w.unmount()
  })
})
