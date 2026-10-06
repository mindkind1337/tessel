// @vitest-environment node
// Job cost and model of a terminal agent on an SSH host: its conversation
// file is read over the host's connection (a fake readAgentFile here, never
// a server), bounded and throttled; never this PC's files.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createUsageFileCache } from '../jobCostUsage'
import { createJobCost } from '../jobCost'
import { createRemoteModelReader, remoteAgentModel } from '../remoteAgentModel'

const HOST = 'ssh-box1'
const S1 = '11111111-1111-4111-8111-111111111111'
const CX = '33333333-3333-4333-8333-333333333333'
const T0 = Date.parse('2026-10-01T10:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const claudeLine = ({ id, at, model = 'claude-opus-4-8', input = 10, output = 20 }) =>
  JSON.stringify({ type: 'assistant', timestamp: iso(at), requestId: `req-${id}`, uuid: `${id}-u`, message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
const estimate = ({ model, inputTokens, outputTokens }) => (/opus/.test(model || '') ? { usd: (inputTokens + outputTokens) / 1e6, known: true } : { usd: null, known: false })

// A host file as readAgentFile answers it: { ok, size, mtimeMs, data }.
function hostFile() {
  const files = new Map() // `${agent}/${id}` -> { text, mtimeMs }
  const readAgentFile = vi.fn(async (hostId, { agent, id, offset, cap, sub }) => {
    const f = files.get(sub ? `${agent}/${id}/${sub}` : `${agent}/${id}`)
    if (hostId !== HOST || !f) return { ok: false, missing: true, error: 'missing' }
    const buf = Buffer.from(f.text)
    const data = offset === null ? buf.subarray(Math.max(0, buf.length - cap)) : buf.subarray(Math.min(offset, buf.length), Math.min(offset + cap, buf.length))
    return { ok: true, size: buf.length, mtimeMs: f.mtimeMs, data }
  })
  // A Claude session's sub-agent transcripts as listSubagentFiles answers.
  const listSubagentFiles = vi.fn(async (hostId, { id, limit }) => {
    if (hostId !== HOST || !files.has(`claude/${id}`)) return { ok: false, missing: true, error: 'missing' }
    const out = []
    for (const [k, f] of files) if (k.startsWith(`claude/${id}/`)) out.push({ name: k.slice(`claude/${id}/`.length), size: Buffer.byteLength(f.text), mtimeMs: f.mtimeMs })
    return { ok: true, files: out.slice(0, limit) }
  })
  return {
    readAgentFile,
    listSubagentFiles,
    set: (agent, id, text, mtimeMs = 1000) => files.set(`${agent}/${id}`, { text, mtimeMs }),
    add: (agent, id, text) => {
      const f = files.get(`${agent}/${id}`)
      f.text += text
      f.mtimeMs += 1000
    }
  }
}

describe('usage cache: a file on a host', () => {
  it('reads it in bounded requests, then only what was added; at most once per gap', async () => {
    let t = 0
    const host = hostFile()
    host.set('claude', S1, [claudeLine({ id: 'm1', at: T0 }), claudeLine({ id: 'm2', at: T0 + 1 })].join('\n') + '\n')
    const cache = createUsageFileCache({ now: () => t })
    const reader = (q) => host.readAgentFile(HOST, { agent: 'claude', id: S1, ...q })
    const r = await cache.readRemote('k', 'claude', reader, { bytes: 1e9 }, { minGapMs: 5000 })
    expect(r.events).toHaveLength(2)
    expect(r.done).toBe(true)
    expect(host.readAgentFile.mock.calls[0][1]).toMatchObject({ offset: 0 })
    const size = Buffer.byteLength([claudeLine({ id: 'm1', at: T0 }), claudeLine({ id: 'm2', at: T0 + 1 })].join('\n') + '\n')
    // Within the gap: no request.
    const calls = host.readAgentFile.mock.calls.length
    host.add('claude', S1, claudeLine({ id: 'm3', at: T0 + 2 }) + '\n')
    expect((await cache.readRemote('k', 'claude', reader, { bytes: 1e9 }, { minGapMs: 5000 })).events).toHaveLength(2)
    expect(host.readAgentFile.mock.calls.length).toBe(calls)
    t += 6000
    const r2 = await cache.readRemote('k', 'claude', reader, { bytes: 1e9 }, { minGapMs: 5000 })
    expect(r2.events).toHaveLength(3)
    expect(host.readAgentFile.mock.calls.at(-1)[1]).toMatchObject({ offset: size })
  })

  it('a budget cut goes on next time; a missing file is null; one request at a time', async () => {
    let t = 0
    const host = hostFile()
    host.set('claude', S1, [claudeLine({ id: 'm1', at: T0 }), claudeLine({ id: 'm2', at: T0 + 1 })].join('\n') + '\n')
    const cache = createUsageFileCache({ now: () => t })
    const reader = (q) => host.readAgentFile(HOST, { agent: 'claude', id: S1, ...q })
    const r = await cache.readRemote('k', 'claude', reader, { bytes: 100 }, { minGapMs: 0 })
    expect(r.done).toBe(false)
    expect(host.readAgentFile.mock.calls[0][1].cap).toBe(100)
    t += 1
    const all = await cache.readRemote('k', 'claude', reader, { bytes: 1e9 }, { minGapMs: 0 })
    expect(all.done).toBe(true)
    expect(all.events).toHaveLength(2)
    const missing = (q) => host.readAgentFile(HOST, { agent: 'claude', id: CX, ...q })
    expect(await cache.readRemote('m', 'claude', missing, { bytes: 1e9 })).toBe(null)
    const slow = vi.fn(() => new Promise((res) => setTimeout(() => res({ ok: true, size: 0, mtimeMs: 0, data: Buffer.alloc(0) }), 5)))
    const [a, b] = await Promise.all([cache.readRemote('s', 'claude', slow), cache.readRemote('s', 'claude', slow)])
    expect(a).toEqual(b)
    expect(slow).toHaveBeenCalledTimes(1)
  })
})

describe('job cost of a terminal agent on a host', () => {
  let dir, userData, sessions
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'jobcost-remote-'))
    userData = join(dir, 'userData')
    sessions = join(dir, 'sessions')
    fs.mkdirSync(userData, { recursive: true })
    fs.mkdirSync(sessions, { recursive: true })
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const report = (paneId, agent, sessionId) => fs.writeFileSync(join(sessions, `${paneId}.json`), JSON.stringify({ agent, sessionId, at: T0 }))

  it('reads the pane session from the host, remembers the host after the pane closed, never this PC', async () => {
    const host = hostFile()
    host.set('claude', S1, [claudeLine({ id: 'm1', at: T0 + 1000, input: 100, output: 50 })].join('\n') + '\n')
    report('pane-r', 'claude', S1)
    let paneHost = HOST
    const homes = vi.fn(async () => [])
    let t = T0 + 3600000
    const jc = createJobCost({ userDataDir: userData, sessionsDir: () => sessions, homes, estimate, now: () => t, pollMs: 0, remotePollMs: 0, hostOfPane: () => paneHost, readAgentFile: host.readAgentFile })
    const p = (await jc.forPanes(['pane-r']))['pane-r']
    expect(p).toMatchObject({ status: 'ok', inputTokens: 100, outputTokens: 50, agent: 'claude', sessionId: S1 })
    expect(homes).not.toHaveBeenCalled()
    expect(jc.sessionsOf('pane-r').at(-1).hostId).toBe(HOST)
    // The pane closed: its card still finds the host file.
    paneHost = null
    t += 10000
    fs.writeFileSync(join(userData, 'task-board.json'), JSON.stringify({ tasks: [{ id: 'card1', column: 'done', paneId: 'pane-r', workPeriods: [{ start: T0, end: T0 + 7200000, paneId: 'pane-r' }] }] }))
    const c = (await jc.forCards(['card1'])).card1
    expect(c).toMatchObject({ status: 'ok', inputTokens: 100, outputTokens: 50 })
    expect(host.readAgentFile.mock.calls.every(([h]) => h === HOST)).toBe(true)
    await jc.close()
  })

  it("a Claude session's sub-agents on the host count too; an unchanged one is not read again", async () => {
    const host = hostFile()
    host.set('claude', S1, claudeLine({ id: 'm1', at: T0 + 1000, input: 100, output: 50 }) + '\n')
    host.set('claude', `${S1}/agent-a1`, claudeLine({ id: 's1', at: T0 + 2000, input: 7, output: 3 }) + '\n')
    host.set('claude', `${S1}/agent-b2`, claudeLine({ id: 's2', at: T0 + 3000, input: 1, output: 1 }) + '\n')
    report('pane-s', 'claude', S1)
    let t = T0 + 3600000
    const jc = createJobCost({ userDataDir: userData, sessionsDir: () => sessions, estimate, now: () => t, pollMs: 0, remotePollMs: 0, hostOfPane: () => HOST, readAgentFile: host.readAgentFile, listSubagentFiles: host.listSubagentFiles })
    expect((await jc.forPanes(['pane-s']))['pane-s']).toMatchObject({ status: 'ok', inputTokens: 108, outputTokens: 54 })
    expect(host.listSubagentFiles).toHaveBeenCalledWith(HOST, { id: S1, limit: 50 })
    const subReads = () => host.readAgentFile.mock.calls.filter(([, q]) => q.sub).map(([, q]) => q.sub)
    expect(subReads().sort()).toEqual(['agent-a1', 'agent-b2'])
    // Later: one sub-agent wrote more, the other did not; only it is read.
    host.add('claude', `${S1}/agent-a1`, claudeLine({ id: 's3', at: T0 + 4000, input: 2, output: 2 }) + '\n')
    t += 6000
    expect((await jc.forPanes(['pane-s']))['pane-s']).toMatchObject({ inputTokens: 110, outputTokens: 56 })
    expect(subReads().sort()).toEqual(['agent-a1', 'agent-a1', 'agent-b2'])
    expect(host.listSubagentFiles).toHaveBeenCalledTimes(2)
    // Within the gap: neither listed nor read again.
    await jc.forPanes(['pane-s'])
    expect(host.listSubagentFiles).toHaveBeenCalledTimes(2)
    await jc.close()
    // No listing wired: the session's own file only.
    const plain = createJobCost({ userDataDir: userData, sessionsDir: () => sessions, estimate, now: () => t, pollMs: 0, remotePollMs: 0, hostOfPane: () => HOST, readAgentFile: host.readAgentFile })
    expect((await plain.forPanes(['pane-s']))['pane-s']).toMatchObject({ inputTokens: 100, outputTokens: 50 })
    await plain.close()
  })

  it('a change on the host is told (polled only while asked about); no reader: unavailable', async () => {
    const host = hostFile()
    host.set('codex', CX, JSON.stringify({ timestamp: iso(T0), type: 'turn_context', payload: { model: 'gpt-5.5' } }) + '\n')
    report('pane-c', 'codex', CX)
    let t = T0
    const send = vi.fn()
    const jc = createJobCost({ userDataDir: userData, sessionsDir: () => sessions, estimate, now: () => t, pollMs: 0, remotePollMs: 0, debounceMs: 0, send, hostOfPane: () => HOST, readAgentFile: host.readAgentFile })
    await jc.forPanes(['pane-c'])
    t += 6000
    await jc.pollRemote() // first look: its stamp
    host.add('codex', CX, JSON.stringify({ timestamp: iso(T0 + 1), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 6 }, last_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 6 } } } }) + '\n')
    t += 6000
    await jc.pollRemote()
    await new Promise((r) => setTimeout(r, 5))
    expect(send).toHaveBeenCalledWith('jobCost:changed', {})
    // Not asked about for a while: no more requests.
    const calls = host.readAgentFile.mock.calls.length
    t += 10 * 60 * 1000
    await jc.pollRemote()
    expect(host.readAgentFile.mock.calls.length).toBe(calls)
    await jc.close()

    const none = createJobCost({ userDataDir: userData, sessionsDir: () => sessions, estimate, now: () => t, pollMs: 0, remotePollMs: 0, hostOfPane: () => HOST })
    expect((await none.forPanes(['pane-c']))['pane-c']).toMatchObject({ status: 'unavailable', reason: 'remote' })
    await none.close()
  })
})

