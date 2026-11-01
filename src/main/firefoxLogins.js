// Reading Firefox-family saved logins (logins.json + key4.db) with Node's
// crypto only, no native NSS module. The key store key4.db holds a random
// global salt and a wrapped DES-EDE3 ("3DES") key; each login field in
// logins.json is a PK11SDR blob (DES-EDE3-CBC) that this 3DES key unlocks.
//
// Two at-rest schemes wrap the key, and the scheme is recorded in key4.db:
// - pbeWithSha1AndTripleDES-CBC (older profiles): an HMAC-SHA1 key derivation,
//   3DES-CBC.
// - PBES2 (newer profiles): PBKDF2-HMAC-SHA256 then AES-256-CBC.
// A Primary Password, when set, is the input to that derivation and cannot be
// guessed here: the caller is told to export a CSV from Firefox instead.
//
// Nothing decrypted is written or logged; only the vault receives the result.
import crypto from 'node:crypto'
import { sqliteModule } from './cookieImport/chromium'

const fail = (code) => Object.assign(new Error(code), { code })

const OID = {
  pbeWithSha1AndTripleDES: '1.2.840.113549.1.12.5.1.3',
  pbes2: '1.2.840.113549.1.5.13',
  // What each login field itself is encrypted with (the PK11SDR blob's algorithm):
  // older profiles DES-EDE3-CBC with a 24-byte key and an 8-byte IV, newer Firefox
  // AES-256-CBC with a 32-byte key and a 16-byte IV.
  des3cbc: '1.2.840.113549.3.7',
  aes256cbc: '2.16.840.1.101.3.4.1.42'
}
// The fixed object id (CKA_ID) of the wrapped SDR key row in nssPrivate.
const CKA_ID = Buffer.from('f8000000000000000000000000000001', 'hex')
const PASSWORD_CHECK = 'password-check'
const MAX_LOGINS = 5001

// Minimal DER decoder: constructed tags (SEQUENCE/SET) get parsed children,
// primitives keep their raw content. Enough for the NSS structures above; it
// throws on anything malformed rather than guessing.
export function parseDer(buf, off = { i: 0 }) {
  if (off.i + 2 > buf.length) throw fail('der')
  const tag = buf[off.i++]
  let len = buf[off.i++]
  if (len & 0x80) {
    const n = len & 0x7f
    if (n === 0 || n > 4 || off.i + n > buf.length) throw fail('der')
    len = 0
    for (let k = 0; k < n; k++) len = (len << 8) | buf[off.i++]
  }
  if (off.i + len > buf.length) throw fail('der')
  const content = buf.subarray(off.i, off.i + len)
  off.i += len
  const node = { tag, content }
  if (tag & 0x20) {
    node.children = []
    const inner = { i: 0 }
    while (inner.i < content.length) node.children.push(parseDer(content, inner))
  }
  return node
}

function oid(node) {
  const b = node.content
  if (!b.length) throw fail('der')
  const out = [Math.floor(b[0] / 40), b[0] % 40]
  let v = 0
  for (let k = 1; k < b.length; k++) {
    v = (v << 7) | (b[k] & 0x7f)
    if (!(b[k] & 0x80)) { out.push(v); v = 0 }
  }
  return out.join('.')
}

function int(node) {
  let v = 0
  for (const byte of node.content) v = v * 256 + byte
  return v
}

// The legacy scheme derives both the 3DES key and the IV from the password and
// two salts (Mozilla's PBE, HMAC-SHA1).
function moz3desKeyIv(globalSalt, primaryPassword, entrySalt) {
  const hp = crypto.createHash('sha1').update(Buffer.concat([globalSalt, primaryPassword])).digest()
  const pes = Buffer.alloc(20)
  entrySalt.copy(pes, 0, 0, Math.min(20, entrySalt.length))
  const chp = crypto.createHash('sha1').update(Buffer.concat([hp, entrySalt])).digest()
  const hmac = (k, d) => crypto.createHmac('sha1', k).update(d).digest()
  const k1 = hmac(chp, Buffer.concat([pes, entrySalt]))
  const tk = hmac(chp, pes)
  const k2 = hmac(chp, Buffer.concat([tk, entrySalt]))
  const k = Buffer.concat([k1, k2]) // 40 bytes
  return { key: k.subarray(0, 24), iv: k.subarray(32, 40) }
}

