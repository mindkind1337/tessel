import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { it, expect, vi } from 'vitest'
import BrowserDownloads from '../components/BrowserDownloads.vue'

it('shows progress and the saved path, scopes events and cleans up its listener', async () => {
  let event
  const off = vi.fn()
  window.shellApi = { browser: {
    downloads: vi.fn(async () => []),
    onDownloadChanged: vi.fn((fn) => { event = fn; return off }),
    cancelDownload: vi.fn(), revealDownload: vi.fn()
  } }
  const wrapper = mount(BrowserDownloads, { props: { guestId: 7 } })
  await nextTick()
  const row = { id: 'a', webContentsId: 7, name: 'original.pdf', state: 'progressing', receivedBytes: 10, totalBytes: 50, path: null }
  event({ ...row, webContentsId: 8 })
  await nextTick()
  expect(wrapper.text()).toBe('')
  event(row)
  await nextTick()
  expect(wrapper.find('progress').exists()).toBe(false)
  await wrapper.find('.download-toggle').trigger('click')
  expect(wrapper.find('progress').attributes('value')).toBe('10')
  await wrapper.findAll('button').at(-1).trigger('click')
  expect(window.shellApi.browser.cancelDownload).toHaveBeenCalledWith(7, 'a')
  event({ ...row, state: 'completed', receivedBytes: 50, path: 'chosen/original.pdf' })
  await nextTick()
  expect(wrapper.text()).toContain('chosen/original.pdf')
  expect(wrapper.find('progress').exists()).toBe(false)
  await wrapper.findAll('button').at(-1).trigger('click')
  expect(window.shellApi.browser.revealDownload).toHaveBeenCalledWith(7, 'a')
  wrapper.unmount()
  expect(off).toHaveBeenCalled()
  delete window.shellApi
})
