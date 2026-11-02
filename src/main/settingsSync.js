// Settings > Tessel account > Your settings everywhere: a person's settings, projects, SSH hosts
// and task board on every computer they sign in on, encrypted before they leave this one. The
// server keeps the last few blobs, which it cannot read.
//
// The key comes from a sync phrase the person chooses (accounts made with Google or GitHub have no
// password), with scrypt and a random salt kept beside the blob. The phrase is used here once and
// forgotten; the key stays here, sealed with the OS, so the phrase is asked once per computer.
// Neither ever goes to the server or to the window. A lost phrase cannot be recovered: starting
// over erases the server's copy.
//
// What goes in a copy, and what becomes of one that arrives, is syncSchema.js: it is rebuilt from a
// strict list on both sides. Inside the seal: the bundle, padded to a large fixed size so that its
// length says next to nothing, the name of the computer that wrote it and the time, and a sealed
// number (seq) that only ever goes up on this computer (highWater). The server's own version number
// only decides who wrote first: nothing sealed ever takes a number from what the server says.
//
// A copy from another computer is never put in place silently, because that replaces the layout
// and needs a restart: the person is asked, and it is staged for the next start. An upload that
// would lose most of the setup is not sent either: the person is asked too. What the server says
// never turns anything off: the key is only dropped when the person says so.
//
// Being offline or signed out changes nothing here: it tries again later, without a word.
import fs from 'fs'
import { join } from 'path'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'crypto'
import { gzip, gunzip } from 'zlib'
import { secureStorageAvailable } from './credentialProtection'
import { SYNC_CATEGORIES, buildSyncBundle, dropPendingImport, hasPendingImport, inspectBackup, localizeLayout, stageImport } from './settingsBackup'
import { SYNCED_FILE_NAMES, hostChangesOf, rebuildReceived, shapeOf, shrunkFrom, summaryOf } from './syncSchema'

export const SYNC_FORMAT = 1
export const MIN_PHRASE = 12
// The server's limit (its src/sync.js), which fits a row of its database.
export const MAX_BLOB = 1_900_000
// The sealed part is padded up to one of these, whatever it holds: its length gives away which
// bucket it fell in, and nothing else. The last fits the server's limit once in base64url.
export const PAD_BUCKETS = [64 * 1024, 256 * 1024, 1024 * 1024, 1_400_000]
// Far beyond any setup that fits once compressed: such files are not even read.
const MAX_PLAIN_BYTES = 64 * 1024 * 1024
const MAX_STATE = 2 * 1024 * 1024
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
// What an answer may weigh: beyond it, reading stops. The server's limit, with room for the rest.
const MAX_RESPONSE = MAX_BLOB + 64 * 1024
const MAX_META_RESPONSE = 64 * 1024
const KEPT_VERSIONS = 5

const TICK_MS = 60 * 1000
const DEBOUNCE_MS = 60 * 1000
const MIN_INTERVAL_MS = 5 * 60 * 1000
const MAX_WAIT_MS = 15 * 60 * 1000
const FIRST_LOOK_MS = 15 * 1000
// After a copy was put in place, the window needs a moment to load it and write it back its own
// way: that is not a change of the person's. Kept across a restart.
const SETTLE_MS = 3 * 60 * 1000
const RATE_LIMITED_MS = 60 * 60 * 1000
// A file that cannot be read for this long is no longer "being written": the person is told.
const STOPPED_AFTER_MS = 10 * 60 * 1000
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

