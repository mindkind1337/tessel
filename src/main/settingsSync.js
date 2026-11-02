// Settings > Tessel account > Your settings everywhere: a person's settings, projects, SSH hosts
// and task board on every computer they sign in on, encrypted before they leave this one. The
// server keeps one blob it cannot read.
//
// The key comes from a sync phrase the person chooses (accounts made with Google or GitHub have no
// password), with scrypt and a random salt kept beside the blob. The phrase is used here once and
// forgotten; the key stays here, sealed with the OS, so the phrase is asked once per computer.
// Neither ever goes to the server or to the window. A lost phrase cannot be recovered: starting
// over erases the server's copy.
//
// The packing is settingsBackup.js's: no sign-in, no secret, nothing that decides what agents may
// do. A copy from another computer is never put in place silently, because that replaces the
// layout and needs a restart: the person is asked, and it is staged for the next start.
//
// Being offline or signed out changes nothing here: it tries again later, without a word.
import fs from 'fs'
import { join } from 'path'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'crypto'
import { gzip, gunzip } from 'zlib'
import { secureStorageAvailable } from './credentialProtection'
import { MAX_TOTAL_BYTES, SYNC_CATEGORIES, buildSyncBundle, dropPendingImport, hasPendingImport, inspectBackup, localizeLayout, stageImport } from './settingsBackup'

export const SYNC_FORMAT = 1
export const MIN_PHRASE = 12
// The server's limit (its src/sync.js), which fits a row of its database.
export const MAX_BLOB = 1_900_000
// Far beyond any setup that fits once compressed: such files are not even read.
const MAX_PLAIN_BYTES = 64 * 1024 * 1024
const SYNCED_FILES = ['workspace-layout.json', 'remote-hosts.json', 'task-board.json']
const MAX_STATE = 64 * 1024
const MAX_DEVICE = 80
const KEY_BYTES = 32
const SALT_BYTES = 16
const NONCE_BYTES = 12
const TAG_BYTES = 16
// OWASP's scrypt setting: 128 MiB. The server holds the salt and the blob, so this is what stands
// between it and guessing the phrase. Fixed by the format, never read from the server.
const SCRYPT_COST = 2 ** 17
const SCRYPT_R = 8
const SCRYPT_P = 1

const TICK_MS = 60 * 1000
const DEBOUNCE_MS = 60 * 1000
const MIN_INTERVAL_MS = 5 * 60 * 1000
const MAX_WAIT_MS = 15 * 60 * 1000
const FIRST_LOOK_MS = 15 * 1000
// After a copy was put in place, the window needs a moment to load it and write it back its own
// way: that is not a change of the person's.
const SETTLE_MS = 3 * 60 * 1000
const RATE_LIMITED_MS = 60 * 60 * 1000
const REQUEST_MS = 60 * 1000
const QUIT_MS = 2500

const fail = (code) => Object.assign(new Error(code), { code })
const NO_LOG = { info() {}, warn() {} }

// The same phrase gives the same key on every computer, however its accents were typed.
export function cleanPhrase(phrase) {
  if (typeof phrase !== 'string') return null
  const clean = phrase.normalize('NFKC').trim()
  return [...clean].length >= MIN_PHRASE ? clean : null
}

export const deviceLabel = (name) => {
  // eslint-disable-next-line no-control-regex -- control characters are what is dropped
  const clean = String(name || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, MAX_DEVICE)
  return clean || 'Computer'
}

