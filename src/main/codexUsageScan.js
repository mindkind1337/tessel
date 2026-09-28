import fs from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'

const FORMAT = 1
const CHUNK = 64 * 1024
const FINGERPRINT = 4096
const MAX_LINE = 2 * 1024 * 1024
const MAX_DEPTH = 8
const CACHE_LIMIT = 128 * 1024 * 1024

const clone = (value) => JSON.parse(JSON.stringify(value))
const identity = (value) => ({
  size: value.size,
  mtimeMs: value.mtimeMs,
  ctimeMs: value.ctimeMs,
  birthtimeMs: value.birthtimeMs,
  ino: value.ino,
  dev: value.dev
})
const sameFile = (a, b) => a.ino === b.ino && a.dev === b.dev && a.birthtimeMs === b.birthtimeMs
const sameSnapshot = (a, b) =>
  sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
const under = (parent, child) => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
const errorCode = (error) => error?.code || 'read failed'

/** Incremental, read-only transcript scanner. The caller owns all parser semantics. */
export function createCodexUsageScanner({
  root,
  cacheFile,
  makeState,
  consumeLine,
  validateState,
  cacheVersion = 1
}) {
  const sourceRoot = resolve(root)
  const roots = ['sessions', 'archived_sessions'].map((name) => resolve(sourceRoot, name))
  const rootKey = process.platform === 'win32' ? sourceRoot.toLowerCase() : sourceRoot
  let entries = new Map()
  let loaded = false
  let cacheDirty = false
  let running

  function validEntry(entry) {
    return (
      entry &&
      typeof entry.path === 'string' &&
      isAbsolute(entry.path) &&
      roots.some((base) => under(base, entry.path)) &&
      /(?:^|[\\/])rollout-[^\\/]+\.jsonl$/.test(entry.path) &&
      entry.meta &&
      ['size', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'ino', 'dev'].every((key) =>
        Number.isFinite(entry.meta[key])
      ) &&
      Number.isSafeInteger(entry.cursor) &&
      entry.cursor >= 0 &&
      entry.cursor <= entry.meta.size &&
      Array.isArray(entry.fingerprints) &&
      entry.fingerprints.length <= 2 &&
      entry.fingerprints.every(
        (part) =>
          Number.isSafeInteger(part.start) &&
          part.start >= 0 &&
          Number.isSafeInteger(part.length) &&
          part.length > 0 &&
          part.length <= FINGERPRINT &&
          part.start + part.length <= entry.meta.size &&
          /^[a-f0-9]{64}$/.test(part.hash)
      ) &&
      (entry.meta.size === 0 || entry.fingerprints.length > 0) &&
      Array.isArray(entry.warnings) &&
      entry.warnings.every((warning) => typeof warning === 'string') &&
      validateState(entry.state)
    )
  }

  async function loadCache(warnings) {
    if (loaded) return
    loaded = true
    if (!cacheFile) return
    try {
      const stat = await fs.lstat(cacheFile)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CACHE_LIMIT)
        throw new Error('invalid cache file')
      const value = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
      if (
        value.format !== FORMAT ||
        value.version !== cacheVersion ||
        value.root !== rootKey ||
        !Array.isArray(value.files) ||
        !value.files.every(validEntry)
      )
        throw new Error('incompatible cache')
      entries = new Map(value.files.map((entry) => [entry.path, entry]))
    } catch (error) {
      cacheDirty = true
      if (error.code !== 'ENOENT') warnings.push(`Usage cache rebuilt (${errorCode(error)}).`)
    }
  }

  async function discover(warnings) {
    const files = []
    const unavailable = []
    async function walk(path, depth, optional = false) {
      let verified = false
      try {
        const stat = await fs.lstat(path)
        verified = true
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          warnings.push(`Skipped non-regular transcript directory: ${path}`)
          return
        }
        if (depth > MAX_DEPTH) {
          unavailable.push(path)
          warnings.push(`Transcript directory exceeds scan depth ${MAX_DEPTH}: ${path}`)
          return
        }
        const dir = await fs.opendir(path)
        for await (const item of dir) {
          const child = resolve(path, item.name)
          if (item.isSymbolicLink()) {
            warnings.push(`Skipped transcript link: ${child}`)
          } else if (item.isDirectory()) {
            await walk(child, depth + 1)
          } else if (/^rollout-.+\.jsonl$/.test(item.name)) {
            if (item.isFile()) files.push(child)
            else warnings.push(`Skipped non-regular transcript file: ${child}`)
          }
        }
      } catch (error) {
        if (optional && !verified && error.code === 'ENOENT') return
        unavailable.push(path)
        warnings.push(`Transcript directory unavailable (${errorCode(error)}): ${path}`)
      }
    }
    try {
      const stat = await fs.lstat(sourceRoot)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a regular directory')
    } catch (error) {
      warnings.push(`Codex home unavailable; retaining cached usage (${errorCode(error)}).`)
      return { files, unavailable: [sourceRoot] }
    }
    for (const path of roots) await walk(path, 0, true)
    files.sort()
    return { files, unavailable }
  }

  async function readAt(handle, start, length, stats) {
    const data = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await handle.read(data, read, length - read, start + read)
      if (!bytesRead) throw new Error('transcript changed during read')
      read += bytesRead
      stats.bytesRead += bytesRead
    }
    return data
  }

  async function fingerprints(handle, size, stats, previous) {
    const ranges =
      previous ||
      (size === 0
        ? []
        : [
            { start: 0, length: Math.min(size, FINGERPRINT) },
            ...(size > FINGERPRINT
              ? [
                  {
                    start: Math.max(FINGERPRINT, size - FINGERPRINT),
                    length: Math.min(size - FINGERPRINT, FINGERPRINT)
                  }
                ]
              : [])
          ])
    const values = []
    for (const part of ranges) {
      const data = await readAt(handle, part.start, part.length, stats)
      values.push({
        start: part.start,
        length: part.length,
        hash: createHash('sha256').update(data).digest('hex')
      })
    }
    return values
  }
  const equalPrints = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  async function parseFile(path, old, stats) {
    const pathStat = await fs.lstat(path)
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error('not a regular file')
    const meta = identity(pathStat)
    if (old && sameSnapshot(meta, old.meta)) {
      stats.reused++
      return old
    }
    const handle = await fs.open(path, 'r')
    try {
      const openedStat = await handle.stat()
      if (!openedStat.isFile() || !sameSnapshot(meta, identity(openedStat)))
        throw new Error('transcript changed before read')
      const before = await fingerprints(handle, meta.size, stats)
      const append =
        old &&
        meta.size > old.meta.size &&
        sameFile(meta, old.meta) &&
        equalPrints(
          old.fingerprints,
          await fingerprints(handle, old.meta.size, stats, old.fingerprints)
        )
      const state = append ? clone(old.state) : makeState(path)
      const fileWarnings = append ? [...old.warnings] : []
      let cursor = append ? old.cursor : 0
      let position = cursor
      let parts = []
      let lineBytes = 0
      let tooLong = false
      while (position < meta.size) {
        const chunk = await readAt(handle, position, Math.min(CHUNK, meta.size - position), stats)
        let start = 0
        while (start < chunk.length) {
          const end = chunk.indexOf(10, start)
          const stop = end < 0 ? chunk.length : end
          const length = stop - start
          lineBytes += length
          if (!tooLong && lineBytes > MAX_LINE) {
            tooLong = true
            parts = []
            const warning = `Skipped transcript line larger than ${MAX_LINE} bytes: ${path}`
            if (!fileWarnings.includes(warning)) fileWarnings.push(warning)
          }
          if (!tooLong && length) parts.push(chunk.subarray(start, stop))
          if (end < 0) break
          if (!tooLong)
            consumeLine(Buffer.concat(parts, lineBytes).toString('utf8').replace(/\r$/, ''), state)
          cursor = position + end + 1
          parts = []
          lineBytes = 0
          tooLong = false
          start = end + 1
        }
        position += chunk.length
      }
      const after = identity(await handle.stat())
      const current = await fs.lstat(path)
      if (
        !sameFile(meta, after) ||
        after.size < meta.size ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        !sameFile(meta, identity(current)) ||
        !equalPrints(before, await fingerprints(handle, meta.size, stats)) ||
        (append &&
          !equalPrints(
            old.fingerprints,
            await fingerprints(handle, old.meta.size, stats, old.fingerprints)
          ))
      )
        throw new Error('transcript changed during read')
      if (!validateState(state)) throw new Error('invalid parsed usage state')
      stats.read++
      if (append) stats.appended++
      return { path, meta, cursor, fingerprints: before, state, warnings: fileWarnings }
    } finally {
      await handle.close()
    }
  }

  async function saveCache(warnings) {
    if (!cacheFile || !cacheDirty) return
    const temporary = `${cacheFile}.${randomUUID()}.tmp`
    try {
      await fs.mkdir(dirname(cacheFile), { recursive: true })
      const data = JSON.stringify({
        format: FORMAT,
        version: cacheVersion,
        root: rootKey,
        files: [...entries.values()]
      })
      if (Buffer.byteLength(data) > CACHE_LIMIT) throw new Error('cache exceeds size limit')
      await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, cacheFile)
      cacheDirty = false
    } catch (error) {
      warnings.push(
        `Usage cache could not be saved (${errorCode(error)}); parsed usage remains available.`
      )
    } finally {
      await fs.unlink(temporary).catch(() => {})
    }
  }

  async function run() {
    const warnings = []
    const stats = { files: 0, read: 0, reused: 0, appended: 0, bytesRead: 0 }
    await loadCache(warnings)
    const { files, unavailable } = await discover(warnings)
    const next = new Map()
    for (const path of files) {
      const old = entries.get(path)
      try {
        const entry = await parseFile(path, old, stats)
        next.set(path, entry)
      } catch (error) {
        if (old) next.set(path, old)
        warnings.push(
          `Transcript usage ${old ? 'stale' : 'unavailable'} (${errorCode(error)}): ${path}`
        )
      }
    }
    for (const [path, entry] of entries) {
      if (!next.has(path) && unavailable.some((base) => under(base, path))) next.set(path, entry)
    }
    if (
      next.size !== entries.size ||
      [...next].some(([path, entry]) => entries.get(path) !== entry)
    )
      cacheDirty = true
    entries = new Map([...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    for (const entry of entries.values()) warnings.push(...entry.warnings)
    stats.files = entries.size
    await saveCache(warnings)
    return {
      files: [...entries.values()].map(({ path, state }) => ({ path, state: clone(state) })),
      stats,
      warnings
    }
  }

  return function scan() {
    if (!running)
      running = run().finally(() => {
        running = null
      })
    return running
  }
}
