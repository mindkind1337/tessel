// The file explorer (ExplorerPanel.vue) on a Live Share host's project
// (an lshare:// root): read-only until the host gives "Edit files", live;
// the access taken away or a host's Tessel too old said instead of the tree;
// nothing that runs on this computer offered; and a local project exactly
// as before.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import ExplorerTimeline from '../components/ExplorerTimeline.vue'
import { setLshareAccess, forgetLshareAccess } from '../liveShareGuestAccess'
import { setActiveEditor, clearActiveEditor } from '../editor/activeEditor'
import { settings } from '../settings'

const ROOT = 'lshare://p1'
let w
let writeText

function entries(root) {
  return [
    { name: 'src', path: `${root}\\src`, dir: true },
    { name: 'a.js', path: `${root}\\a.js`, dir: false }
  ]
}
function api(over = {}) {
  const a = {
    watch: vi.fn(),
    unwatch: vi.fn(),
    list: vi.fn(async ({ root, dir }) => ({ ok: true, entries: dir === root ? entries(root) : [] })),
    status: vi.fn(async () => ({ ok: true, repo: true, files: {} })),
    create: vi.fn(async () => ({ ok: true, path: `${ROOT}\\new.js` })),
    rename: vi.fn(async () => ({ ok: true, path: `${ROOT}\\b.js` })),
    trash: vi.fn(async () => ({ ok: true })),
    reveal: vi.fn(async () => ({ ok: true })),
    ...over
  }
  window.shellApi = { explorer: a }
  return a
}
async function make(props = {}) {
  w = mount(ExplorerPanel, { props: { root: ROOT, ...props }, attachTo: document.body })
  await flushPromises()
  return w
}
const has = (sel) => w.find(`[data-test="${sel}"]`).exists()
async function openMenuOn(name) {
  const row = w.findAll('.explorer-row').find((r) => r.find('.explorer-name').exists() && r.find('.explorer-name').text() === name)
  await row.trigger('contextmenu', { clientX: 10, clientY: 10 })
  await nextTick()
}
const menuItems = () => w.findAll('.explorer-menu [role="menuitem"]').map((b) => b.text())

