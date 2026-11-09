// The file explorer's drag and drop and "Download…": a row dragged onto a
// folder moves there, files dropped from Windows are copied in, and every
// file or folder (local or remote) can be downloaded.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import { resetSettings } from '../settings'

const ROOT = 'C:\\proj'
const ENTRIES = {
  [ROOT]: [
    { name: 'app', path: `${ROOT}\\app`, dir: true },
    { name: 'docs', path: `${ROOT}\\docs`, dir: true },
    { name: 'README.md', path: `${ROOT}\\README.md`, dir: false }
  ],
  [`${ROOT}\\app`]: [{ name: 'main.js', path: `${ROOT}\\app\\main.js`, dir: false }],
  [`${ROOT}\\docs`]: [{ name: 'guide.md', path: `${ROOT}\\docs\\guide.md`, dir: false }]
}
function api(extra = {}) {
  const explorer = {
    watch: vi.fn(),
    unwatch: vi.fn(),
    list: vi.fn(async ({ dir }) => ({ ok: true, entries: ENTRIES[dir || ROOT] || [] })),
    listMany: undefined,
    status: vi.fn(async () => ({ ok: true, repo: true, files: {} })),
    sparse: vi.fn(async () => ({ ok: true, sparse: false, dirs: [] })),
    searchNames: vi.fn(async () => ({ ok: true, results: [] })),
    move: vi.fn(async ({ path, dir }) => ({ ok: true, path: `${dir}\\${path.split('\\').pop()}` })),
    importPaths: vi.fn(async ({ paths }) => ({ ok: true, copied: paths.map((p) => p.split('\\').pop()), skipped: [], tooLarge: [], failed: [], cut: false })),
    download: vi.fn(async () => ({ ok: true, path: 'C:\\Users\\me\\Downloads\\x' })),
    ...extra
  }
  window.shellApi = { explorer, pathForFile: (f) => f.fakePath || '' }
  return explorer
}
// A DataTransfer as Chromium gives it (jsdom has none).
function transfer({ files = [] } = {}) {
  const data = {}
  const dt = {
    types: files.length ? ['Files'] : [],
    files,
    effectAllowed: 'all',
    dropEffect: 'none',
    setData(k, v) {
      data[k] = v
      if (!dt.types.includes(k)) dt.types.push(k)
    },
    getData: (k) => data[k] || ''
  }
  return dt
}
const row = (w, path) => w.find(`.explorer-row[data-path="${path.replace(/\\/g, '\\\\')}"]`)

