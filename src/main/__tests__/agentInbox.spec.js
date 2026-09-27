import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import net from 'net'
import os from 'os'
import { join } from 'path'
import { inboxOf, postToInbox } from '../agentInbox'

let dir
let server
const pipe = `\\\\.\\pipe\\tessel-inbox-test-${process.pid}-${Date.now()}`
const report = (extra = {}) =>
  fs.writeFileSync(
    join(dir, 'pane-1.json'),
    JSON.stringify({ agent: 'claude', sessionId: 'sess-abc123', inbox: pipe, inboxToken: 'k-1', at: Date.now(), ...extra })
  )

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-inbox-'))
})
afterEach(async () => {
  if (server) await new Promise((r) => server.close(r))
  server = null
  fs.rmSync(dir, { recursive: true, force: true })
})

// A stand-in for Claude Code's inbox: collects each connection's lines.
function listen() {
  const got = []
  server = net.createServer((sock) => {
    let text = ''
    sock.on('data', (d) => (text += d))
    sock.on('end', () => got.push(text.trim().split('\n').map((l) => JSON.parse(l))))
  })
  return new Promise((r) => server.listen(pipe, () => r(got)))
}

describe('inboxOf', () => {
  it('only for the conversation the pane is in now', () => {
    report()
    expect(inboxOf(dir, 'pane-1', 'sess-abc123')).toEqual({ pipe, token: 'k-1' })
    expect(inboxOf(dir, 'pane-1', 'other-session')).toBe(null)
    expect(inboxOf(dir, 'pane-2', 'sess-abc123')).toBe(null)
  })
  it('never an unsafe pane id, a non-pipe path, or another agent', () => {
    report()
    expect(inboxOf(dir, '../pane-1', 'sess-abc123')).toBe(null)
    report({ inbox: 'C:\\Windows\\x' })
    expect(inboxOf(dir, 'pane-1', 'sess-abc123')).toBe(null)
    report({ agent: 'codex' })
    expect(inboxOf(dir, 'pane-1', 'sess-abc123')).toBe(null)
    report({ inboxToken: '' })
    expect(inboxOf(dir, 'pane-1', 'sess-abc123')).toBe(null)
  })
})

describe('postToInbox', () => {
  it('sends the auth line, then the message as one user line', async () => {
    const got = await listen()
    report()
    const res = await postToInbox({ sessionsDir: dir, paneId: 'pane-1', sessionId: 'sess-abc123', text: 'hello team' })
    expect(res).toEqual({ ok: true })
    for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 25))
    expect(got).toEqual([
      [
        { type: 'auth', token: 'k-1' },
        { type: 'user', message: { role: 'user', content: 'hello team' } }
      ]
    ])
  })
  it('fails (so the reminder is typed) when the session is gone', async () => {
    report()
    const res = await postToInbox({ sessionsDir: dir, paneId: 'pane-1', sessionId: 'sess-abc123', text: 'x' })
    expect(res.ok).toBe(false)
  })
  it('fails with no report for the conversation', async () => {
    const res = await postToInbox({ sessionsDir: dir, paneId: 'pane-1', sessionId: 'sess-abc123', text: 'x' })
    expect(res).toEqual({ ok: false, error: 'no inbox reported for this conversation' })
  })
})
