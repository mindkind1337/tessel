// A chat pane's journal: the renderer events it was shown, so a reloaded
// window (or a restarted Tessel) can redraw the conversation, and the
// session id, so reopening the pane resumes it.
//
// <dir>/chats/<paneId>/journal.jsonl   one { seq, at, event } per line
//                     journal.1.jsonl  the previous one (rotated at 20 MB)
//                     meta.json        { sessionId, agent, cwd }
// Streaming deltas are not kept (the final 'assistant' text replaces them),
// nor a sub-agent's tool-level progress events.
// Strings in tool input/output are clipped to 8 KB: a journal is for reading
// back a conversation, not for storing whole files a tool printed.
import fs from 'fs'
import { join } from 'path'
import { readJsonSafe, writeJsonSafe } from '../safeJson.js'

export const CLIP_BYTES = 8 * 1024
export const ROTATE_BYTES = 20 * 1024 * 1024
export const READ_LAST = 2000
const TAIL_CHUNK = 64 * 1024
const PANE = /^[A-Za-z0-9._-]{1,100}$/
const SKIPPED = new Set(['assistantDelta'])
const CLIPPED = new Set(['tool', 'toolResult', 'approval'])

export function validPaneId(id) {
  return typeof id === 'string' && PANE.test(id) && id !== '.' && !id.includes('..')
}

export function clipString(s, max = CLIP_BYTES) {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= max) return s
  let kept = buf.subarray(0, max).toString('utf8')
  if (kept.endsWith('�') && !s.startsWith(kept)) kept = kept.slice(0, -1)
  return `${kept} … (${buf.length - Buffer.byteLength(kept, 'utf8')} more bytes)`
}

// Every string inside `value` clipped; depth and breadth bounded too.
export function clipDeep(value, depth = 0) {
  if (typeof value === 'string') return clipString(value)
  if (!value || typeof value !== 'object') return value
  if (depth > 8) return '…'
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => clipDeep(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value).slice(0, 200)) out[k] = clipDeep(v, depth + 1)
  return out
}

