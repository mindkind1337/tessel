// One link router: a file, a folder, an image, a PDF, a web page or a mail
// address clicked anywhere in Tessel (a terminal, a chat, a rendered Markdown
// file, Source Control, a dialog) does the same thing on every surface:
//   file   -> Tessel's editor, at its line and column;
//   dir    -> the Files tab of the side panel, unfolded at that folder (the
//             system's file manager for a local folder outside the project);
//   image  -> the image viewer (the lightbox); an editor tab when the
//             surface asks for one (opts.image === 'editor');
//   pdf    -> its own PDF window (Chromium's viewer);
//   url    -> Settings > Browser, "Open web links in": Tessel's built-in
//             browser (a new tab of the current project, the default) or the
//             system browser; Ctrl/Cmd+click opens it in the other one;
//   mailto -> the system's mail program.
//
// A target is a string (a URL, a mailto: address, a data:image URL, a file:
// URI, a path) or an object { kind?, path | file, url | href, src, line, col,
// remote, lshare }. classifyTarget() normalizes it:
//   { kind, path, url, src, line, col, remote, lshare }
//   remote: the SSH host id of an ssh://<host>/… path (src/shared/remotePath.js)
//   lshare: true for a Live Share host's lshare://… path
// and returns null for anything Tessel never opens (javascript:, an unknown
// scheme, an empty value).
//
// App.vue builds the router with createLinkRouter(deps) and registers it
// (setLinkRouter); every surface then calls openTarget(target, opts). With no
// router (a test, a window without App), a web page or a mail address still
// opens in the system browser and the rest reports false.
import { fileKind } from '../../../shared/fileKinds.js'
import { isLsharePath } from '../../../shared/liveSharePath.js'
import { isRemotePath, parseRemotePath } from '../../../shared/remotePath.js'
import { fileUriToFilesystemPath } from '../chat/orca/shared/file-uri-path.js'

export const TARGET_KINDS = Object.freeze(['file', 'dir', 'image', 'pdf', 'url', 'mailto'])
export const URL_MODES = Object.freeze(['builtin', 'system'])

const CONTROL = /[\u0000-\u001f\u007f]/
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,[a-z0-9+/=\s]+$/i
const MAX_TARGET = 8192

const posInt = (n) => (Number.isInteger(n) && n > 0 ? n : null)

function webTarget(text) {
  let u
  try {
    u = new URL(text)
  } catch {
    return null
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'url', url: u.href }
  if (u.protocol === 'mailto:') return { kind: 'mailto', url: text }
  return null
}

function pathTarget(path, { kind = null, line = null, col = null } = {}) {
  if (typeof path !== 'string' || !path || path.length > MAX_TARGET || CONTROL.test(path)) return null
  // A network share or a device path (\\server\share, \\?\, //server) never
  // opens from a link: reading it could hand your Windows sign-in to a server.
  // WSL's own share (\\wsl.localhost\<distro>\…, \\wsl$\…) is this PC's.
  if (/^[\\/]{2}/.test(path) && !/^[\\/]{2}wsl(?:\$|\.localhost)[\\/][\w.-]+(?:[\\/]|$)/i.test(path)) return null
  const remote = isRemotePath(path) ? (parseRemotePath(path) || {}).hostId || null : null
  // An ssh:// path that does not parse is never treated as a local one.
  if (isRemotePath(path) && !remote) return null
  const lshare = isLsharePath(path)
  let k = TARGET_KINDS.includes(kind) && kind !== 'url' && kind !== 'mailto' ? kind : null
  // A path written with a trailing separator names a folder.
  if (!k && /[\\/]$/.test(path) && path.replace(/[\\/]+$/, '')) k = 'dir'
  if (!k) {
    const fk = fileKind(path)
    k = fk === 'image' ? 'image' : fk === 'pdf' ? 'pdf' : 'file'
  }
  return { kind: k, path, url: null, src: null, line: posInt(line), col: posInt(col), remote, lshare }
}

// -> { kind, path, url, src, line, col, remote, lshare } | null
export function classifyTarget(input) {
  if (input == null) return null
  const obj = typeof input === 'object' ? input : null
  const text = obj ? null : String(input).trim()
  if (text !== null && (!text || text.length > MAX_TARGET)) return null
  const line = obj ? obj.line : null
  const col = obj ? obj.col ?? obj.column : null
  // An image given by its data (a chat's pasted image, a Markdown data: image).
  const src = obj ? obj.src : text && /^data:/i.test(text) ? text : null
  if (typeof src === 'string' && src) {
    if (!DATA_IMAGE.test(src)) return null
    return { kind: 'image', path: obj && typeof (obj.path || obj.file) === 'string' ? obj.path || obj.file : null, url: null, src, line: null, col: null, remote: null, lshare: false }
  }
  const url = obj ? obj.url || obj.href || null : null
  if (obj && obj.kind === 'url' && !url) return null
  if (url || (text !== null && /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text))) {
    const raw = String(url || text).trim()
    if (/^file:/i.test(raw)) {
      let u
      try {
        u = new URL(raw)
      } catch {
        return null
      }
      const p = fileUriToFilesystemPath(u)
      const hash = /^#?(?:L|line-?)(\d+)/i.exec(u.hash || '')
      return p ? pathTarget(p, { kind: obj && obj.kind, line: line ?? (hash ? Number(hash[1]) : null), col }) : null
    }
    // A virtual path (ssh://, lshare://) is a path, not a web address.
    if (isRemotePath(raw) || isLsharePath(raw)) return pathTarget(raw, { kind: obj && obj.kind, line, col })
    const web = webTarget(raw)
    if (!web) return null
    return { ...web, path: null, src: null, line: null, col: null, remote: null, lshare: false }
  }
  const path = obj ? obj.path || obj.file : text
  return pathTarget(path, { kind: obj && obj.kind, line, col })
}

