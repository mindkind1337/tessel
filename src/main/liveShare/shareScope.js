// Live Share phase 2: what of a shared project's folder a guest may reach.
//
// A guest names a file by its path relative to the project (liveSharePath.js:
// strict segments, never absolute); the host turns it into a path on its own
// disk here, and every request (shareRequests.js) goes through it. The rules:
//
// - Inside the project's folder only, by its real path. The folder is taken
//   as the window gave it (absolute, local, an existing folder) and resolved
//   once with realpath.native (a junction, an 8.3 short name). Each part of a
//   path that exists is looked at on the way down: a link or a junction is
//   followed only when it lands inside the folder. The target's real path
//   (for a new file, its folder's) must be inside it too, and a file opened
//   is checked again by its identity on disk (dev and inode) against the one
//   resolved, which narrows the gap where a folder could be swapped for a
//   junction in between.
// - Always hidden, whatever the share's settings: .git (a repository's own
//   files: hooks, config, the paths of its worktrees) and .tessel (the team's
//   inboxes, named by their secret token, its messages, the worktree setup
//   script that runs by itself), except .tessel/notes.md.
// - Hidden while "Hide ignored and secret files from guests" is on (the
//   share's setting, on by default): what git ignores (git check-ignore, run
//   with the repository's risky settings off, gitSafety.js; kept per project
//   and forgotten when its files change) and what looks like a secret by its
//   name (.env, keys, credentials, cloud folders: SECRET_*).
// - Write-protected even with the edit right, unless the guest may also type
//   (which already runs any command as the host): the files agents and tools
//   run or obey by themselves (.claude/, .mcp.json, .vscode/, an agent's
//   instructions like CLAUDE.md or the notes, git hooks and the configs of
//   the tools that run them (.husky/, .githooks/, .pre-commit-config.yaml,
//   lefthook, lint-staged, commitlint, the folder core.hooksPath names), what
//   decides which files git ignores or how it reads them (.gitignore,
//   .gitattributes, .gitmodules), .envrc...).
// - Never moved, made or put in the Recycle Bin by a guest: .git and .tessel
//   themselves (either name, anywhere: a folder renamed to or from one would
//   show or change what is hidden in it), and a folder with anything hidden
//   or write-protected below it (moving it would show the hidden files under
//   a new name, or take a protected one out of its place).
// - What git ignores is decided once per path for the share: a path seen
//   ignored stays hidden even if a .gitignore changes later (a guest's edit
//   never shows it), and the check runs once per request for all its paths.
//
// Every rule is matched without case on both the path the guest gave and the
// real one (realpath.native expands 8.3 names: TESSEL~1 is .tessel), so a
// hidden file is not reached under another name. A hidden path answers as
// missing: a guest learns nothing of what is there.
//
// And on the way out, assertNoHostPaths() is the last guard over any answer:
// the project folders' paths and any drive, share or long path left in it
// become "…".
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'
import { join, relative, isAbsolute, sep, resolve, dirname } from 'path'
import { localGitArgs } from '../gitSafety'
import { cleanEnv } from '../cleanEnv'
import { relSegments } from '../../shared/liveSharePath'
import { localRootTooBroad } from '../../shared/projectRootPolicy'

// --- Rules on relative paths (pure) ---------------------------------------------
const lower = (rel) => String(rel || '').toLowerCase()
const segsOf = (rel) => (rel ? lower(rel).split('/') : [])

// .git anywhere (a nested repository or a worktree's .git file too), and
// .tessel anywhere but its notes (the folder itself is listed, to reach them).
export function isAlwaysHidden(rel) {
  const segs = segsOf(rel)
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === '.git') return true
    if (segs[i] === '.tessel') {
      if (i === segs.length - 1) return false
      return !(i === segs.length - 2 && segs[i + 1] === 'notes.md')
    }
  }
  return false
}

