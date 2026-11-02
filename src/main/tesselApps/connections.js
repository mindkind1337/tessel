// tessel_apps: the services a person connected (Gmail, Outlook, GitHub...), and their tokens.
//
// Connecting happens on tesselcode.com and the service's own page, in the person's browser
// (tessel-server, src/connect.js), and comes back through Tessel's own link. The tokens then live
// in the main process: Tessel gives them to no agent and not to the window, and calls go from this
// computer straight to the service. A refresh token is kept sealed with the OS and an access token
// in memory only. (Sealing keeps them from other Windows users, not from a program running as you,
// which an agent with a shell is.) They only pass through tesselcode.com to be renewed, because
// that takes the client secret kept there, and only for the account that connected them.
// An account is what the service calls it: an address, a login or a workspace.
import fs from 'fs'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { join } from 'path'
import { secureStorageAvailable } from '../credentialProtection'
import { seenLine } from './unseen'

const CONNECT_MS = 15 * 60 * 1000
const MAX_FILE = 1024 * 1024
// A token this close to its end is renewed first.
const EARLY_MS = 60 * 1000
const SERVICE_RE = /^[a-z][a-z0-9-]{0,30}$/
// Services that give an app no way to end its access: disconnecting deletes the tokens here, sends
// them nowhere, and tells the person where to end it (TesselConnections.vue says where).
const NO_REVOKE = new Set(['microsoft', 'atlassian', 'sentry', 'stripe'])

const base64url = (bytes) => Buffer.from(bytes).toString('base64url')
// An account's name can be someone else's words (who named that workspace?): on one line, and with
// nothing that hides or turns text around, wherever it is shown.
const cleanName = (value) => (typeof value === 'string' ? seenLine(value).slice(0, 320) : '')
const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' } }

export class ConnectionError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function createConnections({ dir, safeStorage, openExternal, signedRequest, publicRequest = signedRequest, ownerOf = () => null, accountUrl = 'https://tesselcode.com', scheme = 'tessel', now = () => Date.now(), onChange = () => {} }) {
  const file = join(dir, 'connections.json')
  let saved // undefined until read: { [service]: { [account]: { access_token, refresh_token, grant, expires_at, scope, connected_at, reconnect } } }
  let pending = null // the connection waiting for the browser
  let lastError = null
  let notEnded = [] // after disconnecting: [{ service, how: 'notTold' | 'byHand' }]
  const renewing = new Map()
  // A token with nothing to renew it that was just refused: said for now, and asked again next time.
  // One 401 is not worth losing a connection over, so this is never saved.
  const refusedNow = new Set()

