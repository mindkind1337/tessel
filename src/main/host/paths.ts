// Paths below an opened root, as the protocol carries them: arrays of names,
// each the base64 of its raw bytes (Linux names need not be UTF-8). `[]` is
// the root. Labels for people come from the host (`label`); when a label is
// needed for a path the host did not label, it is decoded here with
// replacement characters, never trusted as the real bytes.

export type RelPath = string[]

const NAME_MAX = 255
const PATH_MAX = 4096
const NAMES_MAX = 1024
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** The base64 name of one path component given as text (UTF-8). */
export function nameOf(label: string): string {
  return Buffer.from(label, 'utf8').toString('base64')
}

/** The text of one base64 name (lossy for bytes that are not UTF-8). */
export function labelOf(name: string): string {
  return Buffer.from(name, 'base64').toString('utf8')
}

/** A path below the root from a POSIX-style relative path (`a/b/c`); `''` or `.` is the root. */
export function relPathOf(relative: string): RelPath {
  const parts = relative.split('/').filter((p) => p !== '' && p !== '.')
  return parts.map(nameOf)
}

/** The POSIX-style relative text of a path (labels joined with `/`). */
export function relPathText(path: RelPath): string {
  return path.map(labelOf).join('/')
}

/** Whether `path` is `prefix` or below it. */
export function startsWith(path: RelPath, prefix: RelPath): boolean {
  if (prefix.length > path.length) return false
  for (let i = 0; i < prefix.length; i++) if (path[i] !== prefix[i]) return false
  return true
}

export const samePath = (a: RelPath, b: RelPath): boolean => a.length === b.length && startsWith(a, b)

/** A path as the host would accept it (shape only; the host checks it again). */
export function isRelPath(value: unknown): value is RelPath {
  if (!Array.isArray(value) || value.length > NAMES_MAX) return false
  let total = 0
  for (const name of value) {
    if (typeof name !== 'string' || !name || !BASE64.test(name)) return false
    const bytes = Buffer.from(name, 'base64')
    if (!bytes.length || bytes.length > NAME_MAX) return false
    const text = bytes.toString('latin1')
    if (text === '.' || text === '..' || text.includes('/') || text.includes('\0')) return false
    total += bytes.length + 1
  }
  return total <= PATH_MAX + 1
}

/** A key for maps: the names joined (base64 holds no `/`). */
export const pathKey = (path: RelPath): string => path.join('/')
