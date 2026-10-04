import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { extraToolDirs, withToolDirs } from './toolDirs'
import { t } from './i18n'

// CLI contracts: https://cli.github.com/manual/gh_pr_create (explicit --head
// never pushes/forks), gh_pr_checks (pending = exit 8), gh_pr_merge, gh_run_rerun.
// Orca's MIT-licensed github/gh-utils.ts and create-github-pull-request.ts were
// architectural references for bounded concurrency and UTF-8 body files.
const LIMIT = 100
const MAX_OUTPUT = 4 * 1024 * 1024
const COMMON_FIELDS = 'number,title,url,state,author,labels,assignees,createdAt,updatedAt'
const PR_FIELDS = ',isDraft,headRefName,baseRefName,reviewDecision'
const CHECK_FIELDS = 'name,state,bucket,link,workflow,description,startedAt,completedAt'
// "Fix failing checks" / "Resolve review comments" (after the MIT-licensed
// reference pr-checks-fix-prompt.ts and pr-comments-resolution-prompt.ts,
// Copyright (c) 2026 Lovecast Inc.): CI logs and review comments are
// untrusted text bound for an agent prompt, so they are read with bounded
// output, cleaned of control characters, and capped here.
const FAILING_BUCKETS = ['fail', 'cancel']
const LOG_TAIL_BYTES = 12 * 1024
const LOG_TOTAL_BYTES = 48 * 1024
const MAX_LOG_CHECKS = 8
const THREAD_LIMIT = 50
const THREAD_COMMENTS = 10
const COMMENT_CHARS = 4000
const COMMENTS_TOTAL_CHARS = 48 * 1024
const THREADS_QUERY = [
  'query($owner: String!, $name: String!, $number: Int!) {',
  '  repository(owner: $owner, name: $name) {',
  '    pullRequest(number: $number) {',
  '      reviewThreads(first: 100) {',
  '        pageInfo { hasNextPage }',
  '        nodes {',
  '          id isResolved isOutdated path line startLine originalLine',
  '          comments(first: 20) { totalCount nodes { author { login } body url createdAt } }',
  '        }',
  '      }',
  '    }',
  '  }',
  '}'
].join('\n')

class ServiceError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
const fail = (code, message) => {
  throw new ServiceError(code, message)
}
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const str = (value, max = 1024) => (typeof value === 'string' ? value.slice(0, max) : '')
const array = (value) => (Array.isArray(value) ? value : [])
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)
const user = (value) => ({ login: str(value?.login, 100) })
// Untrusted text (CI logs, review comments): no ANSI escapes (also as gh
// prints them in caret notation, ESC as "^["), no control characters but
// newline and tab, no bidirectional overrides, no byte order marks.
export function cleanUntrusted(value, max = Infinity) {
  if (typeof value !== 'string') return ''
  const text = value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]?/g, '')
    .replace(/\^\[\][^\n]*?(?:\^G|\^\[\\)/g, '')
    .replace(/\^\[\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\ufeff/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, '')
  return text.length > max ? text.slice(0, max) : text
}
// gh run view --log-failed prints "<job>\t<step>\t<timestamp> <text>" lines
// (no timestamp on the next lines of a multi-line message), and the whole
// job log with "UNKNOWN STEP" when it cannot match the steps.
// Only the text is kept (a known step is named once where it starts), and
// what follows the last error line (post-job cleanup) is left out, so the
// capped tail holds the failure. partialFirst: the output was cut, its first
// line is a fragment.
const LOG_PREFIX = /^[^\t\n]*\t([^\t\n]*)\t(?:\d{4}-\d\d-\d\dT[\d:.]+Z ?)?/
export function readableFailedLog(text, partialFirst = false) {
  const lines = text.split('\n')
  if (partialFirst && lines.length > 1) lines.shift()
  const out = []
  let step = null
  let lastError = -1
  for (const raw of lines) {
    const match = LOG_PREFIX.exec(raw)
    if (match) {
      const name = match[1].trim()
      if (name && name !== 'UNKNOWN STEP' && name !== step) out.push(`== ${name} ==`)
      step = name
    }
    const line = match ? raw.slice(match[0].length) : raw
    if (line.includes('##[error]')) lastError = out.length
    out.push(line)
  }
  return (lastError >= 0 ? out.slice(0, lastError + 1) : out).join('\n')
}
// The last maxBytes (UTF-8) of a text, starting at a whole line when cut.
export function tailText(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return { text, truncated: false }
  let tail = buf.subarray(buf.length - maxBytes).toString('utf8').replace(/^�+/, '')
  const nl = tail.indexOf('\n')
  if (nl >= 0 && nl < tail.length - 1) tail = tail.slice(nl + 1)
  return { text: tail, truncated: true }
}
const lineNumber = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null)
function httpsUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}
function textInput(value, name, max, required = false) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    value.includes('\0') ||
    (required && !value.trim())
  ) {
    fail('validation', t('main.github.invalidField', 'Invalid {{name}}.', { name }))
  }
  return value
}
function numberInput(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('validation', t('main.github.invalidNumber', 'Invalid GitHub item number.'))
  return String(value)
}
function kindInput(value) {
  if (value !== 'issues' && value !== 'prs') fail('validation', t('main.github.invalidKind', 'Invalid GitHub item kind.'))
  return value === 'issues' ? 'issue' : 'pr'
}
// A git remote's URL (https://host/owner/repo(.git), ssh://[user@]host[:port]/owner/repo,
// user@host:owner/repo) -> "host/owner/repo" for gh's --repo / repo view, or
// null. Only the host name, owner and name are kept (never a user or a token).
export function githubRepoSpec(url) {
  if (typeof url !== 'string' || url.length > 2048 || /[\u0000- \u007f]/.test(url)) return null
  let host
  let rest
  let m
  if ((m = /^(?:https?|ssh|git):\/\/(?:[^@/]*@)?([^/:]+)(?::\d{1,5})?\/(.+)$/i.exec(url))) {
    host = m[1]
    rest = m[2]
  } else if ((m = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(url))) {
    host = m[1]
    rest = m[2]
  } else return null
  const parts = rest.replace(/\/+$/, '').replace(/\.git$/i, '').split('/')
  if (parts.length !== 2) return null
  const [owner, repo] = parts
  const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host) || !NAME.test(owner) || !NAME.test(repo)) return null
  return `${host.toLowerCase()}/${owner}/${repo}`
}