export function deriveKey(phrase, salt, cost = SCRYPT_COST) {
  return new Promise((resolve, reject) => {
    scrypt(phrase, Buffer.from(salt, 'base64url'), KEY_BYTES, { N: cost, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * cost * SCRYPT_R }, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

// What the encryption is bound to: this format, this account, and the version it is written as,
// so the server cannot hand back an older copy under a newer number.
const boundTo = (userId, version) => Buffer.from(`tessel-sync\n${SYNC_FORMAT}\n${userId}\n${version}`)

// bundle -> compressed, then AES-256-GCM with a fresh nonce: format, nonce, tag, ciphertext.
export async function sealCopy({ bundle, key, userId, version }) {
  const plain = await new Promise((resolve, reject) => gzip(Buffer.from(JSON.stringify(bundle)), { level: 9 }, (err, out) => (err ? reject(err) : resolve(out))))
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(boundTo(userId, version))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([Buffer.from([SYNC_FORMAT]), nonce, cipher.getAuthTag(), body]).toString('base64url')
}

// -> the bundle's text. Throws { code: 'unreadable' } for a wrong key or a change of any kind,
// { code: 'newer' } for a format this version does not know.
export async function openCopy({ blob, key, userId, version }) {
  const bytes = Buffer.from(String(blob), 'base64url')
  if (bytes.length < 1 + NONCE_BYTES + TAG_BYTES) throw fail('unreadable')
  if (bytes[0] > SYNC_FORMAT) throw fail('newer')
  if (bytes[0] !== SYNC_FORMAT) throw fail('unreadable')
  let plain
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 1 + NONCE_BYTES))
    decipher.setAAD(boundTo(userId, version))
    decipher.setAuthTag(bytes.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES))
    plain = Buffer.concat([decipher.update(bytes.subarray(1 + NONCE_BYTES + TAG_BYTES)), decipher.final()])
  } catch {
    throw fail('unreadable')
  }
  return new Promise((resolve, reject) =>
    gunzip(plain, { maxOutputLength: MAX_TOTAL_BYTES * 2 }, (err, out) => (err ? reject(fail('unreadable')) : resolve(out.toString('utf8'))))
  )
}

// Whether two setups are the same, whatever else is in their bundles.
function hashOf(files) {
  const hash = createHash('sha256')
  for (const name of Object.keys(files).sort()) hash.update(`${name}\n${files[name].length}\n${files[name]}\n`)
  return hash.digest('base64url')
}

const validMeta = (body) => !!body && Number.isSafeInteger(body.version) && body.version >= 1 && typeof body.salt === 'string' && body.salt.length > 0
const metaOf = (body) => ({
  version: body.version,
  salt: body.salt,
  device: deviceLabel(body.device),
  at: Number.isFinite(body.updated_at) ? body.updated_at : null
})

