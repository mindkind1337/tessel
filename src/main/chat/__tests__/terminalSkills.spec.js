// @vitest-environment node
// The skills a terminal agent's chat view lists: synthetic folders only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createTerminalSkills, terminalSkillRoots } from '../terminalSkills.js'
import { discoverClaudeSkills } from '../skills.js'

let temp, cwd, home
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tessel-tskills-'))
  cwd = path.join(temp, 'project')
  home = path.join(temp, 'home')
  await fs.mkdir(cwd)
  await fs.mkdir(home)
})
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true })
})
async function skill(dir, name, description = 'Does a thing') {
  await fs.mkdir(path.join(dir, name), { recursive: true })
  await fs.writeFile(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBODY NEVER READ`)
}
const views = (map) => ({ cwdOf: (id) => (map[id] ? map[id].cwd : null), agentOf: (id) => (map[id] ? map[id].agent : null) })

describe('terminal agent skills', () => {
  it('the folders each agent reads (an account folder of its own at its root)', () => {
    expect(terminalSkillRoots('claude', { cwd, home })).toEqual([
      [cwd, 'repo', ['.claude/skills', '.claude/commands', '.agents/skills']],
      [home, 'home', ['.claude/skills', '.claude/commands', '.agents/skills']]
    ])
    const account = path.join(temp, 'acct')
    expect(terminalSkillRoots('claude', { home, accountDir: account }).at(-1)).toEqual([account, 'home', ['skills', 'commands']])
    // The default account's folder is the user's own (not twice).
    expect(terminalSkillRoots('claude', { home, accountDir: path.join(home, '.claude') })).toHaveLength(1)
    expect(terminalSkillRoots('codex', { cwd, home, accountDir: account })).toEqual([
      [cwd, 'repo', ['.agents/skills', '.codex/skills'], 'codex'],
      [account, 'home', ['skills'], 'codex'],
      [home, 'home', ['.agents/skills']]
    ])
  })

  it("Claude Code: its project's (by its own view only), the user's and its account's skills, names and descriptions only", async () => {
    await skill(path.join(cwd, '.claude', 'skills'), 'deploy')
    await skill(path.join(home, '.claude', 'skills'), 'review')
    const account = path.join(temp, 'acct')
    await skill(path.join(account, 'skills'), 'acct-only')
    const homes = vi.fn(async () => account)
    const s = createTerminalSkills({ views: views({ 'tv-1': { agent: 'claude', cwd }, 'tv-2': { agent: 'codex', cwd } }), homes, home })
    const res = await s.skills({ agent: 'claude', accountId: 'work', viewId: 'tv-1' })
    expect(res.ok).toBe(true)
    expect(res.result.skills.map((k) => k.name).sort()).toEqual(['acct-only', 'deploy', 'review'])
    expect(homes).toHaveBeenCalledWith('claude', 'work')
    // Opaque references only: no path, no body.
    const text = JSON.stringify(res.result)
    expect(text).not.toContain(temp)
    expect(text).not.toContain('BODY NEVER READ')
    // Another agent's view: not its project.
    const other = await s.skills({ agent: 'claude', viewId: 'tv-2', refresh: true })
    expect(other.result.skills.map((k) => k.name).sort()).toEqual(['acct-only', 'review'])
    // No view: the user's and the account's only.
    const none = await s.skills({ agent: 'claude' })
    expect(none.result.skills.map((k) => k.name)).not.toContain('deploy')
  })

  it('Codex: its CODEX_HOME skills and the shared ones, owned by codex', async () => {
    const codexHome = path.join(temp, 'codex')
    await skill(path.join(codexHome, 'skills'), 'gen-tests')
    await skill(path.join(cwd, '.agents', 'skills'), 'shared-one')
    await skill(path.join(home, '.claude', 'skills'), 'claude-only')
    const s = createTerminalSkills({ views: views({ 'tv-3': { agent: 'codex', cwd } }), homes: async () => codexHome, home })
    const res = await s.skills({ agent: 'codex', viewId: 'tv-3' })
    expect(res.result.skills.map((k) => k.name).sort()).toEqual(['gen-tests', 'shared-one'])
    const owners = res.result.sources.filter((src) => src.exists).map((src) => src.owner)
    expect(owners).toContain('codex')
    expect(owners).toContain(null)
  })

  it('refuses another agent or a bad id, caches for a while, waits for a scan already running', async () => {
    const discover = vi.fn(async () => ({ skills: [], sources: [], scannedAt: 1 }))
    let t = 0
    const s = createTerminalSkills({ views: views({}), discover, home, now: () => t, wait: async () => {} })
    expect((await s.skills({ agent: 'grok' })).ok).toBe(false)
    expect((await s.skills(null)).ok).toBe(false)
    await s.skills({ agent: 'claude', accountId: '../x', viewId: '../../etc' })
    expect(discover.mock.calls[0][0].cwd).toBeUndefined()
    await s.skills({ agent: 'claude' })
    expect(discover).toHaveBeenCalledTimes(1)
    t = 31000
    await s.skills({ agent: 'claude' })
    expect(discover).toHaveBeenCalledTimes(2)
    const busy = Object.assign(new Error('busy'), { code: 'SKILL_SCAN_BUSY' })
    discover.mockRejectedValueOnce(busy)
    expect((await s.skills({ agent: 'claude', refresh: true })).ok).toBe(true)
    discover.mockRejectedValue(new Error('boom'))
    expect((await s.skills({ agent: 'claude', refresh: true })).ok).toBe(false)
  })

  it('the shared discovery takes other roots (an owner of their own)', async () => {
    await skill(path.join(temp, 'r', 'skills'), 'x-skill')
    const res = await discoverClaudeSkills({ roots: [[path.join(temp, 'r'), 'home', ['skills'], 'codex']] })
    expect(res.skills.map((k) => [k.name, k.providers])).toEqual([['x-skill', ['codex']]])
    expect(res.sources[0]).toMatchObject({ owner: 'codex', exists: true })
  })
})