const fileName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '')

// deps (all optional; a missing one makes its kind report false):
//   openInEditor({ file, line, col, preview }) -> truthy when opened
//   viewFile({ file, label, line }) -> the modal viewer, the fallback for a file
//   openPdf({ file, label }) -> its PDF window (App's viewFile reports errors)
//   readImage(path) -> { ok, dataUrl } (files:viewImage: local, SSH or Live Share)
//   showImage({ src, title, file }) -> the lightbox
//   revealInFiles(path) -> true when the Files tab shows it (false: not in
//     the project shown there)
//   openFolder(path) -> the system's file manager (a local folder only)
//   urlMode() -> 'builtin' | 'system'
//   openUrlBuiltin(url) / openUrlSystem(url) / openMail(url)
//   notOpened({ target, reason }) -> tells the user (a toast)
export function createLinkRouter(deps = {}) {
  const call = async (name, ...args) => (typeof deps[name] === 'function' ? deps[name](...args) : undefined)
  const has = (name) => typeof deps[name] === 'function'
  const fail = (target, reason) => {
    if (has('notOpened')) deps.notOpened({ target, reason })
    return false
  }

  async function openFile(t, opts) {
    if (has('openInEditor') && (await call('openInEditor', { file: t.path, line: t.line, col: t.col, preview: opts.preview !== false }))) return true
    if (has('viewFile')) {
      await call('viewFile', { file: t.path, label: opts.label || '', line: t.line })
      return true
    }
    return fail(t, 'unsupported')
  }

  async function openImage(t, opts) {
    if (t.src) {
      if (!has('showImage')) return fail(t, 'unsupported')
      await call('showImage', { src: t.src, title: opts.label || (t.path ? fileName(t.path) : ''), file: null })
      return true
    }
    if (opts.image !== 'editor' && has('readImage') && has('showImage')) {
      const res = await Promise.resolve()
        .then(() => deps.readImage(t.path))
        .catch(() => null)
      if (res && res.ok && typeof res.dataUrl === 'string' && res.dataUrl.startsWith('data:image/')) {
        await call('showImage', { src: res.dataUrl, title: opts.label || fileName(t.path), file: null })
        return true
      }
    }
    // No lightbox (or it could not read it): the editor's image tab.
    return openFile(t, opts)
  }

  async function openDir(t) {
    if (has('revealInFiles') && (await call('revealInFiles', t.path))) return true
    // Outside the project in Files: a folder of this computer opens in the
    // system's file manager; a host's (SSH, Live Share) never does.
    if (!t.remote && !t.lshare && has('openFolder')) {
      const res = await call('openFolder', t.path)
      if (res === false || (res && res.ok === false)) return fail(t, (res && res.reason) || 'failed')
      return true
    }
    return fail(t, 'outside')
  }

  async function openUrl(t, opts) {
    const asked = has('urlMode') ? deps.urlMode() : null
    const mode = URL_MODES.includes(asked) ? asked : 'builtin'
    const e = opts.event
    const other = !!(e && (e.ctrlKey || e.metaKey))
    const where = opts.external === true ? 'system' : (mode === 'builtin') !== other ? 'builtin' : 'system'
    if (where === 'builtin' && has('openUrlBuiltin')) {
      const leaf = await call('openUrlBuiltin', t.url)
      if (leaf !== false && leaf !== null) return true
    }
    if (!has('openUrlSystem')) return fail(t, 'unsupported')
    const res = await call('openUrlSystem', t.url)
    if (res === false || (res && res.ok === false)) return fail(t, 'failed')
    return true
  }

  // -> Promise<boolean>: opened (or handed to the program that opens it).
  // opts: { event (Ctrl/Cmd: the other browser), image: 'lightbox' | 'editor',
  //         label (a title for the viewer), preview (an editor preview tab),
  //         external (a web page in the system browser whatever the setting) }
  async function open(input, opts = {}) {
    const t = classifyTarget(input)
    if (!t) return false
    try {
      if (t.kind === 'file') return await openFile(t, opts)
      if (t.kind === 'image') return await openImage(t, opts)
      if (t.kind === 'pdf') {
        if (!has('openPdf')) return fail(t, 'unsupported')
        await call('openPdf', { file: t.path, label: opts.label || fileName(t.path) })
        return true
      }
      if (t.kind === 'dir') return await openDir(t)
      if (t.kind === 'url') return await openUrl(t, opts)
      if (t.kind === 'mailto') {
        const res = await call(has('openMail') ? 'openMail' : 'openUrlSystem', t.url)
        if (res === false || res === undefined || (res && res.ok === false)) return fail(t, 'failed')
        return true
      }
    } catch {
      return fail(t, 'failed')
    }
    return false
  }

  return { open, classify: classifyTarget }
}

// --- The window's router ----------------------------------------------------------
let current = null
export function setLinkRouter(router) {
  current = router && typeof router.open === 'function' ? router : null
}
export function getLinkRouter() {
  return current
}

// Opens a target through the window's router; without one, a web page or a
// mail address in the system browser.
export async function openTarget(input, opts = {}) {
  if (current) return current.open(input, opts)
  const t = classifyTarget(input)
  const api = globalThis.window?.shellApi
  if (!t || (t.kind !== 'url' && t.kind !== 'mailto') || !api || typeof api.openExternal !== 'function') return false
  try {
    return (await api.openExternal(t.url)) !== false
  } catch {
    return false
  }
}
