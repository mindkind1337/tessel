// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  listJsonAgent,
  setJsonAgentServer,
  removeJsonAgentServer,
  jsonAgentConfig,
  configToEntry,
  teamToolsEntry
} from '../jsonAgents'

let home
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agents-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})
const read = (...p) => JSON.parse(fs.readFileSync(join(home, ...p), 'utf8'))

describe('MCP servers in agents settings files', () => {
  it('Gemini: adds, lists, reads and removes, keeping the rest of the file', () => {
    fs.mkdirSync(join(home, '.gemini'))
    fs.writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ theme: 'Dark', mcpServers: { old: { command: 'x' } } }))
    const entry = configToEntry('gemini', { transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { K: 'v' } })
    expect(setJsonAgentServer('gemini', 'docs', entry, home).ok).toBe(true)
    expect(read('.gemini', 'settings.json').theme).toBe('Dark')
    expect(listJsonAgent('gemini', home).servers.map((s) => s.name)).toEqual(['old', 'docs'])
    expect(jsonAgentConfig('gemini', 'docs', home)).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { K: 'v' } })
    expect(removeJsonAgentServer('gemini', 'docs', home).changed).toBe(true)
    expect(Object.keys(read('.gemini', 'settings.json').mcpServers)).toEqual(['old'])
  })

  it('OpenCode: command is one array, env is "environment", remote servers', () => {
    setJsonAgentServer('opencode', 'loc', configToEntry('opencode', { transport: 'stdio', command: 'node', args: ['s.js'], env: { A: '1' } }), home)
    setJsonAgentServer('opencode', 'rem', configToEntry('opencode', { transport: 'http', url: 'https://x/mcp', headers: { H: 'v' } }), home)
    const cfg = read('.config', 'opencode', 'opencode.json')
    expect(cfg.$schema).toBe('https://opencode.ai/config.json')
    expect(cfg.mcp.loc).toEqual({ type: 'local', command: ['node', 's.js'], enabled: true, environment: { A: '1' } })
    expect(cfg.mcp.rem).toEqual({ type: 'remote', url: 'https://x/mcp', enabled: true, headers: { H: 'v' } })
    expect(listJsonAgent('opencode', home).servers).toEqual([
      { name: 'loc', scope: 'user', type: 'stdio', target: 'node s.js' },
      { name: 'rem', scope: 'user', type: 'http', target: 'https://x/mcp' }
    ])
  })

  it('Copilot: local servers with tools ["*"]', () => {
    setJsonAgentServer('copilot', 'loc', configToEntry('copilot', { transport: 'stdio', command: 'node', args: ['s.js'] }), home)
    expect(read('.copilot', 'mcp-config.json').mcpServers.loc).toEqual({ type: 'local', command: 'node', args: ['s.js'], tools: ['*'] })
  })

  it('never rewrites a file it cannot read as plain JSON', () => {
    fs.mkdirSync(join(home, '.qwen'))
    const text = '{ // my comment\n "mcpServers": {} }'
    fs.writeFileSync(join(home, '.qwen', 'settings.json'), text)
    const r = setJsonAgentServer('qwen', 'x', { command: 'x' }, home)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not plain JSON/)
    expect(fs.readFileSync(join(home, '.qwen', 'settings.json'), 'utf8')).toBe(text)
  })

  it('the Tessel team tools entry passes each pane identity its own way', () => {
    expect(teamToolsEntry('gemini', 'C:/t/tessel-team-mcp.cjs')).toEqual({
      command: 'node',
      args: ['C:/t/tessel-team-mcp.cjs'],
      env: { TESSEL_PANE_ID: '$TESSEL_PANE_ID', TESSEL_PROJECT_DIR: '$TESSEL_PROJECT_DIR' },
      trust: true
    })
    // No path through {env:}: OpenCode inserts it raw, and a backslash breaks its JSON.
    expect(teamToolsEntry('opencode', 'C:/t/s.cjs').environment).toEqual({ TESSEL_PANE_ID: '{env:TESSEL_PANE_ID}' })
    // Cline hands the pane's environment on and never expands $VAR: no env.
    expect(teamToolsEntry('cline', 'C:/t/s.cjs')).toEqual({ command: 'node', args: ['C:/t/s.cjs'] })
  })

  it('Cline: its settings/cline_mcp_settings.json, http as streamableHttp', () => {
    const old = { dir: process.env.CLINE_DIR, data: process.env.CLINE_DATA_DIR, file: process.env.CLINE_MCP_SETTINGS_PATH }
    delete process.env.CLINE_DIR
    delete process.env.CLINE_DATA_DIR
    delete process.env.CLINE_MCP_SETTINGS_PATH
    try {
      fs.mkdirSync(join(home, '.cline', 'data', 'settings'), { recursive: true })
      fs.writeFileSync(join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), JSON.stringify({ mcpServers: {} }))
      expect(setJsonAgentServer('cline', 'tessel-team', teamToolsEntry('cline', 'C:/t/s.cjs'), home).ok).toBe(true)
      const web = configToEntry('cline', { transport: 'http', url: 'https://x/mcp', headers: { A: 'b' } })
      expect(web).toEqual({ type: 'streamableHttp', url: 'https://x/mcp', headers: { A: 'b' } })
      expect(setJsonAgentServer('cline', 'web', web, home).ok).toBe(true)
      expect(read('.cline', 'data', 'settings', 'cline_mcp_settings.json').mcpServers['tessel-team']).toEqual({
        command: 'node',
        args: ['C:/t/s.cjs']
      })
      expect(listJsonAgent('cline', home).servers.map((s) => [s.name, s.type, s.target])).toEqual([
        ['tessel-team', 'stdio', 'node C:/t/s.cjs'],
        ['web', 'http', 'https://x/mcp']
      ])
    } finally {
      for (const [k, v] of [['CLINE_DIR', old.dir], ['CLINE_DATA_DIR', old.data], ['CLINE_MCP_SETTINGS_PATH', old.file]]) {
        if (v !== undefined) process.env[k] = v
      }
    }
  })
})
