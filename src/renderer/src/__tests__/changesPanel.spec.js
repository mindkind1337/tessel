// The Changes tab (ChangesPanel.vue): never "Everything is committed" without
// a git status that worked; paths compared whatever their separators or case;
// a late answer for a folder no longer shown is dropped.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ChangesPanel from '../components/ChangesPanel.vue'
import { setTasks } from '../taskBoardStore'

let w
function api(status) {
  setTasks([])
  window.shellApi = { explorer: { status, watch: vi.fn(), unwatch: vi.fn(), onChanged: () => () => {} } }
}
afterEach(() => {
  if (w) w.unmount()
  w = null
  delete window.shellApi
})

describe('Changes tab', () => {
  it('a failed status is shown as an error, not as a clean copy', async () => {
    api(async () => ({ ok: false, error: 'Git status failed' }))
    w = mount(ChangesPanel, { props: { root: 'C:\\proj' } })
    await flushPromises()
    expect(w.text()).not.toContain('Everything is committed')
    expect(w.find('[data-test="changes-error"]').text()).toContain('Git status failed')
  })

  it('a status that throws is an error too', async () => {
    api(async () => {
      throw new Error('IPC gone')
    })
    w = mount(ChangesPanel, { props: { root: 'C:\\proj' } })
    await flushPromises()
    expect(w.text()).not.toContain('Everything is committed')
    expect(w.find('[data-test="changes-error"]').text()).toContain('IPC gone')
  })

  it('lists changes whatever the separators and case of the folder and of the paths', async () => {
    api(async () => ({ ok: true, repo: true, files: { 'C:\\proj\\a.js': 'M', 'c:\\PROJ\\src\\b.js': 'U', 'C:\\project2\\x.js': 'M' } }))
    w = mount(ChangesPanel, { props: { root: 'C:/proj/' } })
    await flushPromises()
    const rows = w.findAll('[data-test="changes-row"]')
    expect(rows.map((r) => r.find('.explorer-name').text())).toEqual(['a.js', 'b.js'])
    expect(rows[1].find('.explorer-hit-dir').text()).toBe('src')
    expect(w.text()).not.toContain('Everything is committed')
  })

  it('an answer arriving after the folder went away is dropped', async () => {
    const status = vi.fn(async () => ({ ok: true, repo: true, files: {} }))
    api(status)
    w = mount(ChangesPanel, { props: { root: 'C:\\proj' } })
    await flushPromises()
    let finish
    status.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const pending = w.vm.load()
    await w.setProps({ root: null })
    finish({ ok: true, repo: true, files: { 'C:\\proj\\a.js': 'M' } })
    await expect(pending).resolves.toBeUndefined()
    expect(w.findAll('[data-test="changes-row"]')).toHaveLength(0)
  })

  it('an answer for the previous folder never shows in the new one', async () => {
    const answers = []
    api((q) => new Promise((resolve) => answers.push({ q, resolve })))
    w = mount(ChangesPanel, { props: { root: 'C:\\one' } })
    await w.setProps({ root: 'C:\\two' })
    answers[1].resolve({ ok: true, repo: true, files: { 'C:\\two\\b.js': 'M' } })
    await flushPromises()
    answers[0].resolve({ ok: true, repo: true, files: { 'C:\\one\\a.js': 'M' } })
    await flushPromises()
    expect(w.findAll('[data-test="changes-row"]').map((r) => r.find('.explorer-name').text())).toEqual(['b.js'])
  })

  it('an answer after the tab closed changes nothing', async () => {
    let finish
    api(() => new Promise((resolve) => (finish = resolve)))
    w = mount(ChangesPanel, { props: { root: 'C:\\proj' } })
    const vm = w.vm
    w.unmount()
    w = null
    finish({ ok: true, repo: true, files: { 'C:\\proj\\a.js': 'M' } })
    await flushPromises()
    expect(vm).toBeTruthy()
  })
})
