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
})
