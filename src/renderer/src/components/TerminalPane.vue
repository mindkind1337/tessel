<script setup>
import { ref, reactive, inject, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { getBuffer } from '../ptyStore'
import BrandIcon from './BrandIcon.vue'
import { settings, fontStack } from '../settings'
import { terminalTheme } from '../themes'

// Mouse-reporting modes (X10, normal, button, any-event, UTF-8, SGR, urxvt).
const MOUSE_MODES = [9, 1000, 1002, 1003, 1005, 1006, 1015]
import { registerPane, unregisterPane, getPane } from '../paneRegistry'
import {
  setAgentStatus,
  setAttention,
  clearAttention,
  attention,
  limits,
  setLimit,
  clearLimit,
  setApproval,
  approvals
} from '../agentStatus'
import { promptShowsPlaceholder } from '../promptCheck'
import { detectLimit, detectApproval, detectTaskDone } from '../agentLimit'
import { modelLabel } from '../../../shared/modelLabel'

const props = defineProps({
  node: { type: Object, required: true }
})

const ctx = inject('panelCtx')
const hostEl = ref(null)
const exited = ref(false)
// False once the pane is gone (checked after awaits).
let mounted = true
const exitCode = ref(null)
const micMenu = ref(false)
// Scrolled up into history? Then offer a button back to the latest output.
const scrolledUp = ref(false)
const newBelow = ref(false)
const MIN_COLS = 40
const MIN_ROWS = 10

const isActive = computed(() => ctx.activeId.value === props.node.id)
const isMember = computed(() => ctx.broadcast.value && props.node.broadcast)
const isMaximized = computed(() => ctx.maximizedId.value === props.node.id)
const isAgent = computed(() => props.node.kind === 'agent')

// The model the agent uses, shown in the header: read from its conversation
// file (so a /model change shows up), its command or its settings. Checked
// every 20 s and each time it finishes working.
const agentModel = ref(null) // { model, effort, source } | null
const modelText = computed(() => {
  const m = agentModel.value
  if (!m || !m.model) return ''
  return modelLabel(m.model) + (m.effort ? ` · ${m.effort}` : '')
})
const modelTitle = computed(() => {
  const m = agentModel.value
  if (!m) return ''
  const from =
    m.source === 'session'
      ? 'from its latest answer'
      : m.source === 'command'
        ? 'from its command'
        : m.source === 'picked'
          ? 'the model last picked in it'
          : 'from its settings (a change inside the agent may not show)'
  return `Model: ${m.model}${m.effort ? ` (reasoning ${m.effort})` : ''}\n${from}`
})
let modelBusy = false
async function refreshModel() {
  if (!isAgent.value || !window.shellApi.agentModel || modelBusy) {
    if (!isAgent.value) agentModel.value = null
    return
  }
  modelBusy = true
  try {
    const n = props.node
    agentModel.value = await window.shellApi.agentModel({
      agentId: n.agentId,
      sessionId: n.sessionId,
      command: n.agentCommand,
      cwd: n.startDir,
      launchedAt: n.launchedAt || 0
    })
  } catch {
    /* keep what it showed */
  } finally {
    modelBusy = false
  }
}
const modelTimer = setInterval(refreshModel, 20000)
onBeforeUnmount(() => clearInterval(modelTimer))
watch(
  () => [props.node.kind, props.node.agentId, props.node.sessionId],
  () => refreshModel(),
  { immediate: true }
)

// Busy/idle indicator for agent panes: an agent that is actively emitting output
// is "working"; once output has been quiet for a moment it is "idle" — i.e.
// waiting for your input. This is a backend-agnostic heuristic (no TUI parsing).
const agentStatus = ref('idle') // 'busy' | 'idle'
watch(agentStatus, (v) => {
  setAgentStatus(props.node.id, v)
  if (v === 'idle') refreshModel() // an answer just ended
})
let statusTimer = 0
let busySince = 0
const IDLE_AFTER_MS = 1400
// Only a real stretch of work counts as "finished" (typing echoes and redraws
// also produce output, but only for a moment).
const ATTENTION_AFTER_MS = 4000
let lastRecheck = 0
// Output that answers something done here (a click that focuses the pane, a
// resize, a key typed) is the agent redrawing or echoing, not working: it does
// not count as activity for this long after it.
const REDRAW_MS = 700
let redrawUntil = 0
function expectRedraw() {
  redrawUntil = Date.now() + REDRAW_MS
}
function markActivity() {
  if (Date.now() < redrawUntil) return
  if (!isAgent.value) return
  // An approval prompt or a usage limit flagged earlier: still on screen? An
  // agent that keeps redrawing a spinner ("Working 12m") never goes quiet, so
  // this cannot wait for the idle check below. At most once a second.
  const id = props.node.id
  if ((approvals[id] || limits[id]) && Date.now() - lastRecheck > 1000) {
    lastRecheck = Date.now()
    const screen = screenText(12)
    if (approvals[id] && !detectApproval(screen)) setApproval(id, false)
    if (limits[id] && !detectLimit(screen)) clearLimit(id)
  }
  if (agentStatus.value !== 'busy') busySince = Date.now()
  agentStatus.value = 'busy'
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = setTimeout(() => {
    agentStatus.value = 'idle'
    const worked = Date.now() - busySince - IDLE_AFTER_MS
    const screen = screenText(12)
    // Waiting for you to approve a command or an edit: not "finished".
    const asks = detectApproval(screen)
    setApproval(props.node.id, asks)
    if (asks) return
    // Stopped because it hit its usage limit? Say so instead of "finished".
    const hit = detectLimit(screen)
    if (hit) {
      const isNew = !limits[props.node.id]
      setLimit(props.node.id, hit)
      if (isNew) ctx.notifyAgentLimit(props.node, hit)
      return
    }
    // Working again for real: whatever limit it had is over.
    if (worked >= ATTENTION_AFTER_MS) clearLimit(props.node.id)
    // A task it was given is finished (it printed the task signal).
    if (worked >= ATTENTION_AFTER_MS && detectTaskDone(screen) && ctx.agentReportedDone) {
      ctx.agentReportedDone(props.node.id)
    }
    const lookingHere = isActive.value && document.hasFocus()
    if (worked >= ATTENTION_AFTER_MS && !lookingHere) {
      setAttention(props.node.id)
      ctx.notifyAgentDone(props.node)
    }
  }, IDLE_AFTER_MS)
}

// The last `lines` non-empty lines on screen as plain text (a tall pane can
// have its content at the top and blank rows below). A line the terminal
// wrapped over several rows (a narrow pane) comes back whole, so a word like
// TASK_COMPLETE is never cut in two.
function screenText(lines = 20) {
  if (!term) return ''
  const buf = term.buffer.active
  const out = []
  let tail = ''
  for (let y = buf.baseY + term.rows - 1; y >= 0 && out.length < lines; y--) {
    const line = buf.getLine(y)
    if (!line) continue
    tail = line.translateToString(!tail) + tail
    // This row continues the one above it: keep collecting.
    if (line.isWrapped && y > 0) continue
    if (tail.trim()) out.unshift(tail)
    tail = ''
    if (y <= buf.baseY) break
  }
  return out.join('\n')
}

const needsYou = computed(() => !!attention[props.node.id])
const limit = computed(() => limits[props.node.id] || null)

const asksApproval = computed(() => !!approvals[props.node.id])
// The task this agent is doing (or waiting to have reviewed), if any.
const task = computed(() => (ctx.taskOfPane ? ctx.taskOfPane(props.node.id) : null))
// How it is doing (src/shared/tracking.js), when it may be stuck.
const track = computed(() => (ctx.trackOf ? ctx.trackOf(props.node.id) : null))

// The team this pane is in (a named, coloured group of agents), if any.
// (Checked: in the dev build this file can reload before App.vue provides it.)
// This pane leads its team.
const isLead = computed(() => !!(team.value && team.value.leadId === props.node.id))
const team = computed(() => (ctx.teamById ? ctx.teamById(props.node.team) : null))
const paneStyle = computed(() => {
  const style = {}
  if (isAgent.value) style['--accent'] = props.node.accent
  if (team.value) style['--team'] = team.value.color
  return style
})

function acknowledge() {
  clearAttention(props.node.id)
}

let term = null
let fit = null
let search = null
let ro = null
let unsubData = null
let unsubExit = null
let lastCols = 0
let lastRows = 0

// Resize strategy: wait until the size has settled, then resize the VIEW and
// the PTY together, once. Resizing on every pixel of a divider drag sends the
// shell a storm of size changes; full-screen programs (Claude Code, Codex, vim)
// then redraw at sizes that are already stale while xterm reflows underneath
// them, which leaves broken, duplicated or hidden lines. Keeping xterm and the
// PTY at the same size, changed in one step, avoids that. setTimeout (not rAF)
// so panes still refit while the window is unfocused or occluded.
const RESIZE_SETTLE_MS = 90
let fitTimer = 0
// A pane that was at the latest output stays there through a resize (a
// sidebar opening, a split) and the redraw the program sends right after it:
// the reflow would otherwise leave it scrolled up with "New output" shown.
const KEEP_BOTTOM_MS = 1500
let keepBottomUntil = 0

function atBottom() {
  const buf = term.buffer.active
  return buf.viewportY >= buf.baseY
}

function doFit() {
  if (!term || !fit) return
  try {
    const dims = fit.proposeDimensions()
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
    // Never shrink to nothing (e.g. while the pane is momentarily unmeasurable).
    if (dims.cols < 2 || dims.rows < 1) return
    if (dims.cols !== term.cols || dims.rows !== term.rows) {
      expectRedraw()
      const wasAtBottom = atBottom() || Date.now() < keepBottomUntil
      term.resize(dims.cols, dims.rows)
      if (wasAtBottom) {
        keepBottomUntil = Date.now() + KEEP_BOTTOM_MS
        term.scrollToBottom()
      }
    }
    notifyPtySize()
  } catch {
    /* element not measurable yet */
  }
}

// Tell the PTY its new size, only when it really changed.
function notifyPtySize() {
  if (!term || term.cols < 1 || term.rows < 1) return
  if (term.cols === lastCols && term.rows === lastRows) return
  lastCols = term.cols
  lastRows = term.rows
  window.shellApi.resizePty(props.node.id, term.cols, term.rows)
}

function scheduleFit() {
  if (fitTimer) clearTimeout(fitTimer)
  fitTimer = setTimeout(() => {
    fitTimer = 0
    doFit()
  }, RESIZE_SETTLE_MS)
}

function publishMinSize() {
  if (!term || !hostEl.value || term.cols < 1 || term.rows < 1) return
  const screen = hostEl.value.querySelector('.xterm-screen')
  if (!screen) return
  const rect = screen.getBoundingClientRect()
  const minWidth = Math.ceil((rect.width / term.cols) * MIN_COLS) + 14
  const minHeight = Math.ceil((rect.height / term.rows) * MIN_ROWS) + 42
  hostEl.value.style.setProperty('--terminal-min-width', `${minWidth}px`)
  hostEl.value.style.setProperty('--terminal-min-height', `${minHeight}px`)
}

function onLayoutChange() {
  scheduleFit()
}

function windowsPtyOptions() {
  if (props.node.backend === 'conpty') {
    return { backend: 'conpty', buildNumber: props.node.windowsBuild }
  }
  return { backend: 'winpty' }
}

function focusTerm() {
  ctx.setActive(props.node.id)
  acknowledge()
  if (term) term.focus()
}

// --- Find in terminal (Ctrl+Shift+F) ----------------------------------------
const findOpen = ref(false)
const findQuery = ref('')
const findInputEl = ref(null)
const findResult = reactive({ index: -1, count: 0 })
const FIND_DECORATIONS = {
  matchBackground: '#4a3f1a',
  matchBorder: '#8a7432',
  matchOverviewRuler: '#8a7432',
  activeMatchBackground: '#b8860b',
  activeMatchBorder: '#ffd166',
  activeMatchColorOverviewRuler: '#ffd166'
}

function openFind() {
  findOpen.value = true
  const sel = term ? term.getSelection() : ''
  if (sel && !sel.includes('\n')) findQuery.value = sel
  nextTick(() => {
    if (findInputEl.value) {
      findInputEl.value.focus()
      findInputEl.value.select()
    }
    if (findQuery.value) findNext()
  })
}

function closeFind() {
  findOpen.value = false
  if (search) search.clearDecorations()
  if (term) {
    term.clearSelection()
    term.focus()
  }
}

function findNext() {
  keepBottomUntil = 0
  if (search && findQuery.value) search.findNext(findQuery.value, { decorations: FIND_DECORATIONS })
}

function findPrev() {
  keepBottomUntil = 0
  if (search && findQuery.value)
    search.findPrevious(findQuery.value, { decorations: FIND_DECORATIONS })
}

function onFindInput() {
  if (!findQuery.value) {
    if (search) search.clearDecorations()
    findResult.index = -1
    findResult.count = 0
    return
  }
  // Incremental: re-search from the current match as you type.
  keepBottomUntil = 0
  if (search) search.findNext(findQuery.value, { incremental: true, decorations: FIND_DECORATIONS })
}

// --- Drag & drop files: type their paths into this pane ---------------------
const dropping = ref(false)

function quotePath(path) {
  const shell = props.node.shellId
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  if ((shell === 'wsl' || shell === 'gitbash') && m) {
    const rest = m[2].replace(/\\/g, '/')
    const unix =
      shell === 'wsl' ? `/mnt/${m[1].toLowerCase()}/${rest}` : `/${m[1].toLowerCase()}/${rest}`
    return `'${unix.replace(/'/g, `'\\''`)}'`
  }
  // PowerShell expands $var and $(...) inside "…" and in bare words: a
  // single-quoted path is taken as it is (its quotes doubled).
  if ((shell === 'powershell' || shell === 'pwsh') && !isAgent.value && /[\s&()'^;,$`{}@#[\]‘’‚‛]/.test(path)) {
    return `'${path.replace(/['‘’‚‛]/g, (q) => q + q)}'`
  }
  return /[\s&()'^;,%]/.test(path) ? `"${path}"` : path
}

function onDragOver(e) {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  dropping.value = true
}

function onDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) dropping.value = false
}

