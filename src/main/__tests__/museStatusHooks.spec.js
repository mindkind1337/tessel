// @vitest-environment node
// Muse Code's status hooks: Tessel's own managed hooks file, named by Muse's
// settings.json with the pane's variables (its hooks run with a cleared
// environment), installed only in temporary fake homes; the hook script run
// as Muse would run it, with payloads shaped like Muse's (its hooks guide).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { dirname, join, resolve, sep } from 'path'
import { spawn } from 'child_process'
import { installStatusHooks, removeStatusHooks, statusHooksInstallation, statusCommand, STATUS_HOOKS } from '../agentStatusHooks'
import { MUSE_HOOK_ENV } from '../museHooks'
import { museSettingsFile } from '../museSessions'
import { prepareAgentStateHooks } from '../agentStateSetup'
import { createAgentStateStore } from '../agentStateStore'

const script = join(__dirname, '..', 'teamMcp', 'server.cjs')
const launchToken = 'c'.repeat(32)
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const scriptPath = 'C:\\TesselData\\tessel-team-mcp.cjs'
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
const paneEnv = () => ({
  TESSEL_PANE_ID: 'pane-muse',
  TESSEL_PROJECT_DIR: dir,
  TESSEL_SESSIONS_DIR: join(dir, 'sessions'),
  TESSEL_AGENT_STATE_DIR: statusDir(),
  TESSEL_AGENT_PROVIDER: 'muse',
  TESSEL_AGENT_LAUNCH: launchToken
})
function runHook(event, payload, env = {}) {
  return new Promise((done, fail) => {
    const clean = { ...process.env }
    for (const key of Object.keys(clean)) if (/^(TESSEL_|MUSE_)/i.test(key)) delete clean[key]
    const child = spawn(process.execPath, [script, '--hook', '--agent=muse', `--event=${event}`], { cwd: dir, windowsHide: true, env: { ...clean, ...env } })
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
    // What Muse writes on a hook's stdin (Hook events and payloads).
    child.stdin.end(JSON.stringify({ hook_event_name: event, cwd: dir, transcript_path: null, model: 'muse-spark-1.3', permission_mode: 'default', ...payload }))
  })
}
const put = (file, value) => {
  fs.mkdirSync(dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-muse-hooks-'))
  home = join(dir, 'home')
  fs.mkdirSync(home)
})
afterEach(() => {
  const target = resolve(dir)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-muse-hooks-')) throw new Error('Unsafe fixture path')
  fs.rmSync(target, { recursive: true, force: true })
})