describe('drag and drop in the file explorer', () => {
  let w
  afterEach(() => {
    w?.unmount()
    w = null
    delete window.shellApi
    resetSettings()
  })

  it('a row dropped on a folder moves there, and the tree shows it', async () => {
    const ex = api()
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    const dt = transfer()
    await row(w, `${ROOT}\\README.md`).trigger('dragstart', { dataTransfer: dt })
    // A terminal still gets the path to type.
    expect(dt.getData('text/x-tessel-path')).toBe(`${ROOT}\\README.md`)
    expect(dt.effectAllowed).toBe('copyMove')
    await row(w, `${ROOT}\\docs`).trigger('dragover', { dataTransfer: dt })
    expect(dt.dropEffect).toBe('move')
    expect(row(w, `${ROOT}\\docs`).classes()).toContain('drop-target')
    await row(w, `${ROOT}\\docs`).trigger('drop', { dataTransfer: dt })
    await flushPromises()
    expect(ex.move).toHaveBeenCalledWith({ root: ROOT, path: `${ROOT}\\README.md`, dir: `${ROOT}\\docs` })
    expect(w.emitted('toast').at(-1)[0]).toContain('docs')
    expect(w.find('.drop-target').exists()).toBe(false)
  })

  it('a file row stands for its folder; its own folder and a folder into itself are not offered', async () => {
    const ex = api()
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    // A folder onto itself: no drop.
    let dt = transfer()
    await row(w, `${ROOT}\\app`).trigger('dragstart', { dataTransfer: dt })
    await row(w, `${ROOT}\\app`).trigger('dragover', { dataTransfer: dt })
    expect(dt.dropEffect).toBe('none')
    await row(w, `${ROOT}\\app`).trigger('drop', { dataTransfer: dt })
    // A file onto a file of its own folder: no drop.
    dt = transfer()
    await row(w, `${ROOT}\\README.md`).trigger('dragstart', { dataTransfer: dt })
    await row(w, `${ROOT}\\README.md`).trigger('dragover', { dataTransfer: dt })
    expect(dt.dropEffect).toBe('none')
    await flushPromises()
    expect(ex.move).not.toHaveBeenCalled()
    // A folder onto a file at the top: the project's folder, already its own.
    dt = transfer()
    await row(w, `${ROOT}\\docs`).trigger('dragstart', { dataTransfer: dt })
    await row(w, `${ROOT}\\README.md`).trigger('dragover', { dataTransfer: dt })
    expect(dt.dropEffect).toBe('none')
  })

  it('files dropped from Windows are copied into the folder under the pointer', async () => {
    const ex = api()
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    const dt = transfer({ files: [{ name: 'a.png', fakePath: 'D:\\pics\\a.png' }, { name: 'b', fakePath: 'D:\\pics\\b' }] })
    await row(w, `${ROOT}\\app`).trigger('dragover', { dataTransfer: dt })
    expect(dt.dropEffect).toBe('copy')
    await row(w, `${ROOT}\\app`).trigger('drop', { dataTransfer: dt })
    await flushPromises()
    expect(ex.importPaths).toHaveBeenCalledWith({ root: ROOT, dir: `${ROOT}\\app`, paths: ['D:\\pics\\a.png', 'D:\\pics\\b'] })
    expect(w.emitted('toast').at(-1)[0]).toMatch(/a\.png/)
    // On the tree's empty space: the project's own folder.
    await w.get('[data-test="explorer-tree"]').trigger('drop', { dataTransfer: transfer({ files: [{ name: 'c', fakePath: 'D:\\c' }] }) })
    await flushPromises()
    expect(ex.importPaths).toHaveBeenLastCalledWith({ root: ROOT, dir: ROOT, paths: ['D:\\c'] })
  })

  it('a read-only project takes no drop', async () => {
    const ex = api()
    w = mount(ExplorerPanel, { props: { root: ROOT, readOnly: true } })
    await flushPromises()
    const dt = transfer({ files: [{ name: 'a', fakePath: 'D:\\a' }] })
    await row(w, `${ROOT}\\app`).trigger('dragover', { dataTransfer: dt })
    expect(dt.dropEffect).toBe('none')
    await row(w, `${ROOT}\\app`).trigger('drop', { dataTransfer: dt })
    await flushPromises()
    expect(ex.importPaths).not.toHaveBeenCalled()
  })
})

