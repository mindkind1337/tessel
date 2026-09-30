// Background team information written by Tessel (the only writer), read by
// the team tools (teamMcp/server.cjs) — never typed into a terminal:
//   <project>/.tessel/team-channel/current.json   who is in which team now
//   <project>/.tessel/team-channel/<team>/notices.json   Tessel's own notices
//     to an agent (team changes, answers to a lead), read once like messages
import fs from 'fs'
import { createHash, randomBytes } from 'crypto'
import { join, resolve, isAbsolute } from 'path'
import { ensureTeamChannel } from './teamChannel'
import { readJson } from './fileRead'
import { writeFileAtomic } from './safeJson'

const writeAtomic = (file, data) => writeFileAtomic(file, JSON.stringify(data, null, 2))

const ID_RE = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/
const NOTICE_ID_RE = /^[a-z0-9]{6,40}$/
const MAX_NOTICES = 500

function base(dir) {
  if (typeof dir !== 'string' || !isAbsolute(dir) || !fs.existsSync(dir)) return null
  return join(resolve(dir), '.tessel', 'team-channel')
}

// Two Tessel windows (say the installed app and the dev build) can have teams
// in the same project. Nothing is shared for writing, so no window's update
// can be lost:
//   current.<owner>.json   written only by that window:
//                          { owner, at, panes: { <paneId>: { team, num } },
//                            teams: [the teams it made] }
//   current.json           the merged view (panes of every window seen in the
//                          last 5 minutes), rewritten by any window when it
//                          differs; read by team tools of an older version.
// A window rewrites its own file when it changes, and every minute anyway to
// show it still runs. It retires only teams it made (a team of unknown
// origin only when no other window runs).
const OWNER_GONE_MS = 5 * 60 * 1000
// Another window's teams are never retired while its file is younger than
// this (a window can stop writing for a while: paused in a debugger, asleep).
const OWNER_TEAMS_KEPT_MS = 6 * 60 * 60 * 1000
// A retired team's folder (nobody active, not used by any window) is deleted
// once untouched for this long.
const RETIRED_FOLDER_KEPT_MS = 7 * 24 * 60 * 60 * 1000
const OWNER_TOUCH_MS = 60 * 1000
const OWNER_RE = /^[A-Za-z0-9_-]{1,40}$/

function ownerFile(b, owner) {
  return join(b, `current.${owner}.json`)
}

// The files of the windows seen in the last 5 minutes (or `maxAge`), not
// `except`.
function liveOwners(b, except = null, now = Date.now(), maxAge = OWNER_GONE_MS) {
  const out = []
  let names = []
  try {
    names = fs.readdirSync(b)
  } catch {
    return out
  }
  for (const n of names) {
    const m = /^current\.([A-Za-z0-9_-]{1,40})\.json$/.exec(n)
    if (!m || m[1] === except) continue
    const data = readJson(join(b, n))
    if (data && typeof data.at === 'number' && now - data.at <= maxAge && data.panes) out.push(data)
  }
  return out
}

function writeOwn(b, owner, own) {
  writeAtomic(ownerFile(b, owner), { version: 1, owner, at: Date.now(), panes: own.panes, teams: own.teams })
}

// The merged view for older team tools, rewritten only when it differs.
function writeMerged(b) {
  const panes = {}
  for (const o of liveOwners(b)) {
    for (const [id, p] of Object.entries(o.panes)) {
      if (p && ID_RE.test(id) && ID_RE.test(String(p.team))) panes[id] = { team: p.team, num: p.num, paneName: p.paneName, owner: o.owner }
    }
  }
  const file = join(b, 'current.json')
  const old = readJson(file)
  if (old && JSON.stringify(old.panes) === JSON.stringify(panes)) return false
  writeAtomic(file, { version: 1, panes })
  return true
}

function hasActive(b, teamId) {
  const state = readJson(join(b, teamId, 'state.json'))
  return !!(state && state.members && Object.values(state.members).some((m) => m.active))
}

