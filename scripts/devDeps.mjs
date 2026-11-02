// `npm run dev`: the packages this copy's code needs, installed when they are missing. A copy
// brought up to date by hand or by an agent gets new code without the packages it now imports,
// and the window then opens on Vite's red error.
//
// package-lock.json says what must be there, and each package's own package.json what is there.
// Once they agree, a stamp in node_modules holds the lock file's digest, so the next starts read
// one file instead of hundreds. The install writes neither package.json nor the lock file
// (--no-save): a copy that follows a branch must not end up with changes of its own.
//
// Nothing here stops Tessel from starting: a restart the person asked for must come back, even
// when the install could not finish (no network, a file held by a running terminal).
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'

const STAMP = '.tessel-deps'

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// The packages the lock file wants that are absent or of another version: { missing, different }.
// A package for another system or an optional one may rightly be absent.
export function staleDeps(root, lock) {
  const missing = []
  const different = []
  for (const [key, wanted] of Object.entries((lock && lock.packages) || {})) {
    if (!key.startsWith('node_modules/') || !wanted || wanted.link || wanted.optional || wanted.peer) continue
    const found = readJson(path.join(root, key, 'package.json'))
    if (!found) missing.push(key.slice(key.lastIndexOf('node_modules/') + 13))
    else if (wanted.version && found.version !== wanted.version) different.push(key.slice(key.lastIndexOf('node_modules/') + 13))
  }
  return { missing, different }
}

// At most ten minutes (Electron's download can take a while): a stuck install must not hold up the start.
const npmInstall = (root, env) => spawnSync('npm install --no-save --no-audit --no-fund', { cwd: root, env, stdio: 'inherit', shell: true, windowsHide: true, timeout: 10 * 60 * 1000 }).status === 0

// -> 'current' | 'installed' | 'failed' | 'nothing' (no lock file: nothing to compare with)
export function ensureDeps(root, { env = process.env, install = npmInstall, log = console.log, warn = console.error } = {}) {
  let text
  try {
    text = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')
  } catch {
    return 'nothing'
  }
  const digest = createHash('sha256').update(text).digest('hex')
  const stamp = path.join(root, 'node_modules', STAMP)
  try {
    if (fs.readFileSync(stamp, 'utf8').trim() === digest) return 'current'
  } catch {
    // no stamp yet: looked at below
  }
  const remember = () => {
    try {
      fs.writeFileSync(stamp, digest)
    } catch {
      // looked at again next time
    }
  }
  const lock = readJson(path.join(root, 'package-lock.json'))
  if (!lock) return 'nothing'
  const { missing, different } = staleDeps(root, lock)
  if (!missing.length && !different.length) {
    remember()
    return 'current'
  }
  const names = [...missing, ...different]
  log(`Tessel: ${names.length} package(s) to install (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''}): running npm install...`)
  let done = false
  try {
    done = install(root, env) === true
  } catch {
    done = false
  }
  const left = done ? staleDeps(root, lock) : null
  if (left && !left.missing.length && !left.different.length) {
    remember()
    return 'installed'
  }
  warn('Tessel: the install did not finish, so some parts may not work. Close Tessel, then run: npm install')
  return 'failed'
}
