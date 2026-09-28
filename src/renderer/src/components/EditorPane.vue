<script setup>
// A code editor pane (like Orca's editor, with the same Monaco engine): one
// tab per open file, preview tabs (italic) replaced by the next file opened
// with one click, a dirty dot that swaps with the close button, Ctrl+S to
// save, and Orca's view toggle: Edit | Changes for code, Source | Preview |
// Changes for Markdown and Mermaid, Source | Table | Changes for CSV/TSV,
// the picture for an image. A file opened from Source Control is a diff tab
// ("name (diff)", "name (staged diff)"): Monaco's diff editor, inline or side
// by side, F7 / Shift+F7 between changes, the right side editable for
// unstaged changes, review notes on its lines (the + in the gutter, or
// Ctrl+Shift+A). Files changed on disk by an agent reload by themselves when
// you have no unsaved edits; otherwise a banner asks. Logic after Orca's
// MonacoEditor.tsx, DiffViewer.tsx, EditorPanelHeader.tsx, EditorViewToggle.tsx,
// markdown-preview-controls.ts, editor-labels.ts, monaco-view-state-
// persistence.ts, monaco-reveal.ts, ExternalFileChangeBanner.tsx and
// editor-shortcuts.ts (MIT, Copyright (c) 2026 Lovecast Inc.), written for Vue.
import { ref, computed, watch, inject, nextTick, onMounted, onBeforeUnmount, h, render, getCurrentInstance } from 'vue'
import { settings, fontStack } from '../settings'
import { loadMonaco } from '../editor/loadMonaco'
import {
  docs,
  getDoc,
  modelOf,
  ownersOf,
  diskTextOf,
  reconcileOwner,
  saveDoc,
  reloadFromDisk,
  keepMyEdits,
  onDocEdited,
  saveViewState,
  viewStateOf,
  registerEditorPane,
  unregisterEditorPane
} from '../editor/documents'
import { pathKey, samePath, fileName, closeTab as closeTabData, pinTab, docPathOf } from '../editor/editorTabs'
import { fileKind } from '../../../shared/fileKinds'
import { pickLanguage } from '../../../shared/editorLanguage'
import { formatDiffComments } from '../../../shared/sourceControl'
import { notesFor, addNote, deleteNote, updateNote, clearDelivered } from '../reviewNotes'
import { scmRevision } from '../scmState'
import { installDiffNotes } from '../editor/diffNotes'
import LucideIcon from './LucideIcon.vue'
import RichView from './RichView.vue'
import NotesSendMenu from './NotesSendMenu.vue'
import DiffNoteDraft from './DiffNoteDraft.vue'
import DiffNoteCard from './DiffNoteCard.vue'

const props = defineProps({
  node: { type: Object, required: true }
})

const ctx = inject('panelCtx')
const askConfirm = inject('askConfirm', null)
const appContext = getCurrentInstance().appContext

const isActive = computed(() => ctx.activeId.value === props.node.id)
const isMaximized = computed(() => ctx.maximizedId.value === props.node.id)

const rootEl = ref(null)
const hostEl = ref(null)
const diffEl = ref(null)
const ready = ref(false)
const loadError = ref('')

let monaco = null
let editor = null
let diffEditor = null
let diffOriginal = null
let diffModified = null // a read-only right side (staged, deleted, binary-free)
let diffSeq = 0
let shownKey = null // the file whose model the code editor shows
let revealDecorations = null
let revealTimer = null
let stopEdits = null
let paneApi = null
let mounted = false
let notesDecorator = null

const files = computed(() => props.node.files || [])
const activeFile = computed(() => files.value.find((f) => samePath(f.path, props.node.activePath)) || null)
const activeDocPath = computed(() => docPathOf(activeFile.value))
const activeDoc = computed(() => (activeDocPath.value ? docs[pathKey(activeDocPath.value)] || null : null))
const diffInfo = computed(() => (activeFile.value && activeFile.value.diff) || null)
const kind = computed(() => (activeDocPath.value ? fileKind(activeDocPath.value) : 'text'))
const RICH_KINDS = ['markdown', 'mermaid', 'table']

