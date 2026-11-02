// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createContextCost, summarize, shapeTools, skillLine, agentServers, MCP_RECORD_MAX_AGE_MS } from '../contextCost'
import { createContextCounter, createCountCache } from '../contextCost/counts'

let root, home, project, userData
beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-ctxsvc-'))
  home = join(root, 'home')
  project = join(root, 'app')
  userData = join(root, 'data')
  for (const d of [home, join(project, '.git'), userData]) fs.mkdirSync(d, { recursive: true })
  fs.mkdirSync(join(home, '.claude'), { recursive: true })
  fs.writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'one two three four')
  fs.mkdirSync(join(home, '.codex'), { recursive: true })
  fs.writeFileSync(join(home, '.codex', 'AGENTS.md'), 'codex rules here')
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

// One token per word; the team tools as the counting process answers them.
const worker = {
  async request(msg) {
    const words = (s) => (String(s).trim() ? String(s).trim().split(/\s+/).length : 0)
    if (msg.op === 'encoding') return { counts: msg.texts.map(words) }
    if (msg.op === 'tessel') return { tessel: { instructions: 'Use the board.', tools: [{ name: 'team_inbox', description: 'Inbox.', inputSchema: { type: 'object', properties: {} } }] } }
    return null
  }
}
const skillsIn = (home) => [
  { name: 'pdf', description: 'Read PDF files', skillFile: join(home, '.claude', 'skills', 'pdf', 'SKILL.md'), seenBy: ['claude', 'opencode'], scope: 'user' },
  { name: 'lint', description: 'Lint the code base', skillFile: join(home, '.agents', 'skills', 'lint', 'SKILL.md'), seenBy: ['codex'], scope: 'user' }
]
const mcpListed = {
  claude: [{ name: 'fs', scope: 'user', target: 'npx fs' }, { name: 'tessel_team', scope: 'user' }],
  codex: [{ name: 'browser', scope: 'user', enabled: false }, { name: 'tessel_team', scope: 'user' }],
  others: {}
}

function service(extra = {}) {
  const anthropic = { count: vi.fn(async (model, items) => Object.fromEntries(items.map((i) => [i.key, { tokens: 100 }]))) }
  const testMcp = vi.fn(async () => ({ ok: true, status: 'connected', defs: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }] }))
  const listMcp = vi.fn(async () => mcpListed)
  const counter = createContextCounter({ cache: createCountCache(join(userData, 'counts.json')), worker, apis: { anthropic } })
  const svc = createContextCost({
    userData,
    counter,
    worker,
    files: { status: async () => ({}), loaderFor: async () => null },
    apis: { anthropic },
    listSkills: async () => ({ skills: skillsIn(home) }),
    listMcp,
    testMcp,
    agentModel: () => null,
    home,
    env: () => ({}),
    ...extra
  })
  return { svc, anthropic, testMcp, listMcp }
}

describe('summarize: one agent’s totals', () => {
  it('adds loaded, counted items by group, says how exact it is and what is optional', () => {
    const items = [
      { group: 'rules', loaded: true, optional: true, result: { tokens: 100, exact: true } },
      { group: 'skills', loaded: true, optional: true, result: { tokens: 20, exact: false } },
      { group: 'mcp', loaded: false, result: { tokens: 999, exact: true } }, // turned off
      { group: 'mcp', loaded: true, result: null }, // not measured
      { group: 'tessel', loaded: true, optional: false, result: { tokens: 50, exact: true } }
    ]
    expect(summarize(items)).toEqual({ total: 170, groups: { rules: 100, skills: 20, mcp: 0, tessel: 50 }, optional: 120, pending: 1, exact: 'some' })
    expect(summarize([]).exact).toBe('none')
    expect(summarize([items[0]]).exact).toBe('all')
  })
})

