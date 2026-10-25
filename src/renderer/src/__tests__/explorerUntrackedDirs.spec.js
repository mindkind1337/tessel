// A remote project's git status lists an untracked folder once ("?? dir/",
// remoteFs.js projectStatus with --untracked-files=normal), not every file
// in it: the Files panel shows the folder, what is inside it and its open
// editors as untracked all the same (an ignored folder inside stays ignored).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import { statusOf, untrackedFolder, folderStatus } from '../explorerStatus'
import { settings } from '../settings'

describe('explorerStatus: an untracked folder listed once', () => {
  const root = 'ssh://h/srv/app'
  const map = { [`${root}/cache`]: 'U', [`${root}/cache/node_modules`]: '!', [`${root}/a.lua`]: 'M', [`${root}/cache/keep.txt`]: '!' }

  it('a file inside it (at any depth) is untracked', () => {
    expect(statusOf(map, `${root}/cache/x.bin`, root)).toBe('U')
    expect(statusOf(map, `${root}/cache/deep/er/y.bin`, root)).toBe('U')
    expect(statusOf(map, `${root}/cache/deep/er/y.bin`)).toBe('U')
  })

  it('the nearest folder listed decides: inside an ignored folder, no letter; a file listed keeps its own', () => {
    expect(statusOf(map, `${root}/cache/node_modules/z.js`, root)).toBe('')
    expect(statusOf(map, `${root}/cache/keep.txt`, root)).toBe('')
    expect(statusOf(map, `${root}/a.lua`, root)).toBe('M')
    expect(statusOf(map, `${root}/src/b.lua`, root)).toBe('')
  })

  it('the folder itself and the folders inside it get the untracked letter; others none', () => {
    expect(untrackedFolder(map, `${root}/cache`, root)).toBe('U')
    expect(untrackedFolder(map, `${root}/cache/deep`, root)).toBe('U')
    expect(untrackedFolder(map, `${root}/cache/node_modules`, root)).toBe('')
    expect(untrackedFolder(map, `${root}/src`, root)).toBe('')
  })

  it('never looks above the project folder', () => {
    const above = { 'ssh://h/srv': 'U' }
    expect(statusOf(above, `${root}/a.lua`, root)).toBe('')
    expect(untrackedFolder(above, `${root}/src`, root)).toBe('')
  })

  it('the folders above it show it, as before', () => {
    const nested = { [`${root}/data/cache`]: 'U' }
    expect(folderStatus(nested, root)[`${root}/data`]).toBe('U')
  })
})

describe('the Files tree with an untracked folder', () => {
  const ROOT = 'C:\\proj'
  const P = (rel) => `${ROOT}\\${rel}`
  const d = (rel) => ({ name: rel.split('\\').pop(), path: P(rel), dir: true })
  const f = (rel) => ({ name: rel.split('\\').pop(), path: P(rel), dir: false })
  const ENTRIES = {
    [ROOT]: [d('cache'), d('src'), f('top.md')],
    [P('cache')]: [d('cache\\maps'), f('cache\\a.bin')],
    [P('src')]: [f('src\\b.lua')]
  }
  let w
  beforeEach(() => {
    settings.explorerCompactFolders = false
    window.shellApi = {
      explorer: {
        watch: vi.fn(),
        unwatch: vi.fn(),
        list: vi.fn(async ({ dir }) => ({ ok: true, entries: ENTRIES[dir] || [] })),
        status: vi.fn(async () => ({ ok: true, repo: true, files: { [P('cache')]: 'U' } })),
        sparse: vi.fn(async () => ({ ok: true, sparse: false, dirs: [] })),
        searchNames: vi.fn(async () => ({ ok: true, results: [] }))
      }
    }
  })
  afterEach(() => {
    w?.unmount()
    delete window.shellApi
    settings.explorerCompactFolders = true
  })
  const rows = () => w.findAll('.explorer-files .explorer-row')
  const row = (name) => rows().find((r) => r.get('.explorer-name').text() === name)

  it('the folder, its sub-folders and its files show as untracked', async () => {
    w = mount(ExplorerPanel, { props: { root: ROOT }, attachTo: document.body })
    await flushPromises()
    expect(row('cache').classes()).toContain('git-U')
    expect(row('src').classes()).toContain('git-none')
    expect(row('top.md').classes()).toContain('git-none')
    await row('cache').trigger('click')
    await flushPromises()
    expect(row('maps').classes()).toContain('git-U')
    expect(row('a.bin').classes()).toContain('git-U')
    expect(row('a.bin').get('.explorer-git').text()).toBe('U')
  })
})