// --- View modes (Orca's markdown-preview-controls.ts getEditorToggleModes) ----------------
// Internal modes: 'edit' (the code editor), 'rich' (rendered), 'changes'
// (against the last commit), 'compare' (against the disk), 'diff' (a diff
// tab), 'image'.
function defaultMode(f) {
  if (!f) return 'edit'
  if (f.diff) return 'diff'
  const k = fileKind(docPathOf(f))
  if (k === 'image') return 'image'
  return RICH_KINDS.includes(k) ? 'rich' : 'edit'
}
const mode = computed(() => (activeFile.value && activeFile.value.mode) || defaultMode(activeFile.value))
const toggleModes = computed(() => {
  if (!activeFile.value) return []
  if (diffInfo.value) return kind.value === 'markdown' ? ['source', 'rich'] : []
  if (kind.value === 'image') return []
  if (RICH_KINDS.includes(kind.value)) return ['source', 'rich', 'changes']
  return ['edit', 'changes']
})
const toggleValue = computed(() => {
  const m = mode.value
  if (diffInfo.value) return m === 'rich' ? 'rich' : 'source'
  if (m === 'rich') return 'rich'
  if (m === 'changes' || m === 'compare') return 'changes'
  return RICH_KINDS.includes(kind.value) ? 'source' : 'edit'
})
// Orca's EditorViewToggle metadata (CSV: Table; Tessel's rendered Markdown and
// Mermaid take the "rich" slot as Preview).
const TOGGLE_META = {
  source: { label: 'Source', icon: 'code' },
  rich: { label: 'Preview', icon: 'eye' },
  edit: { label: 'Edit', icon: 'fileText' },
  changes: { label: 'Changes', icon: 'gitCompareArrows', title: 'Uncommitted changes' }
}
function toggleMeta(v) {
  if (v === 'rich' && kind.value === 'table') return { label: 'Table', icon: 'table' }
  return TOGGLE_META[v]
}
function setToggle(v) {
  if (diffInfo.value) return setMode(v === 'rich' ? 'rich' : 'diff')
  setMode(v === 'source' || v === 'edit' ? 'edit' : v)
}

const diffNote = ref('')
const diffError = ref('')
const diffBusy = ref(false)
const diffBinary = ref(false)
const diffReadOnly = ref(false)
const richText = ref('')

const title = computed(() => props.node.title || 'Editor')
const docOf = (f) => docs[pathKey(docPathOf(f))] || null

// Orca's editor-labels.ts: "name (diff)", "name (staged diff)".
function baseLabel(f) {
  const name = fileName(docPathOf(f))
  const twins = files.value.filter((o) => fileName(docPathOf(o)).toLowerCase() === name.toLowerCase() && !!o.diff === !!f.diff)
  if (twins.length < 2) return name
  const parts = docPathOf(f).split(/[\\/]/)
  return parts.length > 1 ? `${name} · ${parts[parts.length - 2]}` : name
}
function tabLabel(f) {
  if (!f.diff) return baseLabel(f)
  return `${baseLabel(f)} (${f.diff.area === 'staged' ? 'staged diff' : 'diff'})`
}

// What the body shows instead of the editor (loading, an error).
const message = computed(() => {
  if (loadError.value) return loadError.value
  if (!files.value.length) return 'No file open. Open one from Jump to file (Ctrl+Shift+J) or the file explorer.'
  if (mode.value === 'image') return ''
  if (diffInfo.value) {
    if (!ready.value) return 'Opening…'
    if (diffError.value) return diffError.value
    if (diffBinary.value) return 'Binary file changed'
    return mode.value === 'rich' || !diffBusy.value ? '' : 'Loading diff...'
  }
  const d = activeDoc.value
  if (!d) return ''
  if (d.error) return d.error
  if (d.loading || !ready.value) return 'Opening…'
  return ''
})
const showDiff = computed(() => !message.value && ['changes', 'compare', 'diff'].includes(mode.value))
const showCode = computed(() => !message.value && mode.value === 'edit')
const showRich = computed(() => !message.value && (mode.value === 'rich' || mode.value === 'image'))
const isDiffSurface = computed(() => ['changes', 'diff'].includes(mode.value) && !!activeFile.value)

// --- Theme and options (follow Tessel's settings live) ---------------------------------
function isDark() {
  const c = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)
  if (!c) return true
  const [r, g, b] = c.map(Number)
  return 0.299 * r + 0.587 * g + 0.114 * b < 128
}
function applyTheme() {
  if (monaco) monaco.editor.setTheme(isDark() ? 'vs-dark' : 'vs')
}
function editorOptions() {
  return {
    fontSize: settings.fontSize,
    fontFamily: fontStack(settings.fontFamily),
    wordWrap: settings.editorWordWrap ? 'on' : 'off',
    minimap: { enabled: !!settings.editorMinimap }
  }
}
watch(
  () => [settings.fontSize, settings.fontFamily, settings.editorWordWrap, settings.editorMinimap],
  () => {
    if (editor) editor.updateOptions(editorOptions())
    if (diffEditor) diffEditor.updateOptions({ ...editorOptions(), minimap: { enabled: false } })
  }
)
watch(
  () => settings.theme,
  () => nextTick(() => requestAnimationFrame(applyTheme))
)
watch(
  () => settings.diffSideBySide,
  (v) => diffEditor && diffEditor.updateOptions({ renderSideBySide: !!v })
)
function toggleSideBySide() {
  settings.diffSideBySide = !settings.diffSideBySide
}

// --- Showing the active file ------------------------------------------------------------
function rememberView() {
  if (editor && shownKey) {
    const d = docs[shownKey]
    if (d) saveViewState(props.node.id, d.path, editor.saveViewState())
  }
}

