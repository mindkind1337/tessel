// File references clicked in a terminal (src/shared/fileLinks.js): which
// exist, and opening one at its line (VS Code when installed, else the
// file's default program). Also the project's files for Jump to file.
import fs from 'fs'
import { isAbsolute, resolve, join, relative } from 'path'
import { execFile } from 'child_process'
import { t } from './i18n'

// { cwd, paths: [...] } -> { [path]: absolute path | null }. Only files that
// exist (a folder or a name that merely looks like a file is not a link).
export function resolveFiles({ cwd, paths } = {}) {
  const out = {}
  for (const p of Array.isArray(paths) ? paths.slice(0, 200) : []) {
    if (typeof p !== 'string' || !p || p.length > 1000) continue
    let full = null
    try {
      const candidate = isAbsolute(p) ? p : cwd ? resolve(cwd, p) : null
      if (candidate && fs.statSync(candidate).isFile()) full = candidate
    } catch {
      full = null
    }
    out[p] = full
  }
  return out
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
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
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
