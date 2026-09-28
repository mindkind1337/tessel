// The files open in Tessel's editor panes, one document per file (kept while
// any pane has a tab for it, so undo history survives tab switches and pane
// moves; disposed when its last tab closes). Each document holds one Monaco
// model (monaco.Uri.file(path)). Also: saving (one at a time per file),
// auto-save, and changes made on disk by other programs.
//
// Logic ported from Orca (MIT, Copyright (c) 2026 Lovecast Inc.):
// editor-save-queue.ts (serial saves, a save of our own is not an external
// change), editor-autosave.ts (auto-save suspended while the file changed on
// disk under unsaved edits), monaco-content-sync.ts (external changes applied
// as undoable edits, in the model's line endings).
import { reactive } from 'vue'
import { loadMonaco, monacoIfLoaded } from './loadMonaco'
import { settings } from '../settings'
import { pathKey, fileName, autoSaveDelay, minimalEdit, mainEol } from './editorTabs'
import { pickLanguage } from '../../../shared/editorLanguage'
import { createSaveQueue } from './saveQueue'

// key -> { path, key, name, loading, error, errorCode, dirty, deleted,
//          external, saving, bom, sig, language }
export const docs = reactive({})
// key -> { model, savedAlt, baseline, owners: Set, autoTimer, sub, applying,
//          recentWrite, diskText }
const inner = new Map()
const queue = createSaveQueue()
const editListeners = new Set()
// View state (scroll, selections) per pane and file: `${owner}\n${key}`.
const viewStates = new Map()

let hooks = { toast: () => {} }
export function setEditorHooks(h) {
  hooks = { ...hooks, ...h }
}

export const getDoc = (path) => docs[pathKey(path)] || null
export const modelOf = (path) => inner.get(pathKey(path))?.model || null
export const ownersOf = (path) => [...(inner.get(pathKey(path))?.owners || [])]
export const diskTextOf = (path) => inner.get(pathKey(path))?.diskText ?? null

// Called on every user edit of a document (panes pin its preview tab).
export function onDocEdited(fn) {
  editListeners.add(fn)
  return () => editListeners.delete(fn)
}

// --- Open / close ---------------------------------------------------------------
// A pane (owner) holds a document while it has a tab for it.
export function acquireDoc(path, owner) {
  const key = pathKey(path)
  if (!docs[key]) {
    docs[key] = {
      path,
      key,
      name: fileName(path),
      loading: true,
      error: '',
      errorCode: '',
      dirty: false,
      deleted: false,
      external: false,
      saving: false,
      bom: false,
      sig: null,
      language: 'plaintext'
    }
    inner.set(key, {
      model: null,
      savedAlt: 0,
      baseline: '',
      owners: new Set(),
      autoTimer: null,
      sub: null,
      applying: false,
      recentWrite: null,
      diskText: null,
      diskHash: null
    })
    load(key)
    syncWatch()
  }
  inner.get(key).owners.add(owner)
  return docs[key]
}

export function releaseDoc(path, owner) {
  const key = pathKey(path)
  const i = inner.get(key)
  if (!i) return
  i.owners.delete(owner)
  viewStates.delete(`${owner}\n${key}`)
  if (i.owners.size) return
  clearTimeout(i.autoTimer)
  if (i.sub) i.sub.dispose()
  if (i.model && !i.model.isDisposed()) i.model.dispose()
  inner.delete(key)
  delete docs[key]
  syncWatch()
  syncDirty()
}

// The pane's tabs are these paths: hold them, let go of the others.
export function reconcileOwner(owner, paths) {
  const want = new Set(paths.map(pathKey))
  for (const p of paths) acquireDoc(p, owner)
  for (const [key, i] of [...inner]) {
    if (i.owners.has(owner) && !want.has(key)) releaseDoc(docs[key] ? docs[key].path : key, owner)
  }
}

// Every document a pane holds is let go (the pane closed).
export function releaseOwner(owner) {
  for (const [key, i] of [...inner]) if (i.owners.has(owner)) releaseDoc(docs[key] ? docs[key].path : key, owner)
}

export function saveViewState(owner, path, state) {
  if (state) viewStates.set(`${owner}\n${pathKey(path)}`, state)
}
export function viewStateOf(owner, path) {
  return viewStates.get(`${owner}\n${pathKey(path)}`) || null
}