describe('model of a terminal agent on a host', () => {
  const answer = (model, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: iso(T0), message: { model, content: [] }, ...extra })

  it('its latest answer, read once then only what was added, at most once per gap', async () => {
    let t = 0
    const host = hostFile()
    host.set('claude', S1, answer('claude-opus-5-5', { effort: 'high' }) + '\n')
    const reader = createRemoteModelReader({ readAgentFile: host.readAgentFile, now: () => t, minGapMs: 5000 })
    expect(await reader.read({ hostId: HOST, agent: 'claude', sessionId: S1 })).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(host.readAgentFile.mock.calls[0][1]).toMatchObject({ offset: null })
    host.add('claude', S1, answer('claude-fable-5-1') + '\n')
    expect((await reader.read({ hostId: HOST, agent: 'claude', sessionId: S1 })).model).toBe('claude-opus-5-5')
    expect(host.readAgentFile).toHaveBeenCalledTimes(1)
    t += 6000
    expect((await reader.read({ hostId: HOST, agent: 'claude', sessionId: S1 })).model).toBe('claude-fable-5-1')
    expect(host.readAgentFile.mock.calls[1][1].offset).toBeGreaterThan(0)
    // Nothing new: only the size asked for, the same answer.
    t += 6000
    expect((await reader.read({ hostId: HOST, agent: 'claude', sessionId: S1 })).model).toBe('claude-fable-5-1')
    expect(host.readAgentFile.mock.calls[2][1].offset).toBe(host.readAgentFile.mock.calls[1][1].offset + Buffer.byteLength(answer('claude-fable-5-1') + '\n'))
    // Bad input: never asked.
    expect(await reader.read({ hostId: 'C:\\x', agent: 'claude', sessionId: S1 })).toBe(null)
    expect(await reader.read({ hostId: HOST, agent: 'grok', sessionId: S1 })).toBe(null)
    expect(await reader.read({ hostId: HOST, agent: 'claude', sessionId: '../x' })).toBe(null)
    expect(host.readAgentFile).toHaveBeenCalledTimes(3)
  })

  it('the header answer: the session, else --model, never local settings; the chosen effort', async () => {
    const host = hostFile()
    host.set('codex', CX, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'medium' } }) + '\n')
    const reader = createRemoteModelReader({ readAgentFile: host.readAgentFile })
    expect(await remoteAgentModel({ agentId: 'codex', sessionId: CX, remoteHostId: HOST }, reader)).toEqual({ model: 'gpt-5.5', effort: 'medium', source: 'session' })
    expect(await remoteAgentModel({ agentId: 'claude', sessionId: S1, remoteHostId: HOST, command: 'claude --model opus --effort low' }, reader)).toEqual({ model: 'opus', effort: 'low', source: 'command' })
    expect(await remoteAgentModel({ agentId: 'claude', sessionId: S1, remoteHostId: HOST, command: 'claude' }, reader)).toBe(null)
    expect(await remoteAgentModel({ agentId: 'claude', sessionId: S1, remoteHostId: HOST, command: 'claude', chosenModel: 'fable' }, reader)).toEqual({ model: null, effort: null, source: null, chosenEffort: null })
    host.set('claude', S1, answer('claude-fable-5-1', { effort: 'xhigh' }) + '\n')
    const fresh = createRemoteModelReader({ readAgentFile: host.readAgentFile })
    expect(await remoteAgentModel({ agentId: 'claude', sessionId: S1, remoteHostId: HOST, chosenModel: 'fable' }, fresh)).toMatchObject({ model: 'claude-fable-5-1', chosenEffort: 'xhigh' })
    expect(await remoteAgentModel({ agentId: 'gemini', remoteHostId: HOST, command: 'gemini -m gemini-3' }, fresh)).toEqual({ model: 'gemini-3', effort: null, source: 'command' })
  })
})
