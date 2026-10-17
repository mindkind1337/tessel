// The agents' account tools, main's side (agentAccounts.js): the list passes
// on identity fields only, a switch is asked of the user once and nothing is
// restarted without Allow, the log names ids only. The window is faked here
// (its side: renderer __tests__/agentAccounts.spec.js).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRequire } from 'module'
import { join } from 'path'
import { createAgentAccounts, listText, planText, APPROVAL_TIMEOUT_MS } from '../agentAccounts'
import { handleRequestLine, validateParams, CliError } from '../cliServer'
import { setTeamSecret, verifyRequest, _resetTeamAuth } from '../teamAuth'

// Run inside a Tessel pane, these tests would sign as that pane.
delete process.env.TESSEL_TEAM_SECRET
delete process.env.TESSEL_PANE_ID

const require = createRequire(import.meta.url)
const mcp = require(join(__dirname, '..', 'teamMcp', 'server.cjs'))

const AGENT = 'pane-fable'
const SECRET = 'a'.repeat(64)
const TOKEN = 'b'.repeat(64)
const NOW = Date.UTC(2026, 9, 17, 12)
const FAKE_TOKEN = 'sk-ant-oat01-SECRETSECRETSECRET'

function signed(op, args = {}, { pane = AGENT, secret = SECRET } = {}) {
  process.env.TESSEL_PANE_ID = pane
  process.env.TESSEL_TEAM_SECRET = secret
  try {
    return validateParams('accounts', mcp.accountsRequest(op, args))
  } finally {
    delete process.env.TESSEL_TEAM_SECRET
    delete process.env.TESSEL_PANE_ID
  }
}

