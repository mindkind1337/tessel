// @vitest-environment node
// The team channel's state.json (1 MB+, read at every poll, written at every
// message): polls answer from the parsed file while it is unchanged, delivered
// messages past 500 (+100) move to archive.jsonl, and a state.json from the
// previous version (up to 2000 delivered messages) is migrated without loss.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ensureTeamChannel, pollTeamChannel, ackTeamDelivery, holdTeamDelivery, readTeamArchive } from '../teamChannel'

const teamId = 'team-1'
const members = [
  { id: 'pane-a', num: 1, title: 'Codex' },
  { id: 'pane-b', num: 2, title: 'Claude' }
]
let dir, root, stateFile, outboxes

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-chcache-'))
  const ready = ensureTeamChannel({ dir, teamId, members })
  outboxes = Object.fromEntries(ready.outboxes.map((m) => [m.id, m.outbox]))
  root = join(dir, '.tessel', 'team-channel', teamId)
  stateFile = join(root, 'state.json')
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const delivered = (i) => ({ id: `m-${i}`, fromId: 'pane-a', toId: 'pane-b', text: `hello ${i}`, status: 'delivered', createdAt: i, deliveredAt: i })
const writeState = (mutate) => {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  mutate(state)
  fs.writeFileSync(stateFile, JSON.stringify(state))
}
const stateReads = (spy) => spy.mock.calls.filter(([p]) => String(p) === stateFile).length

describe('polling an unchanged channel', () => {
  it('reads and parses state.json once, not at every poll', () => {
    writeState((s) => (s.messages = Array.from({ length: 300 }, (_, i) => delivered(i))))
    const read = vi.spyOn(fs, 'readFileSync')
    const first = pollTeamChannel({ dir, teamId })
    for (let i = 0; i < 10; i++) expect(pollTeamChannel({ dir, teamId })).toEqual(first)
    expect(stateReads(read)).toBe(1)
    expect(first.history).toHaveLength(200)
  })

  it('a change made by this process (hold, release, ack) shows at the next poll', () => {
    writeState((s) => s.messages.push({ id: 'p1', fromId: 'pane-a', toId: 'pane-b', text: 'x', status: 'pending', createdAt: 1 }))
    expect(pollTeamChannel({ dir, teamId }).deliveries.map((m) => m.id)).toEqual(['p1'])
    expect(holdTeamDelivery({ dir, teamId, id: 'p1', toId: 'pane-b', state: 'inflight' }).ok).toBe(true)
    const held = pollTeamChannel({ dir, teamId })
    expect(held.deliveries).toEqual([])
    expect(held.held.map((m) => m.id)).toEqual(['p1'])
    expect(ackTeamDelivery({ dir, teamId, id: 'p1', toId: 'pane-b' }).ok).toBe(true)
    const done = pollTeamChannel({ dir, teamId })
    expect(done.held).toEqual([])
    expect(done.history.find((m) => m.id === 'p1').status).toBe('delivered')
  })

  it('a change made by another program shows at the next poll', () => {
    expect(pollTeamChannel({ dir, teamId }).deliveries).toEqual([])
    writeState((s) => s.messages.push({ id: 'ext', fromId: 'pane-a', toId: 'pane-b', text: 'from outside', status: 'pending', createdAt: 1 }))
    expect(pollTeamChannel({ dir, teamId }).deliveries.map((m) => m.id)).toEqual(['ext'])
  })

  it('a message dropped in an outbox is taken in, and the cached state is not changed behind the next poll', () => {
    const before = pollTeamChannel({ dir, teamId })
    expect(before.deliveries).toEqual([])
    fs.writeFileSync(join(outboxes['pane-a'], 'one.json'), JSON.stringify({ to: '#2', text: 'hi there' }))
    // The file is read at once (a file empty and younger than 5 s is waited for; this one is whole).
    const after = pollTeamChannel({ dir, teamId })
    expect(after.deliveries.map((m) => m.text)).toEqual(['hi there'])
    expect(fs.existsSync(join(outboxes['pane-a'], 'one.json'))).toBe(false)
    // And again: not twice.
    expect(pollTeamChannel({ dir, teamId }).deliveries).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).messages).toHaveLength(1)
  })

  it('a state.json restored from its copy is read from the copy', () => {
    writeState((s) => s.messages.push(delivered(1)))
    pollTeamChannel({ dir, teamId })
    ackTeamDelivery({ dir, teamId, id: 'nope', toId: 'pane-b' })
    fs.copyFileSync(stateFile, `${stateFile}.bak`)
    fs.writeFileSync(stateFile, '{ cut')
    expect(pollTeamChannel({ dir, teamId }).ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).messages.map((m) => m.id)).toEqual(['m-1'])
  })
})