// panes: { <paneId>: { team, num } } for the teams of this project now;
// owner: this Tessel window (set by the main process; without it, the map is
// written as it is, for a single window).
// -> { ok, changed, lost: [teamId] } — lost: teams of this window found with
// no active member (retired by a window that did not know about them yet):
// the caller sets them up again.
export function writeCurrentTeams({ dir, panes, owner } = {}) {
  const b = base(dir)
  if (!b || !panes || typeof panes !== 'object') return { ok: false, error: 'Invalid team location.' }
  if (owner != null && !OWNER_RE.test(String(owner))) return { ok: false, error: 'Invalid team location.' }
  const clean = {}
  for (const [id, p] of Object.entries(panes)) {
    if (ID_RE.test(id) && p && ID_RE.test(String(p.team)) && Number.isInteger(p.num)) clean[id] = { team: p.team, num: p.num, paneName: p.paneName }
  }
  // A project that never had a team gets no folder just for an empty map.
  if (!Object.keys(clean).length && !fs.existsSync(b)) return { ok: true, changed: false, lost: [] }
  fs.mkdirSync(b, { recursive: true })
  if (!owner) {
    const file = join(b, 'current.json')
    const old = readJson(file)
    if (old && JSON.stringify(old.panes) === JSON.stringify(clean)) return { ok: true, changed: false, lost: [] }
    writeAtomic(file, { version: 1, panes: clean })
    return { ok: true, changed: true, lost: [] }
  }
  const old = readJson(ownerFile(b, owner))
  const teams = new Set(Array.isArray(old && old.teams) ? old.teams.filter((t) => ID_RE.test(String(t))) : [])
  for (const p of Object.values(clean)) teams.add(p.team)
  const own = { panes: clean, teams: [...teams].sort() }
  const same =
    old && JSON.stringify(old.panes) === JSON.stringify(own.panes) && JSON.stringify(old.teams) === JSON.stringify(own.teams)
  if (!same || !(Date.now() - (old.at || 0) < OWNER_TOUCH_MS)) writeOwn(b, owner, own)
  const merged = writeMerged(b)
  const lost = [...new Set(Object.values(clean).map((p) => p.team))].filter(
    (t) => fs.existsSync(join(b, t, 'state.json')) && !hasActive(b, t)
  )
  return { ok: true, changed: !same || merged, lost }
}

// Teams of this project that do not exist any more: their members are made
// inactive, so nothing is read or sent there again. Only this window's own
// teams (or of unknown origin when no other window runs).
export function retireOldTeams({ dir, liveTeamIds, owner } = {}) {
  const b = base(dir)
  if (!b || !Array.isArray(liveTeamIds)) return { ok: false, error: 'Invalid team location.' }
  if (owner != null && !OWNER_RE.test(String(owner))) return { ok: false, error: 'Invalid team location.' }
  if (!fs.existsSync(b)) return { ok: true, retired: [] }
  const live = new Set(liveTeamIds)
  const others = owner ? liveOwners(b, owner) : []
  const theirs = new Set()
  for (const o of owner ? liveOwners(b, owner, Date.now(), OWNER_TEAMS_KEPT_MS) : []) {
    for (const p of Object.values(o.panes)) if (p) theirs.add(p.team)
    for (const t of Array.isArray(o.teams) ? o.teams : []) theirs.add(t)
  }
  const mineFile = owner ? readJson(ownerFile(b, owner)) : null
  const mine = new Set(Array.isArray(mineFile && mineFile.teams) ? mineFile.teams : [])
  // Teams this window has now are its own.
  for (const t of liveTeamIds) if (ID_RE.test(String(t))) mine.add(t)
  const retired = []
  for (const t of fs.readdirSync(b)) {
    if (!ID_RE.test(t) || live.has(t) || theirs.has(t) || !fs.existsSync(join(b, t, 'state.json'))) continue
    if (owner && !mine.has(t) && others.length) continue // unknown origin, another window runs
    if (!hasActive(b, t)) {
      // Retired long ago and used by nobody: its folder goes.
      try {
        if (Date.now() - fs.statSync(join(b, t, 'state.json')).mtimeMs > RETIRED_FOLDER_KEPT_MS)
          fs.rmSync(join(b, t), { recursive: true, force: true })
      } catch {
        // tried again next time
      }
      continue
    }
    const res = ensureTeamChannel({ dir, teamId: t, members: [] })
    if (res.ok) retired.push(t)
  }
  if (owner && mineFile) {
    const teams = [...mine].filter((t) => !retired.includes(t)).sort()
    if (JSON.stringify(teams) !== JSON.stringify(mineFile.teams)) writeOwn(b, owner, { panes: mineFile.panes || {}, teams })
  }
  return { ok: true, retired }
}

