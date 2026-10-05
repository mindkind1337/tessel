// The Agent Session History tab (SessionHistoryPanel.vue, SessionHistoryRow.vue):
// the list from the main process, its scope, search, rows, details and actions.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, config } from '@vue/test-utils'
import { nextTick } from 'vue'
import SessionHistoryPanel from '../components/SessionHistoryPanel.vue'
import { VIEW_STORAGE_KEY } from '../sessionHistory'

// Real <Transition>: the stub would wrap the teleported menus in an element.
config.global.stubs.transition = false

const NOW = 1_800_000_000_000
const SESSIONS = [
  { agent: 'claude', id: 'aaaaaaaa-1111-4222-8333-444444444444', cwd: 'C:\\proj', title: 'Fix the build', started: NOW - 7_200_000, updated: NOW - 300_000, accountId: null },
  { agent: 'codex', id: 'bbbbbbbb-1111-4222-8333-444444444444', cwd: 'C:\\proj\\sub', title: 'Rename things', started: NOW - 90_000_000, updated: NOW - 86_400_000 * 2, accountId: null, accountLabel: 'Work' },
  { agent: 'gemini', id: 'cccccccc-1111-4222-8333-444444444444', cwd: 'D:\\other', title: 'Elsewhere', started: NOW - 10_000, updated: NOW - 10_000 }
]
let calls
let api
let wrapper = null
beforeEach(() => {
  localStorage.removeItem(VIEW_STORAGE_KEY)
  calls = []
  const rec = (name, value) => vi.fn((q) => {
    calls.push([name, q])
    return Promise.resolve(typeof value === 'function' ? value(q) : value)
  })
  api = {
    listSessions: rec('list', SESSIONS),
    sessionDetails: rec('details', { ok: true, file: 'C:\\home\\.claude\\projects\\x\\a.jsonl', firstPrompt: 'Fix the build, please', turns: [{ role: 'user', text: 'Fix the build, please', at: NOW }, { role: 'assistant', text: 'Fixed.', at: NOW }], messageCount: 2 }),
    revealSessionLog: rec('reveal', { ok: true }),
    deleteSession: rec('delete', { ok: true }),
    agentChildren: rec('children', []),
    writeClipboard: vi.fn(),
    chatFiles: { open: rec('openCwd', { ok: true }) },
    sessionSearch: {
      status: rec('status', { available: true, enabled: false, phase: 'idle', filesDue: 0, sessions: 0, sizeBytes: 0 }),
      enable: rec('enable', { ok: true }),
      search: rec('search', { ok: true, hits: [{ agent: 'claude', sessionId: 'aaaaaaaa-1111-4222-8333-444444444444', cwd: 'C:\\proj', title: 'Fix the build', updatedAt: NOW, messageCount: 4, evidence: { role: 'assistant', snippet: 'the \uE000build\uE001 is fixed' } }] })
    }
  }
  window.shellApi = api
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  vi.restoreAllMocks()
  delete window.shellApi
})

async function make(props = {}) {
  wrapper = mount(SessionHistoryPanel, {
    props: { cwd: 'C:\\proj', openIds: {}, ...props },
    attachTo: document.body,
    global: { provide: { askConfirm: () => Promise.resolve(true) } }
  })
  await flushPromises()
  return wrapper
}
const rows = () => wrapper.findAll('[data-test="session-row"]')
const titles = () => rows().map((r) => r.find('.sh-row-title').text())
// A menu opens on the trigger's pointer down, as Radix does; its items are teleported to <body>.
async function openMenu(trigger) {
  // A menu that just closed is still fading out: let it leave first.
  await new Promise((r) => setTimeout(r, 30))
  trigger.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))
  await nextTick()
  await nextTick()
}
// The last one: a menu just closed is still in the DOM while it fades out.
const menuItem = (test) => Array.from(document.querySelectorAll(`[data-test="${test}"]`)).at(-1) || null

