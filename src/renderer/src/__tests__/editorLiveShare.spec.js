// The editor on a Live Share host's file (an lshare:// path): saved only
// while the host lets this guest edit (documents.js), Monaco read-only
// otherwise, live (EditorPane.vue); disconnected at the session's end with
// its text kept to copy; nothing that runs on this computer offered; a local
// file as before. A small stand-in for Monaco.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, reactive, nextTick } from 'vue'

class FakeModel {
  constructor(text, uri) {
    this.text = text
    this.uri = { fsPath: uri ? uri.path : '' }
    this.alt = 1
    this.next = 2
    this.subs = new Set()
    this.disposed = false
  }
  getValue() {
    return this.text
  }
  setValue(v) {
    this.text = v
  }
  getEOL() {
    return '\n'
  }
  getLanguageId() {
    return 'javascript'
  }
  getAlternativeVersionId() {
    return this.alt
  }
  onDidChangeContent(fn) {
    this.subs.add(fn)
    return { dispose: () => this.subs.delete(fn) }
  }
  type(text) {
    this.text += text
    this.alt = this.next++
    for (const fn of this.subs) fn()
  }
  getPositionAt() {
    return { lineNumber: 1, column: 1 }
  }
  pushStackElement() {}
  pushEditOperations() {}
  isDisposed() {
    return this.disposed
  }
  dispose() {
    this.disposed = true
  }
}

const models = new Map()
const editors = []
function fakeEditor() {
  const e = {
    model: null,
    options: [],
    onDidChangeModelContent: () => ({ dispose() {} }),
    onDidChangeCursorPosition: () => ({ dispose() {} }),
    onDidFocusEditorText: () => ({ dispose() {} }),
    updateOptions: vi.fn((o) => e.options.push(o)),
    setModel(m) {
      e.model = m
    },
    getModel: () => e.model,
    saveViewState: () => null,
    restoreViewState() {},
    focus() {},
    dispose() {},
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    createDecorationsCollection: () => ({ clear() {} })
  }
  editors.push(e)
  return e
}
const fakeMonaco = {
  Uri: { file: (p) => ({ path: p }) },
  Range: class {},
  languages: { getLanguages: () => [{ id: 'javascript', extensions: ['.js'] }] },
  editor: {
    EndOfLineSequence: { LF: 0, CRLF: 1 },
    getModel: (uri) => models.get(uri.path) || null,
    createModel: (text, _lang, uri) => {
      const m = new FakeModel(text, uri)
      if (uri) models.set(uri.path, m)
      return m
    },
    setModelLanguage: () => {},
    defineTheme: () => {},
    setTheme: () => {},
    create: () => fakeEditor()
  }
}
vi.mock('../editor/loadMonaco', () => ({
  loadMonaco: vi.fn(() => Promise.resolve(fakeMonaco)),
  monacoIfLoaded: () => fakeMonaco,
  textmateIfLoaded: () => null,
  outlineIfLoaded: () => null
}))

import { loadMonaco } from '../editor/loadMonaco'
import * as docsMod from '../editor/documents'
import EditorPane from '../components/EditorPane.vue'
import { setLshareAccess, endLshareSession, forgetLshareAccess } from '../liveShareGuestAccess'
import { settings } from '../settings'

const disk = new Map()
const writes = []
const toasts = []
let changed = null
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeAll(() => {
  window.shellApi = {
    editor: {
      read: async (file) => {
        if (!disk.has(file)) return { ok: false, error: 'The file was not found.', code: 'missing' }
        const d = disk.get(file)
        return { ok: true, text: d.text, sig: d.sig, ...(d.readOnly !== undefined ? { readOnly: d.readOnly } : {}) }
      },
      write: async ({ file, text }) => {
        const sig = `s${writes.length + 100}`
        disk.set(file, { ...disk.get(file), text, sig })
        writes.push({ file, text })
        return { ok: true, sig }
      },
      watch: async () => ({ ok: true }),
      setDirtyCount: () => {},
      onChanged: (fn) => {
        changed = fn
        return () => {}
      }
    },
    writeClipboard: vi.fn(),
    openFile: vi.fn(async () => ({ ok: true }))
  }
  docsMod.setEditorHooks({ toast: (t) => toasts.push(t) })
  docsMod.startDiskWatch()
})
beforeEach(() => {
  forgetLshareAccess()
  writes.length = 0
  toasts.length = 0
  settings.editorAutoSave = false
  settings.editorAutoSaveDelayMs = 500
})
afterEach(() => {
  forgetLshareAccess()
  settings.editorAutoSave = false
})

let seq = 0
async function openDoc(path, text = 'one\n', extra = {}) {
  disk.set(path, { text, sig: 's1', ...extra })
  const owner = `owner-${++seq}`
  docsMod.acquireDoc(path, owner)
  await flush()
  await flush()
  return owner
}

