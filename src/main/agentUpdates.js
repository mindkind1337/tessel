// Agent CLI updates: which installed agents have a newer version, and the
// command that updates each one (run in the background by
// agentUpdateRunner.js, or in a pane when asked: Run in a terminal).
//
// - Installed version: one `npm ls -g --depth=0 --json` for every npm-installed
//   CLI; Claude Code's native install (~/.local/bin/claude.exe) answers
//   `claude --version` (a plain print, no interactive UI). No agent's UI is
//   ever started to learn its version.
// - Latest version: the public npm registry (GET <registry>/<package>/latest,
//   no credentials), cached for a few hours.
// - Agents installed another way (winget, pip, their own installer) are
//   listed as such: Tessel does not guess how to update them.
//
// TESSEL_AGENT_REGISTRY points the registry elsewhere and
// TESSEL_AGENT_UPDATES_FAKE (a JSON file) replaces the detection: both for
// tests only, so nothing real is ever updated by them.
import http from 'http'
import https from 'https'
import fs from 'fs'
import { join, dirname } from 'path'
import { t } from './i18n'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
export const LATEST_TTL_MS = 6 * 60 * 60 * 1000

// Agent id -> its npm package (the one AGENT_PRESETS installs).
export const NPM_PACKAGES = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
  opencode: 'opencode-ai',
  qwen: '@qwen-code/qwen-code',
  copilot: '@github/copilot',
  cline: 'cline',
  amp: '@ampcode/cli',
  pi: '@earendil-works/pi-coding-agent',
  droid: '@factory/cli',
  crush: '@charmland/crush',
  kilo: '@kilocode/cli',
  continue: '@continuedev/cli',
  codebuff: 'codebuff',
  openclaw: 'openclaw',
  openclaude: '@gitlawb/openclaude',
  autohand: 'autohand-cli',
  commandcode: 'command-code',
  mimocode: '@mimo-ai/cli'
}
// Same options as its install (see AGENT_PRESETS).
const NPM_FLAGS = { pi: '--ignore-scripts ' }

// How each agent installed another way updates, when Tessel does not update
// it itself (shown as a hint). Functions: read in the interface's language.
const OTHER_HINTS = {
  kimi: () => t('main.agentUpdate.hintKimi', 'Run its installer again to update it.'),
  ollama: () => t('main.agentUpdate.hintOllama', 'Ollama updates itself (or: winget upgrade Ollama.Ollama).'),
  aider: () => t('main.agentUpdate.hintAider', 'Run aider-install again to update it.')
}
// Installed by the vendor's own script (agentInstalls.js).
for (const id of ['cursor', 'grok', 'antigravity', 'hermes', 'devin', 'omp', 'muse']) {
  OTHER_HINTS[id] = () => t('main.agentUpdate.hintInstaller', 'Run its installer again to update it.')
}

export function npmUpdateSteps(id) {
  const pkg = NPM_PACKAGES[id]
  return pkg ? [`npm install -g ${NPM_FLAGS[id] || ''}${pkg}@latest`] : null
}

// --- Versions ------------------------------------------------------------------
const SEMVER = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?/