function showActive() {
  if (!editor) return
  const d = activeDoc.value
  const model = mode.value === 'edit' && d && !d.error && !d.loading ? modelOf(d.path) : null
  const key = model ? d.key : null
  if (key !== shownKey) {
    rememberView()
    editor.setModel(model)
    shownKey = key
    if (model) {
      const vs = viewStateOf(props.node.id, d.path)
      if (vs) editor.restoreViewState(vs)
    }
  }
  const m = mode.value
  if (m === 'diff') enterDiffTab(activeFile.value)
  else if ((m === 'changes' || m === 'compare') && d && !d.error && !d.loading && modelOf(d.path)) enterDiff(d, m)
  else leaveDiff()
  updateRichText()
  applyReveal()
}

watch(
  () => [props.node.activePath, activeDoc.value && activeDoc.value.loading, activeDoc.value && activeDoc.value.error, mode.value, ready.value],
  () => nextTick(showActive)
)
// Stage, discard, commit: a diff tab reads its sides again.
watch(
  () => scmRevision.value,
  () => {
    if (mode.value === 'diff') {
      diffFor = ''
      nextTick(showActive)
    }
  }
)

// The pane's tabs changed: hold their files, let go of the others.
function heldPaths() {
  return files.value.filter((f) => defaultMode(f) !== 'image').map((f) => docPathOf(f))
}
watch(
  () => files.value.map((f) => f.path).join('\n'),
  () => {
    const held = heldPaths()
    // The diff editor must let go of a file's model before it is released
    // (Monaco throws when a model it shows is disposed).
    const dm = diffEditor && diffEditor.getModel()
    if (dm && dm.modified && dm.modified !== diffModified && !held.some((p) => samePath(p, dm.modified.uri.fsPath))) leaveDiff()
    if (editor && editor.getModel() && !held.some((p) => samePath(p, editor.getModel().uri.fsPath))) {
      rememberView()
      editor.setModel(null)
      shownKey = null
    }
    reconcileOwner(props.node.id, held)
    // The active tab is gone (closed elsewhere): show a neighbour.
    if (props.node.activePath && !activeFile.value) props.node.activePath = files.value.length ? files.value[0].path : null
  }
)

// --- The rendered view (Preview / Table / Diagram) follows the text --------------------------
function updateRichText() {
  if (mode.value !== 'rich') return
  if (diffInfo.value) {
    richText.value = diffModified ? diffModified.getValue() : (modelOf(activeDocPath.value) || { getValue: () => '' }).getValue()
    return
  }
  const model = activeDoc.value && !activeDoc.value.loading ? modelOf(activeDocPath.value) : null
  richText.value = model ? model.getValue() : ''
}
let richTimer = 0

// --- Reveal a line (a file:line link, Jump to file, a note) ---------------------------------
// Like Orca's performReveal: cursor there, the line centred, a brief highlight.
function applyReveal() {
  const r = props.node.reveal
  if (!r || !samePath(r.path, props.node.activePath)) return
  if (mode.value === 'diff') {
    if (!r.line) {
      props.node.reveal = null
      if (isActive.value) focusEditor()
      return
    }
    if (!diffEditor || !diffEditor.getModifiedEditor().getModel() || diffBusy.value) return
    props.node.reveal = null
    const me = diffEditor.getModifiedEditor()
    const line = Math.min(Math.max(1, r.line), me.getModel().getLineCount())
    me.setPosition({ lineNumber: line, column: 1 })
    if (notesDecorator) notesDecorator.reveal(line)
    else me.revealLineInCenter(line)
    return
  }
  if (!editor) return
  const model = editor.getModel()
  if (!model) {
    if (mode.value === 'rich' || mode.value === 'image') props.node.reveal = null
    return
  }
  props.node.reveal = null
  if (!r.line) {
    if (isActive.value) focusEditor()
    return
  }
  const line = Math.min(Math.max(1, r.line), model.getLineCount())
  const column = Math.min(Math.max(1, r.col || 1), model.getLineMaxColumn(line))
  if (mode.value !== 'edit') setMode('edit')
  editor.setPosition({ lineNumber: line, column })
  editor.setSelection({ startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column })
  editor.revealPositionInCenter({ lineNumber: line, column })
  if (revealDecorations) revealDecorations.clear()
  clearTimeout(revealTimer)
  revealDecorations = editor.createDecorationsCollection([
    { range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: { isWholeLine: true, className: 'ed-reveal-line' } }
  ])
  revealTimer = setTimeout(() => {
    if (revealDecorations) revealDecorations.clear()
    revealDecorations = null
  }, 1200)
  focusEditor()
}
watch(
  () => props.node.reveal && props.node.reveal.seq,
  () => nextTick(showActive)
)

// --- Changes (against the last commit), Compare (against the disk), diff tabs ---------------
function setMode(m) {
  const f = activeFile.value
  if (!f) return
  const i = files.value.indexOf(f)
  const next = files.value.slice()
  next[i] = { ...f, mode: m }
  props.node.files = next
}

function ensureDiffEditor() {
  if (diffEditor) return
  diffEditor = monaco.editor.createDiffEditor(diffEl.value, {
    ...editorOptions(),
    minimap: { enabled: false },
    automaticLayout: true,
    originalEditable: false,
    readOnly: false,
    renderSideBySide: !!settings.diffSideBySide,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    renderOverviewRuler: true,
    maxTokenizationLineLength: 20000,
    padding: { top: 0 }
  })
}

