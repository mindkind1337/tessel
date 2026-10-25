// The Files tree kept per project (explorerTreeCache.js, ExplorerPanel.vue):
// a project shown again, or the panel remounted (a host connected again),
// shows its tree at once (open folders, selection), never an empty
// "Loading…"; its open folders are then read again in the background and
// only what changed is applied. The git letters never hold the listing, and
// a slow or failed git status leaves the tree and the last letters as they
// are. An SSH project's open folders are also kept on disk (names only).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import { saveTree, loadTree, forgetTree, clearTreeCache, DISK_MAX_ENTRIES } from '../explorerTreeCache'

const ROOT = 'C:\\proj'
const OTHER = 'C:\\other'
const P = (rel, root = ROOT) => `${root}\\${rel}`
const d = (rel, root = ROOT) => ({ name: rel.split('\\').pop(), path: P(rel, root), dir: true })
const f = (rel, root = ROOT) => ({ name: rel.split('\\').pop(), path: P(rel, root), dir: false })

let w = null
afterEach(() => {
  w?.unmount()
  w = null
  delete window.shellApi
  clearTreeCache()
  try {
    localStorage.clear()
  } catch {
    /* none */
  }
})

// A fake explorer API; listMany can be held (hold()) to see what shows
// before the host answers.
function makeApi(entries, { status = () => ({ ok: true, repo: true, files: {} }) } = {}) {
  let held = null
  const api = {
    watch: vi.fn(),
    unwatch: vi.fn(),
    list: vi.fn(async ({ dir }) => (entries[dir] ? { ok: true, entries: entries[dir] } : { ok: false, error: 'gone' })),
    listMany: vi.fn(async ({ dirs }) => {
      if (held) await held.promise
      return { ok: true, results: dirs.map((dir) => (entries[dir] ? { dir, ok: true, entries: entries[dir] } : { dir, ok: false, error: 'gone' })) }
    }),
    status: vi.fn(async (q) => status(q)),
    sparse: vi.fn(async () => ({ ok: true, sparse: false, dirs: [] })),
    onChanged: () => () => {},
    hold() {
      let release
      held = { promise: new Promise((r) => (release = r)) }
      held.release = () => {
        const h = held
        held = null
        release()
        return h
      }
      return held
    }
  }
  window.shellApi = { explorer: api }
  return api
}
const names = () => w.findAll('.explorer-row .explorer-name').map((n) => n.text())
const row = (path) => w.findAll('.explorer-row').find((r) => r.attributes('data-path') === path)
const loadingShown = () => w.find('[data-test="panel-loading"]').exists() || w.find('[data-test="explorer-dir-loading"]').exists()

async function openSrc(api) {
  w = mount(ExplorerPanel, { props: { root: ROOT } })
  await flushPromises()
  await row(P('src')).trigger('click')
  await new Promise((r) => setTimeout(r, 5))
  await flushPromises()
  await row(P('src\\a.lua')).trigger('click')
  await flushPromises()
  return api
}

describe('a project shown again', () => {
  it('comes back at once as it was (open folders, selection), then only what changed is applied', async () => {
    const entries = {
      [ROOT]: [d('src'), f('server.cfg')],
      [P('src')]: [f('src\\a.lua')],
      [OTHER]: [f('readme.md', OTHER)]
    }
    const api = makeApi(entries)
    await openSrc(api)
    expect(names()).toEqual(['src', 'a.lua', 'server.cfg'])
    await w.setProps({ root: OTHER })
    await flushPromises()
    expect(names()).toEqual(['readme.md'])
    // Meanwhile a file appeared on disk; the host's answer is held.
    entries[P('src')] = [f('src\\a.lua'), f('src\\b.lua')]
    const held = api.hold()
    api.list.mockClear()
    api.listMany.mockClear()
    await w.setProps({ root: ROOT })
    await flushPromises()
    // At once, before any answer: the tree as it was, never "Loading…".
    expect(names()).toEqual(['src', 'a.lua', 'server.cfg'])
    expect(row(P('src\\a.lua')).classes()).toContain('selected')
    expect(api.list).not.toHaveBeenCalled()
    // Its open folders read again, in the background, together.
    expect(api.listMany).toHaveBeenCalledTimes(1)
    expect(api.listMany.mock.calls[0][0]).toMatchObject({ dirs: [ROOT, P('src')], background: true })
    expect(w.find('[data-test="explorer-dir-refreshing"]').exists()).toBe(true)
    held.release()
    await flushPromises()
    expect(names()).toEqual(['src', 'a.lua', 'b.lua', 'server.cfg'])
    expect(row(P('src\\a.lua')).classes()).toContain('selected')
    expect(w.find('[data-test="explorer-dir-refreshing"]').exists()).toBe(false)
  })

  it('the panel remounted (a host connected again): no empty "Loading…", its folders still open', async () => {
    const entries = { [ROOT]: [d('src')], [P('src')]: [f('src\\a.lua')] }
    const api = await openSrc(makeApi(entries))
    w.unmount()
    const held = api.hold()
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    expect(names()).toEqual(['src', 'a.lua'])
    expect(loadingShown()).toBe(false)
    held.release()
    await flushPromises()
    expect(names()).toEqual(['src', 'a.lua'])
  })

  it('another window\'s (or a test\'s) reads are not given to this one', async () => {
    const entries = { [ROOT]: [d('src')], [P('src')]: [f('src\\a.lua')] }
    await openSrc(makeApi(entries))
    w.unmount()
    const api = makeApi(entries)
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ dir: ROOT }))
    expect(names()).toEqual(['src'])
  })
})

