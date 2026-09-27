// JSON files that must survive a crash or a kill mid-write (the dev build is
// restarted on every source change): written to a temp file, then renamed
// over the real one, keeping the previous good copy as <file>.bak. Reading
// falls back to that copy when the file is damaged, and keeps the damaged
// file aside (<file>.corrupt-<time>) instead of letting it be overwritten.
//
// `valid(data)` (optional) says whether parsed content has the expected
// shape; content that parses but fails it counts as damaged.
import fs from 'fs'

const anyShape = () => true

// The parsed content of `file` when it is good, else undefined.
function readGood(file, valid) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return undefined
    // A failed read says nothing about the contents. Falling back to an
    // older backup here could discard a successfully committed update.
    throw err
  }
  try {
    const data = JSON.parse(text)
    return valid(data) ? data : undefined
  } catch {
    return undefined
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Write `text` to `file` through a temp file + rename. On Windows the rename
// fails for a moment while another process (a team tool reading the file, an
// antivirus scan) has the file open: tried again for about half a second.
// The temp file never stays behind.
export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (err) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        try {
          fs.unlinkSync(tmp)
        } catch {
          // nothing left to clean
        }
        throw err
      }
      sleepSync(25)
    }
  }
}
const writeAtomic = writeFileAtomic

export function writeJsonSafe(file, data, valid = anyShape) {
  const text = JSON.stringify(data, null, 2)
  // Only a good file becomes the backup (a damaged one would replace the
  // last good copy), and the backup itself is replaced atomically.
  try {
    if (fs.existsSync(file) && readGood(file, valid) !== undefined) {
      writeAtomic(`${file}.bak`, fs.readFileSync(file, 'utf8'))
    }
  } catch {
    // no new backup this time; the previous one is still intact
  }
  writeAtomic(file, text)
}

// -> { data, from: 'file' | 'backup' | null, corrupt: path | null }
export function readJsonSafe(file, valid = anyShape) {
  let corrupt = null
  if (fs.existsSync(file)) {
    const data = readGood(file, valid)
    if (data !== undefined) return { data, from: 'file', corrupt }
    corrupt = `${file}.corrupt-${Date.now()}`
    try {
      fs.copyFileSync(file, corrupt)
    } catch {
      corrupt = null
    }
  }
  const bak = readGood(`${file}.bak`, valid)
  if (bak !== undefined) return { data: bak, from: 'backup', corrupt }
  return { data: null, from: null, corrupt }
}
