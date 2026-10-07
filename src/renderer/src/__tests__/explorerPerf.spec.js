// The Files tree stays fast on a big or remote project (after VS Code's
// explorer): folders read together in one request, a compact chain at once,
// change notices that read again only what they touch, git status throttled
// and skipped for ignored files, only the rows in view drawn, a prefetch on
// a remote host; and a loading state, never an empty tree, until it answers.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import { foldersToReload, statusMatters, sameEntries, rememberIgnored, forgetIgnored } from '../explorerChanges'
import { settings } from '../settings'

const ROOT = 'C:\\proj'
const P = (rel) => `${ROOT}\\${rel}`
const d = (rel) => ({ name: rel.split('\\').pop(), path: P(rel), dir: true })
const f = (rel) => ({ name: rel.split('\\').pop(), path: P(rel), dir: false })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let w = null
afterEach(() => {
  w?.unmount()
  w = null
  delete window.shellApi
  vi.useRealTimers()
})

function makeApi(entries, { many = true, status = {} } = {}) {
  let changed = null
  const list = vi.fn(async ({ dir }) => (entries[dir] ? { ok: true, entries: entries[dir] } : { ok: false, error: 'The folder is gone.' }))
  const api = {
    watch: vi.fn(),
    unwatch: vi.fn(),
    list,
    status: vi.fn(async () => ({ ok: true, repo: true, files: status })),
    sparse: vi.fn(async () => ({ ok: true, sparse: false, dirs: [] })),
    onChanged: (fn) => {
      changed = fn
      return () => {}
    },
    fire: (root, info) => changed && changed(root, info)
  }
  if (many)
    api.listMany = vi.fn(async ({ dirs, chain }) => {
      const results = []
      for (const dir of dirs) {
        let cur = dir
        for (;;) {
          const r = entries[cur] ? { ok: true, entries: entries[cur] } : { ok: false, error: 'The folder is gone.' }
          results.push({ dir: cur, ...r })
          if (!chain || !r.ok || r.entries.length !== 1 || !r.entries[0].dir) break
          cur = r.entries[0].path
        }
      }
      return { ok: true, results }
    })
  window.shellApi = { explorer: api }
  return api
}
const names = () => w.findAll('.explorer-row .explorer-name').map((n) => n.text())
const row = (path) => w.findAll('.explorer-row').find((r) => r.attributes('data-path') === path)

describe('reads', () => {
  it('a compact chain opens with one request', async () => {
    const api = makeApi({
      [ROOT]: [d('a'), f('top.md')],
      [P('a')]: [d('a\\b')],
      [P('a\\b')]: [d('a\\b\\c')],
      [P('a\\b\\c')]: [f('a\\b\\c\\x.txt'), f('a\\b\\c\\y.txt')]
    })
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    await row(P('a')).trigger('click')
    await sleep(5)
    await flushPromises()
    expect(api.listMany).toHaveBeenCalledTimes(1)
    expect(api.listMany.mock.calls[0][0]).toMatchObject({ dirs: [P('a')], chain: true })
    expect(api.list).toHaveBeenCalledTimes(1) // the project's own folder only
    expect(names()).toEqual(['a/b/c', 'x.txt', 'y.txt', 'top.md'])
  })

  it('folders clicked in the same moment are read together', async () => {
    const entries = { [ROOT]: [] }
    for (let i = 0; i < 6; i++) {
      entries[ROOT].push(d(`r${i}`))
      entries[P(`r${i}`)] = [f(`r${i}\\a.lua`), f(`r${i}\\b.lua`)]
    }
    const api = makeApi(entries)
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    const rows = [0, 1, 2, 3, 4, 5].map((i) => row(P(`r${i}`)))
    for (const r of rows) r.trigger('click')
    await sleep(5)
    await flushPromises()
    expect(api.listMany).toHaveBeenCalledTimes(1)
    expect(api.listMany.mock.calls[0][0].dirs).toHaveLength(6)
    expect(names().filter((n) => n === 'a.lua')).toHaveLength(6)
  })

  it('without listMany (an older main), one read per folder as before', async () => {
    const api = makeApi({ [ROOT]: [d('a')], [P('a')]: [f('a\\x.txt')] }, { many: false })
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    await row(P('a')).trigger('click')
    await flushPromises()
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(names()).toEqual(['a', 'x.txt'])
  })
})

