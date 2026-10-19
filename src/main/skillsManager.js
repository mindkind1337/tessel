// Agent skills (a folder with a SKILL.md and its files), for every agent CLI
// that reads them, in one place (the Skills window, SkillsDialog.vue):
//   list    - each agent's skill folders, user and project, with the
//             SKILL.md frontmatter (name, description) and who reads it;
//   add     - from a folder or a GitHub repository (its tarball over https,
//             only the skill's folder kept), always shown before installing,
//             then copied into the skill folder of each chosen agent;
//   remove  - to the Recycle Bin, or deleted;
//   update  - a skill added from GitHub, from the same place again.
// Nothing from a skill is ever run: no install script, no setup. A setup
// command found in its instructions (npx <pkg> setup) is only offered, for
// the user to run in a pane they see.
//
// Where each agent reads skills (user = all projects, project = this folder):
//   Claude Code  ~/.claude/skills            .claude/skills
//   Codex        ~/.agents/skills, $CODEX_HOME/skills   .agents/skills, .codex/skills
//   OpenCode     ~/.config/opencode/skills   .opencode/skills  (and the Claude and .agents folders)
//   Copilot CLI  ~/.copilot/skills           .github/skills    (and the Claude and .agents folders)
//   Gemini CLI   ~/.gemini/skills            .gemini/skills    (and the .agents folders)
//   Antigravity  ~/.gemini/config/skills     .agents/skills    (agy, checked with its /skills)
//   Muse Code    ~/.config/muse/skills       .agents/skills    (and the Claude, Codex and .agents folders)
//   Grok Build   <GROK_HOME or ~/.grok>/skills   .grok/skills  (and the Claude and .agents folders)
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes, createHash } from 'node:crypto'
import { t } from './i18n'
import { skillFrontmatter } from './chat/skills.js'
import { readTar, gunzipCapped } from './skillsTar'
import { writeFileAtomic } from './safeJson'

export const SKILL_AGENTS = ['claude', 'codex', 'opencode', 'copilot', 'gemini', 'antigravity', 'muse', 'grok']

export const SKILL_CAPS = {
  files: 1000, // files in one skill
  bytes: 20 * 1024 * 1024, // all its files together
  depth: 12, // folders inside the skill
  download: 50 * 1024 * 1024, // a GitHub archive, compressed
  unpacked: 300 * 1024 * 1024, // the same, unpacked
  skillMd: 256 * 1024, // the SKILL.md shown before installing
  listDepth: 3, // folders looked into below a skill folder when listing
  listed: 2000 // skills listed in all
}

const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {})
export const sameKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
const inside = (root, file) => {
  const rel = path.relative(root, file)
  return !!rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)
}

// A skill's folder name: what the agents call it. Letters, digits, . _ -,
// never a Windows device name or a name ending in a dot.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
export function isSafeSkillName(name) {
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) &&
    !name.endsWith('.') &&
    !RESERVED.test(name)
  )
}

// A path inside a skill, as written in an archive ("scripts/run.py"):
// relative, forward slashes, no "." or "..", nothing Windows would read
// differently (a drive, a stream after ":", a trailing dot or space).
export function safeRelPath(rel, caps = SKILL_CAPS) {
  if (typeof rel !== 'string' || !rel || rel.length > 240) return null
  if (/[\p{Cc}\\:*?"<>|]/u.test(rel) || rel.startsWith('/')) return null
  const parts = rel.replace(/\/$/, '').split('/')
  if (parts.length > caps.depth + 1) return null
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || RESERVED.test(part)) return null
  }
  return parts.join('/')
}

// ---------------------------------------------------------------- Folders

