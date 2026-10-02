// Review and merge a task branch (step 3 of tasks). A task made "in its own
// copy" lives in <repo>.worktrees/<name> on branch agent/<name>. These read
// what the agent changed, check it can merge into the branch it came from,
// merge it into the project folder, or delete the copy.
//
// Every call re-checks its arguments against git itself: the paths and names
// come from the renderer and are only trusted once git confirms them.
import { join, dirname, basename, resolve, relative, isAbsolute } from 'path'
import fs from 'fs'
import { run } from './agentTools'
import {
  parseChangedFiles,
  parseCommits,
  parseMergeTree,
  parseStatusPaths,
  mergeBlocker
} from '../shared/diff'

const BRANCH_RE = /^agent\/[A-Za-z0-9._-]{1,80}$/
const REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,120}$/
const MAX_DIFF = 600 * 1024

const git = (cwd, args, opts) => run('git', ['-C', cwd, ...args], { timeout: 30000, ...opts })

function samePath(a, b) {
  const x = resolve(a)
  const y = resolve(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

// { root, path, branch, target } from the renderer -> checked values, or an error.
async function check({ root, path, branch, target } = {}) {
  if (typeof root !== 'string' || !root || !fs.existsSync(root)) return { error: 'The project folder is missing.' }
  const top = await git(root, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return { error: 'The project folder is not a git repository.' }
  const repo = top.stdout.trim()
  if (typeof branch !== 'string' || !BRANCH_RE.test(branch)) return { error: 'Not a task branch.' }
  if (typeof target !== 'string' || !REF_RE.test(target)) return { error: 'Unknown base branch.' }
  const out = { repo, branch, target, path: null }
  if (path) {
    // Only a copy that git lists for this repo, inside <repo>.worktrees.
    const base = join(dirname(repo), `${basename(repo)}.worktrees`)
    const rel = relative(base, resolve(path))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { error: 'Not a task copy of this project.' }
    const list = await git(repo, ['worktree', 'list', '--porcelain'])
    const rec = parseWorktrees(list.stdout).find((w) => samePath(w.path, path))
    // A listed copy must be the one on this branch: never pair copy A with
    // branch B.
    if (rec && rec.branch !== `refs/heads/${branch}`)
      return { error: `That copy is not on branch ${branch}.` }
    out.path = rec ? rec.path : resolve(path)
    out.listed = !!rec
  }
  return out
}

// `git worktree list --porcelain` -> [{ path, branch }] (branch: full ref, or null).
export function parseWorktrees(text) {
  const out = []
  let cur = null
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: null }
      out.push(cur)
    } else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7)
  }
  return out
}

