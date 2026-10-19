// Live Share: "Agents guests may use", enforced on the host
// (liveShare/shareHost.js). A guest can't open an agent or a model its rule
// leaves out (it is told why), can't type in a pane running one (watching
// stays), can't switch an agent to a model left out with /model, and its
// "open" menu lists only what it may use. The share's setting counts for
// whoever has no rule of its own; agents the host installs later follow
// "Allow agents I add later". Real WebSockets on 127.0.0.1.
import { describe, it, expect, afterEach } from 'vitest'
import { createShareHost } from '../liveShare/shareHost'
import { createShareGuest } from '../liveShare/shareGuest'
import { newSecret, newSigningKey } from '../liveShare/shareCrypto'
import { NO_RIGHTS, withAgents } from '../../shared/liveShareRights'
import { setAgentAllowed, setAgentModels, setAgentLater } from '../../shared/liveShareAgents'

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out')
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const ALL = { ...NO_RIGHTS, type: true, open: true, close: true }
const HOST_IDS = ['claude', 'codex']
const pane = (id) => ({ id, title: id, kind: 'shell', cols: 80, rows: 24 })
const layoutOf = (name, ids) => ({ project: name, tree: { type: 'split', dir: 'row', sizes: ids.map(() => 100 / ids.length), children: ids.map((id) => ({ type: 'leaf', id, view: 'terminal', title: id, kind: 'shell' })) }, activeId: ids[0], maximizedId: null })