// Every skill folder Tessel knows, with the agents that read it and the
// agents it installs for. A folder read by several agents is listed once.
export function skillRoots({ home = os.homedir(), env = process.env, cwd = null } = {}) {
  const codexHome = env.CODEX_HOME || path.join(home, '.codex')
  const grokHome = env.GROK_HOME || path.join(home, '.grok')
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config')
  const roots = [
    { scope: 'user', path: path.join(home, '.claude', 'skills'), seenBy: ['claude', 'opencode', 'copilot', 'muse', 'grok'], installFor: ['claude'] },
    { scope: 'user', path: path.join(home, '.agents', 'skills'), seenBy: ['codex', 'opencode', 'copilot', 'gemini', 'muse', 'grok'], installFor: ['codex'] },
    { scope: 'user', path: path.join(codexHome, 'skills'), seenBy: ['codex', 'muse'], installFor: [] },
    { scope: 'user', path: path.join(config, 'opencode', 'skills'), seenBy: ['opencode'], installFor: ['opencode'] },
    { scope: 'user', path: path.join(home, '.copilot', 'skills'), seenBy: ['copilot'], installFor: ['copilot'] },
    { scope: 'user', path: path.join(home, '.gemini', 'skills'), seenBy: ['gemini'], installFor: ['gemini'] },
    // The Antigravity CLI's own (not Gemini CLI's ~/.gemini/skills).
    { scope: 'user', path: path.join(home, '.gemini', 'config', 'skills'), seenBy: ['antigravity'], installFor: ['antigravity'] },
    // Muse Code's own (it also reads the Claude Code, Codex and .agents ones).
    { scope: 'user', path: path.join(config, 'muse', 'skills'), seenBy: ['muse'], installFor: ['muse'] },
    // Grok Build's own (it also reads the Claude Code and .agents ones).
    { scope: 'user', path: path.join(grokHome, 'skills'), seenBy: ['grok'], installFor: ['grok'] }
  ]
  if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
    const at = (...parts) => path.join(cwd, ...parts)
    roots.push(
      { scope: 'project', path: at('.claude', 'skills'), seenBy: ['claude', 'opencode', 'copilot', 'muse', 'grok'], installFor: ['claude'] },
      { scope: 'project', path: at('.agents', 'skills'), seenBy: ['codex', 'opencode', 'copilot', 'gemini', 'antigravity', 'muse', 'grok'], installFor: ['codex', 'antigravity', 'muse'] },
      { scope: 'project', path: at('.codex', 'skills'), seenBy: ['codex', 'muse'], installFor: [] },
      { scope: 'project', path: at('.opencode', 'skills'), seenBy: ['opencode'], installFor: ['opencode'] },
      { scope: 'project', path: at('.github', 'skills'), seenBy: ['copilot'], installFor: ['copilot'] },
      { scope: 'project', path: at('.gemini', 'skills'), seenBy: ['gemini'], installFor: ['gemini'] },
      { scope: 'project', path: at('.grok', 'skills'), seenBy: ['grok'], installFor: ['grok'] }
    )
  }
  const byKey = new Map()
  for (const root of roots) {
    const key = sameKey(root.path)
    const seen = byKey.get(key)
    if (!seen) byKey.set(key, { ...root, path: path.resolve(root.path) })
    else {
      seen.seenBy = [...new Set([...seen.seenBy, ...root.seenBy])]
      seen.installFor = [...new Set([...seen.installFor, ...root.installFor])]
    }
  }
  return [...byKey.values()]
}

// The folders a skill goes to for these agents and scope (one per folder).
export function targetRoots(agents, scope, opts) {
  const roots = skillRoots(opts).filter((r) => r.scope === scope)
  const out = []
  for (const agent of agents || []) {
    const root = roots.find((r) => r.installFor.includes(agent))
    if (root && !out.includes(root)) out.push(root)
  }
  return out
}

// The root a skill folder sits directly in, if it is one Tessel knows.
function rootOfSkill(dir, opts) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null
  const parent = sameKey(path.dirname(path.resolve(dir)))
  return skillRoots(opts).find((r) => sameKey(r.path) === parent) || null
}

// ---------------------------------------------------------------- Sources
// Where a skill was added from (to update it): one JSON file in Tessel's
// data folder, by skill folder. Never inside the skill's own folder.
export function createSkillSources(file) {
  let data = null
  const load = () => {
    if (data) return data
    try {
      const parsed = JSON.parse(fsSync.readFileSync(file, 'utf8'))
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      data = {}
    }
    return data
  }
  const save = () => {
    try {
      fsSync.mkdirSync(path.dirname(file), { recursive: true })
      writeFileAtomic(file, JSON.stringify(data, null, 2))
    } catch {
      // not saved: the skill is installed, only "Update" is missing
    }
  }
  return {
    get: (dir) => load()[sameKey(dir)] || null,
    set(dir, source) {
      load()[sameKey(dir)] = source
      save()
    },
    remove(dir) {
      if (load()[sameKey(dir)]) {
        delete data[sameKey(dir)]
        save()
      }
    },
    all: () => ({ ...load() })
  }
}

// Folders a tool fills inside a skill (packages, environments, caches,
// builds, git): not the skill's content. Never read for its history, never
// touched by it. A Python environment is one whatever its name (it holds a
// pyvenv.cfg).
export const SKIPPED_DIR = /^(\.git|node_modules|\.venv|venv|__pycache__|\.mypy_cache|\.pytest_cache|\.tox|\.cache|dist|build|coverage|target)$/i
export const isSkippedRel = (rel) => String(rel).split('/').slice(0, -1).some((part) => SKIPPED_DIR.test(part))

// A skill's content as one hash: each file's path and the hash of its bytes,
// in path order. The same for a package in memory ({ rel, data }) and a
// folder read from disk ({ rel, sha }), so an edited copy is noticed.
const byRel = (x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0)
export const sha256 = (data) => createHash('sha256').update(data).digest('hex')
export function contentHash(files) {
  const envs = files.filter((f) => /(^|\/)pyvenv\.cfg$/.test(f.rel) && f.rel.includes('/')).map((f) => f.rel.slice(0, -'/pyvenv.cfg'.length) + '/')
  const h = createHash('sha256')
  const list = files.filter((f) => !isSkippedRel(f.rel) && !envs.some((e) => f.rel.startsWith(e))).map((f) => ({ rel: f.rel, sha: f.sha || sha256(f.data) }))
  for (const f of list.sort(byRel)) h.update(`${f.rel}\0${f.sha}\n`)
  return h.digest('hex')
}

