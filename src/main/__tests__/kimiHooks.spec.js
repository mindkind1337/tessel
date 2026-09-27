// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, dirname, resolve, sep } from 'path'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { installKimiHooks, KIMI_HOOK_EVENTS } from '../teamInstall'
import { kimiConfigFile, kimiHookEvents } from '../kimiHooks'
import { hooksStatus } from '../teamHooksStatus'
import { ensureTeamChannel, pollTeamChannel } from '../teamChannel'
import { writeCurrentTeams } from '../teamNotices'
import {
  setJsonAgentServer,
  listJsonAgent,
  removeJsonAgentServer,
  teamToolsEntry,
  configToEntry
} from '../jsonAgents'

const require = createRequire(import.meta.url)
const server = join(__dirname, '..', 'teamMcp', 'server.cjs')
const mcp = require(server)
let home
const script = 'C:\\Tessel data\\tessel-team-mcp.cjs'
const accepted = async () => ({ ok: true })
const file = () => kimiConfigFile(home, '')
const put = (text) => {
  fs.mkdirSync(dirname(file()), { recursive: true })
  fs.writeFileSync(file(), text)
}
const install = (path = script, validate = accepted) =>
  installKimiHooks(path, home, { kimiHome: '', validate })

beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-kimi-test-'))
  vi.stubEnv('KIMI_CODE_HOME', '')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  const target = resolve(home)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-kimi-test-'))
    throw new Error('Unexpected cleanup path')
  fs.rmSync(target, { recursive: true, force: true })
})

describe('Kimi TOML installation and diagnostics', () => {
  it('creates only the three useful events, validates once and is idempotent', async () => {
    const validate = vi.fn(accepted)
    expect(await install(script, validate)).toEqual({ changed: true })
    const text = fs.readFileSync(file(), 'utf8')
    expect(kimiHookEvents(text, script)).toEqual(
      Object.fromEntries(KIMI_HOOK_EVENTS.map((e) => [e, true]))
    )
    expect(text).not.toContain('PostToolUse')
    expect(text).not.toContain('PreToolUse')
    expect(await install(script, validate)).toEqual({ changed: false })
    expect(validate).toHaveBeenCalledOnce()
  })

  it('preserves all user TOML and hooks byte-for-byte, backing up only once', async () => {
    const original =
      '# personal config\r\ndefault_model = "custom"\r\n[[hooks]]\r\nevent = "Stop"\r\ncommand = "personal-command"\r\n'
    put(original)
    expect(await install()).toEqual({ changed: true })
    expect(fs.readFileSync(file(), 'utf8').startsWith(original)).toBe(true)
    expect(fs.readFileSync(file() + '.before-tessel', 'utf8')).toBe(original)
    expect(await install('C:\\updated\\tessel-team-mcp.cjs')).toEqual({ changed: true })
    const updated = fs.readFileSync(file(), 'utf8')
    expect(updated.startsWith(original)).toBe(true)
    expect(updated).not.toContain('Tessel data')
    expect(updated.match(/tessel:team-hooks:start/g)).toHaveLength(1)
    expect(fs.readFileSync(file() + '.before-tessel', 'utf8')).toBe(original)
  })

  it('does not confuse markers inside a multiline string with its own block', async () => {
    const original =
      'instructions = """\n# tessel:team-hooks:start\n[[hooks]]\n# tessel:team-hooks:end\n"""\n'
    put(original)
    expect(await install()).toEqual({ changed: true })
    const text = fs.readFileSync(file(), 'utf8')
    expect(text.startsWith(original)).toBe(true)
    expect(Object.values(kimiHookEvents(text, script)).every(Boolean)).toBe(true)
  })

  it.each([
    '# tessel:team-hooks:start\n',
    '# tessel:team-hooks:end\n',
    'note = "unfinished',
    'values = [1, 2'
  ])('leaves incomplete or ambiguous TOML untouched (%#)', async (original) => {
    put(original)
    const validate = vi.fn(accepted)
    expect((await install(script, validate)).error).toBeTruthy()
    expect(fs.readFileSync(file(), 'utf8')).toBe(original)
    expect(validate).not.toHaveBeenCalled()
    expect(fs.existsSync(file() + '.before-tessel')).toBe(false)
  })

  it('does not erase a custom hook inserted inside our marked block', async () => {
    await install()
    const original = fs
      .readFileSync(file(), 'utf8')
      .replace('event = "Stop"', 'event = "Notification"')
    put(original)
    expect((await install()).error).toContain('custom changes')
    expect(fs.readFileSync(file(), 'utf8')).toBe(original)
  })

  it('leaves the original untouched when Kimi rejects the candidate', async () => {
    const original = 'hooks = []\n'
    put(original)
    expect((await install(script, async () => ({ ok: false }))).error).toBeTruthy()
    expect(fs.readFileSync(file(), 'utf8')).toBe(original)
    expect(fs.existsSync(file() + '.before-tessel')).toBe(false)
  })

  it('refuses to overwrite an edit made during asynchronous validation', async () => {
    put('# original\n')
    const result = await install(script, async () => {
      put('# newer user edit\n')
      return { ok: true }
    })
    expect(result.error).toContain('changed during validation')
    expect(fs.readFileSync(file(), 'utf8')).toBe('# newer user edit\n')
    expect(fs.existsSync(file() + '.before-tessel')).toBe(false)
  })

  it('does not overwrite an unreadable file or return its error details', async () => {
    const read = fs.readFileSync.bind(fs)
    vi.spyOn(fs, 'readFileSync').mockImplementation((path, ...args) => {
      if (path === file()) throw Object.assign(new Error('private-secret'), { code: 'EACCES' })
      return read(path, ...args)
    })
    const result = await install()
    expect(result.error).toBeTruthy()
    expect(JSON.stringify(result)).not.toContain('private-secret')
    expect(fs.existsSync(file())).toBe(false)
  })

  it('honors KIMI_CODE_HOME in installation and read-only diagnostics', async () => {
    vi.stubEnv('KIMI_CODE_HOME', join(home, 'custom-kimi'))
    expect(await installKimiHooks(script, home, { validate: accepted })).toEqual({ changed: true })
    expect(fs.existsSync(file())).toBe(false)
    const agent = hooksStatus({ home, scriptPath: script }).agents.find((a) => a.id === 'kimi')
    expect(agent).toMatchObject({ hooks: 'installed', approval: null, inbox: false })
    expect(fs.existsSync(kimiConfigFile(home))).toBe(true)
  })

  it('reports missing, partial and malformed managed hooks without exposing settings', async () => {
    const status = () =>
      hooksStatus({ home, scriptPath: script }).agents.find((a) => a.id === 'kimi')
    expect(status().hooks).toBe('missing')
    await install()
    put(fs.readFileSync(file(), 'utf8').replace('event = "Stop"', 'event = "Notification"'))
    expect(status()).toMatchObject({
      hooks: 'partial',
      events: { SessionStart: true, UserPromptSubmit: true, Stop: false }
    })
    put('# tessel:team-hooks:start\nPRIVATE_SECRET\n# tessel:team-hooks:end\n')
    expect(status().hooks).toBe('error')
    expect(JSON.stringify(status())).not.toContain('PRIVATE_SECRET')
  })
})