describe("Muse Code's managed hooks file", () => {
  const hooksFile = () => STATUS_HOOKS.muse.file(home, {})
  const settingsFile = () => museSettingsFile(home)

  it("Tessel's own file next to Muse's settings, which name it with the pane's variables; the user's settings kept", () => {
    const user = { schema_version: 1, mcpServers: { docs: { command: 'docs-mcp' } }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] }, managed_hooks_env_vars: ['CI_TOKEN'] }
    put(settingsFile(), user)
    expect(installStatusHooks('muse', scriptPath, { home, env: {}, node: NODE })).toEqual({ changed: true })
    expect(hooksFile()).toBe(join(home, '.config', 'muse', 'tessel-status-hooks.json'))
    const saved = read(settingsFile())
    expect(saved).toMatchObject({ schema_version: 1, mcpServers: user.mcpServers, hooks: user.hooks, managed_hooks_path: resolve(hooksFile()) })
    expect(saved.managed_hooks_env_vars).toEqual(['CI_TOKEN', ...MUSE_HOOK_ENV])
    // The settings-level shape: event -> [{ hooks: [{ type, command, timeout }] }], no matcher.
    const hooks = read(hooksFile()).hooks
    expect(Object.keys(hooks)).toEqual(STATUS_HOOKS.muse.events)
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: statusCommand(scriptPath, 'muse', 'Stop', NODE), timeout: 30 }] }])
    expect(JSON.stringify(hooks)).not.toContain('PermissionRequest')
    expect(fs.readFileSync(`${settingsFile()}.before-tessel`, 'utf8')).toBe(JSON.stringify(user))
    expect(installStatusHooks('muse', scriptPath, { home, env: {}, node: NODE })).toEqual({ changed: false })
    expect(statusHooksInstallation('muse', scriptPath, { home, env: {}, node: NODE })).toMatchObject({ id: 'muse', hooks: 'installed', statusOnly: true })
    // Removed: Tessel's file, its pointer and its variables only.
    expect(removeStatusHooks('muse', { home, env: {} })).toEqual({ changed: true })
    expect(fs.existsSync(hooksFile())).toBe(false)
    expect(fs.existsSync(`${settingsFile()}.before-tessel`)).toBe(false)
    expect(fs.existsSync(join(home, '.config', 'muse', 'tessel-status-hooks.added.json'))).toBe(false)
    expect(read(settingsFile())).toEqual(user)
  })

  it('Interrupt declares async: true (Muse 1.4.10 rejects a synchronous cancellation hook); an older install is rewritten', () => {
    expect(installStatusHooks('muse', scriptPath, { home, env: {}, node: NODE })).toEqual({ changed: true })
    const hooks = read(hooksFile()).hooks
    expect(hooks.Interrupt).toEqual([{ hooks: [{ type: 'command', command: statusCommand(scriptPath, 'muse', 'Interrupt', NODE), timeout: 30, async: true }] }])
    // Only Interrupt: every other event Muse waits on stays synchronous.
    for (const event of STATUS_HOOKS.muse.events.filter((e) => e !== 'Interrupt')) expect(hooks[event][0].hooks[0]).not.toHaveProperty('async')
    // What an older Tessel wrote (no async): stale, so the next start rewrites it.
    const old = { hooks: { ...hooks, Interrupt: [{ hooks: [{ type: 'command', command: statusCommand(scriptPath, 'muse', 'Interrupt', NODE), timeout: 30 }] }] } }
    put(hooksFile(), old)
    expect(statusHooksInstallation('muse', scriptPath, { home, env: {}, node: NODE }).hooks).toBe('partial')
    expect(installStatusHooks('muse', scriptPath, { home, env: {}, node: NODE })).toEqual({ changed: true })
    expect(read(hooksFile()).hooks.Interrupt[0].hooks[0].async).toBe(true)
    expect(read(hooksFile()).hooks.Interrupt).toHaveLength(1)
    expect(installStatusHooks('muse', scriptPath, { home, env: {}, node: NODE })).toEqual({ changed: false })
  })

  it('only what Tessel added is taken out again: a variable name or a pointer that was there before stays', () => {
    // The user already pointed Muse at Tessel's file and named TESSEL_REMOTE (any case).
    const user = { schema_version: 1, managed_hooks_path: resolve(hooksFile()), managed_hooks_env_vars: ['tessel_remote', 'CI_TOKEN'] }
    put(settingsFile(), user)
    expect(installStatusHooks('muse', scriptPath, { home, env: {}, node: NODE })).toEqual({ changed: true })
    const saved = read(settingsFile())
    expect(saved.managed_hooks_env_vars).toEqual(['tessel_remote', 'CI_TOKEN', ...MUSE_HOOK_ENV.filter((n) => n !== 'TESSEL_REMOTE')])
    expect(read(join(home, '.config', 'muse', 'tessel-status-hooks.added.json'))).toEqual({ pointer: false, envVars: MUSE_HOOK_ENV.filter((n) => n !== 'TESSEL_REMOTE') })
    // Installed again (Tessel restarted): still only its own names noted.
    expect(installStatusHooks('muse', scriptPath, { home, env: {}, node: NODE })).toEqual({ changed: false })
    expect(read(join(home, '.config', 'muse', 'tessel-status-hooks.added.json')).envVars).not.toContain('TESSEL_REMOTE')
    expect(removeStatusHooks('muse', { home, env: {} })).toEqual({ changed: true })
    expect(read(settingsFile())).toEqual(user)
  })

  it('a name the user adds after Tessel installed is theirs to keep', () => {
    expect(installStatusHooks('muse', scriptPath, { home, env: {}, node: NODE })).toEqual({ changed: true })
    const saved = read(settingsFile())
    put(settingsFile(), { ...saved, managed_hooks_env_vars: [...saved.managed_hooks_env_vars, 'MY_VAR'] })
    expect(removeStatusHooks('muse', { home, env: {} })).toEqual({ changed: true })
    expect(read(settingsFile())).toEqual({ schema_version: 1, managed_hooks_env_vars: ['MY_VAR'] })
  })

  it('a new settings file gets the schema_version Muse needs to start', () => {
    expect(installStatusHooks('muse', scriptPath, { home, env: {}, node: NODE })).toEqual({ changed: true })
    expect(read(settingsFile())).toEqual({ schema_version: 1, managed_hooks_path: resolve(hooksFile()), managed_hooks_env_vars: MUSE_HOOK_ENV })
  })

  it("another managed file (an administrator's, another app's) is never replaced: nothing is written", () => {
    const user = { schema_version: 1, managed_hooks_path: 'managed-hooks.json' }
    put(settingsFile(), user)
    const res = installStatusHooks('muse', scriptPath, { home, env: {}, node: NODE })
    expect(res.error).toMatch(/managed-hooks\.json/)
    expect(read(settingsFile())).toEqual(user)
    expect(fs.existsSync(hooksFile())).toBe(false)
    expect(removeStatusHooks('muse', { home, env: {} })).toEqual({ changed: false })
    expect(read(settingsFile())).toEqual(user)
  })

  it('a settings file it cannot read, or a variables setting that is not a list, is left alone', () => {
    put(settingsFile(), '{broken')
    expect(installStatusHooks('muse', scriptPath, { home, env: {}, node: NODE }).error).toBeTruthy()
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{broken')
    put(settingsFile(), { schema_version: 1, managed_hooks_env_vars: 'TESSEL_PANE_ID' })
    expect(installStatusHooks('muse', scriptPath, { home, env: {}, node: NODE }).error).toMatch(/managed_hooks_env_vars/)
    expect(fs.existsSync(hooksFile())).toBe(false)
  })

  it('Settings shows it partial while a variable is missing, an error when another file is named', () => {
    installStatusHooks('muse', scriptPath, { home, env: {}, node: NODE })
    const saved = read(settingsFile())
    put(settingsFile(), { ...saved, managed_hooks_env_vars: ['TESSEL_PANE_ID'] })
    expect(statusHooksInstallation('muse', scriptPath, { home, env: {}, node: NODE }).hooks).toBe('partial')
    put(settingsFile(), { ...saved, managed_hooks_path: join(dir, 'other.json') })
    expect(statusHooksInstallation('muse', scriptPath, { home, env: {}, node: NODE })).toMatchObject({ hooks: 'error' })
  })

  it('on Windows, the form cmd /C runs however Muse quotes it; a path with a space, the usual one', () => {
    expect(statusCommand(scriptPath, 'muse', 'Stop', NODE, 'win32')).toBe('C:\\"Program Files\\nodejs"\\node.exe C:\\TesselData\\tessel-team-mcp.cjs --hook --agent=muse --event=Stop')
    expect(statusCommand('C:\\Tessel data\\tessel-team-mcp.cjs', 'muse', 'Stop', NODE, 'win32')).toBe('C:/"Program Files/nodejs/node.exe" "C:\\Tessel data\\tessel-team-mcp.cjs" --hook --agent=muse --event=Stop')
  })

  it('installed for every Muse launch, like the other status agents', async () => {
    const source = fs.readFileSync(script, 'utf8')
    const prepare = () => prepareAgentStateHooks({ provider: 'muse', env: {}, node: NODE, home, sharedDir: join(dir, 'shared'), source })
    expect(await prepare()).toMatchObject({ ok: true, supported: true, changed: true })
    expect(await prepare()).toMatchObject({ ok: true, changed: false })
  })
})

