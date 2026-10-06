// The Files tree as compact as VS Code's: 22 px rows, 8 px indentation,
// indent guides, and compact folders ("a / b / c" on one row).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import { settings } from '../settings'

const ROOT = 'C:\\proj'
const P = (rel) => `${ROOT}\\${rel}`
const d = (rel) => ({ name: rel.split('\\').pop(), path: P(rel), dir: true })
const f = (rel) => ({ name: rel.split('\\').pop(), path: P(rel), dir: false })
let ENTRIES
function api() {
  ENTRIES = {
    [ROOT]: [d('a'), f('top.md')],
    [P('a')]: [d('a\\b')],
    [P('a\\b')]: [d('a\\b\\c')],
    [P('a\\b\\c')]: [d('a\\b\\c\\deep'), f('a\\b\\c\\x.txt')],
    [P('a\\b\\c\\deep')]: [f('a\\b\\c\\deep\\z.txt')]
  }
  window.shellApi = {
    explorer: {
      watch: vi.fn(),
      unwatch: vi.fn(),
      list: vi.fn(async ({ dir }) => ({ ok: true, entries: ENTRIES[dir] || [] })),
      status: vi.fn(async () => ({ ok: true, repo: true, files: { [P('a\\b\\c\\x.txt').toLowerCase()]: 'M' } })),
      sparse: vi.fn(async () => ({ ok: true, sparse: false, dirs: [] })),
      searchNames: vi.fn(async () => ({ ok: true, results: [] })),
      rename: vi.fn(async ({ path, name }) => ({ ok: true, path: path.replace(/[^\\]+$/, name) })),
      create: vi.fn(async ({ dir, name }) => ({ ok: true, path: dir + '\\' + name })),
      trash: vi.fn(async () => ({ ok: true }))
    }
  }
  return window.shellApi.explorer
}

