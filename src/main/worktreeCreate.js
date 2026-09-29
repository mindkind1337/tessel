// Optional initialization of a newly created worktree. Never return file
// contents or process output: environment files and setup logs may be secrets.
import fs from 'fs'
import { execFile, spawn } from 'child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { cleanEnv } from './cleanEnv'
import { t } from './i18n'

const ENV_LIMITS = {
  entries: 10000,
  depth: 8,
  files: 128,
  fileBytes: 1024 * 1024,
  bytes: 4 * 1024 * 1024
}
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.tessel',
  'node_modules',
  'bower_components',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  'cache',
  'caches',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.parcel-cache',
  '.yarn',
  '.pnpm-store',
  '.npm',
  '.gradle',
  '.m2',
  'coverage',
  'dist',
  'build',
  'target',
  'logs',
  'tmp',
  'temp'
])

function inside(root, path) {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}

function directoryRoot(path) {
  const absolute = resolve(path)
  const stat = fs.lstatSync(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe directory') // i18n-ignore internal, caught and replaced
  return fs.realpathSync(absolute)
}

// Validate each existing component, including Windows junctions, before using
// it. Missing destination directories are created one component at a time.
function safeDirectory(root, path, create = false) {
  if (!inside(root, path)) throw new Error('Outside worktree') // i18n-ignore internal, caught and replaced
  let current = root
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part)
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (!create || error.code !== 'ENOENT') throw error
      fs.mkdirSync(current)
      stat = fs.lstatSync(current)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, fs.realpathSync(current))) {
      throw new Error('Unsafe directory') // i18n-ignore internal, caught and replaced
    }
  }
}

