// Live Share across a restart of Tessel: what a share (the host's) or a
// joined session (a guest's) needs to carry on, kept in a file of Tessel's
// data folder while it runs, written again every minute. The next Tessel
// takes it back if it is recent enough (maxAgeMs: RESUME_MS unless said; a
// share is kept with no age, a joined session for as long as its host keeps
// the guest: liveShare.js): a restart, an update, a crash, a reboot. Stop
// sharing or Leave deletes it. It holds the
// invitations' secrets and a guest's reconnect key, like the other sign-ins
// in that folder. What lasts longer (the host's trusted people, a guest's
// identity key) is in files of its own (createKeptFile): no age, written
// whole each time. Every one of them is written for this user only (0600, its
// folder 0700, as Tessel's other secret stores; Windows keeps the data
// folder's own access rights).
import fs from 'fs'
import { dirname } from 'path'

export const RESUME_MS = 10 * 60 * 1000

function writeWhole(path, data) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  // A temporary file left by a crash goes first: the new one is made for
  // this user only.
  fs.rmSync(tmp, { force: true })
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, path)
}

// A file kept until it is replaced: { v: 1, ...data }. read() says whether
// it is there: { status: 'ok', data }, { status: 'missing' } (none yet), or
// { status: 'unreadable' } (there, but it can't be read: whoever reads it
// must not replace it, so nothing in it is lost by a passing error).
export function createKeptFile(path) {
  return {
    read() {
      let text
      try {
        text = fs.readFileSync(path, 'utf8')
      } catch (err) {
        return { status: err && err.code === 'ENOENT' ? 'missing' : 'unreadable' }
      }
      try {
        const saved = JSON.parse(text)
        return saved && typeof saved === 'object' && saved.v === 1 ? { status: 'ok', data: saved } : { status: 'unreadable' }
      } catch {
        return { status: 'unreadable' }
      }
    },
    write(data) {
      try {
        writeWhole(path, { ...data, v: 1 })
        return true
      } catch {
        return false
      }
    }
  }
}

export function createSessionFile(path, { now = Date.now, maxAgeMs = RESUME_MS } = {}) {
  return {
    // The saved session, or null (none, unreadable, or too old: then the
    // file goes, with the secrets it holds).
    read() {
      let saved
      try {
        saved = JSON.parse(fs.readFileSync(path, 'utf8'))
      } catch {
        saved = null
      }
      const age = saved && saved.v === 1 && Number.isFinite(saved.savedAt) ? now() - saved.savedAt : null
      // (Kept with no age: whatever the clock says, even one set back.)
      if (age !== null && (maxAgeMs === Infinity || (age >= 0 && age < maxAgeMs))) return saved
      this.clear()
      return null
    },
    write(data) {
      try {
        writeWhole(path, { ...data, v: 1, savedAt: now() })
      } catch {
        /* only taking the session back after a restart is lost */
      }
    },
    clear() {
      for (const file of [path, `${path}.tmp`]) {
        try {
          fs.rmSync(file, { force: true })
        } catch {
          /* already gone */
        }
      }
    },
    // Deleted only if what it holds is still what keep(saved) expects (a new
    // session may have saved its own meanwhile).
    clearIf(keep) {
      let saved
      try {
        saved = JSON.parse(fs.readFileSync(path, 'utf8'))
      } catch {
        saved = null
      }
      if (!saved || keep(saved)) this.clear()
    }
  }
}
