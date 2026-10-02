// Background team information written by Tessel (the only writer), read by
// the team tools (teamMcp/server.cjs) — never typed into a terminal:
//   <project>/.tessel/team-channel/current.json   who is in which team now
//   <project>/.tessel/team-channel/<team>/notices.json   Tessel's own notices
//     to an agent (team changes, answers to a lead), read once like messages
import fs from 'fs'
import { join, resolve, isAbsolute } from 'path'
import { ensureTeamChannel } from './teamChannel'

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

// panes: { <paneId>: { team, num } } for the teams of this project now.
export function writeCurrentTeams({ dir, panes } = {}) {
  const b = base(dir)
  if (!b || !panes || typeof panes !== 'object') return { ok: false, error: 'Invalid team location.' }
  const clean = {}
  for (const [id, p] of Object.entries(panes)) {
    if (ID_RE.test(id) && p && ID_RE.test(String(p.team)) && Number.isInteger(p.num)) clean[id] = { team: p.team, num: p.num }
  }
  // A project that never had a team gets no folder just for an empty map.
  if (!Object.keys(clean).length && !fs.existsSync(b)) return { ok: true, changed: false }
  fs.mkdirSync(b, { recursive: true })
  const file = join(b, 'current.json')
  const old = readJson(file)
  if (old && JSON.stringify(old.panes) === JSON.stringify(clean)) return { ok: true, changed: false }
  writeAtomic(file, { version: 1, panes: clean })
  return { ok: true, changed: true }
}

// Teams of this project that do not exist any more: their members are made
// inactive, so nothing is read or sent there again.
export function retireOldTeams({ dir, liveTeamIds } = {}) {
  const b = base(dir)
  if (!b || !Array.isArray(liveTeamIds)) return { ok: false, error: 'Invalid team location.' }
  if (!fs.existsSync(b)) return { ok: true, retired: [] }
  const retired = []
  for (const t of fs.readdirSync(b)) {
    if (!ID_RE.test(t) || liveTeamIds.includes(t) || !fs.existsSync(join(b, t, 'state.json'))) continue
    const state = readJson(join(b, t, 'state.json'))
    if (!state || !state.members || !Object.values(state.members).some((m) => m.active)) continue
    const res = ensureTeamChannel({ dir, teamId: t, members: [] })
    if (res.ok) retired.push(t)
  }
  return { ok: true, retired }
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
