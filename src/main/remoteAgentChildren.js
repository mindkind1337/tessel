// The sub-agents of a terminal agent's conversation on an SSH host (Claude
// Code's Task / Agent tool, Codex's spawn_agent threads), the same rows as
// agentChildren.js gives for this PC's files, read over the host's
// connection (remoteFs.js):
//   Claude Code: listSubagentFiles (<id>/subagents/*.jsonl next to its
//     transcript, newest first: names, sizes, times), readSubagentMetas (each
//     one's agent-<id>.meta.json once: kind, title, background) and
//     readAgentFile(.., { sub }) for what each transcript added;
//   Codex: listCodexChildren (the rollouts whose first line names the
//     conversation), their head once and what each added (readAgentFile).
// Never a sign-in (each read says "not connected" instead), never busy: one
// read of a conversation at a time, at most every minGapMs whoever asks (the
// pane header, its sidebar row...), and only the bytes a file added since
// the last read are asked for (at most maxReads files per read). A Codex
// conversation's new children are looked for at most every codexScanMs.
import { summarizeTail, parseCodexHead, summarizeCodexTail } from './agentChildren'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HOST_ID = /^[0-9A-Za-z_-]{1,100}$/
const CLAUDE_FILE = /^agent-([A-Za-z0-9_-]{1,80})$/
const ROLLOUT = /^rollout-[0-9T-]{10,40}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const TAIL_BYTES = 96 * 1024
// What a file added, read in one go up to this (a finished sub-agent's last
// line can be over 100 KB); a file first seen this much larger: its end only.
const WIDE_BYTES = 2 * 1024 * 1024
const HEAD_BYTES = 8192
const CODEX_HEAD_BYTES = 256 * 1024
const MAX_AGENTS = 50
const MAX_SESSIONS = 50
// A line not ended yet, kept for the next read, at most this long.
const MAX_REST = 4 * 1024 * 1024
const QUIET_MS = 15 * 60 * 1000

// Lines of a window of a file: `rest` is the unended line before it (when the
// window starts where the last one ended), `cut` drops its first (partial)
// line. -> { lines, rest }
function splitWindow(data, { rest = '', cut = false } = {}) {
  const text = rest + data.toString('utf8')
  const parts = text.split('\n')
  const tail = parts.pop()
  if (cut) parts.shift()
  return { lines: parts.filter((l) => l.trim()), rest: tail.length > MAX_REST ? '' : tail }
}

// A summary of what a file added, on top of what was known (each part found
// in the new lines wins; the others stay).
function mergeSummary(old, add) {
  if (!old) return add
  return {
    done: add.decided ? add.done : old.done,
    decided: add.decided || old.decided,
    last: add.last || old.last,
    tokens: add.tokens ?? old.tokens,
    model: add.model ?? old.model,
    ...(Object.prototype.hasOwnProperty.call(add, 'effort') || Object.prototype.hasOwnProperty.call(old, 'effort') ? { effort: add.effort ?? old.effort ?? null } : {})
  }
}

function startOf(lines) {
  const m = lines.length ? /"timestamp":"([^"]+)"/.exec(lines[0]) : null
  return m ? Date.parse(m[1]) || null : null
}