// What guessing would start with. Only asked of a phrase being chosen: an existing copy's phrase
// is whatever it is.
const COMMON_IN_PHRASES = ['password', 'passw0rd', 'motdepasse', 'qwerty', 'azerty', 'letmein', 'iloveyou', 'jetaime', 'welcome', 'bienvenue', 'admin', 'tessel', 'secret', 'dragon', 'monkey', 'sunshine', 'football', 'changeme']
const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'azertyuiop', 'qsdfghjklm', 'wxcvbn', '1234567890', 'abcdefghijklmnopqrstuvwxyz']
export function phraseIsWeak(clean) {
  let rest = String(clean).toLowerCase()
  for (const word of COMMON_IN_PHRASES) rest = rest.split(word).join(' ')
  // Keyboard rows and sequences, either way, from four keys on.
  for (const row of KEY_ROWS) {
    for (const line of [row, [...row].reverse().join('')]) {
      for (let size = line.length; size >= 4; size--) {
        for (let at = 0; at + size <= line.length; at++) rest = rest.split(line.slice(at, at + size)).join(' ')
      }
    }
  }
  // A character repeated counts once, and so does a pattern repeated (abcabcabc).
  rest = rest.replace(/(.)\1+/gu, '$1').replace(/(.{2,6}?)\1+/gu, '$1')
  const letters = [...rest].filter((ch) => /[\p{L}\p{N}]/u.test(ch) || /[^\s]/.test(ch))
  return letters.length < 8 || new Set(letters).size < 5 || /^[\p{N}\s\p{P}]*$/u.test(rest)
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

// What the encryption is bound to: this format and this account.
const boundTo = (userId) => Buffer.from(`tessel-sync\n${SYNC_FORMAT}\n${userId}`)

// The compressed part, its length first, then zeros up to the bucket. Compressing leaks through
// length, so the length never shows.
function padded(plain) {
  const size = PAD_BUCKETS.find((bucket) => plain.length + 4 <= bucket)
  if (!size) throw fail('too-big')
  const out = Buffer.alloc(size)
  out.writeUInt32BE(plain.length, 0)
  plain.copy(out, 4)
  return out
}
function unpadded(bytes) {
  if (bytes.length < 4) throw fail('unreadable')
  const length = bytes.readUInt32BE(0)
  if (length + 4 > bytes.length) throw fail('unreadable')
  return bytes.subarray(4, 4 + length)
}

// bundle, seq, device and time -> compressed, padded, then AES-256-GCM with a fresh nonce:
// format, nonce, tag, ciphertext.
export async function sealCopy({ bundle, key, userId, seq, device = '', at = 0 }) {
  const compressed = await new Promise((resolve, reject) => gzip(Buffer.from(JSON.stringify({ seq, device, at, bundle })), { level: 9 }, (err, out) => (err ? reject(err) : resolve(out))))
  const plain = padded(compressed)
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(boundTo(userId))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([Buffer.from([SYNC_FORMAT]), nonce, cipher.getAuthTag(), body]).toString('base64url')
}

// -> { seq, device, at, bundle }. Throws { code: 'unreadable' } for a wrong key or a change of any
// kind, { code: 'newer' } for a format this version does not know.
export async function openCopy({ blob, key, userId }) {
  const bytes = Buffer.from(String(blob), 'base64url')
  if (bytes.length < 1 + NONCE_BYTES + TAG_BYTES) throw fail('unreadable')
  if (bytes[0] > SYNC_FORMAT) throw fail('newer')
  if (bytes[0] !== SYNC_FORMAT) throw fail('unreadable')
  let plain
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 1 + NONCE_BYTES))
    decipher.setAAD(boundTo(userId))
    decipher.setAuthTag(bytes.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES))
    plain = Buffer.concat([decipher.update(bytes.subarray(1 + NONCE_BYTES + TAG_BYTES)), decipher.final()])
  } catch {
    throw fail('unreadable')
  }
  const text = await new Promise((resolve, reject) => gunzip(unpadded(plain), { maxOutputLength: MAX_PLAIN_BYTES }, (err, out) => (err ? reject(fail('unreadable')) : resolve(out.toString('utf8')))))
  let sealed
  try {
    sealed = JSON.parse(text)
  } catch {
    throw fail('unreadable')
  }
  if (!sealed || !Number.isSafeInteger(sealed.seq) || sealed.seq < 1 || !sealed.bundle || typeof sealed.bundle !== 'object') throw fail('unreadable')
  return { seq: sealed.seq, device: deviceLabel(sealed.device), at: Number.isFinite(sealed.at) ? sealed.at : null, bundle: sealed.bundle }
}

// Whether two setups are the same, whatever else is in their bundles.
function hashOf(files) {
  const hash = createHash('sha256')
  for (const name of Object.keys(files).sort()) hash.update(`${name}\n${files[name].length}\n${files[name]}\n`)
  return hash.digest('base64url')
}

const validMeta = (body) => !!body && Number.isSafeInteger(body.version) && body.version >= 1 && typeof body.salt === 'string' && body.salt.length > 0 && body.salt.length <= 256
const metaOf = (body) => ({ version: body.version, salt: body.salt })

// An answer as JSON, read up to a limit whatever it claims. -> the value, or null.
async function readLimited(res, max) {
  try {
    if (Number(res.headers?.get?.('content-length') || 0) > max) {
      await res.body?.cancel?.()
      return null
    }
    if (!res.body || !res.body.getReader) {
      if (typeof res.json === 'function') return await res.json()
      return null
    }
    const reader = res.body.getReader()
    const chunks = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'))
  } catch {
    return null
  }
}

