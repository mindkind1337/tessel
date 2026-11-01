import { describe, it, expect } from 'vitest'
import { MCP_CATALOG, catalogSpec } from '../mcpCatalog'

const byId = (id) => MCP_CATALOG.find((e) => e.id === id)

describe('MCP catalog', () => {
  it('has unique, CLI-safe ids', () => {
    const ids = MCP_CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/)
  })

  it('fills folder arguments into the command', () => {
    const spec = catalogSpec(byId('filesystem'), { folder: 'C:\My Project' }, 'claude')
    expect(spec).toMatchObject({ agent: 'claude', name: 'filesystem', transport: 'stdio' })
    expect(spec.commandLine).toBe('npx -y @modelcontextprotocol/server-filesystem "C:\My Project"')
    expect(spec.env).toBe('')
  })

  it('passes API keys as environment variables', () => {
    const spec = catalogSpec(byId('brave-search'), { BRAVE_API_KEY: 'k123' }, 'codex')
    expect(spec.env).toBe('BRAVE_API_KEY=k123')
  })

  it('uses a header for Claude and a token variable for Codex', () => {
    const e = byId('github')
    expect(catalogSpec(e, { token: 'ghp_x' }, 'claude')).toMatchObject({
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: 'Authorization: Bearer ghp_x'
    })
    const codex = catalogSpec(e, { token: 'ghp_x' }, 'codex')
    expect(codex.headers).toBeUndefined()
    expect(codex.bearerEnvVar).toBe('GITHUB_PERSONAL_ACCESS_TOKEN')
  })

  it('gives every agent the same Google client and the same no-send rights', () => {
    const answers = { GOOGLE_OAUTH_CLIENT_ID: 'id1', GOOGLE_OAUTH_CLIENT_SECRET: 's1' }
    for (const agent of ['claude', 'codex', 'gemini', 'opencode']) {
      const spec = catalogSpec(byId('google-workspace'), answers, agent)
      expect(spec.commandLine).toBe('uvx workspace-mcp --permissions gmail:drafts calendar:full drive:readonly')
      expect(spec.env).toBe('GOOGLE_OAUTH_CLIENT_ID=id1\nGOOGLE_OAUTH_CLIENT_SECRET=s1')
    }
  })

  it("sets an entry's fixed environment without asking, ahead of the answers", () => {
    const spec = catalogSpec(byId('outlook'), {}, 'codex')
    expect(spec.env).toBe('MS365_MCP_TENANT_ID=consumers')
    expect(spec.commandLine).toContain('--allowed-scopes "Mail.ReadWrite Calendars.ReadWrite Contacts.ReadWrite Files.Read"')
    expect(spec.commandLine).not.toContain('Mail.Send')
    const both = catalogSpec({ ...byId('outlook'), inputs: [{ key: 'K', as: 'env' }] }, { K: 'v' }, 'codex')
    expect(both.env).toBe('MS365_MCP_TENANT_ID=consumers\nK=v')
  })
})