function onDrop(e) {
  dropping.value = false
  const files = e.dataTransfer ? [...e.dataTransfer.files] : []
  if (!files.length) return
  e.preventDefault()
  const toPath = window.shellApi.pathForFile || (() => '')
  const paths = files.map((f) => toPath(f)).filter(Boolean)
  if (!paths.length) return
  window.shellApi.writePty(props.node.id, paths.map(quotePath).join(' ') + ' ')
  focusTerm()
}

// Keys the app handles itself; the terminal must not also send them to the
// shell (Alt+Arrow would otherwise type escape sequences, for example).
function isAppShortcut(e) {
  const k = e.key
  if (e.ctrlKey && e.shiftKey && !e.altKey) {
    return ['e', 'o', 'w', 'b', 'k', 'n', 'f', 'r', 'p'].includes(k.toLowerCase())
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey) {
    return ['=', '+', '-', '0', ',', 'PageUp', 'PageDown'].includes(k)
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)
  }
  return k === 'F1'
}

function copySelection() {
  if (!term) return false
  const sel = term.getSelection()
  if (sel && sel.length) {
    window.shellApi.writeClipboard(sel)
    return true
  }
  return false
}

async function pasteClipboard() {
  const text = await window.shellApi.readClipboard()
  if (text) requestPaste(text)
  else if (window.shellApi.clipboardHasImage && (await window.shellApi.clipboardHasImage()))
    pasteImage()
}

