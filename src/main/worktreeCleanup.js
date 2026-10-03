// The git evidence of a project's other worktrees, for the Clean up worktrees
// dialog (after Orca's workspace cleanup scan and its git evidence, MIT,
// Copyright (c) 2026 Lovecast Inc.): for each one, is it clean, is its branch
// merged into the default branch, how far ahead or behind, its last commit
// and when it was last touched. Read-only: the deleting goes through
// review.js reviewRemove, one worktree at a time.
//
// Only for an open project (worktreeList.js checks the folder), git always
// run with argument arrays and the repository's program-running settings off
// (gitSafety.js).
import fs from 'fs'
import { join } from 'path'
import { run as defaultRun } from './agentTools'
import { localGitArgs as defaultGitArgs } from './gitSafety'

const CONCURRENCY = 4
const GIT_TIMEOUT = 15000

// The repository's default branch: origin's HEAD when a local branch of that
// name exists, else main or master, else the main checkout's branch.
// -> a local branch name, or null.
export async function defaultBranchOf(git, mainBranch) {
  const has = async (name) => (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).ok
  const origin = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (origin.ok) {
    const name = origin.stdout.trim().replace(/^origin\//, '')
    if (name && (await has(name))) return name
  }
  for (const name of ['main', 'master']) if (await has(name)) return name
  return mainBranch || null
}

// `git rev-list --left-right --count A...B` -> { behind, ahead } of B against A.
export function parseLeftRight(text) {
  const m = String(text || '')
    .trim()
    .match(/^(\d+)\s+(\d+)$/)
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : { behind: null, ahead: null }
}

// `git status --porcelain=v1` -> how many paths changed (untracked included).
export function countStatus(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim()).length
}

function mtimeOf(stat, path) {
  try {
    return stat(path).mtimeMs || 0
  } catch {
    return 0
  }
}

async function inBatches(items, size, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
  return out
}

// One worktree ({ path, branch, head, locked, prunable } from worktreeList)
// -> its evidence. git(cwd, args) runs git there with the safety arguments.
export async function worktreeEvidence(wt, { git, defaultBranch, exists = fs.existsSync, stat = fs.statSync } = {}) {
  const ev = {
    path: wt.path,
    branch: wt.branch || '',
    head: wt.head || '',
    detached: !wt.branch,
    locked: !!wt.locked,
    missing: !!wt.prunable || !exists(wt.path),
    onDefault: !!wt.branch && wt.branch === defaultBranch,
    dirty: null,
    changes: 0,
    merged: null,
    ahead: null,
    behind: null,
    lastCommitAt: 0,
    lastCommitSubject: '',
    activityAt: 0
  }
  const ref = wt.branch ? `refs/heads/${wt.branch}` : wt.head
  // Merge state and commits come from the repository, even when the folder is gone.
  if (ref && defaultBranch) {
    const [anc, lr] = await Promise.all([
      git(null, ['merge-base', '--is-ancestor', ref, `refs/heads/${defaultBranch}`]),
      git(null, ['rev-list', '--left-right', '--count', `refs/heads/${defaultBranch}...${ref}`])
    ])
    ev.merged = anc.code === 0 ? true : anc.code === 1 ? false : null
    Object.assign(ev, parseLeftRight(lr.ok ? lr.stdout : ''))
  }
  if (ref) {
    const log = await git(null, ['log', '-1', '--format=%ct%x1f%s', ref, '--'])
    if (log.ok) {
      const [ct, subject] = log.stdout.trim().split('\x1f')
      ev.lastCommitAt = (Number(ct) || 0) * 1000
      ev.lastCommitSubject = String(subject || '').slice(0, 200)
    }
  }
  let touched = 0
  if (!ev.missing) {
    // When git last wrote to this checkout (its index, its HEAD), read
    // before git status refreshes the index.
    const dir = await git(wt.path, ['rev-parse', '--absolute-git-dir'])
    if (dir.ok && dir.stdout.trim()) {
      const gd = dir.stdout.trim()
      touched = Math.max(mtimeOf(stat, join(gd, 'index')), mtimeOf(stat, join(gd, 'HEAD')))
    }
    const st = await git(wt.path, ['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=none'])
    if (st.ok) {
      ev.changes = countStatus(st.stdout)
      ev.dirty = ev.changes > 0
    }
  }
  ev.activityAt = Math.max(ev.lastCommitAt, touched)
  return ev
}

// list: worktreeList's list (it checks the folder is an open project).
export function createWorktreeCleanup({ list, run = defaultRun, gitArgs = defaultGitArgs, exists = fs.existsSync, stat = fs.statSync } = {}) {
  return {
    // -> { ok: true, root, defaultBranch, items: [evidence] } | { ok: false, error }
    async scan(cwd) {
      const res = await list(cwd)
      if (!res || !res.ok) return res || { ok: false, error: 'failed' }
      const main = res.worktrees.find((w) => w.isMain)
      if (!main) return { ok: false, error: 'not-repo' }
      const root = main.path
      const safety = await gitArgs(root, { ask: false })
      const git = (where, args) => run('git', ['-C', where || root, ...safety, ...args], { timeout: GIT_TIMEOUT })
      const defaultBranch = await defaultBranchOf((args) => git(null, args), main.branch)
      const others = res.worktrees.filter((w) => !w.isMain)
      const items = await inBatches(others, CONCURRENCY, (wt) => worktreeEvidence(wt, { git, defaultBranch, exists, stat }))
      return { ok: true, root, mainBranch: main.branch || '', defaultBranch, items, scannedAt: Date.now() }
    }
  }
}
