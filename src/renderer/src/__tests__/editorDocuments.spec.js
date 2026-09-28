// The editor's documents (src/renderer/src/editor/documents.js) with a small
// stand-in for Monaco's text model: dirty state, saving, auto-save, changes
// on disk (clean: reloaded; unsaved edits: kept, flagged), deletion.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

class FakeModel {
  constructor(text) {
    this.text = text
    this.eol = /\r\n/.test(text) ? '\r\n' : '\n'
    this.alt = 1
    this.next = 2
    this.history = []
    this.subs = new Set()
    this.disposed = false
  }
  getValue() {
    return this.text
  }
  getEOL() {
    return this.eol
  }
  getAlternativeVersionId() {
    return this.alt
  }
  onDidChangeContent(fn) {
    this.subs.add(fn)
    return { dispose: () => this.subs.delete(fn) }
  }
  offsetAt({ lineNumber, column }) {
    const lines = this.text.split(this.eol)
    let off = 0
    for (let i = 0; i < lineNumber - 1; i++) off += lines[i].length + this.eol.length
    return off + column - 1
  }
  getPositionAt(offset) {
    const before = this.text.slice(0, offset).split(this.eol)
    return { lineNumber: before.length, column: before[before.length - 1].length + 1 }
  }
  pushStackElement() {}
  pushEOL(e) {
    this.eol = e === 1 ? '\r\n' : '\n'
    this.text = this.text.replace(/\r\n|\n/g, this.eol)
  }
  pushEditOperations(_sel, edits) {
    for (const e of edits) {
      const s = this.offsetAt({ lineNumber: e.range.startLineNumber, column: e.range.startColumn })
      const en = this.offsetAt({ lineNumber: e.range.endLineNumber, column: e.range.endColumn })
      this.text = this.text.slice(0, s) + e.text + this.text.slice(en)
    }
    this.history.push(this.alt)
    this.alt = this.next++
    for (const fn of this.subs) fn()
  }
  // A user edit / undo, as Monaco reports them.
  type(text) {
    this.text += text
    this.history.push(this.alt)
    this.alt = this.next++
    for (const fn of this.subs) fn()
  }
  undo() {
    this.alt = this.history.pop()
    for (const fn of this.subs) fn()
  }
  isDisposed() {
    return this.disposed
  }
  dispose() {
    this.disposed = true
  }
}

const models = new Map()
const fakeMonaco = {
  Uri: { file: (p) => ({ path: p, toString: () => `file:///${p}` }) },
  Range: class {
    constructor(a, b, c, d) {
      Object.assign(this, { startLineNumber: a, startColumn: b, endLineNumber: c, endColumn: d })
    }
  },
  languages: { getLanguages: () => [{ id: 'javascript', extensions: ['.js'] }] },
  editor: {
    EndOfLineSequence: { LF: 0, CRLF: 1 },
    getModel: (uri) => models.get(uri.path) || null,
    createModel: (text, _lang, uri) => {
      const m = new FakeModel(text)
      models.set(uri.path, m)
      return m
    },
    setModelLanguage: () => {}
  }
}

vi.mock('../editor/loadMonaco', () => ({
  loadMonaco: () => Promise.resolve(fakeMonaco),
  monacoIfLoaded: () => fakeMonaco
}))