async function refExists(repo, ref) {
  return (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok
}

// Everything the review screen shows about a task branch.
export async function reviewInfo(args) {
  const c = await check(args)
  if (c.error) return { ok: false, error: c.error }
  const { repo, branch, target } = c
  if (!(await refExists(repo, branch))) return { ok: false, error: `The branch ${branch} no longer exists.` }
  if (!(await refExists(repo, target))) return { ok: false, error: `The base branch ${target} no longer exists.` }

  const mb = await git(repo, ['merge-base', target, branch])
  if (!mb.ok) return { ok: false, error: `${branch} and ${target} have no common history.` }
  const base = mb.stdout.trim()

  const [head, ns, num, log, merge, rootHead, rootStatus, behind, raw] = await Promise.all([
    git(repo, ['rev-parse', branch]),
    git(repo, ['diff', '--name-status', '--no-renames', base, branch]),
    git(repo, ['diff', '--numstat', '--no-renames', base, branch]),
    git(repo, ['log', '--format=%H%x1f%an%x1f%ct%x1f%s%x1f%b%x1e', '-n', '50', `${base}..${branch}`]),
    git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', target, branch]),
    git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(repo, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(repo, ['rev-list', '--count', `${branch}..${target}`]),
    git(repo, ['diff', '--raw', '--no-renames', '--no-abbrev', base, branch])
  ])
  const files = parseChangedFiles(ns.stdout, num.stdout, raw.stdout)
  // merge-tree exits 1 with conflicts, other codes on errors.
  const conflicts = merge.code === 1 ? parseMergeTree(merge.stdout) : []
  const mergeCheck = merge.ok || merge.code === 1 ? 'done' : 'failed'

  let uncommitted = []
  if (c.path && c.listed && fs.existsSync(c.path)) {
    const st = await git(c.path, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (st.ok) uncommitted = parseStatusPaths(st.stdout)
  }
  const dirty = new Set(parseStatusPaths(rootStatus.stdout))
  const dirtyOverlap = files.map((f) => f.path).filter((p) => dirty.has(p))
  const merging = fs.existsSync(join(repo, '.git', 'MERGE_HEAD'))

  const info = {
    ok: true,
    repo,
    branch,
    target,
    base,
    head: head.stdout.trim(),
    files,
    commits: parseCommits(log.stdout),
    conflicts,
    mergeCheck,
    uncommitted,
    dirtyOverlap,
    rootBranch: rootHead.ok ? rootHead.stdout.trim() : null,
    merging,
    behind: Number(behind.stdout.trim()) || 0,
    copyExists: !!(c.path && fs.existsSync(c.path))
  }
  info.blocker = merging
    ? 'The project folder is in the middle of another merge.'
    : mergeCheck === 'failed'
      ? `Could not check for conflicts: ${(merge.stderr || merge.error || '').trim().split(/\r?\n/)[0]}`
      : mergeBlocker(info)
  return info
}

// The diff of one file of the branch, from where it started.
export async function reviewDiff(args = {}) {
  const c = await check(args)
  if (c.error) return { ok: false, error: c.error }
  const file = args.file
  if (typeof file !== 'string' || !file || file.startsWith('-')) return { ok: false, error: 'No file.' }
  const mb = await git(c.repo, ['merge-base', c.target, c.branch])
  if (!mb.ok) return { ok: false, error: 'No common history.' }
  const res = await git(c.repo, ['diff', '--no-renames', '--no-color', '-U3', mb.stdout.trim(), c.branch, '--', file])
  if (!res.ok) return { ok: false, error: (res.stderr || 'git diff failed').trim() }
  const tooBig = res.stdout.length > MAX_DIFF
  return { ok: true, text: tooBig ? res.stdout.slice(0, MAX_DIFF) : res.stdout, truncated: tooBig }
}

// Merge the task branch into the project folder, only if it is still safe.
export async function reviewMerge(args = {}) {
  const info = await reviewInfo(args)
  if (!info.ok) return info
  if (info.blocker) return { ok: false, error: info.blocker }
  if (args.expectHead && args.expectHead !== info.head)
    return { ok: false, error: 'The agent committed again since you looked. Check the changes again.' }
  const title = String(args.title || info.branch)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 120)
  const res = await git(info.repo, ['merge', '--no-ff', '--no-edit', '-m', `Merge task "${title}" (${info.branch})`, info.branch], {
    timeout: 120000
  })
  if (!res.ok) {
    if (fs.existsSync(join(info.repo, '.git', 'MERGE_HEAD'))) await git(info.repo, ['merge', '--abort'])
    if (/tell me who you are|unable to auto-detect email/i.test(res.stderr))
      return { ok: false, error: 'Git does not know your name yet. Run git config user.name and git config user.email in the project, then merge again.' }
    return { ok: false, error: (res.stdout + res.stderr).trim().split(/\r?\n/).slice(-3).join(' ') || 'git merge failed' }
  }
  const sha = await git(info.repo, ['rev-parse', 'HEAD'])
  return { ok: true, sha: sha.stdout.trim(), commits: info.commits.length, files: info.files.length }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function stillListed(repo, path) {
  const list = await git(repo, ['worktree', 'list', '--porcelain'])
  return parseWorktrees(list.stdout).some((w) => samePath(w.path, path))
}

// Delete the task's copy and its branch. `force` also drops work that was
// never merged (Discard); without it git refuses to delete an unmerged branch.
export async function reviewRemove(args = {}) {
  const c = await check(args)
  if (c.error) return { ok: false, error: c.error }
  if (c.path && c.listed) {
    // Windows keeps the folder busy for a moment after its terminal closes.
    // git may unregister the copy and still fail to delete its folder: then
    // the folder is deleted below.
    let res = null
    for (let i = 0; i < 8; i++) {
      res = await git(c.repo, ['worktree', 'remove', ...(args.force ? ['--force'] : []), c.path])
      if (res.ok || !(await stillListed(c.repo, c.path))) break
      if (!args.force && /modified or untracked/i.test(res.stderr)) break
      await wait(700)
    }
    if (!res.ok && (await stillListed(c.repo, c.path)))
      return { ok: false, error: (res.stderr || 'git worktree remove failed').trim().split(/\r?\n/)[0] }
    for (let i = 0; i < 8 && fs.existsSync(c.path); i++) {
      try {
        fs.rmSync(c.path, { recursive: true, force: true })
      } catch {
        await wait(700)
      }
    }
    if (fs.existsSync(c.path))
      return { ok: false, error: `Could not delete the folder ${c.path}. Close what uses it and try again.` }
  }
  await git(c.repo, ['worktree', 'prune'])
  if (await refExists(c.repo, c.branch)) {
    const del = await git(c.repo, ['branch', args.force ? '-D' : '-d', c.branch])
    if (!del.ok) return { ok: false, error: (del.stderr || 'git branch -d failed').trim().split(/\r?\n/)[0], copyRemoved: true }
  }
  return { ok: true }
}
