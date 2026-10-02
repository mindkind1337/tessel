// A team member's inbox: <project>/.tessel/team/<token>/. The agent writes
// request files there (see src/shared/leadRequests.js); Tessel takes them
// (reads, then deletes) every few seconds. The token is random per member,
// so only the agent told about the folder writes into it.
import { join, resolve, isAbsolute } from 'path'
import fs from 'fs'

const TOKEN_RE = /^[a-z0-9]{16,48}$/
const MAX_FILES = 20
const MAX_BYTES = 64 * 1024

function inboxPath({ dir, token } = {}) {
  if (typeof dir !== 'string' || !dir || !isAbsolute(dir) || !fs.existsSync(dir)) return null
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null
  return join(resolve(dir), '.tessel', 'team', token)
}

// Make the folder (with a HOW-TO.md) and return its path.
export function ensureInbox({ dir, token, guide } = {}) {
  const path = inboxPath({ dir, token })
  if (!path) return { ok: false, error: 'No project folder for the lead inbox.' }
  fs.mkdirSync(path, { recursive: true })
  if (typeof guide === 'string' && guide) fs.writeFileSync(join(path, 'HOW-TO.md'), guide.slice(0, 20000))
  return { ok: true, path }
}

// Read and delete the waiting .json requests, oldest first.
// -> { ok, items: [{ file, data } | { file, error }] }
export function takeInbox({ dir, token } = {}) {
  const path = inboxPath({ dir, token })
  if (!path) return { ok: false, error: 'bad inbox' }
  if (!fs.existsSync(path)) return { ok: true, items: [], missing: true }
  const names = fs
    .readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.json'))
    .map((d) => {
      const file = join(path, d.name)
      let t = 0
      try {
        t = fs.statSync(file).mtimeMs
      } catch {
        // gone meanwhile
      }
      return { name: d.name, file, t }
    })
    .sort((a, b) => a.t - b.t || a.name.localeCompare(b.name))
    .slice(0, MAX_FILES)
  const items = []
  for (const n of names) {
    let item
    try {
      const size = fs.statSync(n.file).size
      // A file still being written (empty): leave it for the next round.
      if (size === 0 && Date.now() - n.t < 5000) continue
      if (size > MAX_BYTES) item = { file: n.name, error: 'file too large' }
      else {
        const text = fs.readFileSync(n.file, 'utf8').replace(/^﻿/, '')
        try {
          item = { file: n.name, data: JSON.parse(text) }
        } catch (err) {
          // Half-written JSON: try again next round, for a few seconds.
          if (Date.now() - n.t < 5000) continue
          item = { file: n.name, error: `not valid JSON (${err.message})` }
        }
      }
    } catch (err) {
      item = { file: n.name, error: err.message }
    }
    try {
      fs.rmSync(n.file, { force: true })
    } catch {
      // Locked by the writer: it will be read again, which is harmless only
      // if we skip it now.
      continue
    }
    items.push(item)
  }
  return { ok: true, items }
}

// The member left the team: remove its inbox.
export function removeInbox({ dir, token } = {}) {
  const path = inboxPath({ dir, token })
  if (path && fs.existsSync(path)) fs.rmSync(path, { recursive: true, force: true })
  return { ok: true }
}