// An image can't be typed into a terminal. Claude Code attaches an image
// whose file path is pasted, so we save the clipboard image and paste its
// path: instant, where Claude's own Alt+V takes seconds on Windows (it starts
// PowerShell to read the clipboard). Other programs read the clipboard
// themselves on Ctrl+V (Codex does it quickly).
async function pasteImage() {
  if (props.node.agentId === 'claude') {
    let file = null
    try {
      file = await window.shellApi.saveClipboardImage()
    } catch {
      /* fall back to Claude's own key */
    }
    if (file && term) term.paste(file)
    else window.shellApi.writePty(props.node.id, '\x1bv')
  } else {
    window.shellApi.writePty(props.node.id, '\x16')
  }
  if (term) term.focus()
}

// Pasting goes through xterm's paste(), which wraps the text as a bracketed
// paste when the program supports it (so several lines arrive as one block
// instead of running line by line) and sends it to the pane (or to every pane
// in broadcast). Text with line breaks waits for a confirmation first, so an
// accidental right-click can't run a pile of commands.
const pasteAsk = ref(null) // { text, lines, preview, more }
const pasteAskEl = ref(null)
const PREVIEW_LINES = 500

function requestPaste(text) {
  if (!text || !term) return
  if (settings.confirmMultilinePaste && /[\r\n]/.test(text)) {
    const all = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
    pasteAsk.value = {
      text,
      lines: all.length,
      preview: all.slice(0, PREVIEW_LINES).join('\n'),
      more: Math.max(0, all.length - PREVIEW_LINES)
    }
    nextTick(() => pasteAskEl.value && pasteAskEl.value.focus())
    return
  }
  term.paste(text)
  term.focus()
}

function confirmPaste() {
  const ask = pasteAsk.value
  pasteAsk.value = null
  if (ask && term) term.paste(ask.text)
  if (term) term.focus()
}

function cancelPaste() {
  pasteAsk.value = null
  if (term) term.focus()
}

// Ctrl+V: the browser pastes into xterm's hidden text box. Catch it first so
// it gets the same confirmation.
function onPasteEvent(e) {
  if (!e.target || !e.target.classList || !e.target.classList.contains('xterm-helper-textarea'))
    return
  e.preventDefault()
  e.stopPropagation()
  const data = e.clipboardData
  const text = data ? data.getData('text/plain') : ''
  if (text) requestPaste(text)
  else if (data && [...data.items].some((i) => i.type.startsWith('image/'))) pasteImage()
}

// Editable pane title — stored on the node so it survives layout changes and
// is captured by workspace persistence.
const paneTitle = ref(props.node.title || props.node.shellName)
const editingTitle = ref(false)
// Keep the shown title in sync when it's changed from elsewhere (e.g. an
// install pane renamed right after it opens), unless you're editing it.
watch(
  () => props.node.title,
  (t) => {
    if (!editingTitle.value && t) paneTitle.value = t
  }
)
const titleInputEl = ref(null)

function startEditTitle(e) {
  e.stopPropagation()
  editingTitle.value = true
  nextTick(() => titleInputEl.value && titleInputEl.value.select())
}

function saveTitle() {
  if (!paneTitle.value.trim()) paneTitle.value = props.node.shellName
  props.node.title = paneTitle.value
  editingTitle.value = false
  if (term) term.focus()
}

function cancelEditTitle() {
  editingTitle.value = false
  if (term) term.focus()
}

