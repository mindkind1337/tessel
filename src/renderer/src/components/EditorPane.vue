<script setup>
// A code editor pane (like Orca's editor, with the same Monaco engine): one
// tab per open file, preview tabs (italic) replaced by the next file opened
// with one click, a dirty dot that swaps with the close button, Ctrl+S to
// save, and a Changes view (the file against its last commit, Monaco's diff
// editor). Files changed on disk by an agent reload by themselves when you
// have no unsaved edits; otherwise a banner asks. Logic after Orca's
// MonacoEditor.tsx, monaco-view-state-persistence.ts, monaco-reveal.ts,
// ExternalFileChangeBanner.tsx, EditorViewToggle.tsx and editor-shortcuts.ts
// (MIT, Copyright (c) 2026 Lovecast Inc.), written for Vue.
import { ref, computed, watch, inject, nextTick, onMounted, onBeforeUnmount } from 'vue'
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
  saveDocs,
  reloadFromDisk,
  keepMyEdits,
  onDocEdited,
  saveViewState,
  viewStateOf,
  registerEditorPane,
  unregisterEditorPane
} from '../editor/documents'
import { pathKey, samePath, fileName, closeTab as closeTabData, pinTab } from '../editor/editorTabs'

const props = defineProps({
  node: { type: Object, required: true }
})

const ctx = inject('panelCtx')
const askConfirm = inject('askConfirm', null)

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
let diffSeq = 0
let shownKey = null // the file whose model the code editor shows
let revealDecorations = null
let revealTimer = null
let stopEdits = null
let paneApi = null
let mounted = false

const files = computed(() => props.node.files || [])
const activeFile = computed(() => files.value.find((f) => samePath(f.path, props.node.activePath)) || null)
const activeDoc = computed(() => (props.node.activePath ? docs[pathKey(props.node.activePath)] || null : null))
const mode = computed(() => (activeFile.value && activeFile.value.mode) || 'edit')
const diffNote = ref('')
const diffBusy = ref(false)

const title = computed(() => props.node.title || 'Editor')
const docOf = (f) => docs[pathKey(f.path)] || null

// Several tabs with the same name: their folder tells them apart.
function tabLabel(f) {
  const name = fileName(f.path)
  const twins = files.value.filter((o) => fileName(o.path).toLowerCase() === name.toLowerCase())
  if (twins.length < 2) return name
  const parts = f.path.split(/[\\/]/)
  return parts.length > 1 ? `${name} · ${parts[parts.length - 2]}` : name
}

// What the body shows instead of the editor (loading, an error).
const message = computed(() => {
  if (loadError.value) return loadError.value
  if (!files.value.length) return 'No file open. Open one from Jump to file (Ctrl+Shift+J) or the file explorer.'
  const d = activeDoc.value
  if (!d) return ''
  if (d.error) return d.error
  if (d.loading || !ready.value) return 'Opening…'
  return ''
})
const showDiff = computed(() => !message.value && mode.value !== 'edit')
const showCode = computed(() => !message.value && mode.value === 'edit')

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
  const model = d && !d.error && !d.loading ? modelOf(d.path) : null
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
  if (mode.value !== 'edit' && model) enterDiff(d, mode.value)
  else leaveDiff()
  applyReveal()
}

watch(
  () => [props.node.activePath, activeDoc.value && activeDoc.value.loading, activeDoc.value && activeDoc.value.error, mode.value, ready.value],
  () => nextTick(showActive)
)

// The pane's tabs changed: hold their files, let go of the others.
watch(
  () => files.value.map((f) => f.path).join('\n'),
  () => {
    reconcileOwner(props.node.id, files.value.map((f) => f.path))
    // The active tab is gone (closed elsewhere): show a neighbour.
    if (props.node.activePath && !activeFile.value) props.node.activePath = files.value.length ? files.value[0].path : null
  }
)

// --- Reveal a line (a file:line link, Jump to file) -------------------------------------
// Like Orca's performReveal: cursor there, the line centred, a brief highlight.
function applyReveal() {
  const r = props.node.reveal
  if (!r || !editor || !samePath(r.path, props.node.activePath)) return
  const model = editor.getModel()
  if (!model) return
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

// --- Changes (against the last commit) and Compare (against the disk) --------------------
function setMode(m) {
  const f = activeFile.value
  if (!f) return
  const i = files.value.indexOf(f)
  const next = files.value.slice()
  next[i] = { ...f, mode: m }
  props.node.files = next
}

let diffFor = '' // `${file}|${mode}` the diff editor shows
async function enterDiff(d, m) {
  if (!monaco) return
  if (diffFor === `${d.key}|${m}`) return
  diffFor = `${d.key}|${m}`
  const token = ++diffSeq
  diffBusy.value = true
  diffNote.value = ''
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
      diffNote.value = r.note || 'Left: the last commit (HEAD). Right: this file, editable. F7 / Shift+F7: next / previous change.'
    }
  }
  const model = modelOf(d.path)
  if (!model || token !== diffSeq) return
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor(diffEl.value, {
      ...editorOptions(),
      minimap: { enabled: false },
      automaticLayout: true,
      originalEditable: false,
      readOnly: false,
      renderSideBySide: !!settings.diffSideBySide,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      maxTokenizationLineLength: 20000
    })
  }
  const old = diffOriginal
  diffOriginal = monaco.editor.createModel(text, model.getLanguageId())
  diffEditor.setModel({ original: diffOriginal, modified: model })
  if (old) old.dispose()
  diffBusy.value = false
}

