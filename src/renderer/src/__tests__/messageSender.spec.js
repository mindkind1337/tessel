// The sender of a team message in the window: built from the sending pane
// (never from the message), recorded with the activity event, shown as one
// compact line with the details on hover, and older records still shown.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildSenderSnapshot, senderSummary, senderDetails } from '../senderIdentity'
import ActivityPanel from '../components/ActivityPanel.vue'
import NativeChatMessageRow from '../components/chat/orca/NativeChatMessageRow.vue'

const APP = readFileSync(join(__dirname, '..', 'App.vue'), 'utf8').replace(/\r\n/g, '\n')

const leaf = {
  id: 'pane-1',
  num: 1,
  paneName: 'Ada',
  title: 'Claude Code',
  agentId: 'claude',
  model: 'claude-opus-5-5',
  effort: 'high',
  sessionId: 'sess-1',
  accountId: 'acc-work',
  worktree: { path: 'C:\\Tessel-claude\\t2', branch: 'claude/t2' },
  team: 'team-1',
  // What the pane holds but must never be recorded.
  env: { ANTHROPIC_API_KEY: 'sk-ant-api03-secretsecretsecret' },
  token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
}

describe('sender snapshot (window)', () => {
  it('is built from the pane state and what Tessel knows around it', () => {
    const s = buildSenderSnapshot(leaf, {
      agentName: 'Claude Code',
      model: 'Opus 5.5 · high',
      branch: 'main',
      teamId: 'team-1',
      lead: true,
      card: { id: 'card-42', title: 'Sender identity' },
      now: 1000
    })
    expect(s).toMatchObject({
      paneId: 'pane-1',
      num: 1,
      name: 'Ada',
      agentId: 'claude',
      agentName: 'Claude Code',
      model: 'Opus 5.5 · high',
      modelId: 'claude-opus-5-5',
      effort: 'high',
      sessionId: 'sess-1',
      accountId: 'acc-work',
      host: 'local',
      worktree: 'C:\\Tessel-claude\\t2',
      branch: 'claude/t2', // its own copy's branch first
      teamId: 'team-1',
      lead: true,
      cardId: 'card-42',
      at: 1000
    })
    expect(JSON.stringify(s)).not.toMatch(/sk-ant|ghp_|ANTHROPIC/)
  })

  it('an SSH pane: its host label, user@host and remote folder', () => {
    const s = buildSenderSnapshot(
      { ...leaf, worktree: null, remoteHostId: 'ssh-box', remotePath: '/srv/app' },
      { agentName: 'Claude Code', host: { label: 'Build box', address: 'deploy@build.example.com:22' }, branch: 'main' }
    )
    expect(s).toMatchObject({ host: 'ssh', hostLabel: 'Build box', hostAddress: 'deploy@build.example.com:22', remotePath: '/srv/app', branch: 'main' })
    expect(senderSummary(s)).toBe('Ada · Claude Code · Build box · main')
  })

  it('a compact line and full details', () => {
    const s = buildSenderSnapshot(leaf, { agentName: 'Claude Code', model: 'Opus 5.5 · high', teamId: 'team-1', lead: true })
    expect(senderSummary(s)).toBe('Ada · Claude Code · Opus 5.5 high · local · claude/t2')
    const d = senderDetails({ ...s, tesselVersion: '1.13.2' })
    expect(d).toMatch(/Pane: #1 Ada \(pane-1\)/)
    expect(d).toMatch(/Model: Opus 5\.5 · high \(claude-opus-5-5\)/)
    expect(d).toMatch(/Session: sess-1/)
    expect(d).toMatch(/Team: team-1 \(lead\)/)
    expect(d).toMatch(/Tessel: 1\.13\.2/)
    expect(senderSummary(undefined)).toBe('')
    expect(senderDetails(null)).toBe('')
  })
})

describe('App.vue records the sender', () => {
  it('gives each poll the members\' snapshots, built from their panes', () => {
    expect(APP).toMatch(/function senderSnapshotOf\(leaf, team = null\)/)
    expect(APP).toMatch(/model: paneModels\[leaf\.id\] \|\| leaf\.headerModel/)
    // Every poll that hands messages out (the count-only one at launch aside).
    const polls = APP.match(/window\.shellApi\.channel\.poll\(\{[^}]*\}\)/g).filter((p) => !/availableIds: \[\]/.test(p))
    expect(polls.length).toBeGreaterThanOrEqual(2)
    for (const p of polls) expect(p).toMatch(/senders: channelSenders\(team\)/)
  })
  it('keeps it with the activity event and the chat message', () => {
    const log = APP.slice(APP.indexOf('function logTeamMessages'), APP.indexOf('function syncTeamBoard'))
    expect(log).toMatch(/cleanSender\(m\.sender\) \? \{ sender: cleanSender\(m\.sender\) \}/)
    const lm = APP.slice(APP.indexOf('function logMessage('), APP.indexOf('function flushPending'))
    expect(lm).toMatch(/meta\.sender \? \{ sender: meta\.sender \}/)
    const chats = APP.slice(APP.indexOf('async function pushToChats'), APP.indexOf('function acceptChatTeam'))
    expect(chats).toMatch(/\{ sender: cleanSender\(d\.sender\) \}/)
  })
})

