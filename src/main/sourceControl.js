// Source control for the right panel's Changes tab (after Orca's Source
// Control: src/main/git/source-control/staging.ts, discard-changes.ts,
// commit-changes.ts, status-read.ts and src/main/git/remote.ts, MIT,
// Copyright (c) 2026 Lovecast Inc.), written for Tessel.
//
// Works on any folder in a git repository: the workspace's project, or a
// task's own copy (a worktree). Every call finds the repository again with
// git itself; the paths come from the renderer and are only used once they
// are proven to be inside that repository. git is always run with an
// argument array (never a shell string), each path as a literal pathspec
// after "--", so no name is read as an option or a glob.
import fs from 'fs'
import { resolve, relative, isAbsolute, join, sep } from 'path'
import { run } from './agentTools'
import { cleanEnv } from './cleanEnv'
import { t } from './i18n'

const MAX_FILE = 10 * 1024 * 1024 // a version larger than this is not shown
const MAX_MESSAGE = 20000
const BULK = 100 // pathspecs per git call (Orca's BULK_CHUNK_SIZE)

// git never waits for a password or an editor in the background.
function gitEnv() {
  return { ...cleanEnv(process.env), GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no', GCM_INTERACTIVE: 'never' }
}
const git = (top, args, opts = {}) =>
  run('git', ['-C', top, '-c', 'core.quotepath=off', ...args], { timeout: 30000, env: gitEnv(), maxBuffer: 32 * 1024 * 1024, ...opts })

// Git's message for the user: its last meaningful lines.
function gitMessage(res, fallback) {
  const text = `${res.stderr || ''}\n${res.stdout || ''}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^hint:/i.test(l))
  return text.slice(-2).join(' ').slice(0, 400) || res.error || fallback
}

function identityError(res) {
  return /tell me who you are|unable to auto-detect email|empty ident/i.test(`${res.stderr}${res.stdout}`)
}

// The repository a folder is in: -> { top } or { error }.
export async function repoOf(root) {
  if (typeof root !== 'string' || !root || !isAbsolute(root)) return { error: t('main.scm.invalidFolder', 'Invalid folder.') }
  if (!fs.existsSync(root)) return { error: t('main.scm.folderMissing', 'The folder is missing.') }
  const res = await run('git', ['-C', root, 'rev-parse', '--show-toplevel'], { timeout: 15000, env: gitEnv() })
  if (!res.ok) return { error: t('main.scm.notRepo', 'This folder is not in a git repository.'), notRepo: true }
  return { top: resolve(res.stdout.trim()) }
}

// A path from the renderer (relative to the repository, or absolute) -> the
// path relative to the repository with / separators, or null when it is not
// strictly inside it (the repository itself, .., another drive, NUL).
export function relIn(top, p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.length > 4096) return null
  const full = resolve(isAbsolute(p) ? p : join(top, p))
  const rel = relative(resolve(top), full)
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) return null
  const parts = rel.split(sep)
  if (parts[0].toLowerCase() === '.git') return null
  return parts.join('/')
}

function relList(top, paths) {
  const list = Array.isArray(paths) ? paths : [paths]
  if (!list.length || list.length > 5000) return { error: t('main.scm.noFile', 'No file.') }
  const out = []
  for (const p of list) {
    const r = relIn(top, p)
    if (!r) return { error: t('main.scm.notRepoFileNamed', '"{{path}}" is not a file of this repository.', { path: String(p).slice(0, 200) }) }
    if (!out.includes(r)) out.push(r)
  }
  return { rels: out }
}

const literal = (rel) => `:(literal)${rel}`

async function inChunks(top, base, rels) {
  for (let i = 0; i < rels.length; i += BULK) {
    const res = await git(top, [...base, '--', ...rels.slice(i, i + BULK).map(literal)])
    if (!res.ok) return res
  }
  return { ok: true }
}

// --- Status ----------------------------------------------------------------------
const LETTER = { M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' }

// `git status --porcelain=v2 --branch -z` -> { branch, oid, upstream, ahead,
// behind, entries }. A file changed both in the index and on disk is two
// entries (staged and unstaged), like Orca's groups. entries: [{ path, oldPath,
// area: 'staged'|'unstaged'|'untracked', status, conflict }]; a conflicted file
// is one unstaged entry with its kind (both modified, deleted by them…).
export function parseStatusV2(out) {
  const parts = String(out || '').split('\0')
  const info = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, hasAb: false, entries: [] }
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec) continue
    if (rec.startsWith('# ')) {
      const [key, ...rest] = rec.slice(2).split(' ')
      const val = rest.join(' ')
      if (key === 'branch.head') info.branch = val === '(detached)' ? null : val
      else if (key === 'branch.oid') info.oid = val === '(initial)' ? null : val
      else if (key === 'branch.upstream') info.upstream = val
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val)
        if (m) {
          info.ahead = Number(m[1])
          info.behind = Number(m[2])
          info.hasAb = true
        }
      }
      continue
    }
    const kind = rec[0]
    if (kind === '?') {
      info.entries.push({ path: rec.slice(2), area: 'untracked', status: 'untracked' })
      continue
    }
    if (kind === '!') continue
    const fields = rec.split(' ')
    const xy = fields[1] || '..'
    if (kind === 'u') {
      info.entries.push({ path: fields.slice(10).join(' '), area: 'unstaged', status: 'modified', conflict: true, conflictStatus: 'unresolved', conflictKind: conflictKind(xy) })
      continue
    }
    let path
    let oldPath
    if (kind === '1') path = fields.slice(8).join(' ')
    else if (kind === '2') {
      path = fields.slice(9).join(' ')
      oldPath = parts[++i]
    } else continue
    const x = xy[0]
    const y = xy[1]
    if (x !== '.') info.entries.push({ path, ...(oldPath && (x === 'R' || x === 'C') ? { oldPath } : {}), area: 'staged', status: LETTER[x] || 'modified' })
    if (y !== '.') info.entries.push({ path, area: 'unstaged', status: LETTER[y] || 'modified' })
  }
  return info
}

// Orca's conflict kinds (shared/git-status-types.ts).
const CONFLICT_KIND = {
  DD: 'both_deleted',
  AU: 'added_by_us',
  UD: 'deleted_by_them',
  UA: 'added_by_them',
  DU: 'deleted_by_us',
  AA: 'both_added',
  UU: 'both_modified'
}
function conflictKind(xy) {
  return CONFLICT_KIND[xy] || 'both_modified'
}

// `git diff --numstat -z` -> { path: { added, removed } } (renames: new path).
export function parseNumstatZ(out) {
  const parts = String(out || '').split('\0')
  const map = {}
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec) continue
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec)
    if (!m) continue
    let path = m[3]
    if (!path) {
      // A rename: the old path, then the new one.
      i += 2
      path = parts[i]
    }
    if (!path) continue
    map[path] = { added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]), binary: m[1] === '-' }
  }
  return map
}

async function gitDir(top) {
  const res = await git(top, ['rev-parse', '--absolute-git-dir'])
  return res.ok ? res.stdout.trim() : null
}

// A merge, rebase or cherry-pick stopped half way (Orca's conflict banner).
function operationOf(dir) {
  if (!dir) return null
  const has = (n) => {
    try {
      return fs.existsSync(join(dir, n))
    } catch {
      return false
    }
  }
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase'
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  return null
}

// Everything the Changes tab shows about a folder's repository.
// -> { ok, repo, top, branch, detached, upstream, hasUpstream, ahead, behind,
//      hasCommits, operation, remotes, entries } | { ok: true, repo: false } | { ok: false, error }
export async function scmStatus({ root } = {}) {
  const r = await repoOf(root)
  if (r.notRepo) return { ok: true, repo: false }
  if (r.error) return { ok: false, error: r.error }
  const top = r.top
  const [st, un, stg, dir, remotes] = await Promise.all([
    git(top, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { timeout: 20000 }),
    git(top, ['diff', '--numstat', '-z', '--no-ext-diff']),
    git(top, ['diff', '--cached', '--numstat', '-z', '--no-ext-diff']),
    gitDir(top),
    git(top, ['remote'])
  ])
  if (!st.ok) return { ok: false, error: gitMessage(st, t('main.scm.statusFailed', 'Git status failed.')) }
  const info = parseStatusV2(st.stdout)
  const counts = { unstaged: un.ok ? parseNumstatZ(un.stdout) : {}, staged: stg.ok ? parseNumstatZ(stg.stdout) : {} }
  const entries = info.entries.map((e) => {
    const c = counts[e.area] && counts[e.area][e.path]
    return c ? { ...e, added: c.added, removed: c.removed, binary: c.binary } : e
  })
  return {
    ok: true,
    repo: true,
    top,
    branch: info.branch,
    detached: !info.branch,
    head: info.oid,
    hasCommits: !!info.oid,
    upstream: info.upstream,
    hasUpstream: !!info.upstream,
    ahead: info.ahead,
    behind: info.behind,
    operation: operationOf(dir),
    remotes: remotes.ok ? remotes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [],
    entries
  }
}

// --- Stage, unstage, discard ----------------------------------------------------------
export async function scmStage({ root, paths } = {}) {
  const r = await repoOf(root)
  if (r.error) return { ok: false, error: r.error }
  const l = relList(r.top, paths)
  if (l.error) return { ok: false, error: l.error }
  // -A: a file deleted on disk is staged as deleted too.
  const res = await inChunks(r.top, ['add', '-A'], l.rels)
  return res.ok ? { ok: true } : { ok: false, error: gitMessage(res, t('main.scm.addFailed', 'git add failed.')) }
}

export async function scmUnstage({ root, paths } = {}) {
  const r = await repoOf(root)
  if (r.error) return { ok: false, error: r.error }
  const l = relList(r.top, paths)
  if (l.error) return { ok: false, error: l.error }
  const head = await git(r.top, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  // No commit yet: there is nothing to restore from, the files leave the index.
  const res = head.ok
    ? await inChunks(r.top, ['restore', '--staged'], l.rels)
    : await inChunks(r.top, ['rm', '--cached', '-r', '--quiet'], l.rels)
  return res.ok ? { ok: true } : { ok: false, error: gitMessage(res, t('main.scm.unstageFailed', 'Unstage failed.')) }
}

function insideReal(topReal, p) {
  const rel = relative(topReal, p)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

// Discard the changes of files not staged. A tracked file gets back its staged
// (index) version, so what was staged is kept; an untracked file goes to the
// Recycle Bin (trashItem), never deleted for good. Files with a conflict are
// refused (Orca hides Discard on them: it could lose the resolution).
// trashItem(fullPath) -> Promise.
export async function scmDiscard({ root, paths } = {}, trashItem) {
  const r = await repoOf(root)
  if (r.error) return { ok: false, error: r.error }
  const l = relList(r.top, paths)
  if (l.error) return { ok: false, error: l.error }
  const st = await git(r.top, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
  if (!st.ok) return { ok: false, error: gitMessage(st, t('main.scm.statusFailed', 'Git status failed.')) }
  const entries = parseStatusV2(st.stdout).entries
  const tracked = []
  const untracked = []
  for (const rel of l.rels) {
    const mine = entries.filter((e) => e.path === rel)
    if (mine.some((e) => e.conflict)) return { ok: false, error: t('main.scm.hasConflict', '{{path}} has a conflict: resolve it first.', { path: rel }) }
    if (mine.some((e) => e.area === 'untracked')) untracked.push(rel)
    else if (mine.some((e) => e.area === 'unstaged')) tracked.push(rel)
    // Nothing to discard for it (already clean, or only staged): skipped.
  }
  if (untracked.length && typeof trashItem !== 'function') return { ok: false, error: t('main.scm.noRecycleBin', 'The Recycle Bin is not available.') }
  let topReal
  try {
    topReal = fs.realpathSync(r.top)
  } catch {
    return { ok: false, error: t('main.scm.repoUnreadable', 'The repository folder could not be read.') }
  }
  // Every untracked path is checked before anything is moved.
  const targets = []
  for (const rel of untracked) {
    const full = join(r.top, ...rel.split('/'))
    let real
    try {
      real = fs.realpathSync(full)
    } catch {
      continue // already gone
    }
    if (!insideReal(topReal, real)) return { ok: false, error: t('main.scm.outsideRepo', '{{path}} resolves outside the repository.', { path: rel }) }
    targets.push(full)
  }
  if (tracked.length) {
    const res = await inChunks(r.top, ['restore', '--worktree'], tracked)
    if (!res.ok) return { ok: false, error: gitMessage(res, t('main.scm.discardFailed', 'Discard failed.')) }
  }
  let trashed = 0
  for (const full of targets) {
    try {
      await trashItem(full)
      trashed++
    } catch (err) {
      return {
        ok: false,
        error: t('main.scm.trashFailed', 'Could not move {{path}} to the Recycle Bin: {{error}}', { path: relative(r.top, full), error: (err && err.message) || err }),
        restored: tracked.length,
        trashed
      }
    }
  }
  return { ok: true, restored: tracked.length, trashed }
}

// --- Commit ---------------------------------------------------------------------
// Commits what is staged (like Orca: the Commit button needs staged files).
export async function scmCommit({ root, message } = {}) {
  const r = await repoOf(root)
  if (r.error) return { ok: false, error: r.error }
  const msg = String(message || '')
    .replace(/\r/g, '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, MAX_MESSAGE)
  if (!msg) return { ok: false, error: t('main.scm.noMessage', 'Enter a commit message to commit.') }
  const staged = await git(r.top, ['diff', '--cached', '--quiet'])
  if (staged.ok) return { ok: false, error: t('main.scm.nothingStaged', 'Stage at least one file to commit.') }
  const res = await git(r.top, ['commit', '-m', msg], { timeout: 180000 })
  if (!res.ok) {
    if (identityError(res))
      return { ok: false, error: t('main.scm.noGitName', 'Git does not know your name yet (Tools > Git > Set name & email), then commit again.') }
    return { ok: false, error: gitMessage(res, t('main.scm.commitFailed', 'Commit failed.')) }
  }
  const sha = await git(r.top, ['rev-parse', 'HEAD'])
  return { ok: true, sha: sha.stdout.trim() }
}

// --- Remote ---------------------------------------------------------------------
const NAME_RE = /^(?!-)[^\0\s~^:?*[\\]{1,200}$/

async function currentBranch(top) {
  const res = await git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return res.ok ? res.stdout.trim() : null
}
async function config(top, key) {
  const res = await git(top, ['config', '--get', key])
  return res.ok ? res.stdout.trim() : ''
}

function remoteError(res, op) {
  const text = `${res.stderr || ''}\n${res.stdout || ''}`
  if (/rejected|non-fast-forward|fetch first|failed to push some refs/i.test(text) && op === 'push')
    return t('main.scm.pushRejected', 'The remote branch has commits this one does not: pull (or sync) first. Nothing was pushed.')
  if (/could not read username|authentication failed|permission denied|403|terminal prompts disabled/i.test(text))
    return t('main.scm.remoteAuth', 'Git could not sign in to the remote. Sign in once (Tools > GitHub CLI > Sign in, or git push in a terminal), then try again.')
  if (/could not resolve host|unable to access|network/i.test(text))
    return t('main.scm.unreachable', 'Could not reach the remote: {{error}}', { error: gitMessage(res, t('main.scm.opFailed', '{{op}} failed.', { op })) })
  if (/CONFLICT|Automatic merge failed/i.test(text))
    return t('main.scm.pullConflicts', 'The pull stopped on conflicts: resolve them in the files listed under Conflicts, then commit.')
  if (/local changes .* would be overwritten|Please commit your changes or stash them/i.test(text))
    return t('main.scm.localChanges', 'Your uncommitted changes touch the same files: commit or stash them first.')
  return gitMessage(res, t('main.scm.gitOpFailed', 'git {{op}} failed.', { op }))
}

// Push to the branch's upstream; without one, publish it to origin (or its
// configured remote) and set the upstream, like Orca's gitPush. Never forced.
export async function scmPush({ root } = {}) {
  const r = await repoOf(root)
  if (r.error) return { ok: false, error: r.error }
  const branch = await currentBranch(r.top)
  if (!branch) return { ok: false, error: t('main.scm.pushNoBranch', 'Check out a branch before pushing commits.') }
  const remote = (await config(r.top, `branch.${branch}.remote`)) || 'origin'
  if (!NAME_RE.test(remote) || remote === '.')
    return { ok: false, error: t('main.scm.unusualRemote', 'The branch pushes to an unusual remote: push it from a terminal.') }
  const url = await git(r.top, ['remote', 'get-url', remote])
  if (!url.ok) return { ok: false, error: t('main.scm.noRemote', 'This repository has no remote named {{remote}}.', { remote }) }
  const merge = (await config(r.top, `branch.${branch}.merge`)).replace(/^refs\/heads\//, '')
  const target = merge && NAME_RE.test(merge) ? merge : branch
  if (!NAME_RE.test(branch) || !NAME_RE.test(target))
    return { ok: false, error: t('main.scm.unusualBranch', 'Unusual branch name: push it from a terminal.') }
  const res = await git(r.top, ['push', '--set-upstream', remote, `HEAD:refs/heads/${target}`], { timeout: 180000 })
  if (!res.ok) return { ok: false, error: remoteError(res, 'push') }
  return { ok: true, remote, branch: target }
}

// Pull with the user's own pull settings (merge by default), like Orca's gitPull.
export async function scmPull({ root, ffOnly = false } = {}) {
  const r = await repoOf(root)
  if (r.error) return { ok: false, error: r.error }
  const branch = await currentBranch(r.top)
  if (!branch) return { ok: false, error: t('main.scm.pullNoBranch', 'Check out a branch before pulling commits.') }
  const up = await git(r.top, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (!up.ok) return { ok: false, error: t('main.scm.pullNoUpstream', 'Publish the branch first to pull commits.') }
  const res = await git(r.top, ['pull', ...(ffOnly ? ['--ff-only'] : ['--no-edit'])], { timeout: 180000 })
  if (!res.ok) return { ok: false, error: remoteError(res, 'pull') }
  return { ok: true }
}

export async function scmFetch({ root } = {}) {
  const r = await repoOf(root)
  if (r.error) return { ok: false, error: r.error }
  const res = await git(r.top, ['fetch', '--prune'], { timeout: 180000 })
  if (!res.ok) return { ok: false, error: remoteError(res, 'fetch') }
  return { ok: true }
}

// Pull, then push (Orca's Sync).
export async function scmSync({ root } = {}) {
  const pull = await scmPull({ root })
  if (!pull.ok) return pull
  return scmPush({ root })
}

// --- The two sides of a file's diff -------------------------------------------------
async function show(top, spec) {
  const res = await git(top, ['show', '--no-textconv', spec], { maxBuffer: MAX_FILE + 1024 })
  if (!res.ok) {
    if (/maxBuffer/i.test(String(res.error || ''))) return { tooBig: true }
    return { missing: true }
  }
  return { text: res.stdout }
}

function clean(v) {
  if (v.tooBig) return { error: t('main.scm.versionTooLarge', 'This version is too large to compare (over 10 MB).') }
  const text = v.text || ''
  if (text.slice(0, 8000).includes('\0')) return { binary: true }
  return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text }
}

// area 'staged': HEAD -> index (read-only); 'unstaged': index -> the file on
// disk; 'untracked': nothing -> the file on disk. oldPath: a staged rename's
// old name. -> { ok, original, modified, binary, exists, rel, full }
export async function scmFileVersions({ root, path, area, oldPath } = {}) {
  const r = await repoOf(root)
  if (r.error) return { ok: false, error: r.error }
  const rel = relIn(r.top, path)
  if (!rel) return { ok: false, error: t('main.scm.notRepoFile', 'Not a file of this repository.') }
  const oldRel = oldPath ? relIn(r.top, oldPath) : null
  if (oldPath && !oldRel) return { ok: false, error: t('main.scm.notRepoFile', 'Not a file of this repository.') }
  const full = join(r.top, ...rel.split('/'))
  let exists = false
  try {
    exists = fs.statSync(full).isFile()
  } catch {
    exists = false
  }
  let original = { text: '' }
  let modified = null
  if (area === 'staged') {
    const head = await show(r.top, `HEAD:${oldRel || rel}`)
    original = head.missing ? { text: '' } : head
    const index = await show(r.top, `:${rel}`)
    modified = index.missing ? { text: '' } : index
  } else if (area === 'unstaged') {
    const index = await show(r.top, `:${rel}`)
    if (index.missing) {
      const head = await show(r.top, `HEAD:${rel}`)
      original = head.missing ? { text: '' } : head
    } else original = index
  } else if (area !== 'untracked') return { ok: false, error: t('main.scm.unknownGroup', 'Unknown change group.') }
  if (!modified) {
    if (!exists) modified = { text: '' }
    else {
      try {
        const st = fs.statSync(full)
        modified = st.size > MAX_FILE ? { tooBig: true } : { text: fs.readFileSync(full, 'utf8') }
      } catch {
        modified = { text: '' }
      }
    }
  }
  const o = clean(original)
  const m = clean(modified)
  if (o.error || m.error) return { ok: false, error: o.error || m.error }
  if (o.binary || m.binary) return { ok: true, binary: true, rel, full, exists, top: r.top }
  return { ok: true, original: o.text, modified: m.text, rel, full, exists, top: r.top }
}

// --- The staged diff, for a generated commit message --------------------------------
export const STAGED_DIFF_BUDGET = 200000

// Orca's prompt (shared/commit-message-prompt.ts), word for word.
export function commitPrompt(diff) {
  return `You are generating a single git commit message.
Read the staged diff below and produce the message.

Rules:
- First line: imperative mood, <= 72 chars, no trailing period.
- Optional body: blank line, then wrapped at 72 chars explaining WHY.
- Output ONLY the commit message - no preamble, no code fences, no quotes.
- Do not include "Co-authored-by" or other git trailers.

Staged diff:
\`\`\`diff
${diff}
\`\`\`
`
}

// A diff longer than the budget: each file keeps a fair share, cut on a line.
export function truncateDiff(diff, budget = STAGED_DIFF_BUDGET) {
  if (diff.length <= budget) return diff
  const sections = diff.split(/(?=^diff --git )/m)
  const share = Math.max(200, Math.floor(budget / sections.length))
  return sections
    .map((s) => {
      if (s.length <= share) return s
      const cut = s.lastIndexOf('\n', share)
      return `${s.slice(0, cut > share / 2 ? cut : share)}\n...(diff truncated, ${s.length - share} bytes omitted)\n`
    })
    .join('')
    .slice(0, budget + 2000)
}

// What an agent answered -> the message (fences, quotes and trailers removed).
export function cleanGeneratedMessage(text) {
  let msg = String(text || '').replace(/\r/g, '').trim()
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(msg)
  if (fence) msg = fence[1].trim()
  if ((msg.startsWith('"') && msg.endsWith('"')) || (msg.startsWith("'") && msg.endsWith("'"))) msg = msg.slice(1, -1).trim()
  msg = msg
    .split('\n')
    .filter((l) => !/^(co-authored-by|signed-off-by):/i.test(l.trim()))
    .join('\n')
    .trim()
  return msg.slice(0, MAX_MESSAGE)
}

export async function scmStagedDiff({ root } = {}) {
  const r = await repoOf(root)
  if (r.error) return { ok: false, error: r.error }
  const res = await git(r.top, ['diff', '--cached', '--no-color', '--no-ext-diff'], { maxBuffer: 64 * 1024 * 1024 })
  if (!res.ok) return { ok: false, error: gitMessage(res, t('main.scm.diffFailed', 'git diff failed.')) }
  if (!res.stdout.trim()) return { ok: false, error: t('main.scm.nothingStagedMessage', 'Stage at least one file to generate a message.') }
  return { ok: true, diff: truncateDiff(res.stdout), top: r.top }
}
