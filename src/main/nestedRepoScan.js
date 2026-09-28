// "Browse folder" on a folder that holds several repositories: find them,
// bounded, like Orca (MIT, Copyright (c) 2026 Lovecast Inc.):
// src/main/project-groups/nested-repo-discovery.ts and
// nested-repo-scan-rules.ts.
//
// Breadth-first from the chosen folder: a child with a .git marker (or a bare
// repository's HEAD/objects/refs) is a repository and is not entered (nested
// repos stay hidden, as in Orca); other folders are entered up to maxDepth.
// Skipped: VCS metadata folders, node_modules and other build output, hidden
// folders below the first level (a hidden folder directly in the chosen
// folder, like ~/.nvm, is looked into, as Orca does), symlinks, and what the
// folders' .gitignore files exclude.
//
// Tessel's additions, so a scan always ends: a time limit by default (Orca's
// is off unless asked), at most MAX_ENTRIES_PER_DIR entries read per folder
// (read one by one, never listed in full first) and at most MAX_FOLDERS
// folders read in all. Any limit reached marks the result truncated/timedOut.
import fsp from 'fs/promises'
import { basename, join } from 'path'

export const DEFAULT_MAX_DEPTH = 3
export const DEFAULT_MAX_REPOS = 100
export const DEFAULT_TIMEOUT_MS = 30000
export const MAX_ENTRIES_PER_DIR = 5000
export const MAX_FOLDERS = 5000

const SKIPPED_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.cache', 'vendor', '__pycache__', '.turbo', '.parcel-cache'])
const VCS_METADATA_DIRS = new Set(['.git', '.svn', '.hg', '.jj', '.sl', '.repo', 'CVS'])

export function normalizeScanOptions(options) {
  const raw = options && typeof options === 'object' ? options : {}
  const num = (v) => typeof v === 'number' && Number.isFinite(v)
  return {
    maxDepth: num(raw.maxDepth) ? Math.max(1, Math.min(8, Math.floor(raw.maxDepth))) : DEFAULT_MAX_DEPTH,
    maxRepos: num(raw.maxRepos) ? Math.max(1, Math.min(500, Math.floor(raw.maxRepos))) : DEFAULT_MAX_REPOS,
    timeoutMs: num(raw.timeoutMs) ? Math.max(500, Math.min(30000, Math.floor(raw.timeoutMs))) : DEFAULT_TIMEOUT_MS
  }
}

function shouldSkipDirectory(name, depth) {
  if (VCS_METADATA_DIRS.has(name)) return true
  if (SKIPPED_DIRS.has(name)) return true
  return depth > 0 && name.startsWith('.')
}

// --- .gitignore rules (Orca's matcher: no regular expressions, bounded) ------
function compileGlobSegment(pattern) {
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern
  return { pattern }
}

