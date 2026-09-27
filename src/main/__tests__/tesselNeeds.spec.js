import { describe, it, expect } from 'vitest'
import { assessNeeds, versionAtLeast, parseVersion } from '../tesselNeeds'

const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]))
const good = {
  node: { path: 'C:\\node.exe', version: 'v22.19.0' },
  git: { path: 'C:\\git.exe', configured: true },
  uvx: true,
  agents: [
    { id: 'claude', name: 'Claude Code', available: true },
    { id: 'codex', name: 'Codex', available: true },
    { id: 'kimi', name: 'Kimi', available: false }
  ],
  claudeVersion: '2.1.283 (Claude Code)',
  script: { exists: true, version: '1.6.8' },
  hooks: {
    agents: [
      { id: 'claude', hooks: 'installed', approval: null },
      { id: 'codex', hooks: 'installed', approval: 'approved' },
      { id: 'gemini', hooks: 'missing', approval: null }
    ]
  }
}

describe('what Tessel needs', () => {
  it('reads versions', () => {
    expect(parseVersion('v22.19.0')).toEqual([22, 19, 0])
    expect(versionAtLeast('2.1.283 (Claude Code)', '2.1.234')).toBe(true)
    expect(versionAtLeast('2.1.100', '2.1.234')).toBe(false)
    expect(versionAtLeast('v18.0.0', '18')).toBe(true)
    expect(versionAtLeast('', '18')).toBe(false)
  })

  it('all good: every row ok, hooks only for installed agents', () => {
    const rows = byId(assessNeeds(good))
    for (const id of ['node', 'agents', 'team-tools', 'hooks', 'claude-inbox', 'git', 'uvx']) expect(rows[id].status).toBe('ok')
    expect(rows.agents.detail).toBe('Claude Code, Codex')
    expect(rows.hooks.detail).not.toMatch(/Gemini/)
  })

  it('no Node.js: missing, with the install to run', () => {
    const rows = byId(assessNeeds({ ...good, node: null }))
    expect(rows.node).toMatchObject({ status: 'missing', fix: { install: 'node' } })
  })

  it('an old Node.js or Claude Code: to fix, saying what version is needed', () => {
    const rows = byId(assessNeeds({ ...good, node: { path: 'x', version: 'v16.20.0' }, claudeVersion: '2.1.100' }))
    expect(rows.node.status).toBe('warn')
    expect(rows.node.detail).toMatch(/18 or newer/)
    expect(rows['claude-inbox']).toMatchObject({ status: 'warn', fix: { run: 'claude update' } })
  })

  it('Codex hooks not approved, or not set up: says where to go', () => {
    const hooks = { agents: [{ id: 'claude', hooks: 'partial' }, { id: 'codex', hooks: 'installed', approval: 'needs-approval' }] }
    const rows = byId(assessNeeds({ ...good, hooks }))
    expect(rows.hooks.status).toBe('warn')
    expect(rows.hooks.detail).toMatch(/not set up for Claude Code/)
    expect(rows.hooks.detail).toMatch(/\/hooks/)
  })

  it('no agent, no team tools, no git, no uvx', () => {
    const rows = byId(assessNeeds({ node: good.node, agents: [], script: { exists: false }, git: null, uvx: false }))
    expect(rows.agents.status).toBe('missing')
    expect(rows['team-tools'].status).toBe('missing')
    expect(rows.git).toMatchObject({ status: 'warn', fix: { install: 'git' } })
    expect(rows.uvx).toMatchObject({ status: 'optional', fix: { install: 'uv' } })
    expect(rows['claude-inbox']).toBeUndefined()
  })
})
