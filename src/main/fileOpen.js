// File references clicked in a terminal (src/shared/fileLinks.js): which
// exist, and opening one at its line (VS Code when installed, else the
// file's default program). Also the project's files for Jump to file.
import fs from 'fs'
import os from 'os'
import { isAbsolute, resolve, join, relative } from 'path'
import { execFile } from 'child_process'
import { t } from './i18n'
import { isRemotePath } from '../shared/remotePath'

// { cwd, paths: [...], detail } -> { [path]: absolute path | null } for the
// files that exist (a folder or a name that merely looks like a file is not
// a link); with detail: { [path]: { path, kind: 'file' | 'dir' } | null },
// folders included. A batch is capped (MAX_RESOLVE).
// Never blocks the main process: each look is fs.promises.stat with its own
// time limit, one at a time per drive or share, and a drive that did not
// answer in time (a mapped network drive that is gone, a sleeping disk) is
// skipped for a while instead of being asked again on every hover.
// "~" is the home folder. A network share (\\server\share) or a device path
// (\\?\, \\.\) is never looked up: asking a server for a file can hand it
// your Windows sign-in; WSL's own share (\\wsl.localhost\…, \\wsl$\…) is
// this PC's.
// opts.remote(paths) -> { [ssh:// path]: 'file' | 'dir' | null }: the SSH
// paths of the batch, looked up over the connection (remoteFs.statLinks).
export const MAX_RESOLVE = 100
export const STAT_TIMEOUT_MS = 1500
export const DEAD_ROOT_MS = 30000
const deadRoots = new Map() // root -> until (ms)
const CONTROL = /[\u0000-\u001f]/

// The drive or share a path is on: C:, \\wsl.localhost\ubuntu, or / .
export function statRoot(full) {
  const unc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)/.exec(full)
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`.toLowerCase()
  const drive = /^([A-Za-z]):/.exec(full)
  return drive ? `${drive[1].toUpperCase()}:` : '/'
}

export function lookablePath(full) {
  if (/^[\\/]{2}/.test(full)) return /^[\\/]{2}wsl(?:\$|\.localhost)[\\/][^\\/?*]+/i.test(full)
  return true
}

function statWithin(stat, full, ms) {
  let timer = null
  return Promise.race([
    Promise.resolve()
      .then(() => stat(full))
      .then(
        (st) => ({ st }),
        () => ({ st: null })
      ),
    new Promise((done) => {
      timer = setTimeout(() => done({ timeout: true }), ms)
      if (timer.unref) timer.unref()
    })
  ]).finally(() => clearTimeout(timer))
}

export async function resolveFiles(
  { cwd, paths, detail = false } = {},
  { stat = (p) => fs.promises.stat(p), timeoutMs = STAT_TIMEOUT_MS, home = os.homedir(), remote = null, now = () => Date.now() } = {}
) {
  const out = {}
  const list = Array.isArray(paths) ? paths.slice(0, MAX_RESOLVE) : []
  const base = typeof cwd === 'string' && cwd && !isRemotePath(cwd) && isAbsolute(cwd) ? cwd : null
  const byRoot = new Map() // root -> [[p, full]]
  const remotePaths = []
  for (const p of list) {
    if (typeof p !== 'string' || !p || p.length > 1000 || CONTROL.test(p)) continue
    out[p] = null
    if (isRemotePath(p)) {
      remotePaths.push(p)
      continue
    }
    const named = p === '~' || /^~[\\/]/.test(p) ? join(home, p.slice(1)) : p
    const full = isAbsolute(named) ? named : base ? resolve(base, named) : null
    if (!full || !lookablePath(full)) continue
    const root = statRoot(full)
    if (!byRoot.has(root)) byRoot.set(root, [])
    byRoot.get(root).push([p, full])
  }
  const kindOf = (st) => (st && st.isFile() ? 'file' : st && st.isDirectory() ? 'dir' : null)
  const put = (p, full, kind) => {
    if (!kind || (!detail && kind !== 'file')) return
    out[p] = detail ? { path: full, kind } : full
  }
  const jobs = [...byRoot].map(async ([root, items]) => {
    for (const [p, full] of items) {
      if ((deadRoots.get(root) || 0) > now()) return
      const res = await statWithin(stat, full, timeoutMs)
      if (res.timeout) {
        deadRoots.set(root, now() + DEAD_ROOT_MS)
        return
      }
      put(p, full, kindOf(res.st))
    }
  })
  if (remotePaths.length && typeof remote === 'function') {
    jobs.push(
      Promise.resolve()
        .then(() => remote(remotePaths))
        .then((kinds) => {
          for (const p of remotePaths) put(p, p, kinds && (kinds[p] === 'file' || kinds[p] === 'dir') ? kinds[p] : null)
        })
        .catch(() => {})
    )
  }
  await Promise.all(jobs)
  return out
}
// WSL's default distro (wsl.exe with no -d), as its registry key names it:
// HKCU\…\Lxss DefaultDistribution = {guid}, and {guid}\DistributionName.
// -> Promise<string | null>
const LXSS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'
export function regValue(out, name) {
  const m = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'mi').exec(String(out || ''))
  return m ? m[1] : null
}
function regQuery(key, name, run) {
  return new Promise((done) =>
    run('reg.exe', ['query', key, '/v', name], { windowsHide: true, timeout: 5000 }, (err, stdout) => done(err ? null : regValue(stdout, name)))
  )
}
export async function defaultWslDistro({ run = execFile, platform = process.platform } = {}) {
  if (platform !== 'win32') return null
  const guid = await regQuery(LXSS, 'DefaultDistribution', run)
  if (!guid || !/^\{[0-9a-f-]{36}\}$/i.test(guid)) return null
  const name = await regQuery(`${LXSS}\\${guid}`, 'DistributionName', run)
  return name && /^[\w.-]{1,64}$/.test(name) ? name : null
}

// For tests: forget the drives that did not answer.
export function forgetDeadRoots() {
  deadRoots.clear()
}

// VS Code's "go to" argument: file:line:col.
export function codeGotoArg(file, line, col) {
  return line ? `${file}:${line}${col ? `:${col}` : ''}` : file
}

export const MAX_LISTED_FILES = 20000
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'out', 'build', '.next', '.cache', 'target'])

// Every file of a project, relative, with "/" (Jump to file): git's own list
// when it is a repository (tracked and untracked, never what .gitignore
// ignores), else a walk that skips heavy folders. -> { ok, files, truncated, source }
export async function listProjectFiles(root) {
  if (typeof root !== 'string' || !root || !fs.existsSync(root) || !fs.statSync(root).isDirectory())
    return { ok: false, error: t('main.review.noProject', 'The project folder is missing.') }
  const fromGit = await new Promise((done) =>
    execFile(
      'git',
      // core.fsmonitor off: a repository's own settings never run a program here.
      ['-C', root, '-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 20000 },
      (err, stdout) => done(err ? null : String(stdout))
    )
  )
  if (fromGit !== null) {
    const all = [...new Set(fromGit.split('\0').filter(Boolean))]
    return { ok: true, files: all.slice(0, MAX_LISTED_FILES), truncated: all.length > MAX_LISTED_FILES, source: 'git' }
  }
  const files = []
  const stack = [root]
  while (stack.length && files.length < MAX_LISTED_FILES) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full)
      } else if (e.isFile()) {
        files.push(relative(root, full).split('\\').join('/'))
        if (files.length >= MAX_LISTED_FILES) break
      }
    }
  }
  return { ok: true, files: files.sort(), truncated: files.length >= MAX_LISTED_FILES, source: 'walk' }
}
