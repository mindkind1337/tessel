import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRequire } from 'module'
import { join } from 'path'
import fs from 'fs'
import os from 'os'
import { createAgentTerminal, stripAnsi, checkCommand, keyData, keysData, MAX_COMMAND_BYTES, RATE_MAX, PREPARE_MAX } from '../agentTerminal'
import { handleRequestLine, validateParams, CliError } from '../cliServer'
import { setTeamSecret, verifyRequest, _resetTeamAuth } from '../teamAuth'
import { MAX_OUTPUT_LENGTH } from '../../shared/terminalOutput'

// Run inside a Tessel pane, these tests would sign as that pane.
delete process.env.TESSEL_TEAM_SECRET
delete process.env.TESSEL_PANE_ID

const require = createRequire(import.meta.url)
const mcp = require(join(__dirname, '..', 'teamMcp', 'server.cjs'))

const AGENT = 'pane-7-agent'
const OTHER = 'pane-9-agent'
const SECRET = 'a'.repeat(64)
const OTHER_SECRET = 'c'.repeat(64)
const TOKEN = 'b'.repeat(64)

// A request as the MCP server signs it, checked as the pipe checks it.
function signed(op, args = {}, { pane = AGENT, secret = SECRET } = {}) {
  process.env.TESSEL_PANE_ID = pane
  process.env.TESSEL_TEAM_SECRET = secret
  try {
    return validateParams('terminal', mcp.terminalRequest(op, args))
  } finally {
    delete process.env.TESSEL_TEAM_SECRET
    delete process.env.TESSEL_PANE_ID
  }
}

const OWN = { id: 'pane-own', name: 'Ada · terminal', kind: 'shell', own: true, lang: 'powershell', shellKind: 'pwsh', agentLabel: 'Ada', workspaceKey: 'C:\\proj' }
const USER = { id: 'pane-user', name: 'fivem-afterlife', kind: 'shell', own: false, lang: 'bash', shellKind: 'ssh', host: 'resources', agentLabel: 'Ada', workspaceKey: 'C:\\proj' }
const PEER = { id: 'pane-peer', name: 'Codex', kind: 'agent', agentName: 'Codex CLI', own: false, agentLabel: 'Ada' }

// The window: answers each op; records what it was asked.
function fakeWindow({ target = OWN, approve = { allow: true }, run = { state: 'completed', output: 'hello', exitCode: 0 } } = {}) {
  const calls = []
  const ask = vi.fn(async (method, params) => {
    calls.push(params)
    expect(method).toBe('terminalTarget')
    switch (params.op) {
      case 'prepare':
        // async: a new terminal each time (the window refuses past the limit).
        if (params.mode === 'async' && params.mayOpen === false) throw new CliError('rate_limited', 'limit')
        return typeof target === 'function' ? target(params) : { ...target, isNew: params.mode === 'async' }
      case 'resolve':
        return typeof target === 'function' ? target(params) : { ...target }
      case 'approve':
        return typeof approve === 'function' ? approve(params) : approve
      case 'run':
        return typeof run === 'function' ? run(params) : run
      case 'send':
        return { name: target.name, output: 'sent ok' }
      case 'host':
        return params.host === 'other' ? { hostId: 'ssh-other', label: 'other', projectHost: false } : { hostId: null, label: 'this computer', projectHost: true }
      case 'active':
        return { ...target }
      case 'lastCommand':
        return { name: target.name, commandLine: 'make', exitCode: 0, output: 'built' }
      case 'selection':
        return { name: target.name, text: 'secret selection' }
      case 'output':
        return { name: target.name, command: 'npm test', running: false, exitCode: 0, output: 'out' }
      case 'kill':
        return { name: target.name, output: 'bye' }
      case 'list':
        return { agent: 'Ada', terminals: [{ ...USER, busy: null }, { ...PEER, busy: null }] }
      case 'stoppedNotice':
      case 'abort':
        return { ok: true }
      default:
        throw new Error(`unexpected op ${params.op}`)
    }
  })
  return { ask, calls, ops: () => calls.map((c) => c.op) }
}