beforeEach(() => {
  forgetLshareAccess()
  writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => {
  w?.unmount()
  w = null
  delete window.shellApi
  forgetLshareAccess()
  document.body.innerHTML = ''
})

describe("a Live Share host's project", () => {
  it('is read-only until the host gives Edit files: nothing to create, rename or move to the Recycle Bin', async () => {
    const a = api()
    await make()
    expect(w.findAll('.explorer-name').map((n) => n.text())).toEqual(['src', 'a.js'])
    expect(has('explorer-read-only')).toBe(true)
    expect(has('explorer-head-new-file')).toBe(false)
    expect(has('explorer-head-new-folder')).toBe(false)
    expect(has('open-editors-new-file')).toBe(false)
    await openMenuOn('a.js')
    expect(has('explorer-menu-new-file')).toBe(false)
    expect(has('explorer-menu-rename')).toBe(false)
    expect(has('explorer-menu-trash')).toBe(false)
    // F2 and Delete do nothing either.
    await w.find('.explorer-files').trigger('keydown', { key: 'Delete' })
    await w.find('.explorer-files').trigger('keydown', { key: 'F2' })
    expect(w.find('.explorer-confirm').exists()).toBe(false)
    expect(w.find('.explorer-edit-input').exists()).toBe(false)
    expect(a.trash).not.toHaveBeenCalled()
  })

  it('becomes editable when the host gives Edit files, and read-only again when it takes it back, live', async () => {
    api()
    await make()
    setLshareAccess('p1', { edit: true })
    await flushPromises()
    expect(has('explorer-read-only')).toBe(false)
    expect(has('explorer-head-new-file')).toBe(true)
    await openMenuOn('a.js')
    expect(has('explorer-menu-rename')).toBe(true)
    expect(has('explorer-menu-trash')).toBe(true)
    // A rename under way is dropped the moment the right goes.
    await w.find('[data-test="explorer-menu-rename"]').trigger('click')
    await nextTick()
    expect(w.find('.explorer-edit-input').exists()).toBe(true)
    setLshareAccess('p1', { edit: false })
    await flushPromises()
    expect(w.find('.explorer-edit-input').exists()).toBe(false)
    expect(has('explorer-head-new-file')).toBe(false)
    expect(window.shellApi.explorer.rename).not.toHaveBeenCalled()
  })

  it("the host's answer saying read-only wins over the right given", async () => {
    const a = api()
    setLshareAccess('p1', { edit: true })
    a.list.mockImplementation(async ({ root, dir }) => ({ ok: true, readOnly: true, entries: dir === root ? entries(root) : [] }))
    await make()
    expect(has('explorer-read-only')).toBe(true)
    expect(has('explorer-head-new-file')).toBe(false)
    // A later answer that no longer says so: editable.
    a.list.mockImplementation(async ({ root, dir }) => ({ ok: true, readOnly: false, entries: dir === root ? entries(root) : [] }))
    await w.get('[data-test="explorer-refresh"]').trigger('click')
    await flushPromises()
    expect(has('explorer-head-new-file')).toBe(true)
  })

  it('"You no longer have access to this project" when the window says so: the files go; given back, they come back', async () => {
    const a = api()
    await make()
    setLshareAccess('p1', { state: 'no-access' })
    await flushPromises()
    expect(w.get('[data-test="explorer-access"]').text()).toContain('You no longer have access to this project.')
    expect(w.findAll('.explorer-name')).toHaveLength(0)
    expect(has('explorer-search')).toBe(false)
    const calls = a.list.mock.calls.length
    setLshareAccess('p1', { state: 'ok' })
    await flushPromises()
    expect(a.list.mock.calls.length).toBeGreaterThan(calls)
    expect(w.findAll('.explorer-name').map((n) => n.text())).toEqual(['src', 'a.js'])
  })

  it("the host's own refusal says the same, and Retry asks again", async () => {
    const a = api({ list: vi.fn(async () => ({ ok: false, code: 'no-access', error: 'refused' })) })
    await make()
    expect(w.get('[data-test="explorer-access"]').text()).toContain('You no longer have access to this project.')
    a.list.mockImplementation(async ({ root, dir }) => ({ ok: true, entries: dir === root ? entries(root) : [] }))
    await w.get('[data-test="panel-retry"]').trigger('click')
    await flushPromises()
    expect(has('explorer-access')).toBe(false)
    expect(w.findAll('.explorer-name').map((n) => n.text())).toEqual(['src', 'a.js'])
  })

  it("a project whose files are on the host's SSH server says so calmly: no red error, no Retry", async () => {
    api({ list: vi.fn(async () => ({ ok: false, code: 'remote-project' })) })
    await make()
    const box = w.get('[data-test="explorer-access"]')
    expect(box.text()).toMatch(/SSH server/)
    expect(box.text()).not.toMatch(/no longer have access/)
    expect(box.attributes('data-test')).toBe('explorer-access')
    expect(w.find('[data-test="panel-error"]').exists()).toBe(false)
    expect(w.find('[data-test="panel-retry"]').exists()).toBe(false)
  })

  it("a host's Tessel too old to share files says so", async () => {
    api({ list: vi.fn(async () => ({ ok: false, code: 'outdated-host' })) })
    await make()
    expect(w.get('[data-test="explorer-access"]').text()).toMatch(/host’s Tessel is too old/)
  })

  it('offers nothing that runs on this computer (terminal here, reveal, VS Code), and copies paths relative to the project', async () => {
    const a = api()
    setLshareAccess('p1', { edit: true })
    await make()
    await openMenuOn('a.js')
    expect(has('explorer-menu-terminal')).toBe(false)
    expect(has('explorer-menu-reveal')).toBe(false)
    expect(has('explorer-menu-external')).toBe(false)
    const copy = w.findAll('.explorer-menu [role="menuitem"]').find((b) => b.text() === 'Copy path')
    await copy.trigger('click')
    expect(writeText).toHaveBeenCalledWith('a.js')
    expect(w.emitted('terminal-here')).toBeUndefined()
    expect(w.emitted('open-external')).toBeUndefined()
    expect(a.reveal).not.toHaveBeenCalled()
  })

  it("its header shows the host's name for the project when given", async () => {
    api()
    await make({ rootTitle: 'Website' })
    expect(w.get('[data-test="explorer-folder-head"] .explorer-title').text()).toBe('Website')
  })
})

describe('a local project', () => {
  it('is exactly as before: editable, every action, answers never make it read-only', async () => {
    const a = api({
      list: vi.fn(async ({ root, dir }) => ({ ok: true, readOnly: true, code: 'no-access', entries: dir === root ? entries(root) : [] }))
    })
    await make({ root: 'C:\\proj' })
    expect(has('explorer-read-only')).toBe(false)
    expect(has('explorer-access')).toBe(false)
    expect(has('explorer-head-new-file')).toBe(true)
    await openMenuOn('a.js')
    expect(has('explorer-menu-terminal')).toBe(true)
    expect(has('explorer-menu-reveal')).toBe(true)
    expect(has('explorer-menu-external')).toBe(true)
    expect(has('explorer-menu-rename')).toBe(true)
    expect(menuItems()).toContain('Open a terminal here')
    await w.find('[data-test="explorer-menu-terminal"]').trigger('click')
    expect(w.emitted('terminal-here')[0][0]).toBe('C:\\proj')
    expect(a.list).toHaveBeenCalled()
  })

  it('the readOnly prop alone makes it read-only', async () => {
    api()
    await make({ root: 'C:\\proj', readOnly: true })
    expect(has('explorer-head-new-file')).toBe(false)
    await openMenuOn('a.js')
    expect(has('explorer-menu-trash')).toBe(false)
    // Still a local project: its local actions stay.
    expect(has('explorer-menu-terminal')).toBe(true)
  })
})

describe("the Timeline of a Live Share host's file", () => {
  afterEach(() => {
    clearActiveEditor()
    settings.explorerTimelineShown = false
  })
  it('reads its git history and the host’s Local History through the session (none is kept here)', async () => {
    window.shellApi = {
      scm: { fileHistory: vi.fn(async () => ({ ok: true, items: [], hasMore: false, uncommitted: false, rel: 'a.js' })) },
      localHistory: { list: vi.fn(async () => ({ ok: true, entries: [{ id: 'abc123def', source: 'save', timestamp: Date.now() - 60000 }] })), add: vi.fn() }
    }
    settings.explorerTimelineShown = true
    setActiveEditor({ paneId: 'e1', editor: { getModel: () => ({}), getPosition: () => null }, path: 'lshare://p1\\a.js' })
    w = mount(ExplorerTimeline, { attachTo: document.body })
    await new Promise((r) => setTimeout(r, 5))
    await flushPromises()
    expect(window.shellApi.scm.fileHistory).toHaveBeenCalled()
    // Main sends it to the host (index.js: guestFs.localHistoryList).
    expect(window.shellApi.localHistory.list).toHaveBeenCalledWith({ path: 'lshare://p1\\a.js' })
    expect(window.shellApi.localHistory.add).not.toHaveBeenCalled()
  })
})
