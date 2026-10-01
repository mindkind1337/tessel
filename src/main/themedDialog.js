// Security questions (trust this folder, trust this repository) in Tessel's
// own look instead of a Windows alert, still answered only by the user.
//
// The question is a window of its own, owned by the main process: a small
// modal child of Tessel's window that loads a fixed local page (no script may
// run there: its CSP is default-src 'none'), with its own preload that draws
// the question as text and sends back the button chosen. The answer is taken
// only from that window's webContents, once; closing it is Cancel. Tessel's
// window (web pages, browser panes, agent Markdown) has no way to reach it,
// as with the native dialog it replaces.
//
// themedMessageBox([parent,] opts) takes dialog.showMessageBox's options and
// resolves to its shape ({ response, checkboxChecked }). If the window cannot
// be made or loaded, it falls back to the native dialog.
import { paletteTheme, paletteVars } from '../shared/themePalettes'

export const CONTENT_CHANNEL = 'themed-dialog:content'
export const READY_CHANNEL = 'themed-dialog:ready'
export const ANSWER_CHANNEL = 'themed-dialog:answer'

const WIDTH = 500
const MIN_HEIGHT = 140
const MAX_HEIGHT = 620

// The CSS variables of the classic and Warp-inspired themes (style.css,
// themes.css); the palette themes bring their own (themePalettes.js).
const CLASSIC_VARS = {
  '--chrome': '#101216',
  '--surface': '#181b21',
  '--surface-2': '#1f232b',
  '--surface-3': '#282d37',
  '--border': '#252932',
  '--border-strong': '#333946',
  '--accent': '#6c9cff',
  '--warn': '#f5a524',
  '--danger': '#e5484d',
  '--text': '#d6d9df',
  '--text-strong': '#f1f3f6',
  '--text-dim': '#7f8795'
}
const WARP_VARS = {
  '--chrome': '#161917',
  '--surface': '#202321',
  '--surface-2': '#252b27',
  '--surface-3': '#2c3930',
  '--border': '#303631',
  '--border-strong': '#47544a',
  '--accent': '#aed5b2',
  '--warn': '#dbba87',
  '--danger': '#e5a6a0',
  '--text': '#dfe5df',
  '--text-strong': '#eff3ed',
  '--text-dim': '#939e94'
}
const HEX = /^#[0-9a-f]{3,8}$/i

// The colours of a theme id, as CSS variables (only hex colours pass).
export function themeVars(id) {
  const palette = paletteTheme(id)
  const vars = palette ? paletteVars(palette.ui) : id === 'warp' ? WARP_VARS : CLASSIC_VARS
  const out = {}
  for (const [name, value] of Object.entries(vars)) {
    if (/^--[a-z0-9-]+$/.test(name) && HEX.test(String(value))) out[name] = String(value)
  }
  return out
}

// Text for the page: a string, without control characters (line breaks
// kept), and not longer than max.
function cleanText(value, max) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .slice(0, max)
}

// What the dialog window shows, from showMessageBox's options: plain data
// (strings, numbers), drawn as text by the dialog's preload.
export function dialogContent(opts = {}, vars = themeVars('classic'), { theme = 'classic', cover = false } = {}) {
  const raw = Array.isArray(opts.buttons) && opts.buttons.length ? opts.buttons.slice(0, 6) : ['OK']
  const buttons = raw.map((b) => cleanText(b, 80).replace(/\n/g, ' ') || 'OK')
  const valid = (n) => Number.isInteger(n) && n >= 0 && n < buttons.length
  // As Electron: the first "Cancel" / "No" button, else 0.
  let cancelId = valid(opts.cancelId) ? opts.cancelId : buttons.findIndex((b) => /^(cancel|no)$/i.test(b.trim()))
  if (!valid(cancelId)) cancelId = 0
  const defaultId = valid(opts.defaultId) ? opts.defaultId : cancelId
  return {
    type: opts.type === 'warning' || opts.type === 'error' || opts.type === 'question' ? opts.type : 'info',
    title: cleanText(opts.title, 200).replace(/\n/g, ' '),
    message: cleanText(opts.message, 2000),
    detail: cleanText(opts.detail, 4000),
    buttons,
    defaultId,
    cancelId,
    // Warp has confirmations of its own look; the others are the classic one
    // in their colours. cover: the window covers Tessel's, dimmed.
    theme: theme === 'warp' ? 'warp' : 'classic',
    cover: cover === true,
    vars: { ...vars }
  }
}