function languageOf(path) {
  return pickLanguage(path, monaco.languages.getLanguages())
}

let diffFor = '' // what the diff editor shows
async function enterDiff(d, m) {
  if (!monaco) return
  if (diffFor === `${d.key}|${m}`) return
  diffFor = `${d.key}|${m}`
  const token = ++diffSeq
  detachNotes()
  diffBusy.value = true
  diffNote.value = ''
  diffError.value = ''
  diffBinary.value = false
  diffReadOnly.value = false
  let text = ''
  if (m === 'compare') {
    text = diskTextOf(d.path) ?? ''
    diffNote.value = 'Left: the file on disk now. Right: your unsaved edits.'
  } else {
    let r = null
    try {
      r = await window.shellApi.editor.head(d.path)
    } catch (err) {
      r = { ok: false, error: err && err.message }
    }
    if (token !== diffSeq) return
    if (!r || !r.ok) diffNote.value = (r && r.error) || 'The committed version could not be read.'
    else {
      text = r.text || ''
      diffNote.value = r.note || ''
    }
  }
  const model = modelOf(d.path)
  if (!model || token !== diffSeq) return
  ensureDiffEditor()
  diffEditor.updateOptions({ readOnly: false })
  const oldO = diffOriginal
  const oldM = diffModified
  diffOriginal = monaco.editor.createModel(text, model.getLanguageId())
  diffModified = null
  diffEditor.setModel({ original: diffOriginal, modified: model })
  if (oldO) oldO.dispose()
  if (oldM) oldM.dispose()
  diffBusy.value = false
}

// A diff tab: its sides from git (Orca's getDiff): staged is HEAD -> index
// (read-only); unstaged is the index -> the file, its document on the right
// (editable, saved like the file); untracked is nothing -> the file.
async function enterDiffTab(f) {
  if (!monaco || !f || !f.diff) return
  const dff = f.diff
  const d = activeDoc.value
  const editableSide = dff.area !== 'staged'
  // The file's document is still loading: wait for it (the watch comes back).
  if (editableSide && d && d.loading) return
  const docReady = editableSide && d && !d.error && !d.loading && !!modelOf(d.path)
  const key = `${f.path}|${scmRevision.value}|${docReady ? 'doc' : 'ro'}`
  if (diffFor === key) return
  diffFor = key
  const token = ++diffSeq
  diffBusy.value = true
  diffError.value = ''
  diffNote.value = ''
  diffBinary.value = false
  let r = null
  try {
    r = await window.shellApi.scm.fileVersions({ root: dff.root, path: dff.rel, area: dff.area, oldPath: dff.oldRel || undefined })
  } catch (err) {
    r = { ok: false, error: err && err.message }
  }
  if (token !== diffSeq || !mounted) return
  if (!r || !r.ok) {
    diffBusy.value = false
    diffError.value = (r && r.error) || 'The diff could not be read.'
    return
  }
  if (r.binary) {
    diffBusy.value = false
    diffBinary.value = true
    return
  }
  const lang = docReady ? modelOf(d.path).getLanguageId() : languageOf(dff.full)
  ensureDiffEditor()
  const oldO = diffOriginal
  const oldM = diffModified
  diffOriginal = monaco.editor.createModel(r.original || '', lang)
  let modified
  if (docReady && r.exists) {
    modified = modelOf(d.path)
    diffModified = null
    diffReadOnly.value = false
  } else {
    diffModified = monaco.editor.createModel(r.modified || '', lang)
    modified = diffModified
    diffReadOnly.value = true
  }
  diffEditor.updateOptions({ readOnly: diffReadOnly.value })
  detachNotes()
  diffEditor.setModel({ original: diffOriginal, modified })
  if (oldO) oldO.dispose()
  if (oldM) oldM.dispose()
  diffBusy.value = false
  attachNotes(dff)
  updateRichText()
  // Orca opens a diff at its first change.
  if (!props.node.reveal) {
    const once = diffEditor.onDidUpdateDiff(() => {
      once.dispose()
      if (token === diffSeq && diffEditor && !(props.node.reveal && props.node.reveal.line)) {
        const changes = diffEditor.getLineChanges() || []
        const first = changes[0]
        if (first) diffEditor.getModifiedEditor().revealLineInCenterIfOutsideViewport(Math.max(1, first.modifiedStartLineNumber || 1))
      }
    })
  }
  nextTick(applyReveal)
}

function leaveDiff() {
  diffFor = ''
  diffSeq++
  diffBusy.value = false
  diffError.value = ''
  diffBinary.value = false
  detachNotes()
  if (diffEditor) diffEditor.setModel(null)
  if (diffOriginal) diffOriginal.dispose()
  if (diffModified) diffModified.dispose()
  diffOriginal = null
  diffModified = null
}

