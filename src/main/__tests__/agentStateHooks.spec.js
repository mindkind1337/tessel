// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { ensureTeamChannel, pollTeamChannel } from '../teamChannel'
import { writeCurrentTeams } from '../teamNotices'
import { prepareAgentStateHooks } from '../agentStateSetup'
import { HOOK_EVENTS, CODEX_HOOK_EVENTS } from '../teamInstall'

const require = createRequire(import.meta.url)
const script = join(__dirname, '..', 'teamMcp', 'server.cjs')
const mcp = require(script)
const launchToken = 'a'.repeat(32)
const A = { id: 'pane-1-source', num: 1, title: 'Sender' }
const B = { id: 'pane-2-recipient', num: 2, title: 'Receiver' }
let dir
const statusDir = () => join(dir, 'status')
const reports = () =>
  fs.existsSync(join(statusDir(), 'events'))
    ? fs
        .readdirSync(join(statusDir(), 'events'))
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(join(statusDir(), 'events', f), 'utf8')))
    : []
const as = (pane) => {
  vi.stubEnv('TESSEL_PANE_ID', pane.id)
  vi.stubEnv('TESSEL_PROJECT_DIR', dir)
  return mcp.locate()
}
async function hook(event, { provider = 'claude', data = {}, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [script, '--hook', ...(provider === 'codex' ? ['--codex'] : [])],
      {
        cwd: dir,
        windowsHide: true,
        env: {
          ...process.env,
          TESSEL_PANE_ID: B.id,
          TESSEL_PROJECT_DIR: dir,
          TESSEL_SESSIONS_DIR: join(dir, 'sessions'),
          TESSEL_AGENT_STATE_DIR: statusDir(),
          TESSEL_AGENT_PROVIDER: provider,
          TESSEL_AGENT_LAUNCH: launchToken,
          ...env
        }
      }
    )
    let out = '',
      err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Hook fixture timed out'))
    }, 8000)
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
    child.stdin.end(
      JSON.stringify({ hook_event_name: event, session_id: 'session-root-123', cwd: dir, ...data })
    )
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-state-hooks-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  const target = resolve(dir)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-state-hooks-'))
    throw new Error('Unsafe fixture path')
  fs.rmSync(target, { recursive: true, force: true })
})

