// Where a command runs from (the first match of `where.exe`), looked up for
// many commands at once. Tessel checks some 45 agent CLIs at startup: one
// where.exe each cost about 10 ms of the main thread per process start
// (Windows' CreateProcess runs on it), so the window froze for about half a
// second. Lookups asked in the same moment now share one where.exe.
import { basename } from 'path'

const NAME = /^[\w.@+-]+$/

// A where.exe line's file is this command: its name, or its name plus one
// extension (claude, claude.exe, claude.cmd).
function isCommandFile(file, name) {
  const base = basename(file).toLowerCase()
  if (base === name) return true
  return base.startsWith(name + '.') && !base.slice(name.length + 1).includes('.')
}

// where.exe's output for several names -> Map(name lowercased -> first path).
// where.exe lists each name's matches in PATH order, so the first line that is
// this command is the one that runs.
export function parseWhere(stdout, names) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const found = new Map()
  for (const raw of names) {
    const name = String(raw).toLowerCase()
    if (found.has(name)) continue
    const line = lines.find((l) => isCommandFile(l, name))
    if (line) found.set(name, line)
  }
  return found
}

// run(names) -> Promise<{ stdout }> (where.exe with these names; a name not
// found still leaves the others' lines). lookup(bin) -> Promise of the first
// path ('' when not found). Lookups made before the next turn of the event
// loop go in one where.exe (at most `max` names each).
export function createCommandLookup(run, { max = 64 } = {}) {
  let pending = null
  function flush() {
    const batch = pending
    pending = null
    const names = [...batch.keys()]
    for (let i = 0; i < names.length; i += max) {
      const part = names.slice(i, i + max)
      Promise.resolve()
        .then(() => run(part))
        .then(
          (res) => parseWhere(res && res.stdout, part),
          () => new Map()
        )
        .then((found) => {
          for (const name of part) for (const resolve of batch.get(name)) resolve(found.get(name) || '')
        })
    }
  }
  return function lookup(bin) {
    if (!bin || !NAME.test(bin)) return Promise.resolve('')
    const name = bin.toLowerCase()
    return new Promise((resolve) => {
      if (!pending) {
        pending = new Map()
        setImmediate(flush)
      }
      if (!pending.has(name)) pending.set(name, [])
      pending.get(name).push(resolve)
    })
  }
}