const ctxMenu = reactive({ visible: false, x: 0, y: 0, hasSelection: false })
const ctxMenuEl = ref(null)

async function onContextMenu(e) {
  e.preventDefault()
  // Right-click pastes, like PuTTY and Linux terminals: select text, then
  // right-click to paste it at the prompt. Shift+right-click (or the ⋯
  // button) opens the menu.
  if (settings.rightClickPaste && !e.shiftKey) {
    const sel = term ? term.getSelection() : ''
    if (sel) {
      window.shellApi.writeClipboard(sel)
      term.clearSelection()
      requestPaste(sel)
    } else {
      pasteClipboard()
    }
    return
  }
  otherPanes.value = ctx.otherPanes(props.node.id)
  const sel = term ? term.getSelection() : ''
  ctxMenu.hasSelection = sel.length > 0
  ctxMenu.x = e.clientX
  ctxMenu.y = e.clientY
  ctxMenu.visible = true
  await nextTick()
  if (ctxMenuEl.value) {
    ctxMenuEl.value.focus({ preventScroll: true })
    const r = ctxMenuEl.value.getBoundingClientRect()
    if (ctxMenu.x + r.width > window.innerWidth) ctxMenu.x = window.innerWidth - r.width - 4
    if (ctxMenu.y + r.height > window.innerHeight) ctxMenu.y = window.innerHeight - r.height - 4
  }
}

// The menu takes keyboard focus while open, so Esc closes it instead of
// being sent to the program running in the terminal.
function closeCtxMenuAndRefocus() {
  closeCtxMenu()
  if (term) term.focus()
}

function closeCtxMenu() {
  ctxMenu.visible = false
  ctx.highlightId.value = null
}

async function openMenuAtBtn(e) {
  e.stopPropagation()
  otherPanes.value = ctx.otherPanes(props.node.id)
  const sel = term ? term.getSelection() : ''
  ctxMenu.hasSelection = sel.length > 0
  const rect = e.currentTarget.getBoundingClientRect()
  ctxMenu.x = rect.left
  ctxMenu.y = rect.bottom + 2
  ctxMenu.visible = true
  await nextTick()
  if (ctxMenuEl.value) {
    ctxMenuEl.value.focus({ preventScroll: true })
    const r = ctxMenuEl.value.getBoundingClientRect()
    if (ctxMenu.x + r.width > window.innerWidth) ctxMenu.x = window.innerWidth - r.width - 4
    if (ctxMenu.y + r.height > window.innerHeight) ctxMenu.y = window.innerHeight - r.height - 4
  }
}

function menuCopy() {
  copySelection()
  term && term.clearSelection()
  closeCtxMenu()
}
function menuPaste() {
  pasteClipboard()
  closeCtxMenu()
}

function menuCopyOutput() {
  if (!term) return closeCtxMenu()
  const buf = term.buffer.active
  const lines = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  window.shellApi.writeClipboard(lines.join('\n').trimEnd())
  closeCtxMenu()
}

function menuClear() {
  if (term) term.clear()
  closeCtxMenu()
}
function menuSplit(dir) {
  ctx.splitLeaf(props.node.id, dir)
  closeCtxMenu()
}
function menuClose() {
  ctx.closeLeaf(props.node.id)
  closeCtxMenu()
}
// Clicking the header focuses the terminal. preventDefault stops the browser
// from then moving focus to the (non-focusable) header, which left the pane
// unable to receive typing until you clicked inside it again.
function onNavMouseDown(e) {
  if (!e.target.closest('input, label')) e.preventDefault()
  focusTerm()
}

// Drag the header to move the pane (buttons and inputs stay clickable; a click without movement is not a drag).
function onNavPointerDown(e) {
  if (e.button !== 0) return
  if (e.target.closest('button, input, label')) return
  ctx.beginPaneDrag(props.node.id, e)
}

// --- Hand text to another pane -------------------------------------------------
const otherPanes = ref([])
let paneApi = null

