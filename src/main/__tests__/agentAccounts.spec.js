// The agents' account tools, main's side (agentAccounts.js): the list passes
// on identity fields only, a switch is asked of the user once and nothing is
// restarted without Allow, a call that went away gets no card, the log names
// ids only. The window is faked here (its side: renderer
// __tests__/agentAccounts.spec.js).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRequire } from 'module'
import { join } from 'path'
import { createAgentAccounts, listText, planText, APPROVAL_TIMEOUT_MS } from '../agentAccounts'
import { handleRequestLine, validateParams, CliError } from '../cliServer'
import { setTeamSecret, verifyRequest, requestMac, _resetTeamAuth } from '../teamAuth'

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
const MAX_ID = 'fd69dfdd-c291-490b-9ea1-4b77fdcb2526'

// A request as the MCP server signs it; checked as the pipe checks it
// unless raw (to reach main with what the pipe would refuse).
function signed(op, args = {}, { pane = AGENT, secret = SECRET, raw = false } = {}) {
  process.env.TESSEL_PANE_ID = pane
  process.env.TESSEL_TEAM_SECRET = secret
  try {
    const r = mcp.accountsRequest(op, args)
    return raw ? r : validateParams('accounts', r)
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
      agent: 'claude',
      agentName: 'Claude Code',
      email: 'max@example.com',
      token: FAKE_TOKEN,
      signIns: [
        {
          id: MAX_ID,
          kind: 'pc',
          place: 'this PC',
          scope: 'tessel',
          org: 'Work\u202e Corp',
          plan: 'max',
          sub: { ...maxSub, accessToken: FAKE_TOKEN },
          signedIn: true,
          switchable: true,
          configDir: 'C:\\Users\\u\\AppData\\Roaming\\tessel\\claude-accounts\\fd69\\auth',
          dir: 'C:\\Users\\u\\.claude\\.credentials.json',
          panes: [{ id: 'p-fable', name: 'Fable', project: 'Tessel', agent: 'Claude Code', host: null, credentials: FAKE_TOKEN }]
        },
        { id: 'ssh:box:claude:f1', kind: 'ssh', place: 'build-box', scope: 'tessel', plan: null, signedIn: true, switchable: true, panes: [] }
      ]
    },
    {
      agent: 'claude',
      agentName: 'Claude Code',
      email: 'old@example.com',
      signIns: [
        {
          id: 'claude:system',
          kind: 'pc',
          place: 'this PC',
          scope: 'system',
          plan: 'max',
          sub: canceledSub,
          signedIn: true,
          switchable: true,
          panes: [
            { id: 'p-curie', name: 'Curie', project: 'BridgeClip', agent: 'Claude Code', host: null },
            { id: 'p-kepler', name: 'Kepler', project: 'Visual Code', agent: 'Claude Code', host: null }
          ]
        }
      ]
    },
    {
      agent: 'codex',
      agentName: 'Codex',
      email: 'dev@example.com',
      signIns: [
        { id: 'codex:system', kind: 'pc', place: 'this PC', scope: 'system', plan: 'plus', signedIn: true, switchable: false, panes: [] },
        { id: 'ssh:box:codex:ab12cd', kind: 'ssh', place: 'build-box', scope: 'tessel', plan: 'plus', signedIn: true, switchable: true, panes: [{ id: 'p-cx', name: 'Codex', project: 'Afterlife', agent: 'Codex', host: 'build-box' }] }
      ]
    }
  ],
  waiting: [{ name: 'Ubuntu', kind: 'wsl', state: 'not checked yet', path: '/home/u/.claude' }],
  scope: null
}

const PLAN = {
  token: 'tok-1',
  account: { agent: 'claude', email: 'max@example.com' },
  signIns: [MAX_ID],
  panes: [
    { id: 'p-curie', name: 'Curie', project: 'BridgeClip' },
    { id: 'p-kepler', name: 'Kepler', project: 'Visual Code' }
  ],
  already: []
}

