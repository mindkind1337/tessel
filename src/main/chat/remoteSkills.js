// Claude Code's skills on an SSH host, for a chat there (its "/" menu) and
// for the chat view over a terminal agent there: the host's
// ~/.claude/skills and the project's .claude/skills, listed over the shared
// connection (remoteFs.js listAgentSkills: SKILL.md paths and their first
// 8 KB, read-only, bounded). Only their frontmatter's name and description
// are kept (skills.js skillFrontmatter), in the shape the local discovery
// gives (discoverClaudeSkills), so publicSkillDiscovery turns the host's
// paths into opaque references as for local ones. No path here is ever
// opened on this PC. Codex's skills there the same way (agent 'codex': its
// $CODEX_HOME/skills, ~/.agents/skills, the project's .agents/skills and
// .codex/skills, as terminalSkills.js terminalSkillRoots looks locally).
import { skillFrontmatter, SKILL_LIMITS } from './skills.js'

const HOST_ID = /^ssh-[\w-]{1,60}$/
const CACHE_MS = 30 * 1000

// The folder a SKILL.md belongs to: <...>/.claude/skills.
function skillRootOf(file) {
  const i = file.lastIndexOf('/.claude/skills/')
  return i < 0 ? null : file.slice(0, i + '/.claude/skills'.length)
}

// files: listAgentSkills' [{ kind, path, text, root? }] -> { skills, sources, scannedAt }
// agent 'codex': each file names its skills folder (root); the shared
// .agents/skills folders belong to no one agent (as skills.js marks them).
export function remoteSkillDiscovery(files, now = Date.now, agent = 'claude') {
  const skills = []
  const sources = new Map()
  const names = new Set()
  for (const f of Array.isArray(files) ? files : []) {
    if (skills.length >= SKILL_LIMITS.entries) break
    if (!f || typeof f.path !== 'string' || typeof f.text !== 'string' || (f.kind !== 'home' && f.kind !== 'repo')) continue
    const rootPath = agent === 'codex' ? (typeof f.root === 'string' && f.path.startsWith(f.root + '/') ? f.root : null) : skillRootOf(f.path)
    if (!rootPath) continue
    const shared = agent === 'codex' && rootPath.endsWith('/.agents/skills')
    const providers = [shared ? 'agent-skills' : agent]
    const owner = shared ? null : agent
    const directoryPath = f.path.slice(0, f.path.lastIndexOf('/'))
    const fallback = directoryPath.slice(directoryPath.lastIndexOf('/') + 1)
    const meta = skillFrontmatter(f.text.slice(0, SKILL_LIMITS.bytes), fallback)
    if (!meta) continue
    if (!sources.has(rootPath)) sources.set(rootPath, { id: rootPath, label: rootPath, path: rootPath, sourceKind: f.kind, providers, owner, exists: true })
    // One row per name: the project's skill wins (listed after the user's).
    if (names.has(meta.name)) {
      if (f.kind !== 'repo') continue
      const at = skills.findIndex((s) => s.name === meta.name)
      if (at >= 0) skills.splice(at, 1)
    }
    names.add(meta.name)
    skills.push({
      id: f.path,
      ...meta,
      providers,
      sourceKind: f.kind,
      sourceLabel: rootPath,
      rootPath,
      directoryPath,
      skillFilePath: f.path,
      installed: true,
      updatedAt: null
    })
  }
  return { skills, sources: [...sources.values()], scannedAt: now() }
}

// listSkills(hostId, { project, agent }) -> listAgentSkills' answer.
// skills({ hostId, project, refresh, agent }) -> { ok: true, result } | { ok: false, notConnected? }
// agent: 'claude' (default) or 'codex'. One listing at a time per host,
// project and agent, kept CACHE_MS.
export function createRemoteSkills({ listSkills, now = Date.now } = {}) {
  const cache = new Map() // key -> { at, value }
  const running = new Map() // key -> promise
  async function skills({ hostId, project = null, refresh = false, agent = 'claude' } = {}) {
    if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || typeof listSkills !== 'function') return { ok: false }
    if (agent !== 'claude' && agent !== 'codex') return { ok: false }
    const key = `${agent}\n${hostId}\n${project || ''}`
    const hit = cache.get(key)
    if (!refresh && hit && now() - hit.at < CACHE_MS) return hit.value
    if (running.has(key)) return running.get(key)
    const job = (async () => {
      let r
      try {
        r = await listSkills(hostId, agent === 'codex' ? { project, agent } : { project })
      } catch {
        r = null
      }
      if (!r || !r.ok) return { ok: false, ...(r && r.notConnected ? { notConnected: true } : {}) }
      const value = { ok: true, result: remoteSkillDiscovery(r.files, now, agent) }
      cache.set(key, { at: now(), value })
      if (cache.size > 32) cache.delete(cache.keys().next().value)
      return value
    })()
    running.set(key, job)
    try {
      return await job
    } finally {
      running.delete(key)
    }
  }
  return { skills }
}