describe("a Live Share host's document", () => {
  it('is not saved until the host gives Edit files; saved once it does', async () => {
    const F = 'lshare://p1/src/a1.js'
    await openDoc(F)
    const d = docsMod.getDoc(F)
    expect(docsMod.isReadOnlyDoc(d)).toBe(true)
    docsMod.modelOf(F).type('mine')
    const res = await docsMod.saveDoc(F)
    expect(res).toMatchObject({ ok: false, readOnly: true })
    expect(toasts[0]).toMatch(/a1\.js is read-only: the host has not let you edit files/)
    expect(writes).toEqual([])
    setLshareAccess('p1', { edit: true })
    expect(docsMod.isReadOnlyDoc(d)).toBe(false)
    expect((await docsMod.saveDoc(F)).ok).toBe(true)
    expect(writes).toEqual([{ file: F, text: 'one\nmine' }])
  })

  it("a read saying read-only keeps it read-only whatever the right", async () => {
    const F = 'lshare://p1/a2.js'
    setLshareAccess('p1', { edit: true })
    await openDoc(F, 'x\n', { readOnly: true })
    expect(docsMod.getDoc(F).readOnly).toBe(true)
    docsMod.modelOf(F).type('y')
    expect((await docsMod.saveDoc(F)).ok).toBe(false)
    expect(writes).toEqual([])
  })

  it('read again once the host gives Edit files: editable unless the host still says read-only', async () => {
    const F = 'lshare://p1/b1.js'
    const G = 'lshare://p1/.claude/b2.json'
    await openDoc(F, 'x\n', { readOnly: true })
    await openDoc(G, '{}', { readOnly: true })
    expect(docsMod.getDoc(F).readOnly).toBe(true)
    // The host's answers with the right: b1 may be saved, b2 (runs things) not.
    disk.set(F, { ...disk.get(F), readOnly: false })
    setLshareAccess('p1', { edit: true })
    docsMod.recheckSharedDocs('p1')
    await flush()
    await flush()
    expect(docsMod.getDoc(F).readOnly).toBe(false)
    expect(docsMod.isReadOnlyDoc(docsMod.getDoc(F))).toBe(false)
    expect(docsMod.getDoc(G).readOnly).toBe(true)
  })

  it('auto-save never writes it while read-only', async () => {
    const F = 'lshare://p1/a3.js'
    settings.editorAutoSave = true
    await openDoc(F)
    docsMod.modelOf(F).type('z')
    await new Promise((r) => setTimeout(r, 650))
    expect(writes).toEqual([])
    expect(toasts).toEqual([]) // quietly: auto-save only skips it
  })

  it('at the session end: disconnected, its text kept, nothing read again, never saved', async () => {
    const F = 'lshare://p1/a4.js'
    setLshareAccess('p1', { edit: true })
    await openDoc(F, 'kept\n')
    docsMod.modelOf(F).type(' and mine')
    endLshareSession()
    const d = docsMod.getDoc(F)
    expect(docsMod.isDisconnectedDoc(d)).toBe(true)
    disk.set(F, { text: 'host changed it\n', sig: 's9' })
    await changed({ path: F, exists: true, sig: 's9' })
    await flush()
    expect(docsMod.modelOf(F).getValue()).toBe('kept\n and mine')
    expect(d.external).toBe(false)
    await changed({ path: F, exists: false })
    expect(d.deleted).toBe(false)
    const res = await docsMod.saveDoc(F)
    expect(res.ok).toBe(false)
    expect(toasts.at(-1)).toMatch(/session for a4\.js ended: copy your text/)
  })

  it('a local document is as before: a read saying read-only means nothing', async () => {
    const F = 'C:\\p\\local1.js'
    await openDoc(F, 'a\n', { readOnly: true })
    const d = docsMod.getDoc(F)
    expect(d.readOnly).toBe(false)
    expect(docsMod.isReadOnlyDoc(d)).toBe(false)
    docsMod.modelOf(F).type('b')
    expect((await docsMod.saveDoc(F)).ok).toBe(true)
  })
})

