import fs from 'fs'

// The prompt of a turn whose answer the window shows without it.
//
// A conversation view reads the last window of a transcript (the local file's
// last megabytes, a host's last 512 KB plus a few earlier windows). A long
// turn (an agent at work for an hour, its tools' outputs filling the file)
// pushes the turn's own prompt beyond the window: the view then opened on an
// answer with no question above it. These find that prompt without reading
// the turn: a local file is read backwards from the window's start, a host's
// file is scanned there (__t_tprompt, remoteShell.js, the same rule in awk).

const USER = '"type":"user"'
const TOOL_RESULT = '"type":"tool_result"'
const QUEUED = '"queued_command"'
const QUEUED_PROMPT = '"commandMode":"prompt"'
const META = '"isMeta":true'
const SIDECHAIN = '"isSidechain":true'
const ORIGIN = '"origin"'
const HUMAN = '"kind":"human"'
const PEER = '"kind":"peer"'

// A Claude Code transcript line that starts a turn of the conversation view:
// a user line that is not a tool result, or a prompt queued while the agent
// worked (recorded as an attachment), yours (human, or no origin said; not
// Claude's own context, isMeta) or another session's (peer: the view then
// hides the answer, as it does when the line is in the window, since it was
// not to you). Not a sub-agent's (isSidechain), not a background task's
// notice (it arrives in the middle of a turn: the turn's prompt is earlier).
// The same words as __t_tprompt's awk: keep them equal.
export function isPromptLine(line) {
  if (typeof line !== 'string' || line.includes(SIDECHAIN)) return false
  const user = line.includes(USER) && !line.includes(TOOL_RESULT)
  const queued = line.includes(QUEUED) && line.includes(QUEUED_PROMPT)
  const yours = !line.includes(META) && (!line.includes(ORIGIN) || line.includes(HUMAN))
  return (user && (yours || line.includes(PEER))) || (queued && yours)
}
// Cheaper than decoding: could this line be one at all?
const maybe = (buf) => buf.includes(USER) || buf.includes(QUEUED)

// The whole line of the last prompt that starts before byte `before` of a
// local transcript (a line cut by `before`, the window having begun in the
// middle of it, is completed forwards up to `lineMax` bytes), read backwards
// `chunk` bytes at a time down to `stopAt` (a line's start: the window's
// previous start, when the file only grew since), at most `budget` bytes in
// all; null when none is found there (the window then stays as it is, or
// the prompt found last time stands).
export async function lastPromptBefore(file, before, budget, { fsp = fs.promises, chunk = 1024 * 1024, lineMax = 8 * 1024 * 1024, stopAt = 0, step = 64 * 1024 } = {}) {
  if (typeof file !== 'string' || !(Number.isSafeInteger(before) && before > 0) || !(budget > 0)) return null
  if (!(Number.isSafeInteger(stopAt) && stopAt >= 0 && stopAt < before)) return null
  let fh
  try {
    fh = await fsp.open(file, 'r')
  } catch {
    return null
  }
  try {
    const at = async (start, length) => {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, start)
      return bytesRead === length ? buf : null
    }
    const size = (await fh.stat()).size
    // A start inside a line (the byte before it is not a newline) moves to
    // the next line's start: never a partial line, as __t_tprompt does.
    if (stopAt > 0) {
      const b = await at(stopAt - 1, 1)
      if (!b) return null
      if (b[0] !== 10) {
        let pos = stopAt
        for (;;) {
          if (pos >= before) return null
          const piece = await at(pos, Math.min(step, before - pos))
          if (!piece) return null
          const nl = piece.indexOf(10)
          if (nl >= 0) {
            stopAt = pos + nl + 1
            break
          }
          pos += piece.length
        }
        if (stopAt >= before) return null
      }
    }
    // The bytes after `before` that end the line it falls in (none when
    // `before` is a line's start, the usual case), read a step at a time.
    const ends = []
    let endsLength = 0
    for (let pos = before; pos < size && endsLength < lineMax; ) {
      const piece = await at(pos, Math.min(step, size - pos, lineMax - endsLength))
      if (!piece) break
      const nl = piece.indexOf(10)
      ends.push(nl < 0 ? piece : piece.subarray(0, nl))
      endsLength += nl < 0 ? piece.length : nl
      if (nl >= 0) break
      pos += piece.length
    }
    let end = before
    // The bytes that follow the chunk in the file and end its last line: the
    // cut line's end first, then the earlier chunk's first (partial) segment.
    let carry = Buffer.concat(ends)
    let scanned = 0
    while (end > stopAt && scanned < budget) {
      const start = Math.max(stopAt, end - chunk)
      const buf = await at(start, end - start)
      if (!buf) return null
      scanned += buf.length
      const all = carry.length ? Buffer.concat([buf, carry]) : buf
      // Every segment between newlines is a whole line, last first, except
      // the one before the first newline when the chunk does not start at a
      // line's start (the file's, or stopAt): that line begins earlier and
      // is carried to the next chunk.
      let lineEnd = all.length
      for (;;) {
        const nl = all.lastIndexOf(10, lineEnd - 1)
        if (nl < 0 && start > stopAt) {
          carry = all.subarray(0, lineEnd)
          break
        }
        const segment = all.subarray(nl + 1, lineEnd)
        if (segment.length && maybe(segment)) {
          const text = segment.toString('utf8').replace(/\r$/, '')
          if (isPromptLine(text)) return text
        }
        if (nl <= 0) {
          carry = Buffer.alloc(0)
          break
        }
        lineEnd = nl
      }
      end = start
    }
    return null
  } catch {
    return null
  } finally {
    await fh.close().catch(() => {})
  }
}
