// The agent update history (Settings > Agents): the last attempts, newest
// first, and each agent's last result, kept in userData
// (agent-update-history.json). Bounded: MAX_ENTRIES attempts, one last result
// per agent (at most MAX_AGENTS), every text cut short.
import fs from 'fs'
import { dirname } from 'path'

export const MAX_ENTRIES = 20
const MAX_AGENTS = 50
const KINDS = ['ok', 'same-version', 'in-use', 'permission', 'network', 'not-found', 'timeout', 'failed', 'busy']

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')

// A stored entry, from anything (a file edited by hand, an old version).
export function cleanEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.agentId !== 'string' || !e.agentId) return null
  const at = Number(e.at)
  if (!Number.isFinite(at) || at <= 0) return null
  return {
    agentId: e.agentId.slice(0, 64),
    name: str(e.name, 80) || e.agentId.slice(0, 64),
    at,
    ok: e.ok === true,
    kind: KINDS.includes(e.kind) ? e.kind : e.ok === true ? 'ok' : 'failed',
    from: str(e.from, 64),
    to: str(e.to, 64),
    version: str(e.version, 64),
    detail: str(e.detail, 300),
    reason: str(e.reason, 200),
    file: str(e.file, 1024),
    via: e.via === 'pane' ? 'pane' : 'background',
    auto: e.auto === true
  }
}

export function createUpdateHistory({ file, max = MAX_ENTRIES, log = () => {} }) {
  let data = null

  function load() {
    if (data) return data
    data = { entries: [], last: {} }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && Array.isArray(raw.entries)) data.entries = raw.entries.map(cleanEntry).filter(Boolean).slice(0, max)
      if (raw && raw.last && typeof raw.last === 'object') {
        for (const [id, e] of Object.entries(raw.last).slice(0, MAX_AGENTS)) {
          const c = cleanEntry(e)
          if (c && c.agentId === id) data.last[id] = c
        }
      }
    } catch {
      /* none yet */
    }
    return data
  }
  function save() {
    if (!file) return
    try {
      fs.mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, file)
    } catch (err) {
      log('warn', `agent updates: could not save the history: ${err.message}`)
    }
  }

  return {
    // -> { entries: [...newest first], last: { agentId: entry } }
    get() {
      const d = load()
      return { entries: d.entries.map((e) => ({ ...e })), last: Object.fromEntries(Object.entries(d.last).map(([k, v]) => [k, { ...v }])) }
    },
    add(entry) {
      const e = cleanEntry(entry)
      if (!e) return null
      const d = load()
      d.entries = [e, ...d.entries].slice(0, max)
      d.last[e.agentId] = e
      const ids = Object.keys(d.last)
      if (ids.length > MAX_AGENTS) {
        ids.sort((a, b) => d.last[a].at - d.last[b].at)
        for (const id of ids.slice(0, ids.length - MAX_AGENTS)) delete d.last[id]
      }
      save()
      return e
    }
  }
}
