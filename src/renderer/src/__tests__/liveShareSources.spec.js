// Panels a Live Share guest fills with the host's data, each from a source
// or a snapshot, and as before without one: the Task history (records, costs
// in dollars only when allowed), the sub-agents chip (read through the
// source), the usage menu's "<host>'s usage" section (never an account or an
// action), and Jump to file on a host's project.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive, nextTick } from 'vue'
import TaskHistoryPanel from '../components/TaskHistoryPanel.vue'
import AgentChildren from '../components/AgentChildren.vue'
import UsageMenu from '../components/UsageMenu.vue'
import FileFinder from '../components/FileFinder.vue'
import { setTaskHistory } from '../taskHistory'
import { resetHistoryCostCache } from '../taskHistoryView'
import { cleanHostUsage, latestUpdate } from '../hostUsage'
import { setLshareAccess, forgetLshareAccess } from '../liveShareGuestAccess'
import { selectOptions } from './selectTestUtils'

const NOW = new Date(2026, 9, 3, 15, 0, 0).getTime()
const H = 3600 * 1000
const ok = (input, output, usd) => ({ status: 'ok', inputTokens: input, outputTokens: output, usd, known: usd !== null, final: true, models: [{ model: 'claude-opus-4-8', inputTokens: input, outputTokens: output, usd, known: usd !== null }] })

afterEach(() => {
  delete window.shellApi
  vi.useRealTimers()
  forgetLshareAccess()
  document.body.innerHTML = ''
})

describe('Task history from a source', () => {
  beforeEach(() => {
    resetHistoryCostCache()
    setTaskHistory([{ id: 'local', title: 'My local task', wsId: 'ws', doneAt: NOW - H, durationMs: 1000, cost: ok(1, 1, 0.1) }])
  })
  function hostRecords() {
    return [
      { id: 'r1', title: 'Host task one', agentName: 'Ada', agentKind: 'claude', project: 'Site', doneAt: NOW - H, durationMs: 600000, cost: ok(1000, 500, 0.5) },
      { id: 'r2', title: 'Host task two', agentName: 'Bo', agentKind: 'codex', project: 'Site', doneAt: NOW - 2 * H, durationMs: 60000, cost: ok(10, 10, null) }
    ]
  }

  it("shows the source's records with their figures, reads nothing here, and hides dollars unless allowed", async () => {
    const forCards = vi.fn(async () => ({}))
    window.shellApi = { jobCost: { forCards, onChanged: vi.fn(() => () => {}) } }
    const source = reactive({ records: hostRecords(), usd: false })
    const w = mount(TaskHistoryPanel, { props: { active: true, now: NOW, workspaceId: 'ws', source }, attachTo: document.body })
    await flushPromises()
    expect(w.text()).toContain('Host task one')
    expect(w.text()).not.toContain('My local task')
    expect(w.find('[data-test="history-scopes"]').exists()).toBe(false)
    expect(w.get('[data-test="total-tasks"]').text()).toBe('2')
    expect(w.find('[data-test="total-cost"]').exists()).toBe(false)
    expect(w.find('[data-test="row-cost"]').exists()).toBe(false)
    const sorts = (await selectOptions(w.get('[data-test="history-sort"]'))).map((o) => o.element.dataset.value)
    expect(sorts).toEqual(['date', 'time'])
    expect(forCards).not.toHaveBeenCalled()
    expect(window.shellApi.jobCost.onChanged).not.toHaveBeenCalled()
    // Allowed (the host's "See my usage"), live.
    source.usd = true
    await nextTick()
    expect(w.get('[data-test="total-cost"]').text()).toMatch(/0\.5/)
    expect(w.findAll('[data-test="row-cost"]')).toHaveLength(2)
    w.unmount()
  })

  it('a history the host no longer shares says so', async () => {
    const w = mount(TaskHistoryPanel, { props: { active: false, now: NOW, source: { records: hostRecords(), state: 'no-access' } } })
    expect(w.get('[data-test="history-access"]').text()).toContain('You no longer have access to this project.')
    expect(w.find('[data-test="history-row-r1"]').exists()).toBe(false)
    w.unmount()
  })

  it("without a source: this computer's history, dollars and its own figures as before", async () => {
    window.shellApi = { jobCost: { forCards: vi.fn(async () => ({})), onChanged: () => () => {} } }
    const w = mount(TaskHistoryPanel, { props: { active: true, now: NOW, workspaceId: 'ws' }, attachTo: document.body })
    await flushPromises()
    expect(w.text()).toContain('My local task')
    expect(w.find('[data-test="history-scopes"]').exists()).toBe(true)
    expect(w.find('[data-test="total-cost"]').exists()).toBe(true)
    expect(w.find('[data-test="row-cost"]').exists()).toBe(true)
    w.unmount()
  })
})