describe('compact Files tree', () => {
  let w, ex
  beforeEach(() => {
    settings.explorerCompactFolders = true
    ex = api()
  })
  afterEach(() => {
    w?.unmount()
    delete window.shellApi
    settings.explorerCompactFolders = true
  })
  const rows = () => w.findAll('.explorer-files .explorer-row')
  const names = () => rows().map((r) => r.get('.explorer-name').text())
  const row = (name) => rows().find((r) => r.get('.explorer-name').text() === name)
  async function mountTree() {
    w = mount(ExplorerPanel, { props: { root: ROOT }, attachTo: document.body })
    await flushPromises()
  }

  it('opening a folder opens its sole sub-folders: one row "a/b/c"', async () => {
    await mountTree()
    expect(names()).toEqual(['a', 'top.md'])
    await row('a').trigger('click')
    await flushPromises()
    expect(names()).toEqual(['a/b/c', 'deep', 'x.txt', 'top.md'])
    expect(row('a/b/c').findAll('.explorer-crumb').map((c) => c.text())).toEqual(['a', 'b', 'c'])
    // c holds two entries: read, never further (deep stays closed).
    expect(ex.list.mock.calls.map((c) => c[0].dir)).not.toContain(P('a\\b\\c\\deep'))
    // Git status stays: the folder's dot, the file's letter.
    expect(row('a/b/c').get('.explorer-git').text()).toBe('•')
    expect(row('x.txt').classes()).toContain('git-M')
    expect(row('x.txt').get('.explorer-git').text()).toBe('M')
  })

  it('rows: VS Code geometry (8 px per level) and indent guides', async () => {
    await mountTree()
    await row('a').trigger('click')
    await flushPromises()
    expect(row('a/b/c').attributes('style')).toContain('padding-left: 8px')
    expect(row('x.txt').attributes('style')).toContain('padding-left: 16px')
    expect(row('a/b/c').find('.explorer-guides').exists()).toBe(false)
    const g = row('x.txt').get('.explorer-guides')
    expect(g.attributes('style')).toContain('left: 16px')
    expect(g.attributes('style')).toContain('width: 8px')
    // The selected file's parent folder: its guide brighter.
    await row('x.txt').trigger('click')
    expect(row('x.txt').get('.explorer-guide-active').attributes('style')).toContain('left: 16px')
    expect(row('deep').find('.explorer-guide-active').exists()).toBe(true)
    expect(row('top.md').find('.explorer-guide-active').exists()).toBe(false)
    expect(row('a/b/c').find('.explorer-twistie svg').exists()).toBe(true)
    expect(row('x.txt').find('.explorer-twistie svg').exists()).toBe(false)
    expect(row('x.txt').get('.explorer-icon').attributes('width')).toBe('16')
  })

  it('the stylesheet: 22 px rows, 13 px text, a 16 px twistie, guides on hover', () => {
    const css = readFileSync(join(__dirname, '..', 'style.css'), 'utf8')
    const rule = (sel) => {
      const m = css.match(new RegExp('\\n' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}'))
      return m ? m[1] : ''
    }
    expect(rule('.explorer-row')).toMatch(/height: 22px;/)
    expect(rule('.explorer-row')).toMatch(/font-size: 13px;/)
    expect(rule('.explorer-twistie')).toMatch(/width: 16px;/)
    expect(rule('.explorer-guides')).toMatch(/opacity: 0;/)
    expect(css).toMatch(/\.explorer-files:hover \.explorer-guides/)
  })

  it('a click on a segment selects that folder; the row closes and opens as one', async () => {
    await mountTree()
    await row('a').trigger('click')
    await flushPromises()
    await row('a/b/c').findAll('.explorer-crumb')[1].trigger('click')
    await flushPromises()
    expect(names()).toEqual(['a/b/c', 'top.md'])
    expect(row('a/b/c').classes()).toContain('selected')
    expect(row('a/b/c').findAll('.explorer-crumb')[1].classes()).toContain('active')
    await row('a/b/c').trigger('click')
    await flushPromises()
    expect(names()).toEqual(['a/b/c', 'deep', 'x.txt', 'top.md'])
  })

  it('the context menu and rename apply to the segment right-clicked', async () => {
    await mountTree()
    await row('a').trigger('click')
    await flushPromises()
    await row('a/b/c').findAll('.explorer-crumb')[1].trigger('contextmenu')
    const rename = w.findAll('.explorer-menu .ctx-menu-item').find((b) => b.text() === 'Rename')
    await rename.trigger('click')
    await flushPromises()
    // b stands on its own row while renamed.
    const input = w.get('.explorer-files .explorer-edit-input')
    expect(input.element.value).toBe('b')
    expect(names()).toEqual(['a', 'c', 'deep', 'x.txt', 'top.md'])
    await input.setValue('bee')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(ex.rename).toHaveBeenCalledWith(expect.objectContaining({ path: P('a\\b'), name: 'bee' }))
  })

  it('a new file in a middle segment goes into that folder', async () => {
    await mountTree()
    await row('a').trigger('click')
    await flushPromises()
    await row('a/b/c').findAll('.explorer-crumb')[0].trigger('contextmenu')
    await w.findAll('.explorer-menu .ctx-menu-item').find((b) => b.text() === 'New file').trigger('click')
    await flushPromises()
    expect(names()).toEqual(['a', 'b/c', 'deep', 'x.txt', 'top.md'])
    const input = w.get('.explorer-files .explorer-edit-input')
    await input.setValue('n.js')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(ex.create).toHaveBeenCalledWith(expect.objectContaining({ dir: P('a'), name: 'n.js', folder: false }))
  })

  it('the chain breaks when a folder gets a second child', async () => {
    await mountTree()
    await row('a').trigger('click')
    await flushPromises()
    ENTRIES[P('a\\b')] = [d('a\\b\\c'), f('a\\b\\new.js')]
    await w.get('[data-test="explorer-refresh"]').trigger('click')
    await flushPromises()
    expect(names()).toEqual(['a/b', 'c', 'deep', 'x.txt', 'new.js', 'top.md'])
  })

  it('turned off from the explorer menu: one row per folder', async () => {
    await mountTree()
    await row('a').trigger('click')
    await flushPromises()
    await w.get('[data-test="explorer-more"]').trigger('click')
    await w.get('[data-test="explorer-compact"]').trigger('click')
    expect(settings.explorerCompactFolders).toBe(false)
    expect(names()).toEqual(['a', 'b', 'c', 'deep', 'x.txt', 'top.md'])
    expect(row('c').attributes('style')).toContain('padding-left: 24px')
  })

  it('keyboard: up and down rows, right and left through the segments, then close', async () => {
    await mountTree()
    const tree = w.get('.explorer-files')
    await tree.trigger('keydown', { key: 'ArrowDown' })
    expect(row('a').classes()).toContain('selected')
    await tree.trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    expect(names()).toEqual(['a/b/c', 'deep', 'x.txt', 'top.md'])
    const active = () => row('a/b/c').findAll('.explorer-crumb').findIndex((c) => c.classes('active'))
    expect(active()).toBe(0)
    await tree.trigger('keydown', { key: 'ArrowRight' })
    expect(active()).toBe(1)
    await tree.trigger('keydown', { key: 'ArrowRight' })
    expect(active()).toBe(2)
    await tree.trigger('keydown', { key: 'ArrowDown' })
    expect(row('deep').classes()).toContain('selected')
    await tree.trigger('keydown', { key: 'ArrowLeft' })
    expect(active()).toBe(2)
    await tree.trigger('keydown', { key: 'ArrowLeft' })
    expect(active()).toBe(1)
    await tree.trigger('keydown', { key: 'ArrowLeft' })
    await tree.trigger('keydown', { key: 'ArrowLeft' })
    expect(names()).toEqual(['a/b/c', 'top.md'])
  })
})
