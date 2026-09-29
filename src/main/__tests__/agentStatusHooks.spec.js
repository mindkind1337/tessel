// @vitest-environment node
// Status hooks for the other agents: installed only in temporary fake homes,
// the hook script run as the agents would run it, no real agent CLI started.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { dirname, join, resolve, sep } from 'path'
import { spawn } from 'child_process'
import { pathToFileURL } from 'url'
import { createRequire } from 'module'
import { transformSync } from 'rolldown/experimental'
import {
  installStatusHooks,
  removeStatusHooks,
  statusHooksInstallation,
  statusCommand,
  STATUS_HOOKS,
  STATUS_HOOK_AGENTS,
  PLUGIN_MARKER
} from '../agentStatusHooks'
import { prepareAgentStateHooks } from '../agentStateSetup'
import { opencodePlugin, COPILOT_HOOK_EVENTS, GEMINI_HOOK_EVENTS } from '../teamInstall'
import { createAgentStateStore } from '../agentStateStore'
import { ensureTeamChannel, pollTeamChannel } from '../teamChannel'
import { writeCurrentTeams } from '../teamNotices'

const require = createRequire(import.meta.url)
const script = join(__dirname, '..', 'teamMcp', 'server.cjs')
const mcp = require(script)
const launchToken = 'b'.repeat(32)
let dir, home
const statusDir = () => join(dir, 'status')
const reports = () =>
  fs.existsSync(join(statusDir(), 'events'))
    ? fs
        .readdirSync(join(statusDir(), 'events'))
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(join(statusDir(), 'events', f), 'utf8')))
        .sort((a, b) => a.at - b.at)
    : []
const paneEnv = (provider) => ({
  TESSEL_PANE_ID: 'pane-status',
  TESSEL_PROJECT_DIR: dir,
  TESSEL_SESSIONS_DIR: join(dir, 'sessions'),
  TESSEL_AGENT_STATE_DIR: statusDir(),
  TESSEL_AGENT_PROVIDER: provider,
  TESSEL_AGENT_LAUNCH: launchToken
})
function runHook(args, payload, env = {}) {
  return new Promise((done, fail) => {
    const clean = { ...process.env }
    for (const key of Object.keys(clean)) if (/^TESSEL_/i.test(key)) delete clean[key]
    const child = spawn(process.execPath, [script, '--hook', ...args], { cwd: dir, windowsHide: true, env: { ...clean, ...env } })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error('Hook fixture timed out'))
    }, 8000)
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('error', fail)
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, out, err })
    })
    child.stdin.end(JSON.stringify({ cwd: dir, ...payload }))
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-status-hooks-'))
  home = join(dir, 'home')
  fs.mkdirSync(home)
})
afterEach(() => {
  vi.unstubAllEnvs()
  const target = resolve(dir)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-status-hooks-'))
    throw new Error('Unsafe fixture path')
  fs.rmSync(target, { recursive: true, force: true })
})

