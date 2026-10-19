// The agents' account tools, the window's side (agentAccounts.js): the
// sign-ins and the panes on each, a switch pinned to one sign-in and checked
// as Switch panes… checks it, one card, and the pane menu's Restart on
// <account> for each pane, only after the card's Allow. Main's side: main
// __tests__/agentAccounts.spec.js.
import { describe, it, expect, vi } from 'vitest'
import { createAgentAccountTargets, signInId, SELF_RESTART_MS, APPROVAL_MS, SHORT_APPROVAL_MS, COOLDOWN_MS } from '../agentAccounts'

const NOW = Date.UTC(2026, 9, 17, 12)
const MAX_ID = 'fd69dfdd-c291-490b-9ea1-4b77fdcb2526'
const WORK_ID = '11111111-1111-4111-8111-111111111111'
const U1 = '33333333-3333-4333-8333-333333333333'
const U2 = '44444444-4444-4444-8444-444444444444'
const FAKE_TOKEN = 'sk-ant-oat01-SECRETSECRETSECRET'
const sub = (type, status = 'active') => ({ organization_type: type, subscription_status: status, has_claude_max: type === 'claude_max', checkedAt: NOW - 60000 })
const maxSub = { ...sub('claude_max'), rate_limit_tier: 'default_claude_max_20x' }
const canceledSub = sub('claude_max', 'canceled')

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
        { agent: 'claude', scope: 'tessel', id: MAX_ID, email: 'max@example.com', org: 'Max Org', plan: 'max', state: 'signed-in', sub: maxSub },
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
        { agent: 'claude', scope: 'tessel', id: 'f1', email: 'max@example.com', state: 'signed-in', sub: maxSub },
        { agent: 'codex', scope: 'tessel', id: 'ab12cd', email: 'dev@example.com', state: 'signed-in' }
      ]
    },
    { id: 'wsl:Ubuntu', kind: 'wsl', distro: 'Ubuntu', label: 'Ubuntu', state: 'unknown', entries: [] }
  ]
}

const pane = (id, name, project, extra = {}) => ({ id, kind: 'agent', name, agentId: 'claude', remoteHostId: null, hostAccount: undefined, accountId: null, detected: false, project, wsId: `ws-${project}`, ...extra })
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
    pane('p-remote', 'Remote', 'Server', { remoteHostId: 'box' }),
    pane('p-remote2', 'Remote 2', 'Server', { remoteHostId: 'box', hostAccount: 'zz99' }),
    pane('p-other-host', 'Elsewhere', 'Other', { remoteHostId: 'box' })
  ]
}
const REQUESTERS = {
  'p-lead': { label: 'Lead', project: 'Tessel', wsId: 'ws-Tessel', hostId: null, agentId: 'claude' },
  'p-curie': { label: 'Curie', project: 'BridgeClip', wsId: 'ws-BridgeClip', hostId: null, agentId: 'claude' },
  'p-fable': { label: 'Fable', project: 'Tessel', wsId: 'ws-Tessel', hostId: null, agentId: 'claude' },
  'p-remote': { label: 'Remote', project: 'Server', wsId: 'ws-Server', hostId: 'box', agentId: 'claude' },
  'p-rcodex': { label: 'Box Codex', project: 'Server', wsId: 'ws-Server', hostId: 'box', agentId: 'codex' }
}

function make(extra = {}) {
  const timers = []
  let list = extra.panes || panes()
  let placeList = extra.places || places()
  let on = true
  const deps = {
    enabled: () => on,
    places: vi.fn(async () => placeList),
    panes: () => list,
    findPane: (ref) => (ref === 'zsh' ? { name: 'zsh', kind: 'shell' } : ref === 'Chat' ? { name: 'Chat', kind: 'chat' } : null),
    requester: (id) => REQUESTERS[id] || null,
    agentName: (id) => ({ claude: 'Claude Code', codex: 'Codex' })[id] || id,
    hostLabel: (id) => (id === 'box' ? 'build-box' : id),
    paneState: (id) => (id === 'p-kepler' ? 'working' : null),
    approve: vi.fn(async () => ({ allow: true })),
    dismiss: vi.fn(),
    expire: vi.fn(),
    restart: vi.fn(async () => 'ok'),
    switched: vi.fn(),
    later: (fn, ms) => timers.push({ fn, ms }),
    now: () => clock.now,
    newToken: (() => {
      let n = 0
      return () => `tok-${++n}`
    })(),
    ...extra.deps
  }
  const clock = { now: NOW }
  const at = createAgentAccountTargets(deps)
  return { at, deps, timers, clock, setPanes: (p) => (list = p), setPlaces: (p) => (placeList = p), setEnabled: (v) => (on = v) }
}
// A full switch: plan, the card's answer, the run.
async function flow(env, agent, panesRef, account, explanation) {
  const plan = await env.at.handle({ agent, op: 'plan', panes: panesRef, account })
  const answer = await env.at.handle({ agent, op: 'approve', token: plan.token, explanation, timeoutMs: APPROVAL_MS })
  const done = answer.allow ? await env.at.handle({ agent, op: 'switch', token: plan.token }) : null
  return { plan, answer, done }
}