export function createSettingsSync({
  dir,
  dataDir,
  safeStorage,
  account,
  deviceName = '',
  appVersion = '',
  getBuild = async () => '',
  // The panes whose terminal still runs here, and the agents this computer has:
  // [{ id, command, name, available }]. A pane's command is looked up here, never taken from a copy.
  runningPanes = async () => [],
  localAgents = async () => [],
  folderExists = fs.existsSync,
  onChanged = () => {},
  onNewer = () => {},
  onAlert = () => {},
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
  // { userId, on, salt, sealedKey, base, baseSeq, highWater, hash, shape, at, settleUntil, restored,
  // shadow, staged, asked, erased, shrunk, alert }, or null. Never the key in clear.
  let saved = readSaved()
  let key = null // the key in use, read once
  let remote = null // a copy on the server this computer does not have (see examine)
  let problem = null // why the last automatic step did not work, for the page
  let unreadable = [] // the files that held the last upload back
  let unsettledSince = null
  let busy = false
  let checkedAt = null
  let queue = Promise.resolve()
  let ticker = null
  let firstLook = null
  let started = false
  // Goes up each time the state is forgotten: what was on its way by then does not bring it back.
  let epoch = 0
  // Change detection, in memory: what the files looked like, and since when they changed.
  let lastSignature = null
  let changedAt = null
  let firstChangeAt = null
  let lastPushAt = 0
  let backoffUntil = 0
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

  // On the state as it is now: what was forgotten meanwhile stays forgotten.
  function update(patch) {
    if (!saved) return
    saved = { ...saved, ...patch }
    persist()
  }

  // This account's state: another account's is never used, nor its key.
  function mine() {
    const userId = account.userId()
    return saved && userId && saved.userId === userId ? saved : null
  }

  function theKey() {
    const state = mine()
    if (!state || !state.sealedKey) {
      // Signed out, or another account: nothing of it stays in memory.
      key = null
      return null
    }
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

  // Only ever on the person's word. A copy staged for the next start goes with it: it would apply
  // after they said they want none of this.
  function forget() {
    epoch += 1
    if (saved && saved.staged) {
      try {
        dropPendingImport({ dir: dataDir })
      } catch (err) {
        log.warn('sync', `could not drop what was staged: ${(err && err.code) || 'error'}`) // i18n-ignore
      }
    }
    saved = null
    key = null
    remote = null
    problem = null
    unreadable = []
    unsettledSince = null
    stopTimers()
    try {
      fs.rmSync(file, { force: true })
    } catch (err) {
      log.warn('sync', `could not remove its state: ${(err && err.code) || 'error'}`) // i18n-ignore
    }
  }

  // A lasting alert: kept in the state and shown until it is dealt with, and said again at each start.
  function raiseAlert(kind) {
    if (mine()?.alert === kind) return
    update({ alert: kind })
    onAlert({ kind })
  }
  const clearAlert = (...kinds) => {
    if (kinds.includes(mine()?.alert)) update({ alert: null })
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
      state: !on
        ? 'off'
        : state.staged
          ? 'staged'
          : state.erased
            ? 'erased'
            : !hasKey || (remote && remote.saltChanged)
              ? 'needsPhrase'
              : state.shrunk
                ? 'shrunk'
                : remote
                  ? 'newer'
                  : 'on',
      busy,
      device,
      hasKey,
      // When this computer really sent a copy, by its own clock, and when it last asked the server.
      lastUploadAt: on ? state.at || null : null,
      lastCheckAt: on ? checkedAt : null,
      remote:
        on && remote
          ? {
              device: remote.device || null,
              at: remote.at || null,
              older: !!remote.older,
              unreadable: !!remote.unreadable,
              refused: !!remote.refused,
              saltChanged: !!remote.saltChanged,
              first: !state.base,
              summary: remote.summary || null,
              hostChanges: remote.hostChanges || [],
              local: remote.local || null
            }
          : null,
      staged: on && state.staged ? { device: state.staged.device, at: state.staged.at, missing: state.staged.missing || [], missingAgents: state.staged.missingAgents || [] } : null,
      shrunk: on && state.shrunk ? state.shrunk : null,
      alert: on ? state.alert || null : null,
      problem,
      unreadable
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

  // -> { copy } with its blob when asked for, { none: true }, or { failed }. Only the server's own
  // words say there is no copy: any other 404 (a proxy, a bad deployment) says nothing about it.
  async function readCopy({ meta = false, version = null } = {}) {
    const query = version ? `?version=${version}` : meta ? '?meta=1' : ''
    const { res, failed } = await call(`/api/sync${query}`)
    if (failed) return { failed }
    const body = await readLimited(res, meta ? MAX_META_RESPONSE : MAX_RESPONSE)
    if (res.status === 404) return body && body.error === 'no_copy' ? { none: true } : { failed: 'failed' }
    if (!res.ok) return { failed: 'failed' }
    if (!validMeta(body) || (!meta && typeof body.blob !== 'string')) return { failed: 'failed' }
    return { copy: { ...metaOf(body), ...(meta ? {} : { blob: body.blob }) } }
  }

  async function currentBundle() {
    let total = 0
    for (const name of SYNCED_FILE_NAMES) {
      try {
        total += fs.statSync(join(dataDir, name)).size
      } catch {
        /* not there: it is left out */
      }
    }
    if (total > MAX_PLAIN_BYTES) throw fail('too-big')
    const build = await Promise.resolve(getBuild()).catch(() => '')
    const { bundle, unsettled, unreadable: names } = buildSyncBundle({ dir: dataDir, appVersion, build, now, shadow: mine()?.shadow || null })
    return { bundle, unsettled, unreadable: names, hash: hashOf(bundle.files), shape: shapeOf(bundle.files) }
  }

  // A sealed bundle -> its files, rebuilt from what a copy may hold, and what it is, or throws
  // { code: 'unreadable' | 'newer' | 'refused' }.
  async function openChecked(blob, raw, userId) {
    const sealed = await openCopy({ blob, key: raw, userId })
    try {
      inspectBackup(JSON.stringify(sealed.bundle))
    } catch (err) {
      throw fail(err && err.code === 'newer' ? 'newer' : 'refused')
    }
    return { seq: sealed.seq, device: sealed.device, at: sealed.at, files: rebuildReceived(sealed.bundle.files) }
  }

  function readLocal(name) {
    try {
      return fs.readFileSync(join(dataDir, name), 'utf8')
    } catch {
      return null
    }
  }

  // What the question "Use them?" says of a copy that opened.
  async function describe(opened) {
    const out = { device: opened.device, at: opened.at, seq: opened.seq, summary: summaryOf(opened.files), hostChanges: hostChangesOf(opened.files['remote-hosts.json'] || null, readLocal('remote-hosts.json')) }
    try {
      const { bundle } = await currentBundle()
      out.local = summaryOf(bundle.files)
    } catch {
      /* the question goes without it */
    }
    return out
  }

  function noteUnsettled(names, { now: atOnce = false } = {}) {
    unreadable = names
    if (unsettledSince === null) unsettledSince = now()
    if (atOnce || now() - unsettledSince >= STOPPED_AFTER_MS) {
      problem = 'unreadableFile'
      raiseAlert('uploadsStopped')
    }
  }
  function clearUnsettled() {
    unsettledSince = null
    unreadable = []
    if (problem === 'unreadableFile') problem = null
    clearAlert('uploadsStopped')
  }

  // Sends this computer's setup, on top of the server's version expected. -> 'sent', 'same',
  // 'later', 'conflict', 'asked' (it lost a lot: the person says), or 'failed' (with problem saying
  // why). The number sealed is this computer's own: it never comes from what the server says.
  async function push({ expected, evenIfSame = false, allowShrink = false, stoppedNow = false, timeoutMs = requestMs }) {
    const state = mine()
    const usable = theKey()
    if (!state || !usable) return 'later'
    const era = epoch
    let built
    try {
      built = await currentBundle()
    } catch (err) {
      problem = err && err.code === 'too-big' ? 'tooBig' : err && err.code === 'too-many-panes' ? 'tooManyPanes' : 'failed'
      return 'failed'
    }
    if (built.unsettled) {
      noteUnsettled(built.unreadable, { now: stoppedNow })
      return 'later'
    }
    clearUnsettled()
    if (!Object.keys(built.bundle.files).length) return 'later'
    if (!evenIfSame && built.hash === state.hash && expected === state.base) {
      problem = null
      return 'same'
    }
    // What the window writes back after a copy was put in place is not the person's change.
    if (settling() && !evenIfSame) {
      update({ hash: built.hash, shape: built.shape })
      return 'same'
    }
    if (!evenIfSame && !allowShrink) {
      const lost = shrunkFrom(state.shape, built.shape)
      if (lost) {
        update({ shrunk: lost })
        raiseAlert('shrunk')
        log.warn('sync', 'held back an upload: much of the setup is gone') // i18n-ignore
        return 'asked'
      }
    }
    if (!evenIfSame && built.hash === tooBigHash) return 'failed'
    const seq = (state.highWater || 0) + 1
    const at = now()
    let blob
    try {
      blob = await sealCopy({ bundle: built.bundle, key: usable, userId: state.userId, seq, device, at })
    } catch (err) {
      if (!err || err.code !== 'too-big') throw err
      blob = null
    }
    lastPushAt = now()
    if (!blob || blob.length > maxBlob) {
      tooBigHash = built.hash
      problem = 'tooBig'
      log.warn('sync', `too big to send${blob ? `: ${blob.length} bytes` : ''}`) // i18n-ignore
      return 'failed'
    }
    const { res, failed } = await call('/api/sync', {
      method: 'PUT',
      timeoutMs,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_version: expected, salt: state.salt, blob })
    })
    if (era !== epoch || !mine()) return 'later'
    if (failed) {
      problem = failed
      return 'failed'
    }
    const answer = await readLimited(res, MAX_META_RESPONSE)
    if (era !== epoch || !mine()) return 'later'
    if (res.ok) {
      if (!answer || !Number.isSafeInteger(answer.version) || answer.version < 1) {
        problem = 'failed'
        return 'failed'
      }
      update({ base: answer.version, baseSeq: seq, highWater: seq, hash: built.hash, shape: built.shape, at, shrunk: null, erased: false, alert: null })
      remote = null
      problem = null
      tooBigHash = null
      firstChangeAt = null
      log.info('sync', `sent version ${answer.version}`) // i18n-ignore
      return 'sent'
    }
    if (res.status === 409) {
      // Said in the server's words, or it says nothing about any copy.
      if (answer && answer.error === 'version_conflict' && answer.version === 0) await reconcile(null)
      else if (answer && answer.error === 'version_conflict' && validMeta(answer)) await reconcile(metaOf(answer))
      else problem = 'failed'
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
  function tellOnce(meta, words) {
    const mark = `${meta.salt}:${meta.version}`
    if (!mine() || mine().asked === mark) return
    update({ asked: mark })
    onNewer(words)
  }

  // What the server holds, against what this computer last had. Never uploads and never applies.
  async function reconcile(meta) {
    const state = mine()
    if (!state) return
    if (!meta) {
      // A copy this computer had or made is gone: erased from another computer, or by someone with
      // this account's session. Sending this one's would bring back what the person may have just
      // erased, and turning off would let a stolen session stop it unseen: it keeps its key, sends
      // nothing, and says so until the person chooses.
      remote = null
      if (state.base) {
        if (!state.erased) {
          update({ erased: true })
          log.info('sync', 'the copy on the server is gone: nothing goes up until the person chooses') // i18n-ignore
        }
        raiseAlert('erased')
      }
      return
    }
    if (state.erased) update({ erased: false })
    clearAlert('erased')
    // Another salt: a new phrase on another computer, or someone writing with a stolen session. Only
    // the phrase, when the person enters it, can tell: until then nothing is dropped or sent.
    if (meta.salt !== state.salt) {
      remote = { ...meta, saltChanged: true, device: null, at: null }
      problem = null
      if (mine() && mine().asked !== `${meta.salt}:*`) {
        update({ asked: `${meta.salt}:*` })
        raiseAlert('saltChanged')
      }
      return
    }
    clearAlert('saltChanged')
    if (meta.version === state.base) {
      remote = null
      checkedAt = now()
      return
    }
    // Its key could not be read here: it needs the phrase before it can say anything of this copy.
    if (!theKey()) {
      remote = { ...meta, device: null, at: null }
      return
    }
    const { copy, none, failed } = await readCopy()
    if (failed) {
      problem = failed
      return
    }
    if (none) return reconcile(null)
    const found = { ...metaOf(copy), older: false, unreadable: false, refused: false, device: null, at: null }
    let opened = null
    try {
      opened = await openChecked(copy.blob, theKey(), state.userId)
    } catch (err) {
      if (err && err.code === 'newer') problem = 'newerApp'
      else if (err && err.code === 'unreadable') {
        problem = 'tampered'
        found.unreadable = true
      } else if (err && err.code === 'refused') {
        problem = 'refusedCopy'
        found.refused = true
      } else problem = 'failed'
    }
    if (opened) {
      if (problem === 'tampered' || problem === 'refusedCopy' || problem === 'newerApp') problem = null
      const highest = state.highWater || 0
      // What is highest is remembered at once, whatever the person answers: it never drops.
      if (opened.seq > highest) update({ highWater: opened.seq })
      // The copy this computer last had, under another number: there is nothing to ask.
      if (opened.seq === state.baseSeq) {
        update({ base: copy.version })
        remote = null
        return
      }
      found.older = opened.seq < highest
      Object.assign(found, await describe(opened))
      // Nothing new in it (an upload at quit that got through without this computer hearing the
      // answer, two computers set up the same): nobody is asked. Never for an older one.
      if (!found.older) {
        try {
          const { hash, shape, unsettled } = await currentBundle()
          if (!unsettled && hash === hashOf(opened.files)) {
            update({ base: copy.version, baseSeq: opened.seq, hash, shape, ...(opened.device === device ? { at: opened.at || state.at } : {}) })
            remote = null
            problem = null
            return
          }
        } catch {
          /* then the person is asked */
        }
      }
    }
    remote = found
    tellOnce(found, { device: found.device, at: found.at })
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
    // It answered: what it said before no longer stands.
    if (problem === 'offline' || problem === 'failed') problem = null
    checkedAt = now()
    await reconcile(none ? null : copy)
  }

  // --- what runs by itself -------------------------------------------------------------
  function signature() {
    return SYNCED_FILE_NAMES.map((name) => {
      try {
        const stat = fs.statSync(join(dataDir, name))
        return `${stat.mtimeMs}:${stat.size}`
      } catch {
        return '-'
      }
    }).join('|')
  }

  const settling = () => {
    const until = mine()?.settleUntil
    return !!until && now() < until
  }

  // Nothing goes up while the person has a question to answer, or something staged.
  function mayUpload() {
    const state = mine()
    return !!(state && state.on && !state.staged && !state.erased && !state.shrunk && !remote && theKey() && !hasPendingImport(dataDir))
  }

  // The setup came back (a file in place again, a project reopened): the question has no more reason.
  async function recheckShrunk() {
    const state = mine()
    if (!state || !state.shrunk) return
    const { unsettled, shape } = await currentBundle()
    if (!unsettled && !shrunkFrom(state.shape, shape)) {
      update({ shrunk: null })
      clearAlert('shrunk')
    }
  }

  function tick() {
    if (busy) return
    if (mine()?.on && mine().shrunk) {
      exclusive(recheckShrunk).catch(() => {})
      return
    }
    if (!mayUpload()) return
    const at = now()
    const current = signature()
    if (current !== lastSignature) {
      lastSignature = current
      changedAt = at
      if (firstChangeAt === null) firstChangeAt = at
    }
    const state = mine()
    if (state.settleUntil) {
      if (at < state.settleUntil) return
      exclusive(async () => {
        const { hash, shape, unsettled } = await currentBundle()
        if (unsettled || !mine()) return
        // An earlier copy the person went back to goes up as the copy; any other is what is there.
        if (mine().restored) {
          update({ settleUntil: null, restored: false, shape })
          firstChangeAt = at
        } else {
          update({ settleUntil: null, hash, shape })
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
        const staged = state.staged
        update({
          staged: null,
          ...(applied
            ? {
                base: staged.version,
                baseSeq: staged.seq,
                highWater: Math.max(state.highWater || 0, staged.seq || 0),
                hash: null,
                shape: staged.shape || null,
                shadow: staged.shadow || null,
                settleUntil: now() + settleMs,
                restored: !!staged.earlier,
                shrunk: null,
                erased: false,
                alert: null
              }
            : {})
        })
      }
      // A clock put back must not keep this computer from ever sending again.
      if (saved && saved.settleUntil && saved.settleUntil > now() + settleMs) update({ settleUntil: now() + settleMs })
      if (saved && saved.alert) onAlert({ kind: saved.alert })
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

  // Signed out by the person: nothing of the key stays here, in memory or sealed on disk, and the
  // phrase is asked again at the next sign-in. A session the server ended is not this: what the
  // server says never makes this computer drop its key.
  function signedOut() {
    key = null
    remote = null
    stopTimers()
    if (saved && saved.sealedKey) {
      try {
        update({ sealedKey: null })
      } catch (err) {
        log.warn('sync', `sign-out: ${(err && err.code) || 'error'}`) // i18n-ignore
      }
    }
    told()
  }

  // --- what the page asks ---------------------------------------------------------------
  // Asks the server only when asked to, and only with the feature on.
  async function status({ check = false } = {}) {
    if (check && mine()?.on) await exclusive(look)
    return view()
  }

  // What the form needs: whether a copy is already there. Nothing of what it is can be said before
  // it opens: what the server says of it would be the server's word.
  function peek() {
    return exclusive(async () => {
      if (!account.userId()) return refusal('signedOut')
      const { none, failed } = await readCopy({ meta: true })
      if (failed) return refusal(failed)
      return { ...view(), copy: none ? null : {} }
    })
  }

  // The key goes in the state. Under the salt this computer already had, what it knows stays.
  function adopt({ userId, salt, raw }) {
    const same = saved && saved.userId === userId && saved.salt === salt ? saved : null
    // Staged from another account's copy, or under another phrase: it does not follow.
    if (saved && saved.staged && !same) dropPendingImport({ dir: dataDir })
    saved = {
      userId,
      on: true,
      salt,
      sealedKey: sealKey(raw),
      base: same ? same.base || 0 : 0,
      baseSeq: same ? same.baseSeq || 0 : 0,
      highWater: same ? same.highWater || 0 : 0,
      hash: same ? same.hash || null : null,
      shape: same ? same.shape || null : null,
      shadow: same ? same.shadow || null : null,
      at: same ? same.at || null : null,
      settleUntil: same ? same.settleUntil || null : null,
      staged: same ? same.staged || null : null,
      asked: null,
      alert: null
    }
    key = raw
    remote = null
    problem = null
    tooBigHash = null
    lastSignature = null
    firstChangeAt = null
    backoffUntil = 0
    persist()
    if (started) startTimers()
  }

  async function firstUpload(userId, clean) {
    const era = epoch
    const salt = randomBytes(SALT_BYTES).toString('base64url')
    const raw = await deriveKey(clean, salt, scryptCost)
    if (era !== epoch) return 'later'
    adopt({ userId, salt, raw })
    return push({ expected: 0, evenIfSame: true })
  }

  async function turnOnNow(clean, userId, tries = 2) {
    const era = epoch
    const { copy, none, failed } = await readCopy()
    if (failed) return refusal(failed)
    if (none) {
      // Only a phrase being chosen: an existing copy's phrase is whatever it is.
      if (phraseIsWeak(clean)) return refusal('weakPhrase')
      const sent = await firstUpload(userId, clean)
      if (sent === 'conflict' && tries > 1) {
        // Another computer of this person got there first: its copy decides the salt.
        forget()
        return turnOnNow(clean, userId, tries - 1)
      }
      return view()
    }
    const raw = await deriveKey(clean, copy.salt, scryptCost)
    let opened = null
    let unfit = false
    try {
      opened = await openChecked(copy.blob, raw, userId)
    } catch (err) {
      if (err && err.code === 'newer') return refusal('newerApp')
      if (!err || err.code !== 'refused') {
        // A wrong phrase and a changed copy are the same to AES-GCM. Nothing changes either way:
        // this computer's key, if it has one, stays what it was.
        return refusal(err && err.code === 'unreadable' ? 'wrongPhrase' : 'failed')
      }
      // The right phrase, a copy Tessel does not accept: it can be replaced, never used.
      unfit = true
    }
    if (era !== epoch) return view()
    const before = saved && saved.userId === userId && saved.salt === copy.salt ? saved.highWater || 0 : 0
    adopt({ userId, salt: copy.salt, raw })
    if (opened && opened.seq > before) update({ highWater: opened.seq })
    if (opened && opened.seq === saved.baseSeq) {
      update({ base: copy.version })
      return view()
    }
    const older = !!opened && opened.seq < before
    if (opened && !older) {
      try {
        const { hash, shape, unsettled } = await currentBundle()
        if (!unsettled && hash === hashOf(opened.files)) {
          update({ base: copy.version, baseSeq: opened.seq, hash, shape })
          return view()
        }
      } catch {
        /* then the person is asked */
      }
    }
    remote = { ...metaOf(copy), older, refused: unfit, device: opened ? opened.device : null, at: opened ? opened.at : null, ...(opened ? await describe(opened) : {}) }
    if (unfit) problem = 'refusedCopy'
    // The person is looking at the question: it needs no other word.
    update({ asked: `${copy.salt}:${copy.version}` })
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
      if (phraseIsWeak(clean)) return refusal('weakPhrase')
      if (!secureStorageAvailable(safeStorage)) return refusal('noSecureStorage')
      const userId = account.userId()
      if (!userId) return refusal('signedOut')
      const { res, failed } = await call('/api/sync', { method: 'DELETE' })
      if (failed) return refusal(failed)
      if (!res.ok) return refusal(res.status === 429 ? 'rateLimited' : 'failed')
      // What was staged came from what was just erased.
      if (saved && saved.staged) {
        dropPendingImport({ dir: dataDir })
        saved = { ...saved, staged: null }
      }
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
      checkedAt = now()
      await reconcile(none ? null : copy)
      if (!mayUpload()) return view()
      backoffUntil = 0
      await push({ expected: mine().base, stoppedNow: true })
      return view()
    })
  }

  // A copy that opened -> staged for the next start. Nothing else changes.
  async function stage(copy, opened, { hostAddresses = 'keep', serverVersion = copy.version, earlier = false, era = epoch } = {}) {
    let files = opened.files
    let missing = []
    let missingAgents = []
    let shadow = null
    let running = []
    const layout = 'workspace-layout.json'
    if (files[layout]) {
      const [panes, agents] = await Promise.all([runningPanes().catch(() => []), localAgents().catch(() => [])])
      running = Array.isArray(panes) ? panes : []
      if (era !== epoch) return view()
      const made = localizeLayout(files[layout], { agents: new Map((Array.isArray(agents) ? agents : []).map((agent) => [agent.id, agent])), running: new Set(running), folderExists, now })
      files = { ...files, [layout]: made.body }
      missing = made.missing
      missingAgents = made.missingAgents
      shadow = made.shadow
    }
    if (era !== epoch) return view()
    stageImport({ dir: dataDir, files, categories: SYNC_CATEGORIES, prepared: true, now, extra: { source: 'sync', running, hostAddresses: hostAddresses === 'copy' ? 'copy' : 'keep', device: opened.device } })
    update({
      staged: {
        version: serverVersion,
        seq: opened.seq,
        device: opened.device,
        at: opened.at,
        missing: missing.slice(0, 20),
        missingAgents: missingAgents.slice(0, 20),
        shadow,
        shape: shapeOf(opened.files),
        earlier
      },
      shrunk: null
    })
    remote = null
    problem = null
    log.info('sync', `version ${copy.version} staged for the next start`) // i18n-ignore
    return view()
  }

  // The newer copy, decrypted and checked, staged for the next start. A changed address on a host
  // of this computer is taken only on the person's word (hostAddresses: 'copy').
  function apply({ hostAddresses = 'keep' } = {}) {
    return exclusive(async () => {
      const era = epoch
      const state = mine()
      const usable = theKey()
      if (!state || !usable || !remote) return refusal('failed')
      if (remote.saltChanged) return refusal('wrongPhrase')
      const { copy, none, failed } = await readCopy()
      if (failed) return refusal(failed)
      if (none) {
        await reconcile(null)
        return refusal('failed')
      }
      // Newer again since the person read which computer and when: they are told, and choose.
      if (copy.salt !== state.salt || copy.version !== remote.version) {
        await reconcile(metaOf(copy))
        return refusal('changedAgain')
      }
      let opened
      try {
        opened = await openChecked(copy.blob, usable, state.userId)
      } catch (err) {
        problem = err && err.code === 'newer' ? 'newerApp' : err && err.code === 'refused' ? 'refusedCopy' : 'tampered'
        return refusal(problem)
      }
      return stage(copy, opened, { hostAddresses, era })
    })
  }

  // Changed their mind before the restart: what was staged goes, and the question comes back.
  function cancelApply() {
    return exclusive(async () => {
      const state = mine()
      if (!state || !state.staged) return view()
      if (!dropPendingImport({ dir: dataDir })) return refusal('failed')
      update({ staged: null })
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
      if (result === 'later') return refusal(unreadable.length ? 'unreadableFile' : 'failed')
      return result === 'failed' ? refusal(problem || 'failed') : view()
    })
  }

  // The copy is gone from the server: this computer's goes up as the new one, under the same
  // phrase, on the person's word.
  function sendAgain() {
    return exclusive(async () => {
      const state = mine()
      if (!state || !state.erased || !theKey()) return view()
      const result = await push({ expected: 0, evenIfSame: true })
      if (result === 'later') return refusal(unreadable.length ? 'unreadableFile' : 'failed')
      return result === 'failed' ? refusal(problem || 'failed') : view()
    })
  }

  // Much of the setup is gone and the person says it is right: it goes up.
  function sendSmaller() {
    return exclusive(async () => {
      const state = mine()
      if (!state || !state.shrunk || !theKey()) return view()
      const result = await push({ expected: state.base, allowShrink: true })
      if (result === 'sent' || result === 'same') {
        update({ shrunk: null })
        clearAlert('shrunk')
      }
      if (result === 'later') return refusal(unreadable.length ? 'unreadableFile' : 'failed')
      return result === 'failed' ? refusal(problem || 'failed') : view()
    })
  }

  // Much of the setup is gone and the person wants it back: the copy on the server becomes the question.
  function useCopyInstead() {
    return exclusive(async () => {
      const state = mine()
      const usable = theKey()
      if (!state || !state.shrunk || !usable) return view()
      const { copy, none, failed } = await readCopy()
      if (failed) return refusal(failed)
      if (none) {
        await reconcile(null)
        return view()
      }
      let opened
      try {
        opened = await openChecked(copy.blob, usable, state.userId)
      } catch (err) {
        problem = err && err.code === 'newer' ? 'newerApp' : err && err.code === 'refused' ? 'refusedCopy' : 'tampered'
        return refusal(problem)
      }
      update({ shrunk: null })
      clearAlert('shrunk')
      remote = { ...metaOf(copy), older: false, ...(await describe(opened)) }
      return view()
    })
  }

  // The versions the server keeps, each opened here: what the server says of them is not shown.
  // -> { ...view, versions: [{ version, device, at, seq, summary, unreadable }] }, newest first.
  function earlier() {
    return exclusive(async () => {
      const state = mine()
      const usable = theKey()
      if (!state || !usable) return refusal('failed')
      const { res, failed } = await call('/api/sync/versions')
      if (failed) return refusal(failed)
      if (!res.ok) return refusal(res.status === 429 ? 'rateLimited' : 'failed')
      const body = await readLimited(res, MAX_META_RESPONSE)
      const listed = body && Array.isArray(body.versions) ? body.versions.filter((v) => v && Number.isSafeInteger(v.version) && v.version >= 1).slice(0, KEPT_VERSIONS) : []
      const versions = []
      for (const { version } of listed) {
        const { copy } = await readCopy({ version })
        if (!copy || copy.salt !== state.salt) {
          versions.push({ version, unreadable: true })
          continue
        }
        try {
          const opened = await openChecked(copy.blob, usable, state.userId)
          versions.push({ version, device: opened.device, at: opened.at, seq: opened.seq, summary: summaryOf(opened.files) })
        } catch {
          versions.push({ version, unreadable: true })
        }
      }
      return { ...view(), versions }
    })
  }

  // One of those, staged for the next start. Once this computer runs on it, it goes up as the copy.
  function applyEarlier(version, { hostAddresses = 'keep' } = {}) {
    return exclusive(async () => {
      const era = epoch
      const state = mine()
      const usable = theKey()
      if (!state || !usable || !Number.isSafeInteger(version) || version < 1) return refusal('failed')
      const [{ copy, failed }, head] = await Promise.all([readCopy({ version }), readCopy({ meta: true })])
      if (failed || head.failed) return refusal(failed || head.failed)
      if (!copy || !head.copy || copy.salt !== state.salt) return refusal('failed')
      let opened
      try {
        opened = await openChecked(copy.blob, usable, state.userId)
      } catch (err) {
        return refusal(err && err.code === 'refused' ? 'refusedCopy' : 'tampered')
      }
      return stage(copy, opened, { hostAddresses, serverVersion: head.copy.version, earlier: true, era })
    })
  }

  // At quit, if it can be done quickly: never waits long, and what it could not do waits for
  // the next start, as the files stay what they are.
  async function flushAtQuit() {
    if (busy || settling() || !mayUpload() || now() < backoffUntil) return false
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

  // The account was deleted, and the server's copies with it. Whatever was on its way by now
  // does not bring this back (forget).
  function accountDeleted() {
    forget()
    told()
  }

  return { status, peek, turnOn, startOver, turnOff, syncNow, apply, cancelApply, keepMine, sendAgain, sendSmaller, useCopyInstead, earlier, applyEarlier, start, wake, signedOut, flushAtQuit, accountDeleted, close: stopTimers, tick }
}