function branchInput(value, head = false) {
  if (typeof value !== 'string' || !value || value.length > 255)
    fail('validation', t('main.github.invalidBranch', 'Invalid branch name.'))
  let branch = value
  if (head && value.includes(':')) {
    const pieces = value.split(':')
    if (pieces.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(pieces[0]))
      fail('validation', t('main.github.invalidHead', 'Invalid head branch.'))
    branch = pieces[1]
  }
  if (
    !branch ||
    branch === '@' ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch) ||
    branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  ) {
    fail('validation', t('main.github.invalidBranch', 'Invalid branch name.'))
  }
  return value
}
function shaInput(value) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value))
    fail('response', t('main.github.invalidCommit', 'GitHub returned an invalid commit identity.'))
  return value.toLowerCase()
}

function matchingFetchUrl(remotes, repo) {
  // Preserve SSH authentication for a private clone. Do not hand arbitrary
  // remote names/refspecs, embedded HTTPS tokens, or remote-helper schemes to
  // fetch. The API repository remains the authority for host and owner/repo.
  for (const line of remotes.split(/\r?\n/)) {
    const match = /^\S+\s+(\S+)\s+\(fetch\)$/.exec(line)
    if (!match) continue
    const candidate = match[1]
    const scp = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      candidate
    )
    if (
      scp &&
      scp[1].toLowerCase() === repo.host &&
      scp[2].toLowerCase() === repo.nameWithOwner.toLowerCase()
    )
      return candidate
    try {
      const url = new URL(candidate)
      if (
        !['https:', 'ssh:'].includes(url.protocol) ||
        url.hostname.toLowerCase() !== repo.host ||
        url.password ||
        url.search ||
        url.hash
      )
        continue
      if (url.protocol === 'https:' ? !!url.username || !!url.port : url.username !== 'git')
        continue
      if (
        url.pathname.replace(/\.git$/, '').toLowerCase() !== `/${repo.nameWithOwner}`.toLowerCase()
      )
        continue
      return candidate
    } catch {
      /* Not a supported matching remote. */
    }
  }
  return `${repo.url}.git`
}

