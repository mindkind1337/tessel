// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { addNotices, removeNotice } from '../teamNotices'

describe('durable notice retries', () => {
  let dir, file
  const teamId = 'team-notices'
  const notice = { id: 'stable123', toId: 'pane-a', text: 'Please review this task.' }
  const add = (notices) => addNotices({ dir, teamId, notices })
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-notice-retry-'))
    file = join(dir, '.tessel', 'team-channel', teamId, 'notices.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('uses caller ids and accepts the same retry without a duplicate', () => {
    expect(add([notice]).ok).toBe(true)
    expect(add([notice]).ok).toBe(true)
    expect(read().notices).toMatchObject([notice])
  })

  it('does not recreate a notice read before a lost IPC response is retried', () => {
    add([notice])
    expect(removeNotice({ dir, teamId, id: notice.id })).toBe(true)
    expect(read().notices).toEqual([])
    expect(add([notice]).ok).toBe(true)
    expect(read().notices).toEqual([])
  })

  it('refuses an id reused for different contents or recipients without changing the file', () => {
    add([notice])
    const before = fs.readFileSync(file, 'utf8')
    for (const changed of [
      { ...notice, text: 'A different request' },
      { ...notice, toId: 'pane-b' }
    ]) {
      expect(add([changed]).ok).toBe(false)
      expect(fs.readFileSync(file, 'utf8')).toBe(before)
    }
  })

  it('rejects an invalid supplied id instead of silently replacing it on every retry', () => {
    expect(add([{ ...notice, id: '../bad' }]).ok).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('never drops unread notices when the queue is full, and retries after space is freed', () => {
    const batch = Array.from({ length: 500 }, (_, i) => ({
      id: `notice${String(i).padStart(4, '0')}`,
      toId: 'pane-a',
      text: `Notice ${i}`
    }))
    expect(add(batch).ok).toBe(true)
    const before = fs.readFileSync(file, 'utf8')
    expect(add([notice])).toMatchObject({ ok: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    // A retry of already accepted entries needs no free slot.
    expect(add([batch[0]]).ok).toBe(true)
    expect(read().notices).toHaveLength(500)
    removeNotice({ dir, teamId, id: batch[0].id })
    expect(add([notice]).ok).toBe(true)
    expect(read().notices).toHaveLength(500)
    expect(read().notices[0].id).toBe(batch[1].id)
  })

  it('rejects a whole overflowing batch so no recipient gets only part of the request', () => {
    const batch = Array.from({ length: 499 }, (_, i) => ({ toId: 'pane-a', text: `Notice ${i}` }))
    add(batch)
    expect(add([notice, { ...notice, id: 'stable456', toId: 'pane-b' }]).ok).toBe(false)
    expect(read().notices).toHaveLength(499)
    expect(add([notice]).ok).toBe(true)
    expect(read().notices).toHaveLength(500)
  })
})
