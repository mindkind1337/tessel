// What each cookie import did, per browser and profile: when, how many went
// in (new, updated, unchanged) and how many were skipped and why. Counts and
// dates only: never a cookie's name, value or domain. Kept in a small JSON
// file of Tessel's userData folder, so the import window can say "Imported on
// <date>" and "Already imported on <date>" later.
import fs from 'fs'
import { dirname } from 'path'

const MAX_ENTRIES = 100

function keyOf(browserId, profileDir) {
  return `${String(browserId || '')}\n${String(profileDir || '')}`
}

const COUNT_FIELDS = ['total', 'imported', 'added', 'updated', 'unchanged', 'skipped']

// A summary -> what is kept of it (numbers only; a missing one stays null).
export function historyEntry(summary, at = Date.now()) {
  const s = summary || {}
  const entry = { at: Number(at) || Date.now() }
  for (const f of COUNT_FIELDS) entry[f] = Number.isFinite(s[f]) ? s[f] : null
  const reasons = {}
  for (const [k, v] of Object.entries(s.reasons || {})) if (/^[a-zA-Z]{1,32}$/.test(k) && Number.isFinite(v) && v > 0) reasons[k] = v
  entry.reasons = reasons
  return entry
}

// file: the JSON's path. Reads lazily, writes through a temp file + rename.
export function createImportHistory(file) {
  let data = null
  function load() {
    if (data) return data
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      data = parsed && typeof parsed === 'object' && parsed.imports && typeof parsed.imports === 'object' ? parsed : { imports: {} }
    } catch {
      data = { imports: {} }
    }
    return data
  }
  function save() {
    try {
      fs.mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1))
      fs.renameSync(tmp, file)
    } catch {
      // the history is a convenience: an import never fails for it
    }
  }
  return {
    get(browserId, profileDir) {
      const e = load().imports[keyOf(browserId, profileDir)]
      return e && typeof e === 'object' && Number.isFinite(e.at) ? e : null
    },
    record(browserId, profileDir, summary, at) {
      const imports = load().imports
      const key = keyOf(browserId, profileDir)
      delete imports[key]
      imports[key] = historyEntry(summary, at)
      // The oldest go first past the cap (insertion order = oldest first).
      const keys = Object.keys(imports)
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete imports[k]
      save()
      return imports[key]
    }
  }
}