function fakeWindow({ plan, approve = { allow: true }, results, list = LIST } = {}) {
  const calls = []
  const ask = vi.fn(async (method, params, opts) => {
    expect(method).toBe('accountTarget')
    calls.push({ ...params, opts })
    if (params.op === 'list') return list
    if (params.op === 'plan') return typeof plan === 'function' ? plan(params) : plan || PLAN
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
  it('each account and its sign-ins: id, place and kind, organization, plan from the live check, the panes on each; never a token or a path', async () => {
    const win = fakeWindow()
    const { acc } = make(win)
    const { text } = await acc.handle(signed('list'))
    expect(text).toContain('- max@example.com')
    expect(text).toContain(`  - sign-in ${MAX_ID}: this PC (added in Tessel, organization Work Corp) — Max 20x, active, checked 3 min ago`)
    expect(text).toContain('    Panes (1): "Fable" (id p-fable) in project "Tessel", Claude Code, this PC')
    expect(text).toContain('  - sign-in ssh:box:claude:f1: build-box (SSH, account folder made by Tessel) — plan not known')
    expect(text).toContain('  - sign-in claude:system: this PC (its own sign-in) — Max, subscription canceled, checked 2 h ago')
    expect(text).toContain('    Panes (2): "Curie" (id p-curie) in project "BridgeClip", Claude Code, this PC; "Kepler" (id p-kepler) in project "Visual Code"')
    // Codex: its login file's plan; the PC sign-in takes no panes, the host's does.
    expect(text).toContain('  - sign-in codex:system: this PC (its own sign-in, panes cannot move to it) — plus (as its login file says; not checked)')
    expect(text).toContain('"Codex" (id p-cx) in project "Afterlife", Codex, SSH build-box')
    expect(text).toContain('Not read yet (their sign-ins are not shown): Ubuntu (WSL, not checked yet).')
    // Nothing the window should not have sent gets through, nor invisible characters.
    expect(text).not.toContain('sk-ant')
    expect(text).not.toMatch(/credentials|AppData|\.claude|\/home\//i)
    expect(text).not.toMatch(/[\u202e\u200b]/)
    expect(win.calls[0]).toMatchObject({ agent: AGENT, op: 'list' })
  })

  it('an agent on an SSH host is told what it sees', () => {
    const text = listText({ ...LIST, scope: { host: 'build-box', project: 'Server' } })
    expect(text).toContain('You run on the SSH host build-box: you see its sign-ins and the panes of your project "Server" there, and may move only those.')
    expect(listText({ accounts: [], waiting: [], scope: { host: 'build-box', project: 'Server' } })).toMatch(/knows no agent sign-in yet on your host/)
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
    const { text } = await acc.handle(signed('switch', { panes: ['Curie', 'Kepler'], account: MAX_ID, explanation: 'The old subscription ended.' }))
    expect(win.ops()).toEqual(['plan', 'approve', 'switch'])
    const [plan, approve, sw] = win.calls
    expect(plan).toMatchObject({ agent: AGENT, panes: ['Curie', 'Kepler'], account: MAX_ID })
    expect(approve).toMatchObject({ agent: AGENT, token: 'tok-1', explanation: 'The old subscription ended.', timeoutMs: APPROVAL_TIMEOUT_MS })
    // Main waits a little longer than the card stays up.
    expect(approve.opts.timeoutMs).toBeGreaterThan(APPROVAL_TIMEOUT_MS)
    expect(sw).toMatchObject({ agent: AGENT, token: 'tok-1' })
    expect(text).toContain('The user allowed it. Panes moved to max@example.com:')
    expect(text).toContain('- "Curie" (BridgeClip): restarted on max@example.com, its conversation resumed')
    expect(text).toContain('- "Kepler" (Visual Code): could not be restarted: its terminal did not stop')
  })

  it('what the agent says reaches the card without control or invisible characters', async () => {
    const win = fakeWindow({ approve: { allow: false } })
    await make(win).acc.handle(signed('switch', { panes: ['Curie'], account: MAX_ID, explanation: 'Tessel\u202e lla wollA \u202c\u200b\u2066Verified\u2069\ufeff <b>x</b>\nnew\u0007' })).catch(() => {})
    expect(win.calls.find((c) => c.op === 'approve').explanation).toBe('Tessel lla wollA Verified <b>x</b> new')
  })

  it('Refuse: nothing restarted, the agent is told not to ask again; "don\'t ask again" says so too', async () => {
    const win = fakeWindow({ approve: { allow: false } })
    await expect(make(win).acc.handle(signed('switch', { panes: ['Curie'], account: MAX_ID }))).rejects.toMatchObject({ code: 'denied', message: expect.stringContaining('refused') })
    expect(win.ops()).toEqual(['plan', 'approve'])
    const blocked = fakeWindow({ approve: { allow: false, blocked: true } })
    await expect(make(blocked).acc.handle(signed('switch', { panes: ['Curie'], account: MAX_ID }))).rejects.toMatchObject({ code: 'denied', message: expect.stringContaining('asked not to get account switch requests from you again') })
  })

  it('no answer in time (the card closed, or the window never answered): nothing restarted', async () => {
    const win = fakeWindow({ approve: { allow: false, timedOut: true, ms: 50000 } })
    await expect(make(win).acc.handle(signed('switch', { panes: ['Curie'], account: MAX_ID }))).rejects.toMatchObject({ code: 'approval_timeout', message: expect.stringContaining('No answer from the user in 50 s') })
    expect(win.ops()).toEqual(['plan', 'approve'])
    const silent = fakeWindow({
      approve: () => {
        throw new CliError('timeout', 'Tessel’s window did not answer in time.')
      }
    })
    await expect(make(silent).acc.handle(signed('switch', { panes: ['Curie'], account: MAX_ID }))).rejects.toMatchObject({ code: 'approval_timeout' })
    expect(silent.ops()).toEqual(['plan', 'approve'])
  })

  it('a switch the window refuses (wrong agent, wrong machine, unknown pane, no subscription, two sign-ins) is never shown to the user', async () => {
    for (const code of ['wrong_agent', 'wrong_machine', 'unknown_pane', 'inactive_account', 'ambiguous_account', 'cooldown', 'pending', 'blocked', 'disabled']) {
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
    const auth = { nonce: 'n'.repeat(20), at: 1, mac: 'm' }
    expect(() => validateParams('accounts', { pane: AGENT, op: 'switch', args: { panes: ['Curie'], account: 'x', allow: true }, auth })).toThrow(CliError)
    expect(() => validateParams('accounts', { pane: AGENT, op: 'approve', args: {}, auth })).toThrow(CliError)
    // The tool's limits, the pipe's limits: the same.
    expect(() => validateParams('accounts', { pane: AGENT, op: 'switch', args: { panes: Array.from({ length: 21 }, (_, i) => `p${i}`), account: 'x' }, auth })).toThrow(CliError)
    expect(() => validateParams('accounts', { pane: AGENT, op: 'switch', args: { panes: ['p'.repeat(121)], account: 'x' }, auth })).toThrow(CliError)
    expect(() => validateParams('accounts', { pane: AGENT, op: 'switch', args: { panes: ['p'], account: 'x', explanation: 'e'.repeat(301) }, auth })).toThrow(CliError)
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
    // Signed by hand: the tool and the pipe never send that many.
    const args = { panes: Array.from({ length: 21 }, (_, i) => `p${i}`), account: 'x' }
    const nonce = 'n'.repeat(18) + 'toomany'
    const at = Date.now()
    await expect(acc.handle({ pane: AGENT, op: 'switch', args, auth: { nonce, at, mac: requestMac(SECRET, AGENT, 'accounts', { op: 'switch', args, nonce, at }) } })).rejects.toMatchObject({ code: 'too_many' })
    await expect(acc.handle(signed('switch', { panes: ['Curie'] }))).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(win.ask).not.toHaveBeenCalled()
  })

  it('its tool call going away while the window checks it: no card at all', async () => {
    let release
    const win = fakeWindow({ plan: () => new Promise((r) => (release = () => r(PLAN))) })
    const { acc, lines } = make(win)
    const ctrl = new AbortController()
    const p = acc.handle(signed('switch', { panes: ['Curie'], account: MAX_ID }), { signal: ctrl.signal })
    await vi.waitFor(() => expect(win.ops()).toContain('plan'))
    ctrl.abort()
    release()
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(win.ops()).toEqual(['plan', 'abort'])
    expect(lines.some((l) => l.includes('cancelled before asking the user'))).toBe(true)
  })

  it('its tool call going away while the card is up: the card goes, nothing restarts, and the handler is over before its place is freed', async () => {
    let answerCard
    const win = fakeWindow({ approve: () => new Promise((r) => (answerCard = r)) })
    const { acc, lines } = make(win)
    const ctrl = new AbortController()
    let settled = false
    const p = acc.handle(signed('switch', { panes: ['Curie'], account: MAX_ID }), { signal: ctrl.signal }).finally(() => (settled = true))
    await vi.waitFor(() => expect(win.ops()).toContain('approve'))
    ctrl.abort()
    await new Promise((r) => setTimeout(r, 10))
    // Still running: the window has not answered the dropped card yet.
    expect(settled).toBe(false)
    expect(win.ops()).toContain('abort')
    answerCard({ allow: false })
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(win.ops()).not.toContain('switch')
    expect(lines.some((l) => l.includes('cancelled while the user was asked'))).toBe(true)
    expect(lines.some((l) => l.includes('refused by the user'))).toBe(false)
  })

  it('one log line per request and per decision, with ids only (no email, no token)', async () => {
    const win = fakeWindow()
    const { acc, lines } = make(win)
    await acc.handle(signed('list'))
    await acc.handle(signed('switch', { panes: ['Curie', 'Kepler'], account: 'max@example.com', explanation: `token ${FAKE_TOKEN}` }))
    const refused = fakeWindow({ approve: { allow: false } })
    const r = make(refused)
    await r.acc.handle(signed('switch', { panes: ['alice@example.com'], account: 'max@example.com' })).catch(() => {})
    const all = [...lines, ...r.lines]
    expect(all).toEqual([
      `agent-accounts account_list by ${AGENT}`,
      `agent-accounts account_switch_panes by ${AGENT}: 2 pane(s) asked for`,
      `agent-accounts account_switch_panes by ${AGENT}: asking the user: 2 pane(s) [p-curie, p-kepler] -> sign-in ${MAX_ID}`,
      `agent-accounts account_switch_panes by ${AGENT}: allowed by the user`,
      `agent-accounts account_switch_panes by ${AGENT}: done (restarted 1, failed 1)`,
      `agent-accounts account_switch_panes by ${AGENT}: 1 pane(s) asked for`,
      `agent-accounts account_switch_panes by ${AGENT}: asking the user: 2 pane(s) [p-curie, p-kepler] -> sign-in ${MAX_ID}`,
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
    const line = `TESSEL-CLI 1 ${Buffer.from(JSON.stringify({ token: TOKEN, method: 'accounts', params: signed('list', {}, { raw: true }) })).toString('base64')}`
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
    expect(sw.description).toContain('sign-in')
    expect(mcp.ACCOUNT_TOOLS[0].description).toContain('never a token')
    const r = await mcp.accountsTool('list', {}, null, { runtimes: () => [], call: vi.fn() })
    expect(r.isError).toBe(true)
  })

  it('over Tessel\'s limits: said plainly, nothing sent', async () => {
    process.env.TESSEL_PANE_ID = AGENT
    process.env.TESSEL_TEAM_SECRET = SECRET
    try {
      const call = vi.fn()
      const deps = { runtimes: () => [{ pipe: 'a' }], call }
      expect((await mcp.accountsTool('switch', { panes: ['Curie'], account: 'x', explanation: 'e'.repeat(301) }, null, deps)).text).toMatch(/"explanation" is at most 300 characters/)
      expect((await mcp.accountsTool('switch', { panes: Array.from({ length: 21 }, (_, i) => `p${i}`), account: 'x' }, null, deps)).text).toMatch(/At most 20 panes/)
      expect((await mcp.accountsTool('switch', { panes: ['p'.repeat(121)], account: 'x' }, null, deps)).text).toMatch(/at most 120 characters/)
      expect(call).not.toHaveBeenCalled()
    } finally {
      delete process.env.TESSEL_TEAM_SECRET
      delete process.env.TESSEL_PANE_ID
    }
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
