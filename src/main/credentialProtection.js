// How a credential Tessel saved sits on disk, for a warning in Settings where
// it is managed. After Orca's secret-at-rest-protection.ts and
// credential-file-protection.ts (MIT, Copyright (c) 2026 Lovecast Inc.).
//
// Read from the stored bytes, not from whether encryption works now: a file
// written readable stays readable until it is saved again. Never decrypted
// (opening Settings must not ask the OS for a key), and no value is returned.
import fs from 'fs'

const MAX_FILE = 256 * 1024
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

// Can safeStorage seal a credential here? Not without it, nor with Linux's
// "basic_text" backend (a fixed key: the same as readable).
export function secureStorageAvailable(safeStorage) {
  try {
    return !!safeStorage?.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
  } catch {
    return false
  }
}

// A credential file written as { v: 1, ciphertext } (provider keys, Linear):
// 'sealed' for that envelope, 'plaintext' for any other readable JSON record
// (a value anyone who reads the file can use), null when nothing is stored or
// it cannot be told (a link, too big, unreadable, not JSON).
export function envelopeProtection(file) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > MAX_FILE) return null
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.v === 1 && typeof raw.ciphertext === 'string' && BASE64.test(raw.ciphertext)) return 'sealed'
  return Object.keys(raw).length ? 'plaintext' : null
}
