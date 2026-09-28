// Settings > Appearance, "Show Git-Ignored Files": on (Orca's default) the
// explorer shows them dimmed; off it hides them, in the tree and in search.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import { settings, resetSettings } from '../settings'

const ROOT = 'C:\\proj'
function api() {
  window.shellApi = {
    explorer: {
      watch: vi.fn(),
      unwatch: vi.fn(),
      list: vi.fn(async () => ({
        ok: true,
        entries: [
          { name: 'node_modules', path: `${ROOT}\\node_modules`, dir: true },
          { name: 'src', path: `${ROOT}\\src`, dir: true },
          { name: '.env', path: `${ROOT}\\.env`, dir: false },
          { name: 'README.md', path: `${ROOT}\\README.md`, dir: false }
        ]
      })),
      status: vi.fn(async () => ({
        ok: true,
        repo: true,
        files: { [`${ROOT}\\node_modules`]: '!', [`${ROOT}\\.env`]: '!' }
      })),
      searchNames: vi.fn(async () => ({
        ok: true,
        results: [
          { path: `${ROOT}\\.env`, rel: '.env', name: '.env', dir: false },
          { path: `${ROOT}\\README.md`, rel: 'README.md', name: 'README.md', dir: false }
        ]
      }))
    }
  }
}

describe('Show Git-Ignored Files', () => {
  let w
  afterEach(() => {
    w?.unmount()
    resetSettings()
    delete window.shellApi
  })

  it('shows them dimmed by default and hides them when off', async () => {
    api()
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    const names = () => w.findAll('.explorer-row .explorer-name').map((n) => n.text())
    expect(names()).toEqual(['node_modules', 'src', '.env', 'README.md'])
    expect(w.findAll('.explorer-row.ignored')).toHaveLength(2)
    settings.showGitIgnoredFiles = false
    await flushPromises()
    expect(names()).toEqual(['src', 'README.md'])
  })

  it('search results too', async () => {
    api()
    settings.showGitIgnoredFiles = false
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    await w.get('input').setValue('e')
    await new Promise((r) => setTimeout(r, 200))
    await flushPromises()
    expect(w.findAll('.explorer-hit').map((h) => h.attributes('data-path'))).toEqual([`${ROOT}\\README.md`])
  })
})
