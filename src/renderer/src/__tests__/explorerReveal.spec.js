// A folder named by a link (links/openTarget.js): the Files tab unfolds at it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import SidePanel from '../components/SidePanel.vue'
import { resetSettings } from '../settings'

const ROOT = 'C:\\proj'
const ENTRIES = {
  [ROOT]: [
    { name: 'app', path: `${ROOT}\\app`, dir: true },
    { name: 'docs', path: `${ROOT}\\docs`, dir: true },
    { name: 'README.md', path: `${ROOT}\\README.md`, dir: false }
  ],
  [`${ROOT}\\app`]: [{ name: 'web', path: `${ROOT}\\app\\web`, dir: true }],
  [`${ROOT}\\app\\web`]: [{ name: 'main.js', path: `${ROOT}\\app\\web\\main.js`, dir: false }],
  [`${ROOT}\\docs`]: [{ name: 'guide.md', path: `${ROOT}\\docs\\guide.md`, dir: false }]
}
function api() {
  window.shellApi = {
    explorer: {
      watch: vi.fn(),
      unwatch: vi.fn(),
      list: vi.fn(async ({ dir }) => ({ ok: true, entries: ENTRIES[dir || ROOT] || [] })),
      listMany: undefined,
      status: vi.fn(async () => ({ ok: true, repo: true, files: {} })),
      sparse: vi.fn(async () => ({ ok: true, sparse: false, dirs: [] })),
      searchNames: vi.fn(async () => ({ ok: true, results: [] }))
    }
  }
}
const names = (w) => w.findAll('.explorer-row .explorer-name').map((n) => n.text())

describe('revealing a folder in Files', () => {
  let w
  afterEach(() => {
    w?.unmount()
    w = null
    delete window.shellApi
    resetSettings()
  })

  it('opens its parents and itself, and selects it (any slashes, any case)', async () => {
    api()
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    expect(names(w)).toEqual(['app', 'docs', 'README.md'])
    expect(w.vm.revealPath('c:/proj/app/web')).toBe(true)
    await flushPromises()
    const paths = w.findAll('.explorer-row').map((r) => r.attributes('data-path'))
    expect(paths).toContain(`${ROOT}\\app\\web\\main.js`)
    expect(w.find('.explorer-row.selected').exists()).toBe(true)
    expect(w.find('.explorer-row.selected').text()).toContain('web')
  })

  it('refuses a folder outside the project (or a look-alike next to it)', async () => {
    api()
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    expect(w.vm.revealPath('D:\\elsewhere')).toBe(false)
    expect(w.vm.revealPath('C:\\project2\\x')).toBe(false)
    expect(w.vm.revealPath(ROOT)).toBe(true)
  })

  it('the side panel shows its Files tab, then reveals there', async () => {
    api()
    w = mount(SidePanel, { props: { tab: 'tasks', root: ROOT }, global: { stubs: { TaskBoard: true, AgentDashboard: true } } })
    await flushPromises()
    const shown = w.vm.revealInFiles(`${ROOT}\\docs`)
    await nextTick()
    expect(w.emitted('update:tab').at(-1)).toEqual(['files'])
    await w.setProps({ tab: 'files' })
    expect(await shown).toBe(true)
    await flushPromises()
    expect(names(w)).toContain('guide.md')
  })
})