// Skill folders being installed or updated right now (renamed aside for a
// moment): their records are never taken for stale.
const installing = new Set()

// Deletes a folder and everything in it without ever following a link: a
// link or a Windows junction inside is removed itself, never what it points
// to (Electron's recursive fs.rm can follow junctions).
export async function removeTree(target) {
  const st = await fs.lstat(target).catch(() => null)
  if (!st) return
  if (st.isSymbolicLink()) {
    try {
      await fs.unlink(target)
    } catch {
      await fs.rmdir(target)
    }
  } else if (st.isDirectory()) {
    for (const name of await fs.readdir(target)) await removeTree(path.join(target, name))
    await fs.rmdir(target)
  } else await fs.unlink(target)
}

// Records of skills whose folder is gone (deleted, a removed worktree) are
// dropped: never checked for updates again, never given to a new folder of
// the same name. One on a drive that is not there now is kept, and one being
// installed.
export function dropStaleSources(sources) {
  let dropped = 0
  for (const dir of Object.keys(sources ? sources.all() : {})) {
    if (installing.has(sameKey(dir))) continue
    try {
      fsSync.statSync(dir)
    } catch (err) {
      if (err && err.code === 'ENOENT' && fsSync.existsSync(path.parse(path.resolve(dir)).root)) {
        sources.remove(dir)
        dropped++
      }
    }
  }
  return dropped
}

// Where a copy comes from: 'github' or 'folder' when Tessel recorded adding
// it, 'agent' for the agent's own (synced, built in, plugin stores), else
// 'own': made on this computer.
export function skillOrigin(skill) {
  if (skill && skill.managed) return 'agent'
  const source = skill && skill.source
  if (source && source.kind === 'github') return 'github'
  if (source && source.kind === 'folder') return 'folder'
  return 'own'
}

// ---------------------------------------------------------------- Listing

async function readHead(file, bytes) {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

// A folder never looked into for skills: a hidden one (an agent's trash,
// where Claude Code moves a deleted skill as .trash/<id>/<name>; a copy being
// installed or set aside, .<name>.tessel-…; a tool's cache), except Codex's
// built-in skills at the top of its folder (.system).
export function isListedFolder(name, depth) {
  if (name.startsWith('.')) return depth === 0 && name === '.system'
  return true
}

// -> { roots: [{ path, scope, seenBy, installFor, exists }], skills: [...], home }
// A skill directly in a root can be removed; the ones further down belong to
// the agent (Claude's synced skills, Codex's built-in .system ones, plugin
// stores) and are only shown. mdHash: the SKILL.md's hash, so that the
// Skills list can tell copies of the same skill that differ.
export async function listSkills({ home = os.homedir(), env = process.env, cwd = null, sources = null, caps = SKILL_CAPS } = {}) {
  const roots = skillRoots({ home, env, cwd })
  const skills = []
  async function visit(root, dir, depth, managed) {
    if (skills.length >= caps.listed) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (skills.length >= caps.listed) return
      if (!isListedFolder(entry.name, depth)) continue
      const child = path.join(dir, entry.name)
      const link = entry.isSymbolicLink()
      let isDir = entry.isDirectory()
      if (link) {
        try {
          isDir = (await fs.stat(child)).isDirectory()
        } catch {
          isDir = false
        }
      }
      if (!isDir) continue
      const reason = managed || (depth > 0 ? 'nested' : entry.name === 'synced' ? 'synced' : entry.name === '.system' ? 'system' : null)
      const skillFile = path.join(child, 'SKILL.md')
      let stat = null
      try {
        stat = await fs.stat(skillFile)
      } catch {
        // no SKILL.md here
      }
      if (stat && stat.isFile()) {
        let meta = null
        let mdHash = null
        try {
          const head = await readHead(skillFile, 64 * 1024)
          mdHash = sha256(head)
          meta = skillFrontmatter(head, entry.name)
        } catch {
          // unreadable: listed by its folder name
        }
        const source = sources ? sources[sameKey(child)] || null : null
        skills.push({
          id: skillFile,
          name: (meta && meta.name) || entry.name,
          description: (meta && meta.description) || null,
          folder: entry.name,
          dir: child,
          skillFile,
          rootPath: root.path,
          scope: root.scope,
          seenBy: [...root.seenBy],
          managed: depth === 0 ? null : reason,
          link,
          removable: depth === 0 && !link,
          source: source && typeof source === 'object' ? source : null,
          updatedAt: stat.mtimeMs,
          mdHash
        })
        skills[skills.length - 1].origin = skillOrigin(skills[skills.length - 1])
      } else if (!link && depth < caps.listDepth && !SKIPPED_DIR.test(entry.name)) {
        // Not a skill: looked into, unless a tool filled it (node_modules, a build).
        await visit(root, child, depth + 1, reason)
      }
    }
  }
  const out = []
  for (const root of roots) {
    let exists = false
    try {
      exists = (await fs.stat(root.path)).isDirectory()
    } catch {
      // not there
    }
    out.push({ ...root, exists })
    if (exists) await visit(root, root.path, 0, null)
  }
  return { roots: out, skills, home: path.resolve(home) }
}

