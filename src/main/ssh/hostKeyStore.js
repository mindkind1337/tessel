// Tessel's own record of the SSH host keys the user accepted, consulted with
// the user's known_hosts (which Tessel reads but never writes). Ported from
// Orca (MIT, Copyright (c) 2026 Lovecast Inc.: src/main/ssh/
// ssh-host-key-store.ts).
//
// One JSON file in Tessel's user data folder:
//   { version: 1, hostKeys: [{ host, port, keyType, key (base64), fingerprint, acceptedAt }] }
// Records are checked on every read (the key's own type header must match,
// the fingerprint must be the key's): a hand-edited or corrupt record is
// dropped, never shown or trusted. Writes go to a temporary file renamed over
// the store, so a crash never leaves half a trust list. A file this version
// cannot read (newer version, unreadable) is left alone: nothing is trusted
// from it and nothing is written over it.
import fs from 'fs'
import { dirname } from 'path'
import { readHostKeyType, hostKeyFingerprint } from './knownHosts'

export const STORE_FILE_NAME = 'ssh-host-keys.json'
const STORE_VERSION = 1
const MAX_RECORDS = 2000
const MAX_STORE_BYTES = 4 * 1024 * 1024

const normalizeHost = (host) => String(host).trim().toLowerCase()
const isValidPort = (port) => Number.isInteger(port) && port > 0 && port <= 65535

function decodeStoredKey(record) {
  const key = Buffer.from(record.key, 'base64')
  if (key.length === 0 || key.toString('base64').replace(/=+$/, '') !== record.key.replace(/=+$/, '')) return undefined
  return readHostKeyType(key) === record.keyType ? key : undefined
}

function validateRecord(c) {
  if (!c || typeof c !== 'object') return undefined
  const { host, port, keyType, key, fingerprint, acceptedAt } = c
  if (typeof host !== 'string' || !host || host.length > 512 || !isValidPort(port)) return undefined
  if (typeof keyType !== 'string' || !keyType || typeof key !== 'string' || typeof fingerprint !== 'string' || typeof acceptedAt !== 'string') return undefined
  const record = { host: normalizeHost(host), port, keyType, key, fingerprint, acceptedAt }
  const decoded = decodeStoredKey(record)
  return decoded && hostKeyFingerprint(decoded) === fingerprint ? record : undefined
}

// file: the store's path. log(level, msg): never given a secret (there is
// none here: host keys are public).
export function createHostKeyStore({ file, fsApi = fs, log = () => {}, now = () => new Date() } = {}) {
  if (!file) throw new Error('host key store without a file') // i18n-ignore internal: programming error

  // -> { status: 'ok', records } | { status: 'absent' } | { status: 'withheld' }
  function read() {
    let text
    try {
      const st = fsApi.statSync(file)
      if (st.size > MAX_STORE_BYTES) {
        log('warn', 'ssh host key store too large: not read')
        return { status: 'withheld' }
      }
      text = fsApi.readFileSync(file, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return { status: 'absent' }
      log('warn', `ssh host key store unreadable (${err && err.code ? err.code : 'error'})`)
      return { status: 'withheld' }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      // Unrecoverable by any version: treated as empty (a rewrite loses nothing).
      log('warn', 'ssh host key store is not valid JSON: treated as empty')
      return { status: 'ok', records: [] }
    }
    const version = parsed && parsed.version
    if (typeof version === 'number' && version > STORE_VERSION) {
      log('warn', `ssh host key store version ${version} is newer: left alone`)
      return { status: 'withheld' }
    }
    const list = parsed && Array.isArray(parsed.hostKeys) ? parsed.hostKeys : []
    const records = []
    for (const c of list.slice(0, MAX_RECORDS)) {
      const r = validateRecord(c)
      if (r) records.push(r)
    }
    return { status: 'ok', records }
  }

  function records() {
    const s = read()
    return s.status === 'ok' ? s.records : []
  }

  // -> 'match' | 'mismatch' | 'unknown-type-known-host' | 'unknown'
  function match(list, { host, port, keyType, key }) {
    const h = normalizeHost(host)
    let sawSameType = false
    let sawOtherType = false
    for (const r of list) {
      if (r.host !== h || r.port !== port) continue
      if (r.keyType !== keyType) {
        sawOtherType = true
        continue
      }
      const stored = decodeStoredKey(r)
      if (stored && stored.equals(key)) return 'match'
      sawSameType = true
    }
    if (sawSameType) return 'mismatch'
    return sawOtherType ? 'unknown-type-known-host' : 'unknown'
  }

  function storedKeyTypes(list, host, port) {
    const h = normalizeHost(host)
    return list.filter((r) => r.host === h && r.port === port).map((r) => r.keyType)
  }

  // Remember an accepted key (replaces an earlier one of the same host, port
  // and type). -> true when written.
  function trust({ host, port, keyType, key }) {
    const snap = read()
    if (snap.status === 'withheld') return false
    const record = {
      host: normalizeHost(host),
      port,
      keyType,
      key: key.toString('base64'),
      fingerprint: hostKeyFingerprint(key),
      acceptedAt: now().toISOString()
    }
    const kept = (snap.status === 'ok' ? snap.records : []).filter((r) => r.host !== record.host || r.port !== record.port || r.keyType !== record.keyType)
    const next = [...kept, record].slice(-MAX_RECORDS)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      fsApi.mkdirSync(dirname(file), { recursive: true })
      fsApi.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, hostKeys: next }, null, 2), { mode: 0o600 })
      fsApi.renameSync(tmp, file)
    } catch (err) {
      try {
        fsApi.rmSync(tmp, { force: true })
      } catch {
        /* nothing left */
      }
      log('warn', `ssh host key not recorded (${err && err.code ? err.code : 'error'})`)
      return false
    }
    log('info', `ssh host key trusted for ${record.host}:${record.port} (${record.keyType} ${record.fingerprint})`)
    return true
  }

  return { file, read, records, match, storedKeyTypes, trust }
}
