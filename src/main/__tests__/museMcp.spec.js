// @vitest-environment node
// Muse Code's MCP servers, in its settings.json (its MCP guide): the
// tessel-team server written the way Muse starts a server (a cleared
// environment: the pane's variables through ${NAME:-}), its older
// "mcp_servers" key kept, the schema_version it needs, in a temporary home.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { listJsonAgent, setJsonAgentServer, removeJsonAgentServer, jsonAgentConfig, teamToolsEntry } from '../jsonAgents'

let home
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-muse-mcp-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})
const file = () => join(home, '.config', 'muse', 'settings.json')
const put = (value) => {
  fs.mkdirSync(join(home, '.config', 'muse'), { recursive: true })
  fs.writeFileSync(file(), typeof value === 'string' ? value : JSON.stringify(value))
}
const read = () => JSON.parse(fs.readFileSync(file(), 'utf8'))
const NODE = 'C:\\Program Files\\nodejs\\node.exe'

describe('Muse Code: the team tools written again at each start', () => {
  it('a server the user turned off stays off, its timeouts stay, never written twice, round-trips as JSON', () => {
    const entry = teamToolsEntry('muse', 'C:/t/tessel-team-mcp.cjs', NODE)
    put({ schema_version: 1, model: 'muse-wonder-1.0', mcpServers: { 'tessel-team': { command: 'node', args: ['old.cjs'], enabled: false, startup_timeout_ms: 60000 }, docs: { url: 'https://d' } } })
    expect(setJsonAgentServer('muse', 'tessel-team', entry, home, { keepUser: true })).toEqual({ ok: true, changed: true })
    const saved = read()
    expect(saved.mcpServers['tessel-team']).toEqual({ ...entry, enabled: false, startup_timeout_ms: 60000 })
    expect(saved.mcpServers.docs).toEqual({ url: 'https://d' })
    expect(saved.model).toBe('muse-wonder-1.0')
    expect(Object.keys(saved.mcpServers).filter((k) => k === 'tessel-team')).toHaveLength(1)
    // Again: nothing to change.
    expect(setJsonAgentServer('muse', 'tessel-team', entry, home, { keepUser: true })).toEqual({ ok: true, changed: false })
    expect(listJsonAgent('muse', home).servers.find((s) => s.name === 'tessel-team')).toMatchObject({ enabled: false })
    // Muse rewrote its settings with the keys in another order: no change, no new backup.
    const reordered = { schema_version: 1, mcpServers: { 'tessel-team': { startup_timeout_ms: 60000, enabled: false, env: { ...entry.env }, args: entry.args, command: entry.command } } }
    put(reordered)
    fs.rmSync(`${file()}.tessel-bak`, { force: true })
    expect(setJsonAgentServer('muse', 'tessel-team', entry, home, { keepUser: true })).toEqual({ ok: true, changed: false })
    expect(fs.existsSync(`${file()}.tessel-bak`)).toBe(false)
    // A server list that is not an object: left as it is, said why.
    for (const bad of ['oops', ['x'], null]) {
      put({ schema_version: 1, mcpServers: bad })
      const res = setJsonAgentServer('muse', 'tessel-team', entry, home, { keepUser: true })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/not an object/)
      expect(read().mcpServers).toEqual(bad)
    }
    // Its older key: still one server there, none added under the new key.
    put({ schema_version: 1, mcp_servers: { 'tessel-team': { command: 'node', args: ['old.cjs'] } } })
    expect(setJsonAgentServer('muse', 'tessel-team', entry, home, { keepUser: true })).toEqual({ ok: true, changed: true })
    expect(read()).toEqual({ schema_version: 1, mcp_servers: { 'tessel-team': entry } })
  })
})

