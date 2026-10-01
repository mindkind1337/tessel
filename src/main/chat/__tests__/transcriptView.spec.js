// @vitest-environment node
// Synthetic session files only: no real agent folder, no real agent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  contextUsageEvent,
  createTail,
  createTranscriptViews,
  reportedTranscript,
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
    expect(readTranscriptView({ agent: 'gemini', sessionId: OC_ID, roots })).toEqual({ ok: false, code: 'invalid' })
    expect(readTranscriptView({ agent: 'claude', sessionId: 'not-a-uuid-at-all', roots })).toEqual({ ok: false, code: 'invalid' })
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

  it('registers its channels (the IPC guard is global)', async () => {
    grokFile(GROK_SESSION)
    const { views } = setup()
    const handlers = {}
    views.register({ handle: (name, fn) => (handlers[name] = fn) })
    expect(Object.keys(handlers).sort()).toEqual(['transcriptView:close', 'transcriptView:earlier', 'transcriptView:open'])
    expect(await handlers['transcriptView:earlier']({}, { viewId: 'tv-999' })).toEqual({ ok: false, code: 'missing' })
    const res = await handlers['transcriptView:open']({}, { agent: 'grok', sessionId: GROK_ID, path: 'C:\\Windows\\win.ini' })
    expect(res.ok).toBe(true)
    expect(await handlers['transcriptView:close']({}, { viewId: res.viewId })).toEqual({ ok: true })
  })
})

describe('transcript view: Claude Code and Codex (the pane account folder)', () => {
  const CL_ID = '22222222-3333-4444-8555-666666666666'
  const OTHER_FILE_ID = '99999999-3333-4444-8555-666666666666'
  const CX_ID = '0199aabb-ccdd-7eef-8000-0000000000aa'
  let home
  beforeEach(() => {
    home = join(tmp, 'claude-account')
  })
  function claudeFile(content, name = CL_ID) {
    const dir = join(home, 'projects', 'C--proj')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(join(dir, `${name}.jsonl`), content)
    return join(dir, `${name}.jsonl`)
  }
  const claudeTurn = (text, s) => ({ type: 'user', uuid: `u-${s}`, timestamp: ts(s), message: { role: 'user', content: text } })

  it('finds the file in the given folder by id, or the path its hooks reported (inside that folder only)', () => {
    const byId = claudeFile(lines([claudeTurn('by id', 1)]))
    expect(findTranscriptViewFile('claude', CL_ID, roots, { home })).toBe(byId)
    // Newer Claude Code: a file named with another UUID, named by its hooks.
    const named = claudeFile(lines([claudeTurn('named', 1)]), OTHER_FILE_ID)
    expect(findTranscriptViewFile('claude', CL_ID, roots, { home, reported: named })).toBe(named)
    // Outside the folder, not a .jsonl, or no folder at all: not taken.
    const outside = join(tmp, 'elsewhere.jsonl')
    fs.writeFileSync(outside, lines([claudeTurn('secret', 1)]))
    expect(findTranscriptViewFile('claude', CL_ID, roots, { home, reported: outside })).toBe(byId)
    expect(findTranscriptViewFile('claude', CL_ID, roots, { home: null, reported: named })).toBeNull()
    expect(readTranscriptView({ agent: 'claude', sessionId: CL_ID, roots, home: null })).toEqual({ ok: false, code: 'missing' })
  })

  it('Codex: its rollout in the account CODEX_HOME, its own thread only', () => {
    const codexHome = join(tmp, 'codex-account')
    const now = new Date()
    const day = join(codexHome, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    fs.mkdirSync(day, { recursive: true })
    const file = join(day, `rollout-2026-09-01T10-00-00-${CX_ID}.jsonl`)
    fs.writeFileSync(
      file,
      lines([
        { type: 'event_msg', timestamp: ts(1), payload: { type: 'user_message', message: 'Fix it' } },
        { type: 'event_msg', timestamp: ts(2), payload: { type: 'agent_message', message: 'Fixed.' } },
        { type: 'event_msg', timestamp: ts(3), payload: { type: 'task_complete' } }
      ])
    )
    const res = readTranscriptView({ agent: 'codex', sessionId: CX_ID, roots, home: codexHome })
    expect(res.ok).toBe(true)
    expect(res.events.filter((e) => e.type === 'user').map((e) => e.text)).toEqual(['Fix it'])
    expect(res.events.filter((e) => e.type === 'assistant').map((e) => e.text)).toEqual(['Fixed.'])
  })

  it('the window names a pane and an account, never a folder: the home is resolved in main, the hook report checked', async () => {
    const named = claudeFile(lines([claudeTurn('from the reported file', 1)]), OTHER_FILE_ID)
    const sessions = join(tmp, 'sessions')
    fs.mkdirSync(sessions, { recursive: true })
    fs.writeFileSync(join(sessions, 'pane-7.json'), JSON.stringify({ agent: 'claude', sessionId: CL_ID, transcriptPath: named }))
    expect(reportedTranscript(sessions, 'pane-7', 'claude', CL_ID)).toBe(named)
    expect(reportedTranscript(sessions, 'pane-7', 'claude', OTHER_FILE_ID)).toBeNull()
    expect(reportedTranscript(sessions, '../pane-7', 'claude', CL_ID)).toBeNull()
    const homes = vi.fn(async () => home)
    const views = createTranscriptViews({ send: vi.fn(), roots: () => roots, homes, sessionsDir: () => sessions, watch: () => ({ close() {}, on() {} }) })
    const res = await views.openFromWindow({ agent: 'claude', sessionId: CL_ID, paneId: 'pane-7', accountId: 'acc-1', home: 'C:\Windows' })
    expect(homes).toHaveBeenCalledWith('claude', 'acc-1')
    expect(res.ok).toBe(true)
    expect(res.events.find((e) => e.type === 'user').text).toBe('from the reported file')
    // No account folder: nothing read.
    const none = createTranscriptViews({ send: vi.fn(), roots: () => roots, homes: async () => null, sessionsDir: () => sessions })
    expect(await none.openFromWindow({ agent: 'claude', sessionId: CL_ID, paneId: 'pane-7' })).toEqual({ ok: false, code: 'missing' })
    views.closeAll()
  })
})

describe('transcript view: the context the latest answer read', () => {
  const str = (r) => JSON.stringify(r)
  it('Claude Code / OpenClaude: the newest main-thread answer (input + cache), not a sub-agent', () => {
    const file = [
      str({ type: 'assistant', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      str({ type: 'assistant', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 50 } } }),
      str({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 99999 } } }),
      str({ type: 'user', message: { content: 'usage' } })
    ]
    expect(contextUsageEvent('claude', file)).toEqual({ type: 'contextUsage', usedTokens: 2105, windowTokens: null })
    expect(contextUsageEvent('openclaude', file).usedTokens).toBe(2105)
    expect(contextUsageEvent('claude', [str({ type: 'user', message: { content: 'x' } })])).toBeNull()
    expect(contextUsageEvent('grok', file)).toBeNull()
  })
  it('Codex: its newest token_count, in the model window', () => {
    const file = [
      str({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 1000 }, model_context_window: 272000 } } }),
      str({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 3000, output_tokens: 200 }, model_context_window: 272000 } } }),
      str({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
      'not json "token_count"'
    ]
    expect(contextUsageEvent('codex', file)).toEqual({ type: 'contextUsage', usedTokens: 3200, windowTokens: 272000 })
  })
})

