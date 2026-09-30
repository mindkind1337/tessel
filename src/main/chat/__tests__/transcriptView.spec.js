// @vitest-environment node
// Synthetic session files only: no real agent folder, no real agent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  createTranscriptViews,
  findTranscriptViewFile,
  grokViewEvents,
  ompViewEvents,
  readTranscriptView,
  transcriptViewRoots,
  validViewId
} from '../transcriptView'

const GROK_ID = 'a1b2c3d4-0000-4000-8000-000000000001'
const OMP_ID = '0199aabb-ccdd-7eef-8000-000000000002'
const OC_ID = '11111111-2222-4333-8444-555555555555'
const lines = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'
const ts = (s) => `2026-09-01T10:00:${String(s).padStart(2, '0')}.000Z`

let tmp
let roots
beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tview-'))
  roots = transcriptViewRoots(tmp, {})
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function grokFile(content, id = GROK_ID) {
  const dir = join(roots.grok, encodeURIComponent('C:\\proj'), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, 'chat_history.jsonl'), content)
  return join(dir, 'chat_history.jsonl')
}
function ompFile(content, id = OMP_ID) {
  const dir = join(roots.omp, '-C-proj')
  fs.mkdirSync(dir, { recursive: true })
  const file = join(dir, `2026-09-01T10-00-00-000Z_${id}.jsonl`)
  fs.writeFileSync(file, content)
  return file
}
function openclaudeFile(content, id = OC_ID) {
  const dir = join(roots.openclaude, 'projects', 'C--proj')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, `${id}.jsonl`), content)
  return join(dir, `${id}.jsonl`)
}

const GROK_SESSION = lines([
  { type: 'system', content: 'You are Grok.' },
  { type: 'user', content: [{ type: 'text', text: '<user_info>os: windows</user_info>\n<git_status>clean</git_status>' }] },
  { type: 'user', id: 'u1', timestamp: ts(1), content: [{ type: 'text', text: '<user_query>List the files</user_query>' }] },
  { type: 'reasoning', id: 'r1', timestamp: ts(2), summary: [{ text: 'Use ls.' }] },
  { type: 'assistant', id: 'a1', timestamp: ts(3), content: 'Listing.', tool_calls: [{ id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }] },
  { type: 'tool_result', tool_call_id: 'call-1', timestamp: ts(4), content: 'a.js\nb.js' },
  { type: 'assistant', id: 'a2', timestamp: ts(5), content: [{ type: 'text', text: 'Two files.' }] },
  { type: 'user', id: 'u2', timestamp: ts(6), synthetic_reason: 'auto_continue', content: 'continue' }
])