// The first x.y.z[-pre] in a text ("2.1.3 (Claude Code)", "v0.157.1"), without
// build metadata; null when there is none.
export function parseVersion(text) {
  const m = SEMVER.exec(String(text == null ? '' : text))
  if (!m) return null
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}${m[4] ? `-${m[4]}` : ''}`
}

function versionParts(v) {
  const m = SEMVER.exec(String(v == null ? '' : v))
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

// Semver precedence: -1, 0, 1 (NaN when either is not a version). A
// pre-release sorts before its release; pre-release parts compare numbers
// numerically, words by ASCII, numbers before words, shorter first.
export function compareVersions(a, b) {
  const x = versionParts(a)
  const y = versionParts(b)
  if (!x || !y) return NaN
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1
  if (!x.pre.length && !y.pre.length) return 0
  if (!x.pre.length) return 1
  if (!y.pre.length) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1
    if (i >= y.pre.length) return 1
    const p = x.pre[i]
    const q = y.pre[i]
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1
    } else if (pn) return -1
    else if (qn) return 1
    else if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

export function isNewer(latest, installed) {
  return compareVersions(latest, installed) > 0
}

// `npm ls -g --depth=0 --json` -> { package: version }. npm exits 1 on
// warnings (extraneous, invalid) but still prints the JSON; text around it
// (a warning on stdout) is ignored.
export function parseNpmLs(text) {
  const s = String(text || '')
  let data = null
  try {
    data = JSON.parse(s)
  } catch {
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a >= 0 && b > a) {
      try {
        data = JSON.parse(s.slice(a, b + 1))
      } catch {
        data = null
      }
    }
  }
  const deps = data && typeof data === 'object' && data.dependencies && typeof data.dependencies === 'object' ? data.dependencies : {}
  const out = {}
  for (const [name, info] of Object.entries(deps)) {
    const v = info && typeof info.version === 'string' ? parseVersion(info.version) : null
    if (v) out[name] = v
  }
  return out
}

// --- Registry --------------------------------------------------------------------
const PKG_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const MAX_BODY = 4 * 1024 * 1024

export function registryUrl(registry, pkg) {
  return `${String(registry || DEFAULT_REGISTRY).replace(/\/+$/, '')}/${pkg.replace('/', '%2F')}/latest`
}

// The version the registry's `latest` tag points to: { version } or { error }.
// A plain public GET: no token, no cookie, no npmrc.
export function fetchLatest(pkg, { registry = DEFAULT_REGISTRY, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    if (typeof pkg !== 'string' || !PKG_NAME.test(pkg)) return resolve({ error: t('main.agentUpdate.notPackage', 'not a package name') })
    let url
    try {
      url = new URL(registryUrl(registry, pkg))
    } catch {
      return resolve({ error: t('main.agentUpdate.badRegistry', 'bad registry address') })
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return resolve({ error: t('main.agentUpdate.badRegistry', 'bad registry address') })
    const lib = url.protocol === 'https:' ? https : http
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      resolve(r)
    }
    const req = lib.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Tessel agent update check' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return finish({ error: t('main.agentUpdate.registryStatus', 'registry answered {{status}}', { status: res.statusCode }) })
      }
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > MAX_BODY) {
          req.destroy()
          finish({ error: t('main.agentUpdate.registryTooLarge', 'registry answer too large') })
        } else chunks.push(c)
      })
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const version = data && typeof data.version === 'string' ? parseVersion(data.version) : null
          finish(version ? { version } : { error: t('main.agentUpdate.registryNoVersion', 'no version in the registry answer') })
        } catch {
          finish({ error: t('main.agentUpdate.registryUnreadable', 'unreadable registry answer') })
        }
      })
      res.on('error', (err) => finish({ error: err.message }))
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      finish({ error: t('main.agentUpdate.registryTimeout', 'registry did not answer in time') })
    })
    req.on('error', (err) => finish({ error: err.message }))
  })
}

// Run `fn` over `items`, at most `limit` at a time.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// Where an installed agent comes from. commandPath: the file `where` finds
// first (the one that runs); npmPrefix: npm's global folder; npmVersions:
// parseNpmLs's result. -> { source: 'npm'|'native'|'other', pkg?, steps? }
export function classifyInstall({ id, commandPath, npmPrefix, npmVersions, home }) {
  const path = String(commandPath || '')
  const lower = path.toLowerCase()
  const pkg = NPM_PACKAGES[id] || null
  if (id === 'claude' && home && /[\\/]claude(\.exe)?$/i.test(path)) {
    const localBin = join(home, '.local', 'bin').toLowerCase()
    if (lower.startsWith(localBin + '\\') || lower.startsWith(localBin + '/')) {
      return { source: 'native', pkg, steps: ['claude update'] }
    }
  }
  if (pkg && npmVersions && npmVersions[pkg] && npmPrefix && path) {
    const dir = dirname(path).toLowerCase().replace(/[\\/]+$/, '')
    const prefix = String(npmPrefix).toLowerCase().replace(/[\\/]+$/, '')
    if (dir === prefix || dir === join(prefix, 'bin').toLowerCase()) {
      return { source: 'npm', pkg, installed: npmVersions[pkg], steps: npmUpdateSteps(id) }
    }
  }
  return { source: 'other' }
}

// getAgents(): the agents with `available`; which(bin) -> first path or null;
// shell(line) -> { ok, stdout } (through cmd, for npm); runFile(file, args)
// -> { ok, stdout }; cacheFile: where latest versions and notified ones are
// kept; home: the user's home.
export function createAgentUpdates({
  getAgents,
  which,
  shell,
  runFile,
  cacheFile,
  home,
  registry = DEFAULT_REGISTRY,
  fakeFile = null,
  ttlMs = LATEST_TTL_MS,
  now = () => Date.now(),
  log = () => {}
}) {
  let cache = null
  let last = null
  let running = null

  function loadCache() {
    if (cache) return cache
    cache = { latest: {}, notified: {} }
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (data && typeof data.latest === 'object' && data.latest) cache.latest = data.latest
      if (data && typeof data.notified === 'object' && data.notified) cache.notified = data.notified
    } catch {
      /* none yet */
    }
    return cache
  }
  function saveCache() {
    if (!cacheFile) return
    try {
      fs.mkdirSync(dirname(cacheFile), { recursive: true })
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2))
    } catch (err) {
      log('warn', `agent updates: could not save ${cacheFile}: ${err.message}`)
    }
  }

  async function latestOf(pkg, force) {
    const c = loadCache()
    const hit = c.latest[pkg]
    if (!force && hit && typeof hit.version === 'string' && now() - (hit.at || 0) < ttlMs) return { version: hit.version }
    const r = await fetchLatest(pkg, { registry })
    if (r.version) c.latest[pkg] = { version: r.version, at: now() }
    else if (hit && typeof hit.version === 'string') return { version: hit.version, error: r.error }
    return r
  }

  // The installed agents and where each comes from.
  async function detect() {
    const presets = (await getAgents()).filter((a) => a && a.available && !a.custom)
    if (fakeFile) {
      let fake = []
      try {
        fake = JSON.parse(fs.readFileSync(fakeFile, 'utf8')).agents || []
      } catch (err) {
        log('warn', `agent updates: fake file unreadable: ${err.message}`)
      }
      return fake
        .filter((f) => f && typeof f.id === 'string')
        .map((f) => ({
          id: f.id,
          name: f.name || (presets.find((p) => p.id === f.id) || {}).name || f.id,
          source: f.source || 'npm',
          pkg: f.pkg || NPM_PACKAGES[f.id] || null,
          installed: parseVersion(f.installed),
          steps: Array.isArray(f.steps) ? f.steps.map(String) : npmUpdateSteps(f.id)
        }))
    }
    const [ls, root] = await Promise.all([shell('npm ls -g --depth=0 --json'), shell('npm root -g')])
    const npmVersions = parseNpmLs(ls.stdout)
    const rootDir = String(root.stdout || '').trim().split(/\r?\n/).pop() || ''
    const npmPrefix = rootDir ? (process.platform === 'win32' ? dirname(rootDir) : dirname(dirname(rootDir))) : ''
    return Promise.all(
      presets.map(async (a) => {
        const bin = String(a.command || '').trim().split(/\s+/)[0]
        const commandPath = bin ? await which(bin) : null
        const c = classifyInstall({ id: a.id, commandPath, npmPrefix, npmVersions, home })
        let installed = c.installed || null
        if (c.source === 'native') installed = parseVersion((await runFile(commandPath, ['--version'])).stdout)
        return {
          id: a.id,
          name: a.name,
          source: c.source,
          pkg: c.source === 'other' ? null : c.pkg,
          installed,
          steps: c.steps || null,
          ...(c.source === 'other' ? { note: OTHER_HINTS[a.id] ? OTHER_HINTS[a.id]() : t('main.agentUpdate.hintOther', 'Installed outside npm: update it the way you installed it.') } : {})
        }
      })
    )
  }

  async function runCheck({ force = false } = {}) {
    const found = await detect()
    const pkgs = [...new Set(found.filter((f) => f.pkg && f.installed && f.source !== 'other').map((f) => f.pkg))]
    const latest = {}
    await mapLimit(pkgs, 4, async (pkg) => {
      latest[pkg] = await latestOf(pkg, force)
    })
    const c = loadCache()
    const agents = {}
    const newlyFound = []
    for (const f of found) {
      const l = f.pkg ? latest[f.pkg] : null
      const row = {
        id: f.id,
        name: f.name,
        source: f.source,
        installed: f.installed,
        latest: l && l.version ? l.version : null,
        update: false,
        steps: f.steps,
        ...(f.note ? { note: f.note } : {}),
        ...(l && l.error ? { error: l.error } : {})
      }
      row.update = !!(row.installed && row.latest && row.steps && isNewer(row.latest, row.installed))
      agents[f.id] = row
      // Told once per new version.
      if (row.update && c.notified[f.id] !== row.latest) {
        c.notified[f.id] = row.latest
        newlyFound.push({ id: f.id, name: f.name, installed: row.installed, latest: row.latest })
      }
    }
    saveCache()
    last = { checkedAt: now(), agents }
    return { ...last, newlyFound }
  }

  return {
    // The last result (null before the first check).
    status: () => last,
    // One check at a time; force: ask the registry again (else cached).
    check(opts = {}) {
      if (!running) {
        running = runCheck(opts)
          .catch((err) => {
            log('warn', `agent updates: check failed: ${err.message}`)
            return { checkedAt: now(), agents: last ? last.agents : {}, newlyFound: [], error: err.message }
          })
          .finally(() => {
            running = null
          })
      }
      return running
    }
  }
}
