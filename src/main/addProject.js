// "Add a project" in the main process, like Orca's (MIT, Copyright (c) 2026
// Lovecast Inc.): src/main/ipc/repos/repo-clone-lifecycle.ts,
// src/main/git/repo-clone-path.ts, src/shared/git-clone-failure-message.ts,
// src/main/ipc/repos/repo-creation-handlers.ts and
// src/main/ipc/repos/nested-repo-scan-ipc.ts.
//
// - Clone from URL: `git clone --progress -- <url> <folder>` spawned with an
//   argv (no shell), never prompting (a credential prompt nobody can see
//   would hang it), with its progress sent to the window; Cancel kills it and
//   removes the folder only when this clone created it.
// - Create new project: <parent>\<name>, `git init` and an empty first
//   commit, as Orca does.
// - Browse folder: the folder's nested repositories (nestedRepoScan.js),
//   bounded, stoppable, with live progress.
// The renderer only receives paths and results; it makes the workspace.
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import { spawn, execFile } from 'child_process'
import { isAbsolute, join, relative, resolve, sep, win32, posix } from 'path'
import { scanNestedRepos, localScanFilesystem } from './nestedRepoScan'
import { t } from './i18n'

const CONTROL = /[\u0000-\u001f\u007f]/
const WINDOWS_BAD_NAME_CHARS = /[<>:"|?*]/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

// Where "Create new project" and "Clone from URL" start: ~/tessel/projects
// (Orca: ~/orca/projects).
export function defaultProjectsParent(home = os.homedir()) {
  return join(home, 'tessel', 'projects')
}

// --- Clone URL ------------------------------------------------------------------
// Accepted: https://, http://, ssh://, git://, file:// URLs; scp-like
// user@host:path (git@github.com:me/repo.git); a local absolute path (a bare
// repository on this computer). Refused: anything starting with "-" (git
// would read an option), control characters, git's command transports
// (ext::, fd::) and other <helper>:: forms, and hosts starting with "-".
// -> { url } | { error: code }
export function validateCloneUrl(raw) {
  const url = String(raw ?? '').trim()
  if (!url) return { error: 'url-required' }
  if (url.startsWith('-')) return { error: 'url-option' }
  if (url.length > 2048 || CONTROL.test(url) || /\s/.test(url)) return { error: 'url-invalid' }
  if (/^[A-Za-z][\w+.-]*::/.test(url)) return { error: 'url-scheme' }
  const scheme = url.match(/^([A-Za-z][\w+.-]*):\/\//)
  if (scheme) {
    const s = scheme[1].toLowerCase()
    if (!['https', 'http', 'ssh', 'git', 'file'].includes(s)) return { error: 'url-scheme' }
    if (s === 'file') return url.length > 'file://'.length ? { url } : { error: 'url-invalid' }
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return { error: 'url-invalid' }
    }
    if (!parsed.hostname || parsed.hostname.startsWith('-')) return { error: 'url-invalid' }
    return { url }
  }
  // scp-like: [user@]host:path — never a Windows drive (C:\...).
  const scp = url.match(/^(?:([A-Za-z0-9._~-]+)@)?([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):(?!\/\/)(.+)$/)
  if (scp && !/^[A-Za-z]$/.test(scp[2])) {
    if (scp[2].startsWith('-') || (scp[1] && scp[1].startsWith('-'))) return { error: 'url-invalid' }
    return { url }
  }
  if (win32.isAbsolute(url) && /^([A-Za-z]:[\\/]|\\\\)/.test(url)) return { url }
  return { error: 'url-scheme' }
}

// The folder git clone would make: the URL's last segment without .git.
// Refuses ".", "..", and names Windows cannot hold.
export function deriveCloneRepoName(url) {
  let source = String(url).replace(/[\\/]+$/, '').replace(/\.git$/i, '')
  // scp-like: the path part only.
  const scp = source.match(/^(?:[^@/\\]+@)?[^:/\\]+:(?!\/\/)(.*)$/)
  if (scp && !/^[A-Za-z]:/.test(source)) source = scp[1]
  const isWindowsLocal = /^[A-Za-z]:[\\/]/.test(source) || source.startsWith('\\\\')
  const name = isWindowsLocal ? win32.basename(source) : posix.basename(source)
  if (!isValidFolderName(name)) return null
  return name
}

export function isValidFolderName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..') return false
  if (name.length > 255 || CONTROL.test(name) || /[\\/]/.test(name)) return false
  if (WINDOWS_BAD_NAME_CHARS.test(name) || WINDOWS_RESERVED.test(name)) return false
  if (/[. ]$/.test(name)) return false
  return true
}

// -> { clonePath, name } | { error: code }
export function deriveClonePath({ url, destination }) {
  const dest = String(destination ?? '').trim()
  if (!dest || !isAbsolute(dest) || CONTROL.test(dest)) return { error: 'destination-invalid' }
  const name = deriveCloneRepoName(url)
  if (!name) return { error: 'name-invalid' }
  const clonePath = join(dest, name)
  const rel = relative(resolve(dest), resolve(clonePath))
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { error: 'name-invalid' }
  return { clonePath, name }
}

// The argv of the clone (never through a shell). "--" ends the options: the
// URL and folder can never be read as flags.
export function cloneArgs(url, clonePath) {
  return ['-c', 'protocol.ext.allow=never', '-c', 'protocol.fd.allow=never', 'clone', '--progress', '--', url, clonePath]
}

// Git that never asks anything (Orca's nonInteractiveGitEnv): no terminal
// prompt, no credential window, ssh in batch mode.
export function nonInteractiveGitEnv(env = process.env) {
  const next = { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' }
  if (!next.GIT_SSH_COMMAND) next.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  return next
}

// A token typed into an https URL must not come back in an error message.
export function stripCredentials(text) {
  return String(text || '').replace(/([a-z][\w+.-]*:\/\/)[^/@\s]+@/gi, '$1***@')
}

// "Receiving objects:  45% (9/20)" -> { phase, percent } (any language).
export function parseCloneProgress(text) {
  const out = []
  for (const line of String(text).split(/[\r\n]+/)) {
    const m = line.match(/^(?:remote:\s*)?([^:\r\n]{2,60}):\s+(\d{1,3})%/)
    if (m) out.push({ phase: m[1].trim(), percent: Math.min(100, Number.parseInt(m[2], 10)) })
  }
  return out
}

// git's stderr -> the line that says why (Orca's getGitCloneFailureLine).
export function cloneFailureMessage(stderr, clonePath) {
  const lines = stripCredentials(stderr)
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter(Boolean)
  let line = lines.length ? lines[lines.length - 1] : ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const f = lines[i].indexOf('fatal:')
    const e = lines[i].indexOf('error:')
    if (f !== -1) {
      line = lines[i].slice(f)
      break
    }
    if (e !== -1) {
      line = lines[i].slice(e)
      break
    }
  }
  if (/already exists and is not an empty directory|repository exists/i.test(line)) {
    return t(
      'main.project.clone.exists',
      'Destination already exists and is not empty: {{path}}. Choose a different parent folder, delete the existing folder, or add the existing repository instead.',
      { path: clonePath || '' }
    )
  }
  return line || t('main.project.unknownError', 'unknown error')
}

export function errorText(code) {
  switch (code) {
    case 'url-required':
      return t('main.project.clone.urlRequired', 'Enter the Git URL.')
    case 'url-option':
      return t('main.project.clone.urlOption', 'A Git URL cannot start with "-".')
    case 'url-scheme':
      return t('main.project.clone.urlScheme', 'Use an https://, ssh:// or git@host:path URL, or the path of a repository on this computer.')
    case 'url-invalid':
      return t('main.project.clone.urlInvalid', 'This Git URL is not valid.')
    case 'destination-invalid':
      return t('main.project.clone.destinationInvalid', 'Choose an absolute parent folder.')
    case 'name-invalid':
      return t('main.project.clone.nameInvalid', 'No valid folder name can be made from this URL.')
    case 'busy':
      return t('main.project.clone.busy', 'A clone is already running.')
    case 'aborted':
      return t('main.project.clone.aborted', 'Clone aborted')
    case 'no-git':
      return t('main.project.noGit', 'Git is required to create a project.')
    default:
      return typeof code === 'string' && code ? code : t('main.project.unknownError', 'unknown error')
  }
}

// --- Folder identity: only the folder this clone created is ever removed. ------
async function claimTarget(path) {
  try {
    await fsp.mkdir(path, { recursive: false })
    const st = await fsp.lstat(path)
    return { owned: { dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs } }
  } catch (err) {
    if (err && err.code === 'EEXIST') return { owned: null }
    throw err
  }
}

async function cleanupTarget(path, claim) {
  if (!claim || !claim.owned) return
  try {
    const st = await fsp.lstat(path)
    if (!st.isDirectory()) return
    const o = claim.owned
    if (st.dev !== o.dev || st.ino !== o.ino || st.birthtimeMs !== o.birthtimeMs) return
  } catch {
    return
  }
  await fsp.rm(path, { recursive: true, force: true }).catch(() => {})
}

// --- The service ------------------------------------------------------------------
// spawnFn/execFileFn: injected in tests. git: the git executable.
export function createAddProject({ spawnFn = spawn, execFileFn = execFile, git = 'git', send = () => {}, env = () => process.env, home = os.homedir() } = {}) {
  let activeClone = null // { proc, clonePath, claim, aborted }
  const scans = new Map() // scanId -> AbortController

  function runGit(args, cwd, timeout = 60000) {
    return new Promise((resolveRun) => {
      execFileFn(git, args, { cwd, windowsHide: true, timeout, shell: false, env: nonInteractiveGitEnv(env()) }, (err, stdout, stderr) =>
        resolveRun({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err })
      )
    })
  }

  async function isGitAvailable() {
    const r = await runGit(['--version'], home, 5000)
    return r.ok && /git version/i.test(r.stdout)
  }

  async function defaults() {
    return { ok: true, parent: defaultProjectsParent(home), gitAvailable: await isGitAvailable() }
  }

  async function isGitRepo(path) {
    const r = await runGit(['-C', path, 'rev-parse', '--is-inside-work-tree'], home, 10000)
    return r.ok && r.stdout.trim() === 'true'
  }

  async function clone(input = {}) {
    if (activeClone) return { ok: false, error: errorText('busy') }
    const checked = validateCloneUrl(input.url)
    if (checked.error) return { ok: false, code: checked.error, error: errorText(checked.error) }
    const derived = deriveClonePath({ url: checked.url, destination: input.destination })
    if (derived.error) return { ok: false, code: derived.error, error: errorText(derived.error) }
    const { clonePath, name } = derived
    const destination = String(input.destination).trim()
    let claim
    try {
      await fsp.mkdir(destination, { recursive: true })
      claim = await claimTarget(clonePath)
    } catch (err) {
      return { ok: false, error: t('main.project.clone.failed', 'Clone failed: {{error}}', { error: err.message }) }
    }
    return new Promise((done) => {
      let proc
      try {
        proc = spawnFn(git, cloneArgs(checked.url, clonePath), {
          cwd: destination,
          env: nonInteractiveGitEnv(env()),
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'ignore', 'pipe']
        })
      } catch (err) {
        void cleanupTarget(clonePath, claim).then(() =>
          done({ ok: false, error: t('main.project.clone.failed', 'Clone failed: {{error}}', { error: err.message }) })
        )
        return
      }
      const job = { proc, clonePath, claim, aborted: false }
      activeClone = job
      let tail = ''
      let settled = false
      if (proc.stderr) {
        proc.stderr.on('data', (chunk) => {
          const text = chunk.toString()
          tail = (tail + text).slice(-4096)
          for (const p of parseCloneProgress(text)) send('addProject:cloneProgress', p)
        })
      }
      const finish = async (code, signal, err) => {
        if (settled) return
        settled = true
        if (activeClone === job) activeClone = null
        const success = !err && code === 0 && !signal && !job.aborted
        if (!success) await cleanupTarget(clonePath, claim)
        if (job.aborted) return done({ ok: false, aborted: true, error: errorText('aborted') })
        if (err) {
          const why = err.code === 'ENOENT' ? t('main.project.gitMissing', 'Git was not found. Install Git for Windows and try again.') : err.message
          return done({ ok: false, error: t('main.project.clone.failed', 'Clone failed: {{error}}', { error: stripCredentials(why) }) })
        }
        if (!success) return done({ ok: false, error: t('main.project.clone.failed', 'Clone failed: {{error}}', { error: cloneFailureMessage(tail, clonePath) }) })
        done({ ok: true, path: clonePath, name })
      }
      proc.on('error', (e) => void finish(null, null, e))
      proc.on('close', (code, signal) => void finish(code, signal))
    })
  }

  function cloneAbort() {
    const job = activeClone
    if (!job) return { ok: true, aborted: false }
    job.aborted = true
    try {
      job.proc.kill()
    } catch {
      // Already gone: its close handler cleans up.
    }
    return { ok: true, aborted: true }
  }

  // -> { ok: true, path, name } | { ok: false, error }
  async function create(input = {}) {
    const name = String(input.name ?? '').trim()
    const parent = String(input.parentPath ?? '').trim()
    if (!name) return { ok: false, error: t('main.project.create.nameEmpty', 'Name cannot be empty') }
    if (!isValidFolderName(name))
      return { ok: false, error: t('main.project.create.nameInvalid', 'This name cannot be a folder name (no slashes, no <>:"|?*, not "." or "..").') }
    if (!parent) return { ok: false, error: t('main.project.create.parentRequired', 'Parent directory is required') }
    if (!isAbsolute(parent) || CONTROL.test(parent)) return { ok: false, error: t('main.project.create.parentAbsolute', 'Parent directory must be an absolute path') }
    if (!(await isGitAvailable())) return { ok: false, error: errorText('no-git') }
    const target = join(parent, name)
    let createdDir = false
    try {
      await fsp.mkdir(parent, { recursive: true })
    } catch (err) {
      return { ok: false, error: t('main.project.create.mkdirFailed', 'Failed to create directory: {{error}}', { error: err.message }) }
    }
    let exists = false
    try {
      await fsp.access(target)
      exists = true
    } catch {
      exists = false
    }
    if (exists) {
      try {
        const entries = await fsp.readdir(target)
        if (entries.length) return { ok: false, error: t('main.project.create.notEmpty', '"{{name}}" already exists at this location and is not empty.', { name }) }
      } catch (err) {
        return { ok: false, error: t('main.project.create.readFailed', 'Failed to read directory: {{error}}', { error: err.message }) }
      }
    } else {
      try {
        await fsp.mkdir(target, { recursive: false })
        createdDir = true
      } catch (err) {
        return { ok: false, error: t('main.project.create.mkdirFailed', 'Failed to create directory: {{error}}', { error: err.message }) }
      }
    }
    const init = await runGit(['init'], target)
    if (!init.ok) {
      if (createdDir) await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: t('main.project.create.initFailed', 'Failed to initialize git repository: {{error}}', { error: (init.stderr || init.err?.message || '').trim() }) }
    }
    const commit = await runGit(['commit', '--allow-empty', '-m', 'Initial commit'], target)
    if (!commit.ok) {
      if (createdDir) await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
      else await fsp.rm(join(target, '.git'), { recursive: true, force: true }).catch(() => {})
      const msg = `${commit.stderr}\n${commit.err?.message || ''}`
      if (/Please tell me who you are|user\.name|user\.email/i.test(msg))
        return {
          ok: false,
          error: t(
            'main.project.create.identity',
            'Git author identity is not configured. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then try again.'
          )
        }
      return { ok: false, error: t('main.project.create.commitFailed', 'Failed to create initial commit: {{error}}', { error: commit.stderr.trim() || commit.err?.message || '' }) }
    }
    return { ok: true, path: target, name }
  }

  // -> { ok: true, scan } | { ok: false, error }
  async function scan(input = {}) {
    const path = String(input.path ?? '')
    if (!path || !isAbsolute(path) || CONTROL.test(path)) return { ok: false, error: t('main.project.scan.absolute', 'Repo path must be an absolute path') }
    try {
      const st = await fsp.stat(path)
      if (!st.isDirectory()) return { ok: false, error: t('main.error.noProjectFolder', 'The project folder does not exist.') }
    } catch {
      return { ok: false, error: t('main.error.noProjectFolder', 'The project folder does not exist.') }
    }
    const scanId = typeof input.scanId === 'string' && /^[\w-]{1,80}$/.test(input.scanId) ? input.scanId : null
    const controller = new AbortController()
    if (scanId) {
      scans.get(scanId)?.abort()
      scans.set(scanId, controller)
    }
    try {
      const result = await scanNestedRepos({
        path,
        options: input.options,
        filesystem: localScanFilesystem({ isGitRepo }),
        signal: controller.signal,
        onProgress: scanId ? (s) => send('addProject:scanProgress', { scanId, scan: s }) : undefined
      })
      return { ok: true, scan: result }
    } catch (err) {
      return { ok: false, error: err.message }
    } finally {
      if (scanId && scans.get(scanId) === controller) scans.delete(scanId)
    }
  }

  function scanStop(scanId) {
    const c = scans.get(String(scanId || ''))
    if (c) c.abort()
    return { ok: true, stopped: !!c }
  }

  function isDirectory(path) {
    try {
      return typeof path === 'string' && isAbsolute(path) && fs.statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  return { defaults, clone, cloneAbort, create, scan, scanStop, isGitAvailable, isDirectory }
}

// IPC: addProject:* (the renderer sends a URL, a name, paths; never argv).
export function registerAddProject({ ipcMain, service }) {
  const guard = (fn) => async (_evt, arg) => {
    try {
      return await fn(arg || {})
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'failed' }
    }
  }
  ipcMain.handle('addProject:defaults', guard(() => service.defaults()))
  ipcMain.handle('addProject:clone', guard((a) => service.clone({ url: a.url, destination: a.destination })))
  ipcMain.handle('addProject:cloneAbort', guard(() => service.cloneAbort()))
  ipcMain.handle('addProject:create', guard((a) => service.create({ parentPath: a.parentPath, name: a.name })))
  ipcMain.handle('addProject:scan', guard((a) => service.scan({ path: a.path, scanId: a.scanId })))
  ipcMain.handle('addProject:scanStop', guard((a) => service.scanStop(a.scanId)))
}
