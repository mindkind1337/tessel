// Background team information written by Tessel (the only writer), read by
// the team tools (teamMcp/server.cjs) — never typed into a terminal:
//   <project>/.tessel/team-channel/current.json   who is in which team now
//   <project>/.tessel/team-channel/<team>/notices.json   Tessel's own notices
//     to an agent (team changes, answers to a lead), read once like messages
import fs from 'fs'
import { join, resolve, isAbsolute } from 'path'
import { ensureTeamChannel } from './channel.mjs'

const ID_RE = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/
const MAX_NOTICES = 500

function base(dir) {
  if (typeof dir !== 'string' || !isAbsolute(dir) || !fs.existsSync(dir)) return null
  return join(resolve(dir), '.tessel', 'team-channel')
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Two Tessel windows (say the installed app and the dev build) can have teams
// in the same project. current.json is shared:
//   panes:  { <paneId>: { team, num, owner } }   who is in which team now
//   owners: { <owner>: <last write> }           windows still running
//   teams:  { <teamId>: <owner> }               which window made each team
// Each window writes only its own panes and keeps the others', as long as
// that window wrote in the last 5 minutes. A window retires only its own
// teams (a team of unknown origin only when no other window runs). Every
// read-modify-write of current.json, and retiring, happens under a lock file
// shared by the processes, so no window's update is lost.
const OWNER_GONE_MS = 5 * 60 * 1000
const OWNER_TOUCH_MS = 60 * 1000
const LOCK_STALE_MS = 10000
const LOCK_WAIT_MS = 3000

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Run fn() holding <base>/current.lock (made with exclusive create). A lock
// left by a crashed process is taken over after 10 s.
function withLock(b, fn) {
  const lock = join(b, 'current.lock')
  const until = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock)
    } catch {
      // released meanwhile
    }
    if (Date.now() > until) throw new Error('The team folder is busy (another Tessel window is writing it).')
    sleepSync(15)
  }
  try {
    return fn()
  } finally {
    try {
      fs.unlinkSync(lock)
    } catch {
      // already gone
    }
  }
}

function fresh(current, o, now) {
  const at = current && current.owners && current.owners[o]
  return typeof at === 'number' && now - at <= OWNER_GONE_MS
}

// Pane entries of the other, still running, Tessel windows.
function otherPanes(current, owner, now = Date.now()) {
  const out = {}
  if (!owner || !current || !current.panes) return out
  for (const [id, p] of Object.entries(current.panes)) {
    if (p && p.owner && p.owner !== owner && fresh(current, p.owner, now)) out[id] = p
  }
  return out
}

// panes: { <paneId>: { team, num } } for the teams of this project now;
// owner: this Tessel window (set by the main process).
// -> { ok, changed, lost: [teamId] } — lost: teams of this window found with
// no active member (retired by a window that did not know about them yet):
// the caller sets them up again.
export function writeCurrentTeams({ dir, panes, owner } = {}) {
  const b = base(dir)
  if (!b || !panes || typeof panes !== 'object') return { ok: false, error: 'Invalid team location.' }
  const clean = {}
  for (const [id, p] of Object.entries(panes)) {
    if (ID_RE.test(id) && p && ID_RE.test(String(p.team)) && Number.isInteger(p.num)) clean[id] = { team: p.team, num: p.num }
  }
  // A project that never had a team gets no folder just for an empty map.
  if (!Object.keys(clean).length && !fs.existsSync(b)) return { ok: true, changed: false, lost: [] }
  fs.mkdirSync(b, { recursive: true })
  const file = join(b, 'current.json')
  return withLock(b, () => {
    const old = readJson(file)
    const now = Date.now()
    const merged = otherPanes(old, owner, now)
    for (const [id, p] of Object.entries(clean)) merged[id] = owner ? { ...p, owner } : p
    const owners = {}
    for (const [o, at] of Object.entries((old && old.owners) || {})) {
      if (typeof at === 'number' && now - at <= OWNER_GONE_MS) owners[o] = at
    }
    const teams = {}
    for (const [t, o] of Object.entries((old && old.teams) || {})) {
      if (typeof o === 'string' && (o === owner || owners[o])) teams[t] = o
    }
    const lost = []
    if (owner) {
      for (const p of Object.values(clean)) {
        teams[p.team] = owner
        const state = readJson(join(b, p.team, 'state.json'))
        if (state && state.members && !Object.values(state.members).some((m) => m.active) && !lost.includes(p.team))
          lost.push(p.team)
      }
    }
    const same =
      old &&
      JSON.stringify(old.panes) === JSON.stringify(merged) &&
      JSON.stringify(old.teams || {}) === JSON.stringify(owner ? teams : old.teams || {})
    // Unchanged: rewritten only now and then, to show this window still runs.
    if (same && (!owner || now - (owners[owner] || 0) < OWNER_TOUCH_MS)) return { ok: true, changed: false, lost }
    if (owner) owners[owner] = now
    writeAtomic(file, owner ? { version: 1, panes: merged, owners, teams } : { version: 1, panes: merged })
    return { ok: true, changed: !same, lost }
  })
}

