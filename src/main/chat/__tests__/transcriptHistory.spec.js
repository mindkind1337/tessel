// @vitest-environment node
// Synthetic transcripts only: no real agent folder, no real agent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  claudeHistoryEvents,
  codexHistoryEvents,
  findTranscript,
  readLastLines,
  readTranscriptHistory,
  transcriptHomeFor,
  HISTORY_LIMITS
} from '../transcriptHistory'

const CLAUDE_ID = '11111111-2222-4333-8444-555555555555'
// A UUID v7 made on 2025-01-15 (older than the 30 days scanned by date).
const CODEX_ID = '01946a2b-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const lines = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'
const ts = (s) => `2026-09-01T10:00:${String(s).padStart(2, '0')}.000Z`

let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-history-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function claudeHome(content, id = CLAUDE_ID) {
  const home = join(tmp, 'claude')
  fs.mkdirSync(join(home, 'projects', 'C--proj'), { recursive: true })
  fs.writeFileSync(join(home, 'projects', 'C--proj', `${id}.jsonl`), content)
  return home
}

function codexHome(content, id = CODEX_ID) {
  const home = join(tmp, 'codex')
  const dir = join(home, 'sessions', '2025', '01', '15')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, `rollout-2025-01-15T10-00-00-${id}.jsonl`), content)
  return home
}

