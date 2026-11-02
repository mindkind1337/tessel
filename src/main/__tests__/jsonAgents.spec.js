// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  jsonAgentHasServer,
  listJsonAgent,
  setJsonAgentServer,
  removeJsonAgentServer,
  jsonAgentConfig,
  configToEntry,
  entryToConfig,
  teamToolsEntry,
  JSON_AGENTS
} from '../jsonAgents'

let home
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agents-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})
const read = (...p) => JSON.parse(fs.readFileSync(join(home, ...p), 'utf8'))
const put = (rel, text) => {
  fs.mkdirSync(join(home, rel, '..'), { recursive: true })
  fs.writeFileSync(join(home, rel), text)
}

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
    // Variable and header names, never their values.
    expect(listJsonAgent('opencode', home).servers).toEqual([
      { name: 'loc', scope: 'user', type: 'stdio', target: 'node s.js', envKeys: ['A'] },
      { name: 'rem', scope: 'user', type: 'http', target: 'https://x/mcp', headerKeys: ['H'] }
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
    // Node by its absolute path, never by name (a node.exe in the folder the
    // agent runs in would be started instead).
    const NODE = 'C:\\Program Files\\nodejs\\node.exe'
    expect(teamToolsEntry('gemini', 'C:/t/tessel-team-mcp.cjs', NODE)).toEqual({
      command: NODE,
      args: ['C:/t/tessel-team-mcp.cjs'],
      env: { TESSEL_PANE_ID: '$TESSEL_PANE_ID', TESSEL_PROJECT_DIR: '$TESSEL_PROJECT_DIR', TESSEL_TEAM_SECRET: '$TESSEL_TEAM_SECRET' },
      trust: true
    })
    // No path through {env:}: OpenCode inserts it raw, and a backslash breaks its JSON.
    expect(teamToolsEntry('opencode', 'C:/t/s.cjs').environment).toEqual({ TESSEL_PANE_ID: '{env:TESSEL_PANE_ID}', TESSEL_TEAM_SECRET: '{env:TESSEL_TEAM_SECRET}' })
    // Cline hands the pane's environment on and never expands $VAR: no env.
    expect(teamToolsEntry('cline', 'C:/t/s.cjs', NODE)).toEqual({ command: NODE, args: ['C:/t/s.cjs'] })
    // So does the Antigravity CLI (checked: a "$TESSEL_PANE_ID" value reaches
    // the server as it is, and the pane's own variables reach it anyway).
    expect(teamToolsEntry('antigravity', 'C:/t/s.cjs', NODE)).toEqual({ command: NODE, args: ['C:/t/s.cjs'] })
  })

  it('Antigravity CLI: its own ~/.gemini/config/mcp_config.json, never Gemini CLI settings', () => {
    put('.gemini/settings.json', JSON.stringify({ mcpServers: { gem: { command: 'g' } } }))
    // An empty file (agy creates one) is no error.
    put('.gemini/config/mcp_config.json', '')
    expect(listJsonAgent('antigravity', home)).toEqual({ servers: [], error: null })
    const NODE = 'C:\\Program Files\\nodejs\\node.exe'
    expect(setJsonAgentServer('antigravity', 'tessel_team', teamToolsEntry('antigravity', 'C:/t/tessel-team-mcp.cjs', NODE), home)).toEqual({ ok: true, changed: true })
    expect(read('.gemini', 'config', 'mcp_config.json')).toEqual({ mcpServers: { 'tessel_team': { command: NODE, args: ['C:/t/tessel-team-mcp.cjs'] } } })
    expect(read('.gemini', 'settings.json').mcpServers).toEqual({ gem: { command: 'g' } })
    // Again: nothing to change.
    expect(setJsonAgentServer('antigravity', 'tessel_team', teamToolsEntry('antigravity', 'C:/t/tessel-team-mcp.cjs', NODE), home)).toEqual({ ok: true, changed: false })
  })

  it('Antigravity CLI: reads url or serverUrl, and a server agy turned off', () => {
    put('.gemini/config/mcp_config.json', JSON.stringify({ mcpServers: { a: { url: 'https://a/mcp' }, b: { serverUrl: 'https://b/mcp', disabled: true }, c: { command: 'node', args: ['c.js'], disabled: false } } }))
    expect(listJsonAgent('antigravity', home).servers).toEqual([
      { name: 'a', scope: 'user', type: 'http', target: 'https://a/mcp' },
      { name: 'b', scope: 'user', type: 'http', target: 'https://b/mcp', enabled: false },
      { name: 'c', scope: 'user', type: 'stdio', target: 'node c.js' }
    ])
    expect(jsonAgentConfig('antigravity', 'b', home)).toEqual({ transport: 'http', sse: false, url: 'https://b/mcp', headers: {} })
  })

  it('Antigravity CLI: a file with comments (agy accepts them) is never rewritten', () => {
    const text = '{ // mine\n "mcpServers": {} }'
    put('.gemini/config/mcp_config.json', text)
    expect(setJsonAgentServer('antigravity', 'x', { command: 'x' }, home).ok).toBe(false)
    expect(fs.readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).toBe(text)
  })

  it('Cline: its settings/cline_mcp_settings.json, http as streamableHttp', () => {
    const old = { dir: process.env.CLINE_DIR, data: process.env.CLINE_DATA_DIR, file: process.env.CLINE_MCP_SETTINGS_PATH }
    delete process.env.CLINE_DIR
    delete process.env.CLINE_DATA_DIR
    delete process.env.CLINE_MCP_SETTINGS_PATH
    try {
      fs.mkdirSync(join(home, '.cline', 'data', 'settings'), { recursive: true })
      fs.writeFileSync(join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), JSON.stringify({ mcpServers: {} }))
      expect(setJsonAgentServer('cline', 'tessel_team', teamToolsEntry('cline', 'C:/t/s.cjs', 'C:/nodejs/node.exe'), home).ok).toBe(true)
      const web = configToEntry('cline', { transport: 'http', url: 'https://x/mcp', headers: { A: 'b' } })
      expect(web).toEqual({ type: 'streamableHttp', url: 'https://x/mcp', headers: { A: 'b' } })
      expect(setJsonAgentServer('cline', 'web', web, home).ok).toBe(true)
      expect(read('.cline', 'data', 'settings', 'cline_mcp_settings.json').mcpServers['tessel_team']).toEqual({
        command: 'C:/nodejs/node.exe',
        args: ['C:/t/s.cjs']
      })
      expect(listJsonAgent('cline', home).servers.map((s) => [s.name, s.type, s.target])).toEqual([
        ['tessel_team', 'stdio', 'C:/nodejs/node.exe C:/t/s.cjs'],
        ['web', 'http', 'https://x/mcp']
      ])
    } finally {
      for (const [k, v] of [['CLINE_DIR', old.dir], ['CLINE_DATA_DIR', old.data], ['CLINE_MCP_SETTINGS_PATH', old.file]]) {
        if (v !== undefined) process.env[k] = v
      }
    }
  })
})

