// Settings > Tessel account: the optional sign-in to tessel-server. Logging in happens
// on a web page in the person's own browser (Google, GitHub, or an address and a
// password), so no password ever passes through the app. The browser comes back to a
// listener on 127.0.0.1 (RFC 8252) and the code is swapped for a session here, with
// PKCE. The session token is sealed with the OS (safeStorage) and never leaves the
// main process: the window only gets who is signed in. Answers carry codes, which the
// page words in its language.
import fs from 'fs'
import http from 'http'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { join } from 'path'
import { secureStorageAvailable } from './credentialProtection'

export const API_URL = 'https://api.tesselcode.com'
// The web pages a person sees.
export const ACCOUNT_URL = 'https://account.tesselcode.com'
// Long enough to create an account on the page and confirm it from the mailbox.
const SIGN_IN_MS = 15 * 60 * 1000
const REQUEST_MS = 15 * 1000
const MAX_FILE = 64 * 1024

const base64url = (bytes) => Buffer.from(bytes).toString('base64url')
const cleanUser = (user) => ({
  email: String(user?.email || ''),
  name: user?.name ? String(user.name) : null,
  hasPassword: !!user?.has_password,
  hasGoogle: !!user?.has_google,
  hasGitHub: !!user?.has_github
})
// Words only: nothing from the request is echoed into this page.
const donePage = (title, text) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Tessel</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:12vh auto;max-width:480px;padding:0 16px}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`
const SIGNED_IN_PAGE = donePage('Tessel', 'You are signed in. You can close this page and go back to Tessel.<br>Vous êtes connecté. Vous pouvez fermer cette page et revenir à Tessel.')
const FAILED_PAGE = donePage('Tessel', 'The sign-in did not finish. Go back to Tessel to try again.<br>La connexion n’a pas abouti. Revenez à Tessel pour réessayer.')

export function createTesselAccount({ dir, safeStorage, openExternal, fetchFn = fetch, apiUrl = API_URL, accountUrl = ACCOUNT_URL, signInMs = SIGN_IN_MS, requestMs = REQUEST_MS } = {}) {
  const file = join(dir, 'session.json')
  let session // undefined until read; null when signed out
  let pending = null // the sign-in waiting for the browser
  let lastError = null
  let offline = false

  function readSession() {
    if (session !== undefined) return session
    session = null
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.size > MAX_FILE || !secureStorageAvailable(safeStorage)) return session
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const record = JSON.parse(safeStorage.decryptString(Buffer.from(raw.ciphertext, 'base64')))
      if (typeof record.token === 'string' && record.token && record.expires_at > Date.now()) session = record
    } catch {
      // Nothing saved, or unreadable: signed out.
    }
    return session
  }

  function writeSession(next) {
    if (!secureStorageAvailable(safeStorage)) throw new Error('noSecureStorage')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temporary = join(dir, `session-${randomUUID()}.tmp`)
    try {
      fs.writeFileSync(temporary, JSON.stringify({ v: 1, ciphertext: safeStorage.encryptString(JSON.stringify(next)).toString('base64') }), { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, file)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
    session = next
  }

  function forgetSession() {
    session = null
    offline = false
    fs.rmSync(file, { force: true })
  }

  const request = (path, options = {}) => fetchFn(`${apiUrl}${path}`, { ...options, signal: AbortSignal.timeout(requestMs) })
  const bearer = (token) => ({ authorization: `Bearer ${token}` })

  function view() {
    const current = readSession()
    return {
      signedIn: !!current,
      user: current ? cleanUser(current.user) : null,
      signingIn: !!pending,
      offline,
      error: lastError
    }
  }

  // Who is signed in. With check: asks the server too, so a session that ended
  // there shows as signed out; being offline changes nothing.
  async function status({ check = false } = {}) {
    const current = readSession()
    if (check && current) {
      try {
        const res = await request('/api/me', { headers: bearer(current.token) })
        if (res.status === 401) {
          forgetSession()
        } else if (res.ok) {
          offline = false
          const { user } = await res.json()
          if (user && JSON.stringify(cleanUser(user)) !== JSON.stringify(cleanUser(current.user))) {
            writeSession({ ...current, user })
          }
        } else {
          offline = true
        }
      } catch {
        offline = true
      }
    }
    return view()
  }

  function endPending(error = null) {
    if (!pending) return
    const { server, timer } = pending
    pending = null
    clearTimeout(timer)
    lastError = error
    server.close()
    server.closeAllConnections?.()
  }

  async function swap(code, verifier) {
    let res
    try {
      res = await request('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, verifier })
      })
    } catch {
      return 'offline'
    }
    if (!res.ok) return 'refused'
    const { token, expires_at: expiresAt, user } = (await res.json().catch(() => null)) || {}
    if (typeof token !== 'string' || !token) return 'refused'
    try {
      writeSession({ token, expires_at: expiresAt, user })
    } catch {
      return 'noSecureStorage'
    }
    offline = false
    return null
  }

  // Starts a sign-in and returns at once: the page follows it through status().
  // A second one replaces the first.
  async function signIn() {
    endPending()
    lastError = null
    if (!secureStorageAvailable(safeStorage)) {
      lastError = 'noSecureStorage'
      return view()
    }
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = base64url(randomBytes(18))
    let port = 0
    const server = http.createServer((req, res) => {
      let url
      try {
        url = new URL(req.url, 'http://127.0.0.1')
      } catch {
        res.writeHead(404).end()
        return
      }
      // Only the browser's way back. Anything else, from a page guessing the port
      // or a name pointed at this address, neither ends the sign-in nor learns of it.
      const ours = req.method === 'GET' && url.pathname === '/callback' && url.searchParams.get('state') === state && req.headers.host === `127.0.0.1:${port}`
      if (!ours || !pending || pending.server !== server) {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      const denied = !code
      const answer = (html) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html)
      if (denied) {
        answer(FAILED_PAGE)
        endPending({ access_denied: 'denied', account_exists: 'accountExists' }[url.searchParams.get('error')] || 'failed')
        return
      }
      swap(code, verifier).then((error) => {
        answer(error ? FAILED_PAGE : SIGNED_IN_PAGE)
        endPending(error)
      })
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    }).catch(() => {
      lastError = 'failed'
    })
    if (lastError) return view()
    port = server.address().port
    pending = { server, timer: setTimeout(() => endPending('expired'), signInMs) }
    if (pending.timer.unref) pending.timer.unref()
    server.unref?.()
    const params = new URLSearchParams({ challenge, state, port: String(port) })
    try {
      await openExternal(`${accountUrl}/login?${params}`)
    } catch {
      endPending('failed')
    }
    return view()
  }

  function cancelSignIn() {
    endPending()
    return view()
  }

  // Emails the account's own address a link to choose a password, on a web page. A
  // session the server no longer knows ends here too.
  async function passwordLink() {
    const current = readSession()
    lastError = null
    if (!current) {
      lastError = 'signedOut'
      return view()
    }
    let res
    try {
      res = await request('/api/password-link', { method: 'POST', headers: bearer(current.token) })
    } catch {
      lastError = 'offline'
      return view()
    }
    if (res.status === 401) {
      forgetSession()
      lastError = 'signedOut'
      return view()
    }
    if (!res.ok) {
      lastError = res.status === 429 ? 'rateLimited' : 'failed'
      return view()
    }
    return { ...view(), done: 'linkSent' }
  }

  // Signs out here whatever the server says: being offline must not keep anyone
  // signed in on this computer. The session then ends by itself on the server.
  async function signOut() {
    const current = readSession()
    forgetSession()
    lastError = null
    if (current) {
      try {
        await request('/auth/logout', { method: 'POST', headers: bearer(current.token) })
      } catch {
        // It expires by itself.
      }
    }
    return view()
  }

  // Deletes the account on the server, then here. Fails without changing anything
  // if the server cannot confirm it.
  async function deleteAccount() {
    const current = readSession()
    if (!current) return { ...view(), deleted: false }
    let res
    try {
      res = await request('/api/me', { method: 'DELETE', headers: bearer(current.token) })
    } catch {
      lastError = 'offline'
      return { ...view(), deleted: false }
    }
    // Refused because this session already ended: the account is still there.
    if (res.status === 401) {
      forgetSession()
      lastError = 'signedOut'
      return { ...view(), deleted: false }
    }
    if (!res.ok) {
      lastError = 'failed'
      return { ...view(), deleted: false }
    }
    forgetSession()
    lastError = null
    return { ...view(), deleted: true }
  }

  return { status, signIn, passwordLink, cancelSignIn, signOut, deleteAccount, close: () => endPending() }
}
