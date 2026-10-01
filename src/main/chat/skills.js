import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { createHmac, randomBytes } from 'node:crypto'
import { t } from '../i18n.js'
import { commandName } from './commands.js'

export const SKILL_LIMITS = {
  entries: 512,
  directories: 1024,
  files: 4096,
  depth: 4,
  bytes: 65536,
  line: 2048,
  time: 2000
}
// Held until the real filesystem work ends, even after its response times out.
let activeScan = null

const clean = (value) =>
  typeof value === 'string'
    ? value
        .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
        .trim()
        .slice(0, 512)
    : null
const inside = (root, file) => {
  const rel = path.relative(root, file)
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)
}

// Deliberately only the two frontmatter fields: no YAML tags or body evaluation.
export function skillFrontmatter(text, fallback) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const values = {}
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex(
      (line, i) => i > 0 && line.length <= SKILL_LIMITS.line && /^---\s*$/.test(line)
    )
    if (end < 0) return null
    for (let i = 1; i < end; i++) {
      const line = lines[i]
      if (line.length > SKILL_LIMITS.line) continue
      const colon = line.indexOf(':')
      const key = line.slice(0, colon)
      if (colon < 0 || (key !== 'name' && key !== 'description')) continue
      let value = line.slice(colon + 1).trim()
      if (/^[>|][-+]?\s*$/.test(value)) {
        const parts = []
        while (i + 1 < end && /^[ \t]/.test(lines[i + 1])) {
          const continuation = lines[++i]
          if (continuation.length <= SKILL_LIMITS.line) parts.push(continuation.trim())
        }
        value = parts.join(' ')
      } else if (value.startsWith('"')) {
        try {
          value = JSON.parse(value)
        } catch {
          continue
        }
      } else if (value.startsWith("'") && value.endsWith("'"))
        value = value.slice(1, -1).replace(/''/g, "'")
      else {
        const space = value.indexOf(' #'),
          tab = value.indexOf('\t#')
        const comment = space < 0 ? tab : tab < 0 ? space : Math.min(space, tab)
        if (value.startsWith('#')) value = ''
        else if (comment >= 0) value = value.slice(0, comment).trimEnd()
      }
      values[key] = clean(value)
    }
  }
  const name = commandName(values.name || fallback)
  return name ? { name, description: values.description || null } : null
}