// Each agent's own format for a streamable HTTP server, an SSE one and a
// command, where its settings file is, and that it reads back the same.
describe('MCP server formats, per agent', () => {
  const http = { transport: 'http', url: 'https://mcp.context7.com/mcp', headers: { K: 'v' } }
  const sse = { transport: 'http', sse: true, url: 'https://x/sse', headers: {} }
  const stdio = { transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { A: '1' } }
  const cases = {
    gemini: { file: ['.gemini', 'settings.json'], key: 'mcpServers', http: { httpUrl: http.url, headers: { K: 'v' } }, sse: { url: sse.url }, stdio: { command: 'npx', args: ['-y', 'srv'], env: { A: '1' } } },
    qwen: { file: ['.qwen', 'settings.json'], key: 'mcpServers', http: { httpUrl: http.url, headers: { K: 'v' } }, sse: { url: sse.url }, stdio: { command: 'npx', args: ['-y', 'srv'], env: { A: '1' } } },
    copilot: { file: ['.copilot', 'mcp-config.json'], key: 'mcpServers', http: { type: 'http', url: http.url, tools: ['*'], headers: { K: 'v' } }, sse: { type: 'sse', url: sse.url, tools: ['*'] }, stdio: { type: 'local', command: 'npx', args: ['-y', 'srv'], tools: ['*'], env: { A: '1' } } },
    opencode: { file: ['.config', 'opencode', 'opencode.json'], key: 'mcp', http: { type: 'remote', url: http.url, enabled: true, headers: { K: 'v' } }, sse: { type: 'remote', url: sse.url, enabled: true }, stdio: { type: 'local', command: ['npx', '-y', 'srv'], enabled: true, environment: { A: '1' } } },
    cline: { file: ['.cline', 'data', 'settings', 'cline_mcp_settings.json'], key: 'mcpServers', http: { type: 'streamableHttp', url: http.url, headers: { K: 'v' } }, sse: { type: 'sse', url: sse.url }, stdio: { command: 'npx', args: ['-y', 'srv'], env: { A: '1' } } },
    kimi: { file: ['.kimi-code', 'mcp.json'], key: 'mcpServers', http: { transport: 'http', url: http.url, headers: { K: 'v' } }, sse: { transport: 'sse', url: sse.url }, stdio: { command: 'npx', args: ['-y', 'srv'], env: { A: '1' } } },
    cursor: { file: ['.cursor', 'mcp.json'], key: 'mcpServers', http: { url: http.url, headers: { K: 'v' } }, sse: { url: sse.url }, stdio: { command: 'npx', args: ['-y', 'srv'], env: { A: '1' } } },
    // What `agy mcp add` writes (checked with agy 1.3.5); it has no SSE (refused before, see agentTools).
    antigravity: { file: ['.gemini', 'config', 'mcp_config.json'], key: 'mcpServers', http: { serverUrl: http.url, headers: { K: 'v' } }, sse: { serverUrl: sse.url }, stdio: { command: 'npx', args: ['-y', 'srv'], env: { A: '1' } } },
    // Muse Code's settings (its MCP guide): no type (an entry with url is
    // streamable HTTP); no SSE (refused before, see agentTools).
    muse: { file: ['.config', 'muse', 'settings.json'], key: 'mcpServers', http: { url: http.url, headers: { K: 'v' } }, sse: { url: sse.url }, stdio: { command: 'npx', args: ['-y', 'srv'], env: { A: '1' } } }
  }
  const saved = {}
  beforeEach(() => {
    for (const k of ['CLINE_MCP_SETTINGS_PATH', 'CLINE_DATA_DIR', 'CLINE_DIR', 'KIMI_CODE_HOME']) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
  })

  it('covers every agent with a settings file', () => {
    expect(Object.keys(cases).sort()).toEqual([...JSON_AGENTS].sort())
  })

  it.each(Object.keys(cases))('%s: adds HTTP, SSE and command servers in its own format, lists and removes them', (agent) => {
    const c = cases[agent]
    expect(setJsonAgentServer(agent, 'web', configToEntry(agent, http), home).ok).toBe(true)
    expect(setJsonAgentServer(agent, 'old', configToEntry(agent, sse), home).ok).toBe(true)
    expect(setJsonAgentServer(agent, 'cmd', configToEntry(agent, stdio), home).ok).toBe(true)
    const servers = read(...c.file)[c.key]
    expect(servers.web).toEqual(c.http)
    expect(servers.old).toEqual(c.sse)
    expect(servers.cmd).toEqual(c.stdio)
    expect(listJsonAgent(agent, home).servers).toEqual([
      { name: 'web', scope: 'user', type: 'http', target: http.url, headerKeys: ['K'] },
      { name: 'old', scope: 'user', type: 'http', target: sse.url },
      { name: 'cmd', scope: 'user', type: 'stdio', target: 'npx -y srv', envKeys: ['A'] }
    ])
    expect(JSON.stringify(listJsonAgent(agent, home))).not.toMatch(/"v"|"1"/)
    // Read back as it was written (OpenCode and Cursor find SSE by themselves).
    expect(jsonAgentConfig(agent, 'web', home)).toEqual({ ...http, sse: false })
    expect(jsonAgentConfig(agent, 'old', home).sse).toBe(!['opencode', 'cursor', 'antigravity', 'muse'].includes(agent))
    expect(jsonAgentConfig(agent, 'cmd', home)).toEqual(stdio)
    expect(removeJsonAgentServer(agent, 'web', home).changed).toBe(true)
    expect(Object.keys(read(...c.file)[c.key])).toEqual(['old', 'cmd'])
  })

  it('Gemini: url with type "http" is streamable HTTP, url alone is SSE', () => {
    expect(entryToConfig('gemini', { url: 'https://x', type: 'http' }).sse).toBe(false)
    expect(entryToConfig('gemini', { url: 'https://x' }).sse).toBe(true)
  })
})

