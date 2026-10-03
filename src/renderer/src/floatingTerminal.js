// The floating terminal: a drop-down terminal laid over the workspace, shown
// and hidden with Ctrl+` or its toolbar button, still running while hidden.
// After Orca's src/renderer/src/components/floating-terminal (MIT, Copyright
// (c) 2026 Lovecast Inc.): one terminal of its own, outside the panes' grid
// (never in a workspace's tree, so never in the sidebar, the team pickers or
// the saved layout), started in the current project's folder, toggled by a
// shortcut only (Escape is the terminal's), focus given back on hide.
// Tessel's version slides down from the top, Quake-style, with a height you
// drag (remembered); its terminal lives in the terminal host like a pane's,
// so a window reload re-attaches it (its id is kept here). Orca's panel also
// holds tabs, browser pages and Markdown files; Tessel's holds one terminal.
import { reactive } from 'vue'

export const FLOATING_STORAGE_KEY = 'tessel.floatingTerminal' // i18n-ignore
export const MIN_HEIGHT = 0.15
export const MAX_HEIGHT = 0.9
export const DEFAULT_HEIGHT = 0.45

// Its height, a share of the workspace's (kept within bounds).
export function clampHeight(h) {
  const n = Number(h)
  if (!Number.isFinite(n)) return DEFAULT_HEIGHT
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(n * 1000) / 1000))
}

// What is remembered: shown or not, its height, its terminal's id.
export function loadFloatingState(storage) {
  let saved = null
  try {
    saved = JSON.parse((storage && storage.getItem(FLOATING_STORAGE_KEY)) || 'null')
  } catch {
    saved = null
  }
  const s = saved && typeof saved === 'object' ? saved : {}
  return {
    open: s.open === true,
    height: clampHeight(s.height === undefined ? DEFAULT_HEIGHT : s.height),
    ptyId: typeof s.ptyId === 'string' && /^[\w-]{1,80}$/.test(s.ptyId) ? s.ptyId : null
  }
}

export function saveFloatingState(storage, state) {
  try {
    if (storage) storage.setItem(FLOATING_STORAGE_KEY, JSON.stringify({ open: !!state.open, height: clampHeight(state.height), ptyId: state.ptyId || null }))
  } catch {
    /* storage full or blocked: only this window remembers it */
  }
}

// Ctrl+` (the key left of 1, whatever the layout prints on it: ² in French
// AZERTY, # in Canadian French), without Shift or Alt (Ctrl+Alt is AltGr).
export function isFloatingToggleKey(e) {
  if (!e || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false
  return e.code === 'Backquote' || e.key === '`'
}

// The floating terminal's state and actions. App.vue gives it how panes are
// made (createLeaf, so it is a real Tessel terminal), how a terminal is
// stopped, and where a new one starts (the current project).
export function createFloatingTerminal({ createLeaf, killPty, dropBuffer, startOptions, storage } = {}) {
  const saved = loadFloatingState(storage)
  const state = reactive({
    open: saved.open,
    height: saved.height,
    // Its pane (a leaf like the grid's, never put in a tree).
    leaf: null,
    starting: false
  })
  // The terminal to re-attach (after a reload) until it is.
  let ptyId = saved.ptyId
  let pending = null

  function persist() {
    saveFloatingState(storage, { open: state.open, height: state.height, ptyId: state.leaf ? state.leaf.id : ptyId })
  }

  // Its terminal: the one it has, else the one still running in the terminal
  // host (re-attached), else a new one in the current project's folder.
  function ensureLeaf() {
    if (state.leaf) return Promise.resolve(state.leaf)
    if (pending) return pending
    state.starting = true
    pending = (async () => {
      const start = (startOptions && startOptions()) || {}
      const opts = { ...(start.opts || {}), keepOnFailure: true }
      if (ptyId) opts.id = ptyId
      let leaf = null
      try {
        leaf = await createLeaf(start.shellId || null, null, start.cwd || null, null, opts)
      } catch {
        leaf = null
      }
      state.leaf = leaf || null
      ptyId = leaf ? leaf.id : null
      state.starting = false
      pending = null
      persist()
      return state.leaf
    })()
    return pending
  }

  function show() {
    state.open = true
    persist()
    return ensureLeaf()
  }

  function hide() {
    state.open = false
    persist()
  }

  function toggle() {
    if (state.open) {
      hide()
      return Promise.resolve(state.leaf)
    }
    return show()
  }

  function setHeight(h) {
    state.height = clampHeight(h)
    persist()
  }

  // Its terminal stopped (and its output forgotten): the next one is new.
  function stopTerminal() {
    const id = state.leaf ? state.leaf.id : ptyId
    if (id) {
      if (killPty) killPty(id)
      if (dropBuffer) dropBuffer(id)
    }
    state.leaf = null
    ptyId = null
  }

  // Close (its pane's close button): the terminal stops, the panel hides.
  function close() {
    stopTerminal()
    state.open = false
    persist()
  }

  // Restart (or Retry after a failed start): a new terminal in its place.
  async function restart() {
    stopTerminal()
    persist()
    return ensureLeaf()
  }

  // At startup: shown again if it was shown when the window closed or
  // reloaded (its terminal re-attached, or a new one).
  function restoreAtStart() {
    if (state.open) return ensureLeaf()
    return Promise.resolve(null)
  }

  // The terminal ids it uses, kept running when the host's unused terminals
  // are closed at startup (pty:reconcile).
  function ptyIds() {
    const id = state.leaf ? state.leaf.id : ptyId
    return id ? [id] : []
  }

  return { state, show, hide, toggle, setHeight, close, restart, restoreAtStart, ensureLeaf, ptyIds }
}