// roots: [base, kind, folders, owner?] to scan instead of the chat's own
// (a terminal agent's: its account folder, Codex's); owner 'claude' unless
// given, none for the shared .agents folders.
export async function discoverClaudeSkills({
  cwd,
  projectDir,
  home = homedir(),
  roots = null,
  limits = SKILL_LIMITS,
  io = fs
}) {
  if (activeScan) {
    const error = new Error('skill scan busy') // i18n-ignore internal
    error.code = 'SKILL_SCAN_BUSY'
    throw error
  }
  const cap = { ...SKILL_LIMITS, ...limits },
    sources = [],
    skills = [],
    seen = new Set()
  for (const [base, kind, folders, owner = 'claude'] of roots || [
    [cwd, 'repo', ['.claude/skills', '.claude/commands', '.agents/skills']],
    [projectDir, 'repo', ['.claude/skills', '.claude/commands', '.agents/skills']],
    [home, 'home', ['.claude/skills', '.claude/commands', '.agents/skills']]
  ]) {
    if (!base) continue
    for (const folder of folders) {
      const root = path.resolve(base, folder)
      const key = process.platform === 'win32' ? root.toLowerCase() : root
      if (seen.has(key)) continue
      seen.add(key)
      const shared = folder.startsWith('.agents')
      sources.push({
        id: root,
        label: root,
        path: root,
        sourceKind: kind,
        providers: [shared ? 'agent-skills' : owner],
        owner: shared ? null : owner,
        exists: false,
        skippedReason: 'unavailable',
        base: path.resolve(base),
        legacy: /(^|\/)commands$/.test(folder)
      })
    }
  }
  let stopped = false,
    directories = 0,
    files = 0,
    timer
  const deadline = Date.now() + cap.time
  const active = () =>
    !stopped &&
    Date.now() < deadline &&
    skills.length < cap.entries &&
    directories < cap.directories &&
    files < cap.files
  const result = () => ({
    skills: skills.map((row) => ({ ...row })),
    sources: sources.map(({ base, legacy, canonical, ...source }) => ({ ...source })),
    scannedAt: Date.now()
  })
  async function readSkill(file, source, fallback) {
    if (!active()) {
      source.skippedReason = 'unavailable'
      return
    }
    let handle
    try {
      // Windows file ids can exceed Number's exact integer range. Preserve the
      // filesystem's bits before comparing the path with the opened handle.
      const stat = await io.lstat(file, { bigint: true })
      if (!active()) return
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1n) {
        source.skippedReason = 'unavailable'
        return
      }
      if (stat.size > cap.bytes || !inside(source.canonical, await io.realpath(file))) {
        source.skippedReason = 'unavailable'
        return
      }
      if (!active()) return
      handle = await io.open(
        file,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW || 0) |
          (process.platform === 'win32' ? 0 : constants.O_NONBLOCK || 0)
      )
      const opened = await handle.stat({ bigint: true })
      if (
        !opened.isFile() ||
        opened.size > cap.bytes ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino ||
        opened.nlink > 1n ||
        !active()
      ) {
        source.skippedReason = 'unavailable'
        return
      }
      const buffer = Buffer.alloc(cap.bytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (
        !active() ||
        bytesRead > cap.bytes ||
        !inside(source.canonical, await io.realpath(file))
      ) {
        source.skippedReason = 'unavailable'
        return
      }
      const meta = skillFrontmatter(buffer.subarray(0, bytesRead).toString('utf8'), fallback)
      if (!meta) return
      skills.push({
        id: file,
        ...meta,
        providers: [...source.providers],
        sourceKind: source.sourceKind,
        sourceLabel: source.label,
        rootPath: source.path,
        directoryPath: path.dirname(file),
        skillFilePath: file,
        installed: true,
        // Only display metadata becomes a Number; identity stays bigint.
        updatedAt: Number.isFinite(Number(opened.mtimeMs)) ? Number(opened.mtimeMs) : null
      })
    } catch (error) {
      if (error.code !== 'ENOENT') source.skippedReason = 'unavailable'
    } finally {
      await handle?.close().catch(() => {})
    }
  }
  async function visit(dir, source, depth) {
    if (!active()) {
      source.skippedReason = 'unavailable'
      return
    }
    directories++
    let entries
    try {
      const stat = await io.lstat(dir)
      if (!active()) return
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !inside(source.canonical, await io.realpath(dir))
      ) {
        source.skippedReason = 'unavailable'
        return
      }
      if (!active()) return
      entries = await io.opendir(dir)
      if (!active()) {
        await entries.close()
        return
      }
      for await (const entry of entries) {
        files++
        if (!active()) {
          source.skippedReason = 'unavailable'
          break
        }
        if (entry.isSymbolicLink()) {
          source.skippedReason = 'unavailable'
          continue
        }
        const file = path.join(dir, entry.name)
        if (
          entry.isFile() &&
          (entry.name === 'SKILL.md' || (source.legacy && entry.name.endsWith('.md')))
        )
          await readSkill(
            file,
            source,
            source.legacy ? path.basename(file, '.md') : path.basename(dir)
          )
        else if (entry.isDirectory()) {
          if (depth < cap.depth) await visit(file, source, depth + 1)
          else source.skippedReason = 'unavailable'
        }
      }
    } catch {
      source.skippedReason = 'unavailable'
    }
  }
  async function scan() {
    for (const source of sources) {
      if (!active()) break
      try {
        // Check every root component: a junction at .claude must not escape.
        let current = source.base
        const base = await io.realpath(current)
        if (!active()) break
        for (const part of path.relative(source.base, source.path).split(path.sep)) {
          if (!active()) break
          current = path.join(current, part)
          const stat = await io.lstat(current)
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('linked root') // i18n-ignore internal
        }
        if (!active()) break
        source.canonical = await io.realpath(source.path)
        if (!inside(base, source.canonical)) throw new Error('outside root') // i18n-ignore internal
        source.exists = true
        delete source.skippedReason
        await visit(source.path, source, 0)
      } catch (error) {
        source.skippedReason = error.code === 'ENOENT' ? 'missing' : 'unavailable'
      }
      delete source.canonical
    }
  }
  const work = Promise.resolve().then(scan)
  activeScan = work
  const release = () => {
    if (activeScan === work) activeScan = null
  }
  work.then(release, release)
  await Promise.race([
    work,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        stopped = true
        resolve()
      }, cap.time)
    })
  ])
  stopped = true
  clearTimeout(timer)
  return result()
}

