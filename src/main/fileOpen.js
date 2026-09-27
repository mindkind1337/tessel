// File references clicked in a terminal (src/shared/fileLinks.js): which
// exist, and opening one at its line (VS Code when installed, else the
// file's default program).
import fs from 'fs'
import { isAbsolute, resolve } from 'path'

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