// --- Review notes on a diff tab (Orca's DiffViewer + useDiffCommentDecorator) ---------------
function mountZone(dom, which, zoneProps) {
  const comp = which === 'draft' ? DiffNoteDraft : DiffNoteCard
  let current = zoneProps
  const draw = () => {
    const vnode = h(comp, current)
    vnode.appContext = appContext
    render(vnode, dom)
  }
  draw()
  return {
    update(p) {
      current = { ...current, ...p }
      draw()
    },
    unmount() {
      render(null, dom)
    }
  }
}
function attachNotes(dff) {
  detachNotes()
  if (!diffEditor) return
  notesDecorator = installDiffNotes(diffEditor.getModifiedEditor(), {
    monaco,
    mount: mountZone,
    getNotes: () => notesFor(dff.root).filter((n) => n.filePath === dff.rel),
    create: async ({ lineNumber, startLine, body }) => {
      const n = addNote({ repo: dff.root, filePath: dff.rel, lineNumber, startLine, body })
      if (!n && ctx.toast) ctx.toast('Failed to save comment', { kind: 'error' })
      return !!n
    },
    remove: (id) => deleteNote(dff.root, id),
    save: async (id, body) => updateNote(dff.root, id, body),
    delivered: (sent) => clearDelivered(dff.root, sent)
  })
}
function detachNotes() {
  if (notesDecorator) notesDecorator.dispose()
  notesDecorator = null
}
const fileNotes = computed(() => (diffInfo.value ? notesFor(diffInfo.value.root).filter((n) => n.filePath === diffInfo.value.rel) : []))
const allNotes = computed(() => (diffInfo.value ? notesFor(diffInfo.value.root) : []))
watch(
  () => fileNotes.value.map((n) => `${n.id}:${n.body}:${n.lineNumber}`).join('|'),
  () => notesDecorator && notesDecorator.sync()
)
const unsentFile = computed(() => fileNotes.value.filter((n) => !n.sentAt))
const unsentAll = computed(() => allNotes.value.filter((n) => !n.sentAt))
const noteScopes = computed(() => [
  { id: 'file', label: 'This file', notes: unsentFile.value, prompt: formatDiffComments(unsentFile.value) },
  { id: 'all', label: 'All unsent notes', notes: unsentAll.value, prompt: formatDiffComments(unsentAll.value) }
])
function onNotesDelivered(sent) {
  if (diffInfo.value) clearDelivered(diffInfo.value.root, sent)
}

// --- Header buttons (Orca's EditorPanelHeader) ------------------------------------------------
function goToDiff(dir) {
  if (diffEditor && showDiff.value) diffEditor.goToDiff(dir)
}
const canOpenFile = computed(() => !!diffInfo.value && !(diffInfo.value.status === 'deleted' && diffInfo.value.area !== 'staged'))
function openDiffTargetFile() {
  if (!diffInfo.value || !ctx.openInEditor) return
  ctx.openInEditor({ file: diffInfo.value.full, preview: false })
}

// --- Tabs -------------------------------------------------------------------------------
function activate(path) {
  ctx.setActive(props.node.id)
  if (!samePath(props.node.activePath, path)) {
    rememberView()
    props.node.activePath = path
  }
  nextTick(focusEditor)
}

function pin(path) {
  props.node.files = pinTab(files.value, path)
}

async function closeTab(path) {
  const f = files.value.find((x) => samePath(x.path, path))
  const docPath = f ? docPathOf(f) : path
  const d = getDoc(docPath)
  // Its last tab: closing it would lose the unsaved edits.
  const holders = files.value.filter((x) => samePath(docPathOf(x), docPath)).length
  if (d && d.dirty && holders <= 1 && ownersOf(docPath).length <= 1) {
    const answer = askConfirm
      ? await askConfirm({
          title: 'Unsaved changes',
          text: `"${d.name}" has unsaved changes. Do you want to save before closing?`,
          confirmLabel: 'Save',
          altLabel: "Don't Save"
        })
      : window.confirm(`"${d.name}" has unsaved changes. Close without saving?`)
        ? 'alt'
        : false
    if (!answer) return
    if (answer === true) {
      const r = await saveDoc(docPath)
      if (!r || !r.ok) return
    }
  }
  if (!files.value.some((x) => samePath(x.path, path))) return
  const res = closeTabData(files.value, props.node.activePath, path)
  props.node.files = res.files
  props.node.activePath = res.activePath
  // The last tab: the pane closes with it.
  if (!res.files.length) ctx.closeLeaf(props.node.id, { force: true, editorChecked: true })
  else nextTick(focusEditor)
}

function closeActiveTab() {
  if (props.node.activePath) closeTab(props.node.activePath)
}

// Tab strip: the wheel scrolls it sideways.
function onTabsWheel(e) {
  if (!e.deltaY) return
  e.currentTarget.scrollLeft += e.deltaY
}

