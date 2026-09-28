import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import FileFinder from '../components/FileFinder.vue'

function setup(props = {}) {
  window.shellApi = {
    listFiles: vi.fn(async () => ({ ok: true, files: ['src/App.vue', 'src/main/review.js', 'README.md'], truncated: false }))
  }
  return mount(FileFinder, { props: { root: 'C:\\Proj', canInsert: true, ...props }, attachTo: document.body })
}

describe('Jump to file', () => {
  it("lists the project's files, finds by a few letters, Enter opens the chosen one", async () => {
    const w = setup()
    await flushPromises()
    expect(window.shellApi.listFiles).toHaveBeenCalledWith('C:\\Proj')
    await w.find('[data-test="finder-input"]').setValue('rev')
    expect(w.findAll('[data-test="finder-item"]').map((b) => b.find('.finder-name').text())).toEqual(['review.js'])
    await w.find('[data-test="finder-input"]').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('open')).toEqual([[{ rel: 'src/main/review.js', full: 'C:\\Proj\\src\\main\\review.js' }]])
    expect(w.emitted('close')).toBeTruthy()
    w.unmount()
  })

  it('Ctrl+Enter puts the path in the active pane; arrows move the choice', async () => {
    const w = setup()
    await flushPromises()
    const input = w.find('[data-test="finder-input"]')
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(w.emitted('insert')[0][0].rel).toBe('src/main/review.js')
    w.unmount()
  })

  it('a workspace with no folder says so', async () => {
    const w = setup({ root: null })
    await flushPromises()
    expect(w.text()).toMatch(/no project folder/)
    w.unmount()
  })
})
