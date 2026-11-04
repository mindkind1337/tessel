// The latest thing a log names (an agent's model), wherever it is: a turn's
// web results and tool outputs can write megabytes after the line that names
// it (a fixed tail misses it), so the file is read back in chunks until one
// shows. Remembered per file: a grown file is read only from where the last
// read stopped (its last whole line), and keeps what it said when the new part
// names nothing. The same file means the same inode and modification time
// (a file replaced by another of the same size, or rewritten in place, is read
// again from the start). Used for Codex's rollouts, Copilot's events and
// Gemini's and Qwen's chats (agentModel.js, agentModelSources.js).
import fs from 'fs'

const CHUNK = 512 * 1024
const MAX_SCAN = 64 * 1024 * 1024
const SEEN_MAX = 200

// parse(text) -> what the newest lines of that text name, or null.
// What two parts say can add up (Copilot: an answer's model, the effort a
// /model before it set): merge(newer, older) joins them, done(found) says
// nothing older can change it, finish(found) is what the reader returns. By
// default the newest part that names something wins.
// -> (file) => what the file's newest lines name, or null.
export function latestInFile(parse, { chunk = CHUNK, maxScan = MAX_SCAN, merge = (n, o) => n || o, done = (f) => !!f, finish = (f) => f } = {}) {
  const seen = new Map() // file -> { size, ino, mtimeMs, lineEnd, found }
  // The same file as last time: same inode (0 where the system gives none)
  // and, unless it grew, the same modification time.
  const sameFile = (prev, st) => !!prev && prev.ino === (st.ino || 0) && (prev.size < st.size || prev.mtimeMs === st.mtimeMs)
  const out = (found) => (found ? finish(found) : null)
  return function read(file) {
    let fd
    try {
      fd = fs.openSync(file, 'r')
      const st = fs.fstatSync(fd)
      const size = st.size
      const remembered = seen.get(file)
      // Another file at this path (replaced, same size or not), or rewritten
      // in place: what was read before says nothing about it.
      const prev = sameFile(remembered, st) ? remembered : null
      if (prev && prev.size === size) return out(prev.found)
      // Shrank (rewritten): read it all again.
      const floor = prev && prev.size < size ? prev.lineEnd : 0
      let found = null
      let lineEnd = floor
      let end = size
      let carry = Buffer.alloc(0) // the cut first line of the chunk read before
      while (end > floor && size - end < maxScan) {
        const start = Math.max(floor, end - chunk)
        const buf = Buffer.alloc(end - start)
        const n = fs.readSync(fd, buf, 0, buf.length, start)
        if (end === size) {
          const nl = buf.subarray(0, n).lastIndexOf(10)
          if (nl >= 0) lineEnd = start + nl + 1
        }
        const whole = Buffer.concat([buf.subarray(0, n), carry])
        let from = 0
        if (start > floor) {
          // Its first line can be cut: kept for the next (earlier) chunk.
          const nl = whole.indexOf(10)
          if (nl === -1) {
            carry = whole
            end = start
            continue
          }
          carry = whole.subarray(0, nl)
          from = nl + 1
        }
        found = merge(found, parse(whole.subarray(from).toString('utf8')))
        if (found && done(found)) break
        end = start
      }
      // The part read before still says what the new part does not.
      if (prev && floor && !(found && done(found))) found = merge(found, prev.found)
      seen.delete(file)
      seen.set(file, { size, ino: st.ino || 0, mtimeMs: st.mtimeMs, lineEnd, found })
      while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value)
      return out(found)
    } catch {
      return null
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
}