// ---------------------------------------------------------------- Packages
// A skill about to be installed: its files in memory, exactly what was shown,
// so nothing can change between the preview and the copy.
const packages = new Map() // id -> package
const PACKAGE_TTL = 30 * 60 * 1000

function keepPackage(pkg, now = Date.now()) {
  for (const [id, p] of packages) if (now - p.at > PACKAGE_TTL) packages.delete(id)
  while (packages.size >= 6) packages.delete(packages.keys().next().value)
  const id = randomBytes(12).toString('hex')
  packages.set(id, { ...pkg, at: now })
  return id
}
export function getPackage(id) {
  const pkg = typeof id === 'string' ? packages.get(id) : null
  return pkg && Date.now() - pkg.at <= PACKAGE_TTL ? pkg : null
}

const SCRIPT = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|exe|dll|so|dylib|jar|vbs)$/i
// "npx some-pkg setup" in its instructions: offered, never run. Rebuilt from
// its parts, so only a package name and a known verb reach the command line.
const SETUP = /\bnpx\s+(?:(?:-y|--yes)\s+)?((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.^~-]+)?)\s+(setup|init|install)\b/gi
export function findSetupCommands(text) {
  const out = []
  for (const m of String(text || '').matchAll(SETUP)) {
    if (/^skills(@|$)/i.test(m[1])) continue // the skills installer, not a setup
    const command = `npx ${m[1]} ${m[2].toLowerCase()}` // i18n-ignore command
    if (!out.includes(command)) out.push(command)
    if (out.length >= 3) break
  }
  return out
}

// files: [{ rel, data }] (rel already checked). fallback: the folder's name.
export function makePackage(files, source, fallback, caps = SKILL_CAPS) {
  const skillMd = files.find((f) => f.rel === 'SKILL.md')
  if (!skillMd) throw fail(t('main.skills.noSkillMd', 'There is no SKILL.md in this folder.'), 'SKILL_NO_MD')
  const text = skillMd.data.subarray(0, caps.skillMd).toString('utf8')
  const meta = skillFrontmatter(text, isSafeSkillName(fallback) ? fallback : 'skill')
  const name = meta && isSafeSkillName(meta.name) ? meta.name : isSafeSkillName(fallback) ? fallback : null
  if (!name) throw fail(t('main.skills.badName', 'This skill has no usable name (letters, digits, dot, dash and underscore).'), 'SKILL_BAD_NAME')
  const readme = files.find((f) => /^readme\.md$/i.test(f.rel))
  const setup = findSetupCommands(text + '\n' + (readme ? readme.data.subarray(0, caps.skillMd).toString('utf8') : ''))
  const pkg = {
    name,
    description: (meta && meta.description) || null,
    skillMd: text,
    files,
    totalBytes: files.reduce((n, f) => n + f.data.length, 0),
    scripts: files.filter((f) => SCRIPT.test(f.rel)).map((f) => f.rel),
    setup,
    source
  }
  const id = keepPackage(pkg)
  return publicPackage(id, pkg)
}

export function publicPackage(id, pkg) {
  return {
    id,
    name: pkg.name,
    description: pkg.description,
    skillMd: pkg.skillMd,
    files: pkg.files.map((f) => ({ path: f.rel, size: f.data.length })),
    totalBytes: pkg.totalBytes,
    scripts: pkg.scripts,
    setup: pkg.setup,
    source: pkg.source
  }
}

function tooBig() {
  return fail(
    t('main.skills.tooBig', 'This skill is too large (over {{files}} files or {{mb}} MB).', {
      files: SKILL_CAPS.files,
      mb: Math.round(SKILL_CAPS.bytes / 1024 / 1024)
    }),
    'SKILL_TOO_BIG'
  )
}
const linkRefused = (rel) =>
  fail(t('main.skills.link', 'This skill contains a link ({{path}}). Skills with links are not installed.', { path: rel }), 'SKILL_LINK')
const pathRefused = (rel) =>
  fail(t('main.skills.badPath', 'This skill contains a file outside its folder or with an unsafe name ({{path}}).', { path: rel }), 'SKILL_PATH')