// Names that hold secrets by convention (hidden with the setting on).
const SECRET_EXACT = new Set(['.npmrc', '.pypirc', '.netrc', '.git-credentials'])
const SECRET_FOLDERS = new Set(['.aws', '.ssh', '.docker', '.kube', '.gnupg'])
const SECRET_PATTERNS = [
  /^\.env(\..+)?$/, // .env, .env.local... (examples below are not)
  /\.env$/, // prod.env
  /\.(pem|key|p12|pfx|p8|ppk|jks|keystore|kdbx|tfvars)$/,
  /^id_(rsa|ed25519|ecdsa|dsa)/,
  /\.tfstate/,
  /^credentials.*\.json$/,
  /^service-account.*\.json$/,
  /^secrets?\..+$/ // secrets.json, secrets.yaml...
]
const SECRET_EXAMPLE = /^(\.env(\..+)?|.+\.env)\.(example|sample|template)$/
export function isSecretName(name) {
  const n = lower(name)
  if (!n) return false
  if (SECRET_EXACT.has(n) || SECRET_FOLDERS.has(n)) return true
  if (SECRET_EXAMPLE.test(n)) return false
  return SECRET_PATTERNS.some((re) => re.test(n))
}
export const isSecretRel = (rel) => segsOf(rel).some(isSecretName)

// Hidden by its path alone (no disk, no git): always, and the secret names
// while the setting is on.
export function hiddenByName(rel, settings) {
  return isAlwaysHidden(rel) || (hidesPrivate(settings) && isSecretRel(rel))
}

// The share's setting "Hide ignored and secret files from guests": on unless
// turned off.
export const DEFAULT_SHARE_SETTINGS = Object.freeze({ hideIgnored: true })
export const hidesPrivate = (settings) => !(settings && settings.hideIgnored === false)

// Files that run something, or tell an agent or a tool what to run, by
// themselves: written by a guest only with the type right too. extra: more
// protected paths of that project (the folder its core.hooksPath names).
// Agents' own folders (their settings, commands, MCP servers, hooks).
const PROTECTED_FOLDERS = new Set([
  '.claude',
  '.codex',
  '.gemini',
  '.cursor',
  '.vscode',
  '.husky',
  '.githooks',
  '.tessel',
  '.opencode',
  '.continue',
  '.windsurf',
  '.kiro',
  '.grok',
  // Muse Code: its project skills, plugins, workflows and memory (.agents,
  // which Codex and others read too) and its worktrees (.muse).
  '.agents',
  '.muse',
  '.crush',
  '.roo',
  '.cline',
  '.amazonq',
  '.aider',
  '.goose',
  '.qwen',
  '.kimi',
  '.amp',
  '.junie',
  '.augment',
  '.copilot',
  '.zed'
])
const PROTECTED_FILES = new Set([
  '.mcp.json',
  '.envrc',
  // What git ignores, how it reads files (filters, diff drivers), its
  // submodules.
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  // Hook managers: what they run on a commit.
  '.pre-commit-config.yaml',
  '.pre-commit-hooks.yaml',
  // An agent's instructions.
  'claude.md',
  'agents.md',
  'gemini.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  'copilot-instructions.md',
  '.goosehints',
  '.roomodes',
  'qwen.md',
  'grok.md',
  // Agents' settings files (what they run, their MCP servers and models).
  'opencode.json',
  'opencode.jsonc',
  'crush.json',
  '.crush.json',
  '.aider.conf.yml',
  '.aider.conf.yaml',
  '.aider.model.settings.yml',
  '.aider.model.metadata.json',
  '.aiderignore',
  '.cursorignore',
  '.geminiignore',
  '.continuerc.json',
  'continue.config.json'
])
const PROTECTED_PATTERNS = [/^\.?lefthook(-local)?\.ya?ml$/, /^\.lintstagedrc(\..+)?$/, /^lint-staged\.config\.[cm]?[jt]s$/, /^\.?commitlint(rc|\.config)(\..+)?$/]
// The names git runs by itself as hooks: with core.hooksPath on the project's
// own folder ('.'), these files of the project's top level run on a commit.
const HOOK_NAMES = new Set([
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update',
  'proc-receive', 'post-receive', 'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc',
  'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist',
  'p4-post-changelist', 'p4-pre-submit', 'post-index-change'
])
export function isProtectedRel(rel, extra = null) {
  const segs = segsOf(rel)
  if (segs.some((x) => PROTECTED_FOLDERS.has(x))) return true
  const name = segs.length ? segs[segs.length - 1] : ''
  if (name && (PROTECTED_FILES.has(name) || PROTECTED_PATTERNS.some((re) => re.test(name)))) return true
  const low = lower(rel)
  // '' is the project folder itself: its top-level files named like a hook.
  if (Array.isArray(extra) && extra.includes('') && segs.length === 1 && HOOK_NAMES.has(name)) return true
  return Array.isArray(extra) && extra.some((x) => x && (low === x || low.startsWith(`${x}/`)))
}
// May a guest with these rights change `rel` (the edit or git right itself is
// the caller's check)?
export const writeAllowed = (rel, rights, extra = null) => !isProtectedRel(rel, extra) || !!(rights && rights.type === true)