export function createSettingsSync({
  dir,
  dataDir,
  safeStorage,
  account,
  deviceName = '',
  appVersion = '',
  getBuild = async () => '',
  // The panes whose terminal still runs here, and the agent commands this computer has itself.
  runningPanes = async () => [],
  knownCommands = async () => [],
  onChanged = () => {},
  onNewer = () => {},
  log = NO_LOG,
  now = Date.now,
  scryptCost = SCRYPT_COST,
  maxBlob = MAX_BLOB,
  tickMs = TICK_MS,
  debounceMs = DEBOUNCE_MS,
  minIntervalMs = MIN_INTERVAL_MS,
  maxWaitMs = MAX_WAIT_MS,
  firstLookMs = FIRST_LOOK_MS,
  settleMs = SETTLE_MS,
  requestMs = REQUEST_MS,
  quitMs = QUIT_MS
} = {}) {
  const file = join(dir, 'sync.json')
  const device = deviceLabel(deviceName)
  let saved = readSaved() // { userId, on, salt, sealedKey, base, hash, at, staged, asked }, or null. Never the key in clear.
  let key = null // the key in use, read once
  let remote = null // a copy on the server this computer does not have: { version, salt, device, at, older, unreadable }
  let problem = null // why the last automatic step did not work, for the page
  let notice = null
  let busy = false
  let checkedAt = null
  let queue = Promise.resolve()
  let ticker = null
  let firstLook = null
  let started = false
  // Change detection, in memory: what the files looked like, and since when they changed.
  let lastSignature = null
  let changedAt = null
  let firstChangeAt = null
  let lastPushAt = 0
  let backoffUntil = 0
  let settleUntil = 0
  let tooBigHash = null

  function readSaved() {
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.size > MAX_STATE) return null
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return data && data.v === 1 && typeof data.userId === 'string' && typeof data.salt === 'string' ? data : null
    } catch {
      return null
    }
  }

  function persist() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temporary = join(dir, `sync-${randomUUID()}.tmp`)
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...saved, v: 1 }), { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, file)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  // This account's state: another account's is never used, nor its key.
  function mine() {
    const userId = account.userId()
    return saved && userId && saved.userId === userId ? saved : null
  }

  function theKey() {
    const state = mine()
    if (!state || !state.sealedKey) return null
    if (key) return key
    try {
      if (!secureStorageAvailable(safeStorage)) return null
      const raw = Buffer.from(safeStorage.decryptString(Buffer.from(state.sealedKey, 'base64')), 'base64')
      key = raw.length === KEY_BYTES ? raw : null
    } catch {
      // Sealed by another Windows account or computer: the phrase is asked again.
      key = null
    }
    return key
  }

  const sealKey = (raw) => safeStorage.encryptString(raw.toString('base64')).toString('base64')

  function forget() {
    saved = null
    key = null
    remote = null
    problem = null
    stopTimers()
    try {
      fs.rmSync(file, { force: true })
    } catch (err) {
      log.warn('sync', `could not remove its state: ${(err && err.code) || 'error'}`) // i18n-ignore
    }
  }

  function view() {
    const userId = account.userId()
    const state = mine()
    const on = !!(state && state.on)
    const hasKey = on && !!theKey()
    return {
      signedIn: !!userId,
      canSeal: secureStorageAvailable(safeStorage),
      on,
      state: !on ? 'off' : state.staged ? 'staged' : !hasKey ? 'needsPhrase' : remote ? 'newer' : 'on',
      busy,
      device,
      lastSyncAt: on ? Math.max(state.at || 0, checkedAt || 0) || null : null,
      remote: on && remote ? { device: remote.device, at: remote.at, older: !!remote.older, unreadable: !!remote.unreadable, first: !state.base } : null,
      staged: on && state.staged ? { device: state.staged.device, at: state.staged.at, missing: state.staged.missing || [] } : null,
      problem,
      notice
    }
  }
  const told = () => onChanged(view())
  const refusal = (error) => ({ ...view(), error })

  // One at a time: a click and the timer never write over each other.
  function exclusive(work) {
    const run = queue.then(async () => {
      busy = true
      try {
        return await work()
      } finally {
        busy = false
        told()
      }
    })
    queue = run.catch(() => {})
    return run
  }

  // -> { res }, or { failed: 'offline' | 'signedOut' }. A session the server ended is
  // forgotten by account.authed; nothing of this feature is.
  async function call(path, options = {}) {
    try {
      const res = await account.authed(path, { timeoutMs: requestMs, ...options })
      return res ? { res } : { failed: 'signedOut' }
    } catch {
      return { failed: 'offline' }
    }
  }

  // -> { copy } with its blob when asked for, { none: true }, or { failed }
  async function readCopy({ meta = false } = {}) {
    const { res, failed } = await call(`/api/sync${meta ? '?meta=1' : ''}`)
    if (failed) return { failed }
    if (res.status === 404) return { none: true }
    if (!res.ok) return { failed: 'failed' }
    const body = await res.json().catch(() => null)
    if (!validMeta(body) || (!meta && typeof body.blob !== 'string')) return { failed: 'failed' }
    return { copy: { ...metaOf(body), ...(meta ? {} : { blob: body.blob }) } }
  }

  async function currentBundle() {
    let total = 0
    for (const name of SYNCED_FILES) {
      try {
        total += fs.statSync(join(dataDir, name)).size
      } catch {
        /* not there: it is left out */
      }
    }
    if (total > MAX_PLAIN_BYTES) throw fail('too-big')
    const build = await Promise.resolve(getBuild()).catch(() => '')
    const { bundle, unsettled } = buildSyncBundle({ dir: dataDir, appVersion, build, now })
    return { bundle, unsettled, hash: hashOf(bundle.files) }
  }

  // Sends this computer's setup as version expected + 1. -> 'sent', 'same', 'later', 'conflict',
  // or 'failed' (with problem saying why).
  async function push({ expected, evenIfSame = false, timeoutMs = requestMs }) {
    const state = mine()
    const usable = theKey()
    if (!state || !usable) return 'later'
    let built
    try {
      built = await currentBundle()
    } catch (err) {
      problem = err && err.code === 'too-big' ? 'tooBig' : 'failed'
      return 'failed'
    }
    if (built.unsettled || !Object.keys(built.bundle.files).length) return 'later'
    if (!evenIfSame && built.hash === state.hash && expected === state.base) {
      problem = null
      return 'same'
    }
    // What the window writes back after a copy was put in place is not the person's change.
    if (settleUntil && !evenIfSame) {
      saved = { ...state, hash: built.hash }
      persist()
      return 'same'
    }
    if (!evenIfSame && built.hash === tooBigHash) return 'failed'
    const version = expected + 1
    const blob = await sealCopy({ bundle: built.bundle, key: usable, userId: state.userId, version })
    lastPushAt = now()
    if (blob.length > maxBlob) {
      tooBigHash = built.hash
      problem = 'tooBig'
      log.warn('sync', `too big to send: ${blob.length} bytes`) // i18n-ignore
      return 'failed'
    }
    const { res, failed } = await call('/api/sync', {
      method: 'PUT',
      timeoutMs,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_version: expected, salt: state.salt, device, blob })
    })
    if (failed) {
      problem = failed
      return 'failed'
    }
    if (res.ok) {
      const answer = await res.json().catch(() => null)
      if (!answer || answer.version !== version) {
        problem = 'failed'
        return 'failed'
      }
      saved = { ...state, base: version, hash: built.hash, at: Number.isFinite(answer.updated_at) ? answer.updated_at : now() }
      persist()
      remote = null
      problem = null
      tooBigHash = null
      firstChangeAt = null
      log.info('sync', `sent version ${version}`) // i18n-ignore
      return 'sent'
    }
    if (res.status === 409) {
      const answer = await res.json().catch(() => null)
      await reconcile(validMeta(answer) ? metaOf(answer) : null)
      return 'conflict'
    }
    if (res.status === 413) {
      tooBigHash = built.hash
      problem = 'tooBig'
    } else if (res.status === 429) {
      backoffUntil = now() + RATE_LIMITED_MS
      problem = 'rateLimited'
    } else problem = 'failed'
    return 'failed'
  }

  // Said once for each copy: the page keeps the question, the person is not told again.
  function tellOnce(meta) {
    const mark = `${meta.salt}:${meta.version}`
    if (mine().asked === mark) return
    saved = { ...mine(), asked: mark }
    persist()
    onNewer({ device: meta.device, at: meta.at })
  }

  // What the server holds, against what this computer last had. Never uploads and never applies.
  async function reconcile(meta) {
    const state = mine()
    if (!state) return
    if (!meta) {
      // A copy this computer had or made is gone: erased from another computer. Sending this
      // one's would bring back what the person just erased, so it stops, and says so.
      if (state.base) {
        forget()
        notice = 'erased'
        log.info('sync', 'the copy on the server was erased elsewhere: turned off here') // i18n-ignore
      } else remote = null
      return
    }
    // Started over elsewhere, with a new phrase: this key opens nothing any more.
    if (meta.salt !== state.salt) {
      saved = { ...state, sealedKey: null, base: 0, hash: null }
      key = null
      persist()
      remote = meta
      problem = null
      tellOnce(meta)
      return
    }
    if (meta.version === state.base) {
      remote = null
      checkedAt = now()
      return
    }
    // Its key could not be read here: it needs the phrase before it can say anything of this copy.
    if (!theKey()) {
      remote = meta
      return
    }
    const { copy, none, failed } = await readCopy()
    if (failed) {
      problem = failed
      return
    }
    if (none) return reconcile(null)
    const found = { ...metaOf({ ...copy, updated_at: copy.at }), older: copy.version < state.base }
    let files = null
    try {
      files = inspectBackup(await openCopy({ blob: copy.blob, key: theKey(), userId: state.userId, version: copy.version })).files
    } catch (err) {
      if (err && err.code === 'newer') problem = 'newerApp'
      else if (err && err.code === 'unreadable') {
        problem = 'tampered'
        found.unreadable = true
      } else problem = 'failed'
    }
    // Nothing new in it (an upload at quit that got through without this computer hearing the
    // answer, two computers set up the same): nobody is asked.
    if (files) {
      try {
        const { hash, unsettled } = await currentBundle()
        if (!unsettled && hash === hashOf(files)) {
          saved = { ...mine(), base: copy.version, hash, at: copy.at || now() }
          persist()
          remote = null
          problem = null
          return
        }
      } catch {
        /* then the person is asked */
      }
    }
    remote = found
    tellOnce(found)
  }

  // Whether a newer copy waits on the server.
  async function look() {
    const state = mine()
    if (!state || !state.on || state.staged) return
    const { copy, none, failed } = await readCopy({ meta: true })
    if (failed) {
      if (failed !== 'signedOut') problem = failed
      return
    }
    if (problem === 'offline') problem = null
    await reconcile(none ? null : copy)
  }

  // --- what runs by itself -------------------------------------------------------------
  function signature() {
    return SYNCED_FILES.map((name) => {
      try {
        const stat = fs.statSync(join(dataDir, name))
        return `${stat.mtimeMs}:${stat.size}`
      } catch {
        return '-'
      }
    }).join('|')
  }

  // Nothing goes up while the person has a question to answer, or something staged.
  function mayUpload() {
    const state = mine()
    return !!(state && state.on && !state.staged && !remote && theKey() && !hasPendingImport(dataDir))
  }

  function tick() {
    if (busy || !mayUpload()) return
    const at = now()
    const current = signature()
    if (current !== lastSignature) {
      lastSignature = current
      changedAt = at
      if (firstChangeAt === null) firstChangeAt = at
    }
    if (settleUntil) {
      if (at < settleUntil) return
      settleUntil = 0
      exclusive(async () => {
        const { hash, unsettled } = await currentBundle()
        if (!unsettled && mine()) {
          saved = { ...mine(), hash }
          persist()
          firstChangeAt = null
        }
      }).catch(() => {})
      return
    }
    if (firstChangeAt === null || at < backoffUntil || at - lastPushAt < minIntervalMs) return
    if (at - changedAt < debounceMs && at - firstChangeAt < maxWaitMs) return
    exclusive(async () => {
      if (!mayUpload()) return
      const result = await push({ expected: mine().base })
      // Nothing more to try until the files change again.
      if (result === 'same' || (result === 'failed' && problem === 'tooBig')) firstChangeAt = null
    }).catch((err) => log.warn('sync', `upload: ${(err && err.code) || 'failed'}`)) // i18n-ignore
  }

  function startTimers() {
    if (ticker) return
    ticker = setInterval(tick, tickMs)
    if (ticker.unref) ticker.unref()
    firstLook = setTimeout(() => {
      firstLook = null
      exclusive(look).catch(() => {})
    }, firstLookMs)
    if (firstLook.unref) firstLook.unref()
  }

  function stopTimers() {
    clearInterval(ticker)
    clearTimeout(firstLook)
    ticker = null
    firstLook = null
  }

  // Once the window has restored its layout. applied: the next start really put a staged copy
  // in place. It then is what this computer has, whatever the window writes back at first.
  function start({ applied = false } = {}) {
    started = true
    try {
      const state = saved
      if (state && state.staged && !hasPendingImport(dataDir)) {
        saved = { ...state, staged: null, ...(applied ? { base: state.staged.version, hash: null, at: now() } : {}) }
        persist()
        if (applied) settleUntil = now() + settleMs
      }
    } catch (err) {
      log.warn('sync', `start: ${(err && err.code) || 'error'}`) // i18n-ignore
    }
    if (saved && saved.on) startTimers()
  }

  // Just signed in: the state of this account, if it has one, comes back to life.
  function wake() {
    if (started && mine()?.on) {
      startTimers()
      exclusive(look).catch(() => {})
    }
  }

  // --- what the page asks ---------------------------------------------------------------
  // Asks the server only when asked to, and only with the feature on.
  async function status({ check = false } = {}) {
    if (check && mine()?.on) await exclusive(look)
    return view()
  }

  // What the form needs: whether a copy is already there, and whose.
  function peek() {
    return exclusive(async () => {
      if (!account.userId()) return refusal('signedOut')
      const { copy, none, failed } = await readCopy({ meta: true })
      if (failed) return refusal(failed)
      return { ...view(), copy: none ? null : { device: copy.device, at: copy.at } }
    })
  }

  function adopt({ userId, salt, raw, base = 0 }) {
    saved = { userId, on: true, salt, sealedKey: sealKey(raw), base, hash: null, at: null, staged: null, asked: null }
    key = raw
    remote = null
    problem = null
    notice = null
    tooBigHash = null
    lastSignature = null
    firstChangeAt = null
    backoffUntil = 0
    persist()
    if (started) startTimers()
  }

  async function firstUpload(userId, clean) {
    const salt = randomBytes(SALT_BYTES).toString('base64url')
    adopt({ userId, salt, raw: await deriveKey(clean, salt, scryptCost) })
    return push({ expected: 0, evenIfSame: true })
  }

  async function turnOnNow(clean, userId, tries = 2) {
    const { copy, none, failed } = await readCopy()
    if (failed) return refusal(failed)
    if (none) {
      const sent = await firstUpload(userId, clean)
      if (sent === 'conflict' && tries > 1) {
        // Another computer of this person got there first: its copy decides the salt.
        forget()
        return turnOnNow(clean, userId, tries - 1)
      }
      return view()
    }
    const raw = await deriveKey(clean, copy.salt, scryptCost)
    let files
    try {
      files = inspectBackup(await openCopy({ blob: copy.blob, key: raw, userId, version: copy.version })).files
    } catch (err) {
      if (err && err.code === 'newer') return refusal('newerApp')
      // A wrong phrase and a changed copy are the same to AES-GCM. Nothing changes either way.
      return refusal(err && err.code === 'unreadable' ? 'wrongPhrase' : 'failed')
    }
    adopt({ userId, salt: copy.salt, raw })
    try {
      const { hash, unsettled } = await currentBundle()
      if (!unsettled && hash === hashOf(files)) {
        saved = { ...saved, base: copy.version, hash, at: copy.at || now() }
        persist()
        return view()
      }
    } catch {
      /* then the person is asked */
    }
    remote = metaOf({ ...copy, updated_at: copy.at })
    // The person is looking at the question: it needs no other word.
    saved = { ...saved, asked: `${copy.salt}:${copy.version}` }
    persist()
    return view()
  }

  // The phrase comes from the page here, is used and dropped.
  function turnOn(phrase) {
    const clean = cleanPhrase(phrase)
    return exclusive(async () => {
      if (!clean) return refusal('shortPhrase')
      if (!secureStorageAvailable(safeStorage)) return refusal('noSecureStorage')
      const userId = account.userId()
      if (!userId) return refusal('signedOut')
      return turnOnNow(clean, userId)
    })
  }

  // A lost phrase: the copy on the server is erased, and a new one made from this computer.
  function startOver(phrase) {
    const clean = cleanPhrase(phrase)
    return exclusive(async () => {
      if (!clean) return refusal('shortPhrase')
      if (!secureStorageAvailable(safeStorage)) return refusal('noSecureStorage')
      const userId = account.userId()
      if (!userId) return refusal('signedOut')
      const { res, failed } = await call('/api/sync', { method: 'DELETE' })
      if (failed) return refusal(failed)
      if (!res.ok) return refusal(res.status === 429 ? 'rateLimited' : 'failed')
      await firstUpload(userId, clean)
      return view()
    })
  }

  // Off, and with erase the copy on the server too. Fails without changing anything if the
  // server cannot confirm the erasing.
  function turnOff({ erase = false } = {}) {
    return exclusive(async () => {
      if (erase) {
        const { res, failed } = await call('/api/sync', { method: 'DELETE' })
        if (failed) return refusal(failed)
        if (!res.ok) return refusal(res.status === 429 ? 'rateLimited' : 'failed')
      }
      forget()
      notice = null
      return view()
    })
  }

  // Now, whatever the timers say. A newer copy on the server comes first: nothing goes up over it.
  function syncNow() {
    return exclusive(async () => {
      if (!mine()?.on) return view()
      const { copy, none, failed } = await readCopy({ meta: true })
      if (failed) {
        problem = failed === 'signedOut' ? null : failed
        return refusal(failed)
      }
      await reconcile(none ? null : copy)
      if (!mayUpload()) return view()
      backoffUntil = 0
      const result = await push({ expected: mine().base })
      if (result === 'sent' || result === 'same') checkedAt = now()
      return view()
    })
  }

  // The newer copy, decrypted and checked, staged for the next start. Nothing else changes.
  function apply() {
    return exclusive(async () => {
      const state = mine()
      const usable = theKey()
      if (!state || !usable || !remote) return refusal('failed')
      const { copy, none, failed } = await readCopy()
      if (failed) return refusal(failed)
      if (none) {
        await reconcile(null)
        return refusal('failed')
      }
      // Newer again since the person read which computer and when: they are told, and choose.
      if (copy.salt !== state.salt || copy.version !== remote.version) {
        await reconcile(metaOf({ ...copy, updated_at: copy.at }))
        return refusal('changedAgain')
      }
      let files
      try {
        files = inspectBackup(await openCopy({ blob: copy.blob, key: usable, userId: state.userId, version: copy.version })).files
      } catch (err) {
        problem = err && err.code === 'newer' ? 'newerApp' : 'tampered'
        return refusal(problem)
      }
      let missing = []
      const layout = 'workspace-layout.json'
      if (files[layout]) {
        const [running, known] = await Promise.all([runningPanes().catch(() => []), knownCommands().catch(() => [])])
        let currentBody
        try {
          currentBody = fs.readFileSync(join(dataDir, layout), 'utf8')
        } catch {
          currentBody = null
        }
        const local = localizeLayout(files[layout], { currentBody, running: new Set(running), now })
        files = { ...files, [layout]: local.body }
        missing = local.missing
        stageImport({ dir: dataDir, files, categories: SYNC_CATEGORIES, knownCommands: known, now })
      } else stageImport({ dir: dataDir, files, categories: SYNC_CATEGORIES, now })
      saved = { ...state, staged: { version: copy.version, device: copy.device, at: copy.at, missing: missing.slice(0, 20) } }
      persist()
      remote = null
      problem = null
      log.info('sync', `version ${copy.version} staged for the next start`) // i18n-ignore
      return view()
    })
  }

  // Changed their mind before the restart: what was staged goes, and the question comes back.
  function cancelApply() {
    return exclusive(async () => {
      const state = mine()
      if (!state || !state.staged) return view()
      if (!dropPendingImport({ dir: dataDir })) return refusal('failed')
      saved = { ...state, staged: null }
      persist()
      await look()
      return view()
    })
  }

  // Keeps this computer's: it goes up over the other one, on the person's word.
  function keepMine() {
    return exclusive(async () => {
      const state = mine()
      if (!state || !theKey() || !remote) return view()
      const result = await push({ expected: remote.version, evenIfSame: true })
      if (result === 'later') return refusal('failed')
      return result === 'failed' ? refusal(problem || 'failed') : view()
    })
  }

  // At quit, if it can be done quickly: never waits long, and what it could not do waits for
  // the next start, as the files stay what they are.
  async function flushAtQuit() {
    if (busy || settleUntil || !mayUpload() || now() < backoffUntil) return false
    const state = mine()
    const work = exclusive(() => push({ expected: state.base, timeoutMs: quitMs })).catch(() => false)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), quitMs)
      work.then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
    })
  }

  // The account was deleted, and the server's copy with it.
  function accountDeleted() {
    forget()
    notice = null
    told()
  }

  return { status, peek, turnOn, startOver, turnOff, syncNow, apply, cancelApply, keepMine, start, wake, flushAtQuit, accountDeleted, close: stopTimers, tick }
}