// The host's Tessel: one project with a shell (s1), a Claude pane (c1) and a
// Codex pane (x1); its agents and the share's agents setting can change.
function fakeTessel() {
  const t = {
    writes: [],
    opened: [],
    asked: [],
    agents: [
      { id: 'claude', name: 'Claude Code', models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
      { id: 'codex', name: 'Codex' }
    ],
    shareRule: null,
    panes: { s1: { agent: null, models: [] }, c1: { agent: 'claude', models: ['sonnet'] }, x1: { agent: 'codex', models: [] } },
    breaches: [],
    callbacks: {
      projects: () => [{ id: 'ws-a', layout: layoutOf('A', ['s1', 'c1', 'x1']), panes: ['s1', 'c1', 'x1'].map(pane) }],
      snapshot: async (id) => ({ data: `screen of ${id}`, cols: 80, rows: 24 }),
      write: (id, data) => t.writes.push([id, data]),
      openPane: (spec, guest) => t.opened.push([guest.name, spec]),
      askOpen: (spec, guest) => t.asked.push([guest.name, spec]),
      closePane: () => {},
      agents: () => t.agents,
      agentDefault: () => t.shareRule,
      paneAgent: (id) => t.panes[id] || null,
      onRuleBreach: (b) => t.breaches.push(b),
      askApproval: async () => true
    }
  }
  return t
}

function recorder() {
  const r = { states: [], projects: null, rights: [], notices: [], agents: [], screens: {} }
  r.callbacks = {
    onState: (s) => r.states.push(s),
    onProjects: (projects) => (r.projects = projects),
    onSnapshot: (id, data) => (r.screens[id] = data),
    onData: () => {},
    onRights: (rights) => r.rights.push(rights),
    onNotice: (code, about) => r.notices.push({ code, ...about }),
    onAgents: (list) => r.agents.push(list),
    onHostKey: () => {},
    onClosed: () => {}
  }
  return r
}

describe('Live Share: agents guests may use (host enforcement)', () => {
  let host
  afterEach(() => host?.stop())

  async function share(t) {
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Ada', callbacks: t.callbacks })
    const port = await host.start()
    return { secret, port }
  }
  async function joined({ port, secret }, name, back = null) {
    const r = recorder()
    r.key = back ? back.key : newSigningKey()
    r.client = createShareGuest({ url: `ws://127.0.0.1:${port}/`, secret, name, signingKey: r.key, ...(back ? { back: true, hostKey: back.hostKey } : {}), callbacks: { ...r.callbacks, onHostKey: (k) => (r.hostKey = k) } })
    r.client.connect()
    await until(() => r.states.includes('joined') && r.projects)
    return r
  }
  const guestOf = (name) => host.guests().find((g) => g.name === name)
  async function grant(r, name, rights) {
    const n = r.rights.length
    expect(host.setGrant(guestOf(name).id, { rights })).toBe(true)
    await until(() => r.rights.length > n)
  }

  it('lets everything through when no rule is set (the default)', async () => {
    const t = fakeTessel()
    const alex = await joined(await share(t), 'Alex')
    await grant(alex, 'Alex', ALL)
    expect(alex.rights.at(-1).agents).toBeUndefined()
    expect(alex.agents.at(-1).map((a) => a.id)).toEqual(['claude', 'codex'])
    expect(alex.agents.at(-1)[0].models).toBeUndefined()
    alex.client.open({ kind: 'agent', agent: 'claude', project: 'ws-a' })
    alex.client.write('c1', 'hi\r')
    await until(() => t.opened.length === 1 && t.writes.length === 1)
    expect(t.opened[0][1]).toEqual({ kind: 'agent', agent: 'claude', project: 'ws-a' })
  })

  it('refuses to open an agent the rule leaves out, with a notice naming it, and never asks the host', async () => {
    const t = fakeTessel()
    const alex = await joined(await share(t), 'Alex')
    await grant(alex, 'Alex', withAgents(ALL, setAgentAllowed(null, 'claude', false, HOST_IDS)))
    // The guest's menu: Codex only.
    await until(() => alex.agents.at(-1) && alex.agents.at(-1).length === 1)
    expect(alex.agents.at(-1).map((a) => a.id)).toEqual(['codex'])
    alex.client.open({ kind: 'agent', agent: 'claude', project: 'ws-a' })
    await until(() => alex.notices.length)
    expect(alex.notices[0]).toMatchObject({ code: 'agent-denied', agent: 'Claude Code' })
    alex.client.open({ kind: 'agent', agent: 'codex', project: 'ws-a' })
    await until(() => t.opened.length === 1)
    expect(t.opened.map(([, s]) => s.agent)).toEqual(['codex'])
    // Without the right to open: refused before the host is asked.
    await grant(alex, 'Alex', withAgents({ ...ALL, open: false }, setAgentAllowed(null, 'claude', false, HOST_IDS)))
    alex.client.open({ kind: 'agent', agent: 'claude', project: 'ws-a' })
    await until(() => alex.notices.length === 2)
    expect(t.asked).toEqual([])
  })

  it('refuses a model left out, and sends the models allowed with an open', async () => {
    const t = fakeTessel()
    const alex = await joined(await share(t), 'Alex')
    await grant(alex, 'Alex', withAgents(ALL, setAgentModels(null, 'claude', ['sonnet'], HOST_IDS)))
    await until(() => alex.agents.at(-1) && alex.agents.at(-1)[0].models)
    expect(alex.agents.at(-1)[0].models).toEqual([{ id: 'sonnet', label: 'Sonnet' }])
    alex.client.open({ kind: 'agent', agent: 'claude', project: 'ws-a', model: 'opus' })
    await until(() => alex.notices.length)
    expect(alex.notices[0]).toMatchObject({ code: 'model-denied', agent: 'Claude Code', model: 'opus' })
    alex.client.open({ kind: 'agent', agent: 'claude', project: 'ws-a', model: 'sonnet' })
    alex.client.open({ kind: 'agent', agent: 'claude', project: 'ws-a' })
    await until(() => t.opened.length === 2)
    expect(t.opened[0][1]).toEqual({ kind: 'agent', agent: 'claude', project: 'ws-a', model: 'sonnet', models: ['sonnet'] })
    expect(t.opened[1][1]).toEqual({ kind: 'agent', agent: 'claude', project: 'ws-a', models: ['sonnet'] })
  })

  it('refuses typing in a pane running a refused agent or model (the shell and other agents still take it), said once in a while', async () => {
    const t = fakeTessel()
    const alex = await joined(await share(t), 'Alex')
    await grant(alex, 'Alex', withAgents(ALL, setAgentAllowed(null, 'claude', false, HOST_IDS)))
    await until(() => alex.screens.c1)
    alex.client.write('c1', 'rm -rf /\r')
    alex.client.write('c1', 'again')
    alex.client.write('s1', 'ls\r')
    alex.client.write('x1', 'hello')
    await until(() => t.writes.length === 2)
    await wait(40)
    expect(t.writes).toEqual([
      ['s1', 'ls\r'],
      ['x1', 'hello']
    ])
    expect(alex.notices.filter((n) => n.code === 'type-denied')).toHaveLength(1)
    expect(alex.notices[0]).toMatchObject({ code: 'type-denied', agent: 'Claude Code' })
    // Claude allowed again but only Opus: its pane runs Sonnet, so no typing.
    await grant(alex, 'Alex', withAgents(ALL, setAgentModels(null, 'claude', ['opus'], HOST_IDS)))
    alex.client.write('c1', 'x')
    await until(() => alex.notices.some((n) => n.code === 'model-denied'))
    expect(t.writes).toHaveLength(2)
  })

  it('refuses a /model switch to a model left out, typed key by key or pasted', async () => {
    const t = fakeTessel()
    const alex = await joined(await share(t), 'Alex')
    await grant(alex, 'Alex', withAgents(ALL, setAgentModels(null, 'claude', ['sonnet'], HOST_IDS)))
    await until(() => alex.screens.c1)
    for (const k of '/model opus') alex.client.write('c1', k)
    alex.client.write('c1', '\r')
    await until(() => alex.notices.length)
    expect(alex.notices[0]).toMatchObject({ code: 'model-denied', agent: 'Claude Code' })
    expect(t.writes.some(([, d]) => d === '\r')).toBe(false)
    alex.client.write('c1', '/model sonnet\r')
    alex.client.write('c1', 'explain this\r')
    await until(() => t.writes.some(([, d]) => d === 'explain this\r'))
    expect(t.writes.map(([, d]) => d)).toContain('/model sonnet\r')
  })

  it('follows the share’s setting when the guest has no rule, and its own rule over it', async () => {
    const t = fakeTessel()
    t.shareRule = setAgentAllowed(null, 'codex', false, HOST_IDS)
    const alex = await joined(await share(t), 'Alex')
    await grant(alex, 'Alex', ALL)
    expect(alex.rights.at(-1).agents).toEqual(t.shareRule)
    alex.client.open({ kind: 'agent', agent: 'codex', project: 'ws-a' })
    await until(() => alex.notices.length)
    expect(alex.notices[0].code).toBe('agent-denied')
    // The share's setting changes: the guest is told at once.
    t.shareRule = null
    const n = alex.rights.length
    host.agentRuleChanged()
    await until(() => alex.rights.length > n)
    expect(alex.rights.at(-1).agents).toBeUndefined()
    expect(alex.agents.at(-1).map((a) => a.id)).toEqual(['claude', 'codex'])
    // Its own rule counts over the share's.
    t.shareRule = setAgentAllowed(null, 'codex', false, HOST_IDS)
    expect(host.change(guestOf('Alex').id, { agents: setAgentAllowed(null, 'claude', false, HOST_IDS) })).toBe(true)
    await until(() => alex.rights.at(-1).agents && alex.rights.at(-1).agents.deny.includes('claude'))
    alex.client.open({ kind: 'agent', agent: 'codex', project: 'ws-a' })
    await until(() => t.opened.length === 1)
    // Back to the share's setting.
    expect(host.change(guestOf('Alex').id, { agents: null })).toBe(true)
    await until(() => alex.rights.at(-1).agents && alex.rights.at(-1).agents.deny.includes('codex'))
  })

  it('lets in an agent the host installs later only while "Allow agents I add later" is on', async () => {
    const t = fakeTessel()
    const alex = await joined(await share(t), 'Alex')
    await grant(alex, 'Alex', withAgents(ALL, setAgentLater(null, true, HOST_IDS)))
    t.agents = [...t.agents, { id: 'gemini', name: 'Gemini' }]
    host.agentsChanged()
    await until(() => alex.agents.at(-1).some((a) => a.id === 'gemini'))
    alex.client.open({ kind: 'agent', agent: 'gemini', project: 'ws-a' })
    await until(() => t.opened.length === 1)
    // "Later" off (made before Gemini came): Gemini is refused.
    await grant(alex, 'Alex', withAgents(ALL, setAgentLater(null, false, HOST_IDS)))
    await until(() => !alex.agents.at(-1).some((a) => a.id === 'gemini'))
    alex.client.open({ kind: 'agent', agent: 'gemini', project: 'ws-a' })
    await until(() => alex.notices.length)
    expect(alex.notices[0]).toMatchObject({ code: 'agent-denied', agent: 'Gemini' })
    expect(t.opened).toHaveLength(1)
  })

  it('takes nothing in a pane it does not know yet, or one being checked, from a guest whose rule limits agents (and everything without a rule)', async () => {
    const t = fakeTessel()
    t.panes = { s1: { agent: null, models: [] }, x1: { agent: 'codex', models: [], unsure: true } }
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    await grant(alex, 'Alex', withAgents(ALL, setAgentAllowed(null, 'claude', false, HOST_IDS)))
    await until(() => alex.screens.c1)
    alex.client.write('c1', 'a')
    alex.client.write('x1', 'b')
    alex.client.write('s1', 'ls\r')
    await until(() => t.writes.length === 1)
    await wait(40)
    expect(t.writes).toEqual([['s1', 'ls\r']])
    expect(alex.notices.map((n) => n.code)).toEqual(['checking', 'checking'])
    // No rule that limits anything: as before.
    await grant(alex, 'Alex', ALL)
    alex.client.write('c1', 'a')
    await until(() => t.writes.length === 2)
  })

  it('checks every agent found running in a pane, and every source of its model', async () => {
    const t = fakeTessel()
    // Codex started from the Claude pane (Claude's ! mode, say).
    t.panes.c1 = { agent: 'claude', models: ['sonnet'], others: ['codex'] }
    const alex = await joined(await share(t), 'Alex')
    await grant(alex, 'Alex', withAgents(ALL, setAgentAllowed(null, 'codex', false, HOST_IDS)))
    await until(() => alex.screens.c1)
    alex.client.write('c1', 'x')
    await until(() => alex.notices.length)
    expect(alex.notices[0]).toMatchObject({ code: 'type-denied', agent: 'Codex' })
    // Back at its shell prompt (Claude quit): a shell.
    t.panes.c1 = { agent: null, models: [], others: [] }
    alex.client.write('c1', 'y')
    await until(() => t.writes.length === 1)
    // Two sources of its model, one left out: refused.
    t.panes.c1 = { agent: 'claude', models: ['sonnet', 'opus'] }
    await grant(alex, 'Alex', withAgents(ALL, setAgentModels(null, 'claude', ['sonnet'], HOST_IDS)))
    alex.client.write('c1', 'z')
    await until(() => alex.notices.some((n) => n.code === 'model-denied'))
    // Limited models and its model not known: refused too.
    t.panes.c1 = { agent: 'claude', models: [] }
    alex.client.write('c1', 'z')
    await wait(60)
    expect(t.writes).toHaveLength(1)
  })

  it('refuses the keys it can’t follow where models are limited, and follows a line across a reconnect', async () => {
    const t = fakeTessel()
    const conn = await share(t)
    const alex = await joined(conn, 'Alex')
    await grant(alex, 'Alex', withAgents(ALL, setAgentModels(null, 'claude', ['sonnet'], HOST_IDS)))
    await until(() => alex.screens.c1)
    for (const k of ['\t', '\x1b[A', '\x1bp', '\x01', '\x1b[H']) alex.client.write('c1', k)
    alex.client.write('x1', '\t')
    await until(() => t.writes.length === 1)
    await wait(40)
    expect(t.writes).toEqual([['x1', '\t']])
    // "/mo" then the connection drops; back, it types "del opus" + Enter.
    alex.client.write('c1', '/mo')
    await until(() => t.writes.length === 2)
    alex.client.disconnect()
    const back = await joined(conn, 'Alex', alex)
    await until(() => back.screens.c1)
    back.client.write('c1', 'del opus\r')
    await until(() => back.notices.some((n) => n.code === 'model-denied'))
    expect(t.writes).toHaveLength(2)
  })

  it('presses Esc in a pane that switched to a left-out model soon after the guest typed there, and tells the host', async () => {
    const t = fakeTessel()
    const alex = await joined(await share(t), 'Alex')
    await grant(alex, 'Alex', withAgents(ALL, setAgentModels(null, 'claude', ['sonnet'], HOST_IDS)))
    await until(() => alex.screens.c1)
    alex.client.write('c1', 'hello\r')
    await until(() => t.writes.length === 1)
    t.panes.c1 = { agent: 'claude', models: ['opus'] }
    host.paneChanged('c1')
    expect(t.writes.at(-1)).toEqual(['c1', '\x1b'])
    expect(t.breaches).toEqual([expect.objectContaining({ pane: 'c1', agent: 'Claude Code', model: 'opus', guest: expect.objectContaining({ name: 'Alex' }) })])
    // Once per pane in a while; a pane nobody typed in: nothing.
    host.paneChanged('c1')
    host.paneChanged('x1')
    expect(t.breaches).toHaveLength(1)
  })

  it('keeps the invitation’s agents rule when the host’s answer is a plain yes', async () => {
    const t = fakeTessel()
    const rule = setAgentAllowed(null, 'claude', false, HOST_IDS)
    const secret = newSecret()
    host = createShareHost({ secret, hostName: 'Ada', callbacks: t.callbacks })
    const port = await host.start()
    const inv = host.invites()[0]
    expect(host.updateInvite(inv.id, { rights: withAgents(ALL, rule) }).ok).toBe(true)
    const alex = await joined({ port, secret }, 'Alex')
    expect(alex.rights.at(-1).agents).toEqual(rule)
    expect(guestOf('Alex').rights.agents).toEqual(rule)
  })

  it('opens with a picked model only one the host lists for that agent', async () => {
    const t = fakeTessel()
    const alex = await joined(await share(t), 'Alex')
    await grant(alex, 'Alex', ALL)
    alex.client.open({ kind: 'agent', agent: 'claude', project: 'ws-a', model: 'made-up' })
    alex.client.open({ kind: 'agent', agent: 'claude', project: 'ws-a', model: 'opus' })
    await until(() => t.opened.length === 2)
    expect(t.opened.map(([, s]) => s.model)).toEqual([undefined, 'opus'])
  })
})