function pasteText(text) {
  if (!text) return
  // Bracketed paste when the program asked for it (Claude Code, Codex, modern
  // shells), so multi-line text arrives as one paste instead of many commands.
  const bracketed = term && term.modes && term.modes.bracketedPasteMode
  // Control sequences in the text (from another terminal or agent) could end
  // the paste early and run the rest as keystrokes: they are removed.
  text = String(text).replace(/\x1b\[20[01]~/g, '').replace(/\x1b/g, '')
  const data = bracketed ? `\x1b[200~${text}\x1b[201~` : text.replace(/\r?\n/g, '\r')
  window.shellApi.writePty(props.node.id, data)
}

function menuSendSelection(targetId) {
  const text = term ? term.getSelection() : ''
  closeCtxMenu()
  if (text) ctx.sendToPane(props.node.id, targetId, 'selection', text)
}

function menuAskReview(targetId) {
  closeCtxMenu()
  ctx.sendToPane(props.node.id, targetId, 'review')
}

function menuOpenHere() {
  const x = ctxMenu.x
  const y = ctxMenu.y
  closeCtxMenu()
  ctx.openLauncherAt({ left: x, bottom: y }, props.node.id)
}
function jumpToBottom() {
  if (!term) return
  term.scrollToBottom()
  scrolledUp.value = false
  newBelow.value = false
  term.focus()
}

function pickVoice(tip) {
  micMenu.value = false
  ctx.voiceTypingIn(props.node.id, tip)
}

function menuCopySession() {
  closeCtxMenu()
  if (!props.node.sessionId) return
  window.shellApi.writeClipboard(props.node.sessionId)
  ctx.copied('Session ID')
}
function menuFind() {
  closeCtxMenu()
  openFind()
}
function menuRestart() {
  closeCtxMenu()
  ctx.restartLeaf(props.node.id)
}

function onDocPointerDownMenu(e) {
  if (micMenu.value && !(e.target.closest && e.target.closest('.mic-group'))) micMenu.value = false
  if (ctxMenu.visible && ctxMenuEl.value && !ctxMenuEl.value.contains(e.target)) closeCtxMenu()
}
function onEscapeMenu(e) {
  if (e.key === 'Escape' && ctxMenu.visible) closeCtxMenu()
}

onMounted(() => {
  term = new Terminal({
    fontFamily: fontStack(settings.fontFamily),
    fontSize: settings.fontSize,
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    scrollback: settings.scrollback,
    allowProposedApi: true,
    windowsPty: windowsPtyOptions(),
    theme: terminalTheme(settings.theme)
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  // Ctrl+click (or click) a link: open it in the system browser.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (window.shellApi.openExternal) window.shellApi.openExternal(uri)
      else window.open(uri)
    })
  )
  const updateScrolled = () => {
    if (!term) return
    const buf = term.buffer.active
    const up = buf.viewportY < buf.baseY
    if (!up) newBelow.value = false
    scrolledUp.value = up
  }
  term.onScroll(updateScrolled)
  term.onWriteParsed(() => {
    if (!term) return
    const buf = term.buffer.active
    // Just resized from the bottom: the redraw keeps it at the bottom.
    if (buf.viewportY < buf.baseY && Date.now() < keepBottomUntil) term.scrollToBottom()
    else if (buf.viewportY < buf.baseY) newBelow.value = true
    updateScrolled()
  })

  search = new SearchAddon()
  term.loadAddon(search)
  // "Always select with the mouse": some programs (GitHub Copilot CLI, htop,
  // vim with mouse on) ask the terminal to send them clicks, and then dragging
  // no longer selects text unless you hold Shift. With the setting on, those
  // requests are ignored. (Only requests that set nothing but mouse modes, so
  // other modes in the same sequence still apply.)
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (!settings.alwaysSelect) return false
    const modes = params.map((p) => (Array.isArray(p) ? p[0] : p))
    return modes.length > 0 && modes.every((m) => MOUSE_MODES.includes(m))
  })
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    findResult.index = resultIndex
    findResult.count = resultCount
  })
  term.open(hostEl.value)
  // Anything done by hand in the terminal (wheel, keys like Shift+PageUp,
  // dragging the scrollbar, a click) ends "stay at the bottom" at once.
  const byHand = () => (keepBottomUntil = 0)
  for (const ev of ['wheel', 'keydown', 'pointerdown'])
    hostEl.value.addEventListener(ev, byHand, { passive: true, capture: true })
  // Draw with the graphics card (much faster with busy agents and many
  // panes), like VS Code. Falls back to the normal renderer if WebGL is
  // unavailable or the graphics context is lost.
  if (settings.gpuRendering)
    try {
      const gl = new WebglAddon()
      gl.onContextLoss(() => {
        try {
          gl.dispose()
        } catch {
          /* already gone */
        }
      })
      term.loadAddon(gl)
    } catch {
      /* no WebGL: keep the default renderer */
    }

  doFit()

  // Output saved when the app last closed: write it, a divider, then enough
  // blank lines to move it all into the scrollback, so the new shell (which
  // clears the visible screen as it starts) draws below it without erasing it.
  if (props.node.restoredText) {
    const rows = Math.max(1, term.rows)
    term.write(
      props.node.restoredText +
        // Reset, leave any full-screen mode and jump to the bottom row, so
        // the screen drawn by the saved output scrolls up intact.
        '\x1b[0m\x1b[?1049l\x1b[?25h\x1b[999;1H\r\n' +
        '\x1b[2m──── restored from your last session (scroll up to see it) ────\x1b[0m' +
        '\r\n'.repeat(rows)
    )
    props.node.restoredText = ''
  }

  // Replay any buffered history (e.g. after this pane was re-parented by a split).
  // Old output can hold questions to the terminal (cursor position, device
  // attributes): xterm would answer them again while replaying, and those
  // answers would reach the program as typed input. Nothing goes out until
  // the replay is parsed (it takes a moment; nobody types in it).
  let replaying = false
  const history = getBuffer(props.node.id)
  if (history) {
    replaying = true
    term.write(history, () => {
      replaying = false
    })
  }

  // User input → routed through App (handles broadcast / multi-write).
  term.onData((data) => {
    if (replaying) return
    expectRedraw()
    ctx.routeInput(props.node.id, data)
  })
  // Focus in or out (a click on the pane): the agent may redraw its screen.
  if (term.textarea) {
    term.textarea.addEventListener('focus', expectRedraw)
    term.textarea.addEventListener('blur', expectRedraw)
  }
  // onResize fires only when cols/rows actually change → debounce-notify the PTY.
  term.onResize(() => {
    publishMinSize()
    notifyPtySize()
  })
  notifyPtySize() // sync the PTY to the initial fitted size
  publishMinSize()

  // Selecting text copies it; Ctrl+Shift+C / Ctrl+Shift+V copy & paste.
  term.onSelectionChange(() => {
    if (settings.copyOnSelect) copySelection()
  })
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
      openFind()
      return false
    }
    if (isAppShortcut(e)) return false
    // Shift+Enter in an agent: a new line in the message, not sending it. The
    // terminal sends the same Enter for both, so each agent gets the key it
    // reads as "new line": Alt+Enter for Claude Code, Ctrl+J for the others.
    if (
      e.type === 'keydown' &&
      e.key === 'Enter' &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      isAgent.value
    ) {
      e.preventDefault()
      ctx.routeInput(props.node.id, props.node.agentId === 'claude' ? '\x1b\r' : '\n')
      return false
    }
    // xterm leaves a plain Space to the browser's keypress/input events, but
    // Windows sometimes stops delivering the character (seen after using
    // dictation): the keydown arrives and nothing follows, so spaces vanish
    // while letters (handled on keydown) still type. Send it on keydown.
    if (
      e.type === 'keydown' &&
      e.key === ' ' &&
      e.keyCode === 32 &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.isComposing
    ) {
      e.preventDefault()
      ctx.routeInput(props.node.id, ' ')
      return false
    }
    // Ctrl+V pastes (text or image, see onPasteEvent) instead of sending the
    // raw Ctrl+V key: let the browser raise its paste event.
    if (
      e.type === 'keydown' &&
      e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === 'v'
    )
      return false
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey) {
      const k = e.key.toLowerCase()
      if (k === 'c') {
        copySelection()
        return false
      }
      if (k === 'v') {
        pasteClipboard()
        return false
      }
    }
    return true
  })

  // Live output for this pane only.
  unsubData = window.shellApi.onData(({ id, data }) => {
    if (id === props.node.id && term) {
      term.write(data)
      markActivity()
    }
  })
  unsubExit = window.shellApi.onExit(async ({ id, exitCode: code, pid }) => {
    if (id !== props.node.id || !term) return
    // A pane restarted in place keeps its id: the end of the process it
    // replaced is not this pane's end (a late notice from the old one).
    if (pid && props.node.pid && pid !== props.node.pid) return
    // No pid (a terminal host started by an older Tessel): a pane restarted
    // in place asks the host whether its own terminal still runs.
    if (!pid && (props.node.gen || props.node.restartedAt)) {
      const gen = props.node.gen
      const a = await window.shellApi.attachPty(id).catch(() => null)
      if (!mounted || props.node.gen !== gen || !term) return
      if (a && a.ok && !a.exited && (!a.pid || !props.node.pid || a.pid === props.node.pid)) return
    }
    exited.value = true
    exitCode.value = code
    term.write(`\r\n\x1b[33m[process exited with code ${code}]\x1b[0m\r\n`)
  })

  // Refit whenever the pane is resized (divider drag, window resize, splits).
  ro = new ResizeObserver(() => scheduleFit())
  ro.observe(hostEl.value)
  ro.observe(hostEl.value.parentElement)
  window.addEventListener('resize', onLayoutChange)
  window.addEventListener('terminal-layout-change', onLayoutChange)
  window.addEventListener('pointerdown', onDocPointerDownMenu, true)
  window.addEventListener('keydown', onEscapeMenu)

  paneApi = {
    paste: pasteText,
    submit: () => window.shellApi.writePty(props.node.id, '\r'),
    getSelection: () => (term ? term.getSelection() : ''),
    screenText,
    // Is its input prompt empty (see promptCheck.js)?
    promptShowsPlaceholder: (promptChar) => promptShowsPlaceholder(term, promptChar)
  }
  registerPane(props.node.id, paneApi)

  if (props.node.exitedAtStart) exited.value = true
  if (isActive.value) term.focus()
})