describe('the git letters', () => {
  it('are asked in the background and never hold the listing; slow or failed, the tree and the last letters stay', async () => {
    const entries = { [ROOT]: [d('src'), f('a.txt')], [P('src')]: [f('src\\b.txt')] }
    let answer = { ok: true, repo: true, files: { [P('a.txt').toLowerCase()]: 'M' } }
    const api = makeApi(entries, { status: () => answer })
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    expect(api.status).toHaveBeenCalled()
    for (const [q] of api.status.mock.calls) expect(q.background).toBe(true)
    expect(row(P('a.txt')).classes()).toContain('git-M')
    // Slow: never answers. The tree is there and keeps its letters.
    answer = new Promise(() => {})
    await w.setProps({ root: OTHER })
    await w.setProps({ root: ROOT })
    await flushPromises()
    expect(names()).toEqual(['src', 'a.txt'])
    expect(row(P('a.txt')).classes()).toContain('git-M')
    expect(loadingShown()).toBe(false)
  })
})

describe('kept on disk for an SSH project', () => {
  const SSH = 'ssh://ssh-h/srv/app'
  const S = (rel) => `${SSH}\\${rel}`
  it('its open folders\' names come back after a restart (a new window, nothing in memory), no letters', () => {
    const owner = {}
    saveTree(SSH, { nodes: { [SSH]: [{ name: 'src', path: S('src'), dir: true }, { name: 'l', path: S('l'), dir: false, link: true }], [S('src')]: [{ name: 'a.lua', path: S('src\\a.lua'), dir: false }], [S('closed')]: [{ name: 'x', path: S('closed\\x'), dir: false }] }, open: [S('src')], selected: S('src\\a.lua'), scrollTop: 40, status: { x: 'M' }, repo: true }, owner)
    clearTreeCache()
    const back = loadTree(SSH, {})
    expect(back.nodes[SSH]).toEqual([{ name: 'src', path: S('src'), dir: true }, { name: 'l', path: S('l'), dir: false, link: true }])
    expect(back.nodes[S('src')]).toEqual([{ name: 'a.lua', path: S('src\\a.lua'), dir: false }])
    // Only the open folders (and the project's own) are kept on disk.
    expect(back.nodes[S('closed')]).toBeUndefined()
    expect(back).toMatchObject({ open: [S('src')], selected: S('src\\a.lua'), scrollTop: 40, status: {}, repo: false })
    forgetTree(SSH)
    clearTreeCache()
    expect(loadTree(SSH, {})).toBe(null)
  })

  it('bounded, and never a local or a Live Share project', () => {
    const big = Array.from({ length: DISK_MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, path: S(`f${i}`), dir: false }))
    saveTree(SSH, { nodes: { [SSH]: big }, open: [] })
    clearTreeCache()
    expect(loadTree(SSH, {})).toBe(null)
    saveTree('lshare://p1', { nodes: { 'lshare://p1': [] }, open: [] })
    saveTree(ROOT, { nodes: { [ROOT]: [] }, open: [] })
    clearTreeCache()
    expect(loadTree('lshare://p1')).toBe(null)
    expect(loadTree(ROOT)).toBe(null)
    expect(Object.keys(localStorage).some((k) => k.includes('lshare') || k.includes('proj'))).toBe(false)
  })
})