const maxSub = { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', subscription_status: 'active', has_claude_max: true, checkedAt: NOW - 3 * 60000 }
const canceledSub = { organization_type: 'claude_max', subscription_status: 'canceled', has_claude_max: true, checkedAt: NOW - 2 * 3600000 }

// What the window answers for account_list, with fields that must never reach the agent.
const LIST = {
  accounts: [
    {
      id: 'fd69dfdd-c291-490b-9ea1-4b77fdcb2526',
      agent: 'claude',
      agentName: 'Claude Code',
      email: 'max@example.com',
      plan: 'max',
      sub: { ...maxSub, accessToken: FAKE_TOKEN },
      token: FAKE_TOKEN,
      configDir: 'C:\\Users\\u\\AppData\\Roaming\\tessel\\claude-accounts\\fd69\\auth',
      places: [{ kind: 'pc', name: 'this PC', scope: 'tessel', signedIn: true, switchable: true, sub: maxSub, dir: 'C:\\Users\\u\\.claude\\.credentials.json' }],
      panes: [{ id: 'p-fable', name: 'Fable', project: 'Tessel', agent: 'Claude Code', host: null, credentials: FAKE_TOKEN }]
    },
    {
      id: 'claude-1a2b3c4d',
      agent: 'claude',
      agentName: 'Claude Code',
      email: 'old@example.com',
      plan: 'max',
      sub: canceledSub,
      places: [{ kind: 'pc', name: 'this PC', scope: 'system', signedIn: true, switchable: true, sub: canceledSub }],
      panes: [
        { id: 'p-curie', name: 'Curie', project: 'BridgeClip', agent: 'Claude Code', host: null },
        { id: 'p-kepler', name: 'Kepler', project: 'Visual Code', agent: 'Claude Code', host: null }
      ]
    },
    {
      id: 'codex-9f9f9f9f',
      agent: 'codex',
      agentName: 'Codex',
      email: 'dev@example.com',
      plan: 'plus',
      places: [
        { kind: 'pc', name: 'this PC', scope: 'system', signedIn: true, switchable: false },
        { kind: 'ssh', name: 'build-box', scope: 'tessel', signedIn: true, switchable: true }
      ],
      panes: [{ id: 'p-cx', name: 'Codex', project: 'Afterlife', agent: 'Codex', host: 'build-box' }]
    }
  ],
  waiting: [{ name: 'Ubuntu', kind: 'wsl', state: 'not checked yet', path: '/home/u/.claude' }]
}

function fakeWindow({ plan, approve = { allow: true }, results } = {}) {
  const calls = []
  const ask = vi.fn(async (method, params, opts) => {
    expect(method).toBe('accountTarget')
    calls.push({ ...params, opts })
    if (params.op === 'list') return LIST
    if (params.op === 'plan') {
      if (typeof plan === 'function') return plan(params)
      return (
        plan || {
          token: 'tok-1',
          account: { id: 'fd69dfdd-c291-490b-9ea1-4b77fdcb2526', agent: 'claude', email: 'max@example.com' },
          panes: [
            { id: 'p-curie', name: 'Curie', project: 'BridgeClip' },
            { id: 'p-kepler', name: 'Kepler', project: 'Visual Code' }
          ],
          already: []
        }
      )
    }
    if (params.op === 'approve') return typeof approve === 'function' ? approve(params, opts) : approve
    if (params.op === 'switch')
      return {
        results: results || [
          { id: 'p-curie', name: 'Curie', project: 'BridgeClip', status: 'restarted' },
          { id: 'p-kepler', name: 'Kepler', project: 'Visual Code', status: 'failed' }
        ]
      }
    if (params.op === 'abort') return { ok: true }
    throw new Error(`unexpected op ${params.op}`)
  })
  return { ask, calls, ops: () => calls.map((c) => c.op) }
}

function make(win) {
  const lines = []
  const log = { info: vi.fn((tag, msg) => lines.push(`${tag} ${msg}`)), warn: vi.fn((tag, msg) => lines.push(`${tag} ${msg}`)) }
  const acc = createAgentAccounts({ verify: (body, paneId) => verifyRequest(body, paneId, 'accounts'), ask: win.ask, log, now: () => NOW })
  return { acc, lines }
}

beforeEach(() => {
  _resetTeamAuth()
  setTeamSecret(AGENT, SECRET)
})

describe('account_list', () => {
  it('each account: id, email, plan from the live check, where it is signed in, its panes; never a token or a path', async () => {
    const win = fakeWindow()
    const { acc } = make(win)
    const { text } = await acc.handle(signed('list'))
    expect(text).toContain('id fd69dfdd-c291-490b-9ea1-4b77fdcb2526: max@example.com — Max 20x, active, checked 3 min ago')
    expect(text).toContain('id claude-1a2b3c4d: old@example.com — Max, subscription canceled, checked 2 h ago')
    expect(text).toContain('Signed in on: this PC (added in Tessel)')
    expect(text).toContain('"Fable" (id p-fable) in project "Tessel", Claude Code, this PC')
    expect(text).toContain('Panes (2): "Curie" (id p-curie) in project "BridgeClip", Claude Code, this PC; "Kepler" (id p-kepler) in project "Visual Code"')
    // Codex: its login file's plan; the PC sign-in takes no panes, the host's does.
    expect(text).toContain('id codex-9f9f9f9f: dev@example.com — plus (as its login file says; not checked)')
    expect(text).toContain('this PC (its own sign-in, panes cannot move to it there); build-box (SSH, account folder made by Tessel)')
    expect(text).toContain('"Codex" (id p-cx) in project "Afterlife", Codex, SSH build-box')
    expect(text).toContain('Not read yet (their accounts are not shown): Ubuntu (WSL, not checked yet).')
    // Nothing the window should not have sent gets through.
    expect(text).not.toContain('sk-ant')
    expect(text).not.toMatch(/credentials|AppData|\.claude|\/home\//i)
    expect(win.calls[0]).toMatchObject({ agent: AGENT, op: 'list' })
  })

  it('no account yet: says so', () => {
    expect(listText({ accounts: [], waiting: [] })).toMatch(/knows no agent sign-in account yet/)
  })

  it('a plan: the live check wins over the login file', () => {
    expect(planText('claude', 'max', canceledSub, NOW)).toBe('Max, subscription canceled, checked 2 h ago')
    expect(planText('claude', 'max', null, NOW)).toBe('max (as its login file says; not checked)')
    expect(planText('claude', null, { organization_type: 'claude_free', checkedAt: NOW }, NOW)).toBe('Free, no subscription, checked just now')
  })
})

describe('account_switch_panes', () => {
  it('Allow: the user is asked once, then the window restarts each pane; the answer gives each result', async () => {
    const win = fakeWindow()
    const { acc } = make(win)
    const { text } = await acc.handle(signed('switch', { panes: ['Curie', 'Kepler'], account: 'fd69dfdd-c291-490b-9ea1-4b77fdcb2526', explanation: 'The old subscription ended.' }))
    expect(win.ops()).toEqual(['plan', 'approve', 'switch'])
    const [plan, approve, sw] = win.calls
    expect(plan).toMatchObject({ agent: AGENT, panes: ['Curie', 'Kepler'], account: 'fd69dfdd-c291-490b-9ea1-4b77fdcb2526' })
    expect(approve).toMatchObject({ agent: AGENT, token: 'tok-1', explanation: 'The old subscription ended.', timeoutMs: APPROVAL_TIMEOUT_MS })
    // Main waits a little longer than the card stays up.
    expect(approve.opts.timeoutMs).toBeGreaterThan(APPROVAL_TIMEOUT_MS)
    expect(sw).toMatchObject({ agent: AGENT, token: 'tok-1' })
    expect(text).toContain('The user allowed it. Panes moved to max@example.com:')
    expect(text).toContain('- "Curie" (BridgeClip): restarted on max@example.com, its conversation resumed')
    expect(text).toContain('- "Kepler" (Visual Code): could not be restarted: its terminal did not stop')
  })

  it('Refuse: nothing restarted, the agent is told not to ask again', async () => {
    const win = fakeWindow({ approve: { allow: false } })
    const { acc } = make(win)
    await expect(acc.handle(signed('switch', { panes: ['Curie'], account: 'max@example.com' }))).rejects.toMatchObject({ code: 'denied', message: expect.stringContaining('refused') })
    expect(win.ops()).toEqual(['plan', 'approve'])
  })

  it('no answer in time (the card closed, or the window never answered): nothing restarted', async () => {
    const win = fakeWindow({ approve: { allow: false, timedOut: true } })
    const { acc } = make(win)
    await expect(acc.handle(signed('switch', { panes: ['Curie'], account: 'max@example.com' }))).rejects.toMatchObject({ code: 'approval_timeout' })
    expect(win.ops()).toEqual(['plan', 'approve'])
    const silent = fakeWindow({
      approve: () => {
        throw new CliError('timeout', 'Tessel’s window did not answer in time.')
      }
    })
    await expect(make(silent).acc.handle(signed('switch', { panes: ['Curie'], account: 'max@example.com' }))).rejects.toMatchObject({ code: 'approval_timeout' })
    expect(silent.ops()).toEqual(['plan', 'approve'])
  })

  it('a switch the window refuses (wrong agent, wrong machine, unknown pane, no subscription) is never shown to the user', async () => {
    for (const code of ['wrong_agent', 'wrong_machine', 'unknown_pane', 'inactive_account']) {
      const win = fakeWindow({
        plan: () => {
          throw new CliError(code, `refused: ${code}`)
        }
      })
      const { acc, lines } = make(win)
      await expect(acc.handle(signed('switch', { panes: ['Curie'], account: 'x' }))).rejects.toMatchObject({ code })
      expect(win.ops()).toEqual(['plan'])
      expect(lines.at(-1)).toContain(`refused before asking the user (${code})`)
    }
  })

  it('nothing in the request answers the card: unknown arguments are refused at the pipe and dropped by the tool', async () => {
    // The pipe takes panes, account and explanation only.
    expect(() => validateParams('accounts', { pane: AGENT, op: 'switch', args: { panes: ['Curie'], account: 'x', allow: true }, auth: { nonce: 'n', at: 1, mac: 'm' } })).toThrow(CliError)
    expect(() => validateParams('accounts', { pane: AGENT, op: 'approve', args: {}, auth: { nonce: 'n', at: 1, mac: 'm' } })).toThrow(CliError)
    // The MCP tool never sends them.
    const req = signed('switch', { panes: 'Curie, Kepler', account: 'max@example.com', allow: true, approved: true, me: '#2' })
    expect(req.args).toEqual({ panes: ['Curie', 'Kepler'], account: 'max@example.com' })
    // A signed request still goes through the card, whatever it says.
    const win = fakeWindow({ approve: { allow: false } })
    await expect(make(win).acc.handle(req)).rejects.toMatchObject({ code: 'denied' })
    expect(win.ops()).toEqual(['plan', 'approve'])
  })

  it('a request not signed by the pane is refused before anything is asked', async () => {
    const win = fakeWindow()
    const { acc } = make(win)
    const forged = signed('switch', { panes: ['Curie'], account: 'x' }, { secret: 'c'.repeat(64) })
    await expect(acc.handle(forged)).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(acc.handle({ ...signed('list'), auth: { nonce: '', at: 0, mac: '' } })).rejects.toBeInstanceOf(CliError)
    expect(win.ask).not.toHaveBeenCalled()
  })

  it('bad arguments: no panes, too many, no account', async () => {
    const win = fakeWindow()
    const { acc } = make(win)
    await expect(acc.handle(signed('switch', { account: 'x' }))).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(acc.handle(signed('switch', { panes: Array.from({ length: 21 }, (_, i) => `p${i}`), account: 'x' }))).rejects.toMatchObject({ code: 'too_many' })
    await expect(acc.handle(signed('switch', { panes: ['Curie'] }))).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(win.ask).not.toHaveBeenCalled()
  })

  it('its tool call going away drops the card', async () => {
    let release
    const win = fakeWindow({ approve: () => new Promise((r) => (release = r)) })
    const { acc } = make(win)
    const ctrl = new AbortController()
    const p = acc.handle(signed('switch', { panes: ['Curie'], account: 'x' }), { signal: ctrl.signal })
    await vi.waitFor(() => expect(win.ops()).toContain('approve'))
    ctrl.abort()
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(win.ops()).toContain('abort')
    release({ allow: true })
    await new Promise((r) => setTimeout(r, 10))
    expect(win.ops()).not.toContain('switch')
  })

  it('one log line per request and per decision, with ids only (no email, no token)', async () => {
    const win = fakeWindow()
    const { acc, lines } = make(win)
    await acc.handle(signed('list'))
    await acc.handle(signed('switch', { panes: ['Curie', 'Kepler'], account: 'max@example.com', explanation: `token ${FAKE_TOKEN}` }))
    const refused = fakeWindow({ approve: { allow: false } })
    const r = make(refused)
    await r.acc.handle(signed('switch', { panes: ['Curie'], account: 'max@example.com' })).catch(() => {})
    const all = [...lines, ...r.lines]
    expect(all).toEqual([
      `agent-accounts account_list by ${AGENT}`,
      `agent-accounts account_switch_panes by ${AGENT}: 2 pane(s) asked for`,
      `agent-accounts account_switch_panes by ${AGENT}: asking the user: 2 pane(s) [p-curie, p-kepler] -> account fd69dfdd-c291-490b-9ea1-4b77fdcb2526`,
      `agent-accounts account_switch_panes by ${AGENT}: allowed by the user`,
      `agent-accounts account_switch_panes by ${AGENT}: done (restarted 1, failed 1)`,
      `agent-accounts account_switch_panes by ${AGENT}: 1 pane(s) asked for`,
      `agent-accounts account_switch_panes by ${AGENT}: asking the user: 2 pane(s) [p-curie, p-kepler] -> account fd69dfdd-c291-490b-9ea1-4b77fdcb2526`,
      `agent-accounts account_switch_panes by ${AGENT}: refused by the user (nothing restarted)`
    ])
    for (const l of all) {
      expect(l).not.toContain('@')
      expect(l).not.toContain('sk-ant')
    }
  })

  it('goes over the tessel pipe as method "accounts"', async () => {
    const win = fakeWindow()
    const { acc } = make(win)
    const line = `TESSEL-CLI 1 ${Buffer.from(JSON.stringify({ token: TOKEN, method: 'accounts', params: (() => {
      process.env.TESSEL_PANE_ID = AGENT
      process.env.TESSEL_TEAM_SECRET = SECRET
      const r = mcp.accountsRequest('list', {})
      delete process.env.TESSEL_TEAM_SECRET
      delete process.env.TESSEL_PANE_ID
      return r
    })() })).toString('base64')}`
    const reply = JSON.parse(await handleRequestLine(line, { token: TOKEN, handlers: { accounts: (p) => acc.handle(p) } }))
    expect(reply.ok).toBe(true)
    expect(reply.result.text).toContain('max@example.com')
  })
})

describe('account tools in the MCP server', () => {
  it('two tools, described for the agent; Tessel\'s identity needed', async () => {
    expect(mcp.ACCOUNT_TOOLS.map((t) => t.name)).toEqual(['account_list', 'account_switch_panes'])
    expect(mcp.TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['account_list', 'account_switch_panes']))
    const sw = mcp.ACCOUNT_TOOLS[1]
    expect(sw.inputSchema.required).toEqual(['panes', 'account'])
    expect(sw.description).toContain('Allow or Refuse')
    expect(sw.description).toContain('no answer in 2 minutes counts as Refuse')
    expect(mcp.ACCOUNT_TOOLS[0].description).toContain('never a token')
    const r = await mcp.accountsTool('list', {}, null, { runtimes: () => [], call: vi.fn() })
    expect(r.isError).toBe(true)
  })

  it('signs with this pane, passes the cancel signal, tries each Tessel', async () => {
    process.env.TESSEL_PANE_ID = AGENT
    process.env.TESSEL_TEAM_SECRET = SECRET
    try {
      const call = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'unknown_pane', message: 'no' } }).mockResolvedValueOnce({ ok: true, result: { text: 'moved' } })
      const signal = new AbortController().signal
      const r = await mcp.accountsTool('switch', { panes: ['Curie'], account: 'x', me: '#1' }, signal, { runtimes: () => [{ pipe: 'a' }, { pipe: 'b' }], call })
      expect(r.text).toBe('moved')
      const [, method, params, , sig] = call.mock.calls[1]
      expect(method).toBe('accounts')
      expect(sig).toBe(signal)
      expect(params.args).toEqual({ panes: ['Curie'], account: 'x' })
      expect(verifyRequest({ op: params.op, args: params.args, auth: params.auth }, AGENT, 'accounts').ok).toBe(true)
      // Signed for the account tools only: not a terminal request.
      expect(verifyRequest({ op: params.op, args: params.args, auth: params.auth }, AGENT, 'terminal').ok).not.toBe(true)
    } finally {
      delete process.env.TESSEL_TEAM_SECRET
      delete process.env.TESSEL_PANE_ID
    }
  })
})