describe('transcript view: incremental reads', () => {
  const file = () => join(tmp, 'tail.jsonl')
  it('reads only what was added, waits for a line being written, and starts again when the file shrinks', () => {
    fs.writeFileSync(file(), '{"a":1}\n{"b":2}\n{"c":')
    const tail = createTail(file(), 1024)
    expect(tail.read()).toBe(true)
    expect(tail.lines()).toEqual(['{"a":1}', '{"b":2}'])
    expect(tail.read()).toBe(false)
    fs.appendFileSync(file(), '3}\r\n{"d":4}\n')
    expect(tail.read()).toBe(true)
    expect(tail.lines()).toEqual(['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}'])
    fs.writeFileSync(file(), '{"new":1}\n')
    expect(tail.read()).toBe(true)
    expect(tail.lines()).toEqual(['{"new":1}'])
    expect(tail.cut()).toBe(false)
  })

  it('keeps the last bytes only (a cut first line is dropped), and a large addition reads only its end', () => {
    fs.writeFileSync(file(), Array.from({ length: 10 }, (_, i) => `{"n":${i}}`).join('\n') + '\n')
    const tail = createTail(file(), 40)
    tail.read()
    expect(tail.cut()).toBe(true)
    expect(tail.lines().at(-1)).toBe('{"n":9}')
    expect(tail.lines().every((l) => l.startsWith('{"n":'))).toBe(true)
    expect(tail.lines().join('\n').length).toBeLessThanOrEqual(40)
    fs.appendFileSync(file(), Array.from({ length: 20 }, (_, i) => `{"m":${i}}`).join('\n') + '\n')
    tail.read()
    expect(tail.lines().at(-1)).toBe('{"m":19}')
    expect(tail.lines().join('\n').length).toBeLessThanOrEqual(40)
  })

  it('a missing file reads as null', () => {
    expect(createTail(join(tmp, 'nope.jsonl'), 1024).read()).toBeNull()
  })
})

