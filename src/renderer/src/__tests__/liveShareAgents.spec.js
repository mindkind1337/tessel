// Live Share: "Agents they may use" in the window (liveshare/LsAgents.vue):
// the share's setting in the dialog, an invitation's (following the share's
// until changed), a person's; the models of an agent; the guest's "+" menu
// with the models the host allows, and the guest's summary of its rights.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LiveShareDialog from '../components/LiveShareDialog.vue'
import LaunchMenu from '../components/LaunchMenu.vue'
import { fakeApi, OFF_GUEST, guest, trustedOne, sharing } from './liveShareFakes'
import { rightsText } from '../liveShareWindow'
import { grantDiff } from '../liveShareAccess'
import { NO_RIGHTS } from '../../../shared/liveShareRights'

const PROJECTS = [{ id: 'ws-1', name: 'tessel' }]
const AGENTS = [
  { id: 'claude', name: 'Claude Code', models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
  { id: 'codex', name: 'Codex' }
]

let api
beforeEach(() => {
  ;({ api } = fakeApi())
  api.setSettings = vi.fn().mockResolvedValue({ ok: true })
  window.shellApi = { liveShare: api, writeClipboard: vi.fn() }
})
afterEach(() => {
  delete window.shellApi
  vi.clearAllMocks()
})

async function openAt(section, host) {
  api.state.mockResolvedValue({ host: { agents: AGENTS, ...host }, guest: OFF_GUEST, defaultName: 'ada' })
  const w = mount(LiveShareDialog, { props: { open: true, initialSection: section, projects: PROJECTS, projectIds: ['ws-1'] }, attachTo: document.body })
  await flushPromises()
  return w
}
const tick = async (w, sel) => {
  const box = w.find(sel)
  box.element.checked = !box.element.checked
  await box.trigger('change')
  await flushPromises()
}
const lastArg = (fn) => fn.mock.calls.at(-1)[0]

describe('Agents guests may use: the share’s setting', () => {
  it('lists your agents, all allowed by default, and saves a rule when one is left out', async () => {
    const w = await openAt('settings', sharing({ settings: { hideIgnored: true } }))
    const root = w.find('[data-test="ls-agents-setting"]')
    expect(root.find('[data-test="ls-agents-share-summary"]').text()).toBe('All agents')
    await root.find('[data-test="ls-agents-share-toggle"]').trigger('click')
    expect(root.find('[data-test="ls-agents-share-follow"]').exists()).toBe(false)
    expect(root.find('[data-test="ls-agents-share-agent-claude"]').text()).toBe('Claude Code')
    expect(root.find('[data-test="ls-agents-share-later"] input').element.checked).toBe(true)
    expect(root.find('[data-test="ls-agents-share-hint"]').text()).toContain('can’t open them or type in them')
    expect(root.find('[data-test="ls-agents-share-caveat"]').text()).toBe('Anyone who can type — in a terminal or in an agent you allow — can still start any program, including agents and models you leave out. These limits fully hold only for guests who can’t type.')
    await tick(w, '[data-test="ls-agents-share-agent-claude"] input')
    expect(lastArg(api.setSettings)).toEqual({ agents: { deny: ['claude'], later: true, known: ['claude', 'codex'], models: {} } })
    w.unmount()
  })

  it('limits an agent’s models: all at first, then only the ones ticked, never none', async () => {
    const w = await openAt('settings', sharing({ settings: { hideIgnored: true, agents: { deny: [], later: true, known: ['claude', 'codex'], models: { claude: ['sonnet'] } } } }))
    expect(w.find('[data-test="ls-agents-share-summary"]').text()).toBe('All agents, some models only')
    await w.find('[data-test="ls-agents-share-toggle"]').trigger('click')
    expect(w.find('[data-test="ls-agents-share-models-claude"]').text()).toContain('1 of 2 models')
    expect(w.find('[data-test="ls-agents-share-models-codex"]').exists()).toBe(false)
    await w.find('[data-test="ls-agents-share-models-claude"]').trigger('click')
    // Sonnet is the last one: it can't be unticked.
    expect(w.find('[data-test="ls-agents-share-model-claude-sonnet"] input').attributes('disabled')).toBeDefined()
    await tick(w, '[data-test="ls-agents-share-model-claude-opus"] input')
    expect(lastArg(api.setSettings).agents.models).toEqual({ claude: ['sonnet', 'opus'] })
    await tick(w, '[data-test="ls-agents-share-allmodels-claude"] input')
    expect(lastArg(api.setSettings).agents.models).toEqual({})
    w.unmount()
  })

  it('says when agents you add later are left out', async () => {
    const w = await openAt('settings', sharing({ settings: { agents: { deny: [], later: false, known: ['claude', 'codex'], models: {} } } }))
    expect(w.find('[data-test="ls-agents-share-summary"]').text()).toBe('All agents, not the ones you add later')
    w.unmount()
  })
})

describe('Agents guests may use: an invitation, a person, a trusted person', () => {
  it('a new invitation follows the share’s setting until you change it', async () => {
    const w = await openAt('invites', sharing({ invites: [], settings: { agents: { deny: ['codex'], later: true, known: ['claude', 'codex'], models: {} } } }))
    await w.find('[data-test="ls-invite-new"]').trigger('click')
    expect(w.find('[data-test="ls-agents-invite-summary"]').text()).toBe('As the share’s setting: 1 of 2 agents')
    await w.find('[data-test="ls-agents-invite-toggle"]').trigger('click')
    expect(w.find('[data-test="ls-agents-invite-follow"] input').element.checked).toBe(true)
    expect(w.find('[data-test="ls-agents-invite-agent-claude"] input').attributes('disabled')).toBeDefined()
    // Its own: a copy of the share's, then Claude left out too.
    await tick(w, '[data-test="ls-agents-invite-follow"] input')
    await tick(w, '[data-test="ls-agents-invite-agent-claude"] input')
    await w.find('[data-test="ls-invite-save"]').trigger('click')
    await flushPromises()
    expect(lastArg(api.createInvite).rights.agents).toEqual({ deny: ['codex', 'claude'], later: true, known: ['claude', 'codex'], models: {} })
    w.unmount()
  })

  it('next to a person who can type, says the limits hold only partly', async () => {
    const own = { deny: ['claude'], later: true, known: ['claude', 'codex'], models: {} }
    const w = await openAt('people', sharing({ guests: [guest({ rights: { ...NO_RIGHTS, type: true, agents: own } }), guest({ id: 'g2', name: 'Eve', rights: { ...NO_RIGHTS, agents: own } })] }))
    expect(w.find('[data-test="ls-agents-g1-type-warn"]').text()).toContain('can still start any program, including agents and models you leave out')
    expect(w.find('[data-test="ls-agents-g2-type-warn"]').exists()).toBe(false)
    w.unmount()
  })

  it('a person’s list changes at once (main checks it), and back to the share’s setting', async () => {
    const own = { deny: ['claude'], later: true, known: ['claude', 'codex'], models: {} }
    const w = await openAt('people', sharing({ guests: [guest({ rights: { ...NO_RIGHTS, open: true, agents: own } })] }))
    const g = guest().id
    expect(w.find(`[data-test="ls-agents-${g}-summary"]`).text()).toBe('1 of 2 agents')
    await w.find(`[data-test="ls-agents-${g}-toggle"]`).trigger('click')
    await tick(w, `[data-test="ls-agents-${g}-agent-claude"] input`)
    expect(lastArg(api.access)).toEqual({ subject: g, agents: { deny: [], later: true, known: ['claude', 'codex'], models: {} } })
    await tick(w, `[data-test="ls-agents-${g}-follow"] input`)
    expect(lastArg(api.access)).toEqual({ subject: g, agents: null })
    w.unmount()
  })

  it('a trusted person’s list too', async () => {
    const tr = trustedOne({ rights: { ...NO_RIGHTS, agents: { deny: [], later: true, known: ['claude', 'codex'], models: {} } } })
    const w = await openAt('trusted', sharing({ trusted: [tr] }))
    await w.find(`[data-test="ls-agents-${tr.id}-toggle"]`).trigger('click')
    await tick(w, `[data-test="ls-agents-${tr.id}-agent-codex"] input`)
    expect(lastArg(api.access)).toEqual({ subject: tr.id, agents: { deny: ['codex'], later: true, known: ['claude', 'codex'], models: {} } })
    w.unmount()
  })

  it('a changed invitation says its agents list goes with what is taken away', () => {
    const before = { projects: [], rights: { ...NO_RIGHTS } }
    const after = { projects: [], rights: { ...NO_RIGHTS, agents: { deny: ['claude'], later: true, known: [], models: {} } } }
    expect(grantDiff(before, after)).toMatchObject({ removedRights: ['agents'], addedRights: [] })
    expect(grantDiff(before, before).removedRights).toEqual([])
  })
})

describe('Agents guests may use, as a guest', () => {
  const props = (hostMenu) => ({ shells: [], agents: [], hostMenu, accountChoice: false })

  it('the "+" menu offers one item per model the host allows, and the agent alone otherwise', async () => {
    const w = mount(LaunchMenu, { props: props({ host: 'Ada', agents: [{ id: 'claude', name: 'Claude Code', models: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }] }, { id: 'grok', name: 'Grok' }], canOpen: true }) })
    expect(w.find('[data-test="launch-host-agent-claude"]').exists()).toBe(false)
    expect(w.find('[data-test="launch-host-agent-claude-model-sonnet"]').text()).toBe('Claude Code · Sonnet')
    expect(w.find('[data-test="launch-host-agent-grok"]').text()).toBe('Grok')
    await w.find('[data-test="launch-host-agent-claude-model-haiku"]').trigger('click')
    expect(w.emitted('launch')).toEqual([[{ kind: 'agent', id: 'claude', sessionOptions: { model: 'haiku' } }]])
  })

  it('its rights summary says when the host keeps agents or models from guests', () => {
    const open = { ...NO_RIGHTS, open: true }
    expect(rightsText(open)).toBe('You can watch and open terminals and agents.')
    expect(rightsText({ ...open, agents: { deny: [], later: true, known: [], models: {} } })).toBe('You can watch and open terminals and agents.')
    expect(rightsText({ ...open, agents: { deny: ['claude'], later: true, known: [], models: {} } })).toBe('You can watch and open terminals and agents. Some of the host’s agents or models are not for guests: you can watch their panes, not open or type in them.')
    // A guest who can type: said plainly that the limits hold only partly.
    expect(rightsText({ ...open, type: true, agents: { deny: ['claude'], later: true, known: [], models: {} } })).toMatch(/Anyone who can type — in a terminal or in an agent the host allows — can still start any program, including agents and models left out\. These limits fully hold only for guests who can’t type\.$/)
  })
})