describe('a server that changed its name', () => {
  it('the old entry goes, what the person kept in it comes along, and it happens once', () => {
    const home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-json-rename-'))
    try {
      const file = join(home, '.gemini', 'settings.json')
      fs.mkdirSync(join(home, '.gemini'), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { mine: { command: 'x' }, 'tessel-team': { command: 'old', args: [] } } }))
      const entry = { command: 'node', args: ['s.cjs'] }
      expect(setJsonAgentServer('gemini', 'tessel_team', entry, home, { keepUser: true, replaces: 'tessel-team' })).toEqual({ ok: true, changed: true })
      const servers = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers
      expect(Object.keys(servers).sort()).toEqual(['mine', 'tessel_team'])
      expect(setJsonAgentServer('gemini', 'tessel_team', entry, home, { keepUser: true, replaces: 'tessel-team' })).toEqual({ ok: true, changed: false })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('whether an agent names a server', () => {
  it('yes, no, and an unreadable file is no', () => {
    const home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-json-has-'))
    try {
      const file = join(home, '.gemini', 'settings.json')
      fs.mkdirSync(join(home, '.gemini'), { recursive: true })
      expect(jsonAgentHasServer('gemini', 'old', home)).toBe(false)
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { old: { command: 'x' } } }))
      expect(jsonAgentHasServer('gemini', 'old', home)).toBe(true)
      expect(jsonAgentHasServer('gemini', 'other', home)).toBe(false)
      expect(jsonAgentHasServer('gemini', 'constructor', home)).toBe(false)
      fs.writeFileSync(file, '{not json')
      expect(jsonAgentHasServer('gemini', 'old', home)).toBe(false)
      expect(jsonAgentHasServer('nobody', 'old', home)).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