// From a folder on this computer: it must hold a SKILL.md. Links are refused
// (they could point anywhere); .git is left out.
export async function packageFromFolder(dir, caps = SKILL_CAPS) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw fail(t('main.skills.noFolder', 'Choose a folder.'))
  const top = await fs.lstat(dir).catch(() => null)
  if (!top || !top.isDirectory()) throw fail(t('main.skills.noFolder', 'Choose a folder.'))
  if (top.isSymbolicLink()) throw linkRefused(path.basename(dir))
  const files = []
  let total = 0
  async function walk(abs, rel, depth) {
    const entries = await fs.readdir(abs, { withFileTypes: true })
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const child = path.join(abs, entry.name)
      const st = await fs.lstat(child)
      if (st.isSymbolicLink()) throw linkRefused(childRel)
      if (st.isDirectory()) {
        if (entry.name === '.git') continue
        if (depth >= caps.depth) throw tooBig()
        await walk(child, childRel, depth + 1)
      } else if (st.isFile()) {
        if (!safeRelPath(childRel, caps)) throw pathRefused(childRel)
        if (files.length + 1 > caps.files || total + st.size > caps.bytes) throw tooBig()
        const data = await fs.readFile(child)
        total += data.length
        if (total > caps.bytes) throw tooBig()
        files.push({ rel: childRel, data })
      } else throw pathRefused(childRel)
    }
  }
  await walk(dir, '', 0)
  return makePackage(files, { kind: 'folder', path: dir }, path.basename(dir), caps)
}

// "owner/repo", "owner/repo/path/to/skill", "owner/repo@ref", or a github.com
// URL (…/tree/<ref>/<path>, …/blob/<ref>/<path>/SKILL.md).
export function parseGithubSpec(input) {
  let s = String(input || '').trim()
  if (!s || s.length > 500) return null
  let ref = null
  let parts
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(s)
  if (url) {
    s = url[1].replace(/[?#].*$/, '').replace(/\/+$/, '')
    parts = s.split('/')
    if (parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob')) {
      ref = parts[3]
      parts = [parts[0], parts[1], ...parts.slice(4)]
    } else if (parts.length > 2) return null
  } else {
    if (/^[a-z]+:/i.test(s)) return null
    const at = s.lastIndexOf('@')
    if (at > 0) {
      ref = s.slice(at + 1)
      s = s.slice(0, at)
    }
    parts = s.replace(/\/+$/, '').split('/')
  }
  const [owner, rawRepo, ...rest] = parts
  const repo = (rawRepo || '').replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner || '')) return null
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return null
  if (ref != null && (!/^[A-Za-z0-9._-]{1,200}$/.test(ref) || ref.includes('..'))) return null
  if (rest.length && /^skill\.md$/i.test(rest[rest.length - 1])) rest.pop()
  const sub = rest.length ? safeRelPath(rest.join('/')) : ''
  if (sub == null) return null
  return { owner, repo, ref, path: sub }
}