async function load(key) {
  const d = docs[key]
  if (!d) return
  d.loading = true
  d.error = ''
  d.errorCode = ''
  let monaco = null
  let res = null
  try {
    ;[monaco, res] = await Promise.all([loadMonaco(), window.shellApi.editor.read(d.path)])
  } catch (err) {
    res = { ok: false, error: (err && err.message) || 'The editor could not start.', code: 'error' }
  }
  if (docs[key] !== d) return // closed meanwhile
  d.loading = false
  if (!res || !res.ok) {
    d.error = (res && res.error) || 'The file could not be read.'
    d.errorCode = (res && res.code) || 'error'
    return
  }
  const i = inner.get(key)
  const uri = monaco.Uri.file(d.path)
  const lang = pickLanguage(d.path, monaco.languages.getLanguages())
  let model = monaco.editor.getModel(uri)
  if (model) {
    model.setValue(res.text)
    monaco.editor.setModelLanguage(model, lang)
  } else model = monaco.editor.createModel(res.text, lang, uri)
  i.model = model
  i.savedAlt = model.getAlternativeVersionId()
  i.baseline = model.getValue()
  d.bom = !!res.bom
  d.sig = res.sig || null
  i.diskHash = res.hash || null
  d.language = lang
  d.deleted = false
  i.sub = model.onDidChangeContent(() => onEdit(key))
}

function onEdit(key) {
  const d = docs[key]
  const i = inner.get(key)
  if (!d || !i || !i.model) return
  if (i.applying) return
  updateDirty(key)
  for (const fn of editListeners) {
    try {
      fn(d)
    } catch {
      // a pane gone meanwhile
    }
  }
  scheduleAutoSave(key)
}

function updateDirty(key) {
  const d = docs[key]
  const i = inner.get(key)
  if (!d || !i || !i.model) return
  const dirty = i.model.getAlternativeVersionId() !== i.savedAlt
  if (d.dirty !== dirty) {
    d.dirty = dirty
    syncDirty()
  }
}

// --- Saving ------------------------------------------------------------------------
// Auto-save waits while the file changed on disk under unsaved edits (the
// banner asks what to do), and never brings back a deleted file (Orca).
function autoSaveAllowed(d) {
  return !!settings.editorAutoSave && d.dirty && !d.external && !d.deleted && !d.error
}

function scheduleAutoSave(key) {
  const d = docs[key]
  const i = inner.get(key)
  if (!d || !i) return
  clearTimeout(i.autoTimer)
  i.autoTimer = null
  if (!autoSaveAllowed(d)) return
  i.autoTimer = setTimeout(() => {
    i.autoTimer = null
    saveDoc(d.path, { trigger: 'autosave' })
  }, autoSaveDelay(settings.editorAutoSaveDelayMs))
}

