// Reading a file for Tessel's file viewer (src/shared/fileKinds.js), and
// PDFs in their own window (Chromium's PDF viewer). Read-only: nothing here
// writes or runs anything.
import fs from 'fs'
import { isAbsolute } from 'path'
import { pathToFileURL } from 'url'
import { fileKind, extOf, IMAGE_MIME } from '../shared/fileKinds'

export const MAX_TEXT_BYTES = 20 * 1024 * 1024
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024

function statFile(file) {
  if (typeof file !== 'string' || !isAbsolute(file)) return { error: 'Not a full file path.' }
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return { error: 'This is not a file.' }
    return { st }
  } catch {
    return { error: 'The file was not found.' }
  }
}

// A NUL byte in the first 8 KB: binary (Orca's test, and git's).
function looksBinary(buf) {
  return buf.subarray(0, 8192).includes(0)
}

// -> { ok, kind, size, text } (text kinds) | { ok, kind: 'image', size, dataUrl }
//    | { ok, kind: 'pdf', size } | { ok: false, error, kind? }
export function readForView(file) {
  const { st, error } = statFile(file)
  if (error) return { ok: false, error }
  const kind = fileKind(file)
  if (kind === 'pdf') return { ok: true, kind, size: st.size }
  if (kind === 'image') {
    if (st.size > MAX_IMAGE_BYTES) return { ok: false, kind, error: 'This image is too large to show here.' }
    const mime = IMAGE_MIME[extOf(file)]
    const data = fs.readFileSync(file)
    return { ok: true, kind, size: st.size, dataUrl: `data:${mime};base64,${data.toString('base64')}` }
  }
  if (st.size > MAX_TEXT_BYTES) return { ok: false, kind, error: 'This file is too large to show here (over 20 MB).' }
  const buf = fs.readFileSync(file)
  if (looksBinary(buf)) return { ok: false, kind: 'binary', error: 'This is a binary file: Tessel cannot show it.' }
  return { ok: true, kind, size: st.size, text: buf.toString('utf8') }
}

// An image a Markdown file points to (a relative path next to it), as a data
// URL the viewer can show under Tessel's CSP (img-src 'self' data:).
export function readImageForView(file) {
  if (fileKind(file) !== 'image') return { ok: false, error: 'Not an image.' }
  return readForView(file)
}

// A PDF in its own window: Chromium's viewer (zoom, search, print). The page
// gets no preload and no Node; it can only show the file.
export function openPdfWindow(BrowserWindow, file, { icon } = {}) {
  const { error } = statFile(file)
  if (error) return { ok: false, error }
  if (fileKind(file) !== 'pdf') return { ok: false, error: 'Not a PDF.' }
  const win = new BrowserWindow({
    width: 900,
    height: 1000,
    title: file.split(/[\\/]/).pop(),
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    ...(icon ? { icon } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, plugins: true }
  })
  const url = pathToFileURL(file).href
  // Only this file: links in the PDF open in the system browser.
  win.webContents.on('will-navigate', (e, to) => {
    if (to !== url) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadURL(url)
  return { ok: true }
}
