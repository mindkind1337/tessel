import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import NativeChatContextMenu from '../NativeChatContextMenu.vue'
import { createNativeChatFileHref } from '../../../../chat/orca/shared/native-chat-href-routing.js'

let wrapper
let link
afterEach(() => {
  wrapper?.unmount()
  link?.remove()
  delete window.shellApi
})

async function rightClick(target) {
  wrapper.vm.onContextMenu({ preventDefault() {}, stopPropagation() {}, target, clientX: 10, clientY: 10 })
  await flushPromises()
}
const labels = () => [...document.querySelectorAll('[data-test="chat-context-menu"] [role="menuitem"]')].map((el) => el.textContent.trim())
const mountMenu = () =>
  mount(NativeChatContextMenu, {
    props: { rootEl: document.body, enabled: true, actions: {} },
    attachTo: document.body,
    global: { provide: { nativeChatFileLinkContext: { worktreePath: 'C:/proj' } } }
  })

describe('the chat right-click menu on a file link', () => {
  it('offers Show in Folder and Copy Path for the link under the pointer', async () => {
    const reveal = vi.fn(async () => ({ ok: true }))
    const writeClipboard = vi.fn()
    window.shellApi = { chatFiles: { reveal }, writeClipboard }
    wrapper = mountMenu()
    link = document.createElement('a')
    link.setAttribute('href', createNativeChatFileHref('C:/Users/me/Downloads/livery.png'))
    link.textContent = 'livery.png'
    document.body.appendChild(link)
    await rightClick(link)
    expect(labels().slice(0, 2)).toEqual(['Show in Folder', 'Copy Path'])
    document.querySelector('[data-test="chat-context-reveal"]').click()
    await flushPromises()
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal.mock.calls[0][0].replace(/\\/g, '/')).toBe('C:/Users/me/Downloads/livery.png')
  })

  it('elsewhere: no file items', async () => {
    window.shellApi = { chatFiles: { reveal: vi.fn() } }
    wrapper = mountMenu()
    await rightClick(document.body)
    expect(labels()).not.toContain('Show in Folder')
    expect(labels().length).toBeGreaterThan(0)
  })
})