// -> { ok } | { ok: false, error } | { ok: false, skipped: true }
// | { ok: false, conflict: true, error }: the file changed on disk since this
// window last knew it (before the watcher said so); nothing was written and
// the document takes the change as one made on disk (reloaded when clean,
// the banner when there are unsaved edits).
export function saveDoc(path, { trigger = 'user' } = {}) {
  const key = pathKey(path)
  return queue.run(key, async () => {
    const d = docs[key]
    const i = inner.get(key)
    if (!d || !i || !i.model) return { ok: false, skipped: true, error: d && d.error ? d.error : 'The file is not open.' }
    if (trigger === 'autosave' && !autoSaveAllowed(d)) return { ok: false, skipped: true }
    // Changed on disk under unsaved edits: not written over until the banner's
    // "Keep My Edits" (or Reload) says which version wins.
    if (d.external) {
      hooks.toast(`${d.name} was changed on disk by another program: choose Compare, Reload or Keep My Edits before saving.`, {
        kind: 'error',
        timeout: 8000
      })
      return { ok: false, conflict: true, error: 'The file was changed on disk by another program.' }
    }
    const text = i.model.getValue()
    const alt = i.model.getAlternativeVersionId()
    // The disk as this window last knew it goes with the text: the main
    // process refuses the write when the file changed since (never
    // overwrites a change it has not seen).
    const write = async () => {
      try {
        return await window.shellApi.editor.write({
          file: d.path,
          text,
          bom: d.bom,
          expectSig: d.sig || undefined,
          expectHash: i.diskHash || undefined
        })
      } catch (err) {
        return { ok: false, error: (err && err.message) || 'unknown error' }
      }
    }
    d.saving = true
    let res = await write()
    if (res && res.conflict && docs[key] === d) {
      // Changed on disk before the watcher said so: taken as such.
      absorbDisk(key, d, await readFile(d.path))
      // The disk still holds what the edits started from (touched, or its
      // BOM changed): nothing of theirs to lose, written now.
      if (docs[key] === d && d.dirty && !d.external && !d.deleted && i.model) res = await write()
    }
    d.saving = false
    if (docs[key] !== d) return res || { ok: false }
    if (res && res.conflict) {
      if (trigger !== 'autosave')
        hooks.toast(
          d.external
            ? `${d.name} was changed on disk by another program: your edits were not saved. Compare, reload or keep them.`
            : `${d.name} was changed on disk by another program: reloaded.`,
          { kind: 'error', timeout: 8000 }
        )
      return res
    }
    if (!res || !res.ok) {
      hooks.toast(`Could not save ${d.name}: ${(res && res.error) || 'unknown error'}`, { kind: 'error', timeout: 8000 })
      return res || { ok: false, error: 'unknown error' }
    }
    // Our own write: the watcher ignores it (main process), and so does this
    // window for a second (the same signature).
    i.recentWrite = { sig: res.sig, at: Date.now() }
    i.savedAlt = alt
    i.baseline = text
    i.diskText = null
    d.sig = res.sig || null
    i.diskHash = res.hash || null
    d.external = false
    d.deleted = false
    updateDirty(key)
    return res
  })
}

// Save every document of these paths that has unsaved changes. -> true when
// all were saved and none is dirty now: an edit typed while a save was
// writing is saved too (a few rounds), so closing after never loses it.
export async function saveDocs(paths) {
  for (let round = 0; round < 3; round++) {
    const dirty = dirtyPaths(paths)
    if (!dirty.length) return true
    const results = await Promise.all(dirty.map((p) => saveDoc(p)))
    if (!results.every((r) => r && r.ok)) return false
  }
  return !dirtyPaths(paths).length
}

export function dirtyPaths(paths) {
  const out = []
  for (const p of paths) {
    const d = getDoc(p)
    if (d && d.dirty && !out.some((x) => pathKey(x) === d.key)) out.push(d.path)
  }
  return out
}

// Documents with unsaved changes whose every tab is in these panes (one pane
// id, or the ids of all the panes closing together): closing them would
// lose the edits. Two closing panes showing the same document count as one.
export function dirtyOnlyIn(owners, paths) {
  const set = new Set(Array.isArray(owners) || owners instanceof Set ? owners : [owners])
  return dirtyPaths(paths).filter((p) => {
    const o = ownersOf(p)
    return o.length > 0 && o.every((x) => set.has(x))
  })
}

export const dirtyCount = () => Object.values(docs).filter((d) => d.dirty).length

let lastDirtySent = -1
function syncDirty() {
  const n = dirtyCount()
  if (n === lastDirtySent) return
  lastDirtySent = n
  if (window.shellApi.editor && window.shellApi.editor.setDirtyCount) window.shellApi.editor.setDirtyCount(n)
}

// --- Changes on disk -----------------------------------------------------------------
let watchTimer = null
function syncWatch() {
  clearTimeout(watchTimer)
  watchTimer = setTimeout(() => {
    if (!window.shellApi.editor) return
    window.shellApi.editor.watch(Object.values(docs).map((d) => d.path)).catch(() => {})
  }, 50)
}

const normEol = (text, eol) => text.replace(/\r\n|\r|\n/g, eol)

// The disk's text into the model as one undoable edit (only the part that
// changed, so the view stays where it was). The document is clean after.
function applyDiskText(key, text) {
  const d = docs[key]
  const i = inner.get(key)
  const monaco = monacoIfLoaded()
  if (!d || !i || !i.model || !monaco) return
  const model = i.model
  i.applying = true
  try {
    const eol = mainEol(text)
    if (eol && eol !== model.getEOL()) {
      model.pushEOL(eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF)
    }
    const next = normEol(text, model.getEOL())
    const e = minimalEdit(model.getValue(), next)
    if (e) {
      const s = model.getPositionAt(e.start)
      const en = model.getPositionAt(e.endBefore)
      model.pushStackElement()
      model.pushEditOperations([], [{ range: new monaco.Range(s.lineNumber, s.column, en.lineNumber, en.column), text: e.text }], () => null)
      model.pushStackElement()
    }
  } finally {
    i.applying = false
  }
  i.savedAlt = model.getAlternativeVersionId()
  i.baseline = model.getValue()
  i.diskText = null
  d.external = false
  updateDirty(key)
}

