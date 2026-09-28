// Filesystem guards for managed Claude auth. Paths and file contents never
// appear in public errors. No caller-supplied path is read from account metadata.
import fs from 'fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path'
import { randomUUID } from 'crypto'

const LIMIT = 8 * 1024 * 1024
const fold = (path) => (process.platform === 'win32' ? path.toLowerCase() : path)
export const contained = (root, path) => {
  const rel = relative(root, path)
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
export const authError = (message = 'Claude account storage is unavailable or invalid.') =>
  Object.assign(new Error(message), { safeClaudeAccountError: true })

// Check every existing ancestor, including junctions, before reading or writing.
export async function inspect(path, directory = false) {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const parts = relative(root, absolute).split(sep).filter(Boolean)
  let current = root
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index])
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw authError()
    }
    const isDir = index < parts.length - 1 || directory
    if (stat.isSymbolicLink() || (isDir ? !stat.isDirectory() : !stat.isFile())) throw authError()
    if (!isDir && stat.nlink > 1) throw authError()
    if (index === parts.length - 1) {
      if (fold(resolve(await fs.realpath(current))) !== fold(current)) throw authError()
      return stat
    }
  }
  return fs.lstat(root)
}

export async function ensureDirectory(path) {
  if (await inspect(path, true)) return
  await ensureDirectory(dirname(resolve(path)))
  try {
    await fs.mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw authError()
  }
  if (!(await inspect(path, true))) throw authError()
}

export async function readText(path) {
  const before = await inspect(path)
  if (!before) return null
  if (before.size > LIMIT) throw authError()
  let file
  try {
    file = await fs.open(path, 'r')
    const opened = await file.stat()
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
      throw authError()
    const text = await file.readFile('utf8')
    const after = await inspect(path)
    if (
      !after ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw authError()
    return text
  } finally {
    await file?.close()
  }
}

export function jsonObject(text) {
  try {
    const value = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {
    /* Do not include the raw JSON or parser error. */
  }
  throw authError()
}

export async function writeText(path, contents, expected = undefined) {
  const before = await readText(path)
  if (expected !== undefined && before !== expected)
    throw authError(
      'Claude account files changed during the operation. Retry after other logins finish.'
    )
  if (before === contents) return
  if (contents === null) {
    if (before !== null) await fs.unlink(path)
    return
  }
  await ensureDirectory(dirname(path))
  const temporary = join(dirname(path), `.tessel-auth-${randomUUID()}.tmp`)
  let file
  try {
    file = await fs.open(temporary, 'wx', 0o600)
    await file.writeFile(contents, 'utf8')
    await file.sync()
    await file.close()
    file = null
    if ((await readText(path)) !== before)
      throw authError(
        'Claude account files changed during the operation. Retry after other logins finish.'
      )
    await fs.rename(temporary, path)
  } finally {
    await file?.close()
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw authError()
    })
  }
}

export async function exclusiveText(path, contents) {
  await ensureDirectory(dirname(path))
  if (await inspect(path)) throw authError('A Claude account operation is awaiting recovery.')
  let file
  try {
    file = await fs.open(path, 'wx', 0o600)
    await file.writeFile(contents, 'utf8')
    await file.sync()
  } finally {
    await file?.close()
  }
}

export async function ownedDirectory(root, path, marker, identity) {
  if (!contained(resolve(root), resolve(path))) throw authError()
  if (!(await inspect(path, true))) return false
  const canonicalRoot = await fs.realpath(root)
  const canonicalPath = await fs.realpath(path)
  if (
    !contained(canonicalRoot, canonicalPath) ||
    (await readText(join(path, marker))) !== `${identity}\n`
  )
    throw authError()
  return true
}

// Validate the entire owned tree first; never recurse through a link or junction.
export async function removeOwnedDirectory(root, path, marker, identity) {
  if (!(await ownedDirectory(root, path, marker, identity))) return
  const entries = []
  async function walk(directory, depth) {
    if (depth > 12 || entries.length > 4096) throw authError()
    await inspect(directory, true)
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw authError()
      if (entry.isDirectory()) await walk(child, depth + 1)
      else {
        if (!entry.isFile() || !(await inspect(child))) throw authError()
        entries.push([child, false])
      }
    }
    entries.push([directory, true])
  }
  await walk(path, 0)
  if (!(await ownedDirectory(root, path, marker, identity))) throw authError()
  for (const [entry, directory] of entries) {
    if (!contained(resolve(root), resolve(entry))) throw authError()
    await inspect(entry, directory)
    if (directory) await fs.rmdir(entry)
    else await fs.unlink(entry)
  }
}
