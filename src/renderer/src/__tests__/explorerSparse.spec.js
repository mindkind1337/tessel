// A sparse checkout: the Files tree shows one of its folders as its root.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import ThemedSelect from '../components/ui/ThemedSelect.vue'

const ROOT = 'C:\\proj'
const ENTRIES = {
  [ROOT]: [
    { name: 'app', path: `${ROOT}\\app`, dir: true },
    { name: 'docs', path: `${ROOT}\\docs`, dir: true },
    { name: 'README.md', path: `${ROOT}\\README.md`, dir: false }
  ],
  [`${ROOT}\\app\\web`]: [{ name: 'main.js', path: `${ROOT}\\app\\web\\main.js`, dir: false }],
  [`${ROOT}\\docs`]: [{ name: 'guide.md', path: `${ROOT}\\docs\\guide.md`, dir: false }]
}
function api(dirs) {
  window.shellApi = {
    explorer: {
      watch: vi.fn(),
      unwatch: vi.fn(),
      list: vi.fn(async ({ dir }) => ({ ok: true, entries: ENTRIES[dir || ROOT] || [] })),
      status: vi.fn(async () => ({ ok: true, repo: true, files: {} })),
      sparse: vi.fn(async () => (dirs ? { ok: true, sparse: true, dirs } : { ok: true, sparse: false, dirs: [] })),
      searchNames: vi.fn(async () => ({ ok: true, results: [] }))
    }
  }
  return window.shellApi.explorer
}
const WEB = { rel: 'app/web', path: `${ROOT}\\app\\web` }
const DOCS = { rel: 'docs', path: `${ROOT}\\docs` }

describe('sparse checkout in the Files tree', () => {
  let w
  afterEach(() => {
    w?.unmount()
    delete window.shellApi
  })
  const names = () => w.findAll('.explorer-row .explorer-name').map((n) => n.text())

  it('not sparse: the whole project, no folder choice', async () => {
    api(null)
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    expect(names()).toEqual(['app', 'docs', 'README.md'])
    expect(w.find('[data-test="explorer-scope"]').exists()).toBe(false)
  })

  it('a sole sparse folder is shown by itself; the whole project on request', async () => {
    api([WEB])
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    expect(w.find('[data-test="explorer-scope"]').exists()).toBe(true)
    expect(names()).toEqual(['main.js'])
    w.findComponent(ThemedSelect).vm.$emit('update:modelValue', '')
    await flushPromises()
    expect(names()).toEqual(['app', 'docs', 'README.md'])
  })

  it('several: the whole project until one is chosen; a name search then looks in it', async () => {
    const ex = api([WEB, DOCS])
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    expect(names()).toEqual(['app', 'docs', 'README.md'])
    w.findComponent(ThemedSelect).vm.$emit('update:modelValue', 'docs')
    await flushPromises()
    expect(names()).toEqual(['guide.md'])
    await w.get('[data-test="explorer-search"]').setValue('g')
    await new Promise((r) => setTimeout(r, 200))
    await flushPromises()
    expect(ex.searchNames).toHaveBeenLastCalledWith(expect.objectContaining({ root: ROOT, dir: DOCS.path, query: 'g' }))
  })
})
