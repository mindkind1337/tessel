import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { commandName } from './commands.js'

export const SKILL_LIMITS = {
  entries: 512,
  directories: 1024,
  files: 4096,
  depth: 4,
  bytes: 65536,
  time: 2000
}
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
    const end = lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line))
    if (end < 0) return null
    for (let i = 1; i < end; i++) {
      const match = /^(name|description):\s*(.*?)\s*$/.exec(lines[i])
      if (!match) continue
      let value = match[2]
      if (/^[>|][-+]?\s*$/.test(value)) {
        const parts = []
        while (i + 1 < end && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim())
        value = parts.join(' ')
      } else if (value.startsWith('"')) {
        try {
          value = JSON.parse(value)
        } catch {
          continue
        }
      } else if (value.startsWith("'") && value.endsWith("'"))
        value = value.slice(1, -1).replace(/''/g, "'")
      else value = value.replace(/\s+#.*$/, '')
      values[match[1]] = clean(value)
    }
  }
  const name = commandName(values.name || fallback)
  return name ? { name, description: values.description || null } : null
}

export async function discoverClaudeSkills({
  cwd,
  projectDir,
  home = homedir(),
  limits = SKILL_LIMITS,
  io = fs
}) {
  const cap = { ...SKILL_LIMITS, ...limits },
    sources = [],
    skills = [],
    seen = new Set()
  for (const [base, kind, folders] of [
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
        providers: [shared ? 'agent-skills' : 'claude'],
        owner: shared ? null : 'claude',
        exists: false,
        skippedReason: 'unavailable',
        base: path.resolve(base),
        legacy: folder.endsWith('/commands')
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
      const stat = await io.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        source.skippedReason = 'unavailable'
        return
      }
      if (stat.size > cap.bytes || !inside(source.canonical, await io.realpath(file))) {
        source.skippedReason = 'unavailable'
        return
      }
      if (!active()) return
      handle = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size > cap.bytes || !active()) return
      const buffer = Buffer.alloc(cap.bytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (
        bytesRead > cap.bytes ||
        !inside(source.canonical, await io.realpath(file)) ||
        !active()
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
        updatedAt: Number.isFinite(opened.mtimeMs) ? opened.mtimeMs : null
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
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !inside(source.canonical, await io.realpath(dir))
      ) {
        source.skippedReason = 'unavailable'
        return
      }
      entries = await io.opendir(dir)
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
        for (const part of path.relative(source.base, source.path).split(path.sep)) {
          current = path.join(current, part)
          const stat = await io.lstat(current)
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('linked root') // i18n-ignore internal
        }
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
  await Promise.race([
    scan(),
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