function findExecutable(name, dirs, platform) {
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue
    const candidate = path.join(dir, platform === 'win32' ? `${name}.exe` : name)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* Try next installation. */
    }
  }
  return null
}
function defaultRunner(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr, killed: !!error?.killed })
    })
  })
}
// Like defaultRunner, but keeps only the last tailBytes of stdout: a CI log
// can be far larger than the read limit, and only its end is wanted.
export function tailRunner(file, args, options) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true })
    } catch (error) {
      resolve({ code: error?.code || 1, stdout: '', stderr: '' })
      return
    }
    const keep = options.tailBytes
    const out = []
    let held = 0
    let total = 0
    let err = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, options.timeout || 30000)
    child.stdout.on('data', (chunk) => {
      total += chunk.length
      out.push(chunk)
      held += chunk.length
      while (out.length > 1 && held - out[0].length >= keep) held -= out.shift().length
    })
    child.stderr.on('data', (chunk) => {
      if (err.length < 65536) err += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: error?.code || 1, stdout: '', stderr: '', killed })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let buf = Buffer.concat(out)
      if (buf.length > keep) buf = buf.subarray(buf.length - keep)
      resolve({
        code: killed ? 1 : (code ?? 1),
        stdout: buf.toString('utf8'),
        stderr: err.slice(0, 65536),
        killed,
        tailed: total > buf.length
      })
    })
  })
}
function json(result) {
  try {
    return JSON.parse(result.stdout)
  } catch {
    fail('response', t('main.github.unreadable', 'GitHub CLI returned an unreadable response. Update gh and try again.'))
  }
}
function commandError(result, writing = false) {
  if (result.code === 'ENOENT')
    fail('unavailable', t('main.github.noGh', 'GitHub CLI is unavailable. Install gh and restart Tessel.'))
  if (result.killed || result.code === 'ETIMEDOUT') {
    fail(
      'timeout',
      writing
        ? t('main.github.timeoutWrite', 'GitHub request timed out. Refresh before retrying; the change may have completed.')
        : t('main.github.timeout', 'GitHub request timed out. Try again.')
    )
  }
  if (result.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || result.code === 'output_limit') {
    fail(
      'output_limit',
      writing
        ? t('main.github.tooLargeWrite', 'GitHub response exceeded the size limit. Refresh before retrying the change.')
        : t('main.github.tooLarge', 'GitHub response exceeded the size limit. Narrow the request.')
    )
  }
  fail(
    'command',
    writing
      ? t('main.github.unconfirmed', 'GitHub could not confirm the change. Refresh before retrying; check gh authentication and repository permissions.')
      : t('main.github.failed', 'GitHub request failed. Check gh authentication, repository access, and your connection.')
  )
}

function normalizeItem(value, kind) {
  if (!object(value) || !Number.isSafeInteger(value.number) || value.number < 1)
    fail('response', t('main.github.invalidItem', 'GitHub returned an invalid item.'))
  const item = {
    kind,
    number: value.number,
    title: str(value.title),
    url: httpsUrl(value.url),
    state: str(value.state, 40),
    author: user(value.author),
    labels: array(value.labels)
      .slice(0, 100)
      .map((v) => ({
        name: str(v?.name, 100),
        color: /^[a-f0-9]{6}$/i.test(v?.color) ? v.color : ''
      })),
    assignees: array(value.assignees).slice(0, 100).map(user),
    createdAt: str(value.createdAt, 40),
    updatedAt: str(value.updatedAt, 40)
  }
  if (kind === 'prs')
    Object.assign(item, {
      isDraft: value.isDraft === true,
      headRefName: str(value.headRefName, 255),
      baseRefName: str(value.baseRefName, 255),
      reviewDecision: str(value.reviewDecision, 40),
      mergeable: str(value.mergeable, 40)
    })
  return item
}
function normalizeChecks(values) {
  if (!Array.isArray(values)) fail('response', t('main.github.invalidChecks', 'GitHub returned invalid checks.'))
  return values.slice(0, 300).map((v) => ({
    name: str(v?.name),
    state: str(v?.state, 50),
    bucket: str(v?.bucket, 30),
    conclusion: str(v?.state, 50),
    url: httpsUrl(v?.link),
    workflow: str(v?.workflow),
    description: str(v?.description, 2048),
    startedAt: str(v?.startedAt, 40),
    completedAt: str(v?.completedAt, 40)
  }))
}

/** runner(file, argv, execFileOptions) returns {code, stdout, stderr, killed?}.
 * Injected runners must honor timeout/maxBuffer. They are never renderer inputs.
 * No method writes remotely except createIssue/createPr/action. startPoint only
 * fetches a PR ref locally, when the user explicitly starts a PR worktree.
 */