describe("the hook script turns Muse's events into status events", () => {
  const top = '01a0ae0d-1cdf-7221-b5e5-96159c9a1ec0'
  const child = '01a0ae0e-2222-7333-8444-555566667777'
  const cases = [
    ['UserPromptSubmit', { session_id: top, turn_id: 't1', prompt: 'PRIVATE' }, 'UserPromptSubmit'],
    ['PreToolUse', { session_id: top, turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'PRIVATE' }, tool_use_id: 'call_1' }, 'PreToolUse'],
    ['PostToolUseFailure', { session_id: top, turn_id: 't1', tool_name: 'Bash', error: 'boom' }, 'PostToolUseFailure'],
    ['Notification', { session_id: top, notification_type: 'permission_prompt', title: 'Approval', message: 'proj — waiting for approval' }, 'Notification'],
    ['Stop', { session_id: top, turn_id: 't1', stop_hook_active: false, last_assistant_message: 'PRIVATE' }, 'Stop'],
    ['Interrupt', { session_id: top, turn_id: 't1' }, 'Interrupt'],
    ['StopFailure', { session_id: top, turn_id: 't1', error: 'rate_limited' }, 'StopFailure']
  ]
  it.each(cases)('%s -> %s', async (event, payload, expected) => {
    const result = await runHook(event, payload, { ...paneEnv(), MUSE_SESSION_ID: top, MUSE_THREAD_ID: top })
    expect(result.code).toBe(0)
    expect(result.out).toBe('')
    const [report] = reports()
    expect(report).toMatchObject({ provider: 'muse', event: expected, sessionId: top, launchToken, source: 'hook', paneId: 'pane-muse' })
    expect(report.agentId).toBeUndefined()
    expect(JSON.stringify(reports())).not.toMatch(/PRIVATE/)
  })

  it('a sub-agent: announced by its session id, its own events its own (never the pane’s conversation)', async () => {
    await runHook('SubagentStart', { session_id: top, turn_id: 't1', subagent_id: 'explorer-1', child_session_id: child }, { ...paneEnv(), MUSE_SESSION_ID: top, MUSE_THREAD_ID: top })
    await runHook('Stop', { session_id: child, turn_id: child }, { ...paneEnv(), MUSE_SESSION_ID: top, MUSE_THREAD_ID: child })
    const [start, stop] = reports()
    expect(start).toMatchObject({ event: 'SubagentStart', agentId: child, sessionId: top })
    expect(stop).toMatchObject({ event: 'Stop', agentId: child, sessionId: child })
    // The pane's conversation stays the top-level one.
    expect(read(join(dir, 'sessions', 'pane-muse.json'))).toMatchObject({ agent: 'muse', sessionId: top })
  })

  it('Muse 1.3 (no MUSE_SESSION_ID): a sub-agent’s turn id is its own session id', async () => {
    await runHook('PostToolUse', { session_id: child, turn_id: child, tool_name: 'Read' }, paneEnv())
    expect(reports()[0]).toMatchObject({ event: 'PostToolUse', agentId: child })
    expect(fs.existsSync(join(dir, 'sessions', 'pane-muse.json'))).toBe(false)
  })

  it('no status meaning: a compaction restart, a notice that is not an approval, PermissionRequest (its judge may decide alone)', async () => {
    await runHook('SessionStart', { session_id: top, source: 'compact' }, { ...paneEnv(), MUSE_SESSION_ID: top })
    await runHook('Notification', { session_id: top, notification_type: 'idle' }, { ...paneEnv(), MUSE_SESSION_ID: top })
    await runHook('PermissionRequest', { session_id: top, tool_name: 'Bash' }, { ...paneEnv(), MUSE_SESSION_ID: top })
    expect(reports()).toEqual([])
  })

  it('the store takes them for its launch: working, waiting for approval, idle', async () => {
    const store = createAgentStateStore({ dir: statusDir() })
    try {
      await store.register({ paneId: 'pane-muse', provider: 'muse', launchToken, startedAt: Date.now() - 1000 })
      const env = { ...paneEnv(), MUSE_SESSION_ID: top, MUSE_THREAD_ID: top }
      await runHook('SessionStart', { session_id: top, source: 'startup' }, env)
      await runHook('UserPromptSubmit', { session_id: top, turn_id: 't1', prompt: 'hi' }, env)
      expect((await store.scan()).states['pane-muse']).toMatchObject({ state: 'working', hookSeen: true })
      await runHook('Notification', { session_id: top, notification_type: 'permission_prompt' }, env)
      expect((await store.scan()).states['pane-muse']).toMatchObject({ state: 'approval' })
      await runHook('PostToolUse', { session_id: top, turn_id: 't1', tool_name: 'Bash' }, env)
      await runHook('Stop', { session_id: top, turn_id: 't1' }, env)
      expect((await store.scan()).states['pane-muse']).toMatchObject({ state: 'idle', reason: 'ready' })
    } finally {
      await store.dispose()
    }
  })
})
