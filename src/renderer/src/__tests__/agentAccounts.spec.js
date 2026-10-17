// The agents' account tools, the window's side (agentAccounts.js): the
// accounts and the panes on each, a switch checked as Switch panes… checks
// it, one card, and the pane menu's Restart on <account> for each pane, only
// after the card's Allow. Main's side: main __tests__/agentAccounts.spec.js.
import { describe, it, expect, vi } from 'vitest'
import { createAgentAccountTargets, shortHash, accountId, SELF_RESTART_MS, APPROVAL_MS } from '../agentAccounts'

const NOW = Date.UTC(2026, 9, 17, 12)
const MAX_ID = 'fd69dfdd-c291-490b-9ea1-4b77fdcb2526'
const FAKE_TOKEN = 'sk-ant-oat01-SECRETSECRETSECRET'
const maxSub = { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', subscription_status: 'active', has_claude_max: true, checkedAt: NOW - 60000 }
const canceledSub = { organization_type: 'claude_max', subscription_status: 'canceled', has_claude_max: true, checkedAt: NOW - 3600000 }

// main's signedInPlaces.places(): this PC (the system's sign-in, whose Max
// was canceled, and the Max account added in Tessel; Codex), an SSH host,
// a WSL distro not read yet.
function places() {
  return [
    {
      id: 'pc',
      kind: 'pc',
      state: 'ready',
      entries: [
        { agent: 'claude', scope: 'system', id: null, email: 'old@example.com', plan: 'max', state: 'signed-in', sub: canceledSub },
        { agent: 'claude', scope: 'tessel', id: MAX_ID, email: 'max@example.com', plan: 'max', state: 'signed-in', sub: maxSub },
        { agent: 'codex', scope: 'system', id: null, email: 'dev@example.com', plan: 'plus', state: 'signed-in' }
      ]
    },
    {
      id: 'ssh:box',
      kind: 'ssh',
      hostId: 'box',
      label: 'build-box',
      state: 'ready',
      entries: [
        // Fields that must never reach the agent (main strips them already).
        { agent: 'claude', scope: 'default', id: null, email: 'host@example.com', state: 'signed-in', dir: '/home/u/.claude', token: FAKE_TOKEN },
        { agent: 'codex', scope: 'tessel', id: 'ab12cd', email: 'dev@example.com', state: 'signed-in' }
      ]
    },
    { id: 'wsl:Ubuntu', kind: 'wsl', distro: 'Ubuntu', label: 'Ubuntu', state: 'unknown', entries: [] }
  ]
}

const pane = (id, name, project, extra = {}) => ({ id, kind: 'agent', name, agentId: 'claude', remoteHostId: null, hostAccount: undefined, accountId: null, detected: false, project, ...extra })
function panes() {
  return [
    pane('p-curie', 'Curie', 'BridgeClip'),
    pane('p-lovelace', 'Lovelace', 'BridgeClip'),
    pane('p-noether', 'Noether', 'BridgeClip', { accountId: undefined }),
    pane('p-kepler', 'Kepler', 'Visual Code'),
    pane('p-cavendish', 'Cavendish', 'Afterlife'),
    pane('p-fable', 'Fable', 'Tessel', { accountId: MAX_ID }),
    pane('p-dup1', 'Claude Code', 'One', { accountId: MAX_ID }),
    pane('p-dup2', 'Claude Code', 'Two', { accountId: MAX_ID }),
    pane('p-codex', 'Codex', 'Afterlife', { agentId: 'codex', accountId: undefined }),
    pane('p-remote', 'Remote', 'Server', { remoteHostId: 'box' })
  ]
}

function make(extra = {}) {
  const timers = []
  let list = extra.panes || panes()
  const deps = {
    places: vi.fn(async () => places()),
    panes: () => list,
    findPane: (ref) => (ref === 'zsh' ? { name: 'zsh', kind: 'shell' } : ref === 'Chat' ? { name: 'Chat', kind: 'chat' } : null),
    requester: (id) => (['p-lead', 'p-curie', 'p-fable'].includes(id) ? { label: id === 'p-lead' ? 'Lead' : id.slice(2) } : null),
    agentName: (id) => ({ claude: 'Claude Code', codex: 'Codex' })[id] || id,
    hostLabel: (id) => (id === 'box' ? 'build-box' : id),
    paneState: (id) => (id === 'p-kepler' ? 'working' : null),
    approve: vi.fn(async () => ({ allow: true })),
    dismiss: vi.fn(),
    restart: vi.fn(async () => 'ok'),
    switched: vi.fn(),
    later: (fn, ms) => timers.push({ fn, ms }),
    now: () => NOW,
    newToken: (() => {
      let n = 0
      return () => `tok-${++n}`
    })(),
    ...extra.deps
  }
  const at = createAgentAccountTargets(deps)
  return { at, deps, timers, setPanes: (p) => (list = p) }
}
const OLD_ID = `claude-${shortHash('claude|old@example.com')}`

describe('account_list', () => {
  it('each account Tessel knows: id, email, plan, where it is signed in, the panes on it (name, project, agent, host)', async () => {
    const { at } = make()
    const r = await at.handle({ agent: 'p-lead', op: 'list' })
    const byId = Object.fromEntries(r.accounts.map((a) => [a.id, a]))
    // The account added in Tessel is known by its id; another by a hash of its key.
    expect(Object.keys(byId)).toEqual(expect.arrayContaining([MAX_ID, OLD_ID]))
    expect(byId[MAX_ID]).toMatchObject({ agent: 'claude', email: 'max@example.com', sub: maxSub })
    expect(byId[MAX_ID].panes.map((p) => p.name)).toEqual(['Fable', 'Claude Code', 'Claude Code'])
    const old = byId[OLD_ID]
    expect(old.places).toEqual([{ kind: 'pc', name: 'this PC', scope: 'system', signedIn: true, switchable: true, sub: canceledSub }])
    expect(old.panes.map((p) => [p.name, p.project, p.agent, p.host])).toEqual([
      ['Curie', 'BridgeClip', 'Claude Code', null],
      ['Lovelace', 'BridgeClip', 'Claude Code', null],
      ['Noether', 'BridgeClip', 'Claude Code', null],
      ['Kepler', 'Visual Code', 'Claude Code', null],
      ['Cavendish', 'Afterlife', 'Claude Code', null]
    ])
    const host = r.accounts.find((a) => a.email === 'host@example.com')
    expect(host.places[0]).toMatchObject({ kind: 'ssh', name: 'build-box', scope: 'default', switchable: true })
    expect(host.panes).toEqual([expect.objectContaining({ id: 'p-remote', name: 'Remote', host: 'build-box' })])
    // Codex on this PC keeps its account (Switch panes never offers it); on the host it can.
    const codex = r.accounts.find((a) => a.agent === 'codex')
    expect(codex.places.map((p) => [p.name, p.switchable])).toEqual([['this PC', false], ['build-box', true]])
    expect(r.waiting).toEqual([{ name: 'Ubuntu', kind: 'wsl', state: 'not checked yet' }])
    // Identity fields only.
    const json = JSON.stringify(r)
    expect(json).not.toContain('/home/u/.claude')
    expect(json).not.toContain('sk-ant')
  })

  it('an account id is stable and never shows the email', () => {
    expect(shortHash('claude|old@example.com')).toMatch(/^[0-9a-f]{8}$/)
    expect(shortHash('claude|old@example.com')).toBe(shortHash('claude|old@example.com'))
    expect(accountId({ agent: 'claude', key: 'claude|old@example.com', chips: [] })).not.toContain('old')
    expect(accountId({ agent: 'claude', unknown: true, key: 'claude|?', chips: [] })).toBe('claude-unknown')
  })

  it('only an agent pane may ask', async () => {
    const { at } = make()
    await expect(at.handle({ agent: 'p-shell', op: 'list' })).rejects.toMatchObject({ code: 'not_agent' })
  })
})

describe('account_switch_panes: the checks (nothing asked when one fails)', () => {
  const cases = [
    ['a Codex pane to a Claude account', ['Codex'], MAX_ID, 'wrong_agent', /"Codex" is a Codex pane and max@example.com is a Claude Code account/],
    ['an SSH pane to an account signed in on this PC only', ['Remote'], MAX_ID, 'wrong_machine', /runs on the SSH host build-box, where max@example.com is not signed in \(it is on: this PC\)/],
    ['an unknown pane', ['Nobody'], MAX_ID, 'unknown_pane', /No pane "Nobody"/],
    ['a shell', ['zsh'], MAX_ID, 'not_agent', /"zsh" is not an agent pane/],
    ['a chat', ['Chat'], MAX_ID, 'chat', /"Chat" is a chat pane/],
    ['a name two panes share', ['Claude Code'], OLD_ID, 'ambiguous_pane', /give one of their ids: p-dup1 \(One\), p-dup2 \(Two\)/],
    ['an account whose subscription was canceled', ['Fable'], 'old@example.com', 'inactive_account', /old@example.com has its subscription canceled on this PC/],
    ['an unknown account', ['Curie'], 'nobody@example.com', 'unknown_account', /No account "nobody@example.com"/],
    ['Codex on this PC (its account stays)', ['Codex'], 'dev@example.com', 'not_switchable', /Codex panes on this PC keep their account/]
  ]
  for (const [what, refs, account, code, message] of cases) {
    it(what, async () => {
      const { at, deps } = make()
      await expect(at.handle({ agent: 'p-lead', op: 'plan', panes: refs, account })).rejects.toMatchObject({ code, message: expect.stringMatching(message) })
      expect(deps.approve).not.toHaveBeenCalled()
      expect(deps.restart).not.toHaveBeenCalled()
      expect(at._plans.size).toBe(0)
    })
  }

  it('one bad pane among good ones: the whole request is refused, each problem said', async () => {
    const { at } = make()
    const err = await at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie', 'Codex', 'Nobody'], account: MAX_ID }).catch((e) => e)
    expect(err.code).toBe('unknown_pane')
    expect(err.message).toContain('Nothing was asked of the user')
    expect(err.message).toContain('"Codex" is a Codex pane')
    expect(err.message).toContain('No pane "Nobody"')
  })

  it('panes already on the account are left out; all of them: nothing to do', async () => {
    const { at } = make()
    const plan = await at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie', 'p-fable'], account: MAX_ID })
    expect(plan.panes.map((p) => p.id)).toEqual(['p-curie'])
    expect(plan.already.map((p) => p.id)).toEqual(['p-fable'])
    await expect(at.handle({ agent: 'p-lead', op: 'plan', panes: ['p-fable'], account: MAX_ID })).rejects.toMatchObject({ code: 'already' })
  })

  it('the account by its id, its email, or "system"', async () => {
    const { at } = make()
    for (const account of [MAX_ID, 'MAX@example.com']) {
      const plan = await at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie'], account })
      expect(plan.account).toMatchObject({ id: MAX_ID, email: 'max@example.com' })
    }
    // "system": the PC's own sign-in (here canceled: refused).
    await expect(at.handle({ agent: 'p-lead', op: 'plan', panes: ['Fable'], account: 'system' })).rejects.toMatchObject({ code: 'inactive_account' })
  })
})

describe('account_switch_panes: the card, then the restarts', () => {
  const FIVE = ['Curie', 'Lovelace', 'Noether', 'Kepler', 'Cavendish']

  it('Allow: one card naming each pane and the account; then Restart on <account> for each pane, in order', async () => {
    const { at, deps } = make()
    const plan = await at.handle({ agent: 'p-lead', op: 'plan', panes: FIVE, account: MAX_ID })
    const answer = await at.handle({ agent: 'p-lead', op: 'approve', token: plan.token, explanation: 'The old Max ended.', timeoutMs: APPROVAL_MS })
    expect(answer).toEqual({ allow: true, timedOut: false })
    expect(deps.approve).toHaveBeenCalledTimes(1)
    const [card, agentPane, opts] = deps.approve.mock.calls[0]
    expect(agentPane).toBe('p-lead')
    expect(opts).toEqual({ ms: APPROVAL_MS })
    expect(card).toMatchObject({ kind: 'accounts', agentLabel: 'Lead', explanation: 'The old Max ended.', timeoutMs: APPROVAL_MS })
    expect(card.account).toMatchObject({ agent: 'claude', agentName: 'Claude Code', email: 'max@example.com', sub: maxSub, where: [''] })
    expect(card.panes.map((p) => [p.name, p.project, p.from, p.state])).toEqual([
      ['Curie', 'BridgeClip', 'old@example.com', null],
      ['Lovelace', 'BridgeClip', 'old@example.com', null],
      ['Noether', 'BridgeClip', 'old@example.com', null],
      ['Kepler', 'Visual Code', 'old@example.com', 'working'],
      ['Cavendish', 'Afterlife', 'old@example.com', null]
    ])
    expect(deps.restart).not.toHaveBeenCalled()
    const done = await at.handle({ agent: 'p-lead', op: 'switch', token: plan.token })
    expect(deps.restart.mock.calls).toEqual(['p-curie', 'p-lovelace', 'p-noether', 'p-kepler', 'p-cavendish'].map((id) => [id, MAX_ID]))
    expect(done.results.map((r) => [r.name, r.status])).toEqual(FIVE.map((n) => [n, 'restarted']))
    expect(deps.switched).toHaveBeenCalledWith({ agentLabel: 'Lead', account: 'max@example.com', count: 5 })
    // A switch runs once.
    await expect(at.handle({ agent: 'p-lead', op: 'switch', token: plan.token })).rejects.toMatchObject({ code: 'not_allowed' })
    expect(deps.restart).toHaveBeenCalledTimes(5)
  })

  it('an SSH pane goes to its host\'s sign-in (null: the host\'s own)', async () => {
    const extra = [...panes(), pane('p-remote2', 'Remote 2', 'Server', { remoteHostId: 'box', hostAccount: 'zz99' })]
    const { at, deps } = make({ panes: extra })
    const plan = await at.handle({ agent: 'p-lead', op: 'plan', panes: ['Remote 2'], account: 'host@example.com' })
    expect(plan.panes[0]).toMatchObject({ id: 'p-remote2', host: 'build-box' })
    await at.handle({ agent: 'p-lead', op: 'approve', token: plan.token })
    await at.handle({ agent: 'p-lead', op: 'switch', token: plan.token })
    expect(deps.restart).toHaveBeenCalledWith('p-remote2', null)
  })

  it('Refuse, or no answer in time: nothing restarted', async () => {
    for (const reply of [{ allow: false }, { allow: false, timedOut: true }]) {
      const { at, deps } = make({ deps: { approve: vi.fn(async () => reply) } })
      const plan = await at.handle({ agent: 'p-lead', op: 'plan', panes: FIVE, account: MAX_ID })
      expect(await at.handle({ agent: 'p-lead', op: 'approve', token: plan.token })).toEqual({ allow: false, timedOut: !!reply.timedOut })
      await expect(at.handle({ agent: 'p-lead', op: 'switch', token: plan.token })).rejects.toMatchObject({ code: 'not_allowed' })
      expect(deps.restart).not.toHaveBeenCalled()
      expect(deps.switched).not.toHaveBeenCalled()
    }
  })

  it('the approval comes from the card only: not from the request, not from another agent', async () => {
    const { at, deps } = make({ deps: { approve: vi.fn(async () => ({ allow: false })) } })
    const plan = await at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie'], account: MAX_ID })
    // Straight to the switch: refused.
    await expect(at.handle({ agent: 'p-lead', op: 'switch', token: plan.token, allow: true })).rejects.toMatchObject({ code: 'not_allowed' })
    // Another agent cannot answer or run this one.
    await expect(at.handle({ agent: 'p-fable', op: 'approve', token: plan.token, allow: true })).rejects.toMatchObject({ code: 'no_switch' })
    await expect(at.handle({ agent: 'p-fable', op: 'switch', token: plan.token })).rejects.toMatchObject({ code: 'not_allowed' })
    // Whatever the request says, the card's answer decides.
    expect(await at.handle({ agent: 'p-lead', op: 'approve', token: plan.token, allow: true, answer: { allow: true } })).toEqual({ allow: false, timedOut: false })
    await expect(at.handle({ agent: 'p-lead', op: 'switch', token: plan.token })).rejects.toMatchObject({ code: 'not_allowed' })
    expect(deps.restart).not.toHaveBeenCalled()
  })

  it('the asking agent\'s own pane restarts last, after its answer', async () => {
    const { at, deps, timers } = make()
    const plan = await at.handle({ agent: 'p-curie', op: 'plan', panes: ['Curie', 'Kepler'], account: MAX_ID })
    expect(plan.panes.find((p) => p.id === 'p-curie').self).toBe(true)
    await at.handle({ agent: 'p-curie', op: 'approve', token: plan.token })
    const done = await at.handle({ agent: 'p-curie', op: 'switch', token: plan.token })
    expect(deps.restart.mock.calls).toEqual([['p-kepler', MAX_ID]])
    expect(done.results.map((r) => [r.id, r.status])).toEqual([
      ['p-kepler', 'restarted'],
      ['p-curie', 'later']
    ])
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(SELF_RESTART_MS)
    timers[0].fn()
    expect(deps.restart).toHaveBeenLastCalledWith('p-curie', MAX_ID)
  })

  it('checked again when it runs: a pane closed or moved meanwhile is left alone; a restart that fails says so', async () => {
    const { at, deps, setPanes } = make({ deps: { restart: vi.fn(async (id) => (id === 'p-lovelace' ? 'busy' : id === 'p-noether' ? 'failed' : 'ok')) } })
    const plan = await at.handle({ agent: 'p-lead', op: 'plan', panes: FIVE, account: MAX_ID })
    await at.handle({ agent: 'p-lead', op: 'approve', token: plan.token })
    setPanes(panes().filter((p) => p.id !== 'p-kepler').map((p) => (p.id === 'p-cavendish' ? { ...p, accountId: MAX_ID } : p)))
    const done = await at.handle({ agent: 'p-lead', op: 'switch', token: plan.token })
    expect(done.results.map((r) => [r.id, r.status])).toEqual([
      ['p-curie', 'restarted'],
      ['p-lovelace', 'busy'],
      ['p-noether', 'failed'],
      ['p-kepler', 'gone'],
      ['p-cavendish', 'already']
    ])
    expect(deps.restart.mock.calls.map((c) => c[0])).toEqual(['p-curie', 'p-lovelace', 'p-noether'])
  })

  it('its tool call going away: its card is answered no, its switch forgotten', async () => {
    const { at, deps } = make()
    const plan = await at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie'], account: MAX_ID })
    expect(await at.handle({ agent: 'p-lead', op: 'abort' })).toEqual({ ok: true })
    expect(deps.dismiss).toHaveBeenCalledWith('p-lead')
    await expect(at.handle({ agent: 'p-lead', op: 'approve', token: plan.token })).rejects.toMatchObject({ code: 'no_switch' })
  })
})