  function read() {
    if (saved !== undefined) return saved
    saved = {}
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.size > MAX_FILE || !secureStorageAvailable(safeStorage)) return saved
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const record = JSON.parse(safeStorage.decryptString(Buffer.from(raw.ciphertext, 'base64')))
      if (record && typeof record === 'object' && !Array.isArray(record)) saved = record
    } catch {
      // Nothing saved, or unreadable: nothing connected.
    }
    return saved
  }

  const accountsOf = (service) => (Object.hasOwn(read(), service) ? read()[service] : null)

  // What is saved: with a refresh token, the access token stays in memory only.
  function forDisk() {
    const out = {}
    for (const [service, accounts] of Object.entries(saved)) {
      out[service] = {}
      for (const [account, r] of Object.entries(accounts)) {
        const { access_token, expires_at, ...rest } = r
        out[service][account] = r.refresh_token ? rest : { ...rest, access_token, expires_at }
      }
    }
    return out
  }

  function write() {
    if (!secureStorageAvailable(safeStorage)) throw new ConnectionError('no_secure_storage', 'This computer cannot keep the connection safely.')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temporary = join(dir, `connections-${randomUUID()}.tmp`)
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ciphertext: safeStorage.encryptString(JSON.stringify(forDisk())).toString('base64') }), { mode: 0o600 })
      fs.renameSync(temporary, file)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  // What the window and the agents may know: never a token.
  function list() {
    const out = []
    for (const [service, accounts] of Object.entries(read())) {
      for (const [account, r] of Object.entries(accounts)) out.push({ service, account, label: r.label || account, connectedAt: r.connected_at || null, reconnect: !!r.reconnect || refusedNow.has(`${service}\n${account}`) })
    }
    return out
  }
  const view = () => ({ connections: list(), connecting: pending ? pending.service : null, error: lastError, notEnded })
  // Which services can be connected now, as the server says: no account is needed to know that.
  // -> { services: [ids] }, or { services: null } when it cannot be asked.
  async function services() {
    const res = await publicRequest('/api/connect/services').catch(() => null)
    return { services: res?.ok && Array.isArray(res.body?.services) ? res.body.services.filter((s) => typeof s === 'string') : null }
  }
  // The service forgets a connection Tessel will not keep. -> whether it could be told.
  async function revoke(service, { refresh_token, access_token }) {
    const token = refresh_token || access_token
    if (!token || NO_REVOKE.has(service)) return true
    const res = await signedRequest('/api/connect/revoke', { ...JSON_POST, body: JSON.stringify({ service, token, kind: refresh_token ? 'refresh' : 'access' }) }).catch(() => null)
    return !!(res && res.ok)
  }

  function endPending(error = null) {
    if (pending) clearTimeout(pending.timer)
    pending = null
    lastError = error
    notEnded = []
    onChange()
  }

  // Starts a connection in the person's browser. -> view
  async function connect(service) {
    if (!SERVICE_RE.test(String(service))) return { ...view(), error: 'unknownService' }
    if (pending) clearTimeout(pending.timer)
    const attempt = { service, verifier: base64url(randomBytes(48)), state: base64url(randomBytes(24)) }
    pending = attempt
    lastError = null
    notEnded = []
    const challenge = base64url(createHash('sha256').update(attempt.verifier).digest())
    const res = await signedRequest('/api/connect/start', { ...JSON_POST, body: JSON.stringify({ service, challenge, state: attempt.state, app: scheme }) })
    if (pending !== attempt) return view()
    const failed = (code) => {
      endPending(code)
      return view()
    }
    if (res.error) return failed(res.error)
    if (res.status === 503) return failed('unavailable')
    const url = res.ok && typeof res.body?.url === 'string' ? res.body.url : ''
    // Only ever our own address: what opens in the browser is decided here, not by an answer.
    if (!url.startsWith(`${accountUrl}/connect/`)) return failed('failed')
    attempt.timer = setTimeout(() => {
      if (pending === attempt) endPending('timedOut')
    }, CONNECT_MS)
    attempt.timer.unref?.()
    try {
      await openExternal(url)
    } catch {
      return failed('noBrowser')
    }
    onChange()
    return view()
  }

  function cancel() {
    endPending(null)
    return view()
  }

  // Back from the web page: tessel://connect?state=&pickup= (or error=). Only for the
  // connection this Tessel started. -> true when the link was for this.
  async function handleLink(link) {
    let url
    try {
      url = new URL(link)
    } catch {
      return false
    }
    if (url.protocol !== `${scheme}:` || url.hostname !== 'connect') return false
    if (!pending || pending.picking || url.searchParams.get('state') !== pending.state) return true
    const pickup = url.searchParams.get('pickup')
    if (!pickup) {
      endPending(url.searchParams.get('error') === 'denied' ? 'denied' : 'failed')
      return true
    }
    const attempt = pending
    attempt.picking = true
    const res = await signedRequest('/api/connect/pickup', { ...JSON_POST, body: JSON.stringify({ pickup, verifier: attempt.verifier }) })
    if (pending !== attempt) return true
    if (res.error) {
      endPending(res.error)
      return true
    }
    const got = res.ok ? res.body : null
    let label = cleanName(got?.account)
    let account = label.toLowerCase()
    // (A name that cannot be a key here is refused, not lost: nothing else about it is special.)
    if (typeof got?.access_token !== 'string' || !got.access_token || !account || account === '__proto__') {
      if (typeof got?.access_token === 'string') revoke(attempt.service, got)
      endPending('failed')
      return true
    }
    if (!accountsOf(attempt.service)) read()[attempt.service] = {}
    const accounts = accountsOf(attempt.service)
    // Who the service says this is, which a name cannot tell: two accounts can have one address.
    const subject = typeof got.account_id === 'string' && got.account_id ? got.account_id : null
    // Another account with the same name: both stay, and the new one is told apart. (A name made to
    // look like one told apart is another account like any, so this goes on until the place is free.
    // An answer that does not say who it is cannot be taken for the one that is there.)
    const given = label.slice(0, 300)
    const seed = subject || randomUUID()
    for (let tries = 0; Object.hasOwn(accounts, account) && accounts[account].subject && accounts[account].subject !== subject; tries++) {
      label = cleanName(`${given} (${createHash('sha256').update(`${seed}\n${tries}`).digest('hex').slice(0, 8)})`)
      account = label.toLowerCase()
    }
    const before = Object.hasOwn(accounts, account) ? accounts[account] : null
    refusedNow.delete(`${attempt.service}\n${account}`)
    accounts[account] = {
      access_token: got.access_token,
      // Connected again without a new one: the one it had stays good.
      refresh_token: typeof got.refresh_token === 'string' && got.refresh_token ? got.refresh_token : before?.refresh_token || null,
      grant: typeof got.grant === 'string' && got.grant ? got.grant : before?.grant || null,
      expires_at: Number.isFinite(got.expires_in) ? now() + got.expires_in * 1000 : null,
      scope: typeof got.scope === 'string' ? got.scope : null,
      // As the service writes it, for the panel: "Acme Notes" rather than the name it is found by.
      label,
      subject: subject || before?.subject || null,
      // The Tessel account it was made for (signedInAs).
      owner: ownerOf() || before?.owner || null,
      connected_at: now()
    }
    try {
      write()
    } catch (err) {
      delete accounts[account]
      if (before) accounts[account] = before
      // Not kept here: not left alive at the service either.
      revoke(attempt.service, got)
      endPending(err.code === 'no_secure_storage' ? 'noSecureStorage' : 'failed')
      return true
    }
    endPending(null)
    return true
  }

  // The account to use: the one named, or the only one.
  function recordOf(service, account) {
    const accounts = accountsOf(service) || {}
    const names = Object.keys(accounts)
    if (!names.length) throw new ConnectionError('not_connected', 'not connected')
    if (account) {
      const name = String(account).trim().toLowerCase()
      if (!Object.hasOwn(accounts, name)) throw new ConnectionError('unknown_account', 'That account is not connected. Ask the user which one to use.')
      return { name, record: accounts[name] }
    }
    if (names.length > 1) throw new ConnectionError('which_account', 'Several accounts are connected: ask the user which one, then pass it as "account".')
    return { name: names[0], record: accounts[names[0]] }
  }

  // One renewal at a time for an account: a second one would race for the same token.
  function renew(service, name, record) {
    const key = `${service}\n${name}`
    if (renewing.has(key)) return renewing.get(key)
    const work = (async () => {
      // Nothing to renew it with (a token that was not meant to end): the panel says so for now.
      if (!record.refresh_token) {
        refusedNow.add(key)
        onChange()
        throw new ConnectionError('reconnect', 'reconnect')
      }
      const res = await signedRequest('/api/connect/refresh', { ...JSON_POST, body: JSON.stringify({ service, refresh_token: record.refresh_token, grant: record.grant }) })
      if (res.error === 'signedOut') throw new ConnectionError('signed_out', 'signed out')
      if (res.error) throw new ConnectionError('offline', 'offline')
      if (res.body?.error === 'reconnect') {
        record.reconnect = true
        write()
        onChange()
        throw new ConnectionError('reconnect', 'reconnect')
      }
      if (!res.ok || typeof res.body?.access_token !== 'string') throw new ConnectionError('failed', 'failed')
      record.access_token = res.body.access_token
      if (typeof res.body.refresh_token === 'string' && res.body.refresh_token) {
        record.refresh_token = res.body.refresh_token
        if (typeof res.body.grant === 'string') record.grant = res.body.grant
      }
      record.expires_at = Number.isFinite(res.body.expires_in) ? now() + res.body.expires_in * 1000 : null
      delete record.reconnect
      write()
      return record.access_token
    })()
    renewing.set(key, work)
    return work.finally(() => renewing.delete(key))
  }

  // A good token for this service. -> { token, account, refreshed(): Promise<token> }
  async function access(service, account) {
    const { name, record } = recordOf(service, account)
    if (record.reconnect) throw new ConnectionError('reconnect', 'reconnect')
    if (refusedNow.delete(`${service}\n${name}`)) onChange()
    const fresh = record.expires_at === null || record.expires_at === undefined || record.expires_at - now() > EARLY_MS
    const token = fresh && record.access_token ? record.access_token : await renew(service, name, record)
    // (Disconnected while it renewed: nothing is used.)
    if (!Object.hasOwn(accountsOf(service) || {}, name)) throw new ConnectionError('not_connected', 'not connected')
    return { token, account: name, refreshed: () => renew(service, name, record) }
  }

  // Forgotten here whatever happens, even if it cannot be saved (the file goes then), and at the
  // service as far as it can be told: if not, the person is told, with what to do.
  async function disconnect(service, account) {
    const accounts = accountsOf(service)
    const name = String(account || '').trim().toLowerCase()
    const record = accounts && Object.hasOwn(accounts, name) ? accounts[name] : null
    if (!record) return view()
    refusedNow.delete(`${service}\n${name}`)
    delete accounts[name]
    if (!Object.keys(accounts).length) delete saved[service]
    try {
      write()
    } catch {
      // Whatever happens to the file, the service is still told below.
      try {
        fs.rmSync(file, { force: true })
      } catch {
        // locked: the revoke below is what ends the access
      }
    }
    lastError = null
    notEnded = []
    onChange()
    const told = await revoke(service, record)
    if (!told || NO_REVOKE.has(service)) {
      if (!told) lastError = 'notRevoked'
      notEnded = [{ service, how: told ? 'byHand' : 'notTold' }]
      onChange()
    }
    return view()
  }
  // Before signing out of the Tessel account or deleting it, while the server still answers: the
  // connections were made for it, and must not pass to whoever signs in next.
  async function disconnectAll() {
    const left = []
    for (const c of list()) {
      await disconnect(c.service, c.account)
      left.push(...notEnded)
    }
    notEnded = left
    if (left.some((x) => x.how === 'notTold')) lastError = 'notRevoked'
    onChange()
    return view()
  }

  // Someone signed in to Tessel. What was connected for another Tessel account ends here: a session
  // can end without a sign-out (then nothing could ask for it), and connections never pass to whoever
  // signs in next. One from before Tessel kept whose it was cannot be told apart, so it ends too.
  async function signedInAs(owner) {
    if (!owner) return view()
    const left = []
    for (const c of list()) {
      if (accountsOf(c.service)?.[c.account]?.owner === owner) continue
      await disconnect(c.service, c.account)
      left.push(...notEnded)
    }
    notEnded = left
    if (left.some((x) => x.how === 'notTold')) lastError = 'notRevoked'
    onChange()
    return view()
  }

  return { list, view, services, connect, cancel, handleLink, access, disconnect, disconnectAll, signedInAs, close: () => pending && clearTimeout(pending.timer) }
}
