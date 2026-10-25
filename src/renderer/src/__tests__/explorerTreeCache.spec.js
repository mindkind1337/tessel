// The Files tree kept per project (explorerTreeCache.js, ExplorerPanel.vue):
// a project shown again, or the panel remounted (a host connected again),
// shows its tree at once (open folders, selection), never an empty
// "Loading…"; its open folders are then read again in the background and
// only what changed is applied. The git letters never hold the listing, and
// a slow or failed git status leaves the tree and the last letters as they
// are. An SSH project's open folders are also kept on disk (names only).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { mount, flushPromises } from '@vue/test-utils'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import { saveTree, loadTree, forgetTree, forgetHostTrees, clearTreeCache, DISK_MAX_ENTRIES, DISK_MAX_BYTES } from '../explorerTreeCache'

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
    // Kept rows are dimmed and the header says so until they are read again.
    expect(row(P('src\\a.lua')).classes()).toContain('stale')
    expect(w.find('[data-test="explorer-stale"]').exists()).toBe(true)
    held.release()
    await flushPromises()
    expect(names()).toEqual(['src', 'a.lua', 'b.lua', 'server.cfg'])
    expect(row(P('src\\a.lua')).classes()).not.toContain('stale')
    expect(w.find('[data-test="explorer-stale"]').exists()).toBe(false)
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

  it('an answer for the project shown before never sets this one\'s pace (time taken, failures)', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'ExplorerPanel.vue'), 'utf8').replace(/\r\n/g, '\n')
    const start = src.indexOf('async function loadStatus()')
    const body = src.slice(start, src.indexOf('\n}\n', start))
    const current = body.indexOf('if (!stillCurrent(revision, root)) return')
    expect(current).toBeGreaterThan(0)
    expect(body.indexOf('statusCost =')).toBeGreaterThan(current)
    expect(body.indexOf('statusFails =')).toBeGreaterThan(current)
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

  it('too many bytes for one project: not kept on disk, and an older copy goes', () => {
    saveTree(SSH, { nodes: { [SSH]: [{ name: 'small', path: S('small'), dir: false }] }, open: [] })
    const long = 'n'.repeat(400)
    const fat = Array.from({ length: Math.ceil(DISK_MAX_BYTES / 400) + 10 }, (_, i) => ({ name: `${long}${i}`, path: S(`${long}${i}`), dir: false }))
    saveTree(SSH, { nodes: { [SSH]: fat }, open: [] })
    clearTreeCache()
    expect(loadTree(SSH, {})).toBe(null)
  })

  it('the caps count bytes (UTF-8), not characters: names in another script are not let past them', () => {
    saveTree(SSH, { nodes: { [SSH]: [{ name: 'small', path: S('small'), dir: false }] }, open: [] })
    // 3 bytes per character: well under the cap in characters, over it in bytes.
    const long = '日'.repeat(400)
    const wide = Array.from({ length: 250 }, (_, i) => ({ name: `${long}${i}`, path: S(`${long}${i}`), dir: false }))
    expect(JSON.stringify(wide.map((e) => [e.name, 0])).length).toBeLessThan(DISK_MAX_BYTES)
    saveTree(SSH, { nodes: { [SSH]: wide }, open: [] })
    clearTreeCache()
    expect(loadTree(SSH, {})).toBe(null)
  })

  it('its list of copies could not be written: the copy goes too (never one the caps do not count)', () => {
    const real = Storage.prototype.setItem
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (k, v) {
      if (k === 'tessel.explorerTree.v2.index') throw new DOMException('full', 'QuotaExceededError')
      return real.call(this, k, v)
    })
    saveTree(SSH, { nodes: { [SSH]: [{ name: 'x', path: S('x'), dir: false }] }, open: [] })
    spy.mockRestore()
    expect(Object.keys(localStorage).some((k) => k.startsWith('tessel.explorerTree.v2:'))).toBe(false)
    clearTreeCache()
    expect(loadTree(SSH, {})).toBe(null)
  })

  it('an SSH path is matched exactly (POSIX names have case)', () => {
    saveTree('ssh://ssh-h/srv/App', { nodes: { 'ssh://ssh-h/srv/App': [] }, open: [] }, 'o')
    expect(loadTree('ssh://ssh-h/srv/app', 'o')).toBe(null)
    expect(loadTree('ssh://ssh-h/srv/App', 'o')).toBeTruthy()
    clearTreeCache()
    expect(loadTree('ssh://ssh-h/srv/app', {})).toBe(null)
  })

  it('the storage full (another user): the oldest of its own copies go, never another key', () => {
    localStorage.setItem('other.app', 'keep me')
    const A = 'ssh://ssh-h/srv/a'
    const B = 'ssh://ssh-h/srv/b'
    const C = 'ssh://ssh-h/srv/c'
    const one = (r) => ({ nodes: { [r]: [{ name: 'x', path: `${r}\\x`, dir: false }] }, open: [] })
    saveTree(A, one(A))
    saveTree(B, one(B))
    const real = Storage.prototype.setItem
    let refused = 0
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (k, v) {
      if (k.includes('/srv/c') && !refused++) throw new DOMException('full', 'QuotaExceededError')
      return real.call(this, k, v)
    })
    saveTree(C, one(C))
    spy.mockRestore()
    clearTreeCache()
    expect(loadTree(A, {})).toBe(null)
    expect(loadTree(B, {})).toBeTruthy()
    expect(loadTree(C, {})).toBeTruthy()
    expect(localStorage.getItem('other.app')).toBe('keep me')
  })

  it('a host removed takes its projects\' trees along', () => {
    const H1 = 'ssh://ssh-one/srv/a'
    const H2 = 'ssh://ssh-two/srv/b'
    saveTree(H1, { nodes: { [H1]: [] }, open: [] })
    saveTree(H2, { nodes: { [H2]: [] }, open: [] })
    forgetHostTrees('ssh-one')
    clearTreeCache()
    expect(loadTree(H1, {})).toBe(null)
    expect(loadTree(H2, {})).toBeTruthy()
  })
})

describe('a tree kept a long while ago', () => {
  it('its project\'s folder is read in your turn (the rows stay meanwhile), the open ones behind it', async () => {
    const entries = { [ROOT]: [d('src')], [P('src')]: [f('src\\a.lua')] }
    const api = makeApi(entries)
    saveTree(ROOT, { nodes: { [ROOT]: entries[ROOT], [P('src')]: entries[P('src')] }, open: [P('src')], selected: null, scrollTop: 0, status: {}, repo: false }, api, Date.now() - 11 * 60 * 1000)
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ dir: ROOT }))
    expect(api.list.mock.calls.find(([q]) => q.dir === ROOT)[0].background).toBeUndefined()
    expect(names()).toEqual(['src', 'a.lua'])
  })
})
