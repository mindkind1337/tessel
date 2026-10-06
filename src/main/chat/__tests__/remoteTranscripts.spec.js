// @vitest-environment node
// Conversation files on an SSH host: the bounded window reads (remoteFs.js
// readAgentFile over a fake host: Git for Windows' sh on a temporary home,
// never a real server) and the remote tail / history built on them.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRemoteFs } from '../../remoteFs'
import { gitSh, fakeSpawn } from '../../__tests__/fixtures/fakeSsh'
import { createRemoteTail, readRemoteHistory, remoteTranscriptExists, validRemoteTranscript } from '../remoteTranscripts'

const HOST = 'ssh-test1'
const SID = '11111111-2222-4333-8444-555555555555'
const CODEX = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

// A file as a window reader sees it (what readAgentFile answers).
function fileReader(get) {
  return vi.fn(async ({ offset, cap }) => {
    const buf = get()
    if (buf === null) return { ok: false, missing: true }
    if (offset === null) return { ok: true, size: buf.length, data: buf.subarray(Math.max(0, buf.length - cap)) }
    return { ok: true, size: buf.length, data: buf.subarray(Math.min(offset, buf.length), Math.min(offset + cap, buf.length)) }
  })
}

describe('remote tail', () => {
  it('reads the end, then only what was added; a line being written waits', async () => {
    let text = 'one\ntwo\n'
    const read = fileReader(() => Buffer.from(text))
    const tail = createRemoteTail(read, 1024)
    expect(await tail.read()).toBe(true)
    expect(tail.lines()).toEqual(['one', 'two'])
    expect(await tail.read()).toBe(false)
    text += 'thr'
    expect(await tail.read()).toBe(false)
    text += 'ee\n'
    expect(await tail.read()).toBe(true)
    expect(tail.lines()).toEqual(['one', 'two', 'three'])
    expect(read.mock.calls.at(-1)[0]).toEqual({ offset: 8, cap: 1024 })
  })

  it('keeps the last maxBytes, reads earlier lines on demand, starts over when the file shrank', async () => {
    let text = Array.from({ length: 20 }, (_, i) => `line-${String(i).padStart(2, '0')}`).join('\n') + '\n'
    const tail = createRemoteTail(fileReader(() => Buffer.from(text)), 40, { maxEarlier: 80 })
    await tail.read()
    expect(tail.cut()).toBe(true)
    expect(tail.lines().at(-1)).toBe('line-19')
    const kept = tail.lines().length
    const res = await tail.readEarlier(40)
    expect(res.added).toBeGreaterThan(0)
    expect(tail.lines().length).toBe(kept + res.added)
    text = 'fresh\n'
    expect(await tail.read()).toBe(true)
    expect(tail.lines()).toEqual(['fresh'])
  })

  it('an unreadable file is null', async () => {
    const tail = createRemoteTail(fileReader(() => null), 100)
    expect(await tail.read()).toBe(null)
  })

  it('history: events from the lines, a missing file said so, ids checked', async () => {
    const line = (o) => JSON.stringify(o)
    const file = Buffer.from(
      [
        line({ type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'hello' } }),
        line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:00:01Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })
      ].join('\n') + '\n'
    )
    const readAgentFile = vi.fn(async (_h, q) => fileReader(() => file)(q))
    const res = await readRemoteHistory({ readAgentFile, hostId: HOST, agent: 'claude', sessionId: SID })
    expect(res.ok).toBe(true)
    expect(res.events.map((e) => e.type).slice(0, 2)).toEqual(['user', 'assistant'])
    expect(readAgentFile.mock.calls[0][0]).toBe(HOST)
    expect((await readRemoteHistory({ readAgentFile: async () => ({ ok: false, missing: true }), hostId: HOST, agent: 'claude', sessionId: SID })).code).toBe('missing')
    expect((await readRemoteHistory({ readAgentFile, hostId: HOST, agent: 'claude', sessionId: '../x' })).code).toBe('invalid')
    expect(await remoteTranscriptExists({ readAgentFile: async () => ({ ok: false, missing: true }), hostId: HOST, agent: 'claude', sessionId: SID })).toBe(false)
    expect(await remoteTranscriptExists({ readAgentFile: async () => ({ ok: false, error: 'x' }), hostId: HOST, agent: 'claude', sessionId: SID })).toBe(null)
    expect(validRemoteTranscript('grok', HOST, SID)).toBe(false)
  })
})

describe.skipIf(!gitSh())('readAgentFile over a fake host (Git for Windows sh)', () => {
  let base, home, rfs
  const content = '{"type":"user"}\n{"type":"assistant"}\n'
  beforeAll(() => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rtr-'))
    home = join(base, 'home')
    fs.mkdirSync(join(home, '.claude', 'projects', '-home-me-app'), { recursive: true })
    fs.writeFileSync(join(home, '.claude', 'projects', '-home-me-app', `${SID}.jsonl`), content)
    fs.mkdirSync(join(home, '.codex', 'sessions', '2026', '10', '06'), { recursive: true })
    fs.writeFileSync(join(home, '.codex', 'sessions', '2026', '10', '06', `rollout-2026-10-06T01-02-03-${CODEX}.jsonl`), 'codex line\n')
    // Never the test machine's own agent folders.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CONFIG_DIR|CODEX_HOME)$/i.test(k)))
    rfs = createRemoteFs({
      hosts: { launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box', target: { id: HOST } }), get: () => ({ id: HOST, label: 'Box' }), sharedConnected: () => true, paneStarted() {}, paneConnected() {}, paneClosing() {}, paneExited() {} },
      spawnImpl: fakeSpawn({ home }),
      env
    })
  }, 60000)
  afterAll(() => {
    rfs?.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('reads a Claude transcript by its id: the end, or from an offset', async () => {
    const all = await rfs.readAgentFile(HOST, { agent: 'claude', id: SID })
    expect(all.ok).toBe(true)
    expect(all.size).toBe(Buffer.byteLength(content))
    expect(all.data.toString()).toBe(content)
    const end = await rfs.readAgentFile(HOST, { agent: 'claude', id: SID, offset: null, cap: 10 })
    expect(end.data.toString()).toBe(content.slice(-10))
    const from = await rfs.readAgentFile(HOST, { agent: 'claude', id: SID, offset: 16, cap: 5 })
    expect(from.data.toString()).toBe(content.slice(16, 21))
    const past = await rfs.readAgentFile(HOST, { agent: 'claude', id: SID, offset: 1000, cap: 5 })
    expect(past.ok).toBe(true)
    expect(past.data.length).toBe(0)
  }, 60000)

  it('finds a Codex rollout; a missing id says missing; bad input is refused', async () => {
    const r = await rfs.readAgentFile(HOST, { agent: 'codex', id: CODEX })
    expect(r.ok && r.data.toString()).toBe('codex line\n')
    expect(await rfs.readAgentFile(HOST, { agent: 'claude', id: '99999999-2222-4333-8444-555555555555' })).toMatchObject({ ok: false, missing: true })
    expect(await rfs.readAgentFile(HOST, { agent: 'claude', id: '../../etc/passwd' })).toMatchObject({ ok: false, error: 'invalid' })
    expect(await rfs.readAgentFile(HOST, { agent: 'grok', id: SID })).toMatchObject({ ok: false, error: 'invalid' })
    expect(await rfs.readAgentFile(HOST, { agent: 'claude', id: SID, offset: -1 })).toMatchObject({ ok: false, error: 'invalid' })
  }, 60000)
})