watch(isActive, (a) => {
  if (a && term) term.focus()
  if (a && document.hasFocus()) acknowledge()
})

// Live settings. Text metrics changes refit right away.
watch(
  () => settings.theme,
  (theme) => {
    if (term) term.options.theme = terminalTheme(theme)
  }
)
watch(
  () => [settings.fontSize, settings.fontFamily],
  ([size, family]) => {
    if (!term) return
    term.options.fontSize = size
    term.options.fontFamily = fontStack(family)
    doFit()
  }
)
watch(
  () => [settings.cursorStyle, settings.cursorBlink],
  ([style, blink]) => {
    if (!term) return
    term.options.cursorStyle = style
    term.options.cursorBlink = blink
  }
)

// Turning it on also releases a mouse a program already took.
watch(
  () => settings.alwaysSelect,
  (on) => {
    if (on && term) term.write(MOUSE_MODES.map((m) => `\x1b[?${m}l`).join(''))
  }
)

watch(isMaximized, () => {
  nextTick(() => scheduleFit())
})

onBeforeUnmount(() => {
  mounted = false
  if (ro) ro.disconnect()
  if (fitTimer) clearTimeout(fitTimer)
  if (statusTimer) clearTimeout(statusTimer)
  window.removeEventListener('resize', onLayoutChange)
  window.removeEventListener('terminal-layout-change', onLayoutChange)
  window.removeEventListener('pointerdown', onDocPointerDownMenu, true)
  window.removeEventListener('keydown', onEscapeMenu)
  unregisterPane(props.node.id, paneApi)
  if (unsubData) unsubData()
  if (unsubExit) unsubExit()
  if (term) term.dispose()
  term = null
  // NOTE: the PTY is intentionally NOT killed here — the pane may merely be
  // re-mounting after a layout change. App.closeLeaf() owns PTY termination.
})
</script>