describe('Kimi MCP configuration', () => {
  it('preserves personal servers and fields and never pins the pane identity', () => {
    const file = join(home, '.kimi-code', 'mcp.json')
    fs.mkdirSync(dirname(file), { recursive: true })
    const original = {
      custom: 'keep',
      mcpServers: { personal: { command: 'other', env: { KEY: 'secret' } } }
    }
    fs.writeFileSync(file, JSON.stringify(original))
    const entry = teamToolsEntry('kimi', script)
    expect(entry).toEqual({ command: 'node', args: [script] })
    expect(setJsonAgentServer('kimi', 'tessel-team', entry, home)).toEqual({
      ok: true,
      changed: true
    })
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(config).toEqual({
      ...original,
      mcpServers: { ...original.mcpServers, 'tessel-team': entry }
    })
    expect(setJsonAgentServer('kimi', 'tessel-team', entry, home)).toEqual({
      ok: true,
      changed: false
    })
    expect(listJsonAgent('kimi', home).servers.map((s) => s.name)).toEqual([
      'personal',
      'tessel-team'
    ])
    expect(JSON.stringify(listJsonAgent('kimi', home))).not.toContain('secret')
    expect(removeJsonAgentServer('kimi', 'tessel-team', home).ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(original)
  })

  it('uses the overridden home and the Kimi HTTP transport schema', () => {
    const custom = join(home, 'custom')
    vi.stubEnv('KIMI_CODE_HOME', custom)
    const entry = configToEntry('kimi', {
      transport: 'http',
      url: 'https://example.test/mcp',
      headers: { Auth: 'private' }
    })
    expect(entry).toEqual({
      transport: 'http',
      url: 'https://example.test/mcp',
      headers: { Auth: 'private' }
    })
    expect(setJsonAgentServer('kimi', 'web', entry, home).ok).toBe(true)
    expect(fs.existsSync(join(custom, 'mcp.json'))).toBe(true)
    expect(fs.existsSync(join(home, '.kimi-code'))).toBe(false)
  })

  it.each(['{ invalid json', '{"mcpServers":[{"command":"keep"}]}'])(
    'refuses to erase an unreadable or invalid server map (%#)',
    (original) => {
      const file = join(home, '.kimi-code', 'mcp.json')
      fs.mkdirSync(dirname(file), { recursive: true })
      fs.writeFileSync(file, original)
      expect(
        setJsonAgentServer('kimi', 'tessel-team', teamToolsEntry('kimi', script), home).ok
      ).toBe(false)
      expect(fs.readFileSync(file, 'utf8')).toBe(original)
    }
  )
})

describe('Kimi hook wire protocol', () => {
  let dir, root, outbox
  const teamId = 'team-kimi'
  const sender = { id: 'sender', num: 1, title: 'Claude' }
  const receiver = { id: 'kimi-pane', num: 2, title: 'Kimi' }
  const context = () => ({
    root,
    meId: receiver.id,
    state: JSON.parse(fs.readFileSync(join(root, 'state.json'), 'utf8'))
  })
  beforeEach(() => {
    dir = join(home, 'project')
    fs.mkdirSync(dir)
    const ready = ensureTeamChannel({ dir, teamId, members: [sender, receiver] })
    root = join(dir, '.tessel', 'team-channel', teamId)
    outbox = ready.outboxes[0].outbox
    writeCurrentTeams({
      dir,
      panes: { [sender.id]: { team: teamId, num: 1 }, [receiver.id]: { team: teamId, num: 2 } }
    })
  })
  function send(text, name = 'message') {
    fs.writeFileSync(join(outbox, `${name}.json`), JSON.stringify({ to: '#2', text }))
    pollTeamChannel({ dir, teamId })
  }
  function hook(event, extra = {}) {
    return new Promise((done, reject) => {
      const child = spawn(process.execPath, [server, '--hook', '--kimi'], {
        cwd: dir,
        windowsHide: true,
        env: {
          ...process.env,
          TESSEL_PANE_ID: receiver.id,
          TESSEL_PROJECT_DIR: dir,
          TESSEL_SESSIONS_DIR: join(home, 'reports')
        }
      })
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (b) => {
        stdout += b
      })
      child.stderr.on('data', (b) => {
        stderr += b
      })
      child.on('error', reject)
      child.on('close', (code) => done({ code, stdout, stderr }))
      child.stdin.end(
        JSON.stringify({
          hook_event_name: event,
          session_id: 'kimi-session-123',
          cwd: dir,
          ...extra
        })
      )
    })
  }

  it.each(['SessionStart', 'PostToolUse', 'Notification', 'PreToolUse'])(
    'reports %s without consuming unread messages',
    async (event) => {
      send('Keep for a supported delivery event')
      expect(await hook(event)).toEqual({ code: 0, stdout: '', stderr: '' })
      expect(mcp.unread(context())).toHaveLength(1)
      expect(
        JSON.parse(fs.readFileSync(join(home, 'reports', 'kimi-pane.json'), 'utf8'))
      ).toMatchObject({ agent: 'kimi', sessionId: 'kimi-session-123' })
    }
  )

  it('adds plain context at prompt submission, with the board reminder', async () => {
    send('Answer this prompt message')
    const result = await hook('UserPromptSubmit')
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Answer this prompt message')
    expect(result.stdout).toContain('team_task_add')
    expect(result.stdout).not.toContain('hookSpecificOutput')
    expect(mcp.readInbox(context())).toBe('')
  })

  it('continues at Stop with exit 2 and the full message on stderr, only once', async () => {
    send('Please continue\nwith the second line')
    const result = await hook('Stop', { stop_hook_active: false })
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Please continue\nwith the second line')
    expect(mcp.readInbox(context())).toBe('')
    expect(await hook('Stop', { stop_hook_active: false })).toEqual({
      code: 0,
      stdout: '',
      stderr: ''
    })
  })

  it('does not read a new message from an already continued Stop or subagent', async () => {
    send('For the main agent next time')
    expect(await hook('Stop', { stop_hook_active: true })).toEqual({
      code: 0,
      stdout: '',
      stderr: ''
    })
    expect(await hook('UserPromptSubmit', { agent_id: 'subagent' })).toEqual({
      code: 0,
      stdout: '',
      stderr: ''
    })
    expect(mcp.unread(context())).toHaveLength(1)
  })

  it('persists the fallback guard when stop_hook_active is absent, reset by a user prompt', async () => {
    send('first')
    expect((await hook('Stop')).code).toBe(2)
    send('second', 'second')
    expect(await hook('Stop')).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(mcp.unread(context())).toHaveLength(1)
    expect((await hook('UserPromptSubmit')).stdout).toContain('second')
    send('third', 'third')
    expect((await hook('Stop')).stderr).toContain('third')
  })

  it('allows only one concurrent Stop reader to claim the message', async () => {
    send('Exactly one Kimi reader')
    const results = await Promise.all([hook('Stop'), hook('Stop')])
    expect(
      results.filter((r) => r.code === 2 && r.stderr.includes('Exactly one Kimi reader'))
    ).toHaveLength(1)
    expect(mcp.readInbox(context())).toBe('')
  }, 20000)

  it('does not announce or acknowledge delivery when ack publication fails', async () => {
    send('Keep unread')
    fs.writeFileSync(join(root, 'acks'), 'blocked')
    expect(await hook('Stop', { stop_hook_active: false })).toEqual({
      code: 0,
      stdout: '',
      stderr: ''
    })
    expect(mcp.unread(context())).toHaveLength(1)
  })
})