export function createRemoteChildren({
  listSubagentFiles = null,
  readSubagentMetas = null,
  readAgentFile = null,
  listCodexChildren = null,
  now = Date.now,
  minGapMs = 4000,
  codexScanMs = 30000,
  maxReads = 8
} = {}) {
  const convs = new Map() // `${hostId}/${agent}/${id}` -> { at, pending, rows, files, scannedAt }

  const ok = (r) => r && typeof r === 'object' && r.ok === true

  // What a file added since it was last read, folded into f.tail (sum: the
  // agent's summarizer) -> true when it was read.
  async function readMore(f, read, sum, size) {
    const from = f.offset
    let r
    if (from !== null && size !== null && size === from) return false
    if (from !== null && (size === null || size - from <= WIDE_BYTES)) {
      r = await read({ offset: from, cap: WIDE_BYTES })
      if (!ok(r) || !Buffer.isBuffer(r.data)) return false
      // Shorter than it was (written anew): read again from its end.
      if (r.size < from) {
        f.offset = null
        f.rest = ''
        f.tail = null
        return readMore(f, read, sum, r.size)
      }
      const w = splitWindow(r.data, { rest: f.rest })
      f.tail = mergeSummary(f.tail, sum(w.lines))
      f.rest = w.rest
      f.offset = from + r.data.length
    } else {
      r = await read({ offset: null, cap: TAIL_BYTES })
      if (!ok(r) || !Buffer.isBuffer(r.data)) return false
      let w = splitWindow(r.data, { cut: r.size > r.data.length })
      let s = sum(w.lines)
      if (!s.decided && r.size > r.data.length) {
        const wide = await read({ offset: null, cap: WIDE_BYTES })
        if (ok(wide) && Buffer.isBuffer(wide.data)) {
          r = wide
          w = splitWindow(r.data, { cut: r.size > r.data.length })
          s = sum(w.lines)
        }
      }
      if (f.startedAt === null && r.size === r.data.length) f.startedAt = startOf(w.lines)
      f.tail = s
      f.rest = w.rest
      f.offset = r.size
    }
    if (Number.isFinite(r.mtimeMs)) f.mtimeMs = Math.max(f.mtimeMs || 0, r.mtimeMs)
    return true
  }

  function rowState(tail, lastAt, t) {
    return tail && tail.done ? 'done' : t - lastAt > QUIET_MS ? 'quiet' : 'running'
  }

  // --- Claude Code --------------------------------------------------------
  async function claudeRead(c, hostId, id) {
    const r = await listSubagentFiles(hostId, { id, limit: MAX_AGENTS })
    if (!ok(r) || !Array.isArray(r.files)) {
      if (r && r.missing) c.files.clear()
      return
    }
    const listed = r.files.filter((x) => x && CLAUDE_FILE.test(x.name) && Number.isSafeInteger(x.size)).slice(0, MAX_AGENTS)
    const names = new Set(listed.map((x) => x.name))
    for (const name of c.files.keys()) if (!names.has(name)) c.files.delete(name)
    for (const x of listed) {
      const f = c.files.get(x.name)
      if (f) {
        f.size = x.size
        f.mtimeMs = x.mtimeMs
      } else c.files.set(x.name, { size: x.size, mtimeMs: x.mtimeMs, offset: null, rest: '', tail: null, startedAt: null, meta: null })
    }
    // Their meta files, once each (they never change).
    const noMeta = listed.filter((x) => c.files.get(x.name).meta === null).map((x) => x.name)
    if (noMeta.length && typeof readSubagentMetas === 'function') {
      const m = await readSubagentMetas(hostId, { id, names: noMeta })
      if (ok(m) && m.metas && typeof m.metas === 'object') {
        for (const name of noMeta) c.files.get(name).meta = m.metas[name] || {}
      }
    }
    // What changed, newest first, at most maxReads files.
    let reads = 0
    for (const x of [...listed].sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))) {
      const f = c.files.get(x.name)
      if (f.offset === x.size) continue
      if (reads >= maxReads) break
      reads++
      const read = (q) => readAgentFile(hostId, { agent: 'claude', id, sub: x.name, ...q })
      try {
        await readMore(f, read, summarizeTail, x.size)
        // Its start: its first line's time (read once; a whole file read
        // above gave it already).
        if (f.startedAt === null && f.offset !== null) {
          const h = await read({ offset: 0, cap: HEAD_BYTES })
          if (ok(h) && Buffer.isBuffer(h.data)) f.startedAt = startOf([h.data.toString('utf8').split('\n')[0]]) || 0
        }
      } catch {
        // next time
      }
    }
    const t = now()
    const rows = []
    for (const [name, f] of c.files) {
      const meta = f.meta || {}
      const tail = f.tail || { done: false, last: null, tokens: null, model: null }
      const last = tail.last || f.mtimeMs || 0
      const lastAt = Math.max(last, f.mtimeMs || 0)
      const state = rowState(tail, lastAt, t)
      rows.push({
        id: CLAUDE_FILE.exec(name)[1],
        type: typeof meta.agentType === 'string' ? meta.agentType.slice(0, 60) : 'agent',
        title: typeof meta.description === 'string' ? meta.description.slice(0, 200) : '',
        background: meta.requestShape === 'background',
        state,
        startedAt: f.startedAt || null,
        endedAt: state === 'done' ? last : null,
        lastAt,
        tokens: tail.tokens ?? null,
        model: tail.model ?? null
      })
    }
    c.rows = rows
  }

  // --- Codex ----------------------------------------------------------------
  async function codexRead(c, hostId, id) {
    const sid = id.toLowerCase()
    if (typeof listCodexChildren === 'function' && (!c.scannedAt || now() - c.scannedAt >= codexScanMs)) {
      const r = await listCodexChildren(hostId, { id, limit: MAX_AGENTS })
      if (ok(r) && Array.isArray(r.files)) {
        c.scannedAt = now()
        for (const x of r.files) {
          const m = x && ROLLOUT.exec(x.name)
          if (!m || m[1].toLowerCase() === sid || !Number.isSafeInteger(x.size)) continue
          const f = c.files.get(x.name)
          if (f) {
            f.size = x.size
            f.mtimeMs = x.mtimeMs
          } else if (c.files.size < MAX_AGENTS) {
            c.files.set(x.name, { child: m[1].toLowerCase(), size: x.size, mtimeMs: x.mtimeMs, offset: null, rest: '', tail: null, startedAt: null, head: null })
          }
        }
      }
    }
    let reads = 0
    for (const [name, f] of [...c.files].sort((a, b) => (b[1].mtimeMs || 0) - (a[1].mtimeMs || 0))) {
      // Finished, or silent for a while (a crashed one), and no bigger at the
      // last scan: left alone until a scan sees it grow.
      const silent = f.tail && (f.tail.done || now() - Math.max(f.tail.last || 0, f.mtimeMs || 0) > QUIET_MS)
      if (f.offset !== null && silent && f.size <= f.offset) continue
      if (reads >= maxReads) break
      reads++
      const read = (q) => readAgentFile(hostId, { agent: 'codex', id: f.child, ...q })
      try {
        if (!f.head) {
          const h = await read({ offset: 0, cap: CODEX_HEAD_BYTES })
          const head = ok(h) && Buffer.isBuffer(h.data) ? parseCodexHead(h.data.toString('utf8')) : null
          if (!head) continue
          const root = head.root && head.root.toLowerCase()
          const parent = head.parent && head.parent.toLowerCase()
          f.head = head.child && (root === sid || parent === sid) ? head : { child: false }
          if (!f.head.child) {
            c.files.delete(name)
            continue
          }
        }
        // Between scans its size is not known: what it added, if anything
        // (an answer with no bytes when nothing).
        await readMore(f, read, summarizeCodexTail, f.offset === null ? f.size : f.size > f.offset ? f.size : null)
        if (f.offset !== null && f.offset > f.size) f.size = f.offset
      } catch {
        // next time
      }
    }
    const t = now()
    const rows = []
    for (const f of c.files.values()) {
      const head = f.head
      if (!head || !head.child) continue
      const tail = f.tail || { done: false, last: null, tokens: null, model: null }
      const last = tail.last || f.mtimeMs || 0
      const lastAt = Math.max(last, f.mtimeMs || 0)
      const state = rowState(tail, lastAt, t)
      const task = head.path ? head.path.split('/').filter(Boolean).pop() || '' : ''
      const title = task && head.nickname ? `${task} (${head.nickname})` : task || head.nickname || ''
      rows.push({
        id: f.child,
        type: head.role || 'default',
        title: title.slice(0, 200),
        state,
        startedAt: head.startedAt || null,
        endedAt: state === 'done' ? last : null,
        lastAt,
        tokens: tail.tokens ?? null,
        model: tail.model || head.model || null,
        effort: tail.effort || head.effort || null
      })
    }
    c.rows = rows
  }

  // -> the rows (agentChildren.js claudeSubagents / codexSubagents) newest
  // first; the last ones known while a read is under way or too recent.
  async function children({ hostId, agent, sessionId } = {}) {
    if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || !ID.test(String(sessionId))) return []
    if (agent === 'claude' ? typeof listSubagentFiles !== 'function' || typeof readAgentFile !== 'function' : agent !== 'codex' || typeof readAgentFile !== 'function') return []
    const key = `${hostId}/${agent}/${sessionId}`
    let c = convs.get(key)
    if (!c) {
      c = { at: 0, pending: null, rows: [], files: new Map(), scannedAt: 0 }
      convs.set(key, c)
      while (convs.size > MAX_SESSIONS) convs.delete(convs.keys().next().value)
    } else {
      convs.delete(key)
      convs.set(key, c)
    }
    if (c.pending) return c.pending
    if (c.at && now() - c.at < minGapMs) return sorted(c.rows)
    const conv = c
    conv.pending = (async () => {
      try {
        await null
        if (agent === 'claude') await claudeRead(conv, hostId, sessionId)
        else await codexRead(conv, hostId, sessionId)
      } catch {
        // next time
      } finally {
        conv.at = now()
        conv.pending = null
      }
      return sorted(conv.rows)
    })()
    return conv.pending
  }

  function sorted(rows) {
    return [...rows].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, MAX_AGENTS)
  }

  return { children }
}