function make(win, extra = {}) {
  const sent = []
  const s = { enabled: true, autoApprove: false, userRules: {}, workspaceRules: {}, ...(extra.settings || {}) }
  const at = createAgentTerminal({
    verify: (body, paneId) => verifyRequest(body, paneId, 'terminal'),
    settings: () => s,
    ask: win.ask,
    send: (ch, p) => sent.push([ch, p]),
    busyOf: extra.busyOf || (async () => ({})),
    outputDir: extra.outputDir || null,
    logFile: extra.logFile || null
  })
  return { at, sent, settings: s }
}

beforeEach(() => {
  _resetTeamAuth()
  setTeamSecret(AGENT, SECRET)
  setTeamSecret(OTHER, OTHER_SECRET)
})

describe('agent terminal: who may call', () => {
  it('runs a signed request from its own pane', async () => {
    const win = fakeWindow()
    const { at } = make(win)
    const r = await at.handle(signed('run', { command: 'echo hello', explanation: 'say hello', goal: 'test', mode: 'sync' }))
    expect(r.text).toContain('hello')
    expect(win.ops()).toEqual(['host', 'prepare', 'approve', 'run'])
    expect(win.calls[0].agent).toBe(AGENT)
  })

  it('refuses an unsigned request and one signed with another pane\'s secret', async () => {
    const win = fakeWindow()
    const { at } = make(win)
    const req = signed('list')
    await expect(at.handle({ ...req, auth: undefined })).rejects.toMatchObject({ code: 'unauthorized' })
    // OTHER signs, but claims to be AGENT.
    const forged = signed('list', {}, { pane: AGENT, secret: OTHER_SECRET })
    await expect(at.handle(forged)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(win.ask).not.toHaveBeenCalled()
  })

  it('refuses a replayed request and changed arguments', async () => {
    const win = fakeWindow()
    const { at } = make(win)
    const req = signed('list')
    await at.handle(req)
    await expect(at.handle(req)).rejects.toMatchObject({ code: 'unauthorized' })
    const other = signed('run', { command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' })
    await expect(at.handle({ ...other, args: { ...other.args, command: 'rm -rf /' } })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('does nothing while the setting is off', async () => {
    const win = fakeWindow()
    const { at, settings } = make(win)
    settings.enabled = false
    await expect(at.handle(signed('list'))).rejects.toMatchObject({ code: 'disabled' })
    expect(win.ask).not.toHaveBeenCalled()
  })

  it('goes over the tessel pipe as method "terminal"', async () => {
    const win = fakeWindow()
    const { at } = make(win)
    const line = `TESSEL-CLI 1 ${Buffer.from(JSON.stringify({ token: TOKEN, method: 'terminal', params: (() => {
      process.env.TESSEL_PANE_ID = AGENT
      process.env.TESSEL_TEAM_SECRET = SECRET
      const r = mcp.terminalRequest('list', {})
      delete process.env.TESSEL_TEAM_SECRET
      delete process.env.TESSEL_PANE_ID
      return r
    })() })).toString('base64')}`
    const reply = JSON.parse(await handleRequestLine(line, { token: TOKEN, handlers: { terminal: (p) => at.handle(p) } }))
    expect(reply.ok).toBe(true)
    expect(reply.result.text).toContain('fivem-afterlife')
  })

  it('validates the pipe parameters', () => {
    expect(() => validateParams('terminal', { pane: AGENT, op: 'run', args: { evil: 1 }, auth: { nonce: 'n'.repeat(20), at: 1, mac: 'x' } })).toThrow()
    expect(() => validateParams('terminal', { pane: AGENT, op: 'run', args: { keys: [{}] }, auth: { nonce: 'n'.repeat(20), at: 1, mac: 'x' } })).toThrow()
    const ok = validateParams('terminal', { pane: AGENT, op: 'send', args: { id: 'p', keys: ['Ctrl+C'] }, auth: { nonce: 'n'.repeat(20), at: 1, mac: 'x' } })
    expect(ok.args.keys).toEqual(['Ctrl+C'])
  })
})

describe('agent terminal: other agents\' panes are read-only', () => {
  it('refuses run and send into an agent pane, reads it', async () => {
    const win = fakeWindow({ target: PEER })
    const { at } = make(win)
    await expect(at.handle(signed('run', { id: PEER.id, command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }))).rejects.toMatchObject({ code: 'read_only' })
    await expect(at.handle(signed('send', { id: PEER.id, command: 'hi' }))).rejects.toMatchObject({ code: 'read_only' })
    expect(win.ops()).not.toContain('run')
    expect(win.ops()).not.toContain('send')
    const r = await at.handle(signed('output', { id: PEER.id }))
    expect(r.text).toContain('out')
  })
})

describe('agent terminal: approval', () => {
  it('auto-approves by the default rules once the user turned rules on', async () => {
    const win = fakeWindow()
    const { at } = make(win, { settings: { autoApprove: true } })
    const r = await at.handle(signed('run', { command: 'git status', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(win.ops()).toEqual(['host', 'prepare', 'run'])
    expect(r.text).toContain('Auto approved by rule')
  })

  it('asks for a command no rule allows, and for a denied one even with rules on', async () => {
    const win = fakeWindow()
    const { at } = make(win, { settings: { autoApprove: true } })
    await at.handle(signed('run', { command: 'npm test', explanation: 'x', goal: 'y', mode: 'sync' }))
    await at.handle(signed('run', { command: 'ls && rm -rf build', explanation: 'x', goal: 'y', mode: 'sync' }))
    const cards = win.calls.filter((c) => c.op === 'approve').map((c) => c.card)
    expect(cards).toHaveLength(2)
    expect(cards[0].actions.some((a) => a.kind === 'prefix' && a.keys.includes('npm test'))).toBe(true)
    expect(cards[1].info).toMatch(/denied by rule rm/)
  })

  it('never auto-approves while rules are off', async () => {
    const win = fakeWindow()
    const { at } = make(win)
    await at.handle(signed('run', { command: 'git status', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(win.ops()).toEqual(['host', 'prepare', 'approve', 'run'])
  })

  it('a skipped command does not run', async () => {
    const win = fakeWindow({ approve: { allow: false } })
    const { at } = make(win)
    await expect(at.handle(signed('run', { command: 'make', explanation: 'x', goal: 'y', mode: 'sync' }))).rejects.toMatchObject({ code: 'denied' })
    expect(win.ops()).not.toContain('run')
  })

  it('runs the command as the user edited it, and says so', async () => {
    const win = fakeWindow({ approve: { allow: true, command: 'npm test -- --run' } })
    const { at } = make(win)
    const r = await at.handle(signed('run', { command: 'npm test', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(win.calls.find((c) => c.op === 'run').command).toBe('npm test -- --run')
    expect(r.text).toContain('The user manually edited the command')
  })

  it('"Allow all commands in this session" and session rules apply to this agent only', async () => {
    const win = fakeWindow({ approve: { allow: true, action: { kind: 'prefix', keys: ['npm test'], scope: 'session' } } })
    const { at } = make(win, { settings: { autoApprove: true } })
    await at.handle(signed('run', { command: 'npm test', explanation: 'x', goal: 'y', mode: 'sync' }))
    await at.handle(signed('run', { command: 'npm test --watch=false', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(win.calls.filter((c) => c.op === 'approve')).toHaveLength(1)
    // Another agent: its own session.
    await at.handle(signed('run', { command: 'npm test', explanation: 'x', goal: 'y', mode: 'sync' }, { pane: OTHER, secret: OTHER_SECRET }))
    expect(win.calls.filter((c) => c.op === 'approve')).toHaveLength(2)
    const all = fakeWindow({ approve: { allow: true, action: { kind: 'session' } } })
    const b = make(all, { settings: { autoApprove: true } })
    await b.at.handle(signed('run', { command: 'make all', explanation: 'x', goal: 'y', mode: 'sync' }))
    await b.at.handle(signed('run', { command: 'rm -rf build', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(all.calls.filter((c) => c.op === 'approve')).toHaveLength(1)
  })

  it('the user\'s terminal: asked once per terminal (remembered), never by rules', async () => {
    const win = fakeWindow({ target: USER, approve: { allow: true, remember: 'pane' } })
    const { at } = make(win, { settings: { autoApprove: true } })
    await at.handle(signed('run', { id: USER.id, command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }))
    await at.handle(signed('run', { id: USER.id, command: 'cat server.cfg', explanation: 'x', goal: 'y', mode: 'sync' }))
    const cards = win.calls.filter((c) => c.op === 'approve')
    expect(cards).toHaveLength(1)
    expect(cards[0].card.kind).toBe('pane')
    // A denied command asks again in an approved terminal.
    await at.handle(signed('run', { id: USER.id, command: 'rm old.log', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(win.calls.filter((c) => c.op === 'approve')).toHaveLength(2)
  })

  it('"Allow this time" in a user terminal asks again next time', async () => {
    const win = fakeWindow({ target: USER, approve: { allow: true, remember: 'once' } })
    const { at } = make(win)
    await at.handle(signed('run', { id: USER.id, command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }))
    await at.handle(signed('run', { id: USER.id, command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(win.calls.filter((c) => c.op === 'approve')).toHaveLength(2)
  })
})

describe('agent terminal: Stop', () => {
  it('refuses that agent\'s next writes there until the user allows it again', async () => {
    const win = fakeWindow({ target: USER, approve: { allow: true, remember: 'pane' } })
    const { at, sent } = make(win)
    await at.handle(signed('run', { id: USER.id, command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(sent.some(([ch, p]) => ch === 'terminal:agentControl' && p.active && p.paneId === USER.id && p.agent === 'Ada')).toBe(true)
    expect(at.stop(USER.id)).toBe(true)
    expect(sent.some(([ch, p]) => ch === 'terminal:agentControl' && !p.active && p.stopped)).toBe(true)
    await expect(at.handle(signed('run', { id: USER.id, command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }))).rejects.toMatchObject({ code: 'stopped_by_user' })
    await expect(at.handle(signed('send', { id: USER.id, keys: ['Ctrl+C'] }))).rejects.toMatchObject({ code: 'stopped_by_user' })
    expect(win.ops()).toContain('stoppedNotice')
    // Another agent is not stopped there.
    await at.handle(signed('run', { id: USER.id, command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }, { pane: OTHER, secret: OTHER_SECRET }))
    // Allowed again: it asks for the terminal again (Stop took the approval back).
    at.allowAgain(USER.id, AGENT)
    const before = win.calls.filter((c) => c.op === 'approve').length
    await at.handle(signed('run', { id: USER.id, command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(win.calls.filter((c) => c.op === 'approve').length).toBe(before + 1)
  })
})

describe('agent terminal: limits', () => {
  it('caps the command at 8 KB and refuses control characters', () => {
    expect(() => checkCommand('x'.repeat(MAX_COMMAND_BYTES + 1))).toThrow(/longer/)
    expect(() => checkCommand('echo \x1b[31m')).toThrow(/control/)
    expect(checkCommand('a\r\nb')).toBe('a\nb')
  })

  it('rate-limits writes per agent', async () => {
    const win = fakeWindow({ target: { ...OWN } })
    const { at } = make(win, { settings: { autoApprove: true } })
    for (let i = 0; i < RATE_MAX; i++) await at.handle(signed('run', { command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }))
    await expect(at.handle(signed('run', { command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }))).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('named keys only, never paste', () => {
    expect(keyData('Ctrl+C').data).toBe('\x03')
    expect(keyData('Up').data).toBe('\x1b[A')
    expect(keyData('ArrowUp', { appCursor: true }).data).toBe('\x1bOA')
    expect(keyData('y').data).toBe('y')
    expect(keyData('Shift+Tab').data).toBe('\x1b[Z')
    expect(keyData('Ctrl+V').code).toBe('reserved_key')
    expect(keyData('Shift+Insert').code).toBe('reserved_key')
    expect(keyData('\x16').code).toBe('invalid_argument')
    expect(() => keysData(Array(40).fill('a'))).toThrow(/At most/)
  })

  it('an output over 20 KB goes to a file, with a preview and its tail', async () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-term-'))
    const big = `${'start\n'}${'x'.repeat(MAX_OUTPUT_LENGTH * 2)}\nTHE END`
    const win = fakeWindow({ run: { state: 'completed', output: big, exitCode: 0 } })
    const { at } = make(win, { outputDir: dir, settings: { autoApprove: true } })
    const r = await at.handle(signed('run', { command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(r.text).toMatch(/Output too large \(\d+KB\)\. Full output saved to: /)
    expect(r.text).toContain('THE END')
    expect(r.text.length).toBeLessThan(MAX_OUTPUT_LENGTH + 500)
    const files = fs.readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(fs.readFileSync(join(dir, files[0]), 'utf8')).toBe(big)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a password question: needs_user_input, nothing is sent', async () => {
    const win = fakeWindow({ run: { state: 'sensitive', output: '[sudo] password for me:', prompt: '[sudo] password for me:' } })
    const { at } = make(win, { settings: { autoApprove: true } })
    await expect(at.handle(signed('run', { command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }))).rejects.toMatchObject({ code: 'needs_user_input' })
    const win2 = fakeWindow({ target: { ...OWN, cursorLine: 'Enter passphrase for key: ' } })
    const b = make(win2)
    await expect(b.at.handle(signed('send', { id: OWN.id, command: 'hunter2' }))).rejects.toMatchObject({ code: 'needs_user_input' })
    await expect(b.at.handle(signed('send', { id: OWN.id, keys: ['y', 'Enter'] }))).rejects.toMatchObject({ code: 'needs_user_input' })
    expect(win2.ops()).not.toContain('send')
    // It may still cancel the question.
    await b.at.handle(signed('send', { id: OWN.id, keys: ['Ctrl+C'] }))
    expect(win2.calls.find((c) => c.op === 'send')).toMatchObject({ mode: 'keys', data: '\x03' })
  })

  it('a timed-out command keeps running: the agent gets its id and how to follow it', async () => {
    const win = fakeWindow({ run: { state: 'timeout', output: 'building...' } })
    const { at } = make(win, { settings: { autoApprove: true } })
    const r = await at.handle(signed('run', { command: 'ls', explanation: 'x', goal: 'y', mode: 'sync', timeout: 5000 }))
    expect(r.text).toContain('Command timed out after 5000ms')
    expect(r.text).toContain(`terminal ID ${OWN.id}`)
    expect(r.text).toContain('get_terminal_output')
    expect(win.calls.find((c) => c.op === 'run').timeoutMs).toBe(5000)
  })

  it('caps the timeout at 120 s', async () => {
    const win = fakeWindow()
    const { at } = make(win, { settings: { autoApprove: true } })
    await at.handle(signed('run', { command: 'ls', explanation: 'x', goal: 'y', mode: 'sync', timeout: 10 * 60 * 1000 }))
    expect(win.calls.find((c) => c.op === 'run').timeoutMs).toBe(120000)
  })

  it('rewrites && for Windows PowerShell 5.1 only, and says so', async () => {
    const win = fakeWindow({ target: { ...OWN, shellKind: 'powershell' } })
    const { at } = make(win)
    const r = await at.handle(signed('run', { command: 'npm ci && npm test', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(win.calls.find((c) => c.op === 'run').command).toBe('npm ci; npm test')
    expect(r.text).toContain('simplified the command')
  })

  it('logs each command it runs', async () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-term-'))
    const logFile = join(dir, 'agent-terminal.log')
    const win = fakeWindow()
    const { at, sent } = make(win, { logFile, settings: { autoApprove: true } })
    await at.handle(signed('run', { command: 'git status', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(sent.find(([ch]) => ch === 'terminal:agentLog')[1]).toMatchObject({ paneId: OWN.id, kind: 'run', text: 'git status', agent: 'Ada' })
    expect(JSON.parse(fs.readFileSync(logFile, 'utf8').trim())).toMatchObject({ pane: OWN.id, text: 'git status' })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('agent terminal: other tools', () => {
  it('send_to_terminal: a cancel signal is sent raw, with VS Code\'s note', async () => {
    const win = fakeWindow({ approve: { allow: true } })
    const { at } = make(win)
    const r = await at.handle(signed('send', { id: OWN.id, command: '\x03' }))
    const call = win.calls.find((c) => c.op === 'send')
    expect(call).toMatchObject({ mode: 'keys', data: '\x03' })
    expect(r.text).toContain('cancel signal')
  })

  it('kill_terminal and get_terminal_output', async () => {
    const win = fakeWindow()
    const { at } = make(win)
    expect((await at.handle(signed('kill', { id: OWN.id }))).text).toContain('Successfully killed terminal')
    expect((await at.handle(signed('output', { id: OWN.id }))).text).toContain('exit code 0')
  })

  it('terminal_list marks busy local shells and the terminals it may write to', async () => {
    const win = fakeWindow()
    const { at } = make(win, { busyOf: async (ids) => Object.fromEntries(ids.map((id) => [id, true])) })
    const r = await at.handle(signed('list'))
    expect(r.text).toContain('pane-peer')
    expect(r.text).toContain('read-only')
  })

  it('strips escape codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m \x1b]633;D;0\x07ok\r\n')).toBe('red ok\n')
  })
})

describe('terminal tools in the MCP server', () => {
  it('lists the VS Code tools, needs Tessel\'s identity', async () => {
    const names = mcp.TERMINAL_TOOLS.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['run_in_terminal', 'get_terminal_output', 'send_to_terminal', 'kill_terminal', 'terminal_last_command', 'terminal_selection', 'terminal_list']))
    const run = mcp.TERMINAL_TOOLS.find((t) => t.name === 'run_in_terminal')
    expect(run.inputSchema.required).toEqual(['command', 'explanation', 'goal', 'mode'])
    const r = await mcp.terminalTool('list', {}, { runtimes: () => [], call: vi.fn() })
    expect(r.isError).toBe(true)
  })

  it('signs with this pane and tries each Tessel', async () => {
    process.env.TESSEL_PANE_ID = AGENT
    process.env.TESSEL_TEAM_SECRET = SECRET
    try {
      const call = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'unknown_pane', message: 'no' } }).mockResolvedValueOnce({ ok: true, result: { text: 'done' } })
      const r = await mcp.terminalTool('run', { command: 'ls', me: 'x' }, { runtimes: () => [{ pipe: 'a' }, { pipe: 'b' }], call })
      expect(r.text).toBe('done')
      const [, method, params] = call.mock.calls[1]
      expect(method).toBe('terminal')
      expect(params.pane).toBe(AGENT)
      expect(params.args).toEqual({ command: 'ls' })
      expect(verifyRequest({ op: params.op, args: params.args, auth: params.auth }, AGENT, 'terminal').ok).toBe(true)
    } finally {
      delete process.env.TESSEL_TEAM_SECRET
      delete process.env.TESSEL_PANE_ID
    }
  })
})

describe('security review: requests that wait', () => {
  it('opening terminals is rate-limited before any approval', async () => {
    const win = fakeWindow({ approve: { allow: false } })
    const { at } = make(win)
    let refused = null
    for (let i = 0; i < 20 && !refused; i++) {
      try {
        await at.handle(signed('run', { command: 'make', explanation: 'x', goal: 'y', mode: 'async' }))
      } catch (err) {
        if (err.code === 'rate_limited') refused = i
      }
    }
    expect(refused).toBe(PREPARE_MAX)
    expect(win.calls.filter((c) => c.op === 'prepare').map((c) => c.mayOpen)).toEqual([...Array(PREPARE_MAX).fill(true), false])
  })

  it('the client going away ends a request waiting for the user, and the window lets it go', async () => {
    const win = fakeWindow({ approve: () => new Promise(() => {}) })
    const { at } = make(win)
    const ctl = new AbortController()
    const p = at.handle(signed('run', { command: 'make', explanation: 'x', goal: 'y', mode: 'sync' }), { signal: ctl.signal })
    await vi.waitFor(() => expect(win.ops()).toContain('approve'))
    ctl.abort()
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(win.calls.find((c) => c.op === 'abort')).toMatchObject({ agent: AGENT })
  })
})

describe('security review: reading a terminal', () => {
  it('a user terminal is read only after the user allows it, once per terminal, and each read is logged', async () => {
    const win = fakeWindow({ target: USER, approve: { allow: true, remember: 'pane' } })
    const { at, sent } = make(win)
    await at.handle(signed('output', { id: USER.id }))
    await at.handle(signed('output', { id: USER.id }))
    const cards = win.calls.filter((c) => c.op === 'approve')
    expect(cards).toHaveLength(1)
    expect(cards[0].card.kind).toBe('read')
    expect(win.ops().filter((o) => o === 'resolve')).toHaveLength(2)
    expect(sent.filter(([ch, p]) => ch === 'terminal:agentLog' && p.kind === 'read')).toHaveLength(2)
  })

  it('denied: nothing is read', async () => {
    const win = fakeWindow({ target: PEER, approve: { allow: false } })
    const { at } = make(win)
    await expect(at.handle(signed('output', { id: PEER.id }))).rejects.toMatchObject({ code: 'denied' })
    expect(win.ops()).not.toContain('output')
  })

  it('its own terminal needs no approval', async () => {
    const win = fakeWindow({ target: OWN })
    const { at } = make(win)
    await at.handle(signed('output', { id: OWN.id }))
    expect(win.ops()).toEqual(['resolve', 'output'])
  })

  it('the active terminal’s last command and selection: the same approval', async () => {
    const win = fakeWindow({ target: USER, approve: { allow: true, remember: 'pane' } })
    const { at } = make(win)
    expect((await at.handle(signed('selection'))).text).toContain('secret selection')
    expect((await at.handle(signed('lastCommand'))).text).toContain('make')
    expect(win.calls.filter((c) => c.op === 'approve')).toHaveLength(1)
    expect(win.calls.find((c) => c.op === 'selection').terminal).toBe(USER.id)
  })

  it('Stop takes reading back too', async () => {
    const win = fakeWindow({ target: USER, approve: { allow: true, remember: 'pane' } })
    const { at } = make(win)
    await at.handle(signed('output', { id: USER.id }))
    await at.handle(signed('run', { id: USER.id, command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }))
    at.stop(USER.id)
    await expect(at.handle(signed('output', { id: USER.id }))).rejects.toMatchObject({ code: 'stopped_by_user' })
  })
})

describe('security review: another SSH host', () => {
  const REMOTE = { ...OWN, id: 'pane-remote', host: 'other', lang: 'bash', shellKind: 'ssh', projectHost: false }
  it('its first use asks the user (per host), and nothing runs there without asking', async () => {
    const win = fakeWindow({ target: REMOTE, approve: (p) => ({ allow: true, remember: p.card.kind === 'host' ? 'pane' : 'once' }) })
    const { at } = make(win, { settings: { autoApprove: true, workspaceRules: { 'C:\proj': { make: true } } } })
    await at.handle(signed('run', { command: 'ls', explanation: 'x', goal: 'y', mode: 'sync', host: 'other' }))
    await at.handle(signed('run', { command: 'make', explanation: 'x', goal: 'y', mode: 'sync', host: 'other' }))
    const kinds = win.calls.filter((c) => c.op === 'approve').map((c) => c.card.kind)
    expect(kinds).toEqual(['host', 'command', 'command'])
    // The host card comes before any terminal is opened there.
    expect(win.ops().indexOf('approve')).toBeLessThan(win.ops().indexOf('prepare'))
  })

  it('a host the user refused: nothing is opened', async () => {
    const win = fakeWindow({ target: REMOTE, approve: { allow: false } })
    const { at } = make(win)
    await expect(at.handle(signed('run', { command: 'ls', explanation: 'x', goal: 'y', mode: 'sync', host: 'other' }))).rejects.toMatchObject({ code: 'denied' })
    expect(win.ops()).not.toContain('prepare')
  })

  it('"allow all in this session" does not cover another host', async () => {
    const win = fakeWindow({ target: REMOTE, approve: (p) => ({ allow: true, remember: 'pane', action: p.card.kind === 'command' ? { kind: 'session' } : null }) })
    const { at } = make(win, { settings: { autoApprove: true } })
    await at.handle(signed('run', { command: 'make', explanation: 'x', goal: 'y', mode: 'sync', host: 'other' }))
    await at.handle(signed('run', { command: 'make', explanation: 'x', goal: 'y', mode: 'sync', host: 'other' }))
    expect(win.calls.filter((c) => c.op === 'approve' && c.card.kind === 'command')).toHaveLength(2)
  })

  it('the project’s own host: no host card', async () => {
    const win = fakeWindow({ target: { ...OWN, projectHost: true } })
    const { at } = make(win, { settings: { autoApprove: true } })
    await at.handle(signed('run', { command: 'ls', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(win.ops()).toEqual(['host', 'prepare', 'run'])
  })
})

describe('security review: Stop and the session', () => {
  it('Stop takes back the agent’s "allow all" and session rules', async () => {
    const win = fakeWindow({ approve: { allow: true, action: { kind: 'session' } } })
    const { at } = make(win, { settings: { autoApprove: true } })
    await at.handle(signed('run', { command: 'make', explanation: 'x', goal: 'y', mode: 'sync' }))
    await at.handle(signed('run', { command: 'make', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(win.calls.filter((c) => c.op === 'approve')).toHaveLength(1)
    at.stop(OWN.id)
    expect(at._sessions.get(AGENT)).toMatchObject({ allowAll: false, rules: {} })
    at.allowAgain(OWN.id, AGENT)
    await at.handle(signed('run', { command: 'make', explanation: 'x', goal: 'y', mode: 'sync' }))
    expect(win.calls.filter((c) => c.op === 'approve')).toHaveLength(2)
  })
})

describe('security review: a command the card shows whole', () => {
  it('at most 50 lines, no run of blank lines', () => {
    expect(() => checkCommand(Array(51).fill('echo x').join('\n'))).toThrow(/50 lines/)
    expect(() => checkCommand('ls\n\n\nrm -rf x')).toThrow(/blank lines/)
    expect(() => checkCommand('ls' + ' '.repeat(10) + '\n \n\t\nrm x')).toThrow(/blank lines/)
    expect(checkCommand('ls\npwd')).toBe('ls\npwd')
  })
})