describe("the editor pane on a Live Share host's file", () => {
  let w
  let ctx
  let asked
  function mountPane(path, { confirm = false } = {}) {
    asked = []
    const node = reactive({ type: 'leaf', kind: 'editor', id: `ed-${++seq}`, title: 'Editor', files: [{ path }], activePath: path, reveal: null })
    ctx = {
      activeId: ref(node.id),
      maximizedId: ref(null),
      highlightId: ref(null),
      setActive: vi.fn(),
      closeLeaf: vi.fn(),
      toggleMaximize: vi.fn(),
      beginPaneDrag: vi.fn(),
      toast: vi.fn(),
      copied: vi.fn(),
      openInEditor: vi.fn()
    }
    w = mount(EditorPane, {
      props: { node },
      attachTo: document.body,
      global: {
        provide: {
          panelCtx: ctx,
          askConfirm: async (q) => {
            asked.push(q)
            return confirm
          }
        }
      }
    })
    return node
  }
  const lastReadOnly = () => {
    const e = editors.at(-1)
    const o = e.options.filter((x) => 'readOnly' in x).at(-1)
    return o ? o.readOnly : undefined
  }
  afterEach(() => {
    w?.unmount()
    w = null
    document.body.innerHTML = ''
  })

  it('opens a remote PNG without loading Monaco, then initializes it for a text tab', async () => {
    const image = 'ssh://ssh-test/srv/output/poster.png'
    loadMonaco.mockClear()
    const node = mountPane(image)
    await flushPromises()
    expect(loadMonaco).not.toHaveBeenCalled()
    expect(w.findComponent({ name: 'RichView' }).props('file')).toBe(image)
    const text = 'C:/p/after-image.js'
    disk.set(text, { text: 'hello', sig: 's1' })
    node.files.push({ path: text })
    node.activePath = text
    await flushPromises()
    expect(loadMonaco).toHaveBeenCalled()
    expect(w.get('[data-test="editor-host"]').isVisible()).toBe(true)
  })

  it('shows an image even after Monaco failed for a text tab', async () => {
    loadMonaco.mockImplementation(() => Promise.reject(new Error('module unavailable')))
    try {
      const node = mountPane('C:/p/failed-editor.js')
      await flushPromises()
      expect(w.text()).toContain('module unavailable')
      const image = 'ssh://ssh-test/srv/output/after-error.png'
      node.files.push({ path: image })
      node.activePath = image
      await flushPromises()
      expect(w.findComponent({ name: 'RichView' }).props('file')).toBe(image)
      expect(w.text()).not.toContain('module unavailable')
    } finally {
      loadMonaco.mockImplementation(() => Promise.resolve(fakeMonaco))
    }
  })

  it('Monaco is read-only and says so until the host gives Edit files, then editable, then read-only again: live', async () => {
    const F = 'lshare://p1/src/b1.js'
    disk.set(F, { text: 'hello\n', sig: 's1' })
    mountPane(F)
    await flush()
    await flushPromises()
    await flush()
    expect(lastReadOnly()).toBe(true)
    expect(w.get('[data-test="editor-locked"]').text()).toBe('Read-only')
    setLshareAccess('p1', { edit: true })
    await flushPromises()
    expect(lastReadOnly()).toBe(false)
    expect(w.find('[data-test="editor-locked"]').exists()).toBe(false)
    setLshareAccess('p1', { edit: false })
    await flushPromises()
    expect(lastReadOnly()).toBe(true)
  })

  it('at the session end: disconnected, the text still there to copy', async () => {
    const F = 'lshare://p1/b2.js'
    disk.set(F, { text: 'keep me\n', sig: 's1' })
    setLshareAccess('p1', { edit: true })
    mountPane(F)
    await flush()
    await flushPromises()
    await flush()
    expect(lastReadOnly()).toBeUndefined()
    endLshareSession()
    await flushPromises()
    expect(lastReadOnly()).toBe(true)
    expect(w.get('[data-test="editor-locked"]').text()).toBe('Disconnected')
    expect(editors.at(-1).getModel().getValue()).toBe('keep me\n')
  })

  it('offers no Open in VS Code, and copies the path in the project', async () => {
    const F = 'lshare://p1\\src\\b3.js'
    disk.set(F, { text: 'x\n', sig: 's1' })
    mountPane(F)
    await flush()
    await flushPromises()
    expect(w.find('[data-test="editor-open-external"]').exists()).toBe(false)
    await w.get('[aria-label="Copy path"]').trigger('click')
    expect(window.shellApi.writeClipboard).toHaveBeenLastCalledWith('src/b3.js')
    expect(window.shellApi.openFile).not.toHaveBeenCalled()
  })

  it('closing a tab whose edits can no longer be saved asks that, and keeps it open when not confirmed', async () => {
    const F = 'lshare://p1/b4.js'
    disk.set(F, { text: 'x\n', sig: 's1' })
    setLshareAccess('p1', { edit: true })
    const node = mountPane(F)
    await flush()
    await flushPromises()
    await flush()
    docsMod.modelOf(F).type('unsaved')
    setLshareAccess('p1', { edit: false })
    await flushPromises()
    await w.get('.ed-tab-close').trigger('click')
    await flushPromises()
    expect(asked).toHaveLength(1)
    expect(asked[0].text).toMatch(/can no longer be saved: copy them first/)
    expect(node.files).toHaveLength(1)
    expect(writes.filter((x) => x.file === F)).toEqual([])
  })

  it('a local file is as before: never made read-only, Open in VS Code there', async () => {
    const F = 'C:\\p\\local2.js'
    disk.set(F, { text: 'x\n', sig: 's1' })
    mountPane(F)
    await flush()
    await flushPromises()
    await flush()
    expect(lastReadOnly()).toBeUndefined()
    expect(w.find('[data-test="editor-locked"]').exists()).toBe(false)
    expect(w.find('[data-test="editor-open-external"]').exists()).toBe(true)
    await nextTick()
  })
})
