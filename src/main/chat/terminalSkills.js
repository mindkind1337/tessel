// The skills a terminal agent's chat view lists in its "/" menu (Claude Code,
// OpenClaude: /skill-name; Codex: $skill-name), found by the chat's own
// discovery (skills.js: SKILL.md frontmatter only, bounded, no link followed)
// in the folders that agent reads: the project it works in (its session
// file's "cwd", never a folder the window names), the user's, and the pane's
// account folder (Claude Code's CLAUDE_CONFIG_DIR, Codex's CODEX_HOME).
// The window gets only names, descriptions and opaque references
// (publicSkillDiscovery), as the chat pane does.
import os from 'os'
import path from 'path'
import { discoverClaudeSkills, publicSkillDiscovery } from './skills.js'
import { t } from '../i18n.js'

export const TERMINAL_SKILL_AGENTS = ['claude', 'openclaude', 'codex']
const ACCOUNT_ID = /^[\w.-]{1,80}$/
const VIEW_ID = /^tv-\d{1,9}$/
const CACHE_MS = 30 * 1000
const BUSY_RETRIES = 3
const BUSY_WAIT_MS = 300

const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

// The folders to scan: [base, kind, folders, owner?] (skills.js roots).
export function terminalSkillRoots(agent, { cwd = null, home = os.homedir(), accountDir = null } = {}) {
  const roots = []
  if (agent === 'codex') {
    if (cwd) roots.push([cwd, 'repo', ['.agents/skills', '.codex/skills'], 'codex'])
    const codexHome = accountDir || path.join(home, '.codex')
    roots.push([codexHome, 'home', ['skills'], 'codex'])
    roots.push([home, 'home', ['.agents/skills']])
    return roots
  }
  if (cwd) roots.push([cwd, 'repo', ['.claude/skills', '.claude/commands', '.agents/skills']])
  roots.push([home, 'home', ['.claude/skills', '.claude/commands', '.agents/skills']])
  // Another account's own folder (its CLAUDE_CONFIG_DIR) has its skills at its root.
  if (agent === 'claude' && accountDir && !same(accountDir, path.join(home, '.claude'))) roots.push([accountDir, 'home', ['skills', 'commands']])
  return roots
}

// views: the transcript views (cwdOf, agentOf); homes(agent, accountId) -> the
// pane's account folder (or null).
// remoteSkills: chat/remoteSkills.js's skills({ hostId, project, refresh }),
// for a view of Claude Code on an SSH host (its skills are listed there).
export function createTerminalSkills({ views, homes = async () => null, discover = discoverClaudeSkills, remoteSkills = null, home = os.homedir(), now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const cache = new Map() // key -> { at, value }
  const unavailable = () => ({ ok: false, error: t('main.chat.skillsUnavailable', 'Skill discovery is unavailable.') })

  async function skills(q) {
    const o = q && typeof q === 'object' && !Array.isArray(q) ? q : {}
    const { agent } = o
    if (!TERMINAL_SKILL_AGENTS.includes(agent)) return unavailable()
    // A view of an agent on an SSH host: never this PC's folders. Claude
    // Code's skills there (the user's, its project's), over the connection.
    const viewOf = typeof o.viewId === 'string' && VIEW_ID.test(o.viewId) && views && views.agentOf(o.viewId) === agent ? o.viewId : null
    const hostId = viewOf && typeof views.hostOf === 'function' ? views.hostOf(viewOf) : null
    if (hostId) {
      if (agent !== 'claude' || !remoteSkills) return unavailable()
      try {
        const r = await remoteSkills({ hostId, project: typeof views.remoteCwdOf === 'function' ? views.remoteCwdOf(viewOf) : null, refresh: o.refresh === true })
        return r && r.ok ? { ok: true, result: publicSkillDiscovery(r.result) } : unavailable()
      } catch {
        return unavailable()
      }
    }
    const accountId = o.accountId === null || (typeof o.accountId === 'string' && ACCOUNT_ID.test(o.accountId)) ? o.accountId : undefined
    // The project's skills only from a view of this agent (its file's cwd).
    const viewId = typeof o.viewId === 'string' && VIEW_ID.test(o.viewId) ? o.viewId : null
    const cwd = viewId && views && views.agentOf(viewId) === agent ? views.cwdOf(viewId) : null
    let accountDir = null
    if (agent === 'claude' || agent === 'codex') {
      try {
        accountDir = (await homes(agent, accountId)) || null
      } catch {
        accountDir = null
      }
    }
    // accountDir: the account's config folder (Claude Code's, holding its
    // projects/; Codex's CODEX_HOME, holding its sessions/).
    const roots = terminalSkillRoots(agent, { cwd, home, accountDir })
    const key = JSON.stringify(roots)
    const hit = cache.get(key)
    if (!o.refresh && hit && now() - hit.at < CACHE_MS) return hit.value
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await discover({ cwd: cwd || undefined, home, roots })
        const value = { ok: true, result: publicSkillDiscovery(result) }
        cache.set(key, { at: now(), value })
        if (cache.size > 32) cache.delete(cache.keys().next().value)
        return value
      } catch (error) {
        // The chat's scan runs: once it ends.
        if (error && error.code === 'SKILL_SCAN_BUSY' && attempt < BUSY_RETRIES) {
          await wait(BUSY_WAIT_MS)
          continue
        }
        return unavailable()
      }
    }
  }
  function register(ipcMain) {
    ipcMain.handle('transcriptView:skills', (_e, q) => skills(q))
  }
  return { skills, register }
}
