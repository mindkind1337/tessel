// A project's HTML opened as a real website in the editor's preview: a small
// static server on this computer's loopback (127.0.0.1, a port the system
// picks), so the page's own CSS, scripts, images, fonts and videos load by
// their paths as they do on a web server (what VS Code's Live Preview does).
//
//   http://<label>.localhost:<port>/<path of the file below the project>
//
// Who can ask it for what:
//  - each preview is its own origin: a random label of 128 bits before
//    .localhost (Chromium sends that name to the loopback). The label is the
//    secret: without it nothing is served, a Host that is not exactly
//    <label>.localhost:<port> is refused (a web page of the browser cannot
//    reach it by a name that points here), only GET and HEAD. Its storage and
//    cookies are its own, not another project's nor another program's on
//    127.0.0.1; a page's /css/site.css reaches the site's own root. The server
//    listens on 127.0.0.1 and ::1 (the same port), so no other program can sit
//    on the one it does not hold;
//  - the page's scripts run only when the person turned them on for the
//    folder (register's `scripts`): a page without them can show what it
//    loads (CSS, images, fonts) but cannot read other files; with them it can
//    read the served folder and use the internet, as a website does: that is
//    only for a project the person trusts;
//  - no file or folder whose name starts with "." is served (.git, .env,
//    .ssh, .npmrc), checked on the real names too for a local project (not
//    8.3 short names, not through a link); on an SSH host by the names asked;
//  - only files below the project folder: path segments are decoded and may
//    not be "." or ".." or hold a separator, NUL (or ":" on Windows); a local
//    path is resolved (symlinks too) and must stay inside the project's real
//    folder; a folder answers with its index.html, never a listing;
//  - a project on an SSH host is read there through its open Files session
//    (remoteFs.js, the same rights and size cap as the editor, 50 MB), never a
//    port forward;
//  - every answer carries a Content-Security-Policy: even with scripts on,
//    the page cannot reach other programs of this computer (connect-src is
//    itself and https/wss only), and its frames never load;
//  - limits: sessions (50, the least used leaves first), connections, remote
//    reads at the same time (4), a response's time, the size and number of
//    unsaved texts.
// The text of the file being edited (not yet saved) can replace its file for
// the preview.
import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { isRemotePath } from '../shared/remotePath'

const MAX_SESSIONS = 50
const MAX_OVERRIDE = 2 * 1024 * 1024 // bytes
const MAX_OVERRIDES = 20 // unsaved texts per site
const MAX_CONNECTIONS = 64
const MAX_REMOTE_READS = 4
const REQUEST_MS = 130000

const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  wasm: 'application/wasm',
  pdf: 'application/pdf'
}
const extOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

// The path segments of a request, or null when any is unsafe.
export function safeSegments(pathname, { windows = process.platform === 'win32' } = {}) {
  const raw = pathname.split('/').filter((s) => s !== '')
  const out = []
  for (const s of raw) {
    let d
    try {
      d = decodeURIComponent(s)
    } catch {
      return null
    }
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
    if (!d || d === '.' || d === '..' || /[\u0000-\u001f\\/]/.test(d) || (windows && d.includes(':'))) return null
    out.push(d)
  }
  return out
}
// A name that starts with "." is a hidden file or folder (.git, .env, .ssh):
// never served.
export const hasHidden = (segs) => segs.some((s) => s.startsWith('.'))

function inside(root, p) {
  const a = process.platform === 'win32' ? root.toLowerCase() : root
  const b = process.platform === 'win32' ? p.toLowerCase() : p
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep)
}

