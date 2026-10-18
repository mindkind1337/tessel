// The Conversations tab (ConversationsPanel.vue): threads from the activity
// log, the scope, period, agent and notices filters, the search, folding,
// the copy, and going to an agent's pane.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ConversationsPanel from '../components/ConversationsPanel.vue'
import { setSelectValue } from './selectTestUtils'

const NOW = new Date(2026, 9, 10, 15, 0, 0).getTime()
const MIN = 60 * 1000
const H = 60 * MIN
const ada = { title: 'Ada', agentId: 'claude' }
const bob = { title: 'Bob', agentId: 'codex' }
const msg = (ago, paneId, agent, extra = {}) => ({ t: NOW - ago, type: 'message', paneId, agent, status: 'sent', source: 'you', scope: 'workspace', wsId: 'ws1', ...extra })
const reply = (ago, paneId, agent, extra = {}) => ({ t: NOW - ago, type: 'reply', paneId, agent, kind: 'chat', wsId: 'ws1', ...extra })

const events = () => [
  msg(50 * MIN, 'p1', ada, { scope: 'chat', text: 'Please add the tab' }),
  reply(49 * MIN, 'p1', ada, { text: 'Done: the tab is there.' }),
  msg(40 * MIN, 'p2', bob, { source: 'agent', from: 'Ada', scope: 'team-chat', status: 'unread', teamId: 'team1', text: 'Can you review the API?' }),
  msg(39 * MIN, 'p1', ada, { source: 'tessel', scope: 'team-change', teamId: 'team1', text: '[Tessel] Bob joined your team.' }),
  reply(30 * MIN, 'p2', bob, { kind: 'decision', teamId: 'team1', taskTitle: 'Ship it', text: 'Merge now or wait?' }),
  msg(3 * 24 * H, 'p1', ada, { text: 'Three days ago' }),
  msg(10 * MIN, 'p9', { title: 'Zed', agentId: 'gemini' }, { wsId: 'ws2', text: 'Elsewhere' })
]
const projects = [{ id: 'ws1', name: 'proj', panes: [{ id: 'p1', kind: 'agent', agentId: 'claude', title: 'Ada', state: 'idle' }] }]
const teams = [{ id: 'team1', name: 'Team 2', color: '#aabbcc' }]