describe('status hooks observe without consuming team messages', () => {
  function queued() {
    expect(ensureTeamChannel({ dir, teamId: 'team-1', members: [A, B] }).ok).toBe(true)
    writeCurrentTeams({
      dir,
      panes: { [A.id]: { team: 'team-1', num: 1 }, [B.id]: { team: 'team-1', num: 2 } }
    })
    expect(mcp.send(as(A), '#2', 'Read this with an appropriate delivery event.').ok).toBe(true)
    pollTeamChannel({ dir, teamId: 'team-1' })
    return mcp.unread(as(B)).filter((m) => m.text).length
  }
  it.each(['PreToolUse', 'PermissionRequest', 'Notification', 'StopFailure', 'SessionEnd'])(
    '%s has no delivery or permission-decision output and leaves the inbox unread',
    async (event) => {
      const before = queued()
      const result = await hook(event, {
        data: {
          notification_type: 'permission_prompt',
          tool_use_id: 'tool-1',
          prompt: 'PRIVATE-PROMPT',
          tool_input: { secret: 'PRIVATE-ARG' }
        }
      })
      expect(result).toEqual({ code: 0, out: '', err: '' })
      expect(mcp.unread(as(B)).filter((m) => m.text)).toHaveLength(before)
      expect(reports()).toHaveLength(1)
      expect(reports()[0]).toMatchObject({
        event,
        source: 'hook',
        provider: 'claude',
        launchToken,
        toolId: 'tool-1'
      })
      expect(JSON.stringify(reports())).not.toMatch(/PRIVATE|tool_input|"prompt":/)
    }
  )
  it('records a continuing Stop after team delivery, not a completed response', async () => {
    queued()
    const result = await hook('Stop', { provider: 'codex', data: { stop_hook_active: false } })
    expect(JSON.parse(result.out).decision).toBe('block')
    expect(reports()[0]).toMatchObject({ event: 'Stop', continuing: true, provider: 'codex' })
    expect(mcp.unread(as(B))).toHaveLength(0)
  })
  it('records a non-continuing Stop as a candidate even outside a team', async () => {
    expect((await hook('Stop')).out).toBe('')
    expect(reports()[0]).toMatchObject({ continuing: false, event: 'Stop' })
  })
  it("records the ids of the background work a Claude Stop lists, never its descriptions or commands", async () => {
    // The shape Claude Code 2.1 attaches to Stop (background_tasks).
    const background_tasks = [
      { id: 'b8o5jb42q', type: 'shell', status: 'running', description: 'PRIVATE-DESC', command: 'sleep 600' },
      { id: 'a89b41394dcd804b3', type: 'subagent', status: 'running', description: 'PRIVATE-DESC', agent_type: 'general-purpose' },
      { id: 'mate-1', type: 'teammate', status: 'running', description: 'always listed' },
      { id: 'old-1', type: 'shell', status: 'completed', description: 'over' },
      { id: '../bad', type: 'monitor', status: 'running', description: 'x' }
    ]
    await hook('Stop', { data: { stop_hook_active: false, background_tasks, session_crons: [] } })
    expect(reports()[0]).toMatchObject({ event: 'Stop', background: ['b8o5jb42q', 'a89b41394dcd804b3', 'task-3'] })
    expect(JSON.stringify(reports())).not.toMatch(/PRIVATE|sleep 600|general-purpose/)
  })
  it('records an empty list as "nothing left", and no list when the hook has none', async () => {
    await hook('Stop', { data: { background_tasks: [] } })
    await hook('Stop', { data: {} })
    await hook('Stop', { data: { agent_id: 'child-1', background_tasks: [{ id: 'x', type: 'shell', status: 'running' }] } })
    const stops = reports().sort((a, b) => a.at - b.at)
    expect(stops.filter((r) => Array.isArray(r.background)).map((r) => r.background)).toEqual([[]])
    expect(stops.filter((r) => r.agentId).every((r) => r.background === undefined)).toBe(true)
  })
  it('keeps child state separate from the root session and inbox', async () => {
    const before = queued()
    await hook('SessionStart')
    const sessionFile = join(dir, 'sessions', B.id + '.json')
    const original = fs.readFileSync(sessionFile, 'utf8')
    await hook('Stop', { data: { agent_id: 'child-1', session_id: 'session-child-123' } })
    expect(reports().find((r) => r.agentId)).toMatchObject({
      agentId: 'child-1',
      sessionId: 'session-child-123'
    })
    expect(fs.readFileSync(sessionFile, 'utf8')).toBe(original)
    expect(mcp.unread(as(B)).filter((m) => m.text)).toHaveLength(before)
  })
  it('does not write status without a matching launch identity', async () => {
    await hook('UserPromptSubmit', { env: { TESSEL_AGENT_LAUNCH: '' } })
    await hook('UserPromptSubmit', { env: { TESSEL_AGENT_PROVIDER: 'codex' } })
    expect(reports()).toEqual([])
  })
  it('cannot break an agent when status recording fails', async () => {
    fs.writeFileSync(statusDir(), 'not a directory')
    expect(await hook('PermissionRequest')).toEqual({ code: 0, out: '', err: '' })
  })
})

describe('account-aware status hook installation', () => {
  const install = (provider, env = {}) =>
    prepareAgentStateHooks({
      provider,
      env,
      home: join(dir, 'home'),
      // The absolute node the hook commands run (the fixture env has no PATH).
      node: process.execPath,
      sharedDir: join(dir, 'shared'),
      source: fs.readFileSync(script, 'utf8')
    })
  it.each(['claude', 'codex'])(
    'installs %s in the configured home, retaining unrelated hooks and settings',
    async (provider) => {
      const root = join(dir, 'configured')
      fs.mkdirSync(root)
      const file = join(root, provider === 'codex' ? 'hooks.json' : 'settings.json')
      fs.writeFileSync(
        file,
        JSON.stringify({
          model: 'mine',
          hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.cmd' }] }]
          }
        })
      )
      const env = { [provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: root }
      expect(await install(provider, env)).toMatchObject({ ok: true, changed: true })
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      expect(saved.model).toBe('mine')
      expect(saved.hooks.PreToolUse[0].hooks[0].command).toBe('mine.cmd')
      expect(Object.keys(saved.hooks)).toEqual(
        expect.arrayContaining(provider === 'codex' ? CODEX_HOOK_EVENTS : HOOK_EVENTS)
      )
      expect(await install(provider, env)).toMatchObject({ ok: true, changed: false })
      expect(fs.existsSync(join(dir, 'home'))).toBe(false)
    }
  )
  it('does not claim readiness when a same-version shared bridge lacks the protocol', async () => {
    fs.mkdirSync(join(dir, 'shared'))
    fs.writeFileSync(join(dir, 'shared', 'tessel-team-mcp.cjs'), "const VERSION = '99.0.0'\n")
    expect(await install('codex')).toMatchObject({ ok: false })
    expect(fs.existsSync(join(dir, 'home'))).toBe(false)
  })
  it('keeps unreadable settings untouched and refuses relative homes', async () => {
    const root = join(dir, 'configured')
    fs.mkdirSync(root)
    fs.writeFileSync(join(root, 'hooks.json'), '{broken')
    expect((await install('codex', { CODEX_HOME: root })).ok).toBe(false)
    expect(fs.readFileSync(join(root, 'hooks.json'), 'utf8')).toBe('{broken')
    expect((await install('claude', { CLAUDE_CONFIG_DIR: '../relative' })).ok).toBe(false)
  })
})

