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
import { localGitArgs } from './gitSafety'
import { t } from './i18n'

const MAX_FILE = 10 * 1024 * 1024 // a version larger than this is not shown
const MAX_MESSAGE = 20000
const BULK = 100 // pathspecs per git call (Orca's BULK_CHUNK_SIZE)

// git never waits for a password or an editor in the background.
function gitEnv() {
  return { ...cleanEnv(process.env), GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no', GCM_INTERACTIVE: 'never' }
}
// The repository's own settings that run programs (core.fsmonitor, filters,
// textconv...) stay off until the user trusts it (gitSafety.js).
const git = async (top, args, opts = {}) =>
  run('git', ['-C', top, ...(await localGitArgs(top)), '-c', 'core.quotepath=off', ...args], {
    timeout: 30000,
    env: gitEnv(),
    maxBuffer: 32 * 1024 * 1024,
    ...opts
  })

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
// --- Line counts of untracked files (Orca's git-uncommitted-line-stats.ts) ------------
// git diff ignores untracked files, so their lines are counted from the file
// itself: bounded (at most 2 MB read per file, 8 at a time, 2,000 files and
// 32 MB per call), binaries and larger files get no count, and the result is
// kept per file (size, mtime) so an unchanged file is never read again.
export const MAX_UNTRACKED_LINE_COUNT_BYTES = 2 * 1024 * 1024
const UNTRACKED_READ_CONCURRENCY = 8
const MAX_UNTRACKED_COUNTED = 2000
const UNTRACKED_READ_BUDGET = 32 * 1024 * 1024
const UNTRACKED_CACHE_MAX = 4000
const untrackedStatsCache = new Map() // full path -> { size, mtimeMs, ctimeMs, stats }

function rememberUntracked(full, st, stats) {
  untrackedStatsCache.delete(full)
  untrackedStatsCache.set(full, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, stats })
  if (untrackedStatsCache.size > UNTRACKED_CACHE_MAX) untrackedStatsCache.delete(untrackedStatsCache.keys().next().value)
  return stats
}

async function readHead(full, limit) {
  const fh = await fs.promises.open(full, 'r')
  try {
    const buf = Buffer.alloc(limit)
    let n = 0
    while (n < limit) {
      const { bytesRead } = await fh.read(buf, n, limit - n, n)
      if (!bytesRead) break
      n += bytesRead
    }
    return buf.subarray(0, n)
  } finally {
    await fh.close()
  }
}

// -> { added } | {} (unknown: binary, too large, unreadable, over budget).
async function countFileAdditions(full, budget) {
  try {
    const st = await fs.promises.lstat(full)
    const cached = untrackedStatsCache.get(full)
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.ctimeMs === st.ctimeMs) {
      untrackedStatsCache.delete(full)
      untrackedStatsCache.set(full, cached)
      return cached.stats
    }
    if (st.isSymbolicLink()) return rememberUntracked(full, st, { added: 1 })
    if (!st.isFile() || st.size > MAX_UNTRACKED_LINE_COUNT_BYTES) return rememberUntracked(full, st, {})
    if (st.size > budget.left) return {} // not remembered: counted on a later pass
    budget.left -= st.size
    const buf = await readHead(full, st.size)
    if (buf.subarray(0, 8000).includes(0)) return rememberUntracked(full, st, {})
    if (!buf.length) return rememberUntracked(full, st, { added: 0 })
    let lines = 0
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++
    return rememberUntracked(full, st, { added: buf[buf.length - 1] === 10 ? lines : lines + 1 })
  } catch {
    return {}
  }
}

// rels: untracked paths relative to `top` -> Map rel -> { added? }.
export async function collectUntrackedAdditions(top, rels) {
  const out = new Map()
  const list = (rels || []).slice(0, MAX_UNTRACKED_COUNTED)
  const budget = { left: UNTRACKED_READ_BUDGET }
  for (let i = 0; i < list.length; i += UNTRACKED_READ_CONCURRENCY) {
    const chunk = list.slice(i, i + UNTRACKED_READ_CONCURRENCY)
    await Promise.all(chunk.map(async (rel) => out.set(rel, await countFileAdditions(join(top, ...rel.split('/')), budget))))
  }
  return out
}