describe('sign-in ids', () => {
  it('where it is and which one, never made from the email', () => {
    const pc = { kind: 'pc' }
    expect(signInId(pc, { agent: 'claude', scope: 'tessel', id: MAX_ID, email: 'max@example.com' })).toBe(MAX_ID)
    expect(signInId(pc, { agent: 'claude', scope: 'system', email: 'old@example.com' })).toBe('claude:system')
    expect(signInId(pc, { agent: 'gemini', scope: 'default' })).toBe('gemini:pc')
    const box = { kind: 'ssh', hostId: 'box' }
    expect(signInId(box, { agent: 'claude', scope: 'default', email: 'a@b.c' })).toBe('ssh:box:claude:own')
    expect(signInId(box, { agent: 'codex', scope: 'tessel', id: 'ab12cd' })).toBe('ssh:box:codex:ab12cd')
    expect(signInId(box, { agent: 'claude', scope: 'env' })).toBe('ssh:box:claude:env')
  })
})

describe('account_list', () => {
  it('each account and its sign-ins (id, place, kind, organization, plan), the panes on each; never a token or a path', async () => {
    const { at } = make()
    const r = await at.handle({ agent: 'p-lead', op: 'list' })
    const max = r.accounts.find((a) => a.email === 'max@example.com')
    expect(max.signIns.map((s) => [s.id, s.kind, s.place, s.scope, s.org])).toEqual([
      [MAX_ID, 'pc', 'this PC', 'tessel', 'Max Org'],
      ['ssh:box:claude:f1', 'ssh', 'build-box', 'tessel', null]
    ])
    expect(max.signIns[0].panes.map((p) => p.name)).toEqual(['Fable', 'Claude Code', 'Claude Code'])
    const old = r.accounts.find((a) => a.email === 'old@example.com')
    expect(old.signIns).toHaveLength(1)
    expect(old.signIns[0]).toMatchObject({ id: 'claude:system', scope: 'system', signedIn: true, switchable: true, sub: canceledSub })
    expect(old.signIns[0].panes.map((p) => [p.name, p.project, p.agent, p.host])).toEqual([
      ['Curie', 'BridgeClip', 'Claude Code', null],
      ['Lovelace', 'BridgeClip', 'Claude Code', null],
      ['Noether', 'BridgeClip', 'Claude Code', null],
      ['Kepler', 'Visual Code', 'Claude Code', null],
      ['Cavendish', 'Afterlife', 'Claude Code', null]
    ])
    const host = r.accounts.find((a) => a.email === 'host@example.com')
    expect(host.signIns[0]).toMatchObject({ id: 'ssh:box:claude:own', switchable: true })
    expect(host.signIns[0].panes.map((p) => p.id)).toEqual(['p-remote', 'p-other-host'])
    // Codex on this PC keeps its account (Switch panes never offers it); on the host it can.
    const codex = r.accounts.find((a) => a.agent === 'codex')
    expect(codex.signIns.map((s) => [s.id, s.switchable])).toEqual([['codex:system', false], ['ssh:box:codex:ab12cd', true]])
    expect(r.waiting).toEqual([{ name: 'Ubuntu', kind: 'wsl', state: 'not checked yet' }])
    expect(r.scope).toBeNull()
    const json = JSON.stringify(r)
    expect(json).not.toContain('/home/u/.claude')
    expect(json).not.toContain('sk-ant')
  })

  it('an agent on an SSH host sees only its host\'s sign-ins and its own project\'s panes there', async () => {
    const { at } = make()
    const r = await at.handle({ agent: 'p-remote', op: 'list' })
    const ids = r.accounts.flatMap((a) => a.signIns.map((s) => s.id))
    expect(ids).toEqual(['ssh:box:claude:own', 'ssh:box:claude:f1', 'ssh:box:codex:ab12cd'])
    const shownPanes = r.accounts.flatMap((a) => a.signIns.flatMap((s) => s.panes.map((p) => p.id)))
    expect(shownPanes).toEqual(['p-remote'])
    expect(r.waiting).toEqual([])
    expect(r.scope).toEqual({ host: 'build-box', project: 'Server' })
  })

  it('only an agent pane may ask; the setting off: nothing', async () => {
    const env = make()
    await expect(env.at.handle({ agent: 'p-shell', op: 'list' })).rejects.toMatchObject({ code: 'not_agent' })
    env.setEnabled(false)
    for (const op of ['list', 'plan', 'approve', 'switch']) await expect(env.at.handle({ agent: 'p-lead', op, panes: ['Curie'], account: MAX_ID })).rejects.toMatchObject({ code: 'disabled' })
    expect(env.deps.places).not.toHaveBeenCalled()
  })
})

