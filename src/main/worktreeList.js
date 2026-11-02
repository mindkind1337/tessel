// The git worktrees of a project (the other checkouts of its repository),
// for the left sidebar. Read-only: one `git worktree list --porcelain`, with
// the repository's own program-running settings off (gitSafety.js), and only
// for a folder that is an open project (the layout's local project folders
// and the repositories of a folder imported as a group:
// the renderer's word alone is never enough to run git somewhere).
import fs from 'fs'
import { isAbsolute, resolve, sep } from 'path'
import { run as defaultRun } from './agentTools'
import { localGitArgs as defaultGitArgs } from './gitSafety'

export const MAX_WORKTREES = 200
const MAX_ROOTS = 200
const MAX_PATH = 1024

// `git worktree list --porcelain` -> [{ path, branch, head, isMain, locked,
// prunable }] (after Orca's src/shared/git-worktree-porcelain-parser.ts, MIT,
// Copyright (c) 2026 Lovecast Inc.). branch: the short name ('' when
// detached); git lists the main working tree first; a bare entry is no
// checkout and is left out.
export function parseWorktreeList(text, max = MAX_WORKTREES) {
  const out = []
  let first = true
  for (const block of String(text || '').trim().split(/\r?\n\r?\n/)) {
    let path = ''
    let head = ''
    let branch = ''
    let bare = false
    let locked = false
    let prunable = false
    for (const line of block.trim().split(/\r?\n/)) {
      if (line.startsWith('worktree ')) path = line.slice(9)
      else if (line.startsWith('HEAD ')) head = line.slice(5).trim()
      else if (line.startsWith('branch ')) branch = line.slice(7).trim()
      else if (line === 'bare') bare = true
      else if (line === 'locked' || line.startsWith('locked ')) locked = true
      // Git 2.36+: a registration whose folder is gone.
      else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true
    }
    if (!path) continue
    const isMain = first
    first = false
    if (bare) continue
    if (out.length >= max) break
    out.push({ path, branch: branch.replace(/^refs\/heads\//, ''), head, isMain, locked, prunable })
  }
  return out
}

function norm(p) {
  const x = resolve(p)
  return process.platform === 'win32' ? x.toLowerCase() : x
}

// The layout's project folders on this computer (a remote project has none).
export function localRootsOfLayout(data) {
  const list = data && typeof data === 'object' && Array.isArray(data.workspaces) ? data.workspaces : []
  const out = []
  for (const w of list.slice(0, MAX_ROOTS)) {
    const cwd = w && !w.remote ? w.cwd : null
    if (typeof cwd !== 'string' || !cwd || cwd.length > MAX_PATH || !isAbsolute(cwd)) continue
    const key = norm(cwd)
    if (!out.includes(key)) out.push(key)
  }
  return out
}

// The folders the person chose on this computer: those an agent may be pre-trusted in. A project
// that came with a copy of the settings has its folder named by that copy, not by a person here:
// the agent asks (settingsBackup.js marks it when the copy is put in place).
export function chosenRootsOfLayout(data) {
  const list = data && typeof data === 'object' && Array.isArray(data.workspaces) ? data.workspaces : []
  return localRootsOfLayout({ workspaces: list.filter((w) => !w || w.fromCopy !== true) })
}

// The folders whose worktrees may be listed: the local project folders and
// the repositories of a folder imported as a group (inside that folder).
export function localRepoRootsOfLayout(data) {
  const out = localRootsOfLayout(data)
  const list = data && typeof data === 'object' && Array.isArray(data.workspaces) ? data.workspaces : []
  for (const w of list.slice(0, MAX_ROOTS)) {
    const cwd = w && !w.remote ? w.cwd : null
    const repos = w && w.group && Array.isArray(w.group.repos) ? w.group.repos : []
    if (typeof cwd !== 'string' || !cwd || !isAbsolute(cwd)) continue
    const parent = norm(cwd)
    for (const repo of repos.slice(0, MAX_ROOTS)) {
      const path = repo && repo.path
      if (typeof path !== 'string' || !path || path.length > MAX_PATH || !isAbsolute(path)) continue
      const key = norm(path)
      const inside = key.startsWith(parent.endsWith(sep) ? parent : parent + sep)
      if (inside && !out.includes(key) && out.length < MAX_ROOTS * 2) out.push(key)
    }
  }
  return out
}

export function createWorktreeList({ run = defaultRun, gitArgs = defaultGitArgs, exists = fs.existsSync } = {}) {
  let roots = []
  return {
    setRoots(list) {
      roots = Array.isArray(list) ? list.slice(0, MAX_ROOTS * 2) : []
    },
    // -> { ok: true, worktrees } | { ok: false, error: 'invalid' | 'unknown-folder' | 'not-repo' | 'failed' }
    async list(cwd) {
      if (typeof cwd !== 'string' || !cwd || cwd.length > MAX_PATH || cwd.includes('\0') || !isAbsolute(cwd))
        return { ok: false, error: 'invalid' }
      if (!roots.includes(norm(cwd))) return { ok: false, error: 'unknown-folder' }
      if (!exists(cwd)) return { ok: false, error: 'not-repo' }
      const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 10000 })
      const root = top.ok ? top.stdout.trim() : ''
      if (!root) return { ok: false, error: 'not-repo' }
      // Nobody clicked for this: a repository not yet trusted is never asked
      // about here, its settings just stay off.
      const safety = await gitArgs(root, { ask: false })
      const res = await run('git', ['-C', root, ...safety, 'worktree', 'list', '--porcelain'], { timeout: 15000 })
      if (!res.ok) return { ok: false, error: 'failed' }
      // Git writes C:/x/y on Windows: shown and opened as C:\x\y, like every other folder.
      const native = (p) => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p)
      return { ok: true, worktrees: parseWorktreeList(res.stdout).map((w) => ({ ...w, path: native(w.path) })) }
    }
  }
}