describe('dragging a file out to Windows', () => {
  let w
  afterEach(() => {
    w?.unmount()
    w = null
    delete window.shellApi
    resetSettings()
  })
  const URL1 = `http://127.0.0.1:5000/dl/${'a'.repeat(64)}`
  function outApi() {
    return api({
      dragOutPrepare: vi.fn(async () => ({ ok: true, url: URL1, name: 'README.md' })),
      dragOutRevoke: vi.fn()
    })
  }

  it('a pressed file gets its one-file address, and the drag carries it as a DownloadURL', async () => {
    const ex = outApi()
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    await row(w, `${ROOT}\\README.md`).trigger('mousedown', { button: 0 })
    await flushPromises()
    expect(ex.dragOutPrepare).toHaveBeenCalledWith({ root: ROOT, file: `${ROOT}\\README.md` })
    const dt = transfer()
    await row(w, `${ROOT}\\README.md`).trigger('dragstart', { dataTransfer: dt })
    expect(dt.getData('DownloadURL')).toBe(`application/octet-stream:README.md:${URL1}`)
    // Still a path for a terminal, still a move inside the tree.
    expect(dt.getData('text/x-tessel-path')).toBe(`${ROOT}\\README.md`)
    // Dropped on the desktop: the address stays for the download.
    dt.dropEffect = 'copy'
    await row(w, `${ROOT}\\README.md`).trigger('dragend', { dataTransfer: dt })
    expect(ex.dragOutRevoke).not.toHaveBeenCalled()
  })

  it('given up when the drag ends without a drop, or when the row is only clicked; folders never go out', async () => {
    const ex = outApi()
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    await row(w, `${ROOT}\\README.md`).trigger('mousedown', { button: 0 })
    await flushPromises()
    const dt = transfer()
    await row(w, `${ROOT}\\README.md`).trigger('dragstart', { dataTransfer: dt })
    await row(w, `${ROOT}\\README.md`).trigger('dragend', { dataTransfer: dt })
    expect(ex.dragOutRevoke).toHaveBeenCalledWith(URL1)
    ex.dragOutRevoke.mockClear()
    await row(w, `${ROOT}\\README.md`).trigger('mousedown', { button: 0 })
    await flushPromises()
    await row(w, `${ROOT}\\README.md`).trigger('click')
    expect(ex.dragOutRevoke).toHaveBeenCalledWith(URL1)
    ex.dragOutPrepare.mockClear()
    await row(w, `${ROOT}\\docs`).trigger('mousedown', { button: 0 })
    const fdt = transfer()
    await row(w, `${ROOT}\\docs`).trigger('dragstart', { dataTransfer: fdt })
    expect(ex.dragOutPrepare).not.toHaveBeenCalled()
    expect(fdt.getData('DownloadURL')).toBe('')
  })

  it('dropped inside Tessel (here, a folder of the tree): the address is given up at once', async () => {
    const ex = outApi()
    w = mount(ExplorerPanel, { props: { root: ROOT }, attachTo: document.body })
    await flushPromises()
    await row(w, `${ROOT}\\README.md`).trigger('mousedown', { button: 0 })
    await flushPromises()
    const dt = transfer()
    await row(w, `${ROOT}\\README.md`).trigger('dragstart', { dataTransfer: dt })
    await row(w, `${ROOT}\\docs`).trigger('dragover', { dataTransfer: dt })
    await row(w, `${ROOT}\\docs`).trigger('drop', { dataTransfer: dt })
    await flushPromises()
    expect(ex.dragOutRevoke).toHaveBeenCalledWith(URL1)
    expect(ex.move).toHaveBeenCalled()
  })

  it('an address not ready yet: the drag goes on without it', async () => {
    let answer
    const ex = api({ dragOutPrepare: vi.fn(() => new Promise((r) => (answer = r))), dragOutRevoke: vi.fn() })
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    await row(w, `${ROOT}\\README.md`).trigger('mousedown', { button: 0 })
    const dt = transfer()
    await row(w, `${ROOT}\\README.md`).trigger('dragstart', { dataTransfer: dt })
    expect(dt.getData('DownloadURL')).toBe('')
    expect(dt.getData('text/x-tessel-path')).toBe(`${ROOT}\\README.md`)
    // Pressed elsewhere since: the late address is given up at once.
    await row(w, `${ROOT}\\app`).trigger('mousedown', { button: 0 })
    answer({ ok: true, url: URL1, name: 'README.md' })
    await flushPromises()
    expect(ex.dragOutRevoke).toHaveBeenCalledWith(URL1)
  })
})

describe('"Download…" in the file explorer', () => {
  let w
  afterEach(() => {
    w?.unmount()
    w = null
    delete window.shellApi
    resetSettings()
  })
  async function menuOn(path) {
    await row(w, path).trigger('contextmenu', { clientX: 10, clientY: 10 })
    return w.find('[data-test="explorer-menu-download"]')
  }

  it('a local file and a local folder both offer it', async () => {
    const ex = api()
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    let item = await menuOn(`${ROOT}\\README.md`)
    expect(item.exists()).toBe(true)
    await item.trigger('click')
    await flushPromises()
    expect(ex.download).toHaveBeenCalledWith({ file: `${ROOT}\\README.md`, root: ROOT, folder: false })
    item = await menuOn(`${ROOT}\\docs`)
    expect(item.exists()).toBe(true)
    await item.trigger('click')
    await flushPromises()
    expect(ex.download).toHaveBeenLastCalledWith({ file: `${ROOT}\\docs`, root: ROOT, folder: true })
    expect(w.emitted('toast').at(-1)[0]).toContain('C:\\Users\\me\\Downloads\\x')
  })

  it('a folder shows its progress while it downloads', async () => {
    let finish
    let progress
    api({
      download: vi.fn(() => new Promise((r) => (finish = r))),
      onProgress: vi.fn((fn) => {
        progress = fn
        return () => {}
      })
    })
    w = mount(ExplorerPanel, { props: { root: ROOT } })
    await flushPromises()
    await (await menuOn(`${ROOT}\\docs`)).trigger('click')
    await flushPromises()
    progress({ kind: 'download', done: 3, name: 'x' })
    await flushPromises()
    expect(w.get('[data-test="explorer-transfer"]').text()).toMatch(/docs.*3/)
    finish({ ok: true, path: 'C:\\dl\\docs', files: 3, skipped: 0, tooLarge: 0, cut: false })
    await flushPromises()
    expect(w.find('[data-test="explorer-transfer"]').exists()).toBe(false)
  })
})