// Decrypts an algorithm-wrapped blob (metaData item2 or the nssPrivate key),
// whose outer SEQUENCE is [ AlgorithmIdentifier, OCTET STRING ciphertext ].
// Padding is left in place; the callers strip or slice what they need.
function decryptWrapped(node, globalSalt, primaryPassword) {
  const algId = node.children[0]
  const algo = oid(algId.children[0])
  const cipher = node.children[1].content
  if (algo === OID.pbeWithSha1AndTripleDES) {
    const entrySalt = algId.children[1].children[0].content
    const { key, iv } = moz3desKeyIv(globalSalt, primaryPassword, entrySalt)
    const d = crypto.createDecipheriv('des-ede3-cbc', key, iv)
    d.setAutoPadding(false)
    return Buffer.concat([d.update(cipher), d.final()])
  }
  if (algo === OID.pbes2) {
    const params = algId.children[1] // [ KDF, encScheme ]
    const kdfParams = params.children[0].children[1] // [ salt, iterations, keyLength?, prf? ]
    const entrySalt = kdfParams.children[0].content
    const iterations = int(kdfParams.children[1])
    const keyLength = kdfParams.children[2] && kdfParams.children[2].tag === 0x02 ? int(kdfParams.children[2]) : 32
    const iv14 = params.children[1].children[1].content
    // NSS stores a 14-byte IV and reuses its DER header (0x04 len) as the two
    // leading bytes of the real 16-byte AES IV.
    const iv = Buffer.concat([Buffer.from([0x04, iv14.length]), iv14])
    const k = crypto.createHash('sha1').update(Buffer.concat([globalSalt, primaryPassword])).digest()
    const key = crypto.pbkdf2Sync(k, entrySalt, iterations, keyLength, 'sha256')
    const d = crypto.createDecipheriv('aes-256-cbc', key, iv)
    d.setAutoPadding(false)
    return Buffer.concat([d.update(cipher), d.final()])
  }
  throw fail('unsupported')
}

function stripPadding(buf) {
  const pad = buf.length ? buf[buf.length - 1] : 0
  const end = pad > 0 && pad <= buf.length ? buf.length - pad : buf.length
  return buf.subarray(0, end)
}

// The password-check marker: throws { code: 'primary-password' } when it does not
// match (a Primary Password is set, or the store cannot be read with an empty one).
export function checkPassword({ globalSalt, item2, primaryPassword = Buffer.alloc(0) }) {
  let check
  try {
    check = stripPadding(decryptWrapped(parseDer(item2), globalSalt, primaryPassword)).toString('latin1')
  } catch {
    throw fail('primary-password')
  }
  if (check !== PASSWORD_CHECK) throw fail('primary-password')
}

// The raw record of one wrapped key (nssPrivate row): 24 bytes of 3DES key then
// padding, or a 32-byte AES-256 key. Which of the two a login field wants is
// said by the field itself (decryptField); the padding is not stripped here, an
// AES key may end in any byte.
export function unwrapKey({ globalSalt, a11, primaryPassword = Buffer.alloc(0) }) {
  return Buffer.from(decryptWrapped(parseDer(a11), globalSalt, primaryPassword))
}

// The default (3DES-era) key, for callers that only need that one.
export function deriveLoginKey({ globalSalt, item2, a11, primaryPassword = Buffer.alloc(0) }) {
  checkPassword({ globalSalt, item2, primaryPassword })
  return unwrapKey({ globalSalt, a11, primaryPassword })
}