describe('transcript view: earlier lines (scrolled up)', () => {
  const file = () => join(tmp, 'tail.jsonl')
  const rows = (n, key = 'n') => Array.from({ length: n }, (_, i) => `{"${key}":${String(i).padStart(2, '0')}}`)

  it('reads whole lines just before the kept ones, bounded, until the start of the file', () => {
    fs.writeFileSync(file(), rows(20).join('\n') + '\n')
    // Each line is 9 bytes with its newline: 4 lines kept, 3 windows of 20 bytes at most.
    const tail = createTail(file(), 36, { maxEarlier: 60 })
    tail.read()
    const all = rows(20)
    // Always whole lines, the file's last ones, one after the other.
    const contiguous = () => expect(tail.lines()).toEqual(all.slice(all.length - tail.lines().length))
    contiguous()
    expect(tail.more()).toBe(true)
    let before = tail.lines().length
    let res
    let steps = 0
    do {
      res = tail.readEarlier(20)
      contiguous()
      expect(tail.lines().length).toBe(before + res.added)
      before = tail.lines().length
      steps++
    } while (res.more && steps < 10)
    expect(steps).toBeGreaterThan(1)
    // Bounded: 60 more bytes at most (9 per line).
    expect(tail.lines().join('\n').length).toBeLessThanOrEqual(36 + 60)
    expect(tail.lines().length).toBeLessThan(all.length)
    expect(tail.readEarlier(20)).toEqual({ added: 0, more: false })
    // New lines are still read, and the earlier ones kept.
    const kept = tail.lines().slice()
    fs.appendFileSync(file(), '{"x":1}\n')
    expect(tail.read()).toBe(true)
    expect(tail.lines()).toEqual([...kept, '{"x":1}'])
  })

  it('reaches the first line, with blank lines and CRLF ends kept in place', () => {
    fs.writeFileSync(file(), '{"a":1}\r\n\n{"b":2}\n\n\n{"c":3}\n{"d":4}\n')
    const tail = createTail(file(), 17, { maxEarlier: 1000 })
    tail.read()
    expect(tail.lines()).toEqual(['{"c":3}', '{"d":4}'])
    expect(tail.readEarlier(10)).toEqual({ added: 1, more: true })
    expect(tail.lines()).toEqual(['{"b":2}', '{"c":3}', '{"d":4}'])
    expect(tail.readEarlier(1000)).toEqual({ added: 1, more: false })
    expect(tail.lines()).toEqual(['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}'])
    expect(tail.cut()).toBe(false)
    expect(tail.readEarlier(1000)).toEqual({ added: 0, more: false })
  })

  it('a line longer than the window is never cut, and a replaced file is not read from', () => {
    fs.writeFileSync(file(), `{"long":"${'x'.repeat(100)}"}\n{"a":1}\n`)
    const tail = createTail(file(), 9, { maxEarlier: 1000 })
    tail.read()
    expect(tail.lines()).toEqual(['{"a":1}'])
    expect(tail.readEarlier(20)).toEqual({ added: 0, more: false })
    expect(tail.lines()).toEqual(['{"a":1}'])
    fs.writeFileSync(file(), rows(10).join('\n') + '\n')
    const other = createTail(file(), 18, { maxEarlier: 1000 })
    other.read()
    fs.rmSync(file())
    fs.writeFileSync(file(), rows(10, 'z').join('\n') + '\n')
    expect(other.readEarlier(100)).toBeNull()
  })

  it('a view loads earlier lines on request and says when there are more', () => {
    const many = [{ type: 'system', content: 'You are Grok.' }]
    for (let i = 0; i < 40; i++) many.push({ type: 'user', id: `u${i}`, timestamp: ts(i % 60), content: [{ type: 'text', text: `prompt ${i}` }] })
    grokFile(lines(many))
    const limits = { bytes: 900, events: 2000, text: 64 * 1024 }
    const views = createTranscriptViews({ send: vi.fn(), roots: () => roots, watch: () => ({ close() {}, on() {} }), limits })
    const opened = views.open({ agent: 'grok', sessionId: GROK_ID })
    expect(opened.ok).toBe(true)
    expect(opened.more).toBe(true)
    const shown = opened.events.filter((e) => e.type === 'user').length
    const res = views.earlier(opened.viewId)
    expect(res).toMatchObject({ ok: true })
    expect(res.added).toBeGreaterThan(0)
    expect(res.events.filter((e) => e.type === 'user').length).toBeGreaterThan(shown)
    expect(res.events.filter((e) => e.type === 'user').at(-1).text).toBe('prompt 39')
    expect(views.earlier('tv-nope')).toEqual({ ok: false, code: 'missing' })
    views.closeAll()
  })

  it("Claude Code: its background tasks and its folder come with the view", () => {
    const at = (n) => new Date(Date.now() - 60000 + n * 1000).toISOString()
    const records = [
      { type: 'user', cwd: join(tmp, 'proj'), timestamp: at(1), message: { role: 'user', content: 'start a server' } },
      { type: 'assistant', timestamp: at(2), message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm run dev', description: 'Start the dev server', run_in_background: true } }] } },
      { type: 'user', timestamp: at(3), toolUseResult: { backgroundTaskId: 'b123abc' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Command running in background with ID: b123abc.' }] } }
    ]
    openclaudeFile(lines(records))
    const views = createTranscriptViews({ send: vi.fn(), roots: () => roots, watch: () => ({ close() {}, on() {} }) })
    const opened = views.open({ agent: 'openclaude', sessionId: OC_ID })
    expect(opened.background).toEqual([{ id: 'b123abc', kind: 'command', description: 'Start the dev server', startedAt: Date.parse(records[1].timestamp) }])
    expect(views.cwdOf(opened.viewId)).toBe(join(tmp, 'proj'))
    expect(views.agentOf(opened.viewId)).toBe('openclaude')
    expect(views.cwdOf('tv-nope')).toBeNull()
    views.closeAll()
  })
})