export async function resolveWorktreeBase(root, currentBranch, requested, run) {
  if (requested != null && typeof requested !== 'string') {
    return { ok: false, error: t('main.worktree.baseNotName', 'The base branch must be a branch name.') }
  }
  const selected = requested?.trim() || 'HEAD'
  // Only full object identities bypass symbolic branch validation. Verify the
  // object below and compare identities so a hex-named ref cannot impersonate
  // a missing commit, nor a SHA-256 abbreviation pass as a full SHA-1 identity.
  const pinnedCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(selected)
  let ref = pinnedCommit ? selected.toLowerCase() : 'HEAD'
  if (selected !== 'HEAD' && !pinnedCommit) {
    if (selected.length > 1024 || /[\r\n\0]/.test(selected)) {
      return { ok: false, error: t('main.worktree.baseInvalid', 'The selected base branch is not valid.') }
    }
    const symbolic = await run('git', [
      '-C',
      root,
      'rev-parse',
      '--symbolic-full-name',
      '--verify',
      '--end-of-options',
      selected
    ])
    ref = symbolic.stdout.trim()
    if (!symbolic.ok || !/^refs\/(heads|remotes)\/[^\r\n]+$/.test(ref)) {
      return { ok: false, error: t('main.worktree.baseNotFound', 'The selected base branch was not found.') }
    }
  }
  const resolved = await run('git', [
    '-C',
    root,
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`
  ])
  const commit = resolved.stdout.trim()
  if (
    !resolved.ok ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(commit) ||
    (pinnedCommit && commit.toLowerCase() !== ref)
  ) {
    return { ok: false, error: t('main.worktree.baseNoCommit', 'The selected base branch does not point to a commit.') }
  }
  return { ok: true, commit, branch: selected === 'HEAD' ? currentBranch : selected }
}

function discoverEnv(root, result) {
  const candidates = []
  const queue = [{ path: root, depth: 0 }]
  let entries = 0
  for (let i = 0; i < queue.length; i++) {
    const dir = queue[i]
    safeDirectory(root, dir.path)
    const stream = fs.opendirSync(dir.path)
    try {
      let entry
      while ((entry = stream.readSync())) {
        if (++entries > ENV_LIMITS.entries) {
          result.truncated = true
          return candidates
        }
        const path = join(dir.path, entry.name)
        const stat = fs.lstatSync(path)
        if (stat.isSymbolicLink()) {
          if (entry.name.startsWith('.env')) result.skipped++
          continue
        }
        if (stat.isDirectory()) {
          if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
          if (dir.depth >= ENV_LIMITS.depth) result.truncated = true
          else queue.push({ path, depth: dir.depth + 1 })
        } else if (stat.isFile() && entry.name.startsWith('.env')) {
          if (candidates.length >= ENV_LIMITS.files) {
            result.truncated = true
            return candidates
          }
          if (stat.size > ENV_LIMITS.fileBytes) {
            result.skipped++
            continue
          }
          candidates.push(relative(root, path).split(sep).join('/'))
        }
      }
    } finally {
      stream.closeSync()
    }
  }
  return candidates
}

// Literal pathspecs keep filenames containing Git wildcard syntax literal.
// Small batches also stay well below Windows' command-line length limit.
async function gitPaths(root, paths, args, run) {
  const found = new Set()
  for (let i = 0; i < paths.length; ) {
    const batch = []
    let length = 0
    while (
      i < paths.length &&
      batch.length < 64 &&
      (batch.length === 0 || length + paths[i].length < 8192)
    ) {
      const path = paths[i++]
      batch.push(path)
      length += path.length + 3
    }
    const result = await run('git', ['--literal-pathspecs', '-C', root, ...args, '--', ...batch], {
      timeout: 10000,
      maxBuffer: 256 * 1024
    })
    if (!result.ok) throw new Error('Could not check ignored files') // i18n-ignore internal, caught and replaced
    for (const path of result.stdout.split('\0').filter(Boolean)) found.add(path)
  }
  return found
}

// Unlike ls-files, check-ignore can evaluate a destination that does not yet
// exist. NUL-delimited stdin preserves unusual filenames without shell parsing.
function ignoredDestinations(root, paths) {
  if (!paths.length) return Promise.resolve(new Set())
  return new Promise((resolveResult, reject) => {
    const child = execFile(
      'git',
      ['-C', root, 'check-ignore', '--no-index', '-z', '--stdin'],
      {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 256 * 1024,
        env: cleanEnv(process.env)
      },
      (error, stdout) => {
        if (error && error.code !== 1) reject(new Error('Could not check destination ignore rules')) // i18n-ignore internal, caught and replaced
        else resolveResult(new Set(String(stdout).split('\0').filter(Boolean)))
      }
    )
    child.stdin.on('error', () => {}) // An early Git failure is handled above.
    child.stdin.end(`${paths.join('\0')}\0`)
  })
}

function readEnv(root, path) {
  safeDirectory(root, dirname(path))
  const before = fs.lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || !inside(root, fs.realpathSync(path)))
    return null
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const stat = fs.fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size > ENV_LIMITS.fileBytes
    )
      return null
    const buffer = Buffer.alloc(ENV_LIMITS.fileBytes + 1)
    let used = 0
    while (used < buffer.length) {
      const n = fs.readSync(fd, buffer, used, buffer.length - used, null)
      if (!n) break
      used += n
    }
    return used > ENV_LIMITS.fileBytes ? null : buffer.subarray(0, used)
  } finally {
    fs.closeSync(fd)
  }
}

export async function copyWorktreeEnv(source, destination, run) {
  const result = { ok: true, copied: 0, skipped: 0, truncated: false }
  try {
    const sourceRoot = directoryRoot(source)
    const destinationRoot = directoryRoot(destination)
    if (inside(sourceRoot, destinationRoot) || inside(destinationRoot, sourceRoot))
      throw new Error('Overlapping worktrees') // i18n-ignore internal, caught and replaced
    const candidates = discoverEnv(sourceRoot, result)
    const ignored = await gitPaths(
      sourceRoot,
      candidates,
      ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
      run
    )
    const tracked = await gitPaths(destinationRoot, [...ignored], ['ls-files', '-z'], run)
    const destinationIgnored = await ignoredDestinations(destinationRoot, [...ignored])
    let copiedBytes = 0
    for (const name of ignored) {
      // Git emits only requested paths, but reject malformed output before
      // joining paths so this helper never follows a path outside either root.
      if (!candidates.includes(name) || isAbsolute(name) || name.split(/[\\/]/).includes('..'))
        throw new Error('Unsafe path') // i18n-ignore internal, caught and replaced
      if (tracked.has(name) || !destinationIgnored.has(name)) {
        result.skipped++
        continue
      }
      const target = join(destinationRoot, name)
      let fd
      try {
        safeDirectory(destinationRoot, dirname(target), true)
        // lstat sees dangling symlinks too. Nothing already present is replaced.
        try {
          fs.lstatSync(target)
          result.skipped++
          continue
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        const data = readEnv(sourceRoot, join(sourceRoot, name))
        if (!data || copiedBytes + data.length > ENV_LIMITS.bytes) {
          result.skipped++
          result.truncated = true
          continue
        }
        fd = fs.openSync(
          target,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o600
        )
        fs.writeFileSync(fd, data)
        copiedBytes += data.length
        result.copied++
      } catch (error) {
        result.skipped++
        if (error.code !== 'EEXIST') result.ok = false
      } finally {
        if (fd !== undefined) fs.closeSync(fd)
      }
    }
  } catch {
    result.ok = false
  }
  if (!result.ok) result.error = t('main.worktree.envCopy', 'Some environment files could not be copied safely.')
  return result
}

// Discard all setup output. On a limit breach, Windows' taskkill terminates
// the shell and its descendants, rather than leaving its foreground job alive.
export function runWorktreeSetupProcess(file, args, options) {
  return new Promise((resolveResult) => {
    let settled = false
    let stopped = false
    let bytes = 0
    let timer
    let reapTimer
    let closed = false
    let terminated = false
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: cleanEnv(process.env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(reapTimer)
      resolveResult({ ok })
    }
    const stop = () => {
      if (settled || stopped) return
      stopped = true
      if (process.platform === 'win32' && child.pid) {
        execFile(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          {
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 16 * 1024
          },
          () => {
            terminated = true
            child.kill()
            if (closed) finish(false)
            else reapTimer = setTimeout(() => finish(false), 1000)
          }
        )
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
        finish(false)
      }
    }
    const discard = (chunk) => {
      bytes += chunk.length
      if (bytes > options.maxBuffer) stop()
    }
    child.stdout.on('data', discard)
    child.stderr.on('data', discard)
    child.on('error', () => finish(false))
    // On Windows wait for taskkill itself to finish reaping the tree before
    // callers can inspect or remove the worktree.
    child.on('close', (code) => {
      closed = true
      if (!stopped) finish(code === 0)
      else if (terminated) finish(false)
    })
    timer = setTimeout(stop, options.timeout)
  })
}

export async function setupWorktree(path, baseCommit, run, execute = runWorktreeSetupProcess) {
  try {
    const root = directoryRoot(path)
    const hook = join(root, '.tessel', 'setup.ps1')
    const entry = await run(
      'git',
      ['-C', root, 'ls-tree', '-z', baseCommit, '--', '.tessel/setup.ps1'],
      {
        timeout: 10000,
        maxBuffer: 16 * 1024
      }
    )
    if (!entry.ok)
      return { ok: false, ran: false, error: t('main.worktree.setupCheck', 'Could not check the worktree setup script.') }
    if (!entry.stdout) return { ok: true, ran: false, skipped: 'missing' }
    if (!/^100(?:644|755) blob [a-f0-9]+\t\.tessel\/setup\.ps1\0$/i.test(entry.stdout)) {
      return {
        ok: false,
        ran: false,
        error: t('main.worktree.setupNotTracked', 'The worktree setup script must be a regular tracked file.')
      }
    }
    safeDirectory(root, dirname(hook))
    const stat = fs.lstatSync(hook)
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(root, fs.realpathSync(hook)))
      throw new Error('Unsafe hook') // i18n-ignore internal, caught and replaced
    const executed = await execute(
      process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hook],
      { cwd: root, timeout: 60000, maxBuffer: 256 * 1024 }
    )
    return executed.ok
      ? { ok: true, ran: true }
      : {
          ok: false,
          ran: true,
          error: t('main.worktree.setupFailed', 'The worktree setup script failed or exceeded its execution limit.')
        }
  } catch {
    return {
      ok: false,
      ran: false,
      error: t('main.worktree.setupUnsafe', 'The worktree setup script could not be started safely.')
    }
  }
}