const claudeRecords = [
  { type: 'summary', summary: 'x' },
  { type: 'user', uuid: 'u1', timestamp: ts(1), message: { role: 'user', content: 'Fix the bug' } },
  { type: 'assistant', uuid: 'a1', timestamp: ts(2), message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me look' }] } },
  { type: 'assistant', uuid: 'a2', timestamp: ts(3), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] } },
  { type: 'assistant', uuid: 'a3', timestamp: ts(4), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:\\x.js' } }] } },
  { type: 'user', uuid: 'u2', timestamp: ts(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file text' }] } },
  // A sub-agent's own line and injected context: not shown.
  { type: 'assistant', uuid: 's1', isSidechain: true, timestamp: ts(6), message: { id: 'sx', content: [{ type: 'text', text: 'child' }] } },
  { type: 'user', uuid: 'meta', isMeta: true, timestamp: ts(6), message: { content: 'Caveat: injected' } },
  { type: 'assistant', uuid: 'a4', timestamp: ts(7), message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] } },
  { type: 'user', uuid: 'u3', timestamp: ts(8), message: { content: '<command-name>/model</command-name><command-args>opus</command-args>' } },
  { type: 'user', uuid: 'u4', timestamp: ts(9), message: { content: '<local-command-stdout>Set model</local-command-stdout>' } },
  { type: 'user', uuid: 'u5', timestamp: ts(10), message: { content: 'Again' } },
  { type: 'assistant', uuid: 'a5', timestamp: ts(11), message: { id: 'm3', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'user', uuid: 'u6', timestamp: ts(12), message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }
]

describe('Claude transcript', () => {
  it('becomes the chat events in order, marked imported, with increasing times', () => {
    const events = claudeHistoryEvents(lines(claudeRecords).split('\n').filter(Boolean))
    expect(events.map((e) => e.type)).toEqual([
      'user', 'thinking', 'assistant', 'tool', 'toolResult', 'assistant', 'turnEnd',
      'user', 'turnEnd',
      'user', 'tool', 'tool', 'turnEnd'
    ])
    expect(events.every((e) => e.imported === true)).toBe(true)
    const ats = events.map((e) => e.at)
    expect(ats.every((a, i) => i === 0 || a >= ats[i - 1])).toBe(true)
    expect(events[0]).toMatchObject({ type: 'user', id: 'hist-u1', text: 'Fix the bug', status: 'accepted', at: Date.parse(ts(1)) })
    expect(events[1]).toMatchObject({ messageId: 'hist-m1', text: 'Let me look' })
    expect(events[3]).toMatchObject({ id: 'toolu_1', name: 'Read', input: { file_path: 'C:\\x.js' }, status: 'running' })
    expect(events[4]).toMatchObject({ id: 'toolu_1', text: 'file text', isError: false })
    expect(events[6]).toMatchObject({ status: 'completed', durationMs: 6000 })
    expect(events[7].text).toBe('/model opus')
    // An interrupted turn: its unanswered tool stopped, the turn interrupted.
    expect(events[11]).toEqual(expect.objectContaining({ type: 'tool', id: 'toolu_2', status: 'stopped' }))
    expect(events[12]).toMatchObject({ type: 'turnEnd', status: 'interrupted' })
    expect(JSON.stringify(events)).not.toContain('child')
    expect(JSON.stringify(events)).not.toContain('Caveat')
  })

  it('merges a message whose blocks came one per line', () => {
    const events = claudeHistoryEvents(
      [
        { type: 'user', uuid: 'u1', timestamp: ts(1), message: { content: 'hi' } },
        { type: 'assistant', uuid: 'a1', timestamp: ts(2), message: { id: 'm1', content: [{ type: 'text', text: 'one' }] } },
        { type: 'assistant', uuid: 'a2', timestamp: ts(3), message: { id: 'm1', content: [{ type: 'text', text: 'two' }] } }
      ].map((r) => JSON.stringify(r))
    )
    expect(events.filter((e) => e.type === 'assistant')).toEqual([expect.objectContaining({ text: 'one\n\ntwo', at: Date.parse(ts(2)) })])
  })

  it('reads it from the Claude folder, by id', () => {
    const home = claudeHome(lines(claudeRecords))
    const res = readTranscriptHistory({ agent: 'claude', sessionId: CLAUDE_ID, home })
    expect(res).toMatchObject({ ok: true, truncated: false })
    expect(res.events[0]).toMatchObject({ type: 'user', text: 'Fix the bug' })
  })

  it('skips a partial last line (being written)', () => {
    const home = claudeHome(lines(claudeRecords.slice(0, 2)) + '{"type":"assistant","message":{"id":"m9","content":[{"type":"te')
    const res = readTranscriptHistory({ agent: 'claude', sessionId: CLAUDE_ID, home })
    expect(res.ok).toBe(true)
    expect(res.events.map((e) => e.type)).toEqual(['user', 'turnEnd'])
  })

  it('keeps a whole last line with no newline yet', () => {
    const home = claudeHome(lines(claudeRecords.slice(0, 2)).trimEnd())
    expect(readTranscriptHistory({ agent: 'claude', sessionId: CLAUDE_ID, home }).events[0].text).toBe('Fix the bug')
  })

  it('refuses bad ids, a missing file, and a folder that is not absolute', () => {
    const home = claudeHome(lines(claudeRecords))
    for (const bad of ['../x', 'not-a-uuid', `${CLAUDE_ID}/..`, '', null, `..\\${CLAUDE_ID}`])
      expect(readTranscriptHistory({ agent: 'claude', sessionId: bad, home })).toEqual({ ok: false, code: 'invalid' })
    expect(readTranscriptHistory({ agent: 'gemini', sessionId: CLAUDE_ID, home })).toEqual({ ok: false, code: 'invalid' })
    expect(readTranscriptHistory({ agent: 'claude', sessionId: '99999999-2222-4333-8444-555555555555', home })).toEqual({ ok: false, code: 'missing' })
    expect(readTranscriptHistory({ agent: 'claude', sessionId: CLAUDE_ID, home: 'relative\\claude' })).toEqual({ ok: false, code: 'missing' })
    expect(readTranscriptHistory({ agent: 'claude', sessionId: CLAUDE_ID, home: join(tmp, 'nope') })).toEqual({ ok: false, code: 'missing' })
  })

  it('never reads through a link out of the folder', () => {
    const outside = join(tmp, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(join(outside, `${CLAUDE_ID}.jsonl`), lines(claudeRecords))
    const home = join(tmp, 'claude')
    fs.mkdirSync(join(home, 'projects'), { recursive: true })
    try {
      fs.symlinkSync(outside, join(home, 'projects', 'linked'), 'junction')
    } catch {
      return // links not allowed here
    }
    expect(findTranscript('claude', CLAUDE_ID, home)).toBeNull()
    expect(readTranscriptHistory({ agent: 'claude', sessionId: CLAUDE_ID, home })).toEqual({ ok: false, code: 'missing' })
  })

  it('reads at most the last bytes, and drops the line the window cut', () => {
    const many = []
    for (let i = 0; i < 400; i++) {
      many.push({ type: 'user', uuid: `u${i}`, timestamp: ts(i % 60), message: { content: `prompt ${i} ${'x'.repeat(100)}` } })
      many.push({ type: 'assistant', uuid: `a${i}`, timestamp: ts(i % 60), message: { id: `m${i}`, content: [{ type: 'text', text: `answer ${i}` }] } })
    }
    const home = claudeHome(lines(many))
    const limits = { ...HISTORY_LIMITS, bytes: 8 * 1024 }
    const res = readTranscriptHistory({ agent: 'claude', sessionId: CLAUDE_ID, home, limits })
    expect(res.ok).toBe(true)
    expect(res.truncated).toBe(true)
    // Only the end: the last prompt is there, the first is not.
    const texts = res.events.filter((e) => e.type === 'user').map((e) => e.text)
    expect(texts.at(-1)).toContain('prompt 399')
    expect(texts.some((t) => t.startsWith('prompt 0 '))).toBe(false)
    expect(JSON.stringify(res.events).length).toBeLessThan(20 * 1024)
  })

  it('keeps at most the last N events, and cuts long strings', () => {
    const many = [{ type: 'user', uuid: 'long', timestamp: ts(0), message: { content: 'y'.repeat(200 * 1024) } }]
    for (let i = 0; i < 50; i++) many.push({ type: 'user', uuid: `u${i}`, timestamp: ts(1), message: { content: `p${i}` } })
    const home = claudeHome(lines(many))
    const all = readTranscriptHistory({ agent: 'claude', sessionId: CLAUDE_ID, home })
    const long = all.events.find((e) => e.id === 'hist-long')
    expect(Buffer.byteLength(long.text)).toBeLessThan(HISTORY_LIMITS.text + 100)
    expect(long.text).toMatch(/more bytes\)$/)
    const res = readTranscriptHistory({ agent: 'claude', sessionId: CLAUDE_ID, home, limits: { ...HISTORY_LIMITS, events: 10 } })
    expect(res.events).toHaveLength(10)
    expect(res.truncated).toBe(true)
    expect(res.events.at(-1)).toMatchObject({ type: 'turnEnd' })
    expect(res.events.at(-2)).toMatchObject({ type: 'user', text: 'p49' })
  })
})

describe('Codex rollout', () => {
  const codexRecords = [
    { timestamp: ts(0), type: 'session_meta', payload: { id: CODEX_ID, instructions: 'secret instructions', cwd: 'C:\\p' } },
    { timestamp: ts(1), type: 'turn_context', payload: { model: 'gpt-5', cwd: 'C:\\p' } },
    { timestamp: ts(1), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List files' }] } },
    { timestamp: ts(1), type: 'event_msg', payload: { type: 'user_message', message: 'List files' } },
    { timestamp: ts(2), type: 'response_item', payload: { type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'Thinking about it' }] } },
    { timestamp: ts(2), type: 'event_msg', payload: { type: 'agent_reasoning', text: 'Thinking about it' } },
    { timestamp: ts(3), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'call_1', arguments: '{"command":["ls"]}' } },
    { timestamp: ts(4), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: '{"output":"a.txt","metadata":{"exit_code":1}}' } },
    // A sub-agent's line in the parent's file: skipped.
    { timestamp: ts(4), type: 'event_msg', payload: { type: 'agent_message', message: 'child says', thread_id: '0194aaaa-0000-7000-8000-000000000000' } },
    { timestamp: ts(5), type: 'event_msg', payload: { type: 'agent_message', message: 'Here: a.txt' } },
    { timestamp: ts(5), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Here: a.txt' }] } },
    { timestamp: ts(6), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
    { timestamp: ts(7), type: 'event_msg', payload: { type: 'user_message', message: 'Stop' } },
    { timestamp: ts(8), type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }
  ]

  it('becomes the chat events, once each, without context or another thread', () => {
    const events = codexHistoryEvents(codexRecords.map((r) => JSON.stringify(r)), CODEX_ID)
    expect(events.map((e) => e.type)).toEqual(['user', 'thinking', 'tool', 'toolResult', 'assistant', 'turnEnd', 'user', 'turnEnd'])
    expect(events[0]).toMatchObject({ text: 'List files', status: 'accepted' })
    expect(events[2]).toMatchObject({ id: 'call_1', name: 'shell', input: { command: ['ls'] }, summary: 'ls' })
    expect(events[3]).toMatchObject({ id: 'call_1', text: 'a.txt', isError: true })
    expect(events[4]).toMatchObject({ text: 'Here: a.txt' })
    expect(events[7]).toMatchObject({ status: 'interrupted' })
    const all = JSON.stringify(events)
    for (const hidden of ['child says', 'environment_context', 'secret instructions', 'gpt-5']) expect(all).not.toContain(hidden)
  })

  it('uses completed items when the rollout has them (no response copies)', () => {
    const events = codexHistoryEvents(
      [
        { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'model copy' }] } },
        { timestamp: ts(1), type: 'event_msg', payload: { type: 'item_completed', thread_id: CODEX_ID, item: { type: 'UserMessage', id: 'um1', content: [{ type: 'text', text: 'Visible prompt' }] } } },
        { timestamp: ts(2), type: 'event_msg', payload: { type: 'item_completed', thread_id: CODEX_ID, item: { type: 'AgentMessage', id: 'am1', content: [{ type: 'Text', text: 'Visible answer' }] } } },
        { timestamp: ts(2), type: 'event_msg', payload: { type: 'item_completed', thread_id: 'other-thread-id', item: { type: 'AgentMessage', id: 'am2', content: [{ type: 'Text', text: 'child' }] } } }
      ].map((r) => JSON.stringify(r)),
      CODEX_ID
    )
    expect(events.map((e) => [e.type, e.text])).toEqual([
      ['user', 'Visible prompt'],
      ['assistant', 'Visible answer'],
      ['turnEnd', undefined]
    ])
  })

  it('reads the oldest rollouts (no envelope)', () => {
    const events = codexHistoryEvents(
      [
        { id: CODEX_ID, timestamp: ts(0), instructions: null },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Early prompt' }] },
        { type: 'message', id: 'x1', role: 'assistant', content: [{ type: 'output_text', text: 'Early answer' }] }
      ].map((r) => JSON.stringify(r)),
      CODEX_ID
    )
    expect(events.map((e) => e.type)).toEqual(['user', 'assistant', 'turnEnd'])
  })

  it('finds the rollout by the thread id, on the day it was made', () => {
    const home = codexHome(lines(codexRecords))
    const res = readTranscriptHistory({ agent: 'codex', sessionId: CODEX_ID, home, now: Date.parse('2026-09-29T00:00:00Z') })
    expect(res).toMatchObject({ ok: true, truncated: false })
    expect(res.events[0]).toMatchObject({ type: 'user', text: 'List files' })
    expect(readTranscriptHistory({ agent: 'codex', sessionId: '0194ffff-c3d4-7e5f-8a9b-0c1d2e3f4a5b', home })).toEqual({ ok: false, code: 'missing' })
    expect(readTranscriptHistory({ agent: 'codex', sessionId: '../sessions', home })).toEqual({ ok: false, code: 'invalid' })
  })
})