function insideReal(topReal, p) {
  const rel = relative(topReal, p)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

// --- Remote ---------------------------------------------------------------------
const NAME_RE = /^(?!-)[^\0\s~^:?*[\\]{1,200}$/

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

// --- Branch compare (Orca's branch context row and line-total chip) -------------------
// HEAD against its base (the remote's default branch, origin/main): commits
// ahead / behind, and the lines of the whole branch's work — committed, staged,
// unstaged and untracked — as one `git diff <merge-base>` (Orca's
// git-branch-line-total.ts, so a line touched in two areas counts once).
const OID_RE = /^[0-9a-f]{7,64}$/
export const isCommitId = (v) => typeof v === 'string' && OID_RE.test(v)
const BRANCH_TOTAL_TIMEOUT = 15000

// A GitHub remote URL -> { owner, repo } (https, ssh, git@).
export function githubRepoOf(url) {
  const m = /github\.com[:/]+([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim())
  return m ? { owner: m[1], repo: m[2] } : null
}

// The review page Orca's external-link button opens (review/manual-review-url.ts,
// GitHub only here): the compare page of the pushed branch against the base.
export function compareUrl({ remoteUrl, base, upstream }) {
  const repo = githubRepoOf(remoteUrl)
  if (!repo || !base || !upstream) return null
  const [baseRemote, ...baseRest] = base.split('/')
  const [upRemote, ...upRest] = upstream.split('/')
  if (!baseRest.length || !upRest.length || baseRemote !== upRemote) return null
  const enc = (b) => b.split('/').map(encodeURIComponent).join('/')
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/compare/${enc(baseRest.join('/'))}...${enc(upRest.join('/'))}`
}

// --- Commits (Orca's shared/git-history.ts and git-history-log-parser.ts) -------------
export const HISTORY_DEFAULT_LIMIT = 50
const HISTORY_MAX_LIMIT = 200
const DECORATION_SEPARATOR = '\x1f'
export const HISTORY_COMMIT_FORMAT = '%H%n%aN%n%aE%n%at%n%ct%n%P%n%(decorate:prefix=,suffix=,separator=%x1f)%n%D%n%B'
const UNEXPANDED_DECORATE = `%(decorate:prefix=,suffix=,separator=${DECORATION_SEPARATOR})`

const shortHash = (h) => String(h || '').slice(0, 7)

function refOrder(ref) {
  if (ref.id.startsWith('refs/heads/')) return 1
  if (ref.id.startsWith('refs/remotes/')) return 2
  if (ref.id.startsWith('refs/tags/')) return 3
  return 99
}
const byCategory = (a, b) => refOrder(a) - refOrder(b) || a.name.localeCompare(b.name)

function parseDecorations(raw, revision, separator) {
  if (!raw.trim()) return []
  const refs = []
  for (const part of raw.split(separator)) {
    const ref = part.trim()
    if (!ref || ref === 'HEAD' || /^refs\/remotes\/[^/]+\/HEAD(?:\s|$)/.test(ref)) continue
    if (ref.startsWith('HEAD -> refs/heads/'))
      refs.push({ id: ref.slice('HEAD -> '.length), name: ref.slice('HEAD -> refs/heads/'.length), revision, category: 'branches' })
    else if (ref.startsWith('refs/heads/')) refs.push({ id: ref, name: ref.slice('refs/heads/'.length), revision, category: 'branches' })
    else if (ref.startsWith('refs/remotes/')) refs.push({ id: ref, name: ref.slice('refs/remotes/'.length), revision, category: 'remote branches' })
    else if (ref.startsWith('tag: refs/tags/')) refs.push({ id: ref.slice('tag: '.length), name: ref.slice('tag: refs/tags/'.length), revision, category: 'tags' })
  }
  return refs.sort(byCategory)
}

// `git log --format=HISTORY_COMMIT_FORMAT -z --decorate=full` -> items.
export function parseHistoryLog(stdout) {
  const items = []
  for (const rawRecord of String(stdout || '').split('\0')) {
    const record = rawRecord.replace(/^\n+/, '')
    if (!record.trim()) continue
    const lines = []
    let messageStart = 0
    for (let field = 0; field < 8; field++) {
      const nl = record.indexOf('\n', messageStart)
      if (nl === -1) {
        lines.push(record.slice(messageStart))
        messageStart = record.length
        break
      }
      lines.push(record.slice(messageStart, nl))
      messageStart = nl + 1
    }
    const hash = (lines[0] || '').trim()
    if (!/^[0-9a-fA-F]{40,64}$/.test(hash)) continue
    const at = Number.parseInt(lines[3] || '', 10)
    const parents = (lines[5] || '').trim()
    const decorateField = lines[6] || ''
    const legacy = decorateField === UNEXPANDED_DECORATE
    const message = record.slice(messageStart).replace(/\n$/, '')
    items.push({
      id: hash,
      parentIds: parents ? parents.split(' ') : [],
      subject: message.split(/\r?\n/, 1)[0].trim() || t('main.scm.noCommitSubject', '(no commit message)'),
      message,
      author: lines[1] || undefined,
      authorEmail: lines[2] || undefined,
      displayId: shortHash(hash),
      timestamp: Number.isFinite(at) ? at * 1000 : undefined,
      references: parseDecorations(legacy ? lines[7] || '' : decorateField, hash, legacy ? ',' : DECORATION_SEPARATOR)
    })
  }
  return items
}

function refFromFullName(fullName, fallbackName, revision) {
  const id = fullName || fallbackName
  if (id.startsWith('refs/heads/')) return { id, name: id.slice('refs/heads/'.length), revision, category: 'branches' }
  if (id.startsWith('refs/remotes/')) return { id, name: id.slice('refs/remotes/'.length), revision, category: 'remote branches' }
  if (id.startsWith('refs/tags/')) return { id, name: id.slice('refs/tags/'.length), revision, category: 'tags' }
  return { id, name: fallbackName || shortHash(revision), revision, category: 'commits' }
}

// `git diff-tree --name-status -z` -> [{ path, oldPath?, status }].
export function parseNameStatusZ(out) {
  const parts = String(out || '').split('\0')
  const list = []
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]
    if (!code) continue
    const letter = code[0]
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[++i]
      const path = parts[++i]
      if (path) list.push({ path, oldPath, status: letter === 'R' ? 'renamed' : 'copied' })
    } else {
      const path = parts[++i]
      if (path) list.push({ path, status: LETTER[letter] || 'modified' })
    }
  }
  return list
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

// The git operations over a backend: the local one below (git.exe on this
// machine's folders), or a remote project's (remoteScm.js: git run on an SSH
// host). A backend gives: repoOf(root) -> { top } | { error, notRepo },
// git(top, args, opts) -> { ok, stdout, stderr, error }, relIn(top, path),
// key(top) (one repository whatever the spelling), present(top) (the top the
// window gets), fullPath(top, rel), operation(top) (a merge, rebase or
// cherry-pick stopped half way), untracked(top, rels) (their line counts),
// working(top, rel) -> { exists, version }, prepareTrash / trash (untracked
// files discarded), staged-diff support.
export function createScm(b) {
  const { git, repoOf, relIn } = b
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

  // Everything the Changes tab shows about a folder's repository.
  // -> { ok, repo, top, branch, detached, upstream, hasUpstream, ahead, behind,
  //      hasCommits, operation, remotes, entries } | { ok: true, repo: false } | { ok: false, error }
  async function scmStatus({ root } = {}) {
    const r = await repoOf(root)
    if (r.notRepo) return { ok: true, repo: false }
    if (r.error) return { ok: false, error: r.error }
    const top = r.top
    const [st, un, stg, operation, remotes] = await Promise.all([
      git(top, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { timeout: 20000 }),
      git(top, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv']),
      git(top, ['diff', '--cached', '--numstat', '-z', '--no-ext-diff', '--no-textconv']),
      b.operation(top),
      git(top, ['remote'])
    ])
    if (!st.ok) return { ok: false, error: gitMessage(st, t('main.scm.statusFailed', 'Git status failed.')) }
    const info = parseStatusV2(st.stdout)
    const counts = { unstaged: un.ok ? parseNumstatZ(un.stdout) : {}, staged: stg.ok ? parseNumstatZ(stg.stdout) : {} }
    const untracked = await b.untracked(
      top,
      info.entries.filter((e) => e.area === 'untracked').map((e) => e.path)
    )
    const entries = info.entries.map((e) => {
      if (e.area === 'untracked') {
        const u = untracked.get(e.path)
        return u && typeof u.added === 'number' ? { ...e, added: u.added, removed: 0 } : e
      }
      const c = counts[e.area] && counts[e.area][e.path]
      return c ? { ...e, added: c.added, removed: c.removed, binary: c.binary } : e
    })
    return {
      ok: true,
      repo: true,
      top: b.present(top),
      branch: info.branch,
      detached: !info.branch,
      head: info.oid,
      hasCommits: !!info.oid,
      upstream: info.upstream,
      hasUpstream: !!info.upstream,
      ahead: info.ahead,
      behind: info.behind,
      operation,
      remotes: remotes.ok ? remotes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [],
      entries
    }
  }

  // --- Stage, unstage, discard ----------------------------------------------------------
  async function scmStage({ root, paths } = {}) {
    const r = await repoOf(root)
    if (r.error) return { ok: false, error: r.error }
    const l = relList(r.top, paths)
    if (l.error) return { ok: false, error: l.error }
    // -A: a file deleted on disk is staged as deleted too.
    const res = await inChunks(r.top, ['add', '-A'], l.rels)
    return res.ok ? { ok: true } : { ok: false, error: gitMessage(res, t('main.scm.addFailed', 'git add failed.')) }
  }

  async function scmUnstage({ root, paths } = {}) {
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


  // Discard the changes of files not staged. A tracked file gets back its staged
  // (index) version, so what was staged is kept; an untracked file goes to the
  // Recycle Bin (trashItem), never deleted for good. Files with a conflict are
  // refused (Orca hides Discard on them: it could lose the resolution).
  // trashItem(fullPath) -> Promise.
  async function scmDiscard({ root, paths } = {}, trashItem) {
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
    // Every untracked path is checked before anything is moved.
    const prep = await b.prepareTrash(r.top, untracked, trashItem)
    if (prep.error) return { ok: false, error: prep.error }
    if (tracked.length) {
      const res = await inChunks(r.top, ['restore', '--worktree'], tracked)
      if (!res.ok) return { ok: false, error: gitMessage(res, t('main.scm.discardFailed', 'Discard failed.')) }
    }
    const done = await b.trash(r.top, prep.targets, trashItem)
    if (done.error) return { ok: false, error: done.error, restored: tracked.length, trashed: done.trashed }
    return { ok: true, restored: tracked.length, trashed: done.trashed }
  }

  // --- Commit ---------------------------------------------------------------------
  // Commits what is staged (like Orca: the Commit button needs staged files).
  async function scmCommit({ root, message } = {}) {
    const r = await repoOf(root)
    if (r.error) return { ok: false, error: r.error }
    const msg = String(message || '')
      .replace(/\r/g, '')
      .replace(/\0/g, '')
      .trim()
      .slice(0, MAX_MESSAGE)
    if (!msg) return { ok: false, error: t('main.scm.noMessage', 'Enter a commit message to commit.') }
    const staged = await git(r.top, ['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv'])
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

  async function currentBranch(top) {
    const res = await git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    return res.ok ? res.stdout.trim() : null
  }
  async function config(top, key) {
    const res = await git(top, ['config', '--get', key])
    return res.ok ? res.stdout.trim() : ''
  }

  // Push to the branch's upstream; without one, publish it to origin (or its
  // configured remote) and set the upstream, like Orca's gitPush. Never forced.
  async function scmPush({ root } = {}) {
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
  async function scmPull({ root, ffOnly = false } = {}) {
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

  async function scmFetch({ root } = {}) {
    const r = await repoOf(root)
    if (r.error) return { ok: false, error: r.error }
    const res = await git(r.top, ['fetch', '--prune'], { timeout: 180000 })
    if (!res.ok) return { ok: false, error: remoteError(res, 'fetch') }
    return { ok: true }
  }

  // Pull, then push (Orca's Sync).
  async function scmSync({ root } = {}) {
    const pull = await scmPull({ root })
    if (!pull.ok) return pull
    return scmPush({ root })
  }

  async function refExists(top, ref) {
    const res = await git(top, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return res.ok && !!res.stdout.trim()
  }

  // The ref to compare with: <remote>/HEAD's target, else <remote>/main or
  // /master, else the branch's upstream. -> 'origin/main' | null
  async function resolveCompareBase(top, branch) {
    let remote = (branch && (await config(top, `branch.${branch}.remote`))) || 'origin'
    if (!NAME_RE.test(remote) || remote === '.') remote = 'origin'
    const candidates = []
    const head = await git(top, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`])
    if (head.ok && head.stdout.trim().startsWith('refs/remotes/')) candidates.push(head.stdout.trim().slice('refs/remotes/'.length))
    candidates.push(`${remote}/main`, `${remote}/master`)
    for (const c of candidates) if (NAME_RE.test(c) && (await refExists(top, `refs/remotes/${c}`))) return c
    const up = await git(top, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    const name = up.ok ? up.stdout.trim() : ''
    return name && NAME_RE.test(name) ? name : null
  }

  const compareInFlight = new Map() // top -> Promise

  // -> { ok, base, mergeBase, ahead, behind, added, removed, reviewUrl }
  //  | { ok: true, base: null } (nothing to compare with) | { ok: false, error }
  async function scmBranchCompare({ root } = {}) {
    const r = await repoOf(root)
    if (r.error) return { ok: false, error: r.error }
    const key = b.key(r.top)
    if (compareInFlight.has(key)) return compareInFlight.get(key)
    const p = branchCompare(r.top).finally(() => compareInFlight.delete(key))
    compareInFlight.set(key, p)
    return p
  }

  async function branchCompare(top) {
    const branch = await currentBranch(top)
    const base = await resolveCompareBase(top, branch)
    if (!base) return { ok: true, base: null }
    const mb = await git(top, ['merge-base', 'HEAD', `refs/remotes/${base}`])
    const mbAny = mb.ok ? mb : await git(top, ['merge-base', 'HEAD', base])
    const mergeBase = mbAny.ok ? mbAny.stdout.trim() : ''
    if (!isCommitId(mergeBase)) return { ok: false, base, error: t('main.scm.compareUnavailable', 'Branch compare unavailable') }
    const [diff, st, up] = await Promise.all([
      git(top, ['diff', '-z', '--numstat', '-M', '--no-ext-diff', '--no-textconv', mergeBase, '--'], { timeout: BRANCH_TOTAL_TIMEOUT }),
      git(top, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { timeout: 20000 }),
      git(top, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    ])
    const behindAhead = await git(top, ['rev-list', '--left-right', '--count', `${base}...HEAD`])
    const m = /^(\d+)\s+(\d+)/.exec(behindAhead.ok ? behindAhead.stdout.trim() : '')
    let added = null
    let removed = null
    if (diff.ok && st.ok) {
      added = 0
      removed = 0
      for (const c of Object.values(parseNumstatZ(diff.stdout))) {
        added += c.added || 0
        removed += c.removed || 0
      }
      const untracked = parseStatusV2(st.stdout)
        .entries.filter((e) => e.area === 'untracked')
        .map((e) => e.path)
      for (const s of (await b.untracked(top, untracked)).values()) added += s.added || 0
    }
    const upstream = up.ok ? up.stdout.trim() : ''
    const remoteName = base.split('/')[0]
    const url = await git(top, ['remote', 'get-url', remoteName])
    return {
      ok: true,
      base,
      mergeBase,
      ahead: m ? Number(m[2]) : 0,
      behind: m ? Number(m[1]) : 0,
      added,
      removed,
      reviewUrl: url.ok ? compareUrl({ remoteUrl: url.stdout.trim(), base, upstream }) : null
    }
  }

  async function commitOf(top, ref) {
    if (!ref || ref.startsWith('-')) return null
    const res = await git(top, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return res.ok ? res.stdout.trim() || null : null
  }

  // -> { ok, items, currentRef, remoteRef, baseRef, mergeBase, hasMore, limit }
  async function scmHistory({ root, limit, base } = {}) {
    const r = await repoOf(root)
    if (r.error) return { ok: false, error: r.error }
    const top = r.top
    const n = Number.isFinite(limit) ? Math.min(HISTORY_MAX_LIMIT, Math.max(1, Math.trunc(limit))) : HISTORY_DEFAULT_LIMIT
    const headOid = await commitOf(top, 'HEAD')
    if (!headOid) return { ok: true, items: [], hasMore: false, limit: n }
    const branch = await currentBranch(top)
    const currentRef = branch
      ? { id: `refs/heads/${branch}`, name: branch, revision: headOid, category: 'branches' }
      : { id: headOid, name: shortHash(headOid), revision: headOid, category: 'commits' }
    let remoteRef
    if (branch) {
      const up = await git(top, ['for-each-ref', '--format=%(upstream)%00%(upstream:short)', `refs/heads/${branch}`])
      const [full, short] = up.ok ? up.stdout.split('\0') : []
      if (full && full.trim() && short && short.trim()) {
        const oid = await commitOf(top, full.trim())
        if (oid) remoteRef = refFromFullName(full.trim(), short.trim(), oid)
      }
    }
    let baseRef
    if (typeof base === 'string' && NAME_RE.test(base)) {
      const oid = await commitOf(top, `refs/remotes/${base}`)
      const ref = oid ? refFromFullName(`refs/remotes/${base}`, base, oid) : null
      if (ref && ref.id !== (remoteRef && remoteRef.id) && ref.id !== currentRef.id) baseRef = ref
    }
    let mergeBase
    if (remoteRef && remoteRef.revision !== headOid) {
      const mb = await git(top, ['merge-base', headOid, remoteRef.revision])
      mergeBase = mb.ok ? mb.stdout.trim() || undefined : undefined
    }
    const log = await git(top, ['log', `--format=${HISTORY_COMMIT_FORMAT}`, '-z', '--topo-order', '--decorate=full', `-n${n + 1}`, headOid])
    if (!log.ok) return { ok: false, error: gitMessage(log, t('main.scm.logFailed', 'git log failed.')) }
    const parsed = parseHistoryLog(log.stdout)
    return { ok: true, items: parsed.slice(0, n), currentRef, remoteRef, baseRef, mergeBase, hasMore: parsed.length > n, limit: n }
  }

  // The files a commit changed (against its first parent). -> { ok, entries }
  async function scmCommitFiles({ root, commit } = {}) {
    const r = await repoOf(root)
    if (r.error) return { ok: false, error: r.error }
    if (!isCommitId(commit)) return { ok: false, error: t('main.scm.badCommit', 'Unknown commit.') }
    const parents = await git(r.top, ['rev-list', '--parents', '-n', '1', commit])
    if (!parents.ok) return { ok: false, error: t('main.scm.badCommit', 'Unknown commit.') }
    const ids = parents.stdout.trim().split(/\s+/)
    const range = ids.length > 1 ? [ids[1], ids[0]] : ['--root', ids[0]]
    const [ns, num] = await Promise.all([
      git(r.top, ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--name-status', ...range]),
      git(r.top, ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--numstat', '--no-textconv', ...range])
    ])
    if (!ns.ok) return { ok: false, error: gitMessage(ns, t('main.scm.diffFailed', 'git diff failed.')) }
    const counts = num.ok ? parseNumstatZ(num.stdout) : {}
    const entries = parseNameStatusZ(ns.stdout).map((e) => (counts[e.path] ? { ...e, added: counts[e.path].added, removed: counts[e.path].removed } : e))
    return { ok: true, entries, commit: ids[0], parent: ids.length > 1 ? ids[1] : null }
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
  async function scmFileVersions({ root, path, area, oldPath, commit } = {}) {
    const r = await repoOf(root)
    if (r.error) return { ok: false, error: r.error }
    const rel = relIn(r.top, path)
    if (!rel) return { ok: false, error: t('main.scm.notRepoFile', 'Not a file of this repository.') }
    const oldRel = oldPath ? relIn(r.top, oldPath) : null
    if (oldPath && !oldRel) return { ok: false, error: t('main.scm.notRepoFile', 'Not a file of this repository.') }
    // A file of a commit (the Commits section): its first parent -> the commit, read-only.
    if (area === 'commit') {
      if (!isCommitId(commit)) return { ok: false, error: t('main.scm.badCommit', 'Unknown commit.') }
      const before = await show(r.top, `${commit}^:${oldRel || rel}`)
      const after = await show(r.top, `${commit}:${rel}`)
      const o = clean(before.missing ? { text: '' } : before)
      const m = clean(after.missing ? { text: '' } : after)
      if (o.error || m.error) return { ok: false, error: o.error || m.error }
      const full = b.fullPath(r.top, rel)
      if (o.binary || m.binary) return { ok: true, binary: true, rel, full, exists: false, top: b.present(r.top) }
      return { ok: true, original: o.text, modified: m.text, rel, full, exists: false, top: b.present(r.top) }
    }
    const full = b.fullPath(r.top, rel)
    // The file on disk (its text only when it is the right side).
    const working = await b.working(r.top, rel, { content: area !== 'staged' })
    if (working.error) return { ok: false, error: working.error }
    const exists = working.exists
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
    if (!modified) modified = working.version
    const o = clean(original)
    const m = clean(modified)
    if (o.error || m.error) return { ok: false, error: o.error || m.error }
    if (o.binary || m.binary) return { ok: true, binary: true, rel, full, exists, top: b.present(r.top) }
    return { ok: true, original: o.text, modified: m.text, rel, full, exists, top: b.present(r.top) }
  }

  async function scmStagedDiff({ root } = {}) {
    const r = await repoOf(root)
    if (r.error) return { ok: false, error: r.error }
    const res = await git(r.top, ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv'], { maxBuffer: 64 * 1024 * 1024 })
    if (!res.ok) return { ok: false, error: gitMessage(res, t('main.scm.diffFailed', 'git diff failed.')) }
    if (!res.stdout.trim()) return { ok: false, error: t('main.scm.nothingStagedMessage', 'Stage at least one file to generate a message.') }
    return { ok: true, diff: truncateDiff(res.stdout), top: r.top }
  }
  return {
    repoOf,
    resolveCompareBase,
    scmStatus,
    scmStage,
    scmUnstage,
    scmDiscard,
    scmCommit,
    scmPush,
    scmPull,
    scmFetch,
    scmSync,
    scmBranchCompare,
    scmHistory,
    scmCommitFiles,
    scmFileVersions,
    scmStagedDiff
  }
}


// --- The local backend -------------------------------------------------------------
async function gitDirOperation(top) {
  return operationOf(await gitDir(top))
}

// Every untracked path is checked before anything is moved: its real path
// inside the repository's. -> { targets } | { error }
function localPrepareTrash(top, untracked, trashItem) {
  if (untracked.length && typeof trashItem !== 'function') return { error: t('main.scm.noRecycleBin', 'The Recycle Bin is not available.') }
  let topReal
  try {
    topReal = fs.realpathSync(top)
  } catch {
    return { error: t('main.scm.repoUnreadable', 'The repository folder could not be read.') }
  }
  const targets = []
  for (const rel of untracked) {
    const full = join(top, ...rel.split('/'))
    let real
    try {
      real = fs.realpathSync(full)
    } catch {
      continue // already gone
    }
    if (!insideReal(topReal, real)) return { error: t('main.scm.outsideRepo', '{{path}} resolves outside the repository.', { path: rel }) }
    targets.push(full)
  }
  return { targets }
}

// -> { trashed } | { trashed, error }
async function localTrash(top, targets, trashItem) {
  let trashed = 0
  for (const full of targets) {
    try {
      await trashItem(full)
      trashed++
    } catch (err) {
      return {
        trashed,
        error: t('main.scm.trashFailed', 'Could not move {{path}} to the Recycle Bin: {{error}}', { path: relative(top, full), error: (err && err.message) || err })
      }
    }
  }
  return { trashed }
}

// The file on disk for a diff's right side (content: its text is wanted).
// -> { exists, version }
function localWorking(top, rel, { content = true } = {}) {
  const full = join(top, ...rel.split('/'))
  let exists = false
  try {
    exists = fs.statSync(full).isFile()
  } catch {
    exists = false
  }
  if (!exists || !content) return { exists, version: { text: '' } }
  try {
    const st = fs.statSync(full)
    return { exists, version: st.size > MAX_FILE ? { tooBig: true } : { text: fs.readFileSync(full, 'utf8') } }
  } catch {
    return { exists, version: { text: '' } }
  }
}

export const localScmBackend = {
  git,
  repoOf,
  relIn,
  key: (top) => top.toLowerCase(),
  present: (top) => top,
  fullPath: (top, rel) => join(top, ...rel.split('/')),
  operation: gitDirOperation,
  untracked: collectUntrackedAdditions,
  prepareTrash: localPrepareTrash,
  trash: localTrash,
  working: localWorking
}

const local = createScm(localScmBackend)
export const resolveCompareBase = local.resolveCompareBase
export const scmStatus = local.scmStatus
export const scmStage = local.scmStage
export const scmUnstage = local.scmUnstage
export const scmDiscard = local.scmDiscard
export const scmCommit = local.scmCommit
export const scmPush = local.scmPush
export const scmPull = local.scmPull
export const scmFetch = local.scmFetch
export const scmSync = local.scmSync
export const scmBranchCompare = local.scmBranchCompare
export const scmHistory = local.scmHistory
export const scmCommitFiles = local.scmCommitFiles
export const scmFileVersions = local.scmFileVersions
export const scmStagedDiff = local.scmStagedDiff