describe('delivered messages past the limit go to archive.jsonl', () => {
  const pendingMessage = { id: 'wait', fromId: 'pane-a', toId: 'pane-b', text: 'not yet', status: 'pending', createdAt: 5 }
  const held = { id: 'held', fromId: 'pane-a', toId: 'pane-b', text: 'draft', status: 'uncertain', heldAt: 9, createdAt: 6 }

  it('up to 600 delivered messages nothing moves; one more and the oldest go down to 500, in the archive in order', () => {
    writeState((s) => (s.messages = [pendingMessage, ...Array.from({ length: 600 }, (_, i) => delivered(i))]))
    // A save that adds nothing to trim.
    expect(ackTeamDelivery({ dir, teamId, id: 'wait', toId: 'pane-b' }).ok).toBe(true) // now 601 delivered
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    expect(saved.messages.filter((m) => m.status === 'delivered')).toHaveLength(500)
    const archive = readTeamArchive({ dir, teamId, limit: 5000 })
    // 'wait' (acknowledged by this save, first in the file) and the 100 oldest after it.
    expect(archive.messages.map((m) => m.id)).toEqual(['wait', ...Array.from({ length: 100 }, (_, i) => `m-${i}`)])
    expect(fs.existsSync(join(root, 'archive.jsonl'))).toBe(true)
  })

  it('never moves an undelivered message, whatever its age', () => {
    writeState((s) => (s.messages = [pendingMessage, held, ...Array.from({ length: 900 }, (_, i) => delivered(i))]))
    expect(ackTeamDelivery({ dir, teamId, id: 'wait', toId: 'pane-b' }).ok).toBe(true)
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    expect(saved.messages.find((m) => m.id === 'held').status).toBe('uncertain')
    const archive = readTeamArchive({ dir, teamId, limit: 5000 })
    expect(archive.messages.every((m) => m.status === 'delivered')).toBe(true)
    expect(archive.messages.some((m) => m.id === 'held')).toBe(false)
    expect(pollTeamChannel({ dir, teamId }).held.map((m) => m.id)).toEqual(['held'])
  })

  it('the archive can be read page by page, newest page first, without copies', () => {
    writeState((s) => (s.messages = [pendingMessage, ...Array.from({ length: 1300 }, (_, i) => delivered(i))]))
    ackTeamDelivery({ dir, teamId, id: 'wait', toId: 'pane-b' })
    const all = readTeamArchive({ dir, teamId, limit: 5000 })
    expect(all.total).toBe(801)
    const page = readTeamArchive({ dir, teamId, limit: 100 })
    expect(page.messages.map((m) => m.id)).toEqual(all.messages.slice(-100).map((m) => m.id))
    const older = readTeamArchive({ dir, teamId, limit: 100, before: page.messages[0].id })
    expect(older.messages.at(-1).id).toBe(all.messages.at(-101).id)
    // The same messages in the archive twice (a kill between the archive and the state): read once.
    fs.appendFileSync(join(root, 'archive.jsonl'), JSON.stringify(delivered(0)) + '\n')
    expect(readTeamArchive({ dir, teamId, limit: 5000 }).total).toBe(801)
  })

  it('migration: a state.json with 2000 delivered messages keeps them all between state.json and archive.jsonl, and the old file once', () => {
    writeState((s) => (s.messages = [...Array.from({ length: 2000 }, (_, i) => delivered(i)), pendingMessage]))
    const original = fs.readFileSync(stateFile, 'utf8')
    expect(ackTeamDelivery({ dir, teamId, id: 'wait', toId: 'pane-b' }).ok).toBe(true)
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    const archive = readTeamArchive({ dir, teamId, limit: 5000 })
    const ids = [...archive.messages.map((m) => m.id), ...saved.messages.map((m) => m.id)]
    // 2000 + 'wait' + the delivery receipt the ack made for its sender.
    expect(new Set(ids).size).toBe(2002)
    expect(saved.messages).toHaveLength(501)
    expect(saved.messages.at(-1).id).toBe('wait-receipt')
    expect(saved.messages.at(-1).status).toBe('pending')
    expect(fs.readFileSync(`${stateFile}.before-archive`, 'utf8')).toBe(original)
    // Members and the seen ids are untouched.
    expect(Object.keys(saved.members).sort()).toEqual(['pane-a', 'pane-b'])
    expect(fs.readFileSync(stateFile, 'utf8')).not.toContain('\n')
  })

  it('the archive past 8 MB is moved to archive.old.jsonl and still read', () => {
    fs.writeFileSync(join(root, 'archive.jsonl'), `\n${JSON.stringify(delivered(-1))}\n` + ' '.repeat(8 * 1024 * 1024 + 1))
    writeState((s) => (s.messages = [pendingMessage, ...Array.from({ length: 700 }, (_, i) => delivered(i))]))
    ackTeamDelivery({ dir, teamId, id: 'wait', toId: 'pane-b' })
    expect(fs.existsSync(join(root, 'archive.old.jsonl'))).toBe(true)
    const archive = readTeamArchive({ dir, teamId, limit: 5000 })
    expect(archive.messages[0].id).toBe('m--1')
    expect(archive.messages.length).toBeGreaterThan(100)
  })
})