const JSON_AGENTS = STATUS_HOOK_AGENTS.filter((a) => STATUS_HOOKS[a].shape !== 'plugin')
const scriptPath = 'C:\\Tessel data\\tessel-team-mcp.cjs'
const put = (file, value) => {
  fs.mkdirSync(dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

describe('installing status hooks in the agents’ own files', () => {
  it.each(JSON_AGENTS)('%s: merges with the user’s hooks, is idempotent, and removes only its own', (agent) => {
    const spec = STATUS_HOOKS[agent]
    const file = spec.file(home, {})
    const event = spec.events[0]
    const theirs = spec.shape === 'flat' ? { command: 'mine.cmd' } : { matcher: '', hooks: [{ type: 'command', command: 'mine.cmd' }] }
    const user = spec.shape === 'bundle' ? { other: { [event]: [theirs] }, [spec.bundle]: { [event]: [theirs] }, model: 'x' } : { model: 'x', hooks: { [event]: [theirs], Custom: [theirs] } }
    put(file, user)
    expect(installStatusHooks(agent, scriptPath, { home, env: {} })).toEqual({ changed: true })
    const saved = read(file)
    expect(saved.model).toBe('x')
    const table = spec.shape === 'bundle' ? saved[spec.bundle] : saved.hooks
    if (spec.shape === 'bundle') expect(saved.other).toEqual(user.other)
    else expect(saved.hooks.Custom).toEqual([theirs])
    expect(table[event][0]).toEqual(theirs)
    for (const e of spec.events) expect(JSON.stringify(table[e])).toContain(JSON.stringify(statusCommand(scriptPath, agent, e)).slice(1, -1))
    expect(fs.readFileSync(`${file}.before-tessel`, 'utf8')).toBe(JSON.stringify(user))
    expect(installStatusHooks(agent, scriptPath, { home, env: {} })).toEqual({ changed: false })
    expect(statusHooksInstallation(agent, scriptPath, { home, env: {} })).toMatchObject({ id: agent, hooks: 'installed', statusOnly: true })
    // A newer script path replaces Tessel's entries, never adds a second one.
    expect(installStatusHooks(agent, 'C:\\new\\tessel-team-mcp.cjs', { home, env: {} })).toEqual({ changed: true })
    expect(fs.readFileSync(file, 'utf8')).not.toContain('Tessel data')
    expect(statusHooksInstallation(agent, scriptPath, { home, env: {} }).hooks).toBe('missing')
    expect(removeStatusHooks(agent, { home, env: {} })).toEqual({ changed: true })
    const after = read(file)
    expect(fs.readFileSync(file, 'utf8')).not.toContain('tessel-team-mcp.cjs')
    expect(after.model).toBe('x')
    expect((spec.shape === 'bundle' ? after[spec.bundle] : after.hooks)[event]).toEqual([theirs])
    expect(removeStatusHooks(agent, { home, env: {} })).toEqual({ changed: false })
  })

  it.each(JSON_AGENTS)('%s: an unreadable file, or hooks of another shape, is left untouched', (agent) => {
    const spec = STATUS_HOOKS[agent]
    const file = spec.file(home, {})
    put(file, '{broken')
    expect(installStatusHooks(agent, scriptPath, { home, env: {} }).error).toBeTruthy()
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken')
    expect(statusHooksInstallation(agent, scriptPath, { home, env: {} })).toMatchObject({ hooks: 'error' })
    const odd = { [spec.shape === 'bundle' ? spec.bundle : 'hooks']: ['not', 'a', 'table'] }
    put(file, odd)
    expect(installStatusHooks(agent, scriptPath, { home, env: {} }).error).toBeTruthy()
    expect(read(file)).toEqual(odd)
  })

  it('Cursor: its flat schema, version 1, and none of its permission gates', () => {
    expect(installStatusHooks('cursor', scriptPath, { home, env: {} })).toEqual({ changed: true })
    const saved = read(join(home, '.cursor', 'hooks.json'))
    expect(saved.version).toBe(1)
    expect(saved.hooks.stop).toEqual([{ command: statusCommand(scriptPath, 'cursor', 'stop') }])
    for (const gate of ['preToolUse', 'beforeShellExecution', 'beforeMCPExecution']) expect(saved.hooks[gate]).toBeUndefined()
  })

  it('Antigravity: its own bundle, and never PreToolUse (silence there refuses the tool)', () => {
    installStatusHooks('antigravity', scriptPath, { home, env: {} })
    const saved = read(join(home, '.gemini', 'config', 'hooks.json'))
    expect(Object.keys(saved)).toEqual(['tessel-status'])
    expect(saved['tessel-status'].PreToolUse).toBeUndefined()
    expect(saved['tessel-status'].PostToolUse[0]).toMatchObject({ matcher: '*' })
    expect(saved['tessel-status'].Stop[0]).toMatchObject({ type: 'command', command: statusCommand(scriptPath, 'antigravity', 'Stop') })
  })

  it('Grok: its own file under GROK_HOME, removed whole', () => {
    const grokHome = join(dir, 'grok-home')
    expect(installStatusHooks('grok', scriptPath, { home, env: { GROK_HOME: grokHome } })).toEqual({ changed: true })
    const file = join(grokHome, 'hooks', 'tessel-status.json')
    expect(read(file).hooks.PreToolUse[0].matcher).toBe('.*')
    expect(fs.existsSync(join(home, '.grok'))).toBe(false)
    expect(removeStatusHooks('grok', { home, env: { GROK_HOME: grokHome } })).toEqual({ changed: true })
    expect(fs.existsSync(file)).toBe(false)
  })

  it.each(['amp', 'pi'])('%s: a file of Tessel’s own, never over the user’s', (agent) => {
    const file = STATUS_HOOKS[agent].file(home, {})
    expect(installStatusHooks(agent, scriptPath, { home, env: {} })).toEqual({ changed: true })
    expect(fs.readFileSync(file, 'utf8').startsWith(PLUGIN_MARKER)).toBe(true)
    expect(installStatusHooks(agent, scriptPath, { home, env: {} })).toEqual({ changed: false })
    expect(statusHooksInstallation(agent, scriptPath, { home, env: {} })).toMatchObject({ hooks: 'installed', events: { Plugin: true } })
    expect(removeStatusHooks(agent, { home, env: {} })).toEqual({ changed: true })
    expect(fs.existsSync(file)).toBe(false)
    put(file, '// my own plugin')
    expect(installStatusHooks(agent, scriptPath, { home, env: {} }).error).toBeTruthy()
    expect(removeStatusHooks(agent, { home, env: {} })).toEqual({ changed: false })
    expect(fs.readFileSync(file, 'utf8')).toBe('// my own plugin')
    expect(statusHooksInstallation(agent, scriptPath, { home, env: {} }).hooks).toBe('error')
  })

  it('Pi: its extension goes where PI_CODING_AGENT_DIR says', () => {
    const agentDir = join(dir, 'pi-agent')
    installStatusHooks('pi', scriptPath, { home, env: { PI_CODING_AGENT_DIR: agentDir } })
    expect(fs.existsSync(join(agentDir, 'extensions', 'tessel-status.ts'))).toBe(true)
    expect(fs.existsSync(join(home, '.pi'))).toBe(false)
  })

  it('refuses a script path it cannot quote safely', () => {
    expect(installStatusHooks('droid', 'C:\\a"b\\tessel-team-mcp.cjs', { home, env: {} }).error).toBeTruthy()
    expect(fs.existsSync(join(home, '.factory'))).toBe(false)
  })
})

describe('prepareAgentStateHooks for every status agent', () => {
  const source = fs.readFileSync(script, 'utf8')
  const prepare = (provider, extra = {}) =>
    prepareAgentStateHooks({ provider, env: {}, home, sharedDir: join(dir, 'shared'), source, ...extra })
  it.each(['gemini', 'copilot', 'opencode', ...STATUS_HOOK_AGENTS])('%s: installs in the fake home', async (provider) => {
    expect(await prepare(provider)).toMatchObject({ ok: true, supported: true, changed: true })
    expect(await prepare(provider)).toMatchObject({ ok: true, changed: false })
  })
  it('kimi: checked by Kimi before it is written', async () => {
    const kimiValidate = vi.fn(async () => ({ ok: true }))
    expect(await prepare('kimi', { kimiValidate, env: { KIMI_CODE_HOME: join(dir, 'kimi') } })).toMatchObject({ ok: true, changed: true })
    expect(kimiValidate).toHaveBeenCalledOnce()
    expect(fs.readFileSync(join(dir, 'kimi', 'config.toml'), 'utf8')).toContain('PermissionRequest')
  })
  it('an older shared script without the new agents is not trusted for them', async () => {
    fs.mkdirSync(join(dir, 'shared'))
    fs.writeFileSync(join(dir, 'shared', 'tessel-team-mcp.cjs'), "const VERSION = '99.0.0'\nconst AGENT_STATE_PROTOCOL = 1\n")
    expect(await prepare('cursor')).toMatchObject({ ok: false })
    expect(fs.existsSync(join(home, '.cursor'))).toBe(false)
  })
  it('an agent without status hooks is not supported', async () => {
    expect(await prepare('aider')).toEqual({ ok: true, supported: false })
  })
})

describe('the hook script turns each agent’s events into status events', () => {
  const cases = [
    ['gemini', ['--gemini'], { hook_event_name: 'BeforeTool', session_id: 'gem-session-1' }, 'PreToolUse'],
    ['gemini', ['--gemini'], { hook_event_name: 'Notification', notification_type: 'ToolPermission', session_id: 'gem-session-1' }, 'Notification'],
    ['copilot', ['--copilot', '--event=PreToolUse'], { sessionId: 'cop-session-1', toolName: 'ask_user' }, 'PreToolUse'],
    ['kimi', ['--kimi'], { hook_event_name: 'PermissionRequest', session_id: 'kimi-session-1' }, 'Notification'],
    ['cursor', ['--agent=cursor', '--event=beforeSubmitPrompt'], { conversation_id: 'cur-conv-1' }, 'UserPromptSubmit'],
    ['cursor', ['--agent=cursor', '--event=stop'], { conversation_id: 'cur-conv-1', status: 'aborted' }, 'Interrupt'],
    ['droid', ['--agent=droid', '--event=Notification'], { session_id: 'droid-session', message: 'Droid is waiting for your input' }, 'Stop'],
    ['grok', ['--agent=grok', '--event=Stop'], { sessionId: 'grok-session', backgroundTasks: [{ type: 'subagent' }] }, 'PostToolUse'],
    ['grok', ['--agent=grok', '--event=Notification'], { sessionId: 'grok-session', notificationType: 'idle_prompt' }, 'Stop'],
    ['antigravity', ['--agent=antigravity', '--event=Stop'], { fullyIdle: false }, 'PostToolUse'],
    ['antigravity', ['--agent=antigravity', '--event=PreInvocation'], {}, 'UserPromptSubmit'],
    ['openclaude', ['--agent=openclaude', '--event=UserPromptSubmit'], { session_id: 'oc-session-1', prompt: 'PRIVATE' }, 'UserPromptSubmit'],
    ['commandcode', ['--agent=commandcode', '--event=Stop'], { session_id: 'cc-session-1' }, 'Stop']
  ]
  it.each(cases)('%s %j -> %s', async (provider, args, payload, event) => {
    const result = await runHook(args, payload, paneEnv(provider))
    expect(result.code).toBe(0)
    expect(result.err).toBe('')
    const [report] = reports()
    expect(report).toMatchObject({ provider, event, launchToken, source: 'hook', paneId: 'pane-status' })
    expect(JSON.stringify(reports())).not.toMatch(/PRIVATE/)
  })
  it('an agent with no conversation id gets one per launch', async () => {
    await runHook(['--agent=antigravity', '--event=PreInvocation'], {}, paneEnv('antigravity'))
    expect(reports()[0].sessionId).toBe(`launch-${launchToken.slice(0, 16)}`)
  })
  it('ignores events with no status meaning, and Grok sub-agents’ own sessions', async () => {
    await runHook(['--agent=cursor', '--event=afterAgentResponse'], { conversation_id: 'cur-conv-1' }, paneEnv('cursor'))
    await runHook(['--agent=grok', '--event=Stop'], { sessionId: 'grok-child', subagentType: 'explore' }, paneEnv('grok'))
    await runHook(['--agent=grok', '--event=Notification'], { sessionId: 'g-session', notificationType: 'permission_prompt', message: 'Tool permission requested' }, paneEnv('grok'))
    expect(reports()).toEqual([])
  })
  it('Copilot sub-agents are reported as children (its name identifies each)', async () => {
    await runHook(['--copilot', '--event=subagentStart'], { sessionId: 'cop-session-1', agentName: 'explore' }, paneEnv('copilot'))
    expect(reports()[0]).toMatchObject({ event: 'SubagentStart', agentId: 'explore', sessionId: 'cop-session-1' })
  })
  it('Cursor gets the answer it waits for, in a Tessel pane or not, and nothing else', async () => {
    expect((await runHook(['--agent=cursor', '--event=beforeSubmitPrompt'], {})).out).toBe('{"continue":true}')
    expect((await runHook(['--agent=cursor', '--event=stop'], {}, paneEnv('cursor'))).out).toBe('')
  })
  it('status needs the pane’s own launch: another provider or no token writes nothing', async () => {
    await runHook(['--agent=droid', '--event=Stop'], { session_id: 'droid-session' }, { ...paneEnv('droid'), TESSEL_AGENT_PROVIDER: 'claude' })
    await runHook(['--agent=droid', '--event=Stop'], { session_id: 'droid-session' }, { ...paneEnv('droid'), TESSEL_AGENT_LAUNCH: '' })
    await runHook(['--agent=unknown', '--event=Stop'], { session_id: 'droid-session' }, paneEnv('unknown'))
    expect(reports()).toEqual([])
  })
  it('status-only hooks never take team messages', async () => {
    const A = { id: 'pane-a', num: 1, title: 'A' }
    const B = { id: 'pane-status', num: 2, title: 'B' }
    expect(ensureTeamChannel({ dir, teamId: 'team-1', members: [A, B] }).ok).toBe(true)
    writeCurrentTeams({ dir, panes: { [A.id]: { team: 'team-1', num: 1 }, [B.id]: { team: 'team-1', num: 2 } } })
    vi.stubEnv('TESSEL_PANE_ID', A.id)
    vi.stubEnv('TESSEL_PROJECT_DIR', dir)
    expect(mcp.send(mcp.locate(), '#2', 'hello').ok).toBe(true)
    pollTeamChannel({ dir, teamId: 'team-1' })
    vi.stubEnv('TESSEL_PANE_ID', B.id)
    const before = mcp.unread(mcp.locate()).filter((m) => m.text).length
    expect(before).toBe(1)
    const out = await runHook(['--opencode', '--status'], { hook_event_name: 'Stop', session_id: 'oc-session-12' }, paneEnv('opencode'))
    expect(out.out).toBe('')
    await runHook(['--agent=droid', '--event=Stop'], { session_id: 'droid-session' }, paneEnv('droid'))
    expect(mcp.unread(mcp.locate()).filter((m) => m.text)).toHaveLength(before)
  })
  it('the store takes them for the launch they belong to, and ends the turn idle', async () => {
    const store = createAgentStateStore({ dir: statusDir() })
    try {
      await store.register({ paneId: 'pane-status', provider: 'droid', launchToken, startedAt: Date.now() - 1000 })
      await runHook(['--agent=droid', '--event=UserPromptSubmit'], { session_id: 'droid-session' }, paneEnv('droid'))
      let snap = (await store.scan()).states['pane-status']
      expect(snap).toMatchObject({ state: 'working', hookSeen: true, confirmed: true })
      await runHook(['--agent=droid', '--event=Stop'], { session_id: 'droid-session' }, paneEnv('droid'))
      snap = (await store.scan()).states['pane-status']
      expect(snap).toMatchObject({ state: 'idle', reason: 'ready' })
    } finally {
      await store.dispose()
    }
  })
  it('the installed event lists include the status events', () => {
    expect(GEMINI_HOOK_EVENTS).toEqual(expect.arrayContaining(['BeforeTool', 'Notification', 'SessionEnd']))
    expect(COPILOT_HOOK_EVENTS).toEqual(expect.arrayContaining(['UserPromptSubmit', 'PreToolUse', 'Notification', 'subagentStart', 'SubagentStop']))
    expect(mcp.AGENT_STATUS_AGENTS).toBeGreaterThanOrEqual(2)
  })
})

// The plugins and extensions run as their agent would load them, with a fake
// agent API; their events go through the real hook script into the spool.
describe('plugins and extensions report through the hook script', () => {
  const waitFor = async (test) => {
    for (let i = 0; i < 200; i++) {
      if (test()) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('timed out: ' + JSON.stringify(reports().map((r) => r.event)))
  }
  async function load(source, name) {
    const js = name.endsWith('.ts') ? transformSync(name, source).code : source
    const file = join(dir, name.replace(/\.ts$/, '.mjs'))
    fs.writeFileSync(file, js)
    return import(pathToFileURL(file).href)
  }
  const stubPane = (provider) => {
    for (const [key, value] of Object.entries(paneEnv(provider))) vi.stubEnv(key, value)
    vi.stubEnv('TESSEL_TEAM_SECRET', '')
  }

  it('Pi: session, turn, tools, and a sub-agent holding the turn open', async () => {
    stubPane('pi')
    vi.stubEnv('TESSEL_PI_STATUS_OWNER', '')
    const mod = await load(STATUS_HOOKS.pi.source(script), 'pi-status.ts')
    const handlers = {}
    const bus = {}
    const pi = { on: (name, fn) => (handlers[name] = fn), events: { on: (name, fn) => (bus[name] = fn) } }
    mod.default(pi)
    const ctx = { sessionManager: { getSessionId: () => 'pi-session-1' }, isIdle: () => true }
    handlers.session_start({}, ctx)
    handlers.agent_start({}, ctx)
    handlers.tool_execution_start({ toolName: 'bash', args: { secret: 'PRIVATE' } }, ctx)
    bus['subagent:async-started']({ id: 'run-7' })
    handlers.agent_end({}, ctx)
    await waitFor(() => reports().length >= 5)
    await new Promise((r) => setTimeout(r, 300))
    expect(reports().map((r) => r.event)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SubagentStart', 'PreToolUse'])
    bus['subagent:async-complete']({ id: 'run-7' })
    await waitFor(() => reports().length >= 7)
    const all = reports()
    expect(all.slice(5).map((r) => r.event)).toEqual(['SubagentStop', 'Stop'])
    expect(all[3]).toMatchObject({ agentId: 'pi-run-7', sessionId: 'pi-session-1' })
    expect(JSON.stringify(all)).not.toMatch(/PRIVATE/)
    expect(process.env.TESSEL_PI_STATUS_OWNER).toBe(String(process.pid))
  })

  it('Amp: its thread, its turn and its end', async () => {
    stubPane('amp')
    const mod = await load(STATUS_HOOKS.amp.source(script), 'amp-status.ts')
    const handlers = {}
    mod.default({ on: (name, fn) => (handlers[name] = fn) })
    handlers['session.start']({ thread: { id: 'T-thread-0001' } })
    handlers['agent.start']({ thread: { id: 'T-thread-0001' }, message: 'PRIVATE' })
    handlers['tool.result']({ thread: { id: 'T-thread-0001' }, output: 'PRIVATE' })
    handlers['agent.end']({ thread: { id: 'T-thread-0001' }, status: 'cancelled' })
    await waitFor(() => reports().length >= 4)
    expect(reports().map((r) => r.event)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Interrupt'])
    expect(reports()[0]).toMatchObject({ sessionId: 'T-thread-0001', startSource: 'clear', provider: 'amp' })
    expect(JSON.stringify(reports())).not.toMatch(/PRIVATE/)
  })

  it('OpenCode: busy and idle, and a permission until it is answered', async () => {
    stubPane('opencode')
    const mod = await load(opencodePlugin(script), 'opencode-status.mjs')
    const plugin = await mod.TesselTeam({ client: { session: {} }, directory: dir })
    const send = (type, properties) => plugin.event({ event: { type, properties } })
    await send('session.created', { info: { id: 'ses_root_001' } })
    await send('session.status', { sessionID: 'ses_root_001', status: { type: 'busy' } })
    await send('permission.asked', { id: 'per_1', sessionID: 'ses_child_9' })
    await send('permission.replied', { id: 'per_1', sessionID: 'ses_child_9' })
    await send('session.status', { sessionID: 'ses_root_001', status: { type: 'idle' } })
    await send('session.idle', { sessionID: 'ses_root_001' })
    await waitFor(() => reports().length >= 5)
    await new Promise((r) => setTimeout(r, 300))
    expect(reports().map((r) => r.event)).toEqual(['SessionStart', 'UserPromptSubmit', 'Elicitation', 'ElicitationResult', 'Stop'])
    expect(reports()[2]).toMatchObject({ toolId: 'per_1', sessionId: 'ses_root_001' })
  })
})