describe('SessionHistoryPanel.vue', () => {
  it('lists the workspace’s conversations first, then the project, then all', async () => {
    await make()
    expect(calls[0]).toEqual(['list', { cwd: null, limit: 50 }])
    expect(wrapper.find('.sh-title-full').text()).toBe('Agent Session History')
    expect(wrapper.find('[data-test="scope-workspace"]').attributes('aria-pressed')).toBe('true')
    expect(titles()).toEqual(['Fix the build'])
    expect(wrapper.find('[data-test="session-bar"]').text()).toContain('1 of 3 sessions')
    // The folder badge is for the other scopes.
    expect(wrapper.find('.sh-badge').exists()).toBe(false)
    await wrapper.find('[data-test="scope-project"]').trigger('click')
    expect(titles()).toEqual(['Fix the build', 'Rename things'])
    expect(wrapper.findAll('.sh-folder-line .sh-badge').map((b) => b.text())).toEqual(['C:/proj', 'proj/sub'])
    await wrapper.find('[data-test="scope-all"]').trigger('click')
    expect(titles()).toEqual(['Elsewhere', 'Fix the build', 'Rename things'])
    expect(wrapper.findAll('[data-test="session-group"]').map((g) => [g.find('.sh-group-label').text(), g.find('.sh-group-count').text()])).toEqual([
      ['D:/other', '1'],
      ['C:/proj', '1'],
      ['proj/sub', '1']
    ])
    // The row's facts: agent, time, a Codex account.
    const meta = rows()[2].find('[data-test="session-meta"]').text()
    expect(meta).toContain('Codex')
    expect(meta).toContain('2d ago')
    expect(meta).toContain('Work')
  })

  it('a group folds; the query filters the list without the index', async () => {
    await make({ cwd: null })
    expect(wrapper.find('[data-test="scope-workspace"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="scope-all"]').attributes('aria-pressed')).toBe('true')
    await wrapper.findAll('[data-test="session-group"]')[0].trigger('click')
    expect(titles()).toEqual(['Fix the build', 'Rename things'])
    await wrapper.find('[data-test="session-query"]').setValue('rename')
    expect(titles()).toEqual(['Rename things'])
    expect(wrapper.find('[data-test="session-bar"]').text()).toContain('1 of 3 sessions')
    await wrapper.find('[data-test="session-clear"]').trigger('click')
    expect(wrapper.find('[data-test="session-query"]').element.value).toBe('')
    await wrapper.find('[data-test="session-query"]').setValue('zzz')
    expect(wrapper.find('[data-test="session-empty"]').text()).toBe('No sessions match the current filters')
  })

  it('resumes a conversation, or jumps to the pane it is open in', async () => {
    await make({ openIds: { 'bbbbbbbb-1111-4222-8333-444444444444': 'pane-7' }, cwd: null })
    await rows()[0].find('[data-test="session-resume"]').trigger('click')
    expect(wrapper.emitted('resume')).toEqual([[{ agent: 'gemini', id: 'cccccccc-1111-4222-8333-444444444444', cwd: 'D:\\other', title: 'Elsewhere' }]])
    await rows()[2].find('[data-test="session-jump"]').trigger('click')
    expect(wrapper.emitted('focus-pane')).toEqual([['pane-7']])
  })

  it('an Antigravity IDE conversation offers Continue in CLI and passes its origin, in the list and in search results', async () => {
    const IDE = { agent: 'antigravity', origin: 'ide', id: 'dddddddd-1111-4222-8333-444444444444', cwd: 'E:\ide', title: 'From the IDE', started: NOW - 5_000, updated: NOW - 5_000 }
    api.listSessions = vi.fn(() => Promise.resolve([...SESSIONS, IDE]))
    api.sessionSearch.status = vi.fn(() => Promise.resolve({ available: true, enabled: true, phase: 'current', filesDue: 0, sessions: 1, sizeBytes: 0 }))
    api.sessionSearch.search = vi.fn(() => Promise.resolve({ ok: true, hits: [{ agent: 'antigravity', sessionId: IDE.id, cwd: IDE.cwd, title: IDE.title, updatedAt: NOW, messageCount: 2 }] }))
    await make({ cwd: null })
    const row = rows().find((r) => r.attributes('data-session') === IDE.id)
    expect(row.find('[data-test="session-origin"]').text()).toBe('IDE')
    const button = row.find('[data-test="session-resume"]')
    expect(button.attributes('aria-label')).toContain('new Antigravity CLI conversation')
    await button.trigger('click')
    expect(wrapper.emitted('resume').at(-1)).toEqual([{ agent: 'antigravity', id: IDE.id, cwd: 'E:\ide', title: 'From the IDE', origin: 'ide' }])
    await wrapper.find('[data-test="session-query"]').setValue('ide')
    await new Promise((r) => setTimeout(r, 250))
    await flushPromises()
    const hit = rows().find((r) => r.attributes('data-session') === IDE.id)
    await hit.find('[data-test="session-resume"]').trigger('click')
    expect(wrapper.emitted('resume').at(-1)[0]).toMatchObject({ id: IDE.id, origin: 'ide' })
  })

  it('an Antigravity IDE conversation whose folder is unknown can still be continued in the CLI; another agent\'s cannot be resumed', async () => {
    const IDE = { agent: 'antigravity', origin: 'ide', id: 'eeeeeeee-1111-4222-8333-444444444444', cwd: '', title: 'No folder', started: NOW - 5_000, updated: NOW - 5_000 }
    const LOST = { agent: 'gemini', id: 'ffffffff-1111-4222-8333-444444444444', cwd: '', title: 'Lost', started: NOW - 6_000, updated: NOW - 6_000 }
    api.listSessions = vi.fn(() => Promise.resolve([IDE, LOST]))
    await make({ cwd: null })
    const row = rows().find((r) => r.attributes('data-session') === IDE.id)
    const button = row.find('[data-test="session-resume"]')
    expect(button.attributes('disabled')).toBeUndefined()
    expect(button.attributes('aria-label')).toContain('folder is unknown')
    await button.trigger('click')
    expect(wrapper.emitted('resume').at(-1)[0]).toMatchObject({ id: IDE.id, origin: 'ide' })
    const lost = rows().find((r) => r.attributes('data-session') === LOST.id)
    expect(lost.find('[data-test="session-resume"]').attributes('disabled')).toBeDefined()
  })

  it('expands a row: the first prompt, the latest turns, the folder, the sub-agents', async () => {
    await make()
    await rows()[0].find('[data-test="session-toggle"]').trigger('click')
    await flushPromises()
    expect(calls.find(([n]) => n === 'details')[1]).toEqual({ agent: 'claude', id: 'aaaaaaaa-1111-4222-8333-444444444444', accountId: null })
    const details = wrapper.find('[data-test="session-details"]')
    expect(details.find('[data-test="details-prompt"]').text()).toBe('Fix the build, please')
    expect(details.findAll('[data-test="details-turns"] .sh-card').map((c) => c.text())).toEqual(['YouFix the build, please', 'AgentFixed.'])
    expect(details.find('.sh-path').text()).toBe('C:\\proj')
    expect(details.find('[data-test="details-subagents"]').text()).toContain('Subagents (0)')
    expect(calls.find(([n]) => n === 'children')[1]).toMatchObject({ agent: 'claude', sessionId: 'aaaaaaaa-1111-4222-8333-444444444444' })
    expect(rows()[0].find('[data-test="session-meta"]').text()).toContain('2 msgs')
    await details.find('[data-test="details-copy-prompt"]').trigger('click')
    expect(api.writeClipboard).toHaveBeenCalledWith('Fix the build, please')
    expect(wrapper.emitted('toast').at(-1)).toEqual(['First prompt copied'])
    await details.find('[data-test="details-view-log"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('open-editor')).toEqual([['C:\\home\\.claude\\projects\\x\\a.jsonl']])
    // Clicking the row again folds it.
    await rows()[0].trigger('click')
    expect(wrapper.find('[data-test="session-details"]').exists()).toBe(false)
  })

  it('the action menu: copy the id, reveal the log, open the folder, delete after confirming', async () => {
    await make()
    await openMenu(rows()[0].find('[data-test="session-more"]'))
    expect(menuItem('menu-resume')).toBeTruthy()
    expect(menuItem('menu-delete').getAttribute('aria-disabled')).toBe(null)
    menuItem('menu-copy-id').click()
    expect(api.writeClipboard).toHaveBeenCalledWith('aaaaaaaa-1111-4222-8333-444444444444')
    expect(wrapper.emitted('toast').at(-1)).toEqual(['Session ID copied'])
    await openMenu(rows()[0].find('[data-test="session-more"]'))
    menuItem('menu-reveal-log').click()
    await flushPromises()
    expect(calls.find(([n]) => n === 'reveal')[1]).toMatchObject({ agent: 'claude' })
    await openMenu(rows()[0].find('[data-test="session-more"]'))
    menuItem('menu-open-cwd').click()
    await flushPromises()
    expect(calls.find(([n]) => n === 'openCwd')[1]).toBe('C:\\proj')
    await openMenu(rows()[0].find('[data-test="session-more"]'))
    menuItem('menu-delete').click()
    await flushPromises()
    expect(calls.find(([n]) => n === 'delete')[1]).toEqual({ agent: 'claude', id: 'aaaaaaaa-1111-4222-8333-444444444444', accountId: null })
    expect(wrapper.emitted('toast').at(-1)).toEqual(['Session deleted'])
    expect(calls.filter(([n]) => n === 'list')).toHaveLength(2) // read again
  })

  it('Delete is withheld for a conversation open in a pane and for Codex (with the reason)', async () => {
    await make({ cwd: null, openIds: { 'cccccccc-1111-4222-8333-444444444444': 'pane-1' } })
    await openMenu(rows()[0].find('[data-test="session-more"]'))
    expect(menuItem('menu-delete').getAttribute('aria-disabled')).toBe('true')
    expect(menuItem('menu-delete').getAttribute('title')).toContain('open in a pane')
    expect(menuItem('menu-jump')).toBeTruthy()
    await openMenu(rows()[2].find('[data-test="session-more"]'))
    expect(menuItem('menu-delete').getAttribute('title')).toBe("Codex sessions can't be deleted from Tessel.")
  })

  it('with the index off, a query offers to turn session search on; on, it searches what was said', async () => {
    vi.useFakeTimers({ now: NOW })
    await make()
    await wrapper.find('[data-test="session-query"]').setValue('build')
    expect(wrapper.find('[data-test="session-notice"]').text()).toContain('Find a conversation by what was said in it')
    api.sessionSearch.status.mockResolvedValue({ available: true, enabled: true, phase: 'current', filesDue: 0, sessions: 3, sizeBytes: 2048 })
    await wrapper.find('[data-test="session-enable-search"]').trigger('click')
    await flushPromises()
    vi.advanceTimersByTime(200)
    await flushPromises()
    const search = calls.filter(([n]) => n === 'search').at(-1)[1]
    expect(search).toMatchObject({ query: 'build', scope: { kind: 'folder', path: 'C:\\proj' }, agents: null })
    expect(wrapper.find('.sh-subtitle').text()).toBe('Indexed history')
    expect(wrapper.find('[data-test="session-bar"]').text()).toContain('1 result')
    const evidence = rows()[0].find('[data-test="session-evidence"]')
    expect(evidence.text()).toBe('Agent: the build is fixed')
    expect(evidence.find('mark').text()).toBe('build')
    expect(rows()[0].find('[data-test="session-meta"]').text()).toContain('4 msgs')
    vi.useRealTimers()
  })

  it('the view menu: an agent unticked hides its rows, the depth asks for more', async () => {
    await make({ cwd: null })
    await openMenu(wrapper.find('[data-test="session-view"]'))
    menuItem('agent-gemini').click()
    await nextTick()
    expect(titles()).toEqual(['Fix the build', 'Rename things'])
    expect(wrapper.find('.sh-view-count').text()).toBe('1')
    menuItem('depth').click()
    await nextTick()
    await nextTick()
    menuItem('depth-100').click()
    await flushPromises()
    expect(calls.filter(([n]) => n === 'list').at(-1)[1]).toEqual({ cwd: null, limit: 100 })
    expect(JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY))).toMatchObject({ limit: 100, agents: expect.not.arrayContaining(['gemini']) })
    await openMenu(wrapper.find('[data-test="session-view"]'))
    menuItem('reset-view').click()
    await flushPromises()
    expect(titles()).toHaveLength(3)
    expect(wrapper.find('.sh-view-count').exists()).toBe(false)
  })
})