// .git or .tessel anywhere in a path: never moved, made or put in the
// Recycle Bin by a guest (only .tessel/notes.md is saved, with its right).
export const touchesSpecial = (rel) => segsOf(rel).some((x) => x === '.git' || x === '.tessel')

// --- Roots -------------------------------------------------------------------------
// The project's folder as the window gave it: absolute, local (not ssh:// or
// lshare://, not a share's long-path form), an existing folder.
// -> { root, real } | null
export function rootInfo(root) {
  if (typeof root !== 'string' || !root || root.length > 1024 || !isAbsolute(root)) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(root) || /^\\\\[?.]\\/.test(root)) return null
  // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  if (/[\u0000-\u001f]/.test(root)) return null
  try {
    const real = fs.realpathSync.native(resolve(root))
    if (!fs.statSync(real).isDirectory()) return null
    // A whole drive or share is never a project, nor a system folder or the
    // folder of all homes, by its real path too (a link to one), whatever
    // the window let through (shared/projectRootPolicy.js).
    if (dirname(real) === real || localRootTooBroad(real) || localRootTooBroad(resolve(root))) return null
    return { root: resolve(root), real }
  } catch {
    return null
  }
}

// Is p the base folder or inside it (Windows: without case)?
export function within(base, p) {
  const rel = relative(base, p)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
// p's path from base with "/" ('' for base itself); null when outside.
export function relFrom(base, p) {
  if (!within(base, p)) return null
  const rel = relative(base, p)
  return rel ? rel.split(sep).join('/') : ''
}

const sameFile = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino

// --- Git check-ignore ----------------------------------------------------------------
const IGNORE_TTL_MS = 30000
const IGNORE_CACHE_MAX = 50000
const IGNORE_TIMEOUT_MS = 10000
// Entries below a folder looked at before a guest moves it (more: refused).
const BELOW_MAX = 20000

// git check-ignore -z --stdin over rels (paths from cwd): -> Set of the
// ignored ones | null (git failed: the caller hides them all). noIndex: also
// a file git tracks (staged by force) that its rules ignore.
export function checkIgnore(cwd, safety, rels, { noIndex = false } = {}) {
  return new Promise((done) => {
    let child
    try {
      child = spawn('git', ['-C', cwd, ...safety, 'check-ignore', ...(noIndex ? ['--no-index'] : []), '-z', '--stdin'], {
        windowsHide: true,
        env: { ...cleanEnv(process.env), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
      })
    } catch {
      return done(null)
    }
    let out = ''
    let finished = false
    const finish = (v) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      done(v)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // gone already
      }
      finish(null)
    }, IGNORE_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (s) => {
      out += s
      if (out.length > 64 * 1024 * 1024) {
        try {
          child.kill()
        } catch {
          // gone already
        }
        finish(null)
      }
    })
    child.stderr.on('data', () => {})
    child.on('error', () => finish(null))
    child.stdin.on('error', () => {})
    // 0: some ignored, 1: none; anything else is git failing.
    child.on('close', (code) => finish(code === 0 || code === 1 ? new Set(out.split('\0').filter(Boolean)) : null))
    child.stdin.end(rels.join('\0') + '\0')
  })
}