// remote: { previewRoot(file) -> { root, rel } | null, read(root, rel) ->
// { ok, buf } | { ok: false, tooLarge? } } (remoteFs.js), absent: SSH projects
// are refused.
export function createPreviewServer({ remote = null, log = null } = {}) {
  const sessions = new Map() // label -> { kind: 'local'|'remote', root, scripts, overrides: Map(rel -> Buffer) }
  const byRoot = new Map() // kind + scripts + root -> label
  const servers = [] // 127.0.0.1 and, when there is one, ::1 (the same port)
  let port = 0
  let starting = null
  let remoteReads = 0
  const remoteWaiting = []

  const note = (m) => log && log.warn && log.warn('preview', m)

  function makeServer() {
    const s = http.createServer((req, res) => {
      res.setTimeout(REQUEST_MS, () => res.destroy())
      handle(req, res).catch((err) => {
        note(`a request failed: ${err && err.message}`)
        if (!res.headersSent) send(res, 500, 'Error')
        else res.destroy()
      })
    })
    s.maxConnections = MAX_CONNECTIONS
    s.requestTimeout = REQUEST_MS
    return s
  }
  const listen = (s, host, p) =>
    new Promise((resolve, reject) => {
      s.once('error', reject)
      s.listen(p, host, () => {
        s.removeListener('error', reject)
        resolve(s.address().port)
      })
    })

  // The address is a name under .localhost, which the browser may send to
  // 127.0.0.1 or to ::1: both answer on the same port, so another program
  // cannot sit on the one this server does not hold. No ::1 on this computer:
  // 127.0.0.1 alone.
  async function startServer() {
    if (servers.length) return
    for (let attempt = 0; attempt < 5; attempt++) {
      const v4 = makeServer()
      const p = await listen(v4, '127.0.0.1', 0)
      const v6 = makeServer()
      try {
        await listen(v6, '::1', p)
        servers.push(v4, v6)
        port = p
        break
      } catch (err) {
        v6.close()
        if (err && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT' || err.code === 'EINVAL')) {
          servers.push(v4)
          port = p
          break
        }
        // The port is taken on ::1: another port.
        v4.close()
      }
    }
    if (!port) throw new Error('no port') // i18n-ignore internal: register() answers no-server
    for (const s of servers) s.unref()
  }
  const ensureServer = () => (starting ||= startServer().finally(() => (starting = null)))

  function base(res, status, headers = {}) {
    res.writeHead(status, {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...headers
    })
  }
  function send(res, status, text) {
    base(res, status, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(text)
  }
  // Without scripts: what the page loads (CSS, images, fonts, media) shows, and
  // nothing runs or connects. With them: a website's own rights, minus other
  // programs of this computer and minus frames of other sites (a page's
  // frames inside the preview's own are never followed). On every answer, not
  // only the HTML: an SVG or XML document opened by itself runs scripts too.
  const policy = (scripts) =>
    (scripts
      ? [
          "default-src 'self' https: data: blob:",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:",
          "style-src 'self' 'unsafe-inline' https:",
          "img-src 'self' data: blob: https:",
          "font-src 'self' data: https:",
          "media-src 'self' data: blob: https:",
          "connect-src 'self' https: wss:",
          "frame-src 'none'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'"
        ]
      : [
          "default-src 'none'",
          "script-src 'none'",
          "style-src 'self' 'unsafe-inline' https:",
          "img-src 'self' data: blob: https:",
          "font-src 'self' data: https:",
          "media-src 'self' data: blob: https:",
          "connect-src 'none'",
          "frame-src 'none'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'none'"
        ]
    ).join('; ')

  function headersFor(name, size, s) {
    const type = MIME[extOf(name)] || 'application/octet-stream'
    const h = { 'Content-Type': type, 'Content-Security-Policy': policy(!!(s && s.scripts)) }
    if (size !== undefined) h['Content-Length'] = String(size)
    return h
  }
  function sendBuffer(req, res, name, buf, s) {
    base(res, 200, headersFor(name, buf.length, s))
    res.end(req.method === 'HEAD' ? undefined : buf)
  }

  // A byte range of a local file (a video seeks), or the whole of it.
  function sendFile(req, res, name, file, size, s) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''))
    let start = 0
    let end = size - 1
    let status = 200
    const extra = { 'Accept-Ranges': 'bytes' }
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1])
        if (m[2]) end = Math.min(end, Number(m[2]))
      } else {
        start = Math.max(0, size - Number(m[2]))
      }
      if (start > end || start >= size) {
        base(res, 416, { 'Content-Range': `bytes */${size}` })
        return res.end()
      }
      status = 206
      extra['Content-Range'] = `bytes ${start}-${end}/${size}`
    }
    const length = size === 0 ? 0 : end - start + 1
    base(res, status, { ...headersFor(name, length, s), ...extra })
    if (req.method === 'HEAD' || length === 0) return res.end()
    const stream = fs.createReadStream(file, { start, end })
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  async function serveLocal(req, res, s, segs) {
    let target = path.join(s.root, ...segs)
    for (let attempt = 0; attempt < 2; attempt++) {
      let real
      try {
        real = await fs.promises.realpath(target)
      } catch {
        return send(res, 404, 'Not found')
      }
      if (!inside(s.root, real)) return send(res, 403, 'Outside the project')
      const st = await fs.promises.stat(real).catch(() => null)
      if (!st) return send(res, 404, 'Not found')
      if (st.isDirectory()) {
        if (attempt === 1) return send(res, 404, 'Not found')
        target = path.join(real, 'index.html')
        continue
      }
      if (!st.isFile()) return send(res, 404, 'Not found')
      const rel = path.relative(s.root, real).split(path.sep).join('/')
      // The real names: a short name ("GIT~1") or a link to a hidden folder
      // is as hidden as the name itself.
      if (hasHidden(rel.split('/'))) return send(res, 404, 'Not found')
      const over = s.overrides.get(rel)
      if (over) return sendBuffer(req, res, real, over, s)
      return sendFile(req, res, real, real, st.size, s)
    }
  }

  // A few reads of the host at a time: a page with many files does not open
  // as many remote commands at once.
  async function limitedRead(root, rel) {
    while (remoteReads >= MAX_REMOTE_READS) await new Promise((resolve) => remoteWaiting.push(resolve))
    remoteReads++
    try {
      return await remote.read(root, rel)
    } finally {
      remoteReads--
      const next = remoteWaiting.shift()
      if (next) next()
    }
  }

  // On an SSH host the names are checked as asked (the host's own check keeps
  // the read inside the project, not away from a link that points at a hidden
  // folder: scripts of a repository you trust only).
  async function serveRemote(req, res, s, segs) {
    if (!remote) return send(res, 404, 'Not found')
    let rel = segs.join('/')
    for (let attempt = 0; attempt < 2; attempt++) {
      const over = s.overrides.get(rel)
      if (over) return sendBuffer(req, res, rel, over, s)
      const r = await limitedRead(s.root, rel)
      if (r && r.ok && r.buf) return sendBuffer(req, res, rel, r.buf, s)
      // A folder (or a name that is not a file): its index.html, once.
      if (attempt === 0 && r && !r.tooLarge) {
        rel = rel ? `${rel}/index.html` : 'index.html'
        continue
      }
      if (r && r.tooLarge) return send(res, 413, 'Too large')
      return send(res, 404, 'Not found')
    }
  }

  async function handle(req, res) {
    const hm = new RegExp(`^([0-9a-f]{32})\\.localhost:${port}$`).exec(String(req.headers.host || ''))
    if (!hm) return send(res, 403, 'Forbidden')
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      base(res, 405, { Allow: 'GET, HEAD' })
      return res.end()
    }
    let url
    try {
      url = new URL(req.url, `http://${req.headers.host}`)
    } catch {
      return send(res, 400, 'Bad request')
    }
    // The label (128 bits, in the Host) is the secret: it is the preview's own
    // origin, so a page's /css/site.css reaches its site's root.
    const s = sessions.get(hm[1])
    if (!s) return send(res, 404, 'Not found')
    // The one in use stays: the least used leaves first.
    sessions.delete(hm[1])
    sessions.set(hm[1], s)
    const segs = safeSegments(url.pathname)
    if (!segs) return send(res, 400, 'Bad path')
    if (hasHidden(segs)) return send(res, 404, 'Not found')
    // The root of a site is its index.html.
    return s.kind === 'local' ? serveLocal(req, res, s, segs) : serveRemote(req, res, s, segs)
  }

  function session(kind, root, scripts) {
    const key = `${kind}\n${scripts ? 'js' : 'nojs'}\n${root}`
    let label = byRoot.get(key)
    if (label && sessions.has(label)) {
      const s = sessions.get(label)
      sessions.delete(label)
      sessions.set(label, s)
      return s
    }
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      const gone = sessions.get(oldest)
      sessions.delete(oldest)
      if (gone) byRoot.delete(`${gone.kind}\n${gone.scripts ? 'js' : 'nojs'}\n${gone.root}`)
    }
    label = crypto.randomBytes(16).toString('hex')
    const s = { kind, root, scripts: !!scripts, label, overrides: new Map() }
    sessions.set(label, s)
    byRoot.set(key, label)
    return s
  }

  const enc = (rel) => rel.split('/').map(encodeURIComponent).join('/')
  const addressOf = (s, rel) => `http://${s.label}.localhost:${port}/${enc(rel)}`
  // The unsaved text of a file for its preview (a few files per site).
  function setOverride(s, rel, over) {
    if (over) {
      s.overrides.delete(rel)
      s.overrides.set(rel, over)
      if (s.overrides.size > MAX_OVERRIDES) s.overrides.delete(s.overrides.keys().next().value)
    } else s.overrides.delete(rel)
  }

  // -> { ok, url } | { ok: false, code, error? }
  // file: the HTML file (a local path, or an ssh:// virtual one); root: the
  // project folder the renderer says it belongs to (a hint for a local file,
  // ignored for a remote one: the open project that holds it decides);
  // text: the file's text when it differs from the disk (unsaved edits);
  // scripts: the page's scripts may run (the person turned them on).
  async function register({ file, root = '', text = null, scripts = false } = {}) {
    if (typeof file !== 'string' || !file || !/\.html?$/i.test(file)) return { ok: false, code: 'bad-file' }
    // A network path (\\host\share) would be reached for the check alone.
    if (/^[\\/]{2}/.test(file) || (typeof root === 'string' && /^[\\/]{2}/.test(root))) return { ok: false, code: 'bad-file' }
    try {
      await ensureServer()
    } catch (err) {
      note(`the server did not start: ${err && err.message}`)
      return { ok: false, code: 'no-server' }
    }
    const over = typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= MAX_OVERRIDE ? Buffer.from(text, 'utf8') : null
    if (isRemotePath(file)) {
      const loc = remote ? remote.previewRoot(file) : null
      if (!loc) return { ok: false, code: 'not-in-project' }
      // A page inside a hidden folder (.next, .vitepress) is never served.
      if (hasHidden(loc.rel.split('/'))) return { ok: false, code: 'hidden' }
      const s = session('remote', loc.root, scripts)
      setOverride(s, loc.rel, over)
      return { ok: true, url: addressOf(s, loc.rel) }
    }
    if (!path.isAbsolute(file)) return { ok: false, code: 'bad-file' }
    let realFile
    try {
      realFile = await fs.promises.realpath(file)
    } catch {
      return { ok: false, code: 'missing' }
    }
    let realRoot = path.dirname(realFile)
    if (typeof root === 'string' && root && path.isAbsolute(root)) {
      const r = await fs.promises.realpath(root).catch(() => null)
      if (r && inside(r, realFile)) realRoot = r
    }
    const rel = path.relative(realRoot, realFile).split(path.sep).join('/')
    if (hasHidden(rel.split('/'))) return { ok: false, code: 'hidden' }
    const s = session('local', realRoot, scripts)
    setOverride(s, rel, over)
    return { ok: true, url: addressOf(s, rel) }
  }

  function close() {
    sessions.clear()
    byRoot.clear()
    for (const s of servers) s.close()
    servers.length = 0
    port = 0
  }

  // Is this address one of the previews (any label, this server's port)?
  function isPreviewUrl(u) {
    if (!port || typeof u !== 'string') return false
    try {
      const x = new URL(u)
      return x.protocol === 'http:' && /^[0-9a-f]{32}\.localhost$/.test(x.hostname) && Number(x.port) === port
    } catch {
      return false
    }
  }

  return { register, close, isPreviewUrl }
}