function leaveDiff() {
  diffFor = ''
  diffSeq++
  diffBusy.value = false
  if (diffEditor) diffEditor.setModel(null)
  if (diffOriginal) diffOriginal.dispose()
  diffOriginal = null
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
  const d = getDoc(path)
  // Its last tab: closing it would lose the unsaved edits.
  if (d && d.dirty && ownersOf(path).length <= 1) {
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
    // Saved, and still clean after (an edit typed during the save is saved
    // too): otherwise the tab stays open.
    if (answer === true && !(await saveDocs([path]))) return
  }
  if (!files.value.some((f) => samePath(f.path, path))) return
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
  if (e.ctrlKey && e.shiftKey && !e.altKey) return ['e', 'o', 'w', 'b', 'k', 'n', 't', 'r', 'p', 'x', 'j', ' '].includes(k.toLowerCase())
  if (e.ctrlKey && !e.shiftKey && !e.altKey) return ['=', '+', '-', '0', ',', 'PageUp', 'PageDown'].includes(k)
  // Alt+Up/Down stay Monaco's (move a line); Alt+Left/Right move between panes.
  if (e.altKey && !e.ctrlKey && !e.shiftKey) return ['ArrowLeft', 'ArrowRight'].includes(k)
  return k === 'F1'
}
function onKeydownCapture(e) {
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
  await saveDoc(d.path)
}

// --- Focus -------------------------------------------------------------------------------
function focusEditor() {
  if (showDiff.value && diffEditor) diffEditor.getModifiedEditor().focus()
  else if (editor && editor.getModel()) editor.focus()
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
  const d = activeDoc.value
  if (d && window.shellApi.writeClipboard) {
    window.shellApi.writeClipboard(d.path)
    if (ctx.copied) ctx.copied('Path')
  }
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
  reconcileOwner(props.node.id, files.value.map((f) => f.path))
  stopEdits = onDocEdited((d) => {
    // Editing a preview tab keeps it (Orca, VS Code).
    if (files.value.some((f) => f.preview && samePath(f.path, d.path))) props.node.files = pinTab(files.value, d.path)
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
        <span class="pane-title" :title="activeDoc ? activeDoc.path : title">{{ title }}</span>
      </div>
      <div class="pane-nav-actions" @mousedown.stop>
        <button v-if="activeDoc" class="pane-nav-btn" title="Copy the file's full path" aria-label="Copy path" @click="copyPath">
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
            dirty: docOf(f) && docOf(f).dirty,
            deleted: docOf(f) && docOf(f).deleted,
            failed: docOf(f) && !!docOf(f).error
          }"
          :title="f.path + (f.preview ? '\nPreview: double-click to keep it open' : '')"
          :data-path="f.path"
          @mousedown.left.prevent="activate(f.path)"
          @mousedown.middle.prevent
          @mouseup.middle="closeTab(f.path)"
          @dblclick="pin(f.path)"
        >
          <span class="ed-tab-name">{{ tabLabel(f) }}</span>
          <span v-if="docOf(f) && docOf(f).deleted" class="ed-tab-tag">deleted</span>
          <button
            class="ed-tab-close"
            :class="{ dirty: docOf(f) && docOf(f).dirty }"
            :title="docOf(f) && docOf(f).dirty ? 'Unsaved changes. Close (Ctrl+W)' : 'Close (Ctrl+W)'"
            :aria-label="docOf(f) && docOf(f).dirty ? `Close ${fileName(f.path)} (unsaved changes)` : `Close ${fileName(f.path)}`"
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

      <div v-if="activeDoc && activeDoc.external" class="ed-banner" role="alert">
        <span class="ed-banner-text">This file changed on disk while you have unsaved edits. Saving will overwrite the newer disk content.</span>
        <span class="ed-banner-actions">
          <button class="exit-btn" @click="compare">Compare</button>
          <button class="exit-btn" @click="reloadDisk">Reload from Disk</button>
          <button class="exit-btn" @click="keepEdits">Keep My Edits</button>
        </span>
      </div>

      <div v-if="activeDoc && !activeDoc.error" class="ed-bar">
        <div class="launch-seg ed-seg" role="group" aria-label="View">
          <button class="launch-seg-btn" :class="{ on: mode === 'edit' }" :aria-pressed="mode === 'edit'" @click="setMode('edit')">Edit</button>
          <button
            class="launch-seg-btn"
            :class="{ on: mode === 'changes' }"
            :aria-pressed="mode === 'changes'"
            title="Uncommitted changes: this file against its last commit"
            @click="setMode('changes')"
          >
            Changes
          </button>
        </div>
        <label v-if="mode !== 'edit'" class="ed-check" title="Side by side instead of inline">
          <input v-model="settings.diffSideBySide" type="checkbox" />
          Side by side
        </label>
        <span v-if="mode !== 'edit'" class="ed-note-inline">{{ diffBusy ? 'Reading…' : diffNote }}</span>
        <span class="ed-spacer"></span>
        <span v-if="activeDoc.saving" class="ed-state">Saving…</span>
        <span v-else-if="activeDoc.deleted" class="ed-state warn">Deleted on disk: saving creates it again</span>
      </div>

      <div class="ed-stack">
        <div v-show="showCode" ref="hostEl" class="ed-host" data-test="editor-host"></div>
        <div v-show="showDiff" ref="diffEl" class="ed-host" data-test="diff-host"></div>
        <div v-if="message" class="ed-message" :class="{ error: activeDoc && activeDoc.error }">{{ message }}</div>
      </div>
    </div>
  </div>
</template>