// --- Keyboard (capture phase, before Monaco) ---------------------------------------------
// Ctrl+S saves, Ctrl+W closes the tab, Alt+Z toggles word wrap, F7 /
// Shift+F7 move between changes; Tessel's own shortcuts keep working (they
// never reach Monaco, which binds some of the same keys).
function isAppShortcut(e) {
  const k = e.key
  if (e.ctrlKey && e.shiftKey && !e.altKey) return ['e', 'o', 'w', 'b', 'k', 'n', 't', 'r', 'p', 'x', 'j', 'g', ' '].includes(k.toLowerCase())
  if (e.ctrlKey && !e.shiftKey && !e.altKey) return ['=', '+', '-', '0', ',', 'PageUp', 'PageDown'].includes(k)
  // Alt+Up/Down stay Monaco's (move a line); Alt+Left/Right move between panes.
  if (e.altKey && !e.ctrlKey && !e.shiftKey) return ['ArrowLeft', 'ArrowRight'].includes(k)
  return k === 'F1'
}
function onKeydownCapture(e) {
  // A note's text box: its own keys (the composer handles Enter / Esc).
  if (e.target && e.target.closest && e.target.closest('.orca-diff-comment-inline')) {
    if (!(e.ctrlKey && e.key.toLowerCase() === 's')) return
  }
  const ctrlOnly = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (ctrlOnly && k === 's') {
    e.preventDefault()
    e.stopPropagation()
    if (!e.repeat) saveActive()
    return
  }
  if (ctrlOnly && k === 'w') {
    e.preventDefault()
    e.stopPropagation()
    if (!e.repeat) closeActiveTab()
    return
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey && (k === 'z' || e.code === 'KeyZ')) {
    e.preventDefault()
    e.stopPropagation()
    if (!e.repeat) settings.editorWordWrap = !settings.editorWordWrap
    return
  }
  if (e.key === 'F7' && !e.ctrlKey && !e.altKey && showDiff.value && diffEditor) {
    e.preventDefault()
    e.stopPropagation()
    if (!e.repeat) diffEditor.goToDiff(e.shiftKey ? 'previous' : 'next')
    return
  }
  if (isAppShortcut(e)) {
    e.preventDefault()
    e.stopPropagation()
    if (ctx.appShortcut) ctx.appShortcut(e)
  }
}

async function saveActive() {
  const d = activeDoc.value
  if (!d || d.error || d.loading) return
  if (diffInfo.value && diffReadOnly.value) return
  await saveDoc(d.path)
}

// --- Focus -------------------------------------------------------------------------------
function focusEditor() {
  if (showDiff.value && diffEditor) diffEditor.getModifiedEditor().focus()
  else if (showCode.value && editor && editor.getModel()) editor.focus()
  else if (rootEl.value) rootEl.value.focus()
}
function onPaneMouseDown() {
  ctx.setActive(props.node.id)
}
watch(isActive, (a) => {
  if (a) nextTick(focusEditor)
})

// Drag the header to move the pane; a click on it activates the pane.
function onNavPointerDown(e) {
  if (e.button !== 0) return
  if (e.target.closest('button, input, label')) return
  ctx.beginPaneDrag(props.node.id, e)
}
function onNavMouseDown(e) {
  if (!e.target.closest('input, label')) e.preventDefault()
  ctx.setActive(props.node.id)
  nextTick(focusEditor)
}

function openExternally() {
  const d = activeDoc.value
  if (!d) return
  const pos = editor && shownKey === d.key ? editor.getPosition() : null
  window.shellApi
    .openFile({ file: d.path, line: pos ? pos.lineNumber : undefined, col: pos ? pos.column : undefined })
    .then((res) => {
      if ((!res || !res.ok) && ctx.toast) ctx.toast(`Could not open ${d.name}${res && res.error ? `: ${res.error}` : ''}`, { kind: 'error' })
    })
    .catch(() => {})
}
function copyPath() {
  const p = activeDocPath.value
  if (p && window.shellApi.writeClipboard) {
    window.shellApi.writeClipboard(p)
    if (ctx.copied) ctx.copied('Path')
  }
}
// A link in a rendered Markdown file.
function openLinked(file) {
  if (ctx.openInEditor) ctx.openInEditor({ file })
}

// The banner (unsaved edits and a newer file on disk).
function compare() {
  setMode('compare')
}
async function reloadDisk() {
  const d = activeDoc.value
  if (!d) return
  await reloadFromDisk(d.path)
  if (mode.value === 'compare') setMode('edit')
}
function keepEdits() {
  const d = activeDoc.value
  if (!d) return
  keepMyEdits(d.path)
  if (mode.value === 'compare') setMode('edit')
}
// Compare is only for a conflict: once resolved, back to the editor.
watch(
  () => activeDoc.value && activeDoc.value.external,
  (ext) => {
    if (!ext && mode.value === 'compare') setMode('edit')
  }
)