// --- The scope -----------------------------------------------------------------------
// One per host: the roots' real paths and each project's ignored files, kept
// between requests. ignoreCheck(cwd, safety, rels) and gitTop(root) can be
// given (tests); git by default.
export function createShareScope({ ignoreCheck = checkIgnore, gitTop = defaultGitTop, hooksPath = defaultHooksPath } = {}) {
  const roots = new Map() // root as given -> { root, real }
  const ignores = new Map() // real root -> { at, repo: Promise<{ top, safety } | null>, known: Map rel -> bool }
  // Paths seen ignored, per real root, for the share (never shown again by a
  // change of a .gitignore).
  const sticky = new Map() // real root -> Set of lower-case rels
  const STICKY_MAX = 200000

  function root(path) {
    if (roots.has(path)) return roots.get(path)
    const info = rootInfo(path)
    if (info) {
      roots.set(path, info)
      if (roots.size > 64) roots.delete(roots.keys().next().value)
    }
    return info
  }

  function ignoreState(real) {
    let s = ignores.get(real)
    if (!s || Date.now() - s.at > IGNORE_TTL_MS || s.known.size > IGNORE_CACHE_MAX) {
      s = { at: Date.now(), repo: null, known: new Map() }
      ignores.set(real, s)
      if (ignores.size > 64) ignores.delete(ignores.keys().next().value)
    }
    if (!s.repo) {
      s.repo = (async () => {
        const top = await gitTop(real)
        if (!top) return null
        return { top, safety: await localGitArgs(top, { ask: false }) }
      })().catch(() => null)
    }
    return s
  }

  const stickyOf = (real) => {
    let set = sticky.get(real)
    if (!set) sticky.set(real, (set = new Set()))
    return set
  }
  // Which of rels (paths from the root's real path) git ignores: -> Set. Not
  // a repository: none. git failing: all of them (not kept: asked again).
  // One git run for all the paths not known yet; charge() is asked first (a
  // guest's budget: false -> the request is refused as busy). A path once
  // seen ignored stays so for the share.
  async function ignoredOf(info, rels, { charge = null } = {}) {
    const list = [...new Set(rels.filter((r) => typeof r === 'string' && r))]
    if (!list.length) return new Set()
    const s = ignoreState(info.real)
    const repo = await s.repo
    const seen = stickyOf(info.real)
    // Seen ignored before, itself or a folder it is in.
    const stuck = (r) => {
      const segs = lower(r).split('/')
      for (let i = 1; i <= segs.length; i++) if (seen.has(segs.slice(0, i).join('/'))) return true
      return false
    }
    const out = new Set(seen.size ? list.filter(stuck) : [])
    if (!repo) return out
    const ask = []
    for (const r of list) {
      if (out.has(r)) continue
      const k = lower(r)
      if (s.known.has(k)) {
        if (s.known.get(k)) out.add(r)
      } else ask.push(r)
    }
    if (ask.length) {
      if (typeof charge === 'function' && charge() === false) throw Object.assign(new Error('busy'), { code: 'busy' }) // i18n-ignore internal: answered 'busy'
      const hits = await ignoreCheck(info.real, repo.safety, ask)
      if (!hits) {
        for (const r of ask) out.add(r)
        return out
      }
      const hitKeys = new Set([...hits].map(lower))
      for (const r of ask) {
        const ignored = hitKeys.has(lower(r))
        s.known.set(lower(r), ignored)
        if (ignored) {
          out.add(r)
          if (seen.size < STICKY_MAX) seen.add(lower(r))
        }
      }
    }
    return out
  }

  // The project's folder (path) or the host's setting changed: what was kept
  // about it is read again (paths seen ignored stay hidden: reset() ends the
  // share's).
  function invalidate(path) {
    if (path === undefined) {
      roots.clear()
      ignores.clear()
      return
    }
    const info = roots.get(path)
    roots.delete(path)
    ignores.delete(path)
    if (info) ignores.delete(info.real)
  }
  // Files of a project changed (its watch): only what was kept about them is
  // read again; a .gitignore changed, or none known: every answer not
  // "ignored".
  function invalidatePaths(real, rels) {
    const s = ignores.get(real)
    if (!s) return
    if (!Array.isArray(rels) || rels.some((r) => /(^|\/)\.gitignore$/i.test(r))) {
      for (const [k, v] of [...s.known]) if (!v) s.known.delete(k)
      return
    }
    for (const r of rels) if (s.known.get(lower(r)) === false) s.known.delete(lower(r))
  }
  // A new share: nothing kept from the last one.
  function reset() {
    roots.clear()
    ignores.clear()
    sticky.clear()
    hookFolders.clear()
  }

  // The folder the project's git runs its hooks from (core.hooksPath), when
  // it is inside the project: [rel] (lower case), kept a while.
  const hookFolders = new Map() // real root -> { at, value: Promise<string[]> }
  function protectedOf(info) {
    const hit = hookFolders.get(info.real)
    if (hit && Date.now() - hit.at < IGNORE_TTL_MS) return hit.value
    const value = (async () => {
      const s = ignoreState(info.real)
      const repo = await s.repo
      if (!repo) return []
      // (Read without the -c overrides: a guest's own hide the real one.)
      const where = await hooksPath(info.real, ['-c', 'core.fsmonitor=false'])
      if (!where) return []
      const full = isAbsolute(where) ? where : resolve(repo.top, where)
      let real
      try {
        real = fs.realpathSync.native(full)
      } catch {
        real = full
      }
      const rel = relFrom(info.real, real)
      return rel ? [lower(rel)] : rel === '' ? [''] : []
    })().catch(() => [])
    hookFolders.set(info.real, { at: Date.now(), value })
    if (hookFolders.size > 64) hookFolders.delete(hookFolders.keys().next().value)
    return value
  }

  // Is anything below a folder (rel) hidden from guests, or write-protected
  // for them (rights: theirs)? A walk of the folder (links not followed), at
  // most BELOW_MAX entries (more: yes, as it can't be told), then one check
  // of what git ignores. -> Promise<boolean>
  async function hiddenBelow(info, rel, { settings, rights = null, extra = null, charge = null } = {}) {
    const start = rel ? join(info.real, ...rel.split('/')) : info.real
    const stack = [[start, rel]]
    const names = []
    while (stack.length) {
      const [dir, base] = stack.pop()
      let items
      try {
        items = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return true
      }
      for (const d of items) {
        const r = base ? `${base}/${d.name}` : d.name
        if (hiddenByName(r, settings) || touchesSpecial(r) || !writeAllowed(r, rights, extra)) return true
        names.push(r)
        if (names.length > BELOW_MAX) return true
        if (d.isDirectory() && !d.isSymbolicLink()) stack.push([join(dir, d.name), r])
      }
    }
    if (!hidesPrivate(settings) || !names.length) return false
    return (await ignoredOf(info, names, { charge })).size > 0
  }

  // Of these paths (from the root: lexical and real alike), the ones a guest
  // may not see (one check of git's for all of them). -> Set
  async function hiddenOf(info, rels, settings, { charge = null } = {}) {
    const out = new Set()
    const rest = []
    for (const r of rels) {
      if (hiddenByName(r, settings)) out.add(r)
      else rest.push(r)
    }
    if (hidesPrivate(settings) && rest.length) for (const r of await ignoredOf(info, rest, { charge })) out.add(r)
    return out
  }

  // A guest's path in the project at `rootPath` -> where it is on disk.
  // mustExist: true (it must be there), false (a file or folder about to be
  // made: its folder must be there) or 'any' (a path git still names, like a
  // file deleted with its folder: the part that is there is checked, the
  // rest by name). kind: 'file' | 'dir' | 'any'.
  // -> { ok: true, rel, realRel, real, entry, parentReal, exists, isDir,
  //      isFile, size, id, rootReal }
  //  | { ok: false, code } ('no-project' | 'bad-path' | 'not-found' |
  //    'not-file')
  // real: the target's real path (null when it does not exist yet); entry:
  // the name itself in its folder's real path (a link stays the link: what a
  // rename or the Recycle Bin acts on).
  // skipIgnore: what git ignores is the caller's check (a listing asks git
  // once for the folder and its entries together): rel and realRel.
  async function resolveRel(rootPath, rel, { settings, mustExist = true, kind = 'any', charge = null, skipIgnore = false } = {}) {
    const info = root(rootPath)
    if (!info) return { ok: false, code: 'no-project' }
    const segs = relSegments(rel)
    if (!segs) return { ok: false, code: 'bad-path' }
    if (hiddenByName(rel, settings)) return { ok: false, code: 'not-found' }
    const missing = { ok: false, code: 'not-found' }
    // Down from the root, each part as it is on disk; a link only when it
    // lands inside the folder (then followed from where it lands).
    let dir = info.real
    let found = 0
    for (let i = 0; i < segs.length; i++) {
      const next = join(dir, segs[i])
      let l
      try {
        l = fs.lstatSync(next)
      } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) break
        return missing
      }
      let target = next
      if (l.isSymbolicLink()) {
        try {
          target = fs.realpathSync.native(next)
        } catch {
          return missing // a link to nothing
        }
        if (!within(info.real, target)) return missing
      }
      found = i + 1
      if (i < segs.length - 1) {
        try {
          if (!fs.statSync(target).isDirectory()) return missing
        } catch {
          return missing
        }
        dir = target
      }
    }
    const exists = found === segs.length
    if (!exists && (mustExist === true || (mustExist !== 'any' && found < segs.length - 1))) return missing
    let parentReal = null
    let real = null
    let realRel
    let entry
    try {
      if (!segs.length) {
        real = info.real
        entry = info.real
        realRel = ''
      } else {
        // dir: the entry's folder when it is there, else the deepest folder
        // that is (the rest of the path is missing).
        const dirReal = fs.realpathSync.native(dir)
        if (!within(info.real, dirReal)) return missing
        const tail = exists ? [segs[segs.length - 1]] : segs.slice(found)
        entry = join(dirReal, ...tail)
        parentReal = tail.length > 1 ? join(dirReal, ...tail.slice(0, -1)) : dirReal
        if (exists) {
          real = fs.realpathSync.native(entry)
          if (!within(info.real, real)) return missing
          realRel = relFrom(info.real, real)
        } else {
          const p = relFrom(info.real, dirReal)
          realRel = [p, ...tail].filter(Boolean).join('/')
        }
      }
    } catch {
      return missing
    }
    if (realRel === null || hiddenByName(realRel, settings)) return missing
    if (!skipIgnore && hidesPrivate(settings) && (await ignoredOf(info, [rel, realRel], { charge })).size) return missing
    let id = null
    let isDir = false
    let isFile = false
    let size = 0
    if (exists) {
      try {
        id = fs.statSync(real, { bigint: true })
        isDir = id.isDirectory()
        isFile = id.isFile()
        size = Number(id.size)
      } catch {
        return missing
      }
      if (kind === 'file' && !isFile) return { ok: false, code: isDir ? 'not-file' : 'not-found' }
      if (kind === 'dir' && !isDir) return missing
    }
    return { ok: true, rel, realRel, real, entry, parentReal, exists, isDir, isFile, size, id, rootReal: info.real }
  }

  // A file resolved above, read through one handle: it must still be the
  // same file (dev, inode) and still resolve inside the folder.
  // -> { ok: true, buf, stat } | { ok: false, code } ('not-found' |
  //    'not-file' | 'too-large' | 'failed')
  function readResolved(resolved, maxBytes) {
    if (!resolved || !resolved.ok || !resolved.exists || !resolved.real) return { ok: false, code: 'not-found' }
    let fd
    try {
      fd = fs.openSync(resolved.real, 'r')
    } catch (err) {
      return { ok: false, code: err && err.code === 'ENOENT' ? 'not-found' : 'failed' }
    }
    try {
      const id = fs.fstatSync(fd, { bigint: true })
      if (!sameFile(id, resolved.id)) return { ok: false, code: 'not-found' }
      if (!id.isFile()) return { ok: false, code: 'not-file' }
      let now
      try {
        now = fs.realpathSync.native(resolved.real)
      } catch {
        return { ok: false, code: 'not-found' }
      }
      if (!within(resolved.rootReal, now)) return { ok: false, code: 'not-found' }
      if (id.size > BigInt(maxBytes)) return { ok: false, code: 'too-large' }
      const stat = fs.fstatSync(fd)
      const buf = Buffer.alloc(Number(id.size))
      let n = 0
      while (n < buf.length) {
        const got = fs.readSync(fd, buf, n, buf.length - n, n)
        if (!got) break
        n += got
      }
      return { ok: true, buf: buf.subarray(0, n), stat }
    } catch {
      return { ok: false, code: 'failed' }
    } finally {
      try {
        fs.closeSync(fd)
      } catch {
        // closed
      }
    }
  }

  return { root, resolve: resolveRel, readResolved, hiddenOf, ignoredOf, invalidate, invalidatePaths, reset, hiddenBelow, protectedOf }
}

