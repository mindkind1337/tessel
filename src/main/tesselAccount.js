// Settings > Tessel account: the optional sign-in to tessel-server. Logging in happens
// on a web page in the person's own browser (Google, GitHub, or an address and a
// password), so no password ever passes through the app. The browser comes back through
// Tessel's own link (tessel://, RFC 8252) and the code is swapped for a session here, with
// PKCE, so another program catching the link of a sign-in Tessel started gets nothing. The session token is sealed with the OS (safeStorage) and never leaves the
// main process: the window only gets who is signed in. Answers carry codes, which the
// page words in its language.
import fs from 'fs'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { join } from 'path'
import { secureStorageAvailable } from './credentialProtection'

export const API_URL = 'https://api.tesselcode.com'
// The web pages a person sees.
export const ACCOUNT_URL = 'https://tesselcode.com'
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
// The way back from the web page in a command line (a second launch of Tessel), if any.
export const findAppLink = (argv, scheme) => (Array.isArray(argv) ? argv.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(`${scheme}://`)) : undefined)

export function createTesselAccount({ dir, safeStorage, openExternal, onSignedIn = () => {}, onSignedOut = () => {}, onDeleted = () => {}, scheme = 'tessel', fetchFn = fetch, apiUrl = API_URL, accountUrl = ACCOUNT_URL, signInMs = SIGN_IN_MS, requestMs = REQUEST_MS } = {}) {
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

  const request = (path, { timeoutMs = requestMs, ...options } = {}) => fetchFn(`${apiUrl}${path}`, { ...options, signal: AbortSignal.timeout(timeoutMs) })
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

  // For settingsSync.js, in this process only: the account's id, and a request with its session.
  // -> the answer, or null when signed out, here or by the server (the session is then
  // forgotten, as everywhere else). Throws when the server cannot be reached.
  const userId = () => {
    const id = readSession()?.user?.id
    return typeof id === 'string' && id ? id : null
  }
  async function authed(path, { headers = {}, ...options } = {}) {
    const current = readSession()
    if (!current) return null
    const res = await request(path, { ...options, headers: { ...headers, ...bearer(current.token) } })
    if (res.status === 401) {
      forgetSession()
      return null
    }
    return res
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
    clearTimeout(pending.timer)
    pending = null
    lastError = error
  }

  // -> { session } or { error }. Nothing is kept yet: the caller checks first that the
  // sign-in is still wanted.
  async function swap(code, verifier) {
    let res
    try {
      res = await request('/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, verifier })
      })
    } catch {
      return { error: 'offline' }
    }
    if (!res.ok) return { error: 'refused' }
    const { token, expires_at: expiresAt, user } = (await res.json().catch(() => null)) || {}
    if (typeof token !== 'string' || !token) return { error: 'refused' }
    return { session: { token, expires_at: expiresAt, user } }
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
    pending = { state, verifier, timer: setTimeout(() => endPending('expired'), signInMs) }
    if (pending.timer.unref) pending.timer.unref()
    const params = new URLSearchParams({ challenge, state, app: scheme })
    try {
      await openExternal(`${accountUrl}/login?${params}`)
    } catch {
      endPending('failed')
    }
    return view()
  }

  // The browser's way back: <scheme>://callback?code=&state= (or error=). Any page can try
  // such a link, so what does not carry this sign-in's state does nothing at all.
  async function handleLink(link) {
    let url
    try {
      url = new URL(link)
    } catch {
      return
    }
    if (url.protocol !== `${scheme}:` || url.hostname !== 'callback') return
    if (!pending || pending.swapping || url.searchParams.get('state') !== pending.state) return
    const code = url.searchParams.get('code')
    if (!code) {
      const reason = url.searchParams.get('error')
      endPending(reason === 'access_denied' ? 'denied' : reason === 'account_exists' ? 'accountExists' : 'failed')
      return
    }
    const attempt = pending
    attempt.swapping = true
    const { session: made, error } = await swap(code, attempt.verifier)
    // Cancelled, signed out or started over meanwhile: that wins. The session the server
    // just opened goes too.
    if (pending !== attempt) {
      if (made) request('/auth/logout', { method: 'POST', headers: bearer(made.token) }).catch(() => {})
      return
    }
    if (error) {
      endPending(error)
      return
    }
    try {
      writeSession(made)
    } catch {
      endPending('noSecureStorage')
      return
    }
    offline = false
    endPending(null)
    onSignedIn()
  }

  // Tessel's Google app, for this account. -> { clientId, clientSecret } or { error }
  // A signed-in request to the server (tesselApps/connections.js). -> { status, ok, body } or
  // { error: 'signedOut' | 'offline' }. Nothing of the session leaves this file.
  async function signedRequest(path, init = {}) {
    const current = readSession()
    if (!current) return { error: 'signedOut' }
    let res
    try {
      res = await request(path, { ...init, headers: { ...(init.headers || {}), ...bearer(current.token) } })
    } catch {
      return { error: 'offline' }
    }
    if (res.status === 401) {
      forgetSession()
      return { error: 'signedOut' }
    }
    return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) }
  }

  async function googleClient() {
    const current = readSession()
    if (!current) return { error: 'signedOut' }
    let res
    try {
      res = await request('/api/google-client', { headers: bearer(current.token) })
    } catch {
      return { error: 'offline' }
    }
    if (res.status === 401) {
      forgetSession()
      return { error: 'signedOut' }
    }
    const answer = res.ok ? await res.json().catch(() => null) : null
    if (typeof answer?.client_id !== 'string' || typeof answer?.client_secret !== 'string') return { error: 'failed' }
    return { clientId: answer.client_id, clientSecret: answer.client_secret }
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
    endPending()
    const current = readSession()
    forgetSession()
    lastError = null
    // The person signed out: nothing of a sync key stays. A session the server ended is not this.
    onSignedOut()
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
    onDeleted(current.user && current.user.id)
    return { ...view(), deleted: true }
  }

  return { status, signIn, handleLink, signedRequest, googleClient, passwordLink, cancelSignIn, signOut, deleteAccount, userId, authed, close: () => endPending() }
}
