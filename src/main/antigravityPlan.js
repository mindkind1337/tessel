// Antigravity's plan (Google AI Pro, Ultra...), which `agy /usage` does not
// say. The Antigravity app keeps the signed-in account's status on this
// computer: its state.vscdb, key antigravityUnifiedStateSync.userStatus,
// base64 of a protobuf holding, base64 again, the account (its email) and
// its tier ({ 1: "g1-pro-tier", 2: "Google AI Pro", 3: "Google AI Pro", ...}).
// Read only, nothing sent anywhere. The plan counts only for the account the
// Antigravity CLI is signed in to (the email its log names), when it says.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KEY = 'antigravityUnifiedStateSync.userStatus'
// The app's folders, newest first ("Antigravity" before it was renamed).
const APPS = ['Antigravity IDE', 'Antigravity']
const MAX_VALUE = 1024 * 1024
const LOG_TAIL = 256 * 1024
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/
// The app writes the plan when it runs: one it has not written for a week
// may be a plan since changed (an Ultra shown long after it ended), so it is
// not shown.
export const PLAN_MAX_AGE = 7 * 24 * 60 * 60 * 1000

function varint(buf, i) {
  let value = 0
  let scale = 1
  for (let n = 0; n < 10; n++) {
    if (i >= buf.length) return null
    const byte = buf[i++]
    value += (byte & 0x7f) * scale
    if (!(byte & 0x80)) return [value, i]
    scale *= 128
  }
  return null
}

// A protobuf message -> [{ field, bytes }] of its length-delimited fields, or
// null when the bytes are not one (a string, most often).
function fields(buf) {
  const out = []
  let i = 0
  while (i < buf.length) {
    const key = varint(buf, i)
    if (!key) return null
    const [tag, next] = key
    const field = Math.floor(tag / 8)
    const wire = tag % 8
    if (field < 1) return null
    i = next
    if (wire === 0) {
      const v = varint(buf, i)
      if (!v) return null
      i = v[1]
    } else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else if (wire === 2) {
      const len = varint(buf, i)
      if (!len || len[1] + len[0] > buf.length) return null
      out.push({ field, bytes: buf.subarray(len[1], len[1] + len[0]) })
      i = len[1] + len[0]
    } else return null
  }
  return i === buf.length ? out : null
}

const printable = (buf) => buf.length > 0 && !/[^\x20-\x7e]/.test(buf.toString('latin1'))

// The tier and the account's email anywhere in this message (a base64 string
// is opened as the message it holds). -> { tier, plan, email }
export function findAntigravityTier(buf, depth = 0, found = {}) {
  const list = depth < 12 ? fields(buf) : null
  if (!list) return found
  const strings = new Map()
  for (const { field, bytes } of list) if (printable(bytes)) strings.set(field, bytes.toString('utf8'))
  const id = strings.get(1)
  if (!found.tier && id && /^[a-z0-9-]{1,40}-tier$/.test(id)) {
    const name = (strings.get(3) || strings.get(2) || '').trim()
    if (name && name.length <= 60) Object.assign(found, { tier: id, plan: name })
  }
  for (const { bytes } of list) {
    const text = printable(bytes) ? bytes.toString('latin1') : null
    if (text && !found.email && EMAIL.test(text)) found.email = text
    if (text && text.length >= 16 && /^[A-Za-z0-9+/]+={0,2}$/.test(text)) findAntigravityTier(Buffer.from(text, 'base64'), depth + 1, found)
    else if (!text) findAntigravityTier(bytes, depth + 1, found)
  }
  return found
}

// The stored value (base64 text) -> { tier, plan, email } | null.
export function parseAntigravityUserStatus(value) {
  const text = typeof value === 'string' ? value : value ? Buffer.from(value).toString('utf8') : ''
  if (!text || text.length > MAX_VALUE) return null
  const found = findAntigravityTier(Buffer.from(text.trim(), 'base64'))
  return found.tier ? found : null
}

// "Google AI Pro" -> "Pro", like the other providers' plans.
export function shortPlan(name) {
  const short = String(name || '').replace(/^Google\s+AI\s+/i, '').trim()
  return short || null
}

// The email the Antigravity CLI last said it is signed in as (its cli.log).
export function agyAccountEmail({ home = os.homedir(), read = readTail } = {}) {
  const text = read(path.join(home, '.gemini', 'antigravity-cli', 'cli.log'))
  if (!text) return null
  const all = [...text.matchAll(/authenticated successfully as (\S+)/g)]
  const email = all.length ? all[all.length - 1][1] : null
  return email && EMAIL.test(email) ? email : null
}

function readTail(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, LOG_TAIL)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function readStatus(file) {
  const sqlite = process.getBuiltinModule ? process.getBuiltinModule('node:sqlite') : null
  if (!sqlite) return null
  let db
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250;')
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(KEY)
    return row ? row.value : null
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* closed */
    }
  }
}

// -> { read() -> "Pro" | null }. The app folder written last wins.
export function createAntigravityPlan({
  appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  home = os.homedir(),
  status = readStatus,
  email = () => agyAccountEmail({ home }),
  mtime = (file) => fs.statSync(file).mtimeMs,
  now = Date.now
} = {}) {
  function read() {
    const files = APPS.map((name) => path.join(appData, name, 'User', 'globalStorage', 'state.vscdb'))
      .map((file) => {
        try {
          return { file, at: mtime(file) }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .filter((f) => now() - f.at <= PLAN_MAX_AGE)
      .sort((a, b) => b.at - a.at)
    let cli
    try {
      cli = email()
    } catch {
      cli = null
    }
    for (const { file } of files) {
      const found = parseAntigravityUserStatus(status(file))
      if (!found) continue
      // Another Google account than the CLI's: its plan is not this one's.
      if (cli && found.email && found.email.toLowerCase() !== cli.toLowerCase()) continue
      return shortPlan(found.plan)
    }
    return null
  }
  return { read }
}
