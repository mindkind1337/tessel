// A file dragged from the file explorer out to Windows (the desktop, a folder
// window): the row's drag carries Chromium's DownloadURL, and on the drop
// Windows asks Chromium for the file, which downloads it from this server.
// The in-window drag stays as it is (onto a folder of the tree, onto a
// terminal).
//
// Who can ask it for what:
//  - one token per file about to be dragged (32 random bytes), made by main
//    for one file of an open project (its project, path and, for a Live
//    Share host, the session are kept here; the address carries none of
//    them), good for 2 minutes, gone after the first complete answer;
//  - given up by the window when the drag ends without a drop, when the row
//    is only clicked, or when the drop lands inside Tessel: a short grace
//    (GRACE_MS) first, because Windows asks for the file only once the drag
//    is over, and a token already being read is kept;
//  - one answer at a time per token (another is refused while it runs);
//  - listens on 127.0.0.1 only, a port the system picks, started when the
//    first token is made and closed a little after the last one is gone;
//    short header and request timeouts, a bounded number of connections;
//  - GET only; the Host header must be exactly 127.0.0.1:<port> (no DNS
//    rebinding); no CORS header (a web page cannot read an answer);
//    Content-Disposition attachment with a clean name, nosniff;
//  - a local file must really be inside its project (no link or junction
//    leading out), checked when the token is made and again on the opened
//    file itself when it is read; a remote one is read through the open
//    Files session (remoteFs.js, the editor's 50 MB cap), a Live Share
//    host's through that same session's download (the host's access rules
//    and cap): over the cap, a clean 413, no partial file;
//  - tokens never reach the log.
import http from 'http'
import fs from 'fs'
import crypto from 'crypto'
import { pipeline } from 'stream'
import { isRemotePath } from '../shared/remotePath'
import { isLsharePath } from '../shared/liveSharePath'
import { inside, reallyInside, realPath } from './explorer'

export const TOKEN_MS = 2 * 60 * 1000
export const GRACE_MS = 10000
export const MAX_TOKENS = 64
const MAX_READS = 4
const REQUEST_MS = 130000
const TOKEN_RE = /^\/dl\/([0-9a-f]{64})$/
// Device names Windows opens instead of a file (liveSharePath.js's rule).
const RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$|clock\$)\s*(\..*)?$/i

// The name Windows gives the file (also the DownloadURL's name: no colon),
// whole characters only, its extension kept when it is shortened.
export function dragName(file) {
  let name = String(file).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '') // eslint-disable-line no-control-regex
  name = typeof name.toWellFormed === 'function' ? name.toWellFormed() : name.replace(/[\ud800-\udfff]/g, '_')
  if (!name || RESERVED.test(name)) name = `file-${name || 'download'}`
  const chars = Array.from(name)
  if (chars.length > 200) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot <= 10 ? Array.from(name.slice(dot)) : []
    name = chars.slice(0, 200 - ext.length).join('').replace(/[. ]+$/, '') + ext.join('')
  }
  return name
}

// RFC 5987: what encodeURIComponent leaves that the header does not allow.
const extValue = (s) => encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