function globSegmentMatches(segment, value) {
  if (typeof segment === 'string') return segment === value
  const { pattern } = segment
  let p = 0
  let v = 0
  let star = -1
  let starMatch = 0
  // Retry only the latest star: no combinatorial backtracking.
  while (v < value.length) {
    const token = pattern[p]
    if (token === '*') {
      star = p++
      starMatch = v
    } else if (token === value[v] || (token === '?' && value[v] !== '/')) {
      p++
      v++
    } else if (star !== -1 && value[starMatch] !== '/') {
      p = star + 1
      v = ++starMatch
    } else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}

function pathSegmentsMatch(patternSegments, candidate, memoize) {
  const stride = candidate.length + 1
  const visited = memoize ? new Map() : null
  const from = (pi, ci) => {
    if (pi >= patternSegments.length) return ci >= candidate.length
    const key = pi * stride + ci
    if (visited && visited.has(key)) return visited.get(key)
    const pattern = patternSegments[pi]
    const matched =
      pattern === '**'
        ? from(pi + 1, ci) || (ci < candidate.length && from(pi, ci + 1))
        : ci < candidate.length && globSegmentMatches(pattern, candidate[ci] ?? '') && from(pi + 1, ci + 1)
    if (visited) visited.set(key, matched)
    return matched
  }
  return from(0, 0)
}

function compilePathSegments(pattern) {
  const out = []
  for (const segment of pattern.split('/')) {
    if (segment === '**') {
      if (out[out.length - 1] !== '**') out.push(segment)
      continue
    }
    out.push(compileGlobSegment(segment))
  }
  return out
}

export function parseGitignoreRules(content, baseSegments) {
  return String(content)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((line) => {
      const negate = line.startsWith('!')
      const unprefixed = negate ? line.slice(1) : line
      const anchored = unprefixed.startsWith('/')
      const pattern = unprefixed.replace(/^\/+/, '').replace(/\/+$/, '')
      const basenameOnly = !anchored && !pattern.includes('/')
      const segmentPatterns = basenameOnly ? [compileGlobSegment(pattern)] : compilePathSegments(pattern)
      return {
        pattern,
        segmentPatterns,
        memoizePathWalk: segmentPatterns.filter((s) => s === '**').length > 1,
        negate,
        basenameOnly,
        baseSegments
      }
    })
    .filter((r) => r.pattern.length > 0)
}

export function isIgnoredDirectory(name, segments, rules) {
  let ignored = false
  for (const rule of rules) {
    if (segments.length <= rule.baseSegments.length) continue
    const rel = segments.slice(rule.baseSegments.length)
    const matches = rule.basenameOnly
      ? rel.some((s) => globSegmentMatches(rule.segmentPatterns[0], s))
      : pathSegmentsMatch(rule.segmentPatterns, rel, rule.memoizePathWalk)
    if (matches) ignored = !rule.negate
  }
  return ignored || shouldSkipDirectory(name, segments.length - 1)
}

// --- The local filesystem ------------------------------------------------------
async function hasGitMarker(dirPath) {
  try {
    const marker = await fsp.stat(join(dirPath, '.git'))
    if (marker.isDirectory() || marker.isFile()) return true
  } catch {
    // Not a work tree: maybe a bare repository.
  }
  const [head, objects, refs] = await Promise.all([
    fsp.stat(join(dirPath, 'HEAD')).catch(() => null),
    fsp.stat(join(dirPath, 'objects')).catch(() => null),
    fsp.stat(join(dirPath, 'refs')).catch(() => null)
  ])
  return !!(head && head.isFile() && objects && objects.isDirectory() && refs && refs.isDirectory())
}

// Entry by entry (Dirent: no stat per child, symlinks seen as such), at most
// `limit` of them. -> { entries, truncated }
async function readLocalDirectory(dirPath, limit) {
  const entries = []
  let truncated = false
  const dir = await fsp.opendir(dirPath)
  try {
    for await (const e of dir) {
      if (entries.length >= limit) {
        truncated = true
        break
      }
      entries.push({ name: e.name, isDirectory: e.isDirectory(), isSymlink: e.isSymbolicLink() })
    }
  } finally {
    // A for-await that ran to the end closed it already.
    await dir.close().catch(() => {})
  }
  return { entries, truncated }
}

export function localScanFilesystem({ isGitRepo } = {}) {
  return {
    readDirectory: (p) => readLocalDirectory(p, MAX_ENTRIES_PER_DIR),
    readTextFile: async (p) => {
      // A .gitignore is small; a huge one is not read.
      const st = await fsp.stat(p)
      if (st.size > 256 * 1024) return ''
      return fsp.readFile(p, 'utf8')
    },
    joinPath: join,
    basename,
    hasGitMarker,
    isSelectedPathGitRepo: async (p) => (isGitRepo ? (await isGitRepo(p)) || (await hasGitMarker(p)) : hasGitMarker(p))
  }
}

// -> { selectedPath, selectedPathKind: 'git_repo' | 'non_git_folder', repos:
//      [{ path, displayName, depth }], truncated, timedOut, stopped,
//      durationMs, maxDepth, maxRepos, timeoutMs }
export async function scanNestedRepos({ path, options, filesystem, signal, onProgress, now = () => Date.now() }) {
  const startedAt = now()
  const opts = normalizeScanOptions(options)
  const fsys = filesystem || localScanFilesystem()
  const repos = []
  let truncated = false
  let timedOut = false
  let stopped = false
  let foldersRead = 0
  const result = (kind) => ({
    selectedPath: path,
    selectedPathKind: kind,
    repos: repos.map((r) => ({ ...r })),
    truncated,
    timedOut,
    stopped,
    durationMs: now() - startedAt,
    maxDepth: opts.maxDepth,
    maxRepos: opts.maxRepos,
    timeoutMs: opts.timeoutMs
  })
  const aborted = () => {
    if (!signal || !signal.aborted) return false
    stopped = true
    return true
  }
  const overTime = () => opts.timeoutMs !== null && now() - startedAt > opts.timeoutMs

  if (await fsys.isSelectedPathGitRepo(path)) return result('git_repo')
  if (aborted()) return result('non_git_folder')

  const queue = [{ path, depth: 0, segments: [], ignoreRules: [] }]
  let next = 0
  while (next < queue.length) {
    if (repos.length >= opts.maxRepos) {
      truncated = true
      break
    }
    if (overTime()) {
      timedOut = true
      break
    }
    if (aborted()) break
    if (foldersRead >= MAX_FOLDERS) {
      truncated = true
      break
    }
    const folder = queue[next]
    queue[next++] = undefined
    if (next >= 64 && next * 2 >= queue.length) {
      queue.splice(0, next)
      next = 0
    }
    if (folder.depth > opts.maxDepth) continue

    let listing
    try {
      foldersRead++
      listing = await fsys.readDirectory(folder.path)
    } catch {
      continue
    }
    if (aborted()) break
    const entries = Array.isArray(listing) ? listing : listing.entries
    if (listing && listing.truncated) truncated = true
    let rules = folder.ignoreRules
    if (fsys.readTextFile && entries.some((e) => e.name === '.gitignore')) {
      try {
        rules = [...rules, ...parseGitignoreRules(await fsys.readTextFile(fsys.joinPath(folder.path, '.gitignore')), folder.segments)]
      } catch {
        // An unreadable .gitignore excludes nothing.
      }
    }
    const dirs = entries.filter((e) => e.isDirectory && !e.isSymlink).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of dirs) {
      if (repos.length >= opts.maxRepos) {
        truncated = true
        break
      }
      if (overTime()) {
        timedOut = true
        break
      }
      if (aborted()) break
      const segments = [...folder.segments, entry.name]
      if (isIgnoredDirectory(entry.name, segments, rules)) continue
      const childPath = fsys.joinPath(folder.path, entry.name)
      const isRepo = await fsys.hasGitMarker(childPath)
      if (aborted()) break
      if (isRepo) {
        repos.push({ path: childPath, displayName: fsys.basename(childPath), depth: folder.depth + 1 })
        if (onProgress) onProgress(result('non_git_folder'))
        continue
      }
      // Nearby sibling repos first: breadth-first, not into an early deep folder.
      if (folder.depth < opts.maxDepth) queue.push({ path: childPath, depth: folder.depth + 1, segments, ignoreRules: rules })
    }
    if (stopped || timedOut || (truncated && repos.length >= opts.maxRepos)) break
  }
  return result('non_git_folder')
}