describe('a project on an SSH host', () => {
  const REMOTE = { hostId: 'ssh-box', host: 'box', path: '/home/me/app' }
  const HOST_ROWS = [
    { agent: 'claude', id: 'dddddddd-1111-4222-8333-444444444444', cwd: '/home/me/app', title: 'On the server', started: null, updated: NOW - 60_000, host: 'ssh-box' },
    { agent: 'claude', id: 'eeeeeeee-1111-4222-8333-444444444444', cwd: '/home/me/other', title: 'Other folder there', started: null, updated: NOW - 120_000, host: 'ssh-box' }
  ]

  it("lists the host's own conversations, scoped to the project's folder there", async () => {
    api.listRemoteSessions = vi.fn(() => Promise.resolve({ ok: true, sessions: HOST_ROWS }))
    await make({ cwd: null, remote: REMOTE })
    expect(api.listRemoteSessions).toHaveBeenCalledWith({ hostId: 'ssh-box', limit: expect.any(Number) })
    expect(api.listSessions).not.toHaveBeenCalled()
    expect(titles()).toEqual(['On the server'])
  })

  it('says to connect when the host is not signed in (and never shows local sessions)', async () => {
    api.listRemoteSessions = vi.fn(() => Promise.resolve({ ok: false, notConnected: true, error: 'x' }))
    await make({ cwd: null, remote: REMOTE })
    expect(rows()).toHaveLength(0)
    expect(wrapper.find('.sh-error').text()).toContain('box')
  })
})