const readFile = (path) => window.shellApi.editor.read(path).catch((err) => ({ ok: false, error: err && err.message }))

async function onDiskChange(change) {
  if (!change || typeof change.path !== 'string') return
  const key = pathKey(change.path)
  const d = docs[key]
  const i = inner.get(key)
  if (!d || !i) return
  if (!change.exists) {
    d.deleted = true
    clearTimeout(i.autoTimer)
    return
  }
  const back = d.deleted
  d.deleted = false
  if (i.recentWrite && change.sig === i.recentWrite.sig && Date.now() - i.recentWrite.at < 1000) return
  // Unreadable before (missing at restore, say): try again now it is here.
  if (d.error || !i.model) {
    if (!d.loading) load(key)
    return
  }
  if (change.sig && change.sig === d.sig && !back) return
  // Not in the middle of our own save.
  await queue.idle(key)
  if (docs[key] !== d) return
  await absorbDisk(key, d, await readFile(d.path))
}

// The file as just read from disk (changed by another program): a clean
// document is reloaded; unsaved edits are kept and flagged (the banner offers
// Compare, Reload, Keep) and auto-save waits.
function absorbDisk(key, d, res) {
  const i = inner.get(key)
  if (docs[key] !== d || !i || !i.model) return
  if (!res || !res.ok) {
    if (res && res.code === 'missing') d.deleted = true
    return
  }
  d.sig = res.sig || null
  d.bom = !!res.bom
  i.diskHash = res.hash || null
  const model = i.model
  const sameText = normEol(res.text, model.getEOL()) === normEol(i.baseline, model.getEOL())
  const sameEol = !mainEol(res.text) || mainEol(res.text) === model.getEOL()
  if (sameText && sameEol) return
  if (!d.dirty) {
    // Clean: reloaded silently (undoable).
    applyDiskText(key, res.text)
    return
  }
  // Unsaved edits: kept; the banner offers Compare, Reload, Keep.
  i.diskText = res.text
  d.external = true
  clearTimeout(i.autoTimer)
}

// The banner's "Reload from Disk": the disk's version replaces the edits
// (one undoable edit, so Ctrl+Z brings them back).
export async function reloadFromDisk(path) {
  const key = pathKey(path)
  const d = docs[key]
  if (!d) return
  const res = await readFile(d.path)
  if (docs[key] !== d) return
  if (!res || !res.ok) {
    hooks.toast(`Could not reload ${d.name}: ${(res && res.error) || 'unknown error'}`, { kind: 'error' })
    return
  }
  d.sig = res.sig || null
  d.bom = !!res.bom
  const i = inner.get(key)
  if (i) i.diskHash = res.hash || null
  applyDiskText(key, res.text)
}

// The banner's "Keep My Edits": the next save writes them over the disk.
export function keepMyEdits(path) {
  const key = pathKey(path)
  const d = docs[key]
  const i = inner.get(key)
  if (!d || !i) return
  d.external = false
  i.diskText = null
  scheduleAutoSave(key)
}

// Auto-save turned on (or its delay changed): pending edits are saved.
export function autoSaveSettingsChanged() {
  for (const key of Object.keys(docs)) scheduleAutoSave(key)
}

let stopChanges = null
export function startDiskWatch() {
  if (stopChanges || !window.shellApi.editor || !window.shellApi.editor.onChanged) return
  // A reloaded window starts with nothing unsaved: the main process is told.
  syncDirty()
  stopChanges = window.shellApi.editor.onChanged((c) => {
    onDiskChange(c).catch(() => {})
  })
}

// --- Editor panes -----------------------------------------------------------------------
// Live handles to mounted editor panes (focus, close a tab), by pane id.
const panes = new Map()
export function registerEditorPane(id, api) {
  panes.set(id, api)
}
export function unregisterEditorPane(id, api) {
  if (panes.get(id) === api) panes.delete(id)
}
export function getEditorPane(id) {
  return panes.get(id) || null
}