// idleMs: the server closes this long after its last address is gone (never
// at once: the answer just sent may still be on its way to the drop).
// session(): the Live Share session joined now (a key, 0 for none).
export function createDragOut({ remote, guest, session = () => 0, now = () => Date.now(), timers = { setTimeout, clearTimeout }, httpLib = http, idleMs = 10000, graceMs = GRACE_MS }) {
  const tokens = new Map() // token -> { root, file, kind, session, until, busy, claimed }
  let server = null
  let port = 0
  let starting = null
  let reads = 0
  let sweepTimer = null
  let idleTimer = null

  function sweep() {
    const t = now()
    for (const [k, v] of tokens) if (v.until <= t && !v.busy) tokens.delete(k)
    if (sweepTimer) timers.clearTimeout(sweepTimer)
    sweepTimer = null
    if (!tokens.size) {
      if (server && !idleTimer)
        idleTimer = timers.setTimeout(() => {
          idleTimer = null
          if (!tokens.size) stop()
        }, idleMs)
    } else sweepTimer = timers.setTimeout(sweep, Math.max(1000, Math.min(...[...tokens.values()].map((v) => v.until)) - t + 50))
  }

  function stop() {
    if (sweepTimer) timers.clearTimeout(sweepTimer)
    sweepTimer = null
    if (idleTimer) timers.clearTimeout(idleTimer)
    idleTimer = null
    if (server) {
      try {
        server.close()
      } catch {
        /* already closed */
      }
    }
    server = null
    port = 0
    starting = null
  }

  function start() {
    if (server && port) return Promise.resolve(port)
    if (starting) return starting
    // Header timeouts are checked every connectionsCheckingInterval.
    const s = httpLib.createServer({ connectionsCheckingInterval: 5000 }, (req, res) => {
      res.setTimeout(REQUEST_MS, () => res.destroy())
      serve(req, res).catch(() => (res.headersSent ? res.destroy() : refuse(res, 500)))
    })
    s.maxConnections = 16
    s.headersTimeout = 10000
    s.requestTimeout = REQUEST_MS
    s.keepAliveTimeout = 2000
    s.on('error', () => {})
    starting = new Promise((resolveStart) => {
      s.listen(0, '127.0.0.1', () => {
        server = s
        port = s.address().port
        // Never what keeps Tessel from quitting.
        s.unref()
        resolveStart(port)
      })
      s.once('error', () => {
        starting = null
        resolveStart(0)
      })
    })
    return starting
  }

  function refuse(res, code) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
    res.end()
  }

  function headers(name, length) {
    return {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${extValue(name)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Length': String(length)
    }
  }

  // The local file, opened, and the same file as the real path inside the
  // project (a junction swapped in between is refused). -> { fh, size } | null
  async function openLocal(entry) {
    const real = realPath(entry.file)
    const realRoot = realPath(entry.root)
    if (!real || !realRoot || !inside(realRoot, real) || !reallyInside(entry.root, entry.file)) return null
    let fh = null
    try {
      fh = await fs.promises.open(real, 'r')
      const after = realPath(real)
      if (after !== real || !inside(realRoot, after)) throw new Error('changed')
      const st = await fh.stat({ bigint: true })
      const again = fs.statSync(real, { bigint: true })
      if (!st.isFile() || st.ino !== again.ino || st.dev !== again.dev) throw new Error('changed')
      return { fh, size: Number(st.size) }
    } catch {
      if (fh) await fh.close().catch(() => {})
      return null
    }
  }

  async function serve(req, res) {
    if (req.method !== 'GET') return refuse(res, 405)
    if (!port || req.headers.host !== `127.0.0.1:${port}`) return refuse(res, 421)
    const m = TOKEN_RE.exec(String(req.url || ''))
    const token = m ? m[1] : null
    const entry = token ? tokens.get(token) : null
    if (!entry || entry.until <= now()) return refuse(res, 404)
    if (entry.busy) return refuse(res, 409)
    // Remote reads at the same time: a few (the token stays for a retry).
    if (entry.kind !== 'local' && reads >= MAX_READS) return refuse(res, 503)
    entry.busy = true
    entry.claimed = true
    let finished = false
    // A complete answer uses the token up; a cut one gives it back.
    const settle = (complete) => {
      if (finished) return
      finished = true
      entry.busy = false
      if (complete) tokens.delete(token)
      sweep()
    }
    res.once('finish', () => settle(true))
    res.once('close', () => settle(false))
    if (entry.kind === 'local') {
      const got = await openLocal(entry)
      if (!got) {
        tokens.delete(token)
        return refuse(res, 404)
      }
      res.writeHead(200, headers(dragName(entry.file), got.size))
      if (!got.size) {
        await got.fh.close().catch(() => {})
        return res.end()
      }
      pipeline(got.fh.createReadStream({ start: 0, end: got.size - 1 }), res, () => {})
      return
    }
    reads++
    let got
    try {
      const fsOf = entry.kind === 'shared' ? guest() : remote
      // A Live Share host's file: only in the session it was made in.
      got = entry.kind === 'shared' && session() !== entry.session ? null : await fsOf.readDownload(entry.file)
    } catch {
      got = null
    } finally {
      reads--
    }
    if (!got || !got.ok || !Buffer.isBuffer(got.buf)) {
      // A final answer: the token is used up (no second 50 MB read).
      tokens.delete(token)
      return refuse(res, got && got.code === 'too-large' ? 413 : 404)
    }
    res.writeHead(200, headers(dragName(entry.file), got.buf.length))
    res.end(got.buf)
  }

  // A token for one file of an open project. -> { ok, url, name } | { ok: false }
  async function prepare({ root, file } = {}) {
    if (typeof root !== 'string' || typeof file !== 'string' || !root || !file) return { ok: false }
    let kind
    if (isLsharePath(root)) kind = isLsharePath(file) ? 'shared' : null
    else if (isRemotePath(root)) kind = isRemotePath(file) ? 'remote' : null
    else kind = !isRemotePath(file) && !isLsharePath(file) ? 'local' : null
    if (!kind) return { ok: false }
    if (kind === 'shared' && !session()) return { ok: false }
    let path = file
    if (kind === 'local') {
      path = inside(root, file)
      try {
        if (!path || !reallyInside(root, path) || !fs.statSync(path).isFile()) return { ok: false }
      } catch {
        return { ok: false }
      }
    } else {
      // Below the project shown (the host's own checks come when it is read).
      const r = root.replace(/[\\/]+$/, '')
      if (!(file.startsWith(r + '\\') || file.startsWith(r + '/'))) return { ok: false }
    }
    // The oldest goes when there are too many (never one being read).
    for (const [k, v] of tokens) {
      if (tokens.size < MAX_TOKENS) break
      if (!v.busy) tokens.delete(k)
    }
    if (tokens.size >= MAX_TOKENS) return { ok: false }
    const p = await start()
    if (!p) return { ok: false }
    const token = crypto.randomBytes(32).toString('hex')
    tokens.set(token, { root, file: path, kind, session: kind === 'shared' ? session() : null, until: now() + TOKEN_MS, busy: false, claimed: false })
    sweep()
    return { ok: true, url: `http://127.0.0.1:${p}/dl/${token}`, name: dragName(path) }
  }

  // Given up by the window. Windows asks for a dropped file only once the
  // drag is over, so a token goes after a short grace, unless that request
  // came (claimed): then the 2 minutes or its complete answer end it.
  function revoke(url) {
    const m = /\/dl\/([0-9a-f]{64})$/.exec(String(url || ''))
    const token = m ? m[1] : null
    const entry = token ? tokens.get(token) : null
    if (!entry || entry.claimed) return
    entry.until = Math.min(entry.until, now() + graceMs)
    sweep()
  }

  return { prepare, revoke, close: stop, _tokens: tokens, _port: () => port }
}