describe('account_switch_panes: the named sign-in is the one used', () => {
  // The same email in two organizations on this PC: the system's sign-in
  // (personal Max) and one added in Tessel (a work Team).
  const twoOrgs = () => [
    {
      id: 'pc',
      kind: 'pc',
      state: 'ready',
      entries: [
        { agent: 'claude', scope: 'system', id: null, email: 'alice@example.com', org: "alice@example.com's Organization", plan: 'max', state: 'signed-in', sub: sub('claude_max') },
        { agent: 'claude', scope: 'tessel', id: WORK_ID, email: 'alice@example.com', org: 'Work Corp', plan: 'team', state: 'signed-in', sub: sub('claude_team') },
        { agent: 'claude', scope: 'tessel', id: MAX_ID, email: 'bob@example.com', org: 'Bob Org', plan: 'pro', state: 'signed-in', sub: sub('claude_pro') }
      ]
    }
  ]
  const onBob = () => [pane('p-a', 'A', 'P', { accountId: MAX_ID }), pane('p-b', 'B', 'P', { accountId: MAX_ID })]

  it('by its id: that sign-in, and the card says which (added in Tessel, its organization)', async () => {
    const env = make({ places: twoOrgs(), panes: onBob() })
    const { plan } = await flow(env, 'p-lead', ['A'], WORK_ID)
    expect(plan.signIns).toEqual([WORK_ID])
    expect(env.deps.restart).toHaveBeenCalledWith('p-a', WORK_ID)
    const card = env.deps.approve.mock.calls[0][0]
    expect(card.signIns).toEqual([expect.objectContaining({ id: WORK_ID, kind: 'pc', scope: 'tessel', org: 'Work Corp' })])
    // The personal one by its own id; its organization ("<email>'s Organization") is not shown.
    const env2 = make({ places: twoOrgs(), panes: onBob() })
    await flow(env2, 'p-lead', ['A'], 'claude:system')
    expect(env2.deps.restart).toHaveBeenCalledWith('p-a', null)
    expect(env2.deps.approve.mock.calls[0][0].signIns[0]).toMatchObject({ id: 'claude:system', scope: 'system', org: null })
  })

  it('by an email with two usable sign-ins on that machine: refused, the agent is told the ids', async () => {
    const { at, deps } = make({ places: twoOrgs(), panes: onBob() })
    const err = await at.handle({ agent: 'p-lead', op: 'plan', panes: ['A'], account: 'alice@example.com' }).catch((e) => e)
    expect(err.code).toBe('ambiguous_account')
    expect(err.message).toContain(`${WORK_ID} (this PC, added in Tessel, organization Work Corp)`)
    expect(err.message).toContain('claude:system (this PC, its own sign-in)')
    expect(deps.approve).not.toHaveBeenCalled()
  })

  it('sign-ins with no email: by their own id only, each its own', async () => {
    const unnamed = [
      {
        id: 'pc',
        kind: 'pc',
        state: 'ready',
        entries: [
          { agent: 'claude', scope: 'tessel', id: U1, email: null, state: 'signed-in' },
          { agent: 'claude', scope: 'tessel', id: U2, email: null, state: 'signed-in' },
          { agent: 'claude', scope: 'system', id: null, email: 'carol@example.com', plan: 'max', state: 'signed-in', sub: sub('claude_max') }
        ]
      }
    ]
    const env = make({ places: unnamed, panes: [pane('p-a', 'A', 'P')] })
    await flow(env, 'p-lead', ['A'], U2)
    expect(env.deps.restart).toHaveBeenCalledWith('p-a', U2)
    expect(env.deps.approve.mock.calls[0][0].account).toMatchObject({ email: null, unknown: true })
    // "unknown" or an empty name never picks one of them.
    const env2 = make({ places: unnamed, panes: [pane('p-a', 'A', 'P')] })
    await expect(env2.at.handle({ agent: 'p-lead', op: 'plan', panes: ['A'], account: 'claude-unknown' })).rejects.toMatchObject({ code: 'unknown_account' })
  })

  it('by an email with one sign-in a pane can use there: that one (each machine its own)', async () => {
    const env = make()
    await flow(env, 'p-lead', ['Curie', 'Remote 2'], 'max@example.com')
    expect(env.deps.restart.mock.calls).toEqual([
      ['p-curie', MAX_ID],
      ['p-remote2', 'f1']
    ])
  })
})