// Teams of this project that do not exist any more: their members are made
// inactive, so nothing is read or sent there again. Only this window's own
// teams (or of unknown origin when no other window runs).
export function retireOldTeams({ dir, liveTeamIds, owner } = {}) {
  const b = base(dir)
  if (!b || !Array.isArray(liveTeamIds)) return { ok: false, error: 'Invalid team location.' }
  if (!fs.existsSync(b)) return { ok: true, retired: [] }
  return withLock(b, () => {
    const file = join(b, 'current.json')
    const current = readJson(file)
    const now = Date.now()
    const live = new Set(liveTeamIds)
    for (const p of Object.values(otherPanes(current, owner, now))) live.add(p.team)
    const teams = (current && current.teams) || {}
    const othersRun =
      !!owner && Object.keys((current && current.owners) || {}).some((o) => o !== owner && fresh(current, o, now))
    const retired = []
    for (const t of fs.readdirSync(b)) {
      if (!ID_RE.test(t) || live.has(t) || !fs.existsSync(join(b, t, 'state.json'))) continue
      const maker = teams[t]
      if (owner && maker && maker !== owner && fresh(current, maker, now)) continue
      if (owner && !maker && othersRun) continue
      const state = readJson(join(b, t, 'state.json'))
      if (!state || !state.members || !Object.values(state.members).some((m) => m.active)) continue
      const res = ensureTeamChannel({ dir, teamId: t, members: [] })
      if (res.ok) retired.push(t)
    }
    if (current && current.teams && retired.some((t) => t in current.teams)) {
      for (const t of retired) delete current.teams[t]
      writeAtomic(file, current)
    }
    return { ok: true, retired }
  })
}

// Notices from Tessel to agents of a team: [{ toId, text }].
export function addNotices({ dir, teamId, notices } = {}) {
  const b = base(dir)
  if (!b || typeof teamId !== 'string' || !ID_RE.test(teamId) || !Array.isArray(notices))
    return { ok: false, error: 'Invalid team location.' }
  const root = join(b, teamId)
  fs.mkdirSync(root, { recursive: true })
  const file = join(root, 'notices.json')
  const data = readJson(file) || { notices: [] }
  const list = Array.isArray(data.notices) ? data.notices : []
  for (const n of notices) {
    if (!n || !ID_RE.test(String(n.toId)) || typeof n.text !== 'string' || !n.text.trim()) continue
    list.push({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      toId: n.toId,
      text: n.text.slice(0, 6000),
      at: Date.now()
    })
  }
  writeAtomic(file, { notices: list.slice(-MAX_NOTICES) })
  return { ok: true }
}

// A notice the agent read (ack "n-<id>"): removed.
export function removeNotice({ dir, teamId, id } = {}) {
  const b = base(dir)
  if (!b || !ID_RE.test(String(teamId))) return false
  const file = join(b, teamId, 'notices.json')
  const data = readJson(file)
  if (!data || !Array.isArray(data.notices)) return true
  const next = data.notices.filter((n) => n.id !== id)
  if (next.length !== data.notices.length) writeAtomic(file, { notices: next })
  return true
}