// The page itself: fixed, with no script (its preload draws the question).
export const DIALOG_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
* { box-sizing: border-box; }
:root { color-scheme: dark; }
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
body {
  color: var(--text, #d6d9df);
  font-family: 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
  font-size: 12.5px;
  user-select: none;
}
/* As Tessel's own confirmations (ConfirmDialog.vue, style.css): a card over
   the dimmed window. */
.backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 16px; }
body.cover .backdrop { background: rgba(5, 6, 8, 0.6); }
body:not(.cover) .backdrop { padding: 0; place-items: stretch; }
.card {
  width: min(500px, 100%);
  max-height: calc(100vh - 60px);
  overflow-y: auto;
  padding: 20px 22px 18px;
  border: 1px solid var(--border-strong, #333946);
  border-radius: 14px;
  background: var(--surface, #181b21);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
}
body:not(.cover) .card { width: 100%; max-height: 100vh; border-radius: 0; box-shadow: none; }
.card::-webkit-scrollbar { width: 8px; }
.card::-webkit-scrollbar-thumb { background: var(--border-strong, #333946); border-radius: 8px; }
.head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
.icon { flex: 0 0 auto; width: 16px; height: 16px; color: var(--accent, #6c9cff); }
.icon.warning { color: var(--warn, #f5a524); }
.icon.error { color: var(--danger, #e5484d); }
.icon .ic { display: none; }
.icon.info .ic-info, .icon.question .ic-info, .icon.warning .ic-warn, .icon.error .ic-warn { display: block; }
.title { margin: 0; color: var(--text-strong, #f1f3f6); font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.body { user-select: text; }
.message { margin: 0; color: var(--text, #d6d9df); font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.detail { margin: 8px 0 0; color: var(--text-dim, #7f8795); font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.detail:empty, .message:empty { display: none; }
.actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
button {
  height: 30px; padding: 0 14px;
  border: 1px solid var(--border-strong, #333946); border-radius: 7px;
  background: transparent; color: var(--text, #d6d9df);
  font: inherit; font-size: 12.5px; cursor: pointer;
}
button:hover { border-color: var(--accent, #6c9cff); color: var(--text-strong, #f1f3f6); }
button.primary {
  border-color: var(--accent, #6c9cff);
  background: color-mix(in srgb, var(--accent, #6c9cff) 22%, transparent);
  color: var(--text-strong, #f1f3f6);
}
button.primary.danger {
  border-color: color-mix(in srgb, var(--danger, #e5484d) 70%, transparent);
  background: color-mix(in srgb, var(--danger, #e5484d) 22%, transparent);
}
button:focus { outline: none; }
/* The focus ring once the keyboard moves it (Tab), not from the start. */
body.kbd button:focus { outline: 2px solid var(--accent, #6c9cff); outline-offset: 2px; }
/* The Warp-inspired theme's confirmations (themes.css). */
:root[data-theme='warp'] .card { width: min(440px, 100%); padding: 16px 18px; border-radius: 7px; background: var(--chrome, #161917); }
:root[data-theme='warp'] body:not(.cover) .card { width: 100%; border-radius: 0; }
:root[data-theme='warp'] .title { font-size: 13px; font-weight: 500; }
:root[data-theme='warp'] .message, :root[data-theme='warp'] .detail { font-size: 11px; }
:root[data-theme='warp'] .actions { gap: 6px; margin-top: 14px; }
:root[data-theme='warp'] button { height: 26px; padding-inline: 10px; border-radius: 4px; background: var(--surface, #202321); font-size: 11px; }
:root[data-theme='warp'] button.primary { border-color: color-mix(in srgb, var(--accent, #aed5b2) 52%, var(--border, #303631)); background: color-mix(in srgb, var(--accent, #aed5b2) 12%, var(--surface, #202321)); }
:root[data-theme='warp'] button.primary.danger { border-color: color-mix(in srgb, var(--danger, #e5a6a0) 58%, var(--border, #303631)); background: color-mix(in srgb, var(--danger, #e5a6a0) 10%, var(--surface, #202321)); color: var(--danger, #e5a6a0); }
</style>
</head>
<body>
<div class="backdrop">
<div class="card" role="alertdialog" aria-modal="true" aria-labelledby="title" aria-describedby="message">
  <div class="head">
    <svg id="icon" class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <g class="ic ic-warn"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></g>
      <g class="ic ic-info"><circle cx="12" cy="12" r="9.5"/><path d="M12 16v-5"/><path d="M12 8h.01"/></g>
    </svg>
    <h1 id="title" class="title"></h1>
  </div>
  <div class="body">
    <p id="message" class="message"></p>
    <p id="detail" class="detail"></p>
  </div>
  <div id="actions" class="actions"></div>
</div>
</div>
</body>
</html>`

export const DIALOG_URL = `data:text/html;charset=utf-8,${encodeURIComponent(DIALOG_HTML)}`

// themedMessageBox([parent,] opts) -> Promise<{ response, checkboxChecked }>.
// deps: BrowserWindow, dialog (Electron's), preload (the dialog's preload
// file), getTheme() (the theme id Tessel's window shows), log.
// The window's messages are heard on its own webContents.ipc (Electron's IPC
// of that webContents alone), not on ipcMain: Tessel's channels there answer
// only its main window (ipcGuard.js), and no other page reaches this one.
export function createThemedDialog({ BrowserWindow, dialog, preload, getTheme = () => 'classic', log = null, readyTimeoutMs = 5000 }) {
  const native = (parent, opts) => (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts))

  return function themedMessageBox(a, b) {
    const parent = b === undefined ? null : a && !a.isDestroyed?.() ? a : null
    const opts = (b === undefined ? a : b) || {}
    let content
    let win
    try {
      const theme = getTheme()
      content = dialogContent(opts, themeVars(theme), { theme, cover: !!parent })
      win = new BrowserWindow({
        parent: parent || undefined,
        modal: !!parent,
        show: false,
        width: WIDTH,
        height: 220,
        useContentSize: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: !!parent,
        frame: false,
        // Without it, a frameless window that cannot be resized comes out
        // smaller than asked on Windows (its sizing border is taken off).
        thickFrame: false,
        // Over Tessel's window it is see-through: its page dims the window
        // and draws the card (rounded, with its shadow) in the middle.
        transparent: !!parent,
        hasShadow: !parent,
        title: content.title || 'Tessel',
        backgroundColor: parent ? '#00000000' : content.vars['--surface'] || '#181b21',
        webPreferences: {
          preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webviewTag: false,
          devTools: false,
          spellcheck: false,
          navigateOnDragDrop: false,
          safeDialogs: true,
          disableDialogs: true
        }
      })
    } catch (e) {
      log?.warn?.('dialog', `themed dialog unavailable, native one shown: ${e?.message || e}`)
      return native(parent, opts)
    }

    return new Promise((resolve) => {
      const wc = win.webContents
      const ipc = wc.ipc
      let settled = false
      let shown = false
      let timer = null

      const finish = (response, fallback = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ipc?.removeListener(ANSWER_CHANNEL, onAnswer)
          ipc?.removeListener(READY_CHANNEL, onReady)
        } catch {
          /* the window is gone */
        }
        try {
          if (!win.isDestroyed()) win.destroy()
        } catch {
          /* already gone */
        }
        if (fallback) {
          log?.warn?.('dialog', 'themed dialog did not load, native one shown')
          resolve(native(parent && !parent.isDestroyed?.() ? parent : null, opts))
        } else {
          resolve({ response, checkboxChecked: false })
        }
      }
      // Only this window's page answers, once, with one of its buttons.
      const onAnswer = (event, index) => {
        if (!event || event.sender !== wc || settled || !shown) return
        if (!Number.isInteger(index) || index < 0 || index >= content.buttons.length) return
        finish(index)
      }
      // The preload drew the question: size the window to it, then show it.
      const onReady = (event, height) => {
        if (!event || event.sender !== wc || settled || shown) return
        shown = true
        clearTimeout(timer)
        const h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(Number(height) || 220)))
        try {
          const p = parent && !parent.isDestroyed() && !parent.isMinimized?.() ? parent.getContentBounds?.() : null
          if (p && p.width > 0 && p.height > 0) {
            win.setBounds({ x: p.x, y: p.y, width: p.width, height: p.height })
          } else {
            win.setContentSize(WIDTH, h)
            win.center()
          }
          win.show()
          win.focus()
        } catch (e) {
          log?.warn?.('dialog', `themed dialog: ${e?.message || e}`)
        }
      }

      try {
        win.on('closed', () => finish(content.cancelId))
        if (!ipc || typeof ipc.on !== 'function') throw new Error('no webContents.ipc') // i18n-ignore caught below
        ipc.on(ANSWER_CHANNEL, onAnswer)
        ipc.on(READY_CHANNEL, onReady)
        win.removeMenu?.()
        wc.setWindowOpenHandler(() => ({ action: 'deny' }))
        wc.on('will-navigate', (event) => event.preventDefault())
        wc.on('will-redirect', (event) => event.preventDefault())
        wc.on('will-attach-webview', (event) => event.preventDefault())
        wc.on('did-finish-load', () => {
          if (!settled) wc.send(CONTENT_CHANNEL, content)
        })
        wc.on('did-fail-load', (_event, _code, _text, _url, isMainFrame) => {
          if (isMainFrame !== false) finish(content.cancelId, !shown)
        })
        wc.on('render-process-gone', () => finish(content.cancelId, !shown))
        timer = setTimeout(() => {
          if (!shown) finish(content.cancelId, true)
        }, readyTimeoutMs)
        Promise.resolve(win.loadURL(DIALOG_URL)).catch(() => finish(content.cancelId, !shown))
      } catch {
        finish(content.cancelId, !shown)
      }
    })
  }
}
