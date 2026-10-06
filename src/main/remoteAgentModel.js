// Which model a terminal agent on an SSH host uses (Claude Code, Codex), for
// its pane header: the latest answer in its conversation file there, read
// over the host's connection (remoteFs.js readAgentFile), else a --model on
// its command line. Never this PC's settings files (they are not the host's).
//
// Cost on the connection: the end of the file once (its last TAIL_BYTES),
// then only what was added since (a request whose answer is the size and
// change time alone when nothing changed); each file at most once per
// minGapMs, one request at a time per file.
import { claudeTurnFromText, codexModelFromText, modelFromCommand, effortFromCommand, sameClaudeModel } from './agentModel'

const HOST_ID = /^ssh-[\w-]{1,60}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TAIL_BYTES = 256 * 1024
const MAX_FILES = 100

// readAgentFile(hostId, { agent, id, offset, cap }) -> { ok, size, mtimeMs, data } | { ok: false, missing? }
// read({ hostId, agent, sessionId }) -> { model, effort, at? } | null
export function createRemoteModelReader({ readAgentFile, now = Date.now, minGapMs = 5000, tailBytes = TAIL_BYTES, maxFiles = MAX_FILES } = {}) {
  const files = new Map() // key -> { size, mtimeMs, buf, turn, checkedAt, pending }

  const parse = (agent, buf) => {
    const text = buf.toString('utf8')
    return agent === 'codex' ? codexModelFromText(text) : claudeTurnFromText(text)
  }

  async function ask(hostId, agent, id, offset) {
    try {
      const r = await readAgentFile(hostId, { agent, id, offset, cap: tailBytes })
      return r && r.ok && Buffer.isBuffer(r.data) && Number.isSafeInteger(r.size) ? r : r && r.missing ? { missing: true } : null
    } catch {
      return null
    }
  }

  async function refresh(key, e, hostId, agent, id) {
    let r = await ask(hostId, agent, id, e.buf ? e.size : null)
    if (r && r.missing) {
      files.delete(key)
      return null
    }
    if (!r) return e.turn // unreachable now: what it showed
    // Shrank, or grew past what is kept: its end again.
    if (e.buf && (r.size < e.size || r.size - e.size > tailBytes)) {
      r = await ask(hostId, agent, id, null)
      if (!r || r.missing) return r && r.missing ? (files.delete(key), null) : e.turn
      e.buf = null
    }
    const same = e.buf && r.size === e.size && (r.mtimeMs == null || r.mtimeMs === e.mtimeMs)
    e.mtimeMs = r.mtimeMs ?? null
    if (same) return e.turn
    if (!e.buf) {
      e.buf = r.data
    } else if (r.data.length) {
      const joined = Buffer.concat([e.buf, r.data])
      e.buf = joined.length > tailBytes ? joined.subarray(joined.length - tailBytes) : joined
    }
    e.size = r.size
    e.turn = parse(agent, e.buf)
    return e.turn
  }

  async function read({ hostId, agent, sessionId } = {}) {
    if (typeof readAgentFile !== 'function' || typeof hostId !== 'string' || !HOST_ID.test(hostId)) return null
    if ((agent !== 'claude' && agent !== 'codex') || typeof sessionId !== 'string' || !UUID.test(sessionId)) return null
    const key = `${hostId}\n${agent}\n${sessionId}`
    let e = files.get(key)
    if (e && e.pending) return e.pending
    if (e && now() - e.checkedAt < minGapMs) return e.turn
    if (!e) {
      e = { size: 0, mtimeMs: null, buf: null, turn: null, checkedAt: 0, pending: null }
      files.set(key, e)
      while (files.size > maxFiles) files.delete(files.keys().next().value)
    }
    const entry = e
    entry.pending = refresh(key, entry, hostId, agent, sessionId).finally(() => {
      entry.checkedAt = now()
      entry.pending = null
    })
    return entry.pending
  }

  return { read, size: () => files.size }
}

// The agents:model answer for a pane on an SSH host (q: the window's query
// plus remoteHostId), the same shape as agentModel.js agentModel's.
export async function remoteAgentModel(q = {}, reader) {
  const agentId = q.agentId
  if (agentId !== 'claude' && agentId !== 'codex') {
    const flag = modelFromCommand(q.command)
    return flag ? { model: flag, effort: null, source: 'command' } : null
  }
  let res = null
  const turn = reader ? await reader.read({ hostId: q.remoteHostId, agent: agentId, sessionId: q.sessionId }) : null
  const flagEffort = agentId === 'claude' ? effortFromCommand(q.command) : null
  if (turn && turn.model) res = { model: turn.model, effort: turn.effort || flagEffort || null, source: 'session', ...(turn.at ? { at: turn.at } : {}) }
  else {
    const flag = modelFromCommand(q.command)
    if (flag) res = { model: flag, effort: flagEffort, source: 'command' }
  }
  if (agentId !== 'claude') return res
  const chosen = typeof q.chosenModel === 'string' && /^[\w.[\]-]{1,80}$/.test(q.chosenModel) ? q.chosenModel : null
  if (!chosen) return res
  const sameModel = res && res.source === 'session' && sameClaudeModel(res.model, chosen)
  const chosenEffort = (sameModel && res.effort) || flagEffort || null
  return res ? { ...res, chosenEffort } : { model: null, effort: null, source: null, chosenEffort }
}