// Notices from Tessel to agents of a team: [{ toId, text }].
function readNotices(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { notices: [] }
    throw err
  }
  const data = JSON.parse(text)
  if (!data || !Array.isArray(data.notices)) throw new Error('Invalid team notices file.')
  if (data.accepted != null && (!Array.isArray(data.accepted) || data.accepted.some(
    n => !n || !NOTICE_ID_RE.test(n.id) || !/^[a-f0-9]{64}$/.test(n.hash)
  ))) throw new Error('Invalid team notice ledger.')
  return data
}

const noticeHash = n => createHash('sha256').update(JSON.stringify([n.toId, n.text])).digest('hex')
function noticeLedger(data) {
  const accepted = new Map((data.accepted || []).map(n => [n.id, n.hash]))
  for (const n of data.notices) accepted.set(n.id, noticeHash(n))
  return accepted
}
function noticeState(data, notices, accepted = noticeLedger(data)) {
  return {
    ...data,
    notices,
    // Keep ids after removal too: a lost IPC response may be retried after
    // the agent already read the notice. The ledger lives with this team,
    // and is removed when the retired team's folder is cleaned up.
    accepted: [...accepted].map(([id, hash]) => ({ id, hash }))
  }
}

export function addNotices({ dir, teamId, notices } = {}) {
  const b = base(dir)
  if (!b || typeof teamId !== 'string' || !ID_RE.test(teamId) || !Array.isArray(notices))
    return { ok: false, error: 'Invalid team location.' }
  const root = join(b, teamId)
  fs.mkdirSync(root, { recursive: true })
  const file = join(root, 'notices.json')
  const data = readNotices(file)
  const list = [...data.notices]
  const accepted = noticeLedger(data)
  for (const n of notices) {
    if (!n || !ID_RE.test(String(n.toId)) || typeof n.text !== 'string' || !n.text.trim()) continue
    if (n.id != null && (typeof n.id !== 'string' || !NOTICE_ID_RE.test(n.id)))
      return { ok: false, error: 'Invalid notice id.' }
    const item = {
      id: n.id ?? randomBytes(16).toString('hex'),
      toId: n.toId,
      text: n.text.slice(0, 6000),
      at: Date.now()
    }
    const hash = noticeHash(item)
    if (accepted.has(item.id)) {
      if (accepted.get(item.id) !== hash)
        return { ok: false, error: 'Notice id already used for different content.' }
      continue
    }
    if (list.length >= MAX_NOTICES)
      return { ok: false, error: 'Team notice queue is full; retry after notices are read.' }
    accepted.set(item.id, hash)
    list.push(item)
  }
  // Publish the complete batch and its deduplication ledger together.
  writeAtomic(file, noticeState(data, list, accepted))
  return { ok: true }
}

// A notice the agent read (ack "n-<id>"): removed.
export function removeNotice({ dir, teamId, id } = {}) {
  const b = base(dir)
  if (!b || !ID_RE.test(String(teamId))) return false
  const file = join(b, teamId, 'notices.json')
  try {
    const data = readNotices(file)
    const next = data.notices.filter((n) => n.id !== id)
    if (next.length !== data.notices.length) writeAtomic(file, noticeState(data, next))
    return true
  } catch {
    // Keep the acknowledgement queued until removal really succeeds.
    return false
  }
}