describe('the sub-agents chip from a source', () => {
  const mountChip = (props) => mount(AgentChildren, { props, global: { stubs: { teleport: true } } })

  it("reads the list through the source (never this computer's files), again on its schedule", async () => {
    vi.useFakeTimers()
    const agentChildren = vi.fn(async () => [])
    window.shellApi = { agentChildren }
    const read = vi.fn(async () => [{ id: 'c1', title: 'Host child', type: 'Explore', state: 'running', startedAt: Date.now() }])
    const w = mountChip({ agentId: 'claude', sessionId: null, source: { read } })
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('1 running')
    await vi.advanceTimersByTimeAsync(5000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(agentChildren).not.toHaveBeenCalled()
    await w.get('[data-test="agent-children"]').trigger('click')
    expect(w.text()).toContain('Host child')
    w.unmount()
  })

  it("another source (another host pane): the old list goes at once", async () => {
    window.shellApi = {}
    let resolveB
    const a = { read: vi.fn(async () => [{ id: 'a', title: 'A work', state: 'running', startedAt: Date.now() }]) }
    const b = { read: vi.fn(() => new Promise((r) => (resolveB = r))) }
    const w = mountChip({ agentId: 'claude', source: a })
    await flushPromises()
    expect(w.text()).toContain('1 running')
    await w.setProps({ source: b })
    await flushPromises()
    expect(w.find('[data-test="agent-children"]').exists()).toBe(false)
    resolveB([{ id: 'b', title: 'B work', state: 'running', startedAt: Date.now() }])
    await flushPromises()
    expect(w.text()).toContain('1 running')
    w.unmount()
  })

  it('without a source: this computer\'s reader, as before', async () => {
    const agentChildren = vi.fn(async () => [])
    window.shellApi = { agentChildren }
    const w = mountChip({ agentId: 'claude', sessionId: 'S1' })
    await flushPromises()
    expect(agentChildren).toHaveBeenCalledWith({ agent: 'claude', sessionId: 'S1' })
    w.unmount()
  })
})

describe("the usage menu's section of the host's usage", () => {
  const soon = () => Date.now() + 90 * 60000
  function snapshot() {
    return {
      providers: [
        {
          id: 'claude',
          plan: 'Max',
          windows: [{ label: '5h', usedPct: 42, resetsAt: soon(), accountId: 'acct-1' }],
          status: 'ok',
          updatedAt: Date.now() - 5 * 60000,
          // Never shown, whatever a host sends.
          email: 'ana@example.com',
          accountId: 'acct-secret-1',
          label: 'Work account',
          error: 'token expired at C:\\Users\\ana',
          credits: 12
        },
        { id: 'codex', plan: 'Plus', windows: [], status: 'signin', updatedAt: Date.now() - 60000, organization: 'ACME Corp' }
      ]
    }
  }
  function local() {
    window.shellApi = {
      listAgents: vi.fn(async () => []),
      getUsage: vi.fn(async () => ({ agents: [] })),
      providerUsage: { read: vi.fn(), redeemReset: vi.fn(), autoRefresh: vi.fn(async () => ({})) },
      accounts: { list: vi.fn(async () => ({ ok: true, providers: [] })) }
    }
  }
  async function openMenu(props) {
    local()
    const w = mount(UsageMenu, { props, attachTo: document.body })
    await flushPromises()
    await w.get('[data-test="usage-button"]').trigger('click')
    await flushPromises()
    return w
  }

  it('cleanHostUsage keeps only the plan, the windows, the status and when it was read', () => {
    const [claude, codex] = cleanHostUsage(snapshot())
    expect(Object.keys(claude).sort()).toEqual(['id', 'plan', 'stale', 'status', 'updatedAt', 'windows'])
    expect(Object.keys(claude.windows[0]).sort()).toEqual(['label', 'resetsAt', 'usedPct'])
    expect(codex).toMatchObject({ id: 'codex', status: 'signin', windows: [] })
    // Bounded and checked.
    const bad = cleanHostUsage({
      providers: [
        { id: '../x', windows: [] },
        { id: 'kimi', status: 'weird', windows: [{ label: 'week', usedPct: 250 }, { label: '', usedPct: 5 }, { label: 'day', usedPct: 'x' }] },
        { id: 'kimi', status: 'ok' }
      ]
    })
    expect(bad).toEqual([{ id: 'kimi', plan: '', windows: [{ label: 'week', usedPct: 100, resetsAt: null }], status: 'error', updatedAt: null, stale: false }])
    expect(cleanHostUsage(null)).toEqual([])
    expect(latestUpdate([{ updatedAt: 5 }, { updatedAt: 9 }, { updatedAt: null }])).toBe(9)
  })

  it('"Ana\'s usage": the plan, % and reset, when it was read; never an account field; no refresh, accounts, reset or history', async () => {
    const w = await openMenu({ hostUsage: snapshot(), hostName: 'Ana' })
    const section = w.get('[data-test="usage-host"]')
    expect(section.text()).toContain('Ana’s usage')
    expect(section.get('[data-test="usage-host-updated"]').text()).toBe('Updated 1 min ago')
    const claude = section.get('[data-test="usage-host-row-claude"]')
    expect(claude.text()).toContain('Max')
    expect(claude.text()).toContain('42%')
    expect(section.get('[data-test="usage-host-row-codex"]').text()).toContain('The host needs to sign in again')
    for (const secret of ['ana@example.com', 'acct-secret-1', 'acct-1', 'Work account', 'token expired', 'ACME', '12']) expect(section.text()).not.toContain(secret)
    // Nothing to act with in it.
    expect(section.findAll('button')).toHaveLength(0)
    expect(section.find('[data-test="usage-refresh"]').exists()).toBe(false)
    expect(section.find('[data-test="usage-manage-accounts"]').exists()).toBe(false)
    expect(section.find('[data-test="usage-details"]').exists()).toBe(false)
    expect(section.text()).not.toMatch(/Reset now|Manage accounts|history/i)
    w.unmount()
  })

  it('the host\u2019s agents are named as on its own screen (Antigravity, Cursor, Grok, OpenCode Go), their plans with a capital', async () => {
    const hostUsage = { providers: [
      { id: 'antigravity', plan: 'Ultra', windows: [{ label: '5h', usedPct: 100 }], status: 'ok' },
      { id: 'cursor', windows: [], status: 'error' },
      { id: 'grok', plan: 'supergrok', windows: [{ label: '5h', usedPct: 7 }], status: 'ok' },
      { id: 'opencode-go', windows: [], status: 'signin' },
      { id: 'codex', plan: 'pro', windows: [{ label: '5h', usedPct: 87 }], status: 'ok' }
    ] }
    const w = await openMenu({ hostUsage, hostName: 'Ana' })
    const row = (id) => w.get(`[data-test="usage-host-row-${id}"]`).text()
    expect(row('antigravity')).toContain('Antigravity')
    expect(row('cursor')).toContain('Cursor')
    expect(row('grok')).toContain('Grok')
    expect(row('grok')).toContain('Supergrok')
    expect(row('opencode-go')).toContain('OpenCode Go')
    expect(row('codex')).toContain('Codex')
    expect(row('codex')).toContain('Pro')
    for (const id of ['antigravity', 'cursor', 'grok']) expect(row(id)).not.toMatch(new RegExp(`^${id}`))
    w.unmount()
  })
  it('Detailed / Compact is a local view choice, applied to the section too', async () => {
    const w = await openMenu({ hostUsage: snapshot(), hostName: 'Ana' })
    expect(w.find('[data-test="usage-host"] .usage-provider-detail').exists()).toBe(false)
    await w.get('[data-test="usage-mode-detailed"]').trigger('click')
    const detail = w.get('[data-test="usage-host-row-claude"] .usage-provider-detail')
    expect(detail.text()).toMatch(/5-hour\s*42%/)
    expect(detail.text()).toMatch(/resets in 1 h (29|30) min/)
    expect(detail.text()).toContain('Updated 5 min ago')
    w.unmount()
  })

  it('no snapshot (the right taken away): no section; the toolbar icon is only my own usage', async () => {
    const w = await openMenu({ hostUsage: null, hostName: 'Ana' })
    expect(w.find('[data-test="usage-host"]').exists()).toBe(false)
    await w.setProps({ hostUsage: { providers: [{ id: 'claude', windows: [{ label: '5h', usedPct: 95 }], status: 'ok' }] } })
    expect(w.find('[data-test="usage-host"]').exists()).toBe(true)
    expect(w.get('[data-test="usage-button"]').classes()).not.toContain('usage-bad')
    w.unmount()
  })
})

describe("Jump to file on a Live Share host's project", () => {
  it('lists through the session; the access taken away or refused is said, not asked', async () => {
    window.shellApi = { listFiles: vi.fn(async () => ({ ok: true, files: ['src/a.js'], truncated: false })) }
    let w = mount(FileFinder, { props: { root: 'lshare://p1' }, attachTo: document.body })
    await flushPromises()
    expect(window.shellApi.listFiles).toHaveBeenCalledWith('lshare://p1')
    expect(w.findAll('[data-test="finder-item"]')).toHaveLength(1)
    w.unmount()

    setLshareAccess('p1', { state: 'no-access' })
    window.shellApi.listFiles.mockClear()
    w = mount(FileFinder, { props: { root: 'lshare://p1' }, attachTo: document.body })
    await flushPromises()
    expect(window.shellApi.listFiles).not.toHaveBeenCalled()
    expect(w.text()).toContain('You no longer have access to this project.')
    w.unmount()

    forgetLshareAccess()
    window.shellApi.listFiles.mockResolvedValueOnce({ ok: false, code: 'outdated-host', error: 'x' })
    w = mount(FileFinder, { props: { root: 'lshare://p1' }, attachTo: document.body })
    await flushPromises()
    expect(w.text()).toMatch(/host’s Tessel is too old/)
    w.unmount()
  })
})