describe('transcript view: where and which files', () => {
  it('ids are checked: no path, no separator, a UUID for OpenClaude', () => {
    expect(validViewId('grok', GROK_ID)).toBe(true)
    expect(validViewId('grok', '../../etc')).toBe(false)
    expect(validViewId('grok', 'a/b/c/d/e')).toBe(false)
    expect(validViewId('openclaude', 'not-a-uuid-at-all')).toBe(false)
    expect(validViewId('openclaude', OC_ID)).toBe(true)
    expect(readTranscriptView({ agent: 'claude', sessionId: OC_ID, roots })).toEqual({ ok: false, code: 'invalid' })
    expect(readTranscriptView({ agent: 'grok', sessionId: '..\\x', roots })).toEqual({ ok: false, code: 'invalid' })
  })

  it('finds each agent\'s file inside its own folder only', () => {
    const g = grokFile(GROK_SESSION)
    const o = ompFile(lines([]))
    const c = openclaudeFile(lines([]))
    expect(findTranscriptViewFile('grok', GROK_ID, roots)).toBe(g)
    expect(findTranscriptViewFile('omp', OMP_ID, roots)).toBe(o)
    expect(findTranscriptViewFile('openclaude', OC_ID, roots)).toBe(c)
    expect(findTranscriptViewFile('grok', 'another-session-id', roots)).toBeNull()
  })

  it("OMP: a session's task sub-agent files (its own sub-folder) are never taken for it", () => {
    const dir = join(roots.omp, '-C-proj', `2026-09-01T10-00-00-000Z_${OMP_ID}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(join(dir, `task_${OMP_ID}.jsonl`), lines([]))
    expect(findTranscriptViewFile('omp', OMP_ID, roots)).toBeNull()
  })

  it('a session folder that links outside the agent folder is not read', () => {
    const outside = join(tmp, 'outside', GROK_ID)
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(join(outside, 'chat_history.jsonl'), GROK_SESSION)
    const group = join(roots.grok, 'group')
    fs.mkdirSync(group, { recursive: true })
    try {
      fs.symlinkSync(outside, join(group, GROK_ID), 'junction')
    } catch {
      return // no links on this system: nothing to check
    }
    expect(findTranscriptViewFile('grok', GROK_ID, roots)).toBeNull()
  })
})

describe('transcript view: lines to chat events', () => {
  it('Grok: prompts (not its bootstrap context nor synthetic rows), reasoning, answers, tools and results', () => {
    grokFile(GROK_SESSION)
    const res = readTranscriptView({ agent: 'grok', sessionId: GROK_ID, roots })
    expect(res.ok).toBe(true)
    const kinds = res.events.map((e) => e.type)
    expect(kinds).toEqual(['user', 'thinking', 'assistant', 'tool', 'toolResult', 'assistant', 'turnEnd'])
    expect(res.events[0].text).toBe('List the files')
    expect(res.events[3]).toMatchObject({ type: 'tool', id: 'call-1', name: 'bash', input: { command: 'ls' } })
    expect(res.events[4]).toMatchObject({ type: 'toolResult', id: 'call-1', text: 'a.js\nb.js', isError: false })
    expect(res.events.every((e) => e.imported)).toBe(true)
  })

  it('Grok: a result without a call id goes to the oldest open call', () => {
    const events = grokViewEvents(
      lines([
        { type: 'user', content: 'go' },
        { type: 'backend_tool_call', kind: { tool_type: 'web_search', query: 'x' } },
        { type: 'tool_result', content: 'found', is_error: true }
      ]).trim().split('\n')
    )
    const tool = events.find((e) => e.type === 'tool' && e.name === 'web_search')
    expect(events.find((e) => e.type === 'toolResult')).toMatchObject({ id: tool.id, isError: true, text: 'found' })
  })

  it('OMP: messages, thinking, tool calls with their results, command cells; bookkeeping skipped; an abort ends the turn', () => {
    const events = ompViewEvents(
      lines([
        { type: 'session_init', cwd: 'C:\\proj' },
        { type: 'message', id: 'm1', timestamp: ts(1), message: { role: 'user', content: 'Fix it' } },
        { type: 'message', id: 'm2', timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Look first.' }, { type: 'text', text: 'Reading.' }, { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'a.js' } }] } },
        { type: 'message', id: 'm3', timestamp: ts(3), message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'code' }] } },
        { type: 'message', id: 'm4', timestamp: ts(4), message: { role: 'bashExecution', command: 'npm test', output: 'fail', exitCode: 1 } },
        { type: 'custom_message', display: true, content: 'extension note' },
        { type: 'message', id: 'm5', timestamp: ts(5), message: { role: 'assistant', content: [], stopReason: 'aborted' } }
      ]).trim().split('\n')
    )
    expect(events.map((e) => e.type)).toEqual(['user', 'thinking', 'assistant', 'tool', 'toolResult', 'tool', 'toolResult', 'turnEnd'])
    expect(events[4]).toMatchObject({ id: 'tc1', text: 'code' })
    expect(events[5]).toMatchObject({ name: 'bash', input: 'npm test' })
    expect(events[6]).toMatchObject({ isError: true, text: 'fail' })
    expect(events.at(-1)).toMatchObject({ type: 'turnEnd', status: 'interrupted' })
  })

  it("OpenClaude: Claude Code's own format", () => {
    openclaudeFile(
      lines([
        { type: 'user', uuid: 'u1', timestamp: ts(1), message: { role: 'user', content: 'Hello' } },
        { type: 'assistant', uuid: 'a1', timestamp: ts(2), message: { id: 'msg1', role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] } }
      ])
    )
    const res = readTranscriptView({ agent: 'openclaude', sessionId: OC_ID, roots })
    expect(res.events.map((e) => [e.type, e.text])).toEqual([
      ['user', 'Hello'],
      ['assistant', 'Hi.'],
      ['turnEnd', undefined]
    ])
  })
})

describe('transcript view: live while open', () => {
  function setup(extra = {}) {
    const send = vi.fn()
    let onChange = null
    const watcher = { close: vi.fn(), on: vi.fn() }
    const watch = vi.fn((file, opts, cb) => {
      onChange = cb
      return watcher
    })
    const views = createTranscriptViews({ send, roots: () => roots, watch, debounceMs: 50, ...extra })
    return { views, send, watch, watcher, change: () => onChange && onChange() }
  }

  it('sends the conversation again after the agent writes (at most one read per burst); closed, nothing more', async () => {
    vi.useFakeTimers()
    const file = grokFile(GROK_SESSION)
    const { views, send, watcher, change } = setup()
    const opened = views.open({ agent: 'grok', sessionId: GROK_ID })
    expect(opened).toMatchObject({ ok: true, viewId: expect.any(String) })
    expect(opened.events.length).toBeGreaterThan(0)
    fs.appendFileSync(file, lines([{ type: 'user', id: 'u3', timestamp: ts(9), content: 'next' }]))
    change()
    change()
    change()
    await vi.advanceTimersByTimeAsync(60)
    expect(send).toHaveBeenCalledTimes(1)
    const [channel, payload] = send.mock.calls[0]
    expect(channel).toBe('transcriptView:event')
    expect(payload).toMatchObject({ viewId: opened.viewId, ok: true })
    expect(payload.events.filter((e) => e.type === 'user').map((e) => e.text)).toEqual(['List the files', 'next'])
    // Nothing changed on disk: nothing sent.
    change()
    await vi.advanceTimersByTimeAsync(60)
    expect(send).toHaveBeenCalledTimes(1)
    expect(views.close(opened.viewId)).toBe(true)
    expect(watcher.close).toHaveBeenCalled()
    fs.appendFileSync(file, lines([{ type: 'user', timestamp: ts(10), content: 'later' }]))
    change()
    await vi.advanceTimersByTimeAsync(60)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a missing file or a bad id opens nothing; at most 8 views, the oldest gives way', () => {
    grokFile(GROK_SESSION)
    const { views } = setup()
    expect(views.open({ agent: 'grok', sessionId: 'nope-not-there' })).toEqual({ ok: false, code: 'missing' })
    expect(views.open({ agent: 'grok', sessionId: '../x' })).toEqual({ ok: false, code: 'invalid' })
    const ids = Array.from({ length: 10 }, () => views.open({ agent: 'grok', sessionId: GROK_ID }).viewId)
    expect(views.count()).toBe(8)
    expect(views.close(ids[0])).toBe(false)
    expect(views.close(ids[9])).toBe(true)
  })

  it('where watching fails, a slow poll takes over (and stops with the view)', async () => {
    vi.useFakeTimers()
    const file = grokFile(GROK_SESSION)
    const send = vi.fn()
    const views = createTranscriptViews({
      send,
      roots: () => roots,
      watch: () => {
        throw new Error('no watch')
      },
      debounceMs: 10,
      pollMs: 100
    })
    const { viewId } = views.open({ agent: 'grok', sessionId: GROK_ID })
    fs.appendFileSync(file, lines([{ type: 'user', timestamp: ts(9), content: 'polled' }]))
    await vi.advanceTimersByTimeAsync(150)
    expect(send).toHaveBeenCalledTimes(1)
    views.close(viewId)
    fs.appendFileSync(file, lines([{ type: 'user', timestamp: ts(10), content: 'after' }]))
    await vi.advanceTimersByTimeAsync(500)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('registers its two channels (the IPC guard is global)', async () => {
    grokFile(GROK_SESSION)
    const { views } = setup()
    const handlers = {}
    views.register({ handle: (name, fn) => (handlers[name] = fn) })
    expect(Object.keys(handlers).sort()).toEqual(['transcriptView:close', 'transcriptView:open'])
    const res = await handlers['transcriptView:open']({}, { agent: 'grok', sessionId: GROK_ID, path: 'C:\\Windows\\win.ini' })
    expect(res.ok).toBe(true)
    expect(await handlers['transcriptView:close']({}, { viewId: res.viewId })).toEqual({ ok: true })
  })
})