// --- Mount --------------------------------------------------------------------------------
onMounted(async () => {
  mounted = true
  reconcileOwner(props.node.id, heldPaths())
  stopEdits = onDocEdited((d) => {
    // Editing a preview tab keeps it (Orca, VS Code).
    const f = files.value.find((x) => x.preview && samePath(docPathOf(x), d.path))
    if (f) props.node.files = pinTab(files.value, f.path)
    if (mode.value === 'rich' && samePath(d.path, activeDocPath.value)) {
      clearTimeout(richTimer)
      richTimer = setTimeout(updateRichText, 200)
    }
  })
  paneApi = { focus: focusEditor, closeActiveTab, activePath: () => props.node.activePath }
  registerEditorPane(props.node.id, paneApi)
  if (rootEl.value) rootEl.value.addEventListener('keydown', onKeydownCapture, true)
  try {
    monaco = await loadMonaco()
  } catch (err) {
    loadError.value = `The editor could not start: ${(err && err.message) || err}`
    return
  }
  if (!mounted || !hostEl.value) return
  applyTheme()
  editor = monaco.editor.create(hostEl.value, {
    model: null,
    ...editorOptions(),
    // Like Orca: long lines are not coloured past this (a guard for huge
    // minified files).
    maxTokenizationLineLength: 20000,
    scrollBeyondLastLine: false,
    lineNumbers: 'on',
    renderLineHighlight: 'line',
    automaticLayout: true,
    tabSize: 2,
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'off',
    padding: { top: 4 },
    fixedOverflowWidgets: true
  })
  ready.value = true
  await nextTick()
  showActive()
  if (isActive.value) focusEditor()
})

onBeforeUnmount(() => {
  mounted = false
  rememberView()
  if (rootEl.value) rootEl.value.removeEventListener('keydown', onKeydownCapture, true)
  if (stopEdits) stopEdits()
  unregisterEditorPane(props.node.id, paneApi)
  clearTimeout(revealTimer)
  clearTimeout(richTimer)
  leaveDiff()
  if (diffEditor) diffEditor.dispose()
  diffEditor = null
  // The models stay (documents.js): this pane may only be moving; closing
  // it (App.closeLeaf) lets go of its files.
  if (editor) {
    editor.setModel(null)
    editor.dispose()
  }
  editor = null
})
</script>

