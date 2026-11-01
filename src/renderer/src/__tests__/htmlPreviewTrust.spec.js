// The HTML preview's trust, as VS Code's Workspace Trust: one question about a
// folder, answered once and remembered; scripts only for a trusted folder; the
// toolbar is the page's path and three icons.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import HtmlView from '../components/HtmlView.vue'

let w
const ROOT = 'C:\\sites\\afterlife'
const FILE = 'C:\\sites\\afterlife\\code.html'
const urls = []
beforeEach(() => {
  localStorage.clear()
  urls.length = 0
  window.shellApi = {
    previewUrl: vi.fn(async (q) => {
      urls.push(q)
      return { ok: true, url: `http://${'a'.repeat(32)}.localhost:5000/code.html` }
    }),
    onPreviewBlocked: vi.fn(() => () => {})
  }
})
afterEach(() => {
  w?.unmount()
  w = null
})
const open = async (props = {}) => {
  w = mount(HtmlView, { props: { file: FILE, root: ROOT, text: '<p>x</p>', ...props } })
  await flushPromises()
  return w
}
const sandbox = () => w.get('[data-test="html-live-frame"]').attributes('sandbox')

describe('the folder is asked about once', () => {
  it('first time: the page shows without scripts and the question is there; nothing is decided for the person', async () => {
    await open()
    expect(w.find('[data-test="html-trust"]').exists()).toBe(true)
    expect(sandbox()).toBe('allow-same-origin')
    expect(urls.at(-1).scripts).toBe(false)
    expect(localStorage.getItem('tessel.htmlTrust')).toBeNull()
  })
  it('trust: scripts run, the question goes, the answer is remembered for the folder', async () => {
    await open()
    await w.get('[data-test="html-trust-yes"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="html-trust"]').exists()).toBe(false)
    expect(sandbox()).toBe('allow-scripts allow-same-origin allow-forms')
    expect(urls.at(-1).scripts).toBe(true)
    expect(JSON.parse(localStorage.getItem('tessel.htmlTrust'))).toEqual({ 'c:\\sites\\afterlife': true })
    // Next time, in that folder: no question, scripts on.
    w.unmount()
    await open()
    expect(w.find('[data-test="html-trust"]').exists()).toBe(false)
    expect(sandbox()).toBe('allow-scripts allow-same-origin allow-forms')
    // Another folder asks again.
    w.unmount()
    await open({ file: 'C:\\other\\a.html', root: 'C:\\other' })
    expect(w.find('[data-test="html-trust"]').exists()).toBe(true)
    expect(sandbox()).toBe('allow-same-origin')
  })
  it('declined: no scripts, not asked again; the shield asks again and trusting later works', async () => {
    await open()
    await w.get('[data-test="html-trust-no"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="html-trust"]').exists()).toBe(false)
    expect(sandbox()).toBe('allow-same-origin')
    expect(JSON.parse(localStorage.getItem('tessel.htmlTrust'))).toEqual({ 'c:\\sites\\afterlife': false })
    await w.get('[data-test="html-scripts"]').trigger('click')
    expect(w.find('[data-test="html-trust"]').exists()).toBe(true)
    await w.get('[data-test="html-trust-yes"]').trigger('click')
    await flushPromises()
    expect(sandbox()).toBe('allow-scripts allow-same-origin allow-forms')
  })
  it('the shield of a trusted folder goes back to restricted at once, without a question', async () => {
    localStorage.setItem('tessel.htmlTrust', JSON.stringify({ 'c:\\sites\\afterlife': true }))
    await open()
    await w.get('[data-test="html-scripts"]').trigger('click')
    await flushPromises()
    expect(sandbox()).toBe('allow-same-origin')
    expect(w.find('[data-test="html-trust"]').exists()).toBe(false)
    expect(urls.at(-1).scripts).toBe(false)
  })
  it('the folders that had scripts on before (the old list) stay trusted', async () => {
    localStorage.setItem('tessel.htmlScripts', JSON.stringify(['c:\\sites\\afterlife']))
    await open()
    expect(w.find('[data-test="html-trust"]').exists()).toBe(false)
    expect(sandbox()).toBe('allow-scripts allow-same-origin allow-forms')
  })
})

describe('the toolbar', () => {
  it("the page's path and three icons: reload, open in a browser tab, the shield", async () => {
    await open()
    const bar = w.get('[data-test="html-live-bar"]')
    expect(bar.get('[data-test="html-path"]').text()).toBe('/code.html')
    expect(bar.findAll('button')).toHaveLength(3)
    for (const b of bar.findAll('button')) expect(b.attributes('aria-label')).toBeTruthy()
    const before = window.shellApi.previewUrl.mock.calls.length
    await bar.get('[data-test="html-reload"]').trigger('click')
    expect(window.shellApi.previewUrl.mock.calls.length).toBe(before + 1)
  })
})
