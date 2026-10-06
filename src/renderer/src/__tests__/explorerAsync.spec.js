import { afterEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ExplorerPanel from '../components/ExplorerPanel.vue'

let wrapper
afterEach(() => { wrapper?.unmount(); delete window.shellApi })
function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
const entry = (root, name) => ({ name, path: `${root}/${name}`, dir: false })
function setup(overrides = {}) {
  const api = {
    watch: vi.fn(), unwatch: vi.fn(),
    list: vi.fn(async ({ root }) => ({ ok: true, entries: [entry(root, 'current.js')] })),
    status: vi.fn(async ({ root }) => ({ ok: true, repo: true, files: { [`${root}/current.js`]: 'M' } })),
    ...overrides
  }
  window.shellApi = { explorer: api }
  wrapper = mount(ExplorerPanel, { props: { root: 'C:/A' } })
  return api
}

it('does not overwrite the new project Git badges with an old project response', async () => {
  const old = deferred()
  setup({ status: vi.fn(({ root }) => root === 'C:/A' ? old.promise : Promise.resolve({ ok: true, repo: true, files: { 'C:/B/current.js': 'M' } })) })
  await flushPromises()
  await wrapper.setProps({ root: 'C:/B' })
  await flushPromises()
  expect(wrapper.get('.explorer-row').text()).toContain('M')
  old.resolve({ ok: true, repo: true, files: {} })
  await flushPromises()
  expect(wrapper.get('.explorer-row').text()).toContain('M')
})

it('keeps the latest directory refresh when an older refresh arrives last', async () => {
  const api = setup()
  await flushPromises()
  const older = deferred(), latest = deferred()
  api.list.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise)
  await wrapper.get('[data-test="explorer-refresh"]').trigger('click')
  await wrapper.get('[data-test="explorer-refresh"]').trigger('click')
  latest.resolve({ ok: true, entries: [entry('C:/A', 'new.js')] })
  await flushPromises()
  older.resolve({ ok: true, entries: [entry('C:/A', 'deleted.js')] })
  await flushPromises()
  expect(wrapper.findAll('.explorer-name').map(n => n.text())).toEqual(['new.js'])
})

it('a refresh the remote host did not answer keeps the rows shown, with the error', async () => {
  const api = setup()
  await flushPromises()
  api.list.mockResolvedValueOnce({ ok: false, transient: true, error: 'Box is slow to answer' })
  await wrapper.get('[data-test="explorer-refresh"]').trigger('click')
  await flushPromises()
  expect(wrapper.findAll('.explorer-name').map(n => n.text())).toEqual(['current.js'])
  expect(wrapper.text()).toContain('Box is slow to answer')
  // A refresh asks in the background (a remote host serves clicks first).
  expect(api.list.mock.calls.at(-1)[0]).toMatchObject({ background: true })
})

it('a folder that is really gone is emptied', async () => {
  const api = setup()
  await flushPromises()
  api.list.mockResolvedValueOnce({ ok: false, error: 'The folder is gone.' })
  await wrapper.get('[data-test="explorer-refresh"]').trigger('click')
  await flushPromises()
  expect(wrapper.findAll('.explorer-name')).toHaveLength(0)
})