describe('change notices', () => {
  async function opened() {
    const entries = {
      [ROOT]: [d('logs'), d('src'), f('server.cfg')],
      [P('logs')]: [f('logs\\server.log')],
      [P('src')]: [f('src\\a.lua')]
    }
    const api = makeApi(entries, { status: { [P('logs').toLowerCase()]: '!' } })
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    await row(P('src')).trigger('click')
    await sleep(5)
    await flushPromises()
    api.list.mockClear()
    api.listMany.mockClear()
    api.status.mockClear()
    return { api, entries }
  }

  it('only git-ignored files changed: nothing read again, no git status', async () => {
    const { api } = await opened()
    api.fire(ROOT, { paths: [P('logs\\server.log'), P('logs')], renamed: [] })
    await sleep(1300)
    await flushPromises()
    expect(api.list).not.toHaveBeenCalled()
    expect(api.listMany).not.toHaveBeenCalled()
    expect(api.status).not.toHaveBeenCalled()
  })

  it('a new file: only its folder read again, then git status', async () => {
    const { api, entries } = await opened()
    entries[P('src')] = [f('src\\a.lua'), f('src\\new.lua')]
    api.fire(ROOT, { paths: [P('src\\new.lua')], renamed: [P('src\\new.lua')] })
    await sleep(1300)
    await flushPromises()
    const asked = [...api.list.mock.calls.map((c) => c[0].dir), ...api.listMany.mock.calls.flatMap((c) => c[0].dirs)]
    expect(asked).toEqual([P('src')])
    expect(api.status).toHaveBeenCalledTimes(1)
    expect(names()).toContain('new.lua')
  })

  it('git status after a burst of changes runs once, then no more than once a second', async () => {
    const { api } = await opened()
    for (let i = 0; i < 5; i++) {
      api.fire(ROOT, { paths: [P('src\\a.lua')] })
      await sleep(250)
    }
    await sleep(1300)
    await flushPromises()
    expect(api.status.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(api.status.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('paths not known: every open folder in one request', async () => {
    const { api } = await opened()
    api.fire(ROOT, { paths: null })
    await sleep(300)
    await flushPromises()
    expect(api.listMany).toHaveBeenCalledTimes(1)
    expect(api.listMany.mock.calls[0][0].dirs.sort()).toEqual([ROOT, P('src')].sort())
    expect(api.list).not.toHaveBeenCalled()
  })

  it('a notice from before (a string root, no paths) reads everything shown again', async () => {
    const { api } = await opened()
    api.fire(ROOT)
    await sleep(300)
    await flushPromises()
    expect(api.listMany).toHaveBeenCalledTimes(1)
  })
})

describe('rows drawn', () => {
  it('only the rows in view are in the page, and they follow the scroll', async () => {
    const big = []
    for (let i = 0; i < 2000; i++) big.push(f(`f${String(i).padStart(4, '0')}.ytd`))
    makeApi({ [ROOT]: big })
    const spy = vi.spyOn(window.HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
      return this.classList && this.classList.contains('explorer-tree') ? 220 : 0
    })
    try {
      w = mount(ExplorerPanel, { props: { root: ROOT }, attachTo: document.body })
      await flushPromises()
      await sleep(5)
      await flushPromises()
      const drawn = w.findAll('.explorer-row')
      expect(drawn.length).toBeGreaterThan(5)
      expect(drawn.length).toBeLessThan(60)
      expect(drawn[0].attributes('data-path')).toBe(P('f0000.ytd'))
      const tree = w.get('.explorer-files').element
      tree.scrollTop = 22 * 1000
      tree.dispatchEvent(new Event('scroll'))
      await sleep(40)
      await flushPromises()
      const paths = w.findAll('.explorer-row').map((r) => r.attributes('data-path'))
      expect(paths).toContain(P('f1000.ytd'))
      expect(paths).not.toContain(P('f0000.ytd'))
      // The space of the rows not drawn keeps the scroll bar right.
      const spacers = w.findAll('.explorer-spacer').map((s) => parseInt(s.attributes('style').match(/height:\s*(\d+)/)[1], 10))
      expect(spacers.reduce((a, b) => a + b, 0) + paths.length * 22).toBe(2000 * 22)
    } finally {
      spy.mockRestore()
    }
  })

  it('a small tree is drawn whole', async () => {
    makeApi({ [ROOT]: [f('a.txt'), f('b.txt')] })
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    expect(names()).toEqual(['a.txt', 'b.txt'])
    expect(w.findAll('.explorer-spacer')).toHaveLength(0)
  })
})

describe('loading and errors', () => {
  it('Loading… until the project answers, never an empty tree; a late answer for the previous project is dropped', async () => {
    let release
    const api = makeApi({ 'C:\\B': [f('b.txt')] })
    api.list.mockImplementation(({ root }) =>
      root === ROOT ? new Promise((r) => (release = r)) : Promise.resolve({ ok: true, entries: [{ name: 'b.txt', path: 'C:\\B\\b.txt', dir: false }] })
    )
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    expect(w.find('[data-test="explorer-loading"]').exists()).toBe(true)
    expect(w.findAll('.explorer-row')).toHaveLength(0)
    await w.setProps({ root: 'C:\\B' })
    await flushPromises()
    expect(names()).toEqual(['b.txt'])
    release({ ok: true, entries: [f('old.txt')] })
    await flushPromises()
    expect(names()).toEqual(['b.txt'])
    expect(w.find('[data-test="explorer-loading"]').exists()).toBe(false)
  })

  it('a folder being opened says Loading…; one that could not be read offers Retry', async () => {
    let release
    const api = makeApi({ [ROOT]: [d('a')], [P('a')]: [f('a\\x.txt')] }, { many: false })
    api.list.mockImplementation(({ dir }) => (dir === ROOT ? Promise.resolve({ ok: true, entries: [d('a')] }) : new Promise((r) => (release = r))))
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    await row(P('a')).trigger('click')
    await flushPromises()
    expect(w.find('[data-test="explorer-dir-loading"]').exists()).toBe(true)
    release({ ok: false, transient: true, error: 'Box did not answer' })
    await flushPromises()
    expect(w.find('[data-test="explorer-dir-loading"]').exists()).toBe(false)
    expect(w.text()).toContain('Box did not answer')
    api.list.mockImplementation(async () => ({ ok: true, entries: [f('a\\x.txt')] }))
    await w.get('[data-test="explorer-retry-dir"]').trigger('click')
    await flushPromises()
    expect(names()).toEqual(['a', 'x.txt'])
  })

  it("the project's folder could not be read: the error and Retry", async () => {
    const api = makeApi({})
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    expect(w.get('[data-test="explorer-error"]').text()).toContain('The folder is gone.')
    api.list.mockImplementation(async () => ({ ok: true, entries: [f('back.txt')] }))
    await w.get('[data-test="explorer-retry"]').trigger('click')
    await flushPromises()
    expect(names()).toEqual(['back.txt'])
    expect(w.find('[data-test="explorer-error"]').exists()).toBe(false)
  })
})

describe('prefetch on a remote host', () => {
  it('after a folder opens, its sub-folders are read in the background; opening one asks nothing', async () => {
    const R = 'ssh://box/srv'
    const rp = (rel) => `${R}\\${rel}`
    const rd = (rel) => ({ name: rel.split('\\').pop(), path: rp(rel), dir: true })
    const rf = (rel) => ({ name: rel.split('\\').pop(), path: rp(rel), dir: false })
    const api = makeApi({
      [R]: [rd('res')],
      [rp('res')]: [rd('res\\one'), rd('res\\two')],
      [rp('res\\one')]: [rf('res\\one\\a.lua'), rf('res\\one\\b.lua')],
      [rp('res\\two')]: [rf('res\\two\\c.lua'), rf('res\\two\\d.lua')]
    })
    w = mount(ExplorerPanel, { props: { root: R } })
    await flushPromises()
    await row(rp('res')).trigger('click')
    await sleep(5)
    await flushPromises()
    expect(names()).toEqual(['res', 'one', 'two'])
    await sleep(800)
    await flushPromises()
    const pre = api.listMany.mock.calls.at(-1)[0]
    expect(pre).toMatchObject({ background: true, max: 300 })
    expect(pre.dirs.sort()).toEqual([rp('res\\one'), rp('res\\two')])
    // Kept aside: the closed folders show as before.
    expect(names()).toEqual(['res', 'one', 'two'])
    const before = api.listMany.mock.calls.length + api.list.mock.calls.length
    await row(rp('res\\one')).trigger('click')
    await flushPromises()
    expect(names()).toEqual(['res', 'one', 'a.lua', 'b.lua', 'two'])
    await sleep(5)
    expect(api.listMany.mock.calls.length + api.list.mock.calls.length).toBe(before)
  })

  it('a local project is not prefetched', async () => {
    const api = makeApi({ [ROOT]: [d('res')], [P('res')]: [d('res\\one'), d('res\\two')], [P('res\\one')]: [], [P('res\\two')]: [] })
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    await row(P('res')).trigger('click')
    await sleep(800)
    await flushPromises()
    expect(api.listMany.mock.calls.every((c) => !c[0].max)).toBe(true)
  })
})

describe('explorerChanges', () => {
  const nodes = {
    [ROOT]: { entries: [d('src'), d('logs')] },
    [P('src')]: { entries: [f('src\\a.lua')] }
  }
  it('folders read again: the folder itself, and the folder of a new entry', () => {
    expect(foldersToReload(nodes, [P('src\\new.lua')], { remote: true })).toEqual([P('src')])
    // A file modified on a remote host: its folder lists it already.
    expect(foldersToReload(nodes, [P('src\\a.lua')], { remote: true })).toEqual([])
    // A local watch names the entry, not its folder: its folder is read again
    // when it was created, deleted or renamed (or that is not known).
    expect(foldersToReload(nodes, [P('src\\a.lua')], { remote: false, renamed: [] })).toEqual([])
    expect(foldersToReload(nodes, [P('src\\a.lua')], { remote: false, renamed: [P('src\\a.lua')] })).toEqual([P('src')])
    expect(foldersToReload(nodes, [P('src\\a.lua')], { remote: false })).toEqual([P('src')])
    expect(foldersToReload(nodes, [P('src\\b.lua')], { remote: false, renamed: [] })).toEqual([P('src')])
    // A remote folder whose entries changed names itself.
    expect(foldersToReload(nodes, [P('src')], { remote: true })).toEqual([P('src')])
    // Not loaded, or git's own folder: nothing.
    expect(foldersToReload(nodes, [P('other\\x'), P('.git\\index')], { remote: false })).toEqual([])
  })
  it('git status matters unless every path is git-ignored; git\'s own folder always', () => {
    const ignored = new Set([P('logs').toLowerCase()])
    expect(statusMatters(ROOT, [P('logs\\server.log')], ignored)).toBe(false)
    expect(statusMatters(ROOT, [P('logs\\server.log'), P('src\\a.lua')], ignored)).toBe(true)
    expect(statusMatters(ROOT, [P('.git\\index')], ignored)).toBe(true)
    expect(statusMatters(ROOT, null, ignored)).toBe(true)
    // Shared with the side panel by project.
    rememberIgnored(ROOT, ignored)
    expect(statusMatters(ROOT, [P('logs\\x.log')])).toBe(false)
    forgetIgnored(ROOT)
    expect(statusMatters(ROOT, [P('logs\\x.log')])).toBe(true)
  })
  it('the same entries are the same listing', () => {
    expect(sameEntries([f('a')], [f('a')])).toBe(true)
    expect(sameEntries([f('a')], [d('a')])).toBe(false)
    expect(sameEntries([f('a')], [f('a'), f('b')])).toBe(false)
  })
})

// Settings shared by these tests stay as they were.
afterEach(() => {
  settings.explorerCompactFolders = true
})