describe('Muse Code: MCP servers in its settings', () => {
  it("the team tools: node by its path, the pane's variables passed through env (a missing one empty, never an error)", () => {
    expect(teamToolsEntry('muse', 'C:/t/tessel-team-mcp.cjs', NODE)).toEqual({
      command: NODE,
      args: ['C:/t/tessel-team-mcp.cjs'],
      env: {
        TESSEL_PANE_ID: '${TESSEL_PANE_ID:-}',
        TESSEL_TEAM_SECRET: '${TESSEL_TEAM_SECRET:-}',
        TESSEL_PROJECT_DIR: '${TESSEL_PROJECT_DIR:-}',
        TESSEL_RUNTIME_DIR: '${TESSEL_RUNTIME_DIR:-}',
        APPDATA: '${APPDATA:-}'
      }
    })
  })

  it('a new settings file gets schema_version 1 (Muse refuses to start without it); the rest of a file is kept', () => {
    expect(setJsonAgentServer('muse', 'tessel-team', teamToolsEntry('muse', 'C:/t/tessel-team-mcp.cjs', NODE), home)).toEqual({ ok: true, changed: true })
    expect(read().schema_version).toBe(1)
    expect(Object.keys(read().mcpServers)).toEqual(['tessel-team'])
    put({ schema_version: 1, tui: { terminal_background: 'dark' }, hooks: { Stop: [] }, mcpServers: { docs: { command: 'docs' } } })
    expect(setJsonAgentServer('muse', 'tessel-team', teamToolsEntry('muse', 'C:/t/tessel-team-mcp.cjs', NODE), home).ok).toBe(true)
    expect(read()).toMatchObject({ schema_version: 1, tui: { terminal_background: 'dark' }, hooks: { Stop: [] } })
    expect(Object.keys(read().mcpServers)).toEqual(['docs', 'tessel-team'])
    expect(setJsonAgentServer('muse', 'tessel-team', teamToolsEntry('muse', 'C:/t/tessel-team-mcp.cjs', NODE), home)).toEqual({ ok: true, changed: false })
  })

  it('its older "mcp_servers" key is the one kept; with both keys Muse turns MCP off, and Tessel changes nothing', () => {
    put({ schema_version: 1, mcp_servers: { old: { transport: 'stdio', command: 'old-mcp', args: [] } } })
    expect(listJsonAgent('muse', home).servers).toEqual([{ name: 'old', scope: 'user', type: 'stdio', target: 'old-mcp' }])
    expect(setJsonAgentServer('muse', 'web', { url: 'https://x/mcp' }, home).ok).toBe(true)
    expect(read().mcpServers).toBeUndefined()
    expect(Object.keys(read().mcp_servers)).toEqual(['old', 'web'])
    expect(removeJsonAgentServer('muse', 'old', home).changed).toBe(true)
    const both = { schema_version: 1, mcpServers: { a: { command: 'a' } }, mcp_servers: { b: { command: 'b' } } }
    put(both)
    expect(listJsonAgent('muse', home).error).toMatch(/mcpServers and mcp_servers/)
    expect(setJsonAgentServer('muse', 'c', { command: 'c' }, home).ok).toBe(false)
    expect(read()).toEqual(both)
  })

  it('its legacy streamable_http entries and a server turned off (enabled: false)', () => {
    put({ schema_version: 1, mcpServers: { issues: { transport: 'streamable_http', url: 'https://issues/mcp', headers: { 'X-Team': 'platform' } }, off: { command: 'x', enabled: false } } })
    expect(listJsonAgent('muse', home).servers).toEqual([
      { name: 'issues', scope: 'user', type: 'http', target: 'https://issues/mcp', headerKeys: ['X-Team'] },
      { name: 'off', scope: 'user', type: 'stdio', target: 'x', enabled: false }
    ])
    expect(jsonAgentConfig('muse', 'issues', home)).toEqual({ transport: 'http', sse: false, url: 'https://issues/mcp', headers: { 'X-Team': 'platform' } })
  })

  it('an SSE endpoint is refused before anything is written (Muse speaks stdio and streamable HTTP)', async () => {
    const { addMcp } = await import('../agentTools')
    const r = await addMcp({ agent: 'muse', name: 'old', transport: 'http', url: 'https://x/sse', sse: true })
    expect(r).toEqual({ ok: false, error: 'Muse Code only connects to streamable HTTP servers, not SSE ones.' })
  })
})