const disk = new Map()
let changed = null
const writes = []
const toasts = []
function install() {
  window.shellApi = {
    editor: {
      read: async (file) => {
        if (!disk.has(file)) return { ok: false, error: 'The file was not found.', code: 'missing' }
        const d = disk.get(file)
        return { ok: true, text: d.text, bom: !!d.bom, sig: d.sig }
      },
      write: async ({ file, text, bom, expectSig }) => {
        if (file.includes('readonly')) return { ok: false, error: 'EPERM: operation not permitted' }
        // The main process's guard: changed on disk since the editor knew it.
        if (expectSig !== undefined && disk.has(file) && disk.get(file).sig !== expectSig)
          return { ok: false, conflict: true, sig: disk.get(file).sig, error: 'changed on disk' }
        const sig = `s${writes.length + 100}`
        disk.set(file, { text, bom, sig })
        writes.push({ file, text, bom })
        return { ok: true, sig }
      },
      watch: async () => ({ ok: true }),
      setDirtyCount: () => {},
      onChanged: (fn) => {
        changed = fn
        return () => {}
      }
    }
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

let mod
beforeEach(async () => {
  vi.resetModules()
  models.clear()
  disk.clear()
  writes.length = 0
  toasts.length = 0
  install()
  mod = await import('../editor/documents')
  const { settings } = await import('../settings')
  settings.editorAutoSave = false
  settings.editorAutoSaveDelayMs = 1000
  mod.setEditorHooks({ toast: (t) => toasts.push(t) })
  mod.startDiskWatch()
})
afterEach(() => {
  vi.useRealTimers()
})

const F = 'C:\\p\\a.js'

async function open(text = 'one\r\ntwo\r\n', extra = {}) {
  disk.set(F, { text, sig: 's1', ...extra })
  const d = mod.acquireDoc(F, 'pane-1')
  await flush()
  await flush()
  return d
}

describe('editor documents', () => {
  it('loads a file into one model and tracks unsaved changes (undo back = clean)', async () => {
    const d = await open()
    expect(d.loading).toBe(false)
    const m = mod.modelOf(F)
    expect(m.getValue()).toBe('one\r\ntwo\r\n')
    m.type('three')
    expect(mod.getDoc(F).dirty).toBe(true)
    m.undo()
    expect(mod.getDoc(F).dirty).toBe(false)
  })

  it('saves the text with its BOM, and is clean after', async () => {
    await open('x\r\n', { bom: true })
    mod.modelOf(F).type('y')
    const res = await mod.saveDoc(F)
    expect(res.ok).toBe(true)
    expect(writes).toEqual([{ file: F, text: 'x\r\ny', bom: true }])
    expect(mod.getDoc(F).dirty).toBe(false)
  })

  it('says when a save fails, and stays dirty', async () => {
    const R = 'C:\\readonly\\b.js'
    disk.set(R, { text: 'a', sig: 's1' })
    mod.acquireDoc(R, 'pane-1')
    await flush()
    await flush()
    mod.modelOf(R).type('b')
    const res = await mod.saveDoc(R)
    expect(res.ok).toBe(false)
    expect(toasts[0]).toMatch(/^Could not save b\.js: EPERM/)
    expect(mod.getDoc(R).dirty).toBe(true)
  })

  it('reloads a clean file changed on disk, as one edit', async () => {
    await open('one\r\ntwo\r\n')
    disk.set(F, { text: 'one\r\n2\r\n', sig: 's2' })
    await changed({ path: F, exists: true, sig: 's2' })
    await flush()
    expect(mod.modelOf(F).getValue()).toBe('one\r\n2\r\n')
    expect(mod.getDoc(F).dirty).toBe(false)
    expect(mod.getDoc(F).external).toBe(false)
  })

  it('keeps unsaved edits when the file changes on disk, and flags it', async () => {
    await open('one\n')
    mod.modelOf(F).type('mine')
    disk.set(F, { text: 'theirs\n', sig: 's2' })
    await changed({ path: F, exists: true, sig: 's2' })
    await flush()
    const d = mod.getDoc(F)
    expect(d.external).toBe(true)
    expect(mod.modelOf(F).getValue()).toBe('one\nmine')
    expect(mod.diskTextOf(F)).toBe('theirs\n')
    mod.keepMyEdits(F)
    expect(d.external).toBe(false)
    // Reload from disk: the disk's text, clean.
    disk.set(F, { text: 'theirs 2\n', sig: 's3' })
    await changed({ path: F, exists: true, sig: 's3' })
    await flush()
    expect(d.external).toBe(true)
    await mod.reloadFromDisk(F)
    expect(mod.modelOf(F).getValue()).toBe('theirs 2\n')
    expect(d.dirty).toBe(false)
    expect(d.external).toBe(false)
  })

  it('ignores the echo of its own save', async () => {
    await open('a\n')
    mod.modelOf(F).type('b')
    const res = await mod.saveDoc(F)
    await changed({ path: F, exists: true, sig: res.sig })
    await flush()
    expect(mod.getDoc(F).external).toBe(false)
    expect(mod.getDoc(F).dirty).toBe(false)
  })

  it('marks a deleted file, and clears it when it is back', async () => {
    await open('a\n')
    await changed({ path: F, exists: false, sig: null })
    expect(mod.getDoc(F).deleted).toBe(true)
    await changed({ path: F, exists: true, sig: 's1' })
    await flush()
    expect(mod.getDoc(F).deleted).toBe(false)
  })

  it('auto-saves after the delay, but not while the disk changed under edits', async () => {
    const { settings } = await import('../settings')
    await open('a\n')
    vi.useFakeTimers()
    settings.editorAutoSave = true
    settings.editorAutoSaveDelayMs = 500
    mod.modelOf(F).type('b')
    await vi.advanceTimersByTimeAsync(400)
    expect(writes.length).toBe(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(writes.length).toBe(1)
    mod.modelOf(F).type('c')
    disk.set(F, { text: 'other\n', sig: 's9' })
    await changed({ path: F, exists: true, sig: 's9' })
    await vi.advanceTimersByTimeAsync(10)
    expect(mod.getDoc(F).external).toBe(true)
    mod.modelOf(F).type('d')
    await vi.advanceTimersByTimeAsync(2000)
    expect(writes.length).toBe(1)
  })

  it('keeps a document while a pane holds it, and disposes it with its last tab', async () => {
    await open('a\n')
    mod.acquireDoc(F, 'pane-2')
    const m = mod.modelOf(F)
    mod.modelOf(F).type('x')
    expect(mod.dirtyOnlyIn('pane-1', [F])).toEqual([])
    mod.releaseDoc(F, 'pane-2')
    expect(mod.dirtyOnlyIn('pane-1', [F])).toEqual([F])
    mod.reconcileOwner('pane-1', [])
    expect(mod.getDoc(F)).toBe(null)
    expect(m.isDisposed()).toBe(true)
  })

  it('counts a document held only by panes closing together as at risk', async () => {
    await open('a\n')
    mod.acquireDoc(F, 'pane-2')
    mod.modelOf(F).type('x')
    // Each pane alone: the other still shows it.
    expect(mod.dirtyOnlyIn('pane-1', [F])).toEqual([])
    expect(mod.dirtyOnlyIn(['pane-2'], [F])).toEqual([])
    // Both closing (a workspace): lost unless asked about.
    expect(mod.dirtyOnlyIn(['pane-1', 'pane-2'], [F])).toEqual([F])
    expect(mod.dirtyOnlyIn(new Set(['pane-1', 'pane-2', 'pane-3']), [F])).toEqual([F])
    mod.acquireDoc(F, 'pane-3')
    expect(mod.dirtyOnlyIn(['pane-1', 'pane-2'], [F])).toEqual([])
  })

  it("App's dirtyEditorPaths asks once about a file two closing panes show", async () => {
    const fs = await import('fs')
    const { join } = await import('path')
    const { samePath, docPathOf } = await import('../editor/editorTabs')
    const src = fs.readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.vue'), 'utf8')
    const fn = src.match(/function dirtyEditorPaths\(leaves\) \{[\s\S]*?\n\}/)[0]
    const dirtyEditorPaths = new Function('dirtyOnlyIn', 'samePath', 'docPathOf', `${fn}\nreturn dirtyEditorPaths`)(mod.dirtyOnlyIn, samePath, docPathOf)
    await open('a\n')
    mod.acquireDoc(F, 'pane-2')
    mod.modelOf(F).type('x')
    const leaves = ['pane-1', 'pane-2'].map((id) => ({ id, kind: 'editor', files: [{ path: F }] }))
    expect(dirtyEditorPaths(leaves)).toEqual([F])
    expect(dirtyEditorPaths([leaves[0]])).toEqual([])
    expect(dirtyEditorPaths([leaves[0], { id: 'term', kind: 'terminal' }])).toEqual([])
  })

  it('never auto-saves over a change made on disk before the watcher said so', async () => {
    const { settings } = await import('../settings')
    await open('original')
    mod.modelOf(F).type(' MINE')
    // An agent writes; the watcher's event has not arrived yet.
    disk.set(F, { text: 'IMPORTANT AGENT EDIT', sig: 's2' })
    settings.editorAutoSave = true
    const res = await mod.saveDoc(F, { trigger: 'autosave' })
    expect(res).toMatchObject({ ok: false, conflict: true })
    expect(disk.get(F).text).toBe('IMPORTANT AGENT EDIT')
    const d = mod.getDoc(F)
    expect(d.external).toBe(true)
    expect(d.dirty).toBe(true)
    expect(mod.diskTextOf(F)).toBe('IMPORTANT AGENT EDIT')
    expect(mod.modelOf(F).getValue()).toBe('original MINE')
    expect(toasts).toEqual([])
    // Auto-save stays suspended.
    vi.useFakeTimers()
    mod.modelOf(F).type('!')
    await vi.advanceTimersByTimeAsync(3000)
    expect(writes.length).toBe(0)
    vi.useRealTimers()
    // The watcher's late event changes nothing more.
    await changed({ path: F, exists: true, sig: 's2' })
    await flush()
    expect(d.external).toBe(true)
    // A manual Save (or Save in a close prompt) refuses too while the banner
    // is unanswered, and says so.
    settings.editorAutoSave = false
    expect(await mod.saveDoc(F)).toMatchObject({ ok: false, conflict: true })
    expect(await mod.saveDocs([F])).toBe(false)
    expect(toasts[0]).toMatch(/Keep My Edits before saving/)
    expect(disk.get(F).text).toBe('IMPORTANT AGENT EDIT')
    expect(writes.length).toBe(0)
  })

  it('a manual save after a conflict is refused until Keep My Edits, then writes on purpose', async () => {
    await open('original')
    mod.modelOf(F).type(' MINE')
    disk.set(F, { text: 'AGENT', sig: 's2' })
    const first = await mod.saveDoc(F)
    expect(first).toMatchObject({ ok: false, conflict: true })
    expect(toasts[0]).toMatch(/changed on disk by another program: your edits were not saved/)
    expect(disk.get(F).text).toBe('AGENT')
    expect(mod.getDoc(F).external).toBe(true)
    // Refused while the banner is unanswered.
    expect((await mod.saveDoc(F)).conflict).toBe(true)
    // Keep My Edits, but the agent wrote again meanwhile: refused again.
    disk.set(F, { text: 'AGENT 2', sig: 's3' })
    mod.keepMyEdits(F)
    expect((await mod.saveDoc(F)).conflict).toBe(true)
    expect(disk.get(F).text).toBe('AGENT 2')
    expect(mod.diskTextOf(F)).toBe('AGENT 2')
    expect(mod.getDoc(F).external).toBe(true)
    // Keep My Edits over the version now shown: written on purpose.
    mod.keepMyEdits(F)
    const res = await mod.saveDoc(F)
    expect(res.ok).toBe(true)
    expect(disk.get(F).text).toBe('original MINE')
    expect(mod.getDoc(F).dirty).toBe(false)
  })

  it('a clean document whose file changed before the watcher said so is reloaded, not overwritten', async () => {
    await open('original')
    disk.set(F, { text: 'AGENT', sig: 's2' })
    const res = await mod.saveDoc(F)
    expect(res.conflict).toBe(true)
    expect(disk.get(F).text).toBe('AGENT')
    expect(mod.modelOf(F).getValue()).toBe('AGENT')
    expect(mod.getDoc(F).dirty).toBe(false)
    expect(mod.getDoc(F).external).toBe(false)
  })

  it('saving before closing also saves an edit typed during the save', async () => {
    await open('a')
    const m = mod.modelOf(F)
    m.type(' SAVE THIS')
    const realWrite = window.shellApi.editor.write
    let release
    const gate = new Promise((r) => (release = r))
    let calls = 0
    window.shellApi.editor.write = async (q) => {
      if (calls++ === 0) await gate
      return realWrite(q)
    }
    const closing = mod.saveDocs([F])
    await flush()
    m.type(' NEW EDIT DURING SAVE')
    release()
    expect(await closing).toBe(true)
    expect(mod.getDoc(F).dirty).toBe(false)
    expect(disk.get(F).text).toBe('a SAVE THIS NEW EDIT DURING SAVE')
    expect(writes.length).toBe(2)
  })

  it('saving before closing says no when an edit typed during the save could not be saved', async () => {
    await open('a')
    const m = mod.modelOf(F)
    m.type('b')
    const realWrite = window.shellApi.editor.write
    let calls = 0
    window.shellApi.editor.write = async (q) => {
      calls++
      if (calls === 1) {
        m.type('c') // typed while the first write runs
        return realWrite(q)
      }
      return { ok: false, error: 'disk full' }
    }
    expect(await mod.saveDocs([F])).toBe(false)
    expect(mod.getDoc(F).dirty).toBe(true)
  })

  it('shows why a file cannot be opened', async () => {
    mod.acquireDoc('C:\\p\\gone.js', 'pane-1')
    await flush()
    await flush()
    expect(mod.getDoc('C:\\p\\gone.js')).toMatchObject({ loading: false, error: 'The file was not found.', errorCode: 'missing' })
  })
})
