import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, dirname } from 'path'
import {
  ensureTeamChannel,
  pollTeamChannel,
  ackTeamDelivery,
  holdTeamDelivery,
  releaseTeamDelivery
} from '../teamChannel'

describe('persistent team channel', () => {
  let dir, outboxes
  const teamId = 'team-1'
  const members = [
    { id: 'pane-a', num: 1, title: 'Codex' },
    { id: 'pane-b', num: 2, title: 'Claude' },
    { id: 'pane-c', num: 3, title: 'Gemini' }
  ]
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-channel-'))
    const ready = ensureTeamChannel({ dir, teamId, members })
    expect(ready.ok).toBe(true)
    expect(ready.outboxes[0].guide).toMatch(/"to":"#2"/)
    outboxes = Object.fromEntries(ready.outboxes.map((m) => [m.id, m.outbox]))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const put = (box, name, data) => fs.writeFileSync(join(box, `${name}.json`), JSON.stringify(data))

  it('delivers a direct message and a reply with persistent acknowledgements', () => {
    put(outboxes['pane-a'], 'one', { to: '#2', text: 'Please review this.' })
    const first = pollTeamChannel({ dir, teamId })
    expect(first.deliveries).toHaveLength(1)
    expect(first.deliveries[0]).toMatchObject({
      fromId: 'pane-a',
      toId: 'pane-b',
      text: 'Please review this.',
      status: 'pending'
    })
    const id = first.deliveries[0].id
    expect(fs.existsSync(join(outboxes['pane-a'], 'one.json'))).toBe(false)
    // A later process/poll sees the same undelivered item, without ingesting a duplicate.
    expect(pollTeamChannel({ dir, teamId }).deliveries.map((m) => m.id)).toEqual([id])
    expect(ackTeamDelivery({ dir, teamId, id, toId: 'pane-b' }).ok).toBe(true)
    const receipt = pollTeamChannel({ dir, teamId }).deliveries[0]
    expect(receipt).toMatchObject({ fromId: 'tessel', toId: 'pane-a', replyTo: id })
    expect(receipt.text).toMatch(/Delivered to #2 Claude/)
    expect(ackTeamDelivery({ dir, teamId, id: receipt.id, toId: 'pane-a' }).ok).toBe(true)
    expect(pollTeamChannel({ dir, teamId }).deliveries).toEqual([])
    put(outboxes['pane-b'], 'reply', { to: '#1', text: 'Looks good.', reply_to: id })
    expect(pollTeamChannel({ dir, teamId }).deliveries[0]).toMatchObject({
      fromId: 'pane-b',
      toId: 'pane-a',
      replyTo: id
    })
  })

  it('fans out to teammates and holds an unavailable recipient', () => {
    put(outboxes['pane-a'], 'all', { to: 'team', text: 'Status?' })
    const first = pollTeamChannel({ dir, teamId, availableIds: ['pane-b'] })
    expect(first.deliveries.map((m) => m.toId)).toEqual(['pane-b'])
    const next = pollTeamChannel({ dir, teamId, availableIds: ['pane-c'] })
    expect(next.deliveries.map((m) => m.toId)).toEqual(['pane-c'])
    expect(first.history).toHaveLength(2)
  })

  it('accepts a later message that reuses a filename', () => {
    put(outboxes['pane-a'], 'message', { to: '#2', text: 'First' })
    const first = pollTeamChannel({ dir, teamId }).deliveries[0]
    expect(ackTeamDelivery({ dir, teamId, id: first.id, toId: 'pane-b' }).ok).toBe(true)
    put(outboxes['pane-a'], 'message', { to: '#2', text: 'Second' })
    const second = pollTeamChannel({ dir, teamId }).deliveries.find((m) => m.text === 'Second')
    expect(second.text).toBe('Second')
    expect(second.id).not.toBe(first.id)
  })

  it('rejects an outsider and reports the error to the sender', () => {
    put(outboxes['pane-a'], 'bad', { to: '#99', text: 'Secret' })
    const res = pollTeamChannel({ dir, teamId })
    expect(res.deliveries).toHaveLength(1)
    expect(res.deliveries[0]).toMatchObject({ fromId: 'tessel', toId: 'pane-a' })
    expect(res.deliveries[0].text).toMatch(/recipient is not an active teammate/)
  })

  it('keeps tokens stable on reload and does not deliver to former teammates', () => {
    const oldBox = outboxes['pane-b']
    put(outboxes['pane-a'], 'before-leave', { to: '#2', text: 'Before you go' })
    expect(pollTeamChannel({ dir, teamId }).deliveries[0].toId).toBe('pane-b')
    const ready = ensureTeamChannel({ dir, teamId, members: [members[0], members[2]] })
    expect(ready.outboxes.find((m) => m.id === 'pane-a').outbox).toBe(outboxes['pane-a'])
    put(oldBox, 'stale', { to: '#1', text: 'No longer in team' })
    put(outboxes['pane-a'], 'former', { to: '#2', text: 'Hello?' })
    const res = pollTeamChannel({ dir, teamId })
    expect(res.history.some((m) => m.text === 'No longer in team')).toBe(false)
    expect(res.deliveries[0].text).toMatch(/not an active teammate/)
    expect(res.deliveries.some((m) => m.toId === 'pane-b')).toBe(false)
    expect(res.participants.find((m) => m.id === 'pane-b')).toMatchObject({
      title: 'Claude',
      active: false
    })
    expect(res.participants.some((m) => 'token' in m)).toBe(false)
  })

  it('rejects unsafe ids and waits for a partially written request', () => {
    expect(ensureTeamChannel({ dir, teamId: '../other', members }).ok).toBe(false)
    const file = join(outboxes['pane-a'], 'partial.json')
    fs.writeFileSync(file, '{"to":')
    expect(pollTeamChannel({ dir, teamId }).deliveries).toEqual([])
    fs.utimesSync(file, new Date(), new Date(Date.now() - 10000))
    expect(pollTeamChannel({ dir, teamId }).deliveries[0].text).toMatch(/invalid JSON/)
  })

  it.each(['inflight', 'uncertain'])(
    'keeps %s drafts held across a module reload',
    async (status) => {
      put(outboxes['pane-a'], 'draft', { to: '#2', text: 'Do not paste me twice.' })
      const message = pollTeamChannel({ dir, teamId }).deliveries[0]
      const request = { dir, teamId, id: message.id, toId: message.toId }
      expect(holdTeamDelivery({ ...request, state: status }).ok).toBe(true)
      const stateFile = join(dirname(dirname(outboxes['pane-a'])), 'state.json')
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).messages[0]).toMatchObject({
        status,
        heldAt: expect.any(Number)
      })

      vi.resetModules()
      const restarted = await import('../teamChannel')
      expect(restarted.ensureTeamChannel({ dir, teamId, members }).ok).toBe(true)
      const polled = restarted.pollTeamChannel({ dir, teamId })
      expect(polled.deliveries).toEqual([])
      expect(polled.held).toHaveLength(1)
      expect(polled.held[0]).toMatchObject({ id: message.id, status, text: message.text })
      expect(polled.history).toHaveLength(1) // No delivery receipt before confirmation.
    }
  )

  it('blocks a second draft for the same pane but lets other teammates continue', () => {
    put(outboxes['pane-a'], '01-first', { to: '#2', text: 'First draft' })
    put(outboxes['pane-a'], '02-second', { to: '#2', text: 'Second draft' })
    put(outboxes['pane-a'], '03-other', { to: '#3', text: 'Independent message' })
    const before = pollTeamChannel({ dir, teamId }).deliveries
    const [first, second] = before
    expect(
      holdTeamDelivery({ dir, teamId, id: first.id, toId: first.toId, state: 'inflight' }).ok
    ).toBe(true)
    // A renderer with the earlier poll result cannot hold the next draft too.
    expect(
      holdTeamDelivery({ dir, teamId, id: second.id, toId: second.toId, state: 'inflight' }).ok
    ).toBe(false)
    const blocked = pollTeamChannel({ dir, teamId })
    expect(blocked.deliveries.map((m) => m.text)).toEqual(['Independent message'])
    expect(blocked.held.map((m) => m.id)).toEqual([first.id])
    expect(ackTeamDelivery({ dir, teamId, id: first.id, toId: first.toId }).ok).toBe(true)
    expect(pollTeamChannel({ dir, teamId }).deliveries.some((m) => m.id === second.id)).toBe(true)
  })

  it('keeps unavailable holds visible and preserves them while a member leaves and rejoins', () => {
    put(outboxes['pane-a'], 'draft', { to: '#2', text: 'Still unresolved' })
    const message = pollTeamChannel({ dir, teamId }).deliveries[0]
    expect(
      holdTeamDelivery({ dir, teamId, id: message.id, toId: 'pane-b', state: 'uncertain' }).ok
    ).toBe(true)
    expect(pollTeamChannel({ dir, teamId, availableIds: [] }).held.map((m) => m.id)).toEqual([
      message.id
    ])
    ensureTeamChannel({ dir, teamId, members: [members[0], members[2]] })
    expect(pollTeamChannel({ dir, teamId }).held).toEqual([])
    ensureTeamChannel({ dir, teamId, members })
    const back = pollTeamChannel({ dir, teamId })
    expect(back.deliveries).toEqual([])
    expect(back.held[0]).toMatchObject({ id: message.id, status: 'uncertain' })
  })

  it('preserves the hold time and requires release before retrying an uncertain draft', () => {
    put(outboxes['pane-a'], 'draft', { to: '#2', text: 'An uncertain draft' })
    const message = pollTeamChannel({ dir, teamId }).deliveries[0]
    const request = { dir, teamId, id: message.id, toId: 'pane-b' }
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    expect(holdTeamDelivery({ ...request, state: 'inflight' }).ok).toBe(true)
    now.mockReturnValue(2000)
    expect(holdTeamDelivery({ ...request, state: 'uncertain' }).ok).toBe(true)
    expect(holdTeamDelivery({ ...request, state: 'uncertain' }).ok).toBe(true)
    expect(holdTeamDelivery({ ...request, state: 'inflight' }).ok).toBe(false)
    expect(pollTeamChannel({ dir, teamId }).held[0].heldAt).toBe(1000)
    expect(releaseTeamDelivery(request).ok).toBe(true)
    expect(releaseTeamDelivery(request).ok).toBe(true)
    const retry = pollTeamChannel({ dir, teamId })
    expect(retry.held).toEqual([])
    expect(retry.deliveries).toHaveLength(1)
    expect(retry.deliveries[0].id).toBe(message.id)
    expect(retry.deliveries[0].heldAt).toBeUndefined()
    expect(holdTeamDelivery({ ...request, state: 'inflight' }).ok).toBe(true)
    expect(pollTeamChannel({ dir, teamId }).held[0].heldAt).toBe(2000)
  })

  it.each(['inflight', 'uncertain'])(
    'confirms %s once and cannot reopen it with a late failure',
    (status) => {
      put(outboxes['pane-a'], 'draft', { to: '#2', text: 'Confirmed now' })
      const message = pollTeamChannel({ dir, teamId }).deliveries[0]
      const request = { dir, teamId, id: message.id, toId: 'pane-b' }
      expect(holdTeamDelivery({ ...request, state: status }).ok).toBe(true)
      expect(ackTeamDelivery(request).ok).toBe(true)
      expect(ackTeamDelivery(request).ok).toBe(true)
      expect(releaseTeamDelivery(request).ok).toBe(false)
      expect(holdTeamDelivery({ ...request, state: 'uncertain' }).ok).toBe(false)
      const polled = pollTeamChannel({ dir, teamId })
      expect(polled.held).toEqual([])
      expect(polled.deliveries).toHaveLength(1)
      expect(polled.deliveries[0]).toMatchObject({
        fromId: 'tessel',
        toId: 'pane-a',
        replyTo: message.id
      })
      expect(polled.history.find((m) => m.id === message.id).status).toBe('delivered')
    }
  )

  it('rejects invalid hold and release requests without altering the saved message', () => {
    put(outboxes['pane-a'], 'draft', { to: '#2', text: 'Keep pending' })
    const message = pollTeamChannel({ dir, teamId }).deliveries[0]
    const request = { dir, teamId, id: message.id, toId: 'pane-b' }
    const stateFile = join(dirname(dirname(outboxes['pane-a'])), 'state.json')
    const before = fs.readFileSync(stateFile, 'utf8')
    expect(holdTeamDelivery({ ...request, state: 'delivered' }).ok).toBe(false)
    for (const change of [{ id: 'missing' }, { toId: 'pane-c' }, { teamId: '../unsafe' }]) {
      expect(holdTeamDelivery({ ...request, ...change, state: 'inflight' }).ok).toBe(false)
      expect(releaseTeamDelivery({ ...request, ...change }).ok).toBe(false)
    }
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(before)
  })

  it('does not report a successful hold if persisting it fails', () => {
    put(outboxes['pane-a'], 'draft', { to: '#2', text: 'Cannot begin without a saved hold' })
    const message = pollTeamChannel({ dir, teamId }).deliveries[0]
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('Simulated disk failure')
    })
    expect(
      holdTeamDelivery({ dir, teamId, id: message.id, toId: 'pane-b', state: 'inflight' })
    ).toMatchObject({
      ok: false,
      error: 'Simulated disk failure'
    })
    rename.mockRestore()
    const polled = pollTeamChannel({ dir, teamId })
    expect(polled.held).toEqual([])
    expect(polled.deliveries.map((m) => m.id)).toEqual([message.id])
  })

  it('bounds delivered history without dropping an undelivered message', () => {
    const root = dirname(dirname(outboxes['pane-a']))
    const stateFile = join(root, 'state.json')
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    state.messages = Array.from({ length: 2001 }, (_, i) => ({
      id: `old-${i}`,
      fromId: 'pane-a',
      toId: 'pane-b',
      text: 'old',
      status: 'delivered',
      createdAt: i,
      deliveredAt: i
    }))
    state.messages.push({
      id: 'waiting',
      fromId: 'tessel',
      toId: 'pane-a',
      text: 'still waiting',
      status: 'pending'
    })
    state.messages.push({
      id: 'offline',
      fromId: 'pane-a',
      toId: 'pane-b',
      text: 'deliver later',
      status: 'pending'
    })
    state.messages.push({
      id: 'unresolved',
      fromId: 'pane-a',
      toId: 'pane-c',
      text: 'keep the draft after history is trimmed',
      status: 'uncertain',
      heldAt: 123
    })
    fs.writeFileSync(stateFile, JSON.stringify(state))
    expect(ackTeamDelivery({ dir, teamId, id: 'waiting', toId: 'pane-a' }).ok).toBe(true)
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    expect(saved.messages).toHaveLength(2002)
    expect(saved.messages.some((m) => m.id === 'waiting')).toBe(true)
    expect(saved.messages.find((m) => m.id === 'offline')?.status).toBe('pending')
    expect(pollTeamChannel({ dir, teamId }).held[0]).toMatchObject({
      id: 'unresolved',
      heldAt: 123
    })
    expect(saved.messages.some((m) => m.id === 'old-0')).toBe(false)
  })
})