export function createGithubService({
  runner,
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  ghPath,
  gitPath,
  tempDir = os.tmpdir(),
  // Projects on an SSH host: { isRemote(cwd), context(cwd) -> { ok, remoteUrl,
  // branch } | { ok: false, error } } (remoteFs.js githubContext).
  remote = null
} = {}) {
  const execute = runner || defaultRunner
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const additions = [...extraToolDirs(env, home)]
  if (platform === 'win32')
    additions.push(
      path.join(env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI'),
      path.join(local, 'Programs', 'GitHub CLI'),
      path.join(local, 'Microsoft', 'WinGet', 'Links'),
      path.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd')
    )
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH'
  const toolPath = withToolDirs(env[pathKey], additions)
  const dirs = toolPath.split(path.delimiter).map((dir) => dir.replace(/^"|"$/g, ''))
  const executable = ghPath || findExecutable('gh', dirs, platform) || (runner ? 'gh' : null)
  const git = gitPath || findExecutable('git', dirs, platform) || (runner ? 'git' : null)
  const childEnv = {}
  for (const [key, value] of Object.entries(env)) {
    // Prevent an inherited shell override from retargeting a different checkout,
    // and prevent gh debug HTTP traffic (which can include credentials).
    if (
      /^(GH_REPO|GH_DEBUG|DEBUG|CLICOLOR_FORCE|GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG.*))$/i.test(
        key
      )
    )
      continue
    if (key.toLowerCase() !== 'path') childEnv[key] = value
  }
  Object.assign(childEnv, {
    [pathKey]: toolPath,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
    CLICOLOR: '0',
    GIT_TERMINAL_PROMPT: '0'
  })
  let running = 0
  const queue = []
  async function command(
    file,
    args,
    cwd,
    { writing = false, accept = [0], raw = false, tailBytes = 0, timeout = 30000 } = {}
  ) {
    if (!file)
      fail('unavailable', t('main.github.noGhOrGit', 'GitHub CLI or Git is unavailable. Install it and restart Tessel.'))
    if (running >= 4) await new Promise((resolve) => queue.push(resolve))
    else running++
    try {
      let result
      try {
        result = await (tailBytes && !runner ? tailRunner : execute)(file, args, {
          cwd,
          env: { ...childEnv },
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          timeout,
          maxBuffer: MAX_OUTPUT,
          killSignal: 'SIGKILL',
          ...(tailBytes ? { tailBytes } : {})
        })
      } catch (error) {
        result = {
          code: error?.code ?? 1,
          stdout: error?.stdout,
          stderr: error?.stderr,
          killed: !!error?.killed
        }
      }
      result = {
        ...result,
        code: result?.code ?? (result?.ok === false ? 1 : 0),
        stdout: String(result?.stdout || ''),
        stderr: String(result?.stderr || ''),
        tailed: !!result?.tailed
      }
      if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT)
        result = { code: 'output_limit', stdout: '', stderr: '' }
      if (!raw && !accept.includes(result.code)) commandError(result, writing)
      return result
    } finally {
      const next = queue.shift()
      if (next) next()
      else running--
    }
  }
  async function cwdInput(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0'))
      fail('validation', t('main.github.chooseCwd', 'Choose a local Git working directory.'))
    try {
      if (!(await fsp.stat(cwd)).isDirectory()) throw new Error()
    } catch {
      fail('validation', t('main.github.cwdUnavailable', 'The Git working directory is unavailable.'))
    }
    return cwd
  }
  // Where a request runs: a local Git folder, or a project on an SSH host
  // (its virtual root, ssh://…). The host's repository is named to gh from
  // its remote's URL (read on the host through its session, remoteFs.js) and
  // gh runs here in the home folder: nothing of the host runs on this computer.
  // -> { cwd, spec?, branch?, remote? }
  async function place(cwd) {
    if (remote && typeof cwd === 'string' && remote.isRemote(cwd)) {
      let ctx = null
      try {
        ctx = await remote.context(cwd)
      } catch {
        ctx = null
      }
      if (!ctx || !ctx.ok) fail('repository', (ctx && typeof ctx.error === 'string' && ctx.error) || t('main.github.noRepo', 'The current directory has no supported GitHub repository.'))
      const spec = githubRepoSpec(ctx.remoteUrl)
      if (!spec) fail('repository', t('main.github.noRepo', 'The current directory has no supported GitHub repository.'))
      return { cwd: home, spec, branch: typeof ctx.branch === 'string' ? ctx.branch : '', remote: true }
    }
    return { cwd: await cwdInput(cwd) }
  }
  async function repository(at) {
    const value = json(
      await command(
        executable,
        ['repo', 'view', ...(at.spec ? [at.spec] : []), '--json', 'nameWithOwner,defaultBranchRef,url'],
        at.cwd
      )
    )
    const name = value?.nameWithOwner
    const url = httpsUrl(value?.url)
    if (
      typeof name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) ||
      !url
    )
      fail('repository', t('main.github.noRepo', 'The current directory has no supported GitHub repository.'))
    const parsed = new URL(url)
    if (
      parsed.pathname.replace(/\/$/, '') !== `/${name}` ||
      parsed.search ||
      parsed.hash ||
      parsed.port
    )
      fail('repository', t('main.github.invalidRepo', 'GitHub returned an invalid repository identity.'))
    return {
      nameWithOwner: name,
      defaultBranch: str(value.defaultBranchRef?.name, 255),
      url: url.replace(/\/$/, ''),
      host: parsed.hostname,
      repoArg: `${parsed.hostname}/${name}`
    }
  }
  function scoped(args, repo) {
    return [...args, '--repo', repo.repoArg]
  }
  function itemInRepo(item, repo) {
    const expected = `${repo.url}/${item.kind === 'prs' ? 'pull' : 'issues'}/${item.number}`
    if (item.url.toLowerCase() !== expected.toLowerCase())
      fail('repository', t('main.github.otherRepo', 'GitHub returned an item from a different repository.'))
    return item
  }
  async function bodyFile(body, work) {
    let dir
    try {
      dir = await fsp.mkdtemp(path.join(tempDir, 'tessel-gh-body-'))
      await fsp.chmod(dir, 0o700)
      const file = path.join(dir, 'body.md')
      await fsp.writeFile(file, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      return await work(file)
    } finally {
      // Only our exact file and empty folder, never recursive deletion.
      if (dir) {
        await fsp.unlink(path.join(dir, 'body.md')).catch(() => {})
        await fsp.rmdir(dir).catch(() => {})
      }
    }
  }
  function createdUrl(stdout, repo, kind) {
    const urls = stdout.split(/\s+/).map(httpsUrl).filter(Boolean)
    const prefix = `${repo.url}/${kind === 'prs' ? 'pull' : 'issues'}/`
    const url = urls.find(
      (value) => value.startsWith(prefix) && /^[1-9]\d*$/.test(value.slice(prefix.length))
    )
    if (!url)
      fail(
        'unknown_completion',
        t('main.github.noUrl', 'GitHub may have created the item, but returned no usable URL. Refresh before retrying.')
      )
    return url
  }
  async function readChecks(cwd, repo, number) {
    const result = await command(
      executable,
      scoped(['pr', 'checks', number, '--json', CHECK_FIELDS], repo),
      cwd,
      { accept: [0, 1, 8] }
    )
    // Failed checks (1) and pending checks (8) still return useful JSON. An
    // authentication/server error also uses 1, but does not return an array.
    const values = json(result)
    return { checks: normalizeChecks(values), truncated: values.length > 300 }
  }
  async function prHead(cwd, repo, number) {
    const value = json(
      await command(
        executable,
        scoped(
          ['pr', 'view', number, '--json', 'number,title,url,headRefOid,headRefName,baseRefName'],
          repo
        ),
        cwd
      )
    )
    const item = itemInRepo(normalizeItem(value, 'prs'), repo)
    if (String(item.number) !== number)
      fail('response', t('main.github.otherPr', 'GitHub returned a different pull request.'))
    return { ...item, headSha: shaInput(value.headRefOid) }
  }
  // The run and job of a GitHub Actions check in this repository, or null
  // (an external check has no log gh can read).
  function actionsJob(url, repo) {
    try {
      const parsed = new URL(url)
      if (parsed.origin !== new URL(repo.url).origin) return null
      const match = parsed.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d{0,19})\/job\/([1-9]\d{0,19})\/?$/)
      if (!match || match[1].toLowerCase() !== repo.nameWithOwner.toLowerCase()) return null
      return { runId: match[2], jobId: match[3] }
    } catch {
      return null
    }
  }
  // The failing checks of a PR with the cleaned tail of each one's failed log.
  async function readFailingLogs(cwd, repo, number) {
    const { checks, truncated } = await readChecks(cwd, repo, number)
    const failing = checks.filter((check) => FAILING_BUCKETS.includes(check.bucket))
    let budget = LOG_TOTAL_BYTES
    let fetched = 0
    const out = []
    for (const check of failing.slice(0, 20)) {
      const entry = {
        name: cleanUntrusted(check.name, 1024),
        state: check.state,
        bucket: check.bucket,
        workflow: cleanUntrusted(check.workflow, 1024),
        description: cleanUntrusted(check.description, 2048),
        url: check.url,
        logTail: '',
        logTruncated: false,
        // ok | empty | unavailable | skipped (count or size cap) | none (no Actions job)
        logStatus: 'none'
      }
      const job = actionsJob(check.url, repo)
      if (job && (fetched >= MAX_LOG_CHECKS || budget <= 0)) entry.logStatus = 'skipped'
      else if (job) {
        fetched++
        try {
          const result = await command(
            executable,
            scoped(['run', 'view', job.runId, '--job', job.jobId, '--log-failed'], repo),
            cwd,
            { tailBytes: LOG_TAIL_BYTES * 4, timeout: 60000 }
          )
          const tail = tailText(
            readableFailedLog(cleanUntrusted(result.stdout), result.tailed),
            Math.min(LOG_TAIL_BYTES, budget)
          )
          budget -= Buffer.byteLength(tail.text)
          entry.logTail = tail.text
          entry.logTruncated = tail.truncated || result.tailed
          entry.logStatus = tail.text.trim() ? 'ok' : 'empty'
        } catch {
          entry.logStatus = 'unavailable'
        }
      }
      out.push(entry)
    }
    return { checks: out, truncated: truncated || failing.length > out.length }
  }
  // The unresolved review threads of a PR (file, line, comments), bounded.
  async function readThreads(cwd, repo, number) {
    const [owner, name] = repo.nameWithOwner.split('/')
    const value = json(
      await command(
        executable,
        [
          'api',
          'graphql',
          '--hostname',
          repo.host,
          '-f',
          `query=${THREADS_QUERY}`, // i18n-ignore GraphQL argument
          '-f',
          `owner=${owner}`, // i18n-ignore gh argument
          '-f',
          `name=${name}`, // i18n-ignore gh argument
          '-F',
          `number=${number}` // i18n-ignore gh argument
        ],
        cwd
      )
    )
    const connection = value?.data?.repository?.pullRequest?.reviewThreads
    if (!object(connection) || !Array.isArray(connection.nodes))
      fail('response', t('main.github.invalidThreads', 'GitHub returned invalid review threads.'))
    const open = connection.nodes.filter((node) => object(node) && node.isResolved === false)
    let budget = COMMENTS_TOTAL_CHARS
    const threads = open.slice(0, THREAD_LIMIT).map((node) => {
      const nodes = array(node.comments?.nodes).filter(object)
      const comments = []
      for (const comment of nodes.slice(0, THREAD_COMMENTS)) {
        if (budget <= 0) break
        const body = cleanUntrusted(comment.body, Math.min(COMMENT_CHARS, budget))
        budget -= body.length
        comments.push({
          author: str(comment.author?.login, 100),
          body,
          bodyTruncated: typeof comment.body === 'string' && comment.body.length > body.length,
          url: httpsUrl(comment.url),
          createdAt: str(comment.createdAt, 40)
        })
      }
      const total = Number.isSafeInteger(node.comments?.totalCount) ? node.comments.totalCount : nodes.length
      return {
        id: str(node.id, 200),
        path: cleanUntrusted(node.path, 2048),
        line: lineNumber(node.line) ?? lineNumber(node.originalLine),
        startLine: lineNumber(node.startLine),
        isOutdated: node.isOutdated === true,
        comments,
        omittedComments: Math.max(0, total - comments.length)
      }
    })
    return {
      threads,
      truncated:
        open.length > THREAD_LIMIT ||
        connection.pageInfo?.hasNextPage === true ||
        threads.some((thread) => thread.omittedComments > 0 || thread.comments.some((c) => c.bodyTruncated))
    }
  }
  const safe =
    (work) =>
    async (input = {}) => {
      try {
        return await work(input)
      } catch (error) {
        return error instanceof ServiceError
          ? { ok: false, code: error.code, error: error.message }
          : { ok: false, code: 'internal', error: t('main.github.internal', 'The GitHub operation could not be completed.') }
      }
    }
  return {
    status: safe(async ({ cwd }) => {
      const at = await place(cwd)
      cwd = at.cwd
      if (!executable) return { ok: true, available: false, authenticated: false }
      const version = await command(executable, ['--version'], cwd, { raw: true })
      if (version.code === 'ENOENT') return { ok: true, available: false, authenticated: false }
      if (version.code !== 0) commandError(version)
      let repo
      try {
        repo = await repository(at)
      } catch {
        /* Auth status remains useful outside a repo. */
      }
      const authArgs = ['auth', 'status', '--active']
      if (repo) authArgs.push('--hostname', repo.host)
      const auth = await command(executable, authArgs, cwd, { raw: true })
      if (![0, 1].includes(auth.code)) commandError(auth)
      return {
        ok: true,
        available: true,
        authenticated: auth.code === 0,
        ...(repo
          ? {
              repo: {
                nameWithOwner: repo.nameWithOwner,
                defaultBranch: repo.defaultBranch,
                url: repo.url
              }
            }
          : {})
      }
    }),
    list: safe(async ({ cwd, kind, preset = 'all', query = '' }) => {
      const type = kindInput(kind)
      if (!['all', 'mine', 'review'].includes(preset) || (kind === 'issues' && preset === 'review'))
        fail('validation', t('main.github.invalidFilter', 'Invalid GitHub list filter.'))
      textInput(query, t('main.github.field.searchQuery', 'search query'), 1000)
      if (/\b(?:repo|org|user)\s*:/i.test(query))
        fail(
          'validation',
          t('main.github.searchQualifiers', 'Search within the current repository without repo, org, or user qualifiers.')
        )
      const at = await place(cwd)
      cwd = at.cwd
      const repo = await repository(at)
      const args = [
        type,
        'list',
        '--state',
        'open',
        '--limit',
        String(LIMIT + 1),
        '--json',
        COMMON_FIELDS + (kind === 'prs' ? PR_FIELDS : '')
      ]
      if (preset === 'mine') args.push(kind === 'prs' ? '--author' : '--assignee', '@me')
      const search = [query.trim(), preset === 'review' ? 'review-requested:@me' : '']
        .filter(Boolean)
        .join(' ')
      if (search) args.push('--search', search)
      const values = json(await command(executable, scoped(args, repo), cwd))
      if (!Array.isArray(values)) fail('response', t('main.github.invalidList', 'GitHub returned an invalid list.'))
      return {
        ok: true,
        items: values.slice(0, LIMIT).map((v) => itemInRepo(normalizeItem(v, kind), repo)),
        truncated: values.length > LIMIT
      }
    }),
    detail: safe(async ({ cwd, kind, number }) => {
      const type = kindInput(kind)
      const id = numberInput(number)
      const at = await place(cwd)
      cwd = at.cwd
      const repo = await repository(at)
      const fields =
        COMMON_FIELDS + ',body,comments' + (kind === 'prs' ? PR_FIELDS + ',mergeable,files' : '')
      const value = json(
        await command(executable, scoped([type, 'view', id, '--json', fields], repo), cwd)
      )
      const item = itemInRepo(normalizeItem(value, kind), repo)
      if (item.number !== number) fail('response', t('main.github.otherItem', 'GitHub returned a different item.'))
      item.body = str(value.body, 131072)
      item.comments = array(value.comments)
        .slice(-100)
        .map((v) => ({
          author: user(v?.author),
          body: str(v?.body, 65536),
          createdAt: str(v?.createdAt, 40),
          url: httpsUrl(v?.url)
        }))
      item.files = array(value.files)
        .slice(0, 300)
        .map((v) => ({
          path: str(v?.path, 2048),
          additions: count(v?.additions),
          deletions: count(v?.deletions)
        }))
      item.checks = []
      let truncated =
        array(value.comments).length > 100 ||
        array(value.files).length > 300 ||
        (value.body?.length || 0) > 131072
      if (kind === 'prs') {
        try {
          const result = await readChecks(cwd, repo, id)
          item.checks = result.checks
          truncated ||= result.truncated
        } catch {
          item.checksError = t('main.github.checksUnavailable', 'Checks are unavailable. Refresh to try again.')
        }
        try {
          const result = await readThreads(cwd, repo, id)
          item.reviewThreads = result.threads
          item.reviewThreadsTruncated = result.truncated
        } catch {
          item.reviewThreads = []
          item.reviewThreadsError = t('main.github.threadsUnavailable', 'Review threads are unavailable. Refresh to try again.')
        }
      }
      return { ok: true, item, truncated }
    }),
    createIssue: safe(async ({ cwd, title, body = '' }) => {
      textInput(title, t('main.github.field.issueTitle', 'issue title'), 256, true)
      textInput(body, t('main.github.field.issueBody', 'issue body'), 65536)
      const at = await place(cwd)
      cwd = at.cwd
      const repo = await repository(at)
      const result = await bodyFile(body, (file) =>
        command(
          executable,
          scoped(['issue', 'create', '--title', title, '--body-file', file], repo),
          cwd,
          { writing: true }
        )
      )
      return { ok: true, url: createdUrl(result.stdout, repo, 'issues') }
    }),
    createPr: safe(async ({ cwd, title, body = '', base, head, draft = false }) => {
      textInput(title, t('main.github.field.prTitle', 'pull request title'), 256, true)
      textInput(body, t('main.github.field.prBody', 'pull request body'), 65536)
      branchInput(base)
      if (head !== undefined) branchInput(head, true)
      if (typeof draft !== 'boolean') fail('validation', t('main.github.invalidDraft', 'Invalid draft choice.'))
      const at = await place(cwd)
      cwd = at.cwd
      const repo = await repository(at)
      if (!head)
        head = branchInput(
          // A remote project: its branch as read on the host.
          at.remote ? at.branch : (await command(git, ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)).stdout.trim()
        )
      if (head === base) fail('validation', t('main.github.sameBase', 'Choose a base branch different from the head branch.'))
      const args = ['pr', 'create', '--base', base, '--head', head, '--title', title]
      if (draft) args.push('--draft')
      const result = await bodyFile(body, (file) =>
        command(executable, scoped([...args, '--body-file', file], repo), cwd, { writing: true })
      )
      return { ok: true, url: createdUrl(result.stdout, repo, 'prs') }
    }),
    checks: safe(async ({ cwd, number }) => {
      const id = numberInput(number)
      const at = await place(cwd)
      cwd = at.cwd
      const repo = await repository(at)
      return { ok: true, ...(await readChecks(cwd, repo, id)) }
    }),
    // Reads only: the failing checks with their log tails, for an agent prompt.
    failingLogs: safe(async ({ cwd, number }) => {
      const id = numberInput(number)
      const at = await place(cwd)
      cwd = at.cwd
      const repo = await repository(at)
      return { ok: true, ...(await readFailingLogs(cwd, repo, id)) }
    }),
    // Reads only: the unresolved review threads, for an agent prompt.
    reviewThreads: safe(async ({ cwd, number }) => {
      const id = numberInput(number)
      const at = await place(cwd)
      cwd = at.cwd
      const repo = await repository(at)
      return { ok: true, ...(await readThreads(cwd, repo, id)) }
    }),
    action: safe(async ({ cwd, kind, number, action, body, reason, method = 'squash' }) => {
      const type = kindInput(kind)
      const id = numberInput(number)
      if (
        !['comment', 'close', 'reopen', 'merge', 'autoMerge', 'rerunFailed', 'rerunAll'].includes(
          action
        )
      )
        fail('validation', t('main.github.invalidAction', 'Invalid GitHub action.'))
      if (kind !== 'prs' && ['merge', 'autoMerge', 'rerunFailed', 'rerunAll'].includes(action))
        fail('validation', t('main.github.needsPr', 'This action requires a pull request.'))
      if (action === 'comment') textInput(body, t('main.github.field.comment', 'comment'), 65536, true)
      if (body !== undefined && action !== 'comment')
        fail('validation', t('main.github.useComment', 'Use the comment action to add text.'))
      if (!['merge', 'squash', 'rebase'].includes(method))
        fail('validation', t('main.github.invalidMerge', 'Invalid merge method.'))
      if (
        reason !== undefined &&
        !(action === 'close' && kind === 'issues' && ['completed', 'not planned'].includes(reason))
      )
        fail('validation', t('main.github.invalidReason', 'Invalid closing reason.'))
      const at = await place(cwd)
      cwd = at.cwd
      const repo = await repository(at)
      if (action === 'comment') {
        await bodyFile(body, (file) =>
          command(executable, scoped([type, 'comment', id, '--body-file', file], repo), cwd, {
            writing: true
          })
        )
      } else if (action === 'close' || action === 'reopen') {
        await command(
          executable,
          scoped([type, action, id, ...(reason ? ['--reason', reason] : [])], repo),
          cwd,
          { writing: true }
        )
      } else if (action === 'merge' || action === 'autoMerge') {
        const head = await prHead(cwd, repo, id)
        await command(
          executable,
          scoped(
            [
              'pr',
              'merge',
              id,
              `--${method}`,
              '--match-head-commit',
              head.headSha,
              ...(action === 'autoMerge' ? ['--auto'] : [])
            ],
            repo
          ),
          cwd,
          { writing: true }
        )
      } else {
        const { checks, truncated } = await readChecks(cwd, repo, id)
        if (truncated)
          fail(
            'too_many_runs',
            t('main.github.tooManyChecks', 'Too many checks to restart safely here. Choose workflow runs on GitHub.')
          )
        const runIds = new Set()
        for (const check of checks) {
          if (action === 'rerunFailed' && check.bucket !== 'fail') continue
          try {
            const url = new URL(check.url)
            const prefix = `/${repo.nameWithOwner}/actions/runs/`
            if (url.origin !== new URL(repo.url).origin || !url.pathname.startsWith(prefix))
              continue
            const runId = url.pathname.slice(prefix.length).split('/')[0]
            if (/^[1-9]\d{0,19}$/.test(runId)) runIds.add(runId)
          } catch {
            /* External checks cannot be rerun with gh. */
          }
        }
        if (!runIds.size)
          fail(
            'no_runs',
            t('main.github.noRuns', 'No matching GitHub Actions runs were found for these pull request checks.')
          )
        if (runIds.size > 20)
          fail(
            'too_many_runs',
            t('main.github.tooManyRuns', 'Too many workflow runs to restart here. Choose workflow runs on GitHub.')
          )
        let completed = 0
        for (const runId of runIds) {
          try {
            await command(
              executable,
              scoped(
                ['run', 'rerun', runId, ...(action === 'rerunFailed' ? ['--failed'] : [])],
                repo
              ),
              cwd,
              { writing: true }
            )
            completed++
          } catch (error) {
            if (completed)
              return {
                ok: false,
                code: 'partial',
                error: t('main.github.partial', 'Some workflow runs were restarted. Refresh checks before retrying.'),
                completed
              }
            throw error
          }
        }
        return { ok: true, completed }
      }
      return { ok: true }
    }),
    startPoint: safe(async ({ cwd, number }) => {
      const id = numberInput(number)
      const at = await place(cwd)
      // It fetches into a local checkout: none for a project on a host.
      if (at.remote) fail('validation', t('main.github.remoteStartPoint', 'Not available for a project on a remote host.'))
      cwd = at.cwd
      const repo = await repository(at)
      const item = await prHead(cwd, repo, id)
      const ref = `refs/tessel/pr/${id}`
      const remotes = (await command(git, ['remote', '-v'], cwd)).stdout
      const fetchUrl = matchingFetchUrl(remotes, repo)
      // Explicit validated HTTPS/SSH target and refspec: no checkout, pull,
      // push, hooks, submodules, tag updates, or executable remote-helper URL.
      await command(
        git,
        [
          '-c',
          'core.hooksPath=',
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.https.allow=always',
          '-c',
          'protocol.ssh.allow=always',
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          '--no-auto-maintenance',
          '--no-write-fetch-head',
          '--refmap=',
          '--',
          fetchUrl,
          `+refs/pull/${id}/head:${ref}`
        ],
        cwd
      )
      const sha = shaInput(
        (await command(git, ['rev-parse', '--verify', `${ref}^{commit}`], cwd)).stdout.trim()
      )
      if (sha !== item.headSha)
        fail('changed', t('main.github.changed', 'The pull request changed while fetching. Refresh and start it again.'))
      return {
        ok: true,
        baseBranch: sha,
        headSha: sha,
        number: item.number,
        title: item.title,
        url: item.url,
        headRefName: item.headRefName,
        baseRefName: item.baseRefName
      }
    })
  }
}