<template>
  <div
    class="pane"
    :class="{
      active: isActive,
      'broadcast-member': isMember,
      maximized: isMaximized,
      agent: isAgent,
      'needs-you': needsYou,
      highlighted: ctx.highlightId.value === node.id,
      'in-team': !!team,
      dropping
    }"
    :style="paneStyle"
    :data-pane-id="node.id"
    @mousedown="focusTerm"
    @contextmenu="onContextMenu"
    @paste.capture="onPasteEvent"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div
      class="pane-nav"
      :class="{ agent: isAgent, busy: isAgent && agentStatus === 'busy' }"
      :style="isAgent ? { '--accent': node.accent } : null"
      title="Drag to move this pane"
      @mousedown.stop="onNavMouseDown"
      @pointerdown="onNavPointerDown"
    >
      <div class="pane-nav-left">
        <span v-if="node.num" class="pane-num" :title="`Pane #${node.num}`">{{ node.num }}</span>
        <span
          class="pane-icon"
          :class="isAgent ? ['agent', needsYou ? 'attention' : agentStatus] : null"
          :style="isAgent ? { '--accent': node.accent } : null"
          :title="
            isAgent
              ? agentStatus === 'busy'
                ? `Agent is working${node.sessionId ? `\nSession ${node.sessionId}` : ''}`
                : `Agent is idle, waiting for input${node.sessionId ? `\nSession ${node.sessionId}` : ''}`
              : node.shellName
          "
        >
          <BrandIcon
            :kind="isAgent ? node.agentId : node.shellId"
            :accent="isAgent ? node.accent : null"
            :label="isAgent ? node.title : null"
            :size="15"
          />
          <span v-if="isAgent" class="pane-status-dot"></span>
        </span>
        <input
          v-if="editingTitle"
          ref="titleInputEl"
          v-model="paneTitle"
          class="pane-tab-input"
          @blur="saveTitle"
          @keydown.enter.prevent="saveTitle"
          @keydown.escape.prevent="cancelEditTitle"
          @mousedown.stop
          @click.stop
        />
        <span
          v-if="!editingTitle"
          class="pane-title"
          title="Double-click to rename"
          @dblclick="startEditTitle"
          >{{ paneTitle }}</span
        >
        <span v-if="isAgent && modelText" class="pane-model" :title="modelTitle">{{ modelText }}</span>
        <span
          v-if="node.worktree"
          class="pane-branch"
          :title="`Separate copy on branch ${node.worktree.branch}\n${node.worktree.path}`"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="4.5" cy="3.5" r="1.8" stroke="currentColor" stroke-width="1.4" />
            <circle cx="4.5" cy="12.5" r="1.8" stroke="currentColor" stroke-width="1.4" />
            <circle cx="11.5" cy="5.5" r="1.8" stroke="currentColor" stroke-width="1.4" />
            <path
              d="M4.5 5.3v5.4M11.5 7.3c0 2.5-2 3-5 4"
              stroke="currentColor"
              stroke-width="1.4"
            />
          </svg>
          {{ node.worktree.branch }}
        </span>
        <span
          v-if="task"
          class="pane-task"
          :class="task.column"
          :title="`Task: ${task.title}${task.worktree ? ` (branch ${task.worktree.branch})` : ''}`"
          >{{ task.column === 'review' ? 'To review: ' : '' }}{{ task.title }}</span
        >
        <span
          v-if="team"
          class="pane-team"
          :title="`Team: ${team.name}${isLead ? ' (this agent leads it)' : ''} (manage it under Sessions)`"
          >{{ team.name }}{{ isLead ? ' · lead' : '' }}</span
        >
        <button
          v-if="isAgent && ctx.unsent && ctx.unsent[node.id]"
          class="pane-unsent"
          title="A message was pasted but not seen taken: click to say what happened"
          @click.stop="ctx.resolveUnsent(node.id)"
        >
          message not confirmed
        </button>
        <span
          v-if="
            isAgent &&
            track &&
            (track.level === 'warn' || track.level === 'alert') &&
            !asksApproval &&
            !limit
          "
          class="pane-stuck"
          :class="track.level"
          :title="track.reason"
          >quiet {{ track.minutes }} min</span
        >
        <span
          v-if="isAgent && asksApproval"
          class="pane-approval"
          title="This agent is asking you to approve something"
          >approve?</span
        >
        <span
          v-else-if="isAgent && limit"
          class="pane-limit"
          :title="
            limit.reset
              ? `This agent hit its usage limit. It resets ${/^in /.test(limit.reset) ? '' : 'at '}${limit.reset}.`
              : 'This agent hit its usage limit.'
          "
          >limit{{ limit.reset ? ` · ${limit.reset}` : '' }}</span
        >
        <span v-else-if="isAgent && agentStatus === 'busy'" class="pane-working">working</span>
        <span v-else-if="needsYou" class="pane-needs-you">needs you</span>
        <span v-if="exited" class="exit-tag">exited</span>
      </div>
      <div class="pane-nav-actions" @mousedown.stop>
        <label
          v-if="ctx.broadcast.value"
          class="bc-toggle"
          :class="{ member: node.broadcast }"
          title="Include this pane in multi-write"
        >
          <input v-model="node.broadcast" type="checkbox" />
          write
        </label>
        <!-- voice typing, with its language -->
        <span class="mic-group">
          <button
            class="pane-nav-btn mic-btn"
            :title="`Speak instead of typing (${ctx.voiceName.value}). Windows voice typing, Win+H`"
            @click="ctx.voiceTyping(node.id)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect
                x="5.5"
                y="1.8"
                width="5"
                height="8"
                rx="2.5"
                stroke="currentColor"
                stroke-width="1.4"
              />
              <path
                d="M3.3 7.5a4.7 4.7 0 009.4 0M8 12.2v2"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
            </svg>
            <span v-if="ctx.voiceLabel.value" class="mic-lang">{{ ctx.voiceLabel.value }}</span>
          </button>
          <button
            v-if="ctx.voiceLanguages.value.length"
            class="pane-nav-btn mic-caret"
            title="Voice typing language"
            @click.stop="micMenu = !micMenu"
          >
            <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M2.5 4l2.5 2.5L7.5 4"
                stroke="currentColor"
                stroke-width="1.4"
                fill="none"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <div v-if="micMenu" class="mic-menu" @mousedown.stop>
            <div class="menu-label">Speak in</div>
            <button
              v-for="l in ctx.voiceLanguages.value"
              :key="l.tip"
              class="toolbar-menu-item"
              :class="{ selected: settings.voiceTip === l.tip }"
              @click="pickVoice(l.tip)"
            >
              <span class="mic-menu-tag">{{ l.tag.slice(0, 2).toUpperCase() }}</span>
              <span class="menu-item-name">{{ l.name }}</span>
            </button>
            <button
              class="toolbar-menu-item"
              :class="{ selected: !settings.voiceTip }"
              @click="pickVoice('')"
            >
              <span class="mic-menu-tag">⌨</span>
              <span class="menu-item-name">Current keyboard language</span>
            </button>
          </div>
        </span>
        <!-- open a terminal or agent next to this pane -->
        <button
          class="pane-nav-btn"
          title="Open a terminal or agent next to this pane"
          @click="(e) => ctx.openLauncherAt(e.currentTarget.getBoundingClientRect(), node.id)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 3v10M3 8h10"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <!-- ellipsis / more options -->
        <button class="pane-nav-btn" title="More options" @click="openMenuAtBtn">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="3" cy="8" r="1.4" fill="currentColor" />
            <circle cx="8" cy="8" r="1.4" fill="currentColor" />
            <circle cx="13" cy="8" r="1.4" fill="currentColor" />
          </svg>
        </button>
        <!-- maximize / restore -->
        <button
          class="pane-nav-btn"
          :title="isMaximized ? 'Restore pane' : 'Maximize pane'"
          @click="ctx.toggleMaximize(node.id)"
        >
          <svg
            v-if="isMaximized"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <!-- close -->
        <button
          class="pane-nav-btn close"
          title="Close pane (Ctrl+Shift+W)"
          @click="ctx.closeLeaf(node.id)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <line
              x1="3.5"
              y1="3.5"
              x2="12.5"
              y2="12.5"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
            <line
              x1="12.5"
              y1="3.5"
              x2="3.5"
              y2="12.5"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    </div>

    <div ref="hostEl" class="term-host"></div>

    <div v-if="findOpen" class="find-bar" @mousedown.stop>
      <input
        ref="findInputEl"
        v-model="findQuery"
        class="find-input"
        placeholder="Find"
        spellcheck="false"
        @input="onFindInput"
        @keydown.enter.exact.prevent="findNext"
        @keydown.shift.enter.prevent="findPrev"
        @keydown.escape.prevent="closeFind"
      />
      <span class="find-count">{{
        !findQuery
          ? ''
          : findResult.count
            ? `${findResult.index + 1} of ${findResult.count}`
            : 'No results'
      }}</span>
      <button class="pane-nav-btn" title="Previous (Shift+Enter)" @click="findPrev">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M4 10l4-4 4 4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button class="pane-nav-btn" title="Next (Enter)" @click="findNext">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button class="pane-nav-btn" title="Close (Esc)" @click="closeFind">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>

    <button
      v-if="scrolledUp && !exited"
      class="jump-bottom"
      :class="{ fresh: newBelow }"
      :title="newBelow ? 'New output below. Jump to the latest' : 'Jump to the latest output'"
      @mousedown.stop
      @click="jumpToBottom"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 2.5v10M3.5 8.5L8 13l4.5-4.5"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      {{ newBelow ? 'New output' : 'Latest' }}
    </button>

    <div v-if="node.failed" class="exit-overlay failed" @mousedown.stop>
      <span :title="node.failed">This terminal couldn't start.</span>
      <button class="exit-btn primary" @click="ctx.restartLeaf(node.id)">Retry</button>
      <button class="exit-btn" @click="ctx.closeLeaf(node.id, { force: true })">Close pane</button>
    </div>

    <div v-else-if="exited" class="exit-overlay" @mousedown.stop>
      <span>Process exited{{ exitCode !== null ? ` with code ${exitCode}` : '' }}.</span>
      <button class="exit-btn primary" @click="ctx.restartLeaf(node.id)">Restart</button>
      <button class="exit-btn" @click="ctx.closeLeaf(node.id, { force: true })">Close pane</button>
    </div>

    <div v-if="dropping" class="drop-hint">Drop to paste the file path</div>

    <div
      v-if="pasteAsk"
      ref="pasteAskEl"
      class="paste-ask"
      tabindex="-1"
      role="dialog"
      aria-label="Confirm paste"
      @mousedown.stop
      @contextmenu.stop.prevent
      @keydown.enter.stop="
        (e) => !e.target.closest('button') && (e.preventDefault(), confirmPaste())
      "
      @keydown.escape.prevent.stop="cancelPaste"
    >
      <div class="paste-ask-title">
        Paste {{ pasteAsk.lines }} {{ pasteAsk.lines === 1 ? 'line' : 'lines' }}?
      </div>
      <pre class="paste-ask-preview">{{ pasteAsk.preview }}</pre>
      <div v-if="pasteAsk.more" class="paste-ask-more">
        and {{ pasteAsk.more }} more {{ pasteAsk.more === 1 ? 'line' : 'lines' }}
      </div>
      <div class="paste-ask-actions">
        <button class="exit-btn" @click="cancelPaste">Cancel <kbd>Esc</kbd></button>
        <button class="exit-btn primary" @click="confirmPaste">Paste <kbd>Enter</kbd></button>
      </div>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="ctxMenu.visible"
      ref="ctxMenuEl"
      class="ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      tabindex="-1"
      @mousedown.stop
      @keydown.escape.prevent.stop="closeCtxMenuAndRefocus"
    >
      <div class="ctx-menu-header">
        <span class="ctx-menu-title">{{ node.num ? `#${node.num} ` : '' }}{{ paneTitle }}</span>
        <span class="ctx-menu-subtitle">{{ node.shellName }}</span>
      </div>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" :disabled="!ctxMenu.hasSelection" @click="menuCopy">
        Copy
      </button>
      <button class="ctx-menu-item" @click="menuPaste">Paste</button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" @click="menuCopyOutput">Copy output</button>
      <button class="ctx-menu-item" @click="menuClear">Clear</button>
      <button v-if="node.sessionId" class="ctx-menu-item" @click="menuCopySession">
        Copy session ID<span class="ctx-menu-shortcut">{{ node.sessionId.slice(0, 8) }}</span>
      </button>
      <button class="ctx-menu-item" @click="menuFind">
        Find<span class="ctx-menu-shortcut">Ctrl+Shift+F</span>
      </button>
      <div class="ctx-menu-sep"></div>
      <template v-if="otherPanes.length">
        <div class="ctx-menu-label">Send selection to</div>
        <button
          v-for="p in otherPanes"
          :key="'sel-' + p.id"
          class="ctx-menu-item pane-pick"
          :disabled="!ctxMenu.hasSelection"
          @mouseenter="ctx.highlightId.value = p.id"
          @mouseleave="ctx.highlightId.value = null"
          @click="menuSendSelection(p.id)"
        >
          <span class="ctx-with-icon">
            <span class="pane-num">{{ p.num }}</span>
            <BrandIcon :kind="p.kind" :accent="p.accent" :label="p.title" :size="13" />
            <span class="pick-title">{{ p.title }}</span>
          </span>
          <span class="ctx-menu-shortcut">{{ p.branch || p.where }}</span>
        </button>
        <template v-if="otherPanes.some((p) => p.agent)">
          <div class="ctx-menu-label">Ask to review this pane's changes</div>
          <button
            v-for="p in otherPanes.filter((p) => p.agent)"
            :key="'rev-' + p.id"
            class="ctx-menu-item pane-pick"
            @mouseenter="ctx.highlightId.value = p.id"
            @mouseleave="ctx.highlightId.value = null"
            @click="menuAskReview(p.id)"
          >
            <span class="ctx-with-icon">
              <span class="pane-num">{{ p.num }}</span>
              <BrandIcon :kind="p.kind" :accent="p.accent" :label="p.title" :size="13" />
              <span class="pick-title">{{ p.title }}</span>
            </span>
            <span class="ctx-menu-shortcut">{{ p.branch || p.where }}</span>
          </button>
        </template>
        <div class="ctx-menu-sep"></div>
      </template>
      <template v-if="team">
        <button
          v-if="isAgent && ctx.setTeamLead"
          class="ctx-menu-item"
          @click="(closeCtxMenu(), ctx.setTeamLead(team.id, isLead ? null : node.id))"
        >
          {{ isLead ? `Stop leading ${team.name}` : `Make lead of ${team.name}` }}
        </button>
        <button class="ctx-menu-item" @click="(closeCtxMenu(), ctx.leaveTeam(node.id))">
          Leave {{ team.name }}
        </button>
        <div class="ctx-menu-sep"></div>
      </template>
      <button class="ctx-menu-item" @click="menuOpenHere">Open terminal or agent here…</button>
      <button class="ctx-menu-item" @click="menuSplit('row')">
        Split right<span class="ctx-menu-shortcut">▥</span>
      </button>
      <button class="ctx-menu-item" @click="menuSplit('col')">
        Split down<span class="ctx-menu-shortcut">▤</span>
      </button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" @click="menuRestart">
        Restart<span class="ctx-menu-shortcut">Ctrl+Shift+R</span>
      </button>
      <button class="ctx-menu-item danger" @click="menuClose">Close pane</button>
    </div>
  </Teleport>
</template>