describe('the Context summary', () => {
  it('lists rules, skills, MCP and Tessel per agent, counted with each model, never with the text', async () => {
    const { svc, anthropic } = service()
    const res = await svc.summary({ cwd: project, agents: [{ id: 'claude' }, { id: 'codex' }, { id: 'unknown' }] })
    expect(res.agents.map((a) => a.id)).toEqual(['claude', 'codex'])
    const [claude, codex] = res.agents
    expect(claude.counter).toMatchObject({ kind: 'api', api: 'anthropic', defaulted: true })
    expect(codex.counter).toMatchObject({ kind: 'local', tokenizer: 'o200k_base' })
    // Without remote: no count API asked, Claude's counts are estimates.
    expect(anthropic.count).not.toHaveBeenCalled()
    const groupsOf = (a) => a.items.map((i) => `${i.group}:${i.label}`)
    expect(groupsOf(claude)).toEqual(expect.arrayContaining(['rules:CLAUDE.md', 'skills:pdf', 'mcp:fs', 'tessel:tessel_team']))
    expect(groupsOf(codex)).toEqual(expect.arrayContaining(['rules:AGENTS.md', 'skills:lint', 'mcp:browser']))
    expect(groupsOf(claude)).not.toContain('skills:lint')
    expect(codex.items.find((i) => i.label === 'browser')).toMatchObject({ loaded: false, note: 'off' })
    expect(claude.items.find((i) => i.label === 'fs')).toMatchObject({ loaded: true, note: 'notMeasured', result: null })
    expect(codex.items.find((i) => i.label === 'AGENTS.md').result).toMatchObject({ tokens: 3, exact: true })
    expect(codex.summary.exact).toBe('all')
    expect(claude.summary.exact).toBe('none')
    expect(claude.summary.pending).toBe(1) // fs, not measured
    for (const a of res.agents) for (const i of a.items) expect(i.text).toBeUndefined()
    expect(JSON.stringify(res)).not.toContain('one two three four')
  })

  it('asks the count API when the page is looked at (remote)', async () => {
    const { svc, anthropic } = service()
    const res = await svc.summary({ cwd: project, agents: [{ id: 'claude', model: 'claude-sonnet-5-5' }], remote: true })
    expect(anthropic.count).toHaveBeenCalled()
    expect(anthropic.count.mock.calls[0][0]).toBe('claude-sonnet-5-5')
    expect(res.agents[0].summary.exact).toBe('all')
  })
})

describe('MCP Measure: the server starts on the click only', () => {
  it('never starts a server for the summary or the kept counts; Measure does, and its count is kept', async () => {
    const { svc, testMcp, listMcp } = service()
    await svc.summary({ cwd: project, agents: [{ id: 'claude' }, { id: 'codex' }], remote: true })
    expect(await svc.mcpMeasures({ cwd: project, servers: [{ agent: 'claude', scope: 'user', name: 'fs' }] })).toEqual({})
    expect(testMcp).not.toHaveBeenCalled()
    const measured = await svc.measureMcp({ agent: 'claude', name: 'fs', scope: 'user', cwd: project })
    expect(testMcp).toHaveBeenCalledTimes(1)
    expect(testMcp.mock.calls[0]).toEqual([{ agent: 'claude', name: 'fs', scope: 'user', cwd: project }, { defs: true }])
    expect(measured).toMatchObject({ ok: true, tools: 1, result: { exact: true, source: 'api', tokens: 100 } })
    const listCalls = listMcp.mock.calls.length
    const kept = await svc.mcpMeasures({ cwd: project, servers: [{ agent: 'claude', scope: 'user', name: 'fs' }] })
    expect(kept['claude:user:fs']).toMatchObject({ tools: 1, result: { tokens: 100 } })
    expect(listMcp.mock.calls.length).toBe(listCalls) // read only: no server list read again
    const again = await svc.summary({ cwd: project, agents: [{ id: 'claude' }] })
    expect(again.agents[0].items.find((i) => i.label === 'fs')).toMatchObject({ toolCount: 1, result: { tokens: 100, exact: true } })
    expect(testMcp).toHaveBeenCalledTimes(1)
  })

  it('refuses a server the agent does not have, and says why a server could not be measured', async () => {
    const { svc, testMcp } = service()
    expect((await svc.measureMcp({ agent: 'claude', name: 'nope', cwd: project })).ok).toBe(false)
    expect(testMcp).not.toHaveBeenCalled()
    testMcp.mockResolvedValueOnce({ ok: false, status: 'error', error: 'Command not found: npx' })
    expect(await svc.measureMcp({ agent: 'claude', name: 'fs', cwd: project })).toMatchObject({ ok: false, error: 'Command not found: npx' })
  })
})

describe('helpers', () => {
  it('names MCP tools as each agent presents them, within API limits', () => {
    const defs = [{ name: 'read file', description: 'd', inputSchema: { properties: {} } }, { name: 'read file' }]
    const forClaude = shapeTools('fs', defs, 'claude')
    expect(forClaude[0]).toEqual({ name: 'mcp__fs__read_file', description: 'd', input_schema: { type: 'object', properties: {} } })
    expect(forClaude[1].name).not.toBe(forClaude[0].name)
    expect(shapeTools('fs', defs, 'codex')[0].name).toBe('read_file')
    expect(shapeTools('x'.repeat(80), [{ name: 't' }], 'claude')[0].name).toHaveLength(64)
    expect(skillLine({ name: 'pdf', description: 'Read PDFs' })).toBe('- pdf: Read PDFs')
    expect(agentServers({ others: { gemini: { servers: [{ name: 'a' }] } } }, 'gemini')).toEqual([{ name: 'a' }])
  })
})

