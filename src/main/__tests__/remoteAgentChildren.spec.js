import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRemoteChildren } from '../remoteAgentChildren'
import { parseSubagentMetas, parseSubagentListing } from '../remoteFs'
import { createRemoteSession, sessionArgs } from '../remoteShell'
import { gitSh, fakeSshLaunch } from './fixtures/fakeSsh'

const SID = '0f6b2c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b'
const CODEX_SID = '019a1b2c-3d4e-7f50-8a9b-0c1d2e3f4a5b'
const CODEX_CHILD = '019a1b2c-4e5f-7a60-9b0c-1d2e3f4a5b6c'
const T0 = Date.parse('2026-10-18T10:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

// Lines shaped like Claude Code 2.x's sub-agent transcripts
// (<session>/subagents/agent-<id>.jsonl) and its meta files.
function claudeUser(agentId, at, text = 'Back up fivem_emu.lua before rewrite') {
  return JSON.stringify({ parentUuid: null, isSidechain: true, agentId, type: 'user', message: { role: 'user', content: text }, uuid: `u-${at}`, timestamp: iso(at), userType: 'external', cwd: '/home/fivem2/FXServer', sessionId: SID, version: '2.1.80' })
}
function claudeAssistant(agentId, at, { stop = 'tool_use', model = 'claude-opus-5-5', pad = '' } = {}) {
  return JSON.stringify({
    parentUuid: `u-${at - 1}`,
    isSidechain: true,
    agentId,
    type: 'assistant',
    message: { model, id: `msg_${at}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: `working${pad}` }], stop_reason: stop, usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 50 } },
    uuid: `a-${at}`,
    timestamp: iso(at),
    sessionId: SID
  })
}
const meta = (description, background = false) => ({ agentType: 'general-purpose', launchedWithDefaults: true, description, toolUseId: 'toolu_01', spawnDepth: 1, ...(background ? { requestShape: 'background', requestNonInteractive: true } : {}) })

// A fake host: files by name, read as remoteFs.js reads them (a window: the
// last `cap` bytes, or from `offset` on), every request counted.
function fakeHost() {
  const subs = new Map() // name -> { text, mtimeMs, meta }
  const rollouts = new Map() // child id -> { name, text, mtimeMs }
  const calls = []
  const window = (text, mtimeMs, { offset = null, cap }) => {
    const buf = Buffer.from(text, 'utf8')
    const data = offset === null ? buf.subarray(Math.max(0, buf.length - cap)) : buf.subarray(Math.min(offset, buf.length), Math.min(offset, buf.length) + cap)
    return { ok: true, size: buf.length, mtimeMs, data }
  }
  return {
    subs,
    rollouts,
    calls,
    listSubagentFiles: async (hostId, { id }) => {
      calls.push(['list', id])
      return { ok: true, files: [...subs].map(([name, f]) => ({ name, size: Buffer.byteLength(f.text), mtimeMs: f.mtimeMs })).sort((a, b) => b.mtimeMs - a.mtimeMs) }
    },
    readSubagentMetas: async (hostId, { names }) => {
      calls.push(['meta', ...names])
      const metas = {}
      for (const n of names) if (subs.get(n) && subs.get(n).meta) metas[n] = subs.get(n).meta
      return { ok: true, metas }
    },
    readAgentFile: async (hostId, q) => {
      calls.push(['read', q.agent, q.sub || q.id, q.offset, q.cap])
      if (q.sub) {
        const f = subs.get(q.sub)
        return f ? window(f.text, f.mtimeMs, q) : { ok: false, missing: true }
      }
      const f = rollouts.get(q.id)
      return f ? window(f.text, f.mtimeMs, q) : { ok: false, missing: true }
    },
    listCodexChildren: async (hostId, { id }) => {
      calls.push(['cxlist', id])
      return { ok: true, files: [...rollouts.values()].map((f) => ({ name: f.name, size: Buffer.byteLength(f.text), mtimeMs: f.mtimeMs })) }
    }
  }
}

describe('remote sub-agents (Claude Code on an SSH host)', () => {
  it('lists running and finished ones with their kind, title, model, tokens and background flag', async () => {
    const host = fakeHost()
    host.subs.set('agent-a0f1', { text: [claudeUser('a0f1', T0), claudeAssistant('a0f1', T0 + 1000, { stop: 'end_turn' })].join('\n') + '\n', mtimeMs: T0 + 1000, meta: meta('Read the logs') })
    host.subs.set('agent-b2c3', { text: [claudeUser('b2c3', T0 + 2000), claudeAssistant('b2c3', T0 + 3000)].join('\n') + '\n', mtimeMs: T0 + 3000, meta: meta('Backing up fivem_emu.lua before rewrite', true) })
    let t = T0 + 60_000
    const rc = createRemoteChildren({ ...host, now: () => t })
    const rows = await rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID })
    expect(rows.map((r) => r.id)).toEqual(['b2c3', 'a0f1'])
    expect(rows[0]).toMatchObject({ type: 'general-purpose', title: 'Backing up fivem_emu.lua before rewrite', background: true, state: 'running', startedAt: T0 + 2000, tokens: 2160, model: 'claude-opus-5-5', endedAt: null })
    expect(rows[1]).toMatchObject({ title: 'Read the logs', background: false, state: 'done', endedAt: T0 + 1000 })
    // The meta files are asked for once, in one request.
    expect(host.calls.filter((c) => c[0] === 'meta')).toEqual([['meta', 'agent-b2c3', 'agent-a0f1']])
  })

  it('reads only what a running one added, and nothing when nothing changed', async () => {
    const host = fakeHost()
    const f = { text: claudeUser('b2c3', T0) + '\n', mtimeMs: T0, meta: meta('Long job', true) }
    host.subs.set('agent-b2c3', f)
    let t = T0 + 1000
    const rc = createRemoteChildren({ ...host, now: () => t, minGapMs: 4000 })
    await rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID })
    const size1 = Buffer.byteLength(f.text)
    // Within the gap: the last answer, no request.
    host.calls.length = 0
    t += 1000
    await rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID })
    expect(host.calls).toEqual([])
    // It wrote more: one read from where the last one ended.
    f.text += claudeAssistant('b2c3', T0 + 5000) + '\n'
    f.mtimeMs = T0 + 5000
    t += 5000
    const rows = await rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID })
    expect(host.calls.filter((c) => c[0] === 'read')).toEqual([['read', 'claude', 'agent-b2c3', size1, 2 * 1024 * 1024]])
    expect(rows[0]).toMatchObject({ state: 'running', tokens: 2160, startedAt: T0 })
    // Unchanged: the listing only.
    host.calls.length = 0
    t += 5000
    await rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID })
    expect(host.calls).toEqual([['list', SID]])
    // A line written in two goes: read whole across both.
    const line = claudeAssistant('b2c3', T0 + 20_000, { stop: 'end_turn' }) + '\n'
    f.text += line.slice(0, 40)
    t += 5000
    await rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID })
    f.text += line.slice(40)
    t += 5000
    const after = await rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID })
    expect(after[0]).toMatchObject({ state: 'done', endedAt: T0 + 20_000 })
  })

  it('a long transcript first seen: its end only, and its start from its first line', async () => {
    const host = fakeHost()
    const lines = [claudeUser('c4', T0)]
    for (let i = 1; i < 400; i++) lines.push(claudeAssistant('c4', T0 + i * 1000, { pad: 'x'.repeat(400) }))
    host.subs.set('agent-c4', { text: lines.join('\n') + '\n', mtimeMs: T0 + 400_000, meta: meta('Big one') })
    const rc = createRemoteChildren({ ...host, now: () => T0 + 401_000 })
    const rows = await rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID })
    const reads = host.calls.filter((c) => c[0] === 'read')
    expect(reads).toEqual([
      ['read', 'claude', 'agent-c4', null, 96 * 1024],
      ['read', 'claude', 'agent-c4', 0, 8192]
    ])
    expect(rows[0]).toMatchObject({ startedAt: T0, state: 'running', lastAt: T0 + 400_000 })
  })

  it('reads at most maxReads files at once, newest first; the others on the next turns', async () => {
    const host = fakeHost()
    for (let i = 0; i < 5; i++) host.subs.set(`agent-k${i}`, { text: claudeUser(`k${i}`, T0 + i) + '\n', mtimeMs: T0 + i, meta: meta(`k${i}`) })
    let t = T0 + 10_000
    const rc = createRemoteChildren({ ...host, now: () => t, maxReads: 2 })
    const first = await rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID })
    expect(first).toHaveLength(5)
    expect(host.calls.filter((c) => c[0] === 'read').map((c) => c[2])).toEqual(['agent-k4', 'agent-k3'])
    host.calls.length = 0
    t += 5000
    await rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID })
    expect(host.calls.filter((c) => c[0] === 'read').map((c) => c[2])).toEqual(['agent-k2', 'agent-k1'])
  })

  it('one read at a time whoever asks; nothing for a bad host, session or agent', async () => {
    const host = fakeHost()
    host.subs.set('agent-a1', { text: claudeUser('a1', T0) + '\n', mtimeMs: T0, meta: meta('x') })
    const rc = createRemoteChildren({ ...host, now: () => T0 + 1000 })
    const [a, b] = await Promise.all([rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID }), rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID })])
    expect(a).toEqual(b)
    expect(host.calls.filter((c) => c[0] === 'list')).toHaveLength(1)
    expect(await rc.children({ hostId: 'h 1; rm', agent: 'claude', sessionId: SID })).toEqual([])
    expect(await rc.children({ hostId: 'h1', agent: 'claude', sessionId: '../x' })).toEqual([])
    expect(await rc.children({ hostId: 'h1', agent: 'gemini', sessionId: SID })).toEqual([])
  })

  it('not connected: the last rows stay', async () => {
    const host = fakeHost()
    host.subs.set('agent-a1', { text: claudeUser('a1', T0) + '\n', mtimeMs: T0, meta: meta('x') })
    let t = T0 + 1000
    let up = true
    const rc = createRemoteChildren({ ...host, listSubagentFiles: (h, q) => (up ? host.listSubagentFiles(h, q) : { ok: false, notConnected: true }), now: () => t })
    expect(await rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID })).toHaveLength(1)
    up = false
    t += 10_000
    expect(await rc.children({ hostId: 'h1', agent: 'claude', sessionId: SID })).toHaveLength(1)
  })
})

describe('remote sub-agents (Codex on an SSH host)', () => {
  const head = (id, at) =>
    JSON.stringify({ timestamp: iso(at), type: 'session_meta', payload: { id, timestamp: iso(at), cwd: '/home/u/p', originator: 'codex_cli_rs', cli_version: '0.130.0', session_id: CODEX_SID, parent_thread_id: CODEX_SID, thread_source: 'subagent', agent_nickname: 'Hume', agent_path: '/root/check_tests', source: { subagent: { thread_spawn: { parent_thread_id: CODEX_SID, depth: 1, agent_role: 'worker' } } }, base_instructions: { text: 'y'.repeat(20000) } } })
  const ctxLine = (at) => JSON.stringify({ timestamp: iso(at), type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'high' } })
  const ev = (at, payload) => JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload })

  it('finds the children by their first line, then reads only what they add', async () => {
    const host = fakeHost()
    const child = { name: `rollout-2026-10-18T10-00-05-${CODEX_CHILD}`, text: [head(CODEX_CHILD, T0 + 5000), ctxLine(T0 + 5100), ev(T0 + 5200, { type: 'task_started' })].join('\n') + '\n', mtimeMs: T0 + 5200 }
    host.rollouts.set(CODEX_CHILD, child)
    let t = T0 + 10_000
    const rc = createRemoteChildren({ ...host, now: () => t, codexScanMs: 30_000 })
    const rows = await rc.children({ hostId: 'h1', agent: 'codex', sessionId: CODEX_SID })
    expect(rows).toEqual([expect.objectContaining({ id: CODEX_CHILD, type: 'worker', title: 'check_tests (Hume)', state: 'running', startedAt: T0 + 5000, model: 'gpt-6-luna', effort: 'high' })])
    // Before the next scan: what it added, from where the last read ended.
    const size = Buffer.byteLength(child.text)
    child.text += ev(T0 + 15_000, { type: 'token_count', info: { last_token_usage: { total_tokens: 4321 } } }) + '\n' + ev(T0 + 16_000, { type: 'task_complete' }) + '\n'
    host.calls.length = 0
    t += 6000
    const after = await rc.children({ hostId: 'h1', agent: 'codex', sessionId: CODEX_SID })
    expect(host.calls).toEqual([['read', 'codex', CODEX_CHILD, size, 2 * 1024 * 1024]])
    expect(after[0]).toMatchObject({ state: 'done', tokens: 4321, endedAt: T0 + 16_000 })
    // Finished: left alone until a scan sees it grow.
    host.calls.length = 0
    t += 6000
    await rc.children({ hostId: 'h1', agent: 'codex', sessionId: CODEX_SID })
    expect(host.calls).toEqual([])
  })

  it('a rollout whose head is not this conversation\'s child is dropped', async () => {
    const host = fakeHost()
    const other = '019a1b2c-5f60-7b70-8c0d-1e2f3a4b5c6d'
    const line = JSON.stringify({ timestamp: iso(T0), type: 'session_meta', payload: { id: other, session_id: other, timestamp: iso(T0), instructions: CODEX_SID } })
    host.rollouts.set(other, { name: `rollout-2026-10-18T10-00-00-${other}`, text: line + '\n', mtimeMs: T0 })
    const rc = createRemoteChildren({ ...host, now: () => T0 + 1000 })
    expect(await rc.children({ hostId: 'h1', agent: 'codex', sessionId: CODEX_SID })).toEqual([])
  })
})

describe('host answers', () => {
  it('meta files: only the names asked for, JSON objects only', () => {
    const b = (s) => Buffer.from(s).toString('base64')
    const out = [`@@M agent-a1 ${b(JSON.stringify(meta('one', true)))}`, `@@M agent-zz ${b('{"x":1}')}`, `@@M agent-b2 ${b('{"cut":')}`, `@@M agent-c3 ${b('[1]')}`, 'noise'].join('\n')
    expect(parseSubagentMetas(out, ['agent-a1', 'agent-b2', 'agent-c3'])).toEqual({ 'agent-a1': meta('one', true) })
  })
  it('a Codex children listing reads like a sub-agent one', () => {
    expect(parseSubagentListing(`120 1760781600 rollout-2026-10-18T10-00-05-${CODEX_CHILD}.jsonl\n`)).toEqual([{ name: `rollout-2026-10-18T10-00-05-${CODEX_CHILD}`, size: 120, mtimeMs: 1760781600000 }])
  })
})

// The real helpers, run by Git for Windows' sh through a fake ssh.exe on a
// temporary home shaped like a host's.
describe.skipIf(!gitSh())('host helpers against a POSIX shell (fake ssh)', () => {
  let dir
  let session
  const saved = {}
  beforeAll(() => {
    // The host's own folders only (never this PC's account folder).
    for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterAll(() => {
    for (const k of Object.keys(saved)) if (saved[k] !== undefined) process.env[k] = saved[k]
  })
  afterEach(() => {
    if (session) session.close('done')
    session = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = null
  })
  async function start() {
    const launch = fakeSshLaunch({ home: dir })
    session = createRemoteSession({ file: launch.file, args: sessionArgs(launch.args), spawnImpl: launch.spawnImpl })
    await session.start()
  }

  it('lists the newest sub-agents first, reads their meta files, finds an account folder\'s transcript', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rkids-'))
    const proj = join(dir, '.claude', 'projects', '-home-fivem2-FXServer')
    const sub = join(proj, SID, 'subagents')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(join(proj, `${SID}.jsonl`), claudeUser('x', T0) + '\n')
    const old = (Date.now() - 3600_000) / 1000
    // Named so that alphabetical order is the wrong one.
    fs.writeFileSync(join(sub, 'agent-a0old.jsonl'), claudeUser('a0old', T0) + '\n')
    fs.utimesSync(join(sub, 'agent-a0old.jsonl'), old, old)
    fs.writeFileSync(join(sub, 'agent-ffnew.jsonl'), claudeUser('ffnew', T0) + '\n')
    fs.writeFileSync(join(sub, 'agent-ffnew.meta.json'), JSON.stringify(meta('Backing up', true)))
    const acc = join(dir, '.tessel-server', 'accounts', 'claude', 'acc1', 'projects', 'p')
    fs.mkdirSync(acc, { recursive: true })
    const SID2 = '1a2b3c4d-0000-4000-8000-000000000002'
    fs.writeFileSync(join(acc, `${SID2}.jsonl`), 'hello\n')
    await start()
    const ls = await session.run('__t_subs', [SID, '1'])
    expect(ls.rc).toBe(0)
    expect(parseSubagentListing(ls.out.toString('utf8')).map((f) => f.name)).toEqual(['agent-ffnew'])
    const all = await session.run('__t_subs', [SID, '50'])
    expect(parseSubagentListing(all.out.toString('utf8')).map((f) => f.name)).toEqual(['agent-ffnew', 'agent-a0old'])
    const m = await session.run('__t_smeta', [SID, 'agent-ffnew', 'agent-a0old', '../x'])
    expect(m.rc).toBe(0)
    expect(parseSubagentMetas(m.out.toString('utf8'), ['agent-ffnew', 'agent-a0old'])).toEqual({ 'agent-ffnew': meta('Backing up', true) })
    const rd = await session.run('__t_tread', ['claude', SID2, '-', '100'])
    expect(rd.rc).toBe(0)
    expect(rd.out.toString('utf8').split('\n')[1]).toBe('hello')
  }, 30000)

  it('finds a Codex conversation\'s children by their first line', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rkids-'))
    const day = join(dir, '.codex', 'sessions', '2026', '10', '18')
    fs.mkdirSync(day, { recursive: true })
    const parentLine = JSON.stringify({ type: 'session_meta', payload: { id: CODEX_SID, session_id: CODEX_SID } })
    fs.writeFileSync(join(day, `rollout-2026-10-18T10-00-00-${CODEX_SID}.jsonl`), parentLine + '\n')
    const childLine = JSON.stringify({ type: 'session_meta', payload: { id: CODEX_CHILD, session_id: CODEX_SID, parent_thread_id: CODEX_SID, thread_source: 'subagent', base_instructions: { text: 'y'.repeat(20000) } } })
    fs.writeFileSync(join(day, `rollout-2026-10-18T10-00-05-${CODEX_CHILD}.jsonl`), childLine + '\n')
    const other = '019a1b2c-5f60-7b70-8c0d-1e2f3a4b5c6d'
    fs.writeFileSync(join(day, `rollout-2026-10-18T09-00-00-${other}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: other, session_id: other } }) + '\n' + CODEX_SID + '\n')
    await start()
    const r = await session.run('__t_cxkids', [CODEX_SID, '50'])
    expect(r.rc).toBe(0)
    expect(parseSubagentListing(r.out.toString('utf8')).map((f) => f.name)).toEqual([`rollout-2026-10-18T10-00-05-${CODEX_CHILD}`])
  }, 30000)
})