// App-server supplies metadata; no provider path is opened or executed here.
export function codexSkillDiscovery(response, cwd, now = Date.now) {
  const skills = [],
    sources = new Map(),
    files = new Set()
  for (const entry of Array.isArray(response?.data) ? response.data.slice(0, 512) : []) {
    if (entry?.cwd !== cwd) continue
    for (const value of Array.isArray(entry.skills) ? entry.skills.slice(0, 512) : []) {
      const name = commandName(value?.name),
        file = value?.path
      if (
        !name ||
        value.enabled !== true ||
        typeof file !== 'string' ||
        file.length > 4096 ||
        /[\p{Cc}\p{Cf}]/u.test(file) ||
        files.has(file)
      )
        continue
      const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(file) ? path.win32 : path.posix
      if (!paths.isAbsolute(file)) continue
      const directoryPath = paths.dirname(file),
        rootPath = paths.dirname(directoryPath)
      const sourceKind =
        value.scope === 'repo' ? 'repo' : value.scope === 'user' ? 'home' : 'bundled'
      const source = {
        id: rootPath,
        label: rootPath,
        path: rootPath,
        sourceKind,
        providers: ['codex'],
        owner: 'codex',
        exists: true
      }
      sources.set(rootPath, source)
      files.add(file)
      skills.push({
        id: file,
        name,
        description: clean(
          value.interface?.shortDescription || value.shortDescription || value.description
        ),
        providers: ['codex'],
        sourceKind,
        sourceLabel: source.label,
        rootPath,
        directoryPath,
        skillFilePath: file,
        installed: true,
        updatedAt: null
      })
      if (skills.length >= SKILL_LIMITS.entries) break
    }
    if (skills.length >= SKILL_LIMITS.entries) break
  }
  return { skills, sources: [...sources.values()], scannedAt: now() }
}

// OpenCode's GET /skill: { name, description, location (its SKILL.md),
// content }. The content (the skill's body) is never kept. Provider paths are
// metadata only, never opened by Tessel. A skill inside the chat's folder is
// the project's; inside home, the user's; anything else is OpenCode's own.
export function opencodeSkillDiscovery(list, cwd, now = Date.now, home = homedir()) {
  const skills = [],
    sources = new Map(),
    files = new Set()
  for (const value of Array.isArray(list) ? list.slice(0, 512) : []) {
    const name = commandName(value?.name),
      file = value?.location
    if (!name || typeof file !== 'string' || file.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(file) || files.has(file)) continue
    const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(file) ? path.win32 : path.posix
    if (!paths.isAbsolute(file)) continue
    const directoryPath = paths.dirname(file),
      rootPath = paths.dirname(directoryPath)
    const within = (root) => {
      if (typeof root !== 'string' || !root) return false
      const rel = paths.relative(root, file)
      return !!rel && !paths.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..')
    }
    const sourceKind = within(cwd) ? 'repo' : within(home) ? 'home' : 'bundled'
    sources.set(rootPath, { id: rootPath, label: rootPath, path: rootPath, sourceKind, providers: ['opencode'], owner: 'opencode', exists: true })
    files.add(file)
    skills.push({
      id: file,
      name,
      description: clean(value.description),
      providers: ['opencode'],
      sourceKind,
      sourceLabel: rootPath,
      rootPath,
      directoryPath,
      skillFilePath: file,
      installed: true,
      updatedAt: null
    })
    if (skills.length >= SKILL_LIMITS.entries) break
  }
  return { skills, sources: [...sources.values()], scannedAt: now() }
}