describe('project MCP servers: started only once approved, or after a confirmation', () => {
  const withProject = (extra = {}) => {
    const listed = { claude: [{ name: 'evil', scope: 'project', target: 'npx evil-mcp' }], codex: [], others: {} }
    return service({ listMcp: vi.fn(async () => listed), ...extra })
  }

  it('lists an unapproved one as not counted; Measure asks first, showing its command', async () => {
    const { svc, testMcp } = withProject()
    const res = await svc.summary({ cwd: project, agents: [{ id: 'claude' }] })
    expect(res.agents[0].items.find((i) => i.label === 'evil')).toMatchObject({ loaded: false, note: 'notApproved' })
    expect(await svc.measureMcp({ agent: 'claude', name: 'evil', scope: 'project', cwd: project })).toEqual({ ok: false, code: 'needsConfirm', target: 'npx evil-mcp' })
    expect(testMcp).not.toHaveBeenCalled()
    expect((await svc.measureMcp({ agent: 'claude', name: 'evil', scope: 'project', cwd: project, confirmed: true })).ok).toBe(true)
    expect(testMcp).toHaveBeenCalledTimes(1)
  })

  it('follows the user’s own approvals, never a settings file the repository can ship', async () => {
    fs.mkdirSync(join(project, '.claude'), { recursive: true })
    fs.writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    let svc = withProject().svc
    expect((await svc.summary({ cwd: project, agents: [{ id: 'claude' }] })).agents[0].items.find((i) => i.label === 'evil').note).toBe('notApproved')
    // settings.local.json is usually the user's, but a repository can commit one.
    for (const shipped of [{ enableAllProjectMcpServers: true }, { enabledMcpjsonServers: ['evil'] }]) {
      fs.writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify(shipped))
      const local = withProject()
      expect((await local.svc.summary({ cwd: project, agents: [{ id: 'claude' }] })).agents[0].items.find((i) => i.label === 'evil').note).toBe('notApproved')
      expect(await local.svc.measureMcp({ agent: 'claude', name: 'evil', scope: 'project', cwd: project })).toEqual({ ok: false, code: 'needsConfirm', target: 'npx evil-mcp' })
      expect(local.testMcp).not.toHaveBeenCalled()
    }
    fs.writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [project]: { enabledMcpjsonServers: ['evil'] } } }))
    svc = withProject().svc
    expect((await svc.summary({ cwd: project, agents: [{ id: 'claude' }] })).agents[0].items.find((i) => i.label === 'evil')).toMatchObject({ loaded: true, note: 'notMeasured' })
    fs.writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [project]: { enabledMcpjsonServers: ['evil'], disabledMcpjsonServers: ['evil'] } } }))
    const off = withProject()
    expect((await off.svc.summary({ cwd: project, agents: [{ id: 'claude' }] })).agents[0].items.find((i) => i.label === 'evil').note).toBe('off')
    expect(await off.svc.measureMcp({ agent: 'claude', name: 'evil', scope: 'project', cwd: project, confirmed: true })).toEqual({ ok: false, code: 'disabled' })
    expect(off.testMcp).not.toHaveBeenCalled()
  })
})

describe('a pane card’s hover: kept results only', () => {
  it('starts nothing before the page listed the servers, then reuses that list', async () => {
    const { svc, listMcp, anthropic } = service()
    expect(await svc.summary({ cwd: project, agents: [{ id: 'claude' }], kept: true })).toEqual({ agents: [], notListed: true })
    expect(listMcp).not.toHaveBeenCalled()
    await svc.summary({ cwd: project, agents: [{ id: 'claude' }], remote: true })
    expect(listMcp).toHaveBeenCalledTimes(1)
    const calls = anthropic.count.mock.calls.length
    const kept = await svc.summary({ cwd: project, agents: [{ id: 'claude' }], kept: true, remote: true })
    expect(kept.agents[0].summary.total).toBeGreaterThan(0)
    // Totals only: no list of items (a flood of imports never rides along).
    expect(kept.agents[0].items).toBeUndefined()
    expect(listMcp).toHaveBeenCalledTimes(1)
    expect(anthropic.count.mock.calls.length).toBe(calls) // no count API from a hover
  })
})

