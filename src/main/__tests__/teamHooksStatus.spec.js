// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { dirname, join, resolve, sep } from 'path'
import { hooksStatus } from '../teamHooksStatus'
import {
  HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  installClaudeHooks,
  installCodexHooks,
  GEMINI_HOOK_EVENTS,
  installGeminiHooks,
  installCopilotHooks,
  installOpencodePlugin,
  OPENCODE_MARKER,
  opencodePlugin
} from '../teamInstall'

describe('read-only hook connection diagnostics', () => {
  let home
  let sessionsDir
  const scriptPath = 'C:\\Tessel data\\tessel-team-mcp.cjs'
  // The absolute node Tessel's hook commands run.
  const NODE = 'C:\\Program Files\\nodejs\\node.exe'
  const write = (file, text) => {
    fs.mkdirSync(dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  const json = (file, value) => write(file, JSON.stringify(value))
  const configFile = () => join(home, '.codex', 'config.toml')
  const hooksFile = () => join(home, '.codex', 'hooks.json')
  const claudeFile = () => join(home, '.claude', 'settings.json')
  const geminiFile = () => join(home, '.gemini', 'settings.json')
  const status = () => hooksStatus({ home, sessionsDir, scriptPath, env: {}, node: NODE })
  const agent = (id = 'codex') => status().agents.find((a) => a.id === id)
  const install = () => {
    installClaudeHooks(scriptPath, home, { node: NODE })
    installCodexHooks(scriptPath, home, { node: NODE })
    installGeminiHooks(scriptPath, home, { node: NODE })
    installCopilotHooks(scriptPath, home, { node: NODE })
  }
  const trust = (event, group = 0, handler = 0, enabled, quoted = false) => {
    const name = event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
    const key = `${hooksFile()}:${name}:${group}:${handler}`
    return `[hooks.state.${quoted ? JSON.stringify(key) : `'${key}'`}]\ntrusted_hash = "saved-hash"\n${enabled === undefined ? '' : `enabled = ${enabled}\n`}`
  }
  const allTrust = () => CODEX_HOOK_EVENTS.map((e) => trust(e)).join('\n')

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-hooks-status-'))
    sessionsDir = join(home, 'sessions')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    const target = resolve(home)
    if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-hooks-status-'))
      throw new Error('Unexpected cleanup path')
    fs.rmSync(target, { recursive: true, force: true })
  })

  it('reports missing setups without creating directories, using the installer event lists', () => {
    const result = status()
    const team = result.agents.filter((a) => !a.statusOnly)
    expect(team.map((a) => a.hooks)).toEqual(['missing', 'missing', 'missing', 'missing', 'missing', 'missing'])
    // The agents whose hooks only report their status (agentStatusHooks.js).
    expect(result.agents.filter((a) => a.statusOnly).map((a) => [a.id, a.hooks])).toEqual(
      ['cursor', 'droid', 'grok', 'antigravity', 'openclaude', 'commandcode', 'amp', 'pi'].map((id) => [id, 'missing'])
    )
    expect(Object.keys(result.agents[0].events)).toEqual(HOOK_EVENTS)
    expect(Object.keys(result.agents[1].events)).toEqual(CODEX_HOOK_EVENTS)
    expect(Object.keys(result.agents[2].events)).toEqual(GEMINI_HOOK_EVENTS)
    expect(
      result.agents.every((a) => a.approval === null && a.lastSignal === null && !a.inbox)
    ).toBe(true)
    expect(fs.readdirSync(home)).toEqual([])
  })

  it('without an absolute node on PATH: nothing counts as installed, and Settings is told why', () => {
    install()
    const result = hooksStatus({ home, sessionsDir, scriptPath, env: { PATH: '.' }, node: undefined })
    expect(result.node).toMatchObject({ found: false })
    expect(result.node.error).toMatch(/Node\.js/)
    expect(result.agents.every((a) => a.hooks !== 'installed')).toBe(true)
    expect(status().node).toEqual({ found: true, path: NODE })
  })

  it('an older install running a bare "node" is not counted as installed (it is upgraded on the next install)', () => {
    install()
    const config = JSON.parse(fs.readFileSync(claudeFile(), 'utf8'))
    config.hooks.Stop[0].hooks[0].command = `node "${scriptPath}" --hook`
    json(claudeFile(), config)
    expect(agent('claude')).toMatchObject({ hooks: 'partial', events: { Stop: false } })
    expect(installClaudeHooks(scriptPath, home, { node: NODE })).toEqual({ changed: true })
    expect(agent('claude').hooks).toBe('installed')
    expect(fs.readFileSync(claudeFile(), 'utf8')).not.toContain('"node ')
  })

  it("lists the copies Tessel kept of the user's files", () => {
    json(claudeFile(), { model: 'mine' })
    installClaudeHooks(scriptPath, home, { node: NODE })
    expect(status().backups).toEqual([`${claudeFile()}.before-tessel`])
  })

  it("Copilot: Tessel's own hooks file, each event checked, never its content in an error", () => {
    expect(agent('copilot').hooks).toBe('missing')
    installCopilotHooks(scriptPath, home, { node: NODE })
    expect(agent('copilot')).toMatchObject({ hooks: 'installed', events: { SessionStart: true, PostToolUse: true, Stop: true } })
    const file = join(home, '.copilot', 'hooks', 'tessel-team.json')
    const h = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete h.hooks.Stop
    json(file, h)
    expect(agent('copilot')).toMatchObject({ hooks: 'partial', events: { Stop: false } })
    write(file, '{"secret": "abc"')
    expect(agent('copilot').hooks).toBe('error')
    expect(agent('copilot').error).not.toMatch(/secret|abc/)
  })

  it('defaults home to os.homedir without reading the real user configuration', () => {
    install()
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    expect(hooksStatus({ scriptPath, env: {}, node: NODE }).agents.filter((a) => !a.statusOnly).map((a) => a.hooks)).toEqual([
      'installed',
      'installed',
      'installed',
      'installed',
      'missing',
      'missing'
    ])
  })

  it('distinguishes installation from saved approval and performs no writes', () => {
    install()
    const before = fs.readFileSync(hooksFile(), 'utf8')
    const writer = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('unexpected write')
    })
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('unexpected mkdir')
    })
    const result = status()
    const team = result.agents.filter((a) => !a.statusOnly)
    expect(team.map((a) => a.hooks)).toEqual(['installed', 'installed', 'installed', 'installed', 'missing', 'missing'])
    expect(team.map((a) => a.approval)).toEqual([null, 'needs-approval', null, null, null, null])
    expect(writer).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
    expect(fs.readFileSync(hooksFile(), 'utf8')).toBe(before)
  })

  it('counts only actual unrestricted Tessel commands, not a filename mention or another path', () => {
    install()
    const config = JSON.parse(fs.readFileSync(hooksFile(), 'utf8'))
    config.hooks.Stop[0].hooks[0].command = 'echo tessel-team-mcp.cjs'
    config.hooks.Stop[0].hooks[0].commandWindows = 'echo tessel-team-mcp.cjs'
    config.hooks.UserPromptSubmit[0].matcher = 'Write'
    json(hooksFile(), config)
    expect(agent()).toMatchObject({
      hooks: 'partial',
      events: { SessionStart: true, UserPromptSubmit: false, Stop: false }
    })
    expect(
      hooksStatus({ home, scriptPath: 'C:\\other\\tessel-team-mcp.cjs', node: NODE }).agents.every(
        (a) => a.hooks === 'missing'
      )
    ).toBe(true)
  })

  it('uses the effective Windows command when Codex has an override', () => {
    install()
    const config = JSON.parse(fs.readFileSync(hooksFile(), 'utf8'))
    config.hooks.Stop[0].hooks[0].commandWindows = 'another-hook'
    json(hooksFile(), config)
    expect(agent().events.Stop).toBe(process.platform !== 'win32')
  })

  it.each([null, [], { hooks: [] }])('reports an unreadable hooks file without affecting the other agent: %j', (value) => {
    install()
    json(hooksFile(), value)
    expect(agent()).toMatchObject({ hooks: 'error', approval: null })
    expect(agent('claude').hooks).toBe('installed')
  })

  it.each([{ hooks: { Stop: {} } }, { hooks: { Stop: [null] } }, { hooks: { Stop: [{ hooks: [null] }] } }])(
    'skips entries in a shape the agent ignores (not Tessel’s): %j',
    (value) => {
      json(hooksFile(), value)
      expect(agent()).toMatchObject({ hooks: 'missing' })
      expect(agent().error).toBeUndefined()
    }
  )

  it("another tool's flat entries next to Tessel's (BridgeSpace in Gemini's file): installed, no error", () => {
    install()
    const s = JSON.parse(fs.readFileSync(geminiFile(), 'utf8'))
    s.hooks.AfterAgent.unshift({ type: 'command', command: 'node bs-agent-notify.cjs', timeout: 5000 })
    s.hooks.Notification.unshift({ type: 'command', command: 'node bs-agent-notify.cjs' })
    json(geminiFile(), s)
    expect(agent('gemini')).toMatchObject({ hooks: 'installed' })
    expect(agent('gemini').error).toBeUndefined()
  })

  it('does not expose JSON contents in parse errors', () => {
    write(hooksFile(), '{token: "SECRET-TOKEN"}')
    const result = status()
    expect(result.agents[1].hooks).toBe('error')
    expect(JSON.stringify(result)).not.toContain('SECRET-TOKEN')
  })

  it('looks up the real group AND handler indices, with quoted or literal TOML keys', () => {
    install()
    const config = JSON.parse(fs.readFileSync(hooksFile(), 'utf8'))
    for (const event of CODEX_HOOK_EVENTS) {
      config.hooks[event].unshift({ hooks: [{ type: 'command', command: 'personal-hook' }] })
      config.hooks[event][1].hooks.unshift({ type: 'command', command: 'personal-hook' })
    }
    json(hooksFile(), config)
    write(configFile(), allTrust())
    expect(agent().approval).toBe('needs-approval')
    write(
      configFile(),
      CODEX_HOOK_EVENTS.map((e, i) => trust(e, 1, 1, i === 1 ? true : undefined, i === 2)).join(
        '\n'
      )
    )
    expect(agent().approval).toBe('approved')
    expect(agent().error).toBeUndefined()
  })

  it('requires an enabled saved hash for every event, never claims a hash comparison', () => {
    install()
    write(configFile(), allTrust())
    expect(agent().approval).toBe('approved')
    write(configFile(), allTrust().replace('trusted_hash = "saved-hash"', 'trusted_hash = ""'))
    expect(agent().approval).toBe('needs-approval')
    write(
      configFile(),
      CODEX_HOOK_EVENTS.map((e) => trust(e, 0, 0, e === 'Stop' ? false : undefined)).join('\n')
    )
    expect(agent().approval).toBe('needs-approval')
    write(configFile(), trust('SessionStart'))
    expect(agent().approval).toBe('needs-approval')
  })

  it('supports comments and # inside a quoted key without counting commented approvals', () => {
    install()
    write(configFile(), '# ' + allTrust().split('\n').join('\n# '))
    expect(agent().approval).toBe('needs-approval')
    write(
      configFile(),
      "model = 'model#not-comment' # comment\n" +
        allTrust().replaceAll('"saved-hash"', '"saved-hash" # harmless')
    )
    expect(agent().approval).toBe('approved')
  })

  it.each([
    (text) => `instructions = '''\n${text}\n'''`,
    (text) => `instructions = """\n${text}\n"""`,
    (text) => `instructions = [\n'other',\n]\n${text}`,
    (text) => text + '\n' + text,
    (text) => text.replace('trusted_hash = "saved-hash"', 'trusted_hash = "SECRET-PARSE-ERROR'),
    (text) => text.replace('trusted_hash = "saved-hash"', 'enabled = perhaps'),
    (text) => 'features = { hooks = false }\n' + text
  ])(
    'returns unknown for ambiguous/unsupported TOML instead of a guessed approval (%#)',
    (makeConfig) => {
      install()
      write(configFile(), makeConfig(allTrust()))
      const result = agent()
      expect(result.approval).toBeNull()
      expect(result.error).toContain('/hooks')
      expect(JSON.stringify(result)).not.toContain('SECRET-PARSE-ERROR')
    }
  )

  it('surfaces global hook disables, including the deprecated Codex feature flag', () => {
    install()
    for (const feature of ['hooks', 'codex_hooks']) {
      write(configFile(), `[features]\n${feature} = false\n` + allTrust())
      expect(agent()).toMatchObject({ hooks: 'error', approval: null })
      expect(agent().error).toContain('disabled')
    }
    write(configFile(), '[features]\nhooks = true\ncodex_hooks = false\n' + allTrust())
    expect(agent().approval).toBe('approved')
    const config = JSON.parse(fs.readFileSync(claudeFile(), 'utf8'))
    config.disableAllHooks = true
    json(claudeFile(), config)
    expect(agent('claude')).toMatchObject({ hooks: 'error', approval: null })
  })

  it('treats filesystem read failures as unknown/error, not missing or approved', () => {
    install()
    write(configFile(), allTrust())
    const read = fs.readFileSync.bind(fs)
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (file === configFile() || file === claudeFile())
        throw Object.assign(new Error('private-details'), { code: 'EACCES' })
      return read(file, ...args)
    })
    expect(agent()).toMatchObject({
      hooks: 'installed',
      approval: null,
      error: 'Cannot read Codex config.toml.'
    })
    expect(agent('claude').hooks).toBe('error')
    expect(JSON.stringify(status())).not.toContain('private-details')
  })

  it('finds the latest signal per agent, with only a boolean for the native inbox', () => {
    const report = (file, data) => json(join(sessionsDir, file), data)
    report('claude-old.json', {
      agent: 'claude',
      at: 100,
      source: 'SessionStart',
      inbox: 'private-pipe',
      inboxToken: 'SECRET',
      sessionId: 'PRIVATE-SESSION'
    })
    report('claude-new.json', { agent: 'claude', at: 200, source: 'Stop', cwd: 'PRIVATE-DIR' })
    report('codex.json', { agent: 'codex', at: 300, source: 'Stop', inbox: 'not-a-claude-inbox' })
    report('invalid.json', { agent: 'claude', at: '999', inbox: 'bad' })
    report('other.json', { agent: 'unknown', at: 999 })
    report('gemini.json', { agent: 'gemini', at: 400, source: 'AfterAgent' })
    report('unfinished.json.tmp', { agent: 'codex', at: 999 })
    report('.hidden.json', { agent: 'codex', at: 999 })
    write(join(sessionsDir, 'broken.json'), '{')
    const result = status()
    expect(result.agents[0]).toMatchObject({
      lastSignal: { paneId: 'claude-new', at: 200, source: 'Stop' },
      inbox: true
    })
    expect(result.agents[1]).toMatchObject({
      lastSignal: { paneId: 'codex', at: 300, source: 'Stop' },
      inbox: false
    })
    expect(result.agents[2]).toMatchObject({
      lastSignal: { paneId: 'gemini', at: 400, source: 'AfterAgent' },
      inbox: false,
      approval: null
    })
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET|PRIVATE|private-pipe|inboxToken|sessionId|cwd/
    )
  })

  it('reports Gemini missing events and does not accept Claude commands in their place', () => {
    install()
    expect(agent('gemini')).toMatchObject({ hooks: 'installed', approval: null })
    const config = JSON.parse(fs.readFileSync(geminiFile(), 'utf8'))
    delete config.hooks.AfterTool
    config.hooks.AfterAgent[0].hooks[0].command = `node "${scriptPath}" --hook`
    json(geminiFile(), config)
    expect(agent('gemini')).toMatchObject({
      hooks: 'partial',
      events: { SessionStart: true, BeforeAgent: true, AfterTool: false, AfterAgent: false }
    })
  })

  it('surfaces global or individual hook disables in Gemini', () => {
    install()
    const config = JSON.parse(fs.readFileSync(geminiFile(), 'utf8'))
    config.hooksConfig = { enabled: false }
    json(geminiFile(), config)
    expect(agent('gemini')).toMatchObject({ hooks: 'error', approval: null })
    config.hooksConfig = { disabled: [config.hooks.AfterAgent[0].hooks[0].command] }
    json(geminiFile(), config)
    expect(agent('gemini').error).toContain('disabled')
    config.hooksConfig = { disabled: ['an-unrelated-hook'] }
    json(geminiFile(), config)
    expect(agent('gemini')).toMatchObject({ hooks: 'installed', approval: null })
  })

  it('checks the exact OpenCode plugin without loading or modifying its source', () => {
    const file = join(home, '.config', 'opencode', 'plugins', 'tessel-team.js')
    expect(agent('opencode')).toMatchObject({ hooks: 'missing', events: { Plugin: false } })
    installOpencodePlugin(scriptPath, home, { node: NODE })
    expect(agent('opencode')).toMatchObject({ hooks: 'installed', events: { Plugin: true }, approval: null })
    write(file, opencodePlugin('C:\\old\\tessel-team-mcp.cjs', NODE))
    expect(agent('opencode')).toMatchObject({ hooks: 'partial', events: { Plugin: false } })
    write(file, `${OPENCODE_MARKER}\nthrow new Error('PRIVATE-PLUGIN-CONTENT')`)
    expect(agent('opencode').hooks).toBe('partial')
    const custom = "throw new Error('PRIVATE-PLUGIN-CONTENT')"
    write(file, custom)
    const writer = vi.spyOn(fs, 'writeFileSync')
    expect(agent('opencode').hooks).toBe('error')
    expect(JSON.stringify(agent('opencode'))).not.toContain('PRIVATE-PLUGIN-CONTENT')
    expect(writer).not.toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe(custom)
  })

  it('reports an OpenCode plugin read failure and still returns its last session signal', () => {
    const file = join(home, '.config', 'opencode', 'plugins', 'tessel-team.js')
    json(join(sessionsDir, 'opencode-pane.json'), { agent: 'opencode', at: 120, source: 'SessionStart' })
    const read = fs.readFileSync.bind(fs)
    vi.spyOn(fs, 'readFileSync').mockImplementation((path, ...args) => {
      if (path === file) throw Object.assign(new Error('PRIVATE-ERROR'), { code: 'EACCES' })
      return read(path, ...args)
    })
    expect(agent('opencode')).toMatchObject({ hooks: 'error', error: 'Cannot read OpenCode plugin.', lastSignal: { paneId: 'opencode-pane', at: 120, source: 'SessionStart' } })
  })

  it('does not hide installed hooks when session reports are unreadable', () => {
    install()
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('secret'), { code: 'EACCES' })
    })
    expect(
      status().agents.every(
        (a) =>
          a.hooks === (['kimi', 'opencode'].includes(a.id) || a.statusOnly ? 'missing' : 'installed') &&
          a.lastSignal === null &&
          a.error === 'Cannot read session reports.'
      )
    ).toBe(true)
  })
})
