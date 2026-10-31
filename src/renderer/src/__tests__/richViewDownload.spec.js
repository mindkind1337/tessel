import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import RichView from '../components/RichView.vue'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
let wrapper
const previousApi = window.shellApi
afterEach(() => {
  wrapper?.unmount()
  window.shellApi = previousApi
  document.body.innerHTML = ''
})
async function setup(file, result = { ok: true }) {
  const download = vi.fn(async () => result)
  const imageSaveAs = vi.fn(async () => result)
  window.shellApi = { viewImage: async () => ({ ok: true, dataUrl: PNG }), explorer: { download }, chat: { imageSaveAs } }
  wrapper = mount(RichView, { props: { file, kind: 'image' }, attachTo: document.body, global: { stubs: { teleport: true } } })
  await flushPromises()
  await wrapper.get('img').trigger('contextmenu', { clientX: 200, clientY: 100 })
  return { download, imageSaveAs }
}
describe('image context download', () => {
  it.each(['ssh://ssh-box/srv/poster.png', 'lshare://p1/poster.png'])('downloads the original remote file %s', async (file) => {
    const { download, imageSaveAs } = await setup(file)
    await wrapper.get('[role="menuitem"]').trigger('click')
    await flushPromises()
    expect(download).toHaveBeenCalledWith(file)
    expect(imageSaveAs).not.toHaveBeenCalled()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(wrapper.get('[role="status"]').text()).toBe('File downloaded.')
  })
  it('offers Save as for a local image', async () => {
    const { download, imageSaveAs } = await setup('C:/pictures/poster.png')
    await wrapper.get('[role="menuitem"]').trigger('click')
    await flushPromises()
    expect(download).not.toHaveBeenCalled()
    expect(imageSaveAs).toHaveBeenCalledWith({ dataUrl: PNG, name: 'poster.png' })
  })
  it('canceling Save as leaves the image without an error or success notice', async () => {
    await setup('lshare://p1/poster.png', { ok: false, canceled: true })
    await wrapper.get('[role="menuitem"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.get('img').attributes('src')).toBe(PNG)
  })
  it('changing files closes a stale menu', async () => {
    const { download } = await setup('lshare://p1/poster.png')
    await wrapper.setProps({ file: 'lshare://p1/other.png' })
    await flushPromises()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(download).not.toHaveBeenCalled()
  })
  it('shows a download error while keeping the image visible', async () => {
    await setup('lshare://p1/poster.png', { ok: false, error: 'Access revoked' })
    await wrapper.get('[role="menuitem"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toBe('Access revoked')
    expect(wrapper.get('img').attributes('src')).toBe(PNG)
  })
})