describe('a flood of imports', () => {
  it('reaches the page as IMPORT_LIMIT lines at most, then one line with the number of the others', async () => {
    fs.writeFileSync(join(project, 'CLAUDE.md'), Array.from({ length: 500 }, (_, i) => `@../../far${i}.md`).join('\n'))
    const { svc } = service()
    const res = await svc.summary({ cwd: project, agents: [{ id: 'claude' }] })
    const items = res.agents[0].items
    const more = items.filter((i) => i.type === 'more')
    expect(more).toHaveLength(1)
    expect(more[0]).toMatchObject({ group: 'rules', loaded: false, note: 'more' })
    const refused = items.filter((i) => ['outside', 'skipped', 'limit'].includes(i.note))
    expect(refused.length).toBeLessThanOrEqual(200)
    expect(refused.length + more[0].count).toBeGreaterThanOrEqual(500)
  })
})

describe('only the agent’s own provider counts', () => {
  it('estimates a Copilot agent on a Claude model rather than using the Claude sign-in', async () => {
    fs.mkdirSync(join(home, '.copilot'), { recursive: true })
    fs.writeFileSync(join(home, '.copilot', 'copilot-instructions.md'), 'copilot rules')
    const { svc, anthropic } = service({ agentModel: ({ agentId }) => (agentId === 'copilot' ? { model: 'claude-sonnet-5' } : null) })
    const res = await svc.summary({ cwd: project, agents: [{ id: 'copilot' }], remote: true })
    expect(res.agents[0].counter).toMatchObject({ api: 'anthropic', noRemote: 'otherProvider' })
    expect(anthropic.count).not.toHaveBeenCalled()
    expect(res.agents[0].items.find((i) => i.label === 'copilot-instructions.md').result).toMatchObject({ exact: false, reason: 'otherProvider' })
  })
})

describe('kept MCP measurements age out', () => {
  it('ignores and deletes a measurement older than 30 days', async () => {
    let now = Date.now()
    const { svc, testMcp } = service({ clock: () => now })
    await svc.measureMcp({ agent: 'claude', name: 'fs', scope: 'user', cwd: project })
    expect(testMcp).toHaveBeenCalledTimes(1)
    const dir = join(userData, 'context-cost', 'mcp')
    expect(fs.readdirSync(dir)).toHaveLength(1)
    now += MCP_RECORD_MAX_AGE_MS + 1000
    expect(await svc.mcpMeasures({ cwd: project, servers: [{ agent: 'claude', scope: 'user', name: 'fs' }] })).toEqual({})
    await svc.summary({ cwd: project, agents: [{ id: 'claude' }], remote: true })
    await new Promise((r) => setTimeout(r, 50))
    expect(fs.readdirSync(dir)).toHaveLength(0)
  })
})

describe('a server whose command changed since its measurement', () => {
  it('is shown as not measured', async () => {
    let target = 'npx fs'
    const listMcp = vi.fn(async () => ({ claude: [{ name: 'fs', scope: 'user', target }], codex: [], others: {} }))
    const { svc } = service({ listMcp })
    await svc.measureMcp({ agent: 'claude', name: 'fs', scope: 'user', cwd: project })
    expect((await svc.summary({ cwd: project, agents: [{ id: 'claude' }], remote: true })).agents[0].items.find((i) => i.label === 'fs').toolCount).toBe(1)
    target = 'npx other-fs'
    expect((await svc.summary({ cwd: project, agents: [{ id: 'claude' }], remote: true })).agents[0].items.find((i) => i.label === 'fs').note).toBe('notMeasured')
  })
})

describe('a skill about to be added', () => {
  it('is counted from the package the main process holds, for the agents chosen', async () => {
    const pkg = { name: 'pdf', description: 'Fill PDF forms', skillMd: '---\nname: pdf\n---\nUse pdftk to fill forms.' }
    const { svc } = service({ getPackage: (id) => (id === 'p1' ? pkg : null) })
    const res = await svc.skillPackage({ id: 'p1', agents: ['codex', 'nope'] })
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]).toMatchObject({ agent: 'codex', upfront: { tokens: 5, exact: true }, full: { exact: true } })
    expect(res.rows[0].full.tokens).toBeGreaterThan(res.rows[0].upfront.tokens)
    expect(await svc.skillPackage({ id: 'gone' })).toEqual({ rows: [] })
  })
})