// The project's core.hooksPath (as set, relative to the repository's top or
// absolute), or null.
function defaultHooksPath(cwd, safety) {
  return new Promise((done) => {
    let child
    let out = ''
    try {
      child = spawn('git', ['-C', cwd, ...safety, 'config', '--get', 'core.hooksPath'], { windowsHide: true, env: cleanEnv(process.env) })
    } catch {
      return done(null)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // gone already
      }
    }, IGNORE_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (x) => {
      if (out.length < 4096) out += x
    })
    child.stderr.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0 && out.trim() ? out.trim() : null)
    })
  })
}

// The repository's top for a folder, or null (not one, no git).
function defaultGitTop(cwd) {
  return new Promise((done) => {
    let child
    let out = ''
    try {
      child = spawn('git', ['-C', cwd, '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], { windowsHide: true, env: cleanEnv(process.env) })
    } catch {
      return done(null)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // gone already
      }
    }, IGNORE_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (s) => {
      if (out.length < 8192) out += s
    })
    child.stderr.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0 && out.trim() ? resolve(out.trim()) : null)
    })
  })
}

// --- The last guard on the way out ---------------------------------------------------
const HIDDEN = '…'
const PATH_CHAR = `[^\\s"'<>|*?]`
// A space inside a path: followed by more of it with a separator.
const PATH_SPACE = `[ \\t](?=[^\\s"'<>|*?\\\\/]*[\\\\/])`
const PATH_BODY = `(?:${PATH_CHAR}|${PATH_SPACE})*`
const HOST_PATHS = [
  // C:\..., C:/..., also inside file:///C:/...
  new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]${PATH_BODY}`, 'g'),
  // \\server\share\..., \\?\..., \\.\...
  new RegExp(`\\\\\\\\(?:[?.]\\\\)?[^\\s\\\\/"'<>|*?]+${PATH_BODY}`, 'g'),
  // //server/share/... (not an address's //host)
  new RegExp(`(?<![:\\w/])//[^\\s/"'<>|*?]+/${PATH_BODY}`, 'g')
]