describe('shown where team messages appear', () => {
  let prevApi
  beforeEach(() => {
    prevApi = window.shellApi
    window.shellApi = {}
  })
  afterEach(() => {
    window.shellApi = prevApi
    vi.restoreAllMocks()
  })

  const sender = buildSenderSnapshot(leaf, { agentName: 'Claude Code', model: 'Opus 5.5 · high', now: Date.now() })
  const event = (extra = {}) => ({
    t: Date.now() - 1000,
    type: 'message',
    msgId: 'm1',
    paneId: 'pane-2',
    agent: { title: 'Bob', agentId: 'codex' },
    status: 'unread',
    source: 'agent',
    from: 'Ada',
    scope: 'team-chat',
    preview: 'Can you review?',
    text: 'Can you review?',
    ...extra
  })

  it('the activity timeline: a sender line with details on hover', () => {
    const w = mount(ActivityPanel, { props: { events: [event({ sender })] } })
    const line = w.find('[data-test="act-sender"]')
    expect(line.exists()).toBe(true)
    expect(line.text()).toBe('Ada · Claude Code · Opus 5.5 high · local · claude/t2')
    expect(line.attributes('title')).toMatch(/Session: sess-1/)
    w.unmount()
  })

  it('the activity timeline: an agent reporting a card, with the model it ran with', () => {
    const report = { t: Date.now() - 500, type: 'task', action: 'reported', paneId: 'pane-1', agent: { title: 'Ada', agentId: 'claude' }, title: 'Fix the build', by: 'Ada', detail: 'succeeded', sender }
    const w = mount(ActivityPanel, { props: { events: [report] } })
    expect(w.find('[data-test="act-sender"]').text()).toBe('Ada · Claude Code · Opus 5.5 high · local · claude/t2')
    w.unmount()
  })

  it('App.vue records who reported a card, asked a decision or answered in its chat', () => {
    const report = APP.slice(APP.indexOf('function applyReport('), APP.indexOf('function askDecision('))
    expect(report).toMatch(/const reporter = senderSnapshotOf\(from/)
    expect(report.match(/reporter \? \{ sender: reporter \}/g).length).toBe(2)
    const gate = APP.slice(APP.indexOf('function askDecision('), APP.indexOf('function askDecision(') + 2500)
    expect(gate.match(/asker \? \{ sender: asker \}/g).length).toBe(2)
    const chat = APP.slice(APP.indexOf('function flushChatReplies('), APP.indexOf('function flushChatReplies(') + 1200)
    expect(chat).toMatch(/speaker \? \{ sender: speaker \}/)
  })

  it('the activity timeline: an older event without a sender still shows', () => {
    const w = mount(ActivityPanel, { props: { events: [event()] } })
    expect(w.text()).toMatch(/Ada/)
    expect(w.text()).toMatch(/Can you review\?/)
    expect(w.find('[data-test="act-sender"]').exists()).toBe(false)
    w.unmount()
  })

  const user = (extra = {}) => ({ id: 'u1', role: 'user', timestamp: 0, blocks: [{ type: 'text', text: 'build ok' }], ...extra })
  const row = (message) =>
    mount(NativeChatMessageRow, { props: { message, expandSignal: false, onScrollMessageToTop: vi.fn() }, global: { stubs: { transition: false } } })

  it('the chat card "From Ada (teammate)": the sender line and its details', () => {
    const w = row(user({ sentAs: 'team', from: 'Ada', sender }))
    expect(w.find('[data-test="nc-team-from"]').text()).toMatch(/^From Ada \(teammate\)\s*· Claude Code · Opus 5\.5 high · local · claude\/t2$/)
    expect(w.find('[data-test="nc-team-from"]').attributes('title')).toMatch(/Pane: #1 Ada/)
    w.unmount()
  })

  it('the chat card without a sender (older messages) is unchanged', () => {
    const w = row(user({ sentAs: 'team', from: 'Ada' }))
    expect(w.find('[data-test="nc-team-from"]').text()).toBe('From Ada (teammate)')
    expect(w.find('[data-test="nc-team-sender"]').exists()).toBe(false)
    expect(w.find('[data-test="nc-team-from"]').attributes('title')).toBeUndefined()
    w.unmount()
  })
})