// The archive, with a cap on its size and a check of where it came from.
// Given up when GitHub sends nothing for `stall` ms, or after `total` ms in
// all: a big repository on a slow connection can take minutes, a stalled one
// should not keep the window waiting.
export const DOWNLOAD_TIMEOUTS = { stall: 45000, total: 5 * 60 * 1000 }
async function download(url, fetchFn, caps, timeouts = DOWNLOAD_TIMEOUTS) {
  const ctrl = new AbortController()
  let idle = setTimeout(() => ctrl.abort(), timeouts.stall)
  const timer = setTimeout(() => ctrl.abort(), timeouts.total)
  const alive = () => {
    clearTimeout(idle)
    idle = setTimeout(() => ctrl.abort(), timeouts.stall)
  }
  const failed = (err) => fail(t('main.skills.downloadFailed', 'Could not download it: {{error}}', { error: (err && err.message) || String(err) }))
  try {
    let res
    try {
      res = await fetchFn(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Tessel' } })
    } catch (err) {
      throw failed(err)
    }
    if (res.url && !/^https:\/\/(codeload\.)?github\.com\//i.test(res.url))
      throw fail(t('main.skills.badRedirect', 'GitHub sent the download somewhere else; it was not used.'))
    if (res.status === 404) throw fail(t('main.skills.notFound', 'Not found on GitHub (a private repository, or a wrong name or branch).'), 'SKILL_NOT_FOUND')
    if (!res.ok) throw fail(t('main.skills.httpError', 'GitHub answered {{status}}.', { status: res.status }))
    const length = Number(res.headers && res.headers.get && res.headers.get('content-length'))
    if (length > caps.download) throw tooBig()
    const chunks = []
    let size = 0
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      for (;;) {
        let chunk
        try {
          chunk = await reader.read()
        } catch (err) {
          throw failed(err) // cut off, or given up (no data for too long)
        }
        if (chunk.done) break
        alive()
        size += chunk.value.length
        if (size > caps.download) {
          ctrl.abort()
          throw tooBig()
        }
        chunks.push(Buffer.from(chunk.value))
      }
    } else {
      let buf
      try {
        buf = Buffer.from(await res.arrayBuffer())
      } catch (err) {
        throw failed(err)
      }
      if (buf.length > caps.download) throw tooBig()
      chunks.push(buf)
    }
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(idle)
    clearTimeout(timer)
  }
}

let lastArchive = null // { url, repo, commit, gz, at }: one repository, while choosing skills in it
const ARCHIVE_KEPT = 10 * 60 * 1000
const COMMIT = /^[0-9a-f]{40}$/i

// -> a package, or { candidates: [{ path, name, description }] } when the
// repository holds several skills and none was picked (`pick`: its path).
// `commit`: the commit the list was read at. Each skill picked from that list
// (its preview, several installed in one go) comes from that same commit,
// even once the archive kept is gone and the branch has moved on.
export async function packageFromGithub(input, { fetchFn = fetch, pick = null, fresh = false, commit = null, caps = SKILL_CAPS, timeouts = DOWNLOAD_TIMEOUTS } = {}) {
  const spec = typeof input === 'object' && input ? input : parseGithubSpec(input)
  if (!spec || !spec.owner) throw fail(t('main.skills.badRepo', 'Enter a GitHub repository: owner/repo, owner/repo/path, or its github.com address.'), 'SKILL_BAD_REPO')
  const pinned = typeof commit === 'string' && COMMIT.test(commit) ? commit.toLowerCase() : null
  const refPart = pinned || (spec.ref ? encodeURIComponent(spec.ref) : 'HEAD')
  const url = `https://github.com/${spec.owner}/${spec.repo}/archive/${refPart}.tar.gz` // i18n-ignore URL
  const repoKey = `${spec.owner}/${spec.repo}`.toLowerCase()
  const kept = !fresh && lastArchive && Date.now() - lastArchive.at < ARCHIVE_KEPT ? lastArchive : null
  let gz
  if (kept && (kept.url === url || (pinned && kept.repo === repoKey && kept.commit === pinned))) gz = kept.gz
  else {
    gz = await download(url, fetchFn, caps, timeouts)
    lastArchive = { url, repo: repoKey, commit: null, gz, at: Date.now() }
  }
  let tar
  try {
    tar = readTar(gunzipCapped(gz, caps.unpacked))
  } catch (err) {
    if (err && err.code === 'SKILL_TOO_BIG') throw tooBig()
    throw fail(t('main.skills.badArchive', 'The download is not a readable archive.'))
  }
  const archiveCommit = tar.comment && COMMIT.test(tar.comment) ? tar.comment.toLowerCase() : null
  if (lastArchive && lastArchive.gz === gz) lastArchive.commit = archiveCommit
  // git archive puts everything in one "<repo>-<commit>/" folder: dropped.
  const strip = (p) => {
    const i = String(p).indexOf('/')
    return i < 0 ? '' : p.slice(i + 1)
  }
  const entries = tar.entries.map((e) => ({ ...e, rel: strip(e.path).replace(/\/+$/, '') }))
  const skillDirs = entries
    .filter((e) => e.kind === 'file' && (e.rel === 'SKILL.md' || e.rel.endsWith('/SKILL.md')))
    .map((e) => (e.rel === 'SKILL.md' ? '' : e.rel.slice(0, -'/SKILL.md'.length)))
  const base = typeof pick === 'string' ? pick : spec.path || ''
  const under = (dir) => !base || dir === base || dir.startsWith(base + '/')
  let chosen
  if (skillDirs.includes(base)) chosen = base
  else {
    const found = skillDirs.filter(under)
    const where = `${spec.owner}/${spec.repo}${base ? '/' + base : ''}` // i18n-ignore path
    if (!found.length) throw fail(t('main.skills.noSkillInRepo', 'No SKILL.md found in {{where}}.', { where }), 'SKILL_NO_MD')
    if (found.length === 1) chosen = found[0]
    else {
      // Each skill's files and size, as its package would hold them (a skill
      // inside another counts in both): one pass, each file up its folders.
      const shown = found.slice(0, 300)
      const sizes = new Map(shown.map((dir) => [dir, { files: 0, bytes: 0 }]))
      for (const e of entries) {
        if (e.kind !== 'file') continue
        const parts = e.rel.split('/')
        for (let i = parts.length - 1; i > 0; i--) {
          const size = sizes.get(parts.slice(0, i).join('/'))
          if (size) {
            size.files++
            size.bytes += e.data.length
          }
        }
      }
      return {
        candidates: shown.map((dir) => {
          const md = entries.find((e) => e.kind === 'file' && e.rel === `${dir}/SKILL.md`)
          const fallback = path.posix.basename(dir)
          const meta = md ? skillFrontmatter(md.data.subarray(0, 64 * 1024).toString('utf8'), fallback) : null
          return { path: dir, name: (meta && meta.name) || fallback, description: (meta && meta.description) || null, ...sizes.get(dir) }
        }),
        // More than shown (a list of hundreds): how many there are in all.
        total: found.length,
        repo: where,
        commit: archiveCommit
      }
    }
  }
  const prefix = chosen ? chosen + '/' : ''
  const files = []
  let total = 0
  for (const e of entries) {
    if (chosen && e.rel !== chosen && !e.rel.startsWith(prefix)) continue
    const rel = e.rel.slice(prefix.length)
    if (!rel) continue
    if (!chosen && (rel === '.git' || rel.startsWith('.git/'))) continue
    if (e.kind === 'dir') {
      if (!safeRelPath(rel, caps)) throw pathRefused(rel)
      continue
    }
    if (e.kind === 'symlink' || e.kind === 'hardlink') throw linkRefused(rel)
    if (e.kind !== 'file') throw pathRefused(rel)
    const safe = safeRelPath(rel, caps)
    if (!safe || safe !== rel) throw pathRefused(rel)
    total += e.data.length
    if (files.length + 1 > caps.files || total > caps.bytes) throw tooBig()
    files.push({ rel, data: Buffer.from(e.data) })
  }
  return makePackage(
    files,
    { kind: 'github', owner: spec.owner, repo: spec.repo, ref: spec.ref || null, path: chosen, commit: archiveCommit },
    path.posix.basename(chosen) || spec.repo,
    caps
  )
}

// Update: the skill again from where it was added (GitHub only), always a
// fresh download, shown like a new one before it replaces the old copy.
export async function packageForUpdate(dir, sources, opts = {}) {
  const source = sources && typeof dir === 'string' ? sources.get(dir) : null
  if (!source || source.kind !== 'github' || !source.owner || !source.repo)
    throw fail(t('main.skills.noSource', 'This skill was not added from GitHub by Tessel: nothing to update.'))
  const spec = { owner: source.owner, repo: source.repo, ref: source.ref || null, path: source.path || '' }
  if (!parseGithubSpec(`${spec.owner}/${spec.repo}`)) throw fail(t('main.skills.badRepo', 'Enter a GitHub repository: owner/repo, owner/repo/path, or its github.com address.'))
  return packageFromGithub(spec, { ...opts, pick: spec.path, fresh: true })
}

// ---------------------------------------------------------------- Install

async function writeTree(dest, files) {
  await fs.mkdir(dest)
  for (const f of files) {
    const target = path.resolve(dest, ...f.rel.split('/'))
    if (!inside(dest, target)) throw pathRefused(f.rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, f.data, { flag: 'wx' })
  }
}

// A folder holding a SKILL.md at its top: a skill copy.
async function hasSkillFile(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).some((e) => e.isFile() && /^skill\.md$/i.test(e.name))
  } catch {
    return false
  }
}