describe('readLastLines', () => {
  it('returns null for a missing file', () => {
    expect(readLastLines(join(tmp, 'none.jsonl'), 1024)).toBeNull()
  })
})

describe('transcriptHomeFor', () => {
  const systemClaude = 'C:\\Users\\u\\.claude'
  const systemCodex = 'C:\\Users\\u\\.codex'
  const codexAccountsBase = 'C:\\Users\\u\\AppData\\Roaming\\Tessel\\codex-accounts'
  const opts = { systemClaude, systemCodex, codexAccountsBase }

  it('the system folders by default', () => {
    expect(transcriptHomeFor('claude', {}, opts)).toBe(systemClaude)
    expect(transcriptHomeFor('codex', {}, opts)).toBe(systemCodex)
  })

  it('a managed Codex account home, never another folder', () => {
    const acct = `${codexAccountsBase}\\abc\\home`
    expect(transcriptHomeFor('codex', { codex_home: acct }, opts)).toBe(acct)
    expect(transcriptHomeFor('codex', { CODEX_HOME: 'C:\\elsewhere' }, opts)).toBeNull()
    expect(transcriptHomeFor('codex', { CODEX_HOME: `${codexAccountsBase}\\..\\x` }, opts)).toBeNull()
  })

  it('Claude: only the system folder', () => {
    expect(transcriptHomeFor('claude', { CLAUDE_CONFIG_DIR: 'C:\\elsewhere' }, opts)).toBeNull()
    expect(transcriptHomeFor('claude', { CLAUDE_CONFIG_DIR: systemClaude.toUpperCase() }, opts)).toBe(process.platform === 'win32' ? systemClaude : null)
    expect(transcriptHomeFor('other', {}, opts)).toBeNull()
  })
})
