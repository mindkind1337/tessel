// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { ensureTeamChannel, pollTeamChannel } from '../teamChannel'
import { takeTeamRequests } from '../teamTasks'
import { ensureInbox, takeInbox } from '../leadInbox'
import { addNotices, removeNotice } from '../teamNotices'
import { takeTeamAcks } from '../teamAcks'

describe('team queues during filesystem read failures', () => {
  let dir, root, box
  const teamId = 'team-io'
  const members = [
    { id: 'pane-a', num: 1, title: 'Codex' },
    { id: 'pane-b', num: 2, title: 'Claude' }
  ]
  const token = 'abcdef0123456789abcd'
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-queue-io-'))
    root = join(dir, '.tessel', 'team-channel', teamId)
    box = ensureTeamChannel({ dir, teamId, members }).outboxes[0].outbox
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  function oldJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value))
    const old = new Date(Date.now() - 60000)
    fs.utimesSync(file, old, old)
  }
  function denyRead(file, code) {
    const read = fs.readFileSync
    return vi.spyOn(fs, 'readFileSync').mockImplementation((name, ...args) => {
      if (name === file) throw Object.assign(new Error(`temporary ${code}`), { code })
      return read(name, ...args)
    })
  }

  for (const code of ['EACCES', 'EBUSY', 'EPERM']) {
    it(`preserves an old outbox message after ${code}, then delivers it once`, () => {
      const file = join(box, 'message.json')
      oldJson(file, { to: '#2', text: 'Keep this message.' })
      const locked = denyRead(file, code)
      const first = pollTeamChannel({ dir, teamId })
      locked.mockRestore()
      expect(first.ok).toBe(true)
      expect(first.deliveries).toEqual([])
      expect(fs.existsSync(file)).toBe(true)
      expect(pollTeamChannel({ dir, teamId }).deliveries.map((m) => m.text)).toEqual([
        'Keep this message.'
      ])
      expect(pollTeamChannel({ dir, teamId }).deliveries).toHaveLength(1)
    })

    it(`preserves a board request after ${code}`, () => {
      const folder = join(root, 'requests')
      fs.mkdirSync(folder)
      const file = join(folder, 'pane-a__request.json')
      oldJson(file, { action: 'add', title: 'Keep this card', column: 'doing' })
      const locked = denyRead(file, code)
      const first = takeTeamRequests({ dir, teamId })
      locked.mockRestore()
      expect(first).toMatchObject({ ok: true, requests: [], refused: [] })
      expect(fs.existsSync(file)).toBe(true)
      expect(takeTeamRequests({ dir, teamId }).requests).toMatchObject([
        { title: 'Keep this card' }
      ])
    })

    it(`preserves a lead request after ${code}`, () => {
      const folder = ensureInbox({ dir, token }).path
      const file = join(folder, 'lead.json')
      oldJson(file, { action: 'message', to: 'team', text: 'Keep the lead request.' })
      const locked = denyRead(file, code)
      const first = takeInbox({ dir, token })
      locked.mockRestore()
      expect(first.items).toEqual([])
      expect(fs.existsSync(file)).toBe(true)
      expect(takeInbox({ dir, token }).items).toMatchObject([
        { data: { text: 'Keep the lead request.' } }
      ])
    })

    it(`does not roll the channel back to an older backup after ${code}`, () => {
      oldJson(join(box, 'message.json'), { to: '#2', text: 'Only in the newest state.' })
      expect(pollTeamChannel({ dir, teamId }).deliveries).toHaveLength(1)
      const file = join(root, 'state.json')
      const before = fs.readFileSync(file, 'utf8')
      const locked = denyRead(file, code)
      const blocked = pollTeamChannel({ dir, teamId })
      locked.mockRestore()
      expect(blocked.ok).toBe(false)
      expect(fs.readFileSync(file, 'utf8')).toBe(before)
      expect(pollTeamChannel({ dir, teamId }).deliveries.map((m) => m.text)).toEqual([
        'Only in the newest state.'
      ])
      expect(fs.readdirSync(root).some((name) => name.includes('.corrupt-'))).toBe(false)
    })
  }

  it('does not overwrite existing notices when their file cannot be read', () => {
    addNotices({ dir, teamId, notices: [{ toId: 'pane-a', text: 'Original notice' }] })
    const file = join(root, 'notices.json')
    const before = fs.readFileSync(file, 'utf8')
    const locked = denyRead(file, 'EACCES')
    expect(() =>
      addNotices({ dir, teamId, notices: [{ toId: 'pane-a', text: 'New notice' }] })
    ).toThrow()
    locked.mockRestore()
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('does not confirm removal of a notice that could not be read', () => {
    addNotices({ dir, teamId, notices: [{ toId: 'pane-a', text: 'Original notice' }] })
    const file = join(root, 'notices.json')
    const id = JSON.parse(fs.readFileSync(file, 'utf8')).notices[0].id
    const locked = denyRead(file, 'EBUSY')
    expect(removeNotice({ dir, teamId, id })).toBe(false)
    locked.mockRestore()
    expect(removeNotice({ dir, teamId, id })).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).notices).toEqual([])
  })

  it('retries a notice acknowledgement after a failed read instead of discarding it', () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    addNotices({ dir, teamId, notices: [{ toId: 'pane-a', text: 'Already read by the agent' }] })
    const file = join(root, 'notices.json')
    const id = JSON.parse(fs.readFileSync(file, 'utf8')).notices[0].id
    const acks = join(root, 'acks')
    fs.mkdirSync(acks)
    fs.writeFileSync(join(acks, 'ack.json'), JSON.stringify({ id: `n-${id}`, toId: 'pane-a' }))
    const locked = denyRead(file, 'EACCES')
    expect(takeTeamAcks({ dir, teamId }).count).toBe(0)
    locked.mockRestore()
    clock.mockReturnValue(now + 61000)
    expect(takeTeamAcks({ dir, teamId }).count).toBe(1)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).notices).toEqual([])
  })
})
