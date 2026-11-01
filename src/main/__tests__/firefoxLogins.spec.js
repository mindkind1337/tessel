// @vitest-environment node
// Firefox-family saved logins: key4.db + logins.json, Node crypto only. The
// fixtures are built here, with the same layout NSS writes (PBES2 + AES-256-CBC
// for the wrapped keys; login fields as PK11SDR blobs with 3DES or, in newer
// profiles, AES-256-CBC). The decryption was also run once against a real newer
// profile (all 91 logins read), which is not repeatable here. The older
// pbeWithSha1AndTripleDES key wrapping has no fixture: nothing here tests it.
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { decryptLogins, decryptField, fieldKeyId, checkPassword, parseDer } from '../firefoxLogins'

const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]))
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), len(body.length), body])
}
const seq = (...p) => der(0x30, ...p)
const octet = (b) => der(0x04, Buffer.from(b))
const int = (n) => der(0x02, n < 128 ? Buffer.from([n]) : Buffer.from([n >> 8, n & 255]))
const oidOf = (s) => {
  const a = s.split('.').map(Number)
  const out = [a[0] * 40 + a[1]]
  for (const v of a.slice(2)) {
    const bytes = [v & 0x7f]
    for (let x = v >> 7; x; x >>= 7) bytes.unshift((x & 0x7f) | 0x80)
    out.push(...bytes)
  }
  return der(0x06, Buffer.from(out))
}
const OIDS = { pbes2: '1.2.840.113549.1.5.13', pbkdf2: '1.2.840.113549.1.5.12', hmac256: '1.2.840.113549.2.9', aes256: '2.16.840.1.101.3.4.1.42', des3: '1.2.840.113549.3.7' }

// A PBES2-wrapped blob, as key4.db stores item2 and each nssPrivate key.
const wrap = (plain, globalSalt, { autoPad = true } = {}) => {
  const entrySalt = crypto.randomBytes(32)
  const iv14 = crypto.randomBytes(14)
  const iterations = 1
  const k = crypto.createHash('sha1').update(Buffer.concat([globalSalt, Buffer.alloc(0)])).digest()
  const key = crypto.pbkdf2Sync(k, entrySalt, iterations, 32, 'sha256')
  const c = crypto.createCipheriv('aes-256-cbc', key, Buffer.concat([Buffer.from([0x04, 0x0e]), iv14]))
  c.setAutoPadding(autoPad)
  const cipher = Buffer.concat([c.update(plain), c.final()])
  return seq(seq(oidOf(OIDS.pbes2), seq(seq(oidOf(OIDS.pbkdf2), seq(octet(entrySalt), int(iterations), int(32), seq(oidOf(OIDS.hmac256)))), seq(oidOf(OIDS.aes256), octet(iv14)))), octet(cipher))
}

// A PK11SDR field: [ keyId, [ algo, iv ], ciphertext ].
const field = (text, keyId, algo, key) => {
  const iv = crypto.randomBytes(algo === 'aes' ? 16 : 8)
  const c = crypto.createCipheriv(algo === 'aes' ? 'aes-256-cbc' : 'des-ede3-cbc', key, iv)
  const cipher = Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()])
  return seq(octet(keyId), seq(oidOf(algo === 'aes' ? OIDS.aes256 : OIDS.des3), octet(iv)), octet(cipher)).toString('base64')
}

const build = () => {
  const globalSalt = crypto.randomBytes(20)
  const key3 = crypto.randomBytes(24)
  const key3Padded = Buffer.concat([key3, Buffer.alloc(8, 8)]) // 24 + PKCS padding, as NSS stores it
  const keyAes = crypto.randomBytes(32)
  const id3 = Buffer.from('f8000000000000000000000000000001', 'hex')
  const idAes = crypto.randomBytes(16)
  const item2 = wrap(Buffer.from('password-check'), globalSalt)
  const keys = new Map([
    [id3.toString('hex'), wrap(key3Padded, globalSalt, { autoPad: false })],
    [idAes.toString('hex'), wrap(keyAes, globalSalt, { autoPad: false })]
  ])
  return { globalSalt, item2, a11: keys.get(id3.toString('hex')), keys, key3, keyAes, id3, idAes }
}

describe('Firefox logins', () => {
  it('reads the fields of an older profile (3DES) and of a newer one (AES-256), each with its own key', () => {
    const k = build()
    const json = {
      logins: [
        { hostname: 'https://old.example', encryptedUsername: field('ann', k.id3, 'des3', k.key3), encryptedPassword: field('p\u00e4ss-1', k.id3, 'des3', k.key3) },
        { hostname: 'https://new.example', encryptedUsername: field('bob', k.idAes, 'aes', k.keyAes), encryptedPassword: field('pass-2', k.idAes, 'aes', k.keyAes) }
      ]
    }
    const r = decryptLogins(json, k)
    expect(r.skipped).toBe(0)
    expect(r.incoming).toEqual([
      { origin: 'https://old.example', username: 'ann', password: 'p\u00e4ss-1' },
      { origin: 'https://new.example', username: 'bob', password: 'pass-2' }
    ])
  })

  it('a key that does not belong to the field, a damaged or unknown field: skipped, never wrong text', () => {
    const k = build()
    const other = crypto.randomBytes(16)
    const json = {
      logins: [
        { hostname: 'https://a.example', encryptedUsername: '', encryptedPassword: field('x', other, 'aes', k.keyAes) }, // key id not in the store
        { hostname: 'https://b.example', encryptedUsername: '', encryptedPassword: 'not base64 der' },
        { hostname: 'https://c.example', encryptedUsername: '', encryptedPassword: field('ok', k.idAes, 'aes', k.keyAes) },
        { encryptedPassword: field('no host', k.idAes, 'aes', k.keyAes) }
      ]
    }
    const r = decryptLogins(json, k)
    expect(r.incoming).toEqual([{ origin: 'https://c.example', username: '', password: 'ok' }])
    expect(r.skipped).toBe(3)
  })

  it('a Primary Password (the check marker does not open with an empty one): the caller is told, nothing is read', () => {
    const k = build()
    const locked = { ...k, item2: wrap(Buffer.from('something else'), k.globalSalt) }
    expect(() => checkPassword(locked)).toThrowError(expect.objectContaining({ code: 'primary-password' }))
    expect(() => decryptLogins({ logins: [] }, locked)).toThrowError(expect.objectContaining({ code: 'primary-password' }))
  })

  it('field helpers: the key id a field names; garbage gives nothing', () => {
    const k = build()
    const f = field('v', k.idAes, 'aes', k.keyAes)
    expect(fieldKeyId(f)).toBe(k.idAes.toString('hex'))
    expect(fieldKeyId('zzz')).toBe('')
    expect(decryptField(f, k.keyAes)).toBe('v')
    expect(decryptField(f, crypto.randomBytes(32))).toBeNull()
    expect(decryptField(f, null)).toBeNull()
    expect(decryptField('', k.keyAes)).toBeNull()
  })

  it('the DER reader refuses what is cut short or lies about its length', () => {
    expect(() => parseDer(Buffer.from([0x30, 0x10, 0x01]))).toThrow()
    expect(() => parseDer(Buffer.from([0x30]))).toThrow()
    expect(() => parseDer(Buffer.from([0x30, 0x85, 0, 0, 0, 0, 0]))).toThrow()
  })
})