describe('account_switch_panes: the checks (nothing asked when one fails)', () => {
  const cases = [
    ['a Codex pane to a Claude sign-in', ['Codex'], MAX_ID, 'wrong_agent', /"Codex" is a Codex pane and max@example.com is a Claude Code account/],
    ['an SSH pane to a sign-in on this PC', ['Remote'], MAX_ID, 'wrong_machine', /runs on the SSH host build-box, and the sign-in fd69dfdd-c291-490b-9ea1-4b77fdcb2526 is on this PC/],
    ['an SSH pane to an email signed in on this PC only', ['Remote'], 'old@example.com', 'wrong_machine', /where old@example.com is not signed in \(it is on: this PC\)/],
    ['an unknown pane', ['Nobody'], MAX_ID, 'unknown_pane', /No pane "Nobody"/],
    ['a shell', ['zsh'], MAX_ID, 'not_agent', /"zsh" is not an agent pane/],
    ['a chat', ['Chat'], MAX_ID, 'chat', /"Chat" is a chat pane/],
    ['a name two panes share', ['Claude Code'], 'claude:system', 'ambiguous_pane', /give one of their ids: p-dup1 \(One\), p-dup2 \(Two\)/],
    ['a sign-in whose subscription was canceled', ['Fable'], 'old@example.com', 'inactive_account', /old@example.com has its subscription canceled on this PC/],
    ['an unknown account', ['Curie'], 'nobody@example.com', 'unknown_account', /No sign-in "nobody@example.com"/],
    ['a path for an account', ['Curie'], 'C:\\evil\\.claude', 'unknown_account', /No sign-in/],
    ['Codex on this PC (its account stays)', ['Codex'], 'codex:system', 'not_switchable', /Codex panes on this PC keep their account/]
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

  it('an agent on an SSH host: only its own project\'s panes there, only to a sign-in there', async () => {
    const { at, deps } = make()
    await expect(at.handle({ agent: 'p-remote', op: 'plan', panes: ['Elsewhere'], account: 'ssh:box:claude:f1' })).rejects.toMatchObject({ code: 'not_your_project' })
    await expect(at.handle({ agent: 'p-remote', op: 'plan', panes: ['Curie'], account: 'ssh:box:claude:f1' })).rejects.toMatchObject({ code: 'not_your_project' })
    await expect(at.handle({ agent: 'p-remote', op: 'plan', panes: ['Remote 2'], account: MAX_ID })).rejects.toMatchObject({ code: 'unknown_account' })
    expect(deps.approve).not.toHaveBeenCalled()
    const ok = await at.handle({ agent: 'p-remote', op: 'plan', panes: ['Remote 2'], account: 'ssh:box:claude:f1' })
    expect(ok.signIns).toEqual(['ssh:box:claude:f1'])
  })

  it('panes already on the sign-in are left out; all of them: nothing to do', async () => {
    const { at } = make()
    const plan = await at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie', 'p-fable'], account: MAX_ID })
    expect(plan.panes.map((p) => p.id)).toEqual(['p-curie'])
    expect(plan.already.map((p) => p.id)).toEqual(['p-fable'])
    const env = make()
    await expect(env.at.handle({ agent: 'p-lead', op: 'plan', panes: ['p-fable'], account: MAX_ID })).rejects.toMatchObject({ code: 'already' })
  })
})

describe('account_switch_panes: the card, then the restarts', () => {
  const FIVE = ['Curie', 'Lovelace', 'Noether', 'Kepler', 'Cavendish']

  it('Allow: one card naming who asks, each pane, the sign-in; then Restart on <account> for each pane, in order', async () => {
    const env = make()
    const { answer, done } = await flow(env, 'p-lead', FIVE, MAX_ID, 'The old Max ended.')
    expect(answer).toMatchObject({ allow: true, timedOut: false })
    const [card, agentPane, opts] = env.deps.approve.mock.calls[0]
    expect(agentPane).toBe('p-lead')
    expect(opts).toEqual({ ms: APPROVAL_MS })
    expect(card).toMatchObject({ kind: 'accounts', agentLabel: 'Lead', explanation: 'The old Max ended.', timeoutMs: APPROVAL_MS, requester: { label: 'Lead', project: 'Tessel', host: null } })
    expect(card.account).toMatchObject({ agent: 'claude', agentName: 'Claude Code', email: 'max@example.com' })
    expect(card.signIns).toEqual([{ id: MAX_ID, kind: 'pc', place: 'this PC', where: '', scope: 'tessel', org: 'Max Org', plan: 'max', sub: maxSub }])
    expect(card.projects).toEqual([
      { name: 'BridgeClip', count: 3 },
      { name: 'Visual Code', count: 1 },
      { name: 'Afterlife', count: 1 }
    ])
    expect(card.panes.map((p) => [p.name, p.project, p.from, p.state])).toEqual([
      ['Curie', 'BridgeClip', 'old@example.com', null],
      ['Lovelace', 'BridgeClip', 'old@example.com', null],
      ['Noether', 'BridgeClip', 'old@example.com', null],
      ['Kepler', 'Visual Code', 'old@example.com', 'working'],
      ['Cavendish', 'Afterlife', 'old@example.com', null]
    ])
    expect(env.deps.restart.mock.calls).toEqual(['p-curie', 'p-lovelace', 'p-noether', 'p-kepler', 'p-cavendish'].map((id) => [id, MAX_ID]))
    expect(done.results.map((r) => [r.name, r.status])).toEqual(FIVE.map((n) => [n, 'restarted']))
    expect(env.deps.switched).toHaveBeenCalledWith({ agentLabel: 'Lead', account: 'max@example.com', count: 5 })
  })

  it('what the agent says loses its invisible characters', async () => {
    const env = make()
    await flow(env, 'p-lead', ['Curie'], MAX_ID, 'Tessel\u202e lla wollA \u202c\u200b\u2066Verified\u2069\ufeff\nnext\u0007')
    expect(env.deps.approve.mock.calls[0][0].explanation).toBe('Tessel lla wollA Verified next')
  })

  it('Codex on an SSH host gives up after 60 s: its card ends before', async () => {
    const env = make()
    const plan = await env.at.handle({ agent: 'p-rcodex', op: 'plan', panes: ['Remote 2'], account: 'ssh:box:claude:f1' }).catch((e) => e)
    // (a Claude pane: the Codex agent may still ask for it, in its own project)
    expect(plan.token).toBeTruthy()
    const answer = await env.at.handle({ agent: 'p-rcodex', op: 'approve', token: plan.token, timeoutMs: APPROVAL_MS })
    expect(env.deps.approve.mock.calls[0][2]).toEqual({ ms: SHORT_APPROVAL_MS })
    expect(answer.ms).toBe(SHORT_APPROVAL_MS)
  })

  it('Refuse, or no answer in time: nothing restarted, and the agent waits before asking again', async () => {
    for (const reply of [{ allow: false }, { allow: false, timedOut: true }]) {
      const env = make({ deps: { approve: vi.fn(async () => reply) } })
      const { plan, answer } = await flow(env, 'p-lead', FIVE, MAX_ID)
      expect(answer).toMatchObject({ allow: false, timedOut: !!reply.timedOut })
      await expect(env.at.handle({ agent: 'p-lead', op: 'switch', token: plan.token })).rejects.toMatchObject({ code: 'not_allowed' })
      expect(env.deps.restart).not.toHaveBeenCalled()
      await expect(env.at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie'], account: MAX_ID })).rejects.toMatchObject({ code: 'cooldown' })
      env.clock.now += COOLDOWN_MS + 1000
      expect((await env.at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie'], account: MAX_ID })).token).toBeTruthy()
    }
  })

  it('"Don\'t ask again from this agent": its next requests are refused', async () => {
    const env = make({ deps: { approve: vi.fn(async () => ({ allow: false, block: true })) } })
    const { answer } = await flow(env, 'p-lead', ['Curie'], MAX_ID)
    expect(answer).toMatchObject({ allow: false, blocked: true })
    env.clock.now += COOLDOWN_MS * 10
    await expect(env.at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie'], account: MAX_ID })).rejects.toMatchObject({ code: 'blocked' })
    // Another agent still may.
    expect((await env.at.handle({ agent: 'p-fable', op: 'plan', panes: ['Curie'], account: MAX_ID })).token).toBeTruthy()
  })

  it('one request at a time per agent', async () => {
    const { at } = make()
    await at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie'], account: MAX_ID })
    await expect(at.handle({ agent: 'p-lead', op: 'plan', panes: ['Kepler'], account: MAX_ID })).rejects.toMatchObject({ code: 'pending' })
  })

  it('the approval comes from the card only: not from the request, not from another agent', async () => {
    const { at, deps } = make({ deps: { approve: vi.fn(async () => ({ allow: 'true' })) } })
    const plan = await at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie'], account: MAX_ID })
    await expect(at.handle({ agent: 'p-lead', op: 'switch', token: plan.token, allow: true })).rejects.toMatchObject({ code: 'not_allowed' })
    await expect(at.handle({ agent: 'p-fable', op: 'approve', token: plan.token, allow: true })).rejects.toMatchObject({ code: 'no_switch' })
    await expect(at.handle({ agent: 'p-fable', op: 'switch', token: plan.token })).rejects.toMatchObject({ code: 'not_allowed' })
    // Anything but allow === true from the card is a no.
    expect(await at.handle({ agent: 'p-lead', op: 'approve', token: plan.token, allow: true })).toMatchObject({ allow: false })
    await expect(at.handle({ agent: 'p-lead', op: 'switch', token: plan.token })).rejects.toMatchObject({ code: 'not_allowed' })
    expect(deps.restart).not.toHaveBeenCalled()
  })

  it('the asking agent\'s own pane restarts last, after its answer', async () => {
    const env = make()
    const { plan, done } = await flow(env, 'p-curie', ['Curie', 'Kepler'], MAX_ID)
    expect(plan.panes.find((p) => p.id === 'p-curie').self).toBe(true)
    expect(env.deps.restart.mock.calls).toEqual([['p-kepler', MAX_ID]])
    expect(done.results.map((r) => [r.id, r.status])).toEqual([
      ['p-kepler', 'restarted'],
      ['p-curie', 'later']
    ])
    expect(env.timers).toHaveLength(1)
    expect(env.timers[0].ms).toBe(SELF_RESTART_MS)
    env.timers[0].fn()
    expect(env.deps.restart).toHaveBeenLastCalledWith('p-curie', MAX_ID)
  })

  it('checked again when it runs: a pane closed, swapped or moved meanwhile, or the sign-in gone, is left alone', async () => {
    const env = make({ deps: { restart: vi.fn(async (id) => (id === 'p-lovelace' ? 'busy' : id === 'p-noether' ? 'failed' : 'ok')) } })
    const plan = await env.at.handle({ agent: 'p-lead', op: 'plan', panes: FIVE, account: MAX_ID })
    await env.at.handle({ agent: 'p-lead', op: 'approve', token: plan.token })
    // Kepler closed and a new pane took its name; Cavendish moved to the account meanwhile.
    env.setPanes([...panes().filter((p) => p.id !== 'p-kepler').map((p) => (p.id === 'p-cavendish' ? { ...p, accountId: MAX_ID } : p)), pane('p-new', 'Kepler', 'Visual Code')])
    const done = await env.at.handle({ agent: 'p-lead', op: 'switch', token: plan.token })
    expect(done.results.map((r) => [r.id, r.status])).toEqual([
      ['p-curie', 'restarted'],
      ['p-lovelace', 'busy'],
      ['p-noether', 'failed'],
      ['p-kepler', 'gone'],
      ['p-cavendish', 'already']
    ])
    expect(env.deps.restart.mock.calls.map((c) => c[0])).toEqual(['p-curie', 'p-lovelace', 'p-noether'])
    // The sign-in signed out meanwhile: nothing restarts.
    const env2 = make()
    const p2 = await env2.at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie'], account: MAX_ID })
    await env2.at.handle({ agent: 'p-lead', op: 'approve', token: p2.token })
    env2.setPlaces(places().map((pl) => (pl.id === 'pc' ? { ...pl, entries: pl.entries.filter((e) => e.id !== MAX_ID) } : pl)))
    const done2 = await env2.at.handle({ agent: 'p-lead', op: 'switch', token: p2.token })
    expect(done2.results.map((r) => r.status)).toEqual(['changed'])
    expect(env2.deps.restart).not.toHaveBeenCalled()
  })

  it('its tool call going away: its card is answered no (not a refusal: no wait), its switch forgotten; a plan being made is dropped', async () => {
    const env = make()
    const plan = await env.at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie'], account: MAX_ID })
    expect(await env.at.handle({ agent: 'p-lead', op: 'abort' })).toEqual({ ok: true })
    expect(env.deps.dismiss).toHaveBeenCalledWith('p-lead')
    await expect(env.at.handle({ agent: 'p-lead', op: 'approve', token: plan.token })).rejects.toMatchObject({ code: 'no_switch' })
    // While the places are read: the plan is not kept.
    let release
    env.deps.places.mockImplementationOnce(() => new Promise((r) => (release = () => r(places()))))
    const making = env.at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie'], account: MAX_ID })
    await env.at.handle({ agent: 'p-lead', op: 'abort' })
    release()
    await expect(making).rejects.toMatchObject({ code: 'cancelled' })
    expect(env.at._plans.size).toBe(0)
    // While the card is up: a cancel, not the user's no.
    let answerCard
    env.deps.approve.mockImplementationOnce(() => new Promise((r) => (answerCard = r)))
    const p3 = await env.at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie'], account: MAX_ID })
    const asking = env.at.handle({ agent: 'p-lead', op: 'approve', token: p3.token })
    await vi.waitFor(() => expect(answerCard).toBeTypeOf('function'))
    await env.at.handle({ agent: 'p-lead', op: 'abort' })
    answerCard({ allow: false })
    expect(await asking).toMatchObject({ allow: false, cancelled: true })
    expect(env.at._cooldown.has('p-lead')).toBe(false)
  })

  it('the main process stopped waiting for its card: the card ends, and an Allow there afterwards switches nothing', async () => {
    const env = make()
    let answerCard
    env.deps.approve.mockImplementationOnce(() => new Promise((r) => (answerCard = r)))
    const plan = await env.at.handle({ agent: 'p-lead', op: 'plan', panes: ['Curie'], account: MAX_ID })
    const asking = env.at.handle({ agent: 'p-lead', op: 'approve', token: plan.token })
    await vi.waitFor(() => expect(answerCard).toBeTypeOf('function'))
    expect(await env.at.handle({ agent: 'p-lead', op: 'expire', token: plan.token })).toEqual({ ok: true })
    expect(env.deps.expire).toHaveBeenCalledWith(plan.token)
    answerCard({ allow: true })
    expect(await asking).toMatchObject({ allow: true })
    // The plan is gone: nothing runs, and the agent waits before asking again.
    await expect(env.at.handle({ agent: 'p-lead', op: 'switch', token: plan.token })).rejects.toMatchObject({ code: 'not_allowed' })
    expect(env.deps.restart).not.toHaveBeenCalled()
    expect(env.at._cooldown.has('p-lead')).toBe(true)
  })
})