// The ways a host folder may be written: as given, with "/", and as Git Bash
// writes it (/c/Users/...); without case.
function needlesOf(paths) {
  const out = new Set()
  for (const p of paths) {
    if (typeof p !== 'string' || p.length < 4) continue
    const base = p.replace(/[\\/]+$/, '')
    for (const v of [base, base.replace(/\\/g, '/'), base.replace(/\//g, '\\')]) {
      out.add(v.toLowerCase())
      const m = /^([A-Za-z]):[\\/](.*)$/.exec(v)
      if (m) out.add(`/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`.toLowerCase())
    }
  }
  // Longest first: a folder inside another is replaced whole.
  return [...out].filter((n) => n.length >= 4).sort((a, b) => b.length - a.length)
}

function scrub(text, needles, count) {
  let out = text
  for (const n of needles) {
    let low = out.toLowerCase()
    let at = low.indexOf(n)
    while (at >= 0) {
      out = out.slice(0, at) + HIDDEN + out.slice(at + n.length)
      count.hits++
      low = out.toLowerCase()
      at = low.indexOf(n, at + HIDDEN.length)
    }
  }
  for (const re of HOST_PATHS) {
    out = out.replace(re, () => {
      count.hits++
      return HIDDEN
    })
  }
  return out
}

// Every string of an answer (keys too) without the host's folders: the
// roots' paths (as given and real, and any other host folder given with
// them, like a repository's top or the home folder) and any drive, share or
// long path become "…". keep: dotted paths of fields left as they are (a
// file's own text, which the guest may save back: "text", "results.*.text").
// -> { value, hits } (hits: how many were replaced, for the log).
export function assertNoHostPaths(payload, roots, { keep = [] } = {}) {
  const list = Array.isArray(roots) ? roots : roots ? [roots] : []
  const needles = needlesOf([...list, os.homedir()])
  const kept = keep.map((k) => k.split('.'))
  const count = { hits: 0 }
  const isKept = (path) => kept.some((k) => k.length === path.length && k.every((part, i) => part === path[i]))
  const walk = (v, path, depth) => {
    if (typeof v === 'string') return scrub(v, needles, count)
    if (v === null || typeof v !== 'object') return typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' ? null : v
    if (depth > 32) return null
    if (Array.isArray(v)) return v.map((x) => walk(x, [...path, '*'], depth + 1))
    const out = {}
    for (const [k, x] of Object.entries(v)) {
      const key = scrub(k, needles, count)
      out[key] = isKept([...path, k]) && typeof x === 'string' ? x : walk(x, [...path, k], depth + 1)
    }
    return out
  }
  return { value: walk(payload, [], 0), hits: count.hits }
}
