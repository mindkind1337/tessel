// Agent conversations kept on an SSH host (Claude Code's
// ~/.claude/projects/<folder>/<id>.jsonl, Codex's rollouts), read over the
// host's connection (remoteFs.js readAgentFile: a bounded window of the file
// found by its id in the agent's own folder there, nothing else). The same
// parsers as for local files turn their lines into the chat's events.
//
// Paths here are the host's: none is ever read on this PC (attachments are
// resolved from inline data only) nor put through Windows' path functions.
import { claudeHistoryEvents, codexHistoryEvents, HISTORY_LIMITS, ATTACHMENT_LIMITS, resolveHistoryAttachments } from './transcriptHistory.js'
import { HEAD_BYTES, DETAILS_TAIL_BYTES, detailsFromLines, splitLines } from '../sessionDetails.js'

const HOST_ID = /^ssh-[\w-]{1,60}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODEX_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,99}$/

export const REMOTE_TRANSCRIPT_AGENTS = ['claude', 'codex']

export function validRemoteTranscript(agent, hostId, id) {
  if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || typeof id !== 'string') return false
  if (agent === 'claude') return UUID.test(id)
  if (agent === 'codex') return CODEX_ID.test(id)
  return false
}

// readAgentFile(hostId, { agent, id, offset, cap }) (remoteFs.js) bound to
// one conversation -> readWindow({ offset, cap }) -> { ok, size, data } | { ok: false, missing? }
export function remoteWindowReader(readAgentFile, { hostId, agent, id }) {
  return async ({ offset = null, cap }) => {
    try {
      const r = await readAgentFile(hostId, { agent, id, offset, cap })
      return r && typeof r === 'object' ? r : { ok: false, error: 'failed' }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  }
}

// Complete lines of buf[from, end) (end just past a '\n'), with their sizes
// in the file; blank lines' bytes go with the next line (as createTail).
function linesOf(buf, from, end, carry = 0) {
  const out = []
  const outSizes = []
  let skipped = carry
  let pos = from
  while (pos < end) {
    let nl = buf.indexOf(10, pos)
    if (nl < 0 || nl >= end) nl = end - 1
    let stop = nl
    if (stop > pos && buf[stop - 1] === 13) stop--
    const size = nl + 1 - pos
    if (stop > pos) {
      out.push(buf.toString('utf8', pos, stop))
      outSizes.push(size + skipped)
      skipped = 0
    } else skipped += size
    pos = nl + 1
  }
  return { out, outSizes, skipped }
}

// The remote twin of transcriptView.js createTail: the same interface
// (read, readEarlier, lines, cut, more), its reads async. Each read asks for
// the bytes added since the last one only; a file that shrank is read again
// from its last `maxBytes`.
// read() -> true (lines added / read again) | false (nothing new) | null (unreadable)
export function createRemoteTail(readWindow, maxBytes, { maxEarlier = 0 } = {}) {
  let offset = 0
  let started = false
  let lines = []
  let sizes = []
  let kept = 0
  let cut = false
  let head = 0
  let limit = maxBytes
  let earlier = 0
  let blank = 0
  let stuck = false
  let size = 0
  function reset() {
    offset = 0
    lines = []
    sizes = []
    kept = 0
    cut = false
    head = 0
    limit = maxBytes
    earlier = 0
    blank = 0
    stuck = false
  }
  function take(buf, start) {
    const got = buf.length
    let from = 0
    if (start > 0 && start !== offset) {
      const nl = buf.indexOf(10)
      if (nl < 0) return true
      from = nl + 1
    }
    const end = got > 0 ? buf.lastIndexOf(10, got - 1) : -1
    if (end < from) {
      if (start !== offset) offset = head = start + from
      return start !== offset
    }
    if (!lines.length && start !== offset) {
      head = start + from
      blank = 0
    }
    offset = start + end + 1
    const { out, outSizes, skipped } = linesOf(buf, from, end + 1, blank)
    blank = skipped
    for (let i = 0; i < out.length; i++) {
      lines.push(out[i])
      sizes.push(outSizes[i])
      kept += outSizes[i]
    }
    let drop = 0
    while (kept > limit && drop < lines.length) {
      kept -= sizes[drop]
      head += sizes[drop++]
    }
    if (drop) {
      lines = lines.slice(drop)
      sizes = sizes.slice(drop)
      cut = true
    }
    return true
  }
  async function fromTail(changed) {
    const r = await readWindow({ offset: null, cap: maxBytes })
    if (!r || !r.ok || !Buffer.isBuffer(r.data)) return null
    started = true
    size = r.size
    reset()
    const start = Math.max(0, r.size - r.data.length)
    if (start > 0) cut = true
    take(r.data, start)
    return changed || true
  }
  async function read() {
    if (!started) return fromTail(false)
    const r = await readWindow({ offset, cap: maxBytes })
    if (!r || !r.ok || !Buffer.isBuffer(r.data)) return null
    // Shrank (replaced, rewritten) or grew past what is kept: its tail again.
    if (r.size < offset || r.size - offset > maxBytes) return fromTail(true)
    size = r.size
    if (r.size === offset || !r.data.length) return false
    const before = offset
    take(r.data, offset)
    return offset !== before
  }
  async function readEarlier(bytes) {
    const room = Math.min(bytes, maxEarlier - earlier)
    if (head <= 0 || room <= 0 || stuck) return { added: 0, more: false }
    const start = Math.max(0, head - room - 1)
    const r = await readWindow({ offset: start, cap: head - start })
    if (!r || !r.ok || !Buffer.isBuffer(r.data) || r.size < offset) return null
    const buf = r.data
    if (buf.length !== head - start) return null
    let from = 0
    if (start > 0) {
      const nl = buf.indexOf(10)
      if (nl < 0 || nl >= buf.length - 1) {
        stuck = true
        return { added: 0, more: false }
      }
      from = nl + 1
    }
    const { out, outSizes, skipped } = linesOf(buf, from, buf.length)
    let added = outSizes.reduce((sum, n) => sum + n, 0)
    if (skipped && sizes.length) {
      sizes[0] += skipped
      added += skipped
    } else if (skipped) blank += skipped
    lines = [...out, ...lines]
    sizes = [...outSizes, ...sizes]
    kept += added
    head = start + from
    earlier += buf.length - from
    limit = Math.max(limit, kept, maxBytes + maxEarlier)
    cut = head > 0
    return { added: out.length, more: more() }
  }
  function more() {
    return head > 0 && earlier < maxEarlier && !stuck
  }
  return { read, readEarlier, lines: () => lines, cut: () => cut, more, size: () => size, remote: true }
}

// A remote conversation's most recent part as the chat's events (a resumed
// chat's earlier turns), like transcriptHistory.js readTranscriptHistory.
// -> { ok: true, events, truncated } | { ok: false, code: 'invalid' | 'missing' | 'empty' | 'unreachable' }
export async function readRemoteHistory({ readAgentFile, hostId, agent, sessionId, limits = HISTORY_LIMITS } = {}) {
  if (!validRemoteTranscript(agent, hostId, sessionId) || typeof readAgentFile !== 'function') return { ok: false, code: 'invalid' }
  const tail = createRemoteTail(remoteWindowReader(readAgentFile, { hostId, agent, id: sessionId }), limits.bytes)
  let r
  try {
    r = await tail.read()
  } catch {
    r = null
  }
  if (r === null) return { ok: false, code: 'missing' }
  const caps = { ...limits, attachments: limits.attachments ?? ATTACHMENT_LIMITS }
  let events = agent === 'codex' ? codexHistoryEvents(tail.lines(), sessionId, caps) : claudeHistoryEvents(tail.lines(), caps)
  let truncated = tail.cut()
  if (events.length > limits.events) {
    events = events.slice(-limits.events)
    truncated = true
  }
  if (!events.length) return { ok: false, code: 'empty' }
  if (caps.attachments) resolveHistoryAttachments(events, caps.attachments, { local: false })
  return { ok: true, events, truncated }
}

// Whether the host has that conversation's file (a Claude chat closed before
// its first message never wrote one: --resume would fail). Unknown -> null.
// timeoutMs: not answered by then -> null (a terminal pane waits for it).
export async function remoteTranscriptExists({ readAgentFile, hostId, agent, sessionId, timeoutMs = 0 } = {}) {
  if (!validRemoteTranscript(agent, hostId, sessionId) || typeof readAgentFile !== 'function') return null
  let timer = null
  try {
    const read = Promise.resolve(readAgentFile(hostId, { agent, id: sessionId, offset: null, cap: 1 }))
    read.catch(() => {}) // a late failure after the timeout: nobody waits
    const r =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? await Promise.race([read, new Promise((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)))])
        : await read
    if (r?.ok) return true
    if (r?.missing) return false
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Agent Session History's details of a conversation kept on a host (its
// first prompt, latest turns, message count), as sessionDetails.js does for
// a local file: its first HEAD_BYTES and, when longer, its last bytes.
// -> { ok: true, file: null, size, firstPrompt, turns, messageCount } | { ok: false, notConnected? }
export async function remoteSessionDetails({ readAgentFile, hostId, agent, id } = {}) {
  if (!validRemoteTranscript(agent, hostId, id) || typeof readAgentFile !== 'function') return { ok: false }
  const read = async (q) => {
    try {
      return await readAgentFile(hostId, { agent, id, ...q })
    } catch {
      return null
    }
  }
  const head = await read({ offset: 0, cap: HEAD_BYTES })
  if (!head?.ok || !Buffer.isBuffer(head.data)) return { ok: false, ...(head?.notConnected ? { notConnected: true } : {}) }
  const whole = head.size <= HEAD_BYTES
  let tailLines = null
  if (!whole) {
    const tail = await read({ offset: null, cap: DETAILS_TAIL_BYTES })
    // Its first line is cut (the window starts inside it).
    tailLines = tail?.ok && Buffer.isBuffer(tail.data) ? splitLines(tail.data.toString('utf8')).slice(1) : []
  }
  return { ok: true, file: null, size: head.size, ...detailsFromLines(agent, id, splitLines(head.data.toString('utf8')), tailLines, whole) }
}