describe('the question an agent asks (its card shows at once)', () => {
  const questions = {
    questions: [
      { question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'First', extra: 'PRIVATE-OPT' }, { label: 'B' }], note: 'PRIVATE-Q' }
    ],
    metadata: 'PRIVATE-META'
  }
  it.each([
    ['claude', 'AskUserQuestion', 'PreToolUse'],
    ['claude', 'AskUserQuestion', 'PermissionRequest'],
    ['codex', 'request_user_input', 'PreToolUse']
  ])('%s %s on %s: keeps the question structure only', async (provider, tool, event) => {
    expect((await hook(event, { provider, data: { tool_name: tool, tool_use_id: 'call_1', tool_input: questions, prompt: 'PRIVATE-PROMPT' } })).code).toBe(0)
    const [report] = reports()
    expect(report).toMatchObject({ event, toolName: tool, toolId: 'call_1' })
    expect(report.ask).toEqual({ questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'A', description: 'First' }, { label: 'B' }] }] })
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|tool_input/)
  })
  it('keeps nothing of any other tool, of a tool end, or of a sub-agent', async () => {
    await hook('PreToolUse', { data: { tool_name: 'Bash', tool_use_id: 't1', tool_input: questions } })
    await hook('PostToolUse', { data: { tool_name: 'AskUserQuestion', tool_use_id: 't2', tool_input: questions } })
    await hook('PreToolUse', { data: { tool_name: 'AskUserQuestion', tool_use_id: 't3', agent_id: 'child-1', tool_input: questions } })
    expect(reports()).toHaveLength(3)
    expect(reports().some((r) => r.ask)).toBe(false)
    expect(JSON.stringify(reports())).not.toMatch(/Which one|PRIVATE/)
  })
  it('writes no question over the limits (the card then waits for the file)', async () => {
    const many = { questions: [{ question: 'Q', options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })) }] }
    await hook('PreToolUse', { data: { tool_name: 'AskUserQuestion', tool_use_id: 't1', tool_input: many } })
    expect(reports()[0]).toMatchObject({ toolName: 'AskUserQuestion' })
    expect(reports()[0].ask).toBeUndefined()
  })
})

describe('the permission mode (the chat view mode picker)', () => {
  it.each([
    ['claude', 'UserPromptSubmit', 'plan'],
    ['claude', 'Stop', 'bypassPermissions'],
    ['codex', 'PreToolUse', 'dontAsk']
  ])('%s %s: keeps permission_mode, the value only', async (provider, event, mode) => {
    expect((await hook(event, { provider, data: { permission_mode: mode, prompt: 'PRIVATE-PROMPT', tool_name: 'Bash', tool_input: { command: 'PRIVATE-CMD' } } })).code).toBe(0)
    const [report] = reports()
    expect(report).toMatchObject({ event, permissionMode: mode })
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE/)
  })
  it("keeps no unknown value, nor a sub-agent's", async () => {
    await hook('UserPromptSubmit', { data: { permission_mode: 'superuser' } })
    await hook('Stop', { data: { permission_mode: { mode: 'plan' } } })
    await hook('PreToolUse', { data: { permission_mode: 'plan', agent_id: 'child-1', tool_name: 'Bash' } })
    expect(reports()).toHaveLength(3)
    expect(reports().some((r) => 'permissionMode' in r)).toBe(false)
  })
})
