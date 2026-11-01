// What must be true of the site before it goes online (npm run build:site and
// .github/workflows/site.yml run this). The demo is built from the app's whole
// renderer, so anything that leaks into that source would be published with it: the
// built files are searched, and any of these fails the build:
//   - a local path (C:\Users\..., /home/..., /Users/...) or this checkout's own path;
//   - the build machine's user name;
//   - anything shaped like a token or a key;
//   - a file or a number of files over Cloudflare's limits for static assets;
//   - a demo page that lost its Content-Security-Policy (no network at all).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { userInfo } from 'node:os'

// https://developers.cloudflare.com/workers/platform/limits/#static-assets
// (the Free plan's file count: the lower of the two, so the plan cannot break it).
export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_FILES = 20000

// Shared account names on CI machines and the like: words too common to look for
// alone. Their paths are still found by LOCAL_PATHS.
const GENERIC_USERS = new Set(['runner', 'runneradmin', 'root', 'admin', 'administrator', 'user', 'users', 'ubuntu', 'node', 'ci', 'build', 'docker', 'default', 'public', 'guest', 'system', 'vsts', 'home'])

// Windows' profile folders and POSIX home folders: a path into a person's folder. The
// account name is the first group: the app's own help text says /home/user/project and
// knows Homebrew's /home/linuxbrew, which are nobody's.
const LOCAL_PATHS = [
  { what: 'a Windows user folder', re: /\b[A-Za-z]:(?:\\\\?|\/)Users(?:\\\\?|\/)([A-Za-z0-9._-]{2,})/g },
  { what: 'a home folder', re: /(?:^|[^\w.~-])\/home\/([a-z_][a-z0-9_-]{1,31})\/[A-Za-z0-9._-]/g },
  { what: 'a macOS user folder', re: /(?:^|[^\w.~-])\/Users\/([A-Za-z0-9._-]{2,})\/[A-Za-z0-9._-]/g }
]
const PLACEHOLDER_ACCOUNTS = new Set(['user', 'username', 'you', 'yourname', 'your-name', 'name', 'me', 'example', 'linuxbrew', 'public', 'default', 'shared'])

// Shapes of real credentials. A regular expression in the app's own code that
// recognizes them (maskSecrets) does not match: these need the whole value.
const TOKEN_SHAPES = [
  { what: 'an Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { what: 'an OpenAI-style key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { what: 'a GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g },
  { what: 'a GitHub token', re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { what: 'an AWS key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { what: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { what: 'a Google OAuth secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g },
  { what: 'a Google OAuth client', re: /\b\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/g },
  { what: 'a Slack token', re: /\bxox[abeoprs]-[A-Za-z0-9-]{20,}/g },
  { what: 'a Stripe key', re: /\b[rs]k_live_[A-Za-z0-9]{20,}/g },
  { what: 'an npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { what: 'a Hugging Face token', re: /\bhf_[A-Za-z]{30,}\b/g },
  { what: 'a JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { what: 'a private key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----\s*[A-Za-z0-9+/=]{16,}/g },
  { what: 'a secret in a setting', re: /["'`]?(?:api[_-]?key|api[_-]?secret|auth[_-]?token|access[_-]?token|client[_-]?secret|secret[_-]?key|password)["'`]?\s*[:=]\s*["'`][A-Za-z0-9+/_=.-]{24,}["'`]/gi }
]

// Exact strings the app ships on purpose that look like the above (none so far).
// Each entry must say why it is harmless.
export const ALLOWED = [
  // { text: '...', why: '...' }
]

const excerpt = (text, at, length) => {
  const start = Math.max(0, at - 30)
  return text.slice(start, at + Math.min(length, 60) + 30).replace(/\s+/g, ' ')
}
const allowed = (match) => ALLOWED.some((a) => match.includes(a.text))

// One file's text -> what is wrong with it: [{ what, sample }].
export function scanText(text, { username = '', rootPaths = [] } = {}) {
  const found = []
  const search = (what, re) => {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      if (allowed(m[0]) || (m[1] && PLACEHOLDER_ACCOUNTS.has(m[1].toLowerCase()))) continue
      found.push({ what, sample: excerpt(text, m.index, m[0].length) })
      if (found.length > 20) return
    }
  }
  for (const { what, re } of [...LOCAL_PATHS, ...TOKEN_SHAPES]) search(what, re)
  const name = String(username || '')
  if (name.length >= 3 && !GENERIC_USERS.has(name.toLowerCase())) {
    const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    search(`the build machine's user name (${name})`, new RegExp(`(?<![A-Za-z0-9_])${safe}(?![A-Za-z0-9_])`, 'gi'))
  }
  for (const root of rootPaths) {
    if (!root || root.length < 4) continue
    for (const form of new Set([root, root.replace(/\\/g, '/'), root.replace(/\\/g, '\\\\')])) {
      let at = text.indexOf(form)
      while (at >= 0 && found.length <= 20) {
        found.push({ what: 'this checkout’s own path', sample: excerpt(text, at, form.length) })
        at = text.indexOf(form, at + form.length)
      }
    }
  }
  return found
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const CSP = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i

// The whole folder -> { files, bytes, problems: [text] }.
export function checkFolder(root, { username = '', rootPaths = [], demoIndex = join(root, 'demo', 'index.html') } = {}) {
  const problems = []
  const files = walk(root)
  let bytes = 0
  // The rules Cloudflare reads, not assets it serves.
  const counted = files.filter((f) => !['_headers', '_redirects'].includes(basename(f)))
  if (counted.length > MAX_FILES) problems.push(`${counted.length} files: Cloudflare takes at most ${MAX_FILES} per version.`)
  for (const file of files) {
    const rel = relative(root, file)
    const size = statSync(file).size
    bytes += size
    if (size > MAX_FILE_BYTES) problems.push(`${rel}: ${(size / 1048576).toFixed(1)} MiB, over Cloudflare's limit of ${MAX_FILE_BYTES / 1048576} MiB per file.`)
    // As Latin-1: every byte stays one character, in fonts and images too.
    for (const hit of scanText(readFileSync(file, 'latin1'), { username, rootPaths })) problems.push(`${rel}: ${hit.what}: ...${hit.sample}...`)
  }
  if (!existsSync(demoIndex)) problems.push(`${relative(root, demoIndex)} is missing: the demo was not built.`)
  else {
    const csp = CSP.exec(readFileSync(demoIndex, 'utf8'))
    if (!csp) problems.push(`${relative(root, demoIndex)}: no Content-Security-Policy.`)
    else if (!/(?:^|;)\s*connect-src\s+'none'/.test(csp[1])) problems.push(`${relative(root, demoIndex)}: its Content-Security-Policy no longer says connect-src 'none'.`)
  }
  return { files: counted.length, bytes, problems }
}

// Run as a script: the site's folder, or the folder given.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const root = resolve(process.argv[2] || join(repo, 'site', 'public'))
  let username
  try {
    username = userInfo().username
  } catch {
    username = process.env.USERNAME || process.env.USER || ''
  }
  const result = checkFolder(root, { username, rootPaths: [repo] })
  if (result.problems.length) {
    console.error(`check-demo: ${result.problems.length} problem(s) in ${root}:`)
    for (const problem of result.problems.slice(0, 40)) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log(`check-demo: ok, ${result.files} files, ${(result.bytes / 1048576).toFixed(1)} MiB.`)
}