export function createChatJournal({ dir, paneId, rotateBytes = ROTATE_BYTES, now = Date.now, log = null }) {
  if (!validPaneId(paneId)) throw new Error('invalid pane id') // i18n-ignore programming error
  const folder = join(dir, 'chats', paneId)
  const file = join(folder, 'journal.jsonl')
  const old = join(folder, 'journal.1.jsonl')
  const metaFile = join(folder, 'meta.json')
  let size = null

  const warn = (what, err) => {
    try {
      log?.warn?.('chat', `journal ${paneId}: ${what}: ${err?.code || err?.message || err}`) // i18n-ignore log line
    } catch {
      /* logging never breaks the chat */
    }
  }
  function ensure() {
    fs.mkdirSync(folder, { recursive: true })
    if (size === null) {
      try {
        size = fs.statSync(file).size
      } catch {
        size = 0
      }
    }
  }

  function append(seq, event) {
    if (!event || typeof event !== 'object' || SKIPPED.has(event.type)) return false
    // A sub-agent's tool-level progress is live only: replay needs its roster
    // (the 'subagents' snapshots and start/end), not every tool it ran.
    if (event.type === 'subagent' && event.phase === 'progress' && event.tool) return false
    let stored = CLIPPED.has(event.type) ? clipDeep(event) : event
    // An approval's preview is already bounded, and its hidden count is
    // counted from it: kept whole.
    if (event.type === 'approval' && typeof event.detail === 'string') stored = { ...stored, detail: event.detail }
    const line = `${JSON.stringify({ seq, at: now(), event: stored })}\n`
    try {
      ensure()
      if (size > 0 && size + Buffer.byteLength(line) > rotateBytes) {
        fs.rmSync(old, { force: true })
        fs.renameSync(file, old)
        size = 0
      }
      fs.appendFileSync(file, line, 'utf8')
      size += Buffer.byteLength(line)
      return true
    } catch (err) {
      warn('append', err)
      return false
    }
  }

  function parseLine(line, out) {
    if (!line) return
    try {
      const item = JSON.parse(line)
      if (item && Number.isSafeInteger(item.seq) && item.event && typeof item.event.type === 'string')
        out.push({ seq: item.seq, ...(Number.isFinite(item.at) ? { at: item.at } : {}), event: item.event })
    } catch {
      // a line cut by a crash: skipped
    }
  }

  // The last `limit` good entries of one file, read backwards from its end
  // by chunks (never the whole 20 MB for a few lines).
  function tailLines(path, limit) {
    let fd
    try {
      fd = fs.openSync(path, 'r')
    } catch {
      return []
    }
    try {
      let pos = fs.fstatSync(fd).size
      let rest = Buffer.alloc(0) // the start of a line whose beginning is not read yet
      const found = [] // newest first
      while (pos > 0 && found.length < limit) {
        const len = Math.min(TAIL_CHUNK, pos)
        pos -= len
        const chunk = Buffer.alloc(len)
        fs.readSync(fd, chunk, 0, len, pos)
        let buf = Buffer.concat([chunk, rest])
        let end = buf.length
        for (let i = buf.length - 1; i >= 0 && found.length < limit; i--) {
          if (buf[i] !== 0x0a) continue
          const one = []
          parseLine(buf.subarray(i + 1, end).toString('utf8'), one)
          if (one.length) found.push(one[0])
          end = i
        }
        rest = buf.subarray(0, end)
        buf = null
      }
      if (pos === 0 && found.length < limit && rest.length) {
        const one = []
        parseLine(rest.toString('utf8'), one)
        if (one.length) found.push(one[0])
      }
      return found.reverse()
    } catch {
      return []
    } finally {
      fs.closeSync(fd)
    }
  }

  // -> the last `limit` entries, oldest first, as read() gives them.
  function readTail(limit = READ_LAST) {
    const n = Math.max(1, Math.min(READ_LAST, Math.floor(Number(limit)) || READ_LAST))
    let items = tailLines(file, n)
    if (items.length < n) items = [...tailLines(old, n - items.length), ...items]
    return items
  }

  function readLines(path) {
    let text
    try {
      text = fs.readFileSync(path, 'utf8')
    } catch {
      return []
    }
    const out = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const item = JSON.parse(line)
        if (item && Number.isSafeInteger(item.seq) && item.event && typeof item.event.type === 'string')
          out.push({ seq: item.seq, ...(Number.isFinite(item.at) ? { at: item.at } : {}), event: item.event })
      } catch {
        // a line cut by a crash: skipped
      }
    }
    return out
  }

  // -> the last `limit` entries, oldest first: [{ seq, at?, event }] (at: when it
  // was written, so a redrawn chat keeps its order and times).
  function read(limit = READ_LAST) {
    let items = readLines(file)
    if (items.length < limit) items = [...readLines(old), ...items]
    return items.slice(-limit)
  }

  function lastSeq() {
    const items = readTail(1)
    return items.length ? items[items.length - 1].seq : 0
  }

  function readMeta() {
    try {
      const { data } = readJsonSafe(metaFile, (d) => !!d && typeof d === 'object')
      return data || null
    } catch {
      return null
    }
  }

  function writeMeta(meta) {
    try {
      ensure()
      writeJsonSafe(metaFile, {
        sessionId: meta?.sessionId ?? null,
        agent: meta?.agent ?? null,
        cwd: meta?.cwd ?? null
      })
      return true
    } catch (err) {
      warn('meta', err)
      return false
    }
  }

  // The pane is closed for good: its whole folder goes.
  function remove() {
    try {
      fs.rmSync(folder, { recursive: true, force: true })
      size = null
      return true
    } catch (err) {
      warn('remove', err)
      return false
    }
  }

  return { append, read, readTail, lastSeq, readMeta, writeMeta, remove, folder }
}