// Copies the package into each target folder (<root>/<name>). An existing
// skill of that name is kept (exists: true) unless `replace` names its folder
// (Update): then the new copy takes its place, and the old folder goes to the
// Recycle Bin whole (`trash`; .git, node_modules and all), never deleted for
// good. Without `trash` it is removed (never following a link).
// history (skillHistory.js): a skill copy being replaced is kept as a version
// first, and the new content is noted as installed or updated. A copy that
// cannot be kept whole (and is not exactly what was installed) is never
// replaced; a folder without a SKILL.md is no skill copy and has no history.
// A rename tried again while the file is held for a moment (antivirus right
// after the files were written, on Windows).
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return await fs.rename(from, to)
    } catch (err) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err && err.code)) throw err
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

export async function installSkill({ id, agents = [], scope = 'user', cwd = null, replace = null, home = os.homedir(), env = process.env, sources = null, history = null, trash = null } = {}) {
  const pkg = getPackage(id)
  if (!pkg) throw fail(t('main.skills.expired', 'This preview has expired. Look the skill up again.'), 'SKILL_EXPIRED')
  const opts = { home, env, cwd }
  let targets
  if (replace) {
    const root = rootOfSkill(replace, opts)
    if (!root) throw fail(t('main.skills.unknownFolder', 'This is not a skill folder Tessel knows.'))
    targets = [{ root, dest: path.resolve(replace) }]
  } else {
    if (scope !== 'user' && scope !== 'project') throw fail(t('main.skills.badScope', 'Choose all projects or this project.'))
    if (scope === 'project' && !(typeof cwd === 'string' && path.isAbsolute(cwd)))
      throw fail(t('main.skills.noProject', 'Open a project folder to add a skill to it.'))
    const roots = targetRoots(agents.filter((a) => SKILL_AGENTS.includes(a)), scope, opts)
    if (!roots.length) throw fail(t('main.skills.chooseAgent', 'Choose at least one agent.'))
    targets = roots.map((root) => ({ root, dest: path.join(root.path, pkg.name) }))
  }
  const results = []
  const hash = contentHash(pkg.files)
  for (const { root, dest } of targets) {
    // agents: the chosen agents this folder is for (the window says which
    // agent each result is about); seenBy: every agent that reads it.
    const forAgents = replace ? [...root.installFor] : [...new Set(agents)].filter((a) => root.installFor.includes(a))
    const result = { dir: dest, seenBy: root.seenBy, scope: root.scope, agents: forAgents }
    const tmp = path.join(root.path, `.${path.basename(dest)}.tessel-${randomBytes(4).toString('hex')}`)
    const key = sameKey(dest)
    installing.add(key)
    try {
      const existing = await fs.lstat(dest).catch(() => null)
      if (existing && !replace) {
        results.push({ ...result, ok: false, exists: true, error: t('main.skills.exists', 'A skill with this name is already there.') })
        continue
      }
      if (replace && existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw linkRefused(path.basename(dest))
      if (existing && history && (await hasSkillFile(dest))) {
        // A failed snapshot stops here: the old copy is untouched.
        const snap = await history.track(dest)
        const recorded = sources ? sources.get(dest) : null
        const asInstalled = !snap.truncated && !!(recorded && recorded.hash) && snap.hash === recorded.hash
        if (!snap.saved || !(snap.complete || asInstalled))
          throw fail(
            t('main.skills.history.notKeptUpdate', 'The copy there could not be kept whole in its history (too many files, or a file too large), so it was not replaced. Remove it first to install the new one.'),
            'SKILL_HISTORY_INCOMPLETE'
          )
      }
      await fs.mkdir(root.path, { recursive: true })
      await writeTree(tmp, pkg.files)
      if (existing) {
        // The old copy goes aside, the new one in its place, and only then is
        // the old one let go: any failed step puts the old one back, so the
        // skill never loses its folder (renames are retried while antivirus
        // holds the new files for a moment). Aside, it keeps its own name in
        // a hidden folder, so the Recycle Bin shows it as itself and no agent
        // reads it as a second skill.
        const aside = path.join(root.path, `.${path.basename(dest)}.tessel-old-${randomBytes(4).toString('hex')}`)
        const old = path.join(aside, path.basename(dest))
        await fs.mkdir(aside)
        try {
          await renameRetry(dest, old)
        } catch (err) {
          await fs.rmdir(aside).catch(() => {})
          throw err
        }
        try {
          await renameRetry(tmp, dest)
        } catch (err) {
          await renameRetry(old, dest).then(() => fs.rmdir(aside)).catch(() => {})
          throw err
        }
        if (trash) {
          try {
            await trash(old)
          } catch (err) {
            // No Recycle Bin there (a network share, \\wsl$): the old copy
            // goes back as it was and the new one is dropped. Should a rename
            // fail even so, the new copy stays and the old one stays aside.
            await renameRetry(dest, tmp)
              .then(() => renameRetry(old, dest).catch((e) => renameRetry(tmp, dest).then(() => { throw e })))
              .then(() => fs.rmdir(aside))
              .catch(() => {})
            throw fail(
              t('main.skills.trashFailed', 'The folder there could not be moved to the Recycle Bin ({{error}}), so it was not replaced.', { error: (err && err.message) || String(err) }),
              'SKILL_TRASH_FAILED'
            )
          }
          result.trashed = true
        }
        await removeTree(aside).catch(() => {})
      } else await renameRetry(tmp, dest)
      if (sources) sources.set(dest, { ...pkg.source, name: pkg.name, installedAt: Date.now(), hash })
      if (history) {
        const note = { kind: existing ? 'update' : 'install', from: pkg.source && pkg.source.kind, commit: (pkg.source && pkg.source.commit) || null }
        await history.track(dest, { note }).catch(() => {})
      }
      results.push({ ...result, ok: true })
    } catch (err) {
      await removeTree(tmp).catch(() => {})
      results.push({ ...result, ok: false, error: (err && err.message) || String(err) })
    } finally {
      installing.delete(key)
    }
  }
  return { ok: results.every((r) => r.ok), name: pkg.name, results }
}

// ---------------------------------------------------------------- Remove

// Only a skill folder directly in a known root, holding a SKILL.md, never a
// link (the folder it points to is not Tessel's to remove).
export async function checkRemovable(dir, opts) {
  const root = rootOfSkill(dir, opts)
  if (!root) throw fail(t('main.skills.unknownFolder', 'This is not a skill folder Tessel knows.'))
  const st = await fs.lstat(dir).catch(() => null)
  if (!st) throw fail(t('main.skills.gone', 'This skill is no longer there.'))
  if (st.isSymbolicLink() || !st.isDirectory()) throw linkRefused(path.basename(dir))
  const md = await fs.lstat(path.join(dir, 'SKILL.md')).catch(() => null)
  if (!md || !md.isFile()) throw fail(t('main.skills.noSkillMd', 'There is no SKILL.md in this folder.'))
  return root
}

// mode 'trash' (the Recycle Bin, through `trash`) or 'delete'.
export async function removeSkill({ dir, mode = 'trash', cwd = null, home = os.homedir(), env = process.env, trash = null, sources = null } = {}) {
  await checkRemovable(dir, { home, env, cwd })
  const target = path.resolve(dir)
  if (mode === 'delete') await removeTree(target)
  else {
    if (!trash) throw fail(t('main.skills.noTrash', 'The Recycle Bin is not available.'))
    await trash(target)
  }
  if (sources) sources.remove(target)
  return { ok: true }
}

// A folder inside a known root (to open it): the skill's own or below.
export function isSkillPath(dir, opts) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false
  const target = path.resolve(dir)
  return skillRoots(opts).some((r) => inside(r.path, target))
}