// The id of the key a logins.json field says it was encrypted with (hex), or ''.
export function fieldKeyId(b64) {
  try {
    const node = parseDer(Buffer.from(String(b64 || ''), 'base64'))
    return node.children[0].content.toString('hex')
  } catch {
    return ''
  }
}

// One logins.json field (base64 PK11SDR blob) -> plaintext string, or null when
// it cannot be read (counted as skipped, never logged).
export function decryptField(b64, key) {
  let blob
  try {
    blob = Buffer.from(String(b64 || ''), 'base64')
  } catch {
    return null
  }
  if (!blob.length) return null
  try {
    const node = parseDer(blob) // [ keyId, [ algo, iv ], ciphertext ]
    const algo = oid(node.children[1].children[0])
    const iv = node.children[1].children[1].content
    const cipher = node.children[2].content
    let d
    if (algo === OID.aes256cbc) {
      if (!key || key.length < 32 || iv.length !== 16) return null
      d = crypto.createDecipheriv('aes-256-cbc', key.subarray(0, 32), iv)
    } else if (algo === OID.des3cbc) {
      if (!key || key.length < 24 || iv.length !== 8) return null
      d = crypto.createDecipheriv('des-ede3-cbc', key.subarray(0, 24), iv)
    } else return null
    return Buffer.concat([d.update(cipher), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

// Reads the global salt, the password-check item and the wrapped key from a
// key4.db copy. Returns Buffers; throws { code: 'unreadable' } if absent.
export function readKey4(dbPath) {
  const { DatabaseSync } = sqliteModule()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const meta = db.prepare("SELECT item1, item2 FROM metaData WHERE id = 'password'").get()
    if (!meta || meta.item1 == null || meta.item2 == null) throw fail('unreadable')
    // Every wrapped key, by its id: a login field names the one it needs (a newer
    // profile holds an AES key next to the old 3DES one).
    const keys = new Map()
    for (const row of db.prepare('SELECT a11, a102 FROM nssPrivate').all()) {
      if (row.a102 != null && row.a11 != null && keys.size < 16) keys.set(Buffer.from(row.a102).toString('hex'), Buffer.from(row.a11))
    }
    if (!keys.size) throw fail('unreadable')
    const a11 = keys.get(CKA_ID.toString('hex')) || [...keys.values()][0]
    return { globalSalt: Buffer.from(meta.item1), item2: Buffer.from(meta.item2), a11, keys }
  } finally {
    db.close()
  }
}

// Decrypts a logins.json object with a key4.db already read by readKey4.
// -> { incoming: [{ origin, username, password }], skipped } or throws
// { code: 'primary-password' }.
export function decryptLogins(loginsJson, { globalSalt, item2, a11, keys }) {
  checkPassword({ globalSalt, item2 })
  // Each key is unwrapped once, the first time a field names it.
  const unwrapped = new Map()
  const keyFor = (b64) => {
    const id = fieldKeyId(b64)
    if (!unwrapped.has(id)) {
      let material = null
      try {
        const row = (keys && keys.get(id)) || (!keys || !id ? a11 : null)
        material = row ? unwrapKey({ globalSalt, a11: row }) : null
      } catch {
        material = null
      }
      unwrapped.set(id, material)
    }
    return unwrapped.get(id)
  }
  const logins = Array.isArray(loginsJson && loginsJson.logins) ? loginsJson.logins : []
  const incoming = []
  let skipped = 0
  for (const login of logins.slice(0, MAX_LOGINS)) {
    const password = decryptField(login && login.encryptedPassword, keyFor(login && login.encryptedPassword))
    const username = decryptField(login && login.encryptedUsername, keyFor(login && login.encryptedUsername))
    if (password == null || typeof (login && login.hostname) !== 'string') { skipped++; continue }
    incoming.push({ origin: login.hostname, username: username || '', password })
  }
  return { incoming, skipped }
}