// Main-process cache filtering: no new disk access is needed after revocation.
export function withoutProjectSkills(result, projectDir, cwd) {
  const scoped = (value) =>
    typeof value === 'string' &&
    path.isAbsolute(value) &&
    inside(projectDir, value) &&
    !inside(cwd, value)
  const sources = result.sources.filter((source) => !scoped(source.path))
  const skills = result.skills.flatMap((skill) => {
    const roots = (skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]).filter(
      (root) => !scoped(root)
    )
    if (!roots.length || scoped(skill.directoryPath) || scoped(skill.skillFilePath)) return []
    return [{ ...skill, rootPath: roots[0], ...(skill.rootPaths ? { rootPaths: roots } : {}) }]
  })
  return { ...result, skills, sources }
}

// Opaque references are stable for this main-process lifetime, including refreshes.
// The menu uses equality/deduplication only; these are never filesystem handles.
const referenceKey = randomBytes(32)
const pathsFor = (value) => (/^[A-Za-z]:[\\/]|^\\\\/.test(value) ? path.win32 : path.posix)
function reference(kind, value) {
  const paths = pathsFor(value)
  const normalized = paths.normalize(String(value))
  const canonical = paths === path.win32 ? normalized.toLowerCase() : normalized
  return kind + '-' + createHmac('sha256', referenceKey).update(canonical).digest('hex')
}
function sourceLabel(kind) {
  if (kind === 'home') return t('main.chat.skillsSourceHome', 'User skills')
  if (kind === 'bundled') return t('main.chat.skillsSourceBundled', 'Built-in skills')
  if (kind === 'plugin') return t('main.chat.skillsSourcePlugin', 'Plugin skills')
  return t('main.chat.skillsSourceRepo', 'Project skills')
}
export function publicSkillDiscovery(result) {
  const providers = (values) =>
    (values || []).filter((value) => ['claude', 'codex', 'opencode', 'agent-skills'].includes(value))
  const sources = result.sources.map((source) => ({
    id: reference('source', source.path),
    path: reference('source', source.path),
    label: sourceLabel(source.sourceKind),
    sourceKind: source.sourceKind,
    providers: providers(source.providers),
    owner: source.owner,
    exists: source.exists === true,
    ...(['missing', 'unavailable', 'remote-repo'].includes(source.skippedReason)
      ? { skippedReason: source.skippedReason }
      : {})
  }))
  const skills = result.skills.map((skill) => ({
    id: reference('skill', skill.skillFilePath),
    name: skill.name,
    description: clean(skill.description),
    providers: providers(skill.providers),
    sourceKind: skill.sourceKind,
    sourceLabel: sourceLabel(skill.sourceKind),
    rootPath: reference('source', skill.rootPath),
    ...(skill.rootPaths
      ? { rootPaths: skill.rootPaths.map((root) => reference('source', root)) }
      : {}),
    directoryPath:
      reference('directory', skill.directoryPath) +
      '/' +
      clean(pathsFor(skill.directoryPath).basename(skill.directoryPath)),
    skillFilePath: reference('skill', skill.skillFilePath),
    installed: skill.installed === true,
    updatedAt: Number.isFinite(skill.updatedAt) ? skill.updatedAt : null
  }))
  return { skills, sources, scannedAt: result.scannedAt }
}