<template>
  <div
    ref="rootEl"
    class="pane editor-pane"
    :class="{
      active: isActive,
      maximized: isMaximized,
      highlighted: ctx.highlightId.value === node.id
    }"
    :data-pane-id="node.id"
    data-pane-kind="editor"
    tabindex="-1"
    @mousedown="onPaneMouseDown"
  >
    <div class="pane-nav" title="Drag to move this pane" @mousedown.stop="onNavMouseDown" @pointerdown="onNavPointerDown">
      <div class="pane-nav-left">
        <span v-if="node.num" class="pane-num" :title="`Pane #${node.num}`">{{ node.num }}</span>
        <span class="pane-icon" title="Editor">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <span class="pane-title" :title="activeDocPath || title">{{ title }}</span>
      </div>
      <div class="pane-nav-actions" @mousedown.stop>
        <button v-if="activeDocPath" class="pane-nav-btn" title="Copy the file's full path" aria-label="Copy path" @click="copyPath">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="8.5" rx="1.5" stroke="currentColor" stroke-width="1.3" />
            <path d="M10.5 3.5V3a1 1 0 00-1-1h-6a1 1 0 00-1 1v7a1 1 0 001 1h.5" stroke="currentColor" stroke-width="1.3" />
          </svg>
        </button>
        <button v-if="activeDoc" class="pane-nav-btn" title="Open in VS Code (at the cursor's line)" aria-label="Open in VS Code" @click="openExternally">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v3.5a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V5a.5.5 0 01.5-.5h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button class="pane-nav-btn" :title="isMaximized ? 'Restore pane' : 'Maximize pane'" @click="ctx.toggleMaximize(node.id)">
          <svg v-if="isMaximized" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button class="pane-nav-btn close" title="Close pane (Ctrl+Shift+W)" aria-label="Close pane" @click="ctx.closeLeaf(node.id)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>

    <div class="ed-body">
      <div class="ed-tabs" role="tablist" aria-label="Open files" @wheel.passive="onTabsWheel">
        <div
          v-for="f in files"
          :key="f.path"
          class="ed-tab"
          role="tab"
          :aria-selected="samePath(f.path, node.activePath)"
          :class="{
            active: samePath(f.path, node.activePath),
            preview: f.preview,
            diff: !!f.diff,
            dirty: docOf(f) && docOf(f).dirty,
            deleted: !f.diff && docOf(f) && docOf(f).deleted,
            failed: !f.diff && defaultMode(f) !== 'image' && docOf(f) && !!docOf(f).error
          }"
          :title="docPathOf(f) + (f.preview ? '\nPreview: double-click to keep it open' : '')"
          :data-path="docPathOf(f)"
          :data-diff="f.diff ? f.diff.area : null"
          @mousedown.left.prevent="activate(f.path)"
          @mousedown.middle.prevent
          @mouseup.middle="closeTab(f.path)"
          @dblclick="pin(f.path)"
        >
          <span class="ed-tab-name">{{ tabLabel(f) }}</span>
          <span v-if="!f.diff && docOf(f) && docOf(f).deleted" class="ed-tab-tag">deleted</span>
          <button
            class="ed-tab-close"
            :class="{ dirty: docOf(f) && docOf(f).dirty }"
            :title="docOf(f) && docOf(f).dirty ? 'Unsaved changes. Close (Ctrl+W)' : 'Close (Ctrl+W)'"
            :aria-label="docOf(f) && docOf(f).dirty ? `Close ${tabLabel(f)} (unsaved changes)` : `Close ${tabLabel(f)}`"
            @mousedown.stop
            @click.stop="closeTab(f.path)"
          >
            <span class="ed-dot" aria-hidden="true"></span>
            <svg class="ed-x" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div v-if="!diffInfo && activeDoc && activeDoc.external" class="ed-banner" role="alert">
        <span class="ed-banner-text">This file changed on disk while you have unsaved edits. Saving will overwrite the newer disk content.</span>
        <span class="ed-banner-actions">
          <button class="exit-btn" @click="compare">Compare</button>
          <button class="exit-btn" @click="reloadDisk">Reload from Disk</button>
          <button class="exit-btn" @click="keepEdits">Keep My Edits</button>
        </span>
      </div>

      <div v-if="activeFile && (diffInfo || (activeDoc && (!activeDoc.error || mode === 'image')))" class="ed-bar" data-test="editor-bar">
        <span class="ed-bar-path" :title="activeDocPath">{{ diffInfo ? diffInfo.rel : '' }}</span>
        <span v-if="mode !== 'edit' && mode !== 'image' && diffNote && !diffInfo" class="ed-note-inline">{{ diffBusy ? 'Reading…' : diffNote }}</span>
        <span v-if="diffInfo && diffReadOnly && !diffBusy && mode === 'diff'" class="ed-note-inline" data-test="diff-readonly">{{ diffInfo.area === 'staged' ? 'Staged: read-only' : 'Read-only' }}</span>
        <span class="ed-spacer"></span>
        <span v-if="activeDoc && activeDoc.saving" class="ed-state">Saving…</span>
        <span v-else-if="!diffInfo && activeDoc && activeDoc.deleted" class="ed-state warn">Deleted on disk: saving creates it again</span>
        <button
          v-if="diffInfo"
          type="button"
          class="ed-hbtn"
          :disabled="!canOpenFile"
          :title="canOpenFile ? 'Open file tab' : 'This diff has no modified-side file to open'"
          aria-label="Open file"
          data-test="diff-open-file"
          @click="openDiffTargetFile"
        >
          <LucideIcon name="fileText" :size="14" />
        </button>
        <NotesSendMenu
          v-if="diffInfo && fileNotes.length"
          :scopes="noteScopes"
          default-scope-id="file"
          trigger-label="AI notes"
          :trigger-count="fileNotes.length"
          trigger-class="ed-notes-pill"
          @delivered="onNotesDelivered"
        />
        <template v-if="isDiffSurface && mode !== 'rich'">
          <button
            type="button"
            class="ed-hbtn"
            :title="settings.diffSideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'"
            :aria-label="settings.diffSideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'"
            data-test="diff-layout"
            @click="toggleSideBySide"
          >
            <LucideIcon :name="settings.diffSideBySide ? 'rows2' : 'columns2'" :size="14" />
          </button>
          <button type="button" class="ed-hbtn" title="Previous change (Shift+F7)" aria-label="Previous change" data-test="diff-prev" @click="goToDiff('previous')">
            <LucideIcon name="arrowUp" :size="14" />
          </button>
          <button type="button" class="ed-hbtn" title="Next change (F7)" aria-label="Next change" data-test="diff-next" @click="goToDiff('next')">
            <LucideIcon name="arrowDown" :size="14" />
          </button>
        </template>
        <div v-if="toggleModes.length > 1" class="ed-toggle" role="radiogroup" aria-label="View" data-test="view-toggle">
          <button
            v-for="v in toggleModes"
            :key="v"
            type="button"
            class="ed-toggle-item"
            role="radio"
            :aria-checked="toggleValue === v"
            :aria-label="toggleMeta(v).label"
            :title="toggleMeta(v).title || toggleMeta(v).label"
            :data-mode="v"
            @click="setToggle(v)"
          >
            <LucideIcon :name="toggleMeta(v).icon" :size="14" />
          </button>
        </div>
      </div>

      <div class="ed-stack">
        <div v-show="showCode" ref="hostEl" class="ed-host" data-test="editor-host"></div>
        <div v-show="showDiff" ref="diffEl" class="ed-host" data-test="diff-host"></div>
        <RichView
          v-if="showRich && activeDocPath"
          :key="activeFile && activeFile.path"
          class="ed-host"
          :file="activeDocPath"
          :kind="mode === 'image' ? 'image' : kind"
          :text="richText"
          @open="openLinked"
        />
        <div v-if="message" class="ed-message" :class="{ error: (activeDoc && activeDoc.error && !diffInfo) || diffError }">{{ message }}</div>
      </div>
    </div>
  </div>
</template>