const make = (props = {}) => mount(ConversationsPanel, { props: { events: events(), teams, projects, workspaceId: 'ws1', now: NOW, active: true, ...props }, attachTo: document.body })
const threadKeys = (w) => w.findAll('[data-test^="cv-thread-"]').map((x) => x.attributes('data-test').slice('cv-thread-'.length))
const texts = (w) => w.findAll('[data-test="cv-text"]').map((x) => x.text())

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ConversationsPanel.vue', () => {
  it('shows this workspace, the last 7 days, latest thread first and its messages in the order said, notices left out', () => {
    const w = make()
    expect(threadKeys(w)).toEqual(['you:p2', 'team:team1', 'you:p1'])
    expect(w.find('[data-test="cv-thread-team:team1"] .sh-group-label').text()).toBe('Team "Team 2"')
    expect(w.find('[data-test="cv-thread-you:p1"] .sh-group-label').text()).toBe('You and Ada')
    // A thread's lines run newest first: a new message appears at the top.
    expect(texts(w)).toEqual(['Merge now or wait?', 'Can you review the API?', 'Done: the tab is there.', 'Please add the tab', 'Three days ago'])
    expect(w.find('[data-test="cv-count"]').text()).toBe('3 conversations · 5 messages')
    // A decision asked of you, a message not read yet: said.
    const notes = w.findAll('[data-test="cv-note"]').map((x) => x.text())
    expect(notes).toEqual(['asks you to decide · on "Ship it"', 'not read yet'])
    // Between agents: from and to; your bubbles carry no name (they are the
    // blue ones on the right); an agent's name is above its bubble.
    const team = w.find('[data-test="cv-thread-team:team1"]')
    expect(team.find('[data-test="cv-from"]').text()).toBe('Ada · Claude Code')
    expect(team.find('[data-test="cv-to"]').text()).toBe('Bob')
    const ada1 = w.find('[data-test="cv-thread-you:p1"]')
    expect(ada1.findAll('[data-test="cv-line"]')[1].classes()).toContain('from-you')
    expect(ada1.findAll('[data-test="cv-line"]')[1].find('[data-test="cv-from"]').exists()).toBe(false)
    expect(ada1.findAll('[data-test="cv-line"]')[0].classes()).toContain('from-agent')
    expect(ada1.findAll('[data-test="cv-line"]')[0].find('[data-test="cv-from"]').text()).toBe('Ada · Claude Code')
    expect(ada1.findAll('[data-test="cv-line"]')[0].find('[data-test="cv-to"]').exists()).toBe(false)
    // The sender's logo beside its name, also for a team message whose
    // sender is known by name only (Ada's pane is p1, a Claude Code).
    expect(team.find('[data-test="cv-from"] [data-test="cv-logo"]').exists()).toBe(true)
    expect(team.find('[data-test="cv-from"] [data-test="cv-program"]').text()).toBe('· Claude Code')
    expect(ada1.findAll('[data-test="cv-line"]')[0].find('[data-test="cv-logo"]').exists()).toBe(true)
    // Each agent's name has a color of its own.
    const color = (el) => el.attributes('style')
    expect(color(team.find('[data-test="cv-from"]'))).toMatch(/color:/)
    expect(color(team.find('[data-test="cv-from"]'))).not.toBe(color(team.find('[data-test="cv-to"]')))
    w.unmount()
  })

  it('scope, period and notices', async () => {
    const w = make()
    await w.find('[data-test="cv-scope-all"]').trigger('click')
    expect(threadKeys(w)).toEqual(['you:p9', 'you:p2', 'team:team1', 'you:p1'])
    await w.find('[data-test="cv-scope-workspace"]').trigger('click')
    await setSelectValue(w.find('[data-test="cv-period"]'), '24h')
    expect(texts(w)).not.toContain('Three days ago')
    await setSelectValue(w.find('[data-test="cv-period"]'), '30d')
    expect(texts(w)).toContain('Three days ago')
    // Tessel notices: a chip that is on or off (no checkbox).
    expect(w.find('[data-test="cv-notices"]').element.tagName).toBe('BUTTON')
    await w.find('[data-test="cv-notices"]').trigger('click')
    expect(w.find('[data-test="cv-notices"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-test="cv-thread-team:team1"]').findAll('[data-test="cv-text"]').map((x) => x.text())).toEqual(['Bob joined your team.', 'Can you review the API?'])
    expect(w.find('[data-test="cv-thread-team:team1"]').findAll('[data-test="cv-from"]')[0].text()).toBe('Tessel')
    w.unmount()
  })

  it('an agent filter and a search keep what matches', async () => {
    const w = make()
    await setSelectValue(w.find('[data-test="cv-participant"]'), 'Bob')
    expect(threadKeys(w)).toEqual(['you:p2', 'team:team1'])
    await setSelectValue(w.find('[data-test="cv-participant"]'), '')
    await w.find('[data-test="cv-search"]').setValue('review')
    expect(threadKeys(w)).toEqual(['team:team1'])
    expect(texts(w)).toEqual(['Can you review the API?'])
    await w.find('[data-test="cv-search"]').setValue('nothing like this')
    expect(w.find('[data-test="cv-none"]').exists()).toBe(true)
    await w.find('[data-test="cv-search-clear"]').trigger('click')
    expect(threadKeys(w)).toHaveLength(3)
    w.unmount()
  })

  it('a message to the whole team is one bubble naming every recipient', () => {
    const carl = { title: 'Carl', agentId: 'gemini' }
    const team = (paneId, agent, status) => msg(20 * MIN, paneId, agent, { source: 'agent', from: 'Ada', fromPaneId: 'p1', fromAgentId: 'claude', scope: 'team-chat', status, teamId: 'team1', text: 'Standup in 5' })
    const w = make({ events: [team('p2', bob, 'read'), team('p3', carl, 'unread')] })
    const thread = w.find('[data-test="cv-thread-team:team1"]')
    expect(thread.findAll('[data-test="cv-line"]')).toHaveLength(1)
    expect(thread.findAll('[data-test="cv-to"]').map((x) => x.text())).toEqual(['Bob', 'Carl'])
    expect(thread.find('[data-test="cv-note"]').text()).toBe('read by 1 of 2')
    w.unmount()
  })

  it("one speaker's messages to different people: each bubble names its recipients", () => {
    const carl = { title: 'Carl', agentId: 'gemini' }
    const said = (ago, paneId, agent, text) => msg(ago, paneId, agent, { source: 'agent', from: 'Ada', fromPaneId: 'p1', fromAgentId: 'claude', scope: 'team-chat', status: 'read', teamId: 'team1', text })
    // Ada to Bob, then to Carl a minute later, then to Carl again (shown
    // newest first): Bob's and Carl's bubbles each say who they went to;
    // Carl's two share one head, above the newer of them.
    const w = make({ events: [said(20 * MIN, 'p2', bob, 'Bob: the API'), said(19 * MIN, 'p3', carl, 'Carl: the docs'), said(18 * MIN, 'p3', carl, 'Carl: and the tests')] })
    const lines = w.find('[data-test="cv-thread-team:team1"]').findAll('[data-test="cv-line"]')
    expect(lines.map((l) => l.find('[data-test="cv-text"]').text())).toEqual(['Carl: and the tests', 'Carl: the docs', 'Bob: the API'])
    expect(lines[0].findAll('[data-test="cv-to"]').map((x) => x.text())).toEqual(['Carl'])
    expect(lines[1].find('[data-test="cv-to"]').exists()).toBe(false)
    expect(lines[2].findAll('[data-test="cv-to"]').map((x) => x.text())).toEqual(['Bob'])
    expect(lines.map((l) => l.classes().find((c) => c.startsWith('shape-')))).toEqual(['shape-first', 'shape-last', 'shape-single'])
    w.unmount()
  })

  it('empty: says what shows up here, in one short sentence', () => {
    const w = make({ events: [] })
    expect(w.find('[data-test="cv-empty"]').text()).toBe('Nothing said yet. Team messages and your chats with agents show up here.')
    expect(w.find('[data-test="cv-count"]').text()).toBe('0 conversations · 0 messages')
    w.unmount()
  })

  it('a thread folds; an open pane is reached from its agent name; a long text opens; a group shares corners', async () => {
    const long = 'word '.repeat(100).trim()
    const w = make({ events: [...events(), reply(1 * MIN, 'p1', ada, { text: long })] })
    const ada1 = () => w.find('[data-test="cv-thread-you:p1"]')
    await w.find('[data-test="cv-toggle-you:p1"]').trigger('click')
    expect(ada1().findAll('[data-test="cv-line"]')).toHaveLength(0)
    await w.find('[data-test="cv-toggle-you:p1"]').trigger('click')
    expect(ada1().findAll('[data-test="cv-line"]')).toHaveLength(4)
    // Ada's pane is open: her name is a button; Bob's is not.
    await ada1().findAll('[data-test="cv-line"]')[1].find('[data-test="cv-from"]').trigger('click')
    expect(w.emitted('focus-pane')).toEqual([['p1']])
    expect(w.find('[data-test="cv-thread-you:p2"] [data-test="cv-from"]').element.tagName).toBe('SPAN')
    const longLine = ada1().findAll('[data-test="cv-line"]')[0]
    expect(longLine.find('[data-test="cv-text"]').classes()).toContain('clamp4')
    await longLine.find('.cv-more').trigger('click')
    expect(longLine.find('[data-test="cv-text"]').classes()).not.toContain('clamp4')
    // Two of your messages a minute apart: one group (first, last); Ada's
    // two replies are an hour apart: single each, with her avatar beside both.
    const shapes = ada1().findAll('[data-test="cv-line"]').map((l) => l.classes().find((c) => c.startsWith('shape-')))
    expect(shapes).toEqual(['shape-single', 'shape-single', 'shape-single', 'shape-single'])
    expect(ada1().findAll('.cv-avatar svg, .cv-avatar img, .cv-avatar span').length).toBeGreaterThan(0)
    w.unmount()
  })

  it('a long thread shows its latest lines, the newest at the top, Show earlier below them', async () => {
    const many = Array.from({ length: 35 }, (_, i) => msg((100 - i) * MIN, 'p1', ada, { text: `m${i}` }))
    const w = make({ events: many })
    expect(w.findAll('[data-test="cv-line"]')).toHaveLength(30)
    expect(texts(w)[0]).toBe('m34')
    expect(texts(w)[29]).toBe('m5')
    const lines = w.find('.cv-lines').element.children
    expect(lines[lines.length - 1].getAttribute('data-test')).toBe('cv-earlier-you:p1')
    expect(w.find('[data-test="cv-earlier-you:p1"]').text()).toBe('Show the 5 earlier messages')
    await w.find('[data-test="cv-earlier-you:p1"]').trigger('click')
    expect(w.findAll('[data-test="cv-line"]')).toHaveLength(35)
    expect(w.find('[data-test="cv-earlier-you:p1"]').exists()).toBe(false)
    expect(texts(w)[34]).toBe('m0')
    w.unmount()
  })

  it('copies a thread as text and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const w = make()
    await w.find('[data-test="cv-copy-you:p2"]').trigger('click')
    await nextTick()
    expect(writeText).toHaveBeenCalledTimes(1)
    const text = writeText.mock.calls[0][0]
    expect(text.startsWith('You and Bob\n\n[')).toBe(true)
    expect(text).toContain('Bob → You (asks you to decide, on "Ship it"):\nMerge now or wait?')
    expect(w.emitted('toast')).toEqual([['Conversation copied']])
    w.unmount()
  })

  it('hidden, the threads stay as they were; shown again, they follow the log', async () => {
    const list = events()
    const w = make({ events: list })
    expect(texts(w)).toHaveLength(5)
    await w.setProps({ active: false })
    await w.setProps({ events: [...list, msg(1 * MIN, 'p1', ada, { text: 'Later' })] })
    expect(texts(w)).toHaveLength(5)
    await w.setProps({ active: true })
    expect(texts(w)).toHaveLength(6)
    w.unmount()
  })

  it('a message arriving later appears above the others, and the copy stays oldest first', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const list = events()
    const w = make({ events: list })
    const ada1 = () => w.find('[data-test="cv-thread-you:p1"]')
    const said = () => ada1().findAll('[data-test="cv-text"]').map((x) => x.text())
    expect(said()).toEqual(['Done: the tab is there.', 'Please add the tab', 'Three days ago'])
    await w.setProps({ events: [...list, msg(1 * MIN, 'p1', ada, { text: 'Later' })] })
    expect(said()).toEqual(['Later', 'Done: the tab is there.', 'Please add the tab', 'Three days ago'])
    // The stamp heads the newest message of each hour-wide gap: one above the
    // recent cluster, one more above "Three days ago" below it.
    const children = [...ada1().find('.cv-lines').element.children]
    expect(children[0].getAttribute('data-test')).toBe('cv-stamp')
    expect(children.filter((c) => c.getAttribute('data-test') === 'cv-stamp')).toHaveLength(2)
    // A transcript still reads oldest first.
    await w.find('[data-test="cv-copy-you:p1"]').trigger('click')
    await nextTick()
    const text = writeText.mock.calls[0][0]
    expect(text.indexOf('Three days ago')).toBeLessThan(text.indexOf('Please add the tab'))
    expect(text.indexOf('Please add the tab')).toBeLessThan(text.indexOf('Later'))
    w.unmount()
  })
})
