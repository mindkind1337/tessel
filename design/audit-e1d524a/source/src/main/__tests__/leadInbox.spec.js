import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { ensureInbox, takeInbox, removeInbox } from '../leadInbox'

describe('lead inbox', () => {
  let dir
  const token = 'abcdef0123456789abcd'
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-lead-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('refuses bad folders and tokens', () => {
    expect(ensureInbox({ dir, token: '../x' }).ok).toBe(false)
    expect(ensureInbox({ dir: 'relative', token }).ok).toBe(false)
    expect(takeInbox({ dir, token: 'short' }).ok).toBe(false)
  })

  it('makes the folder with a guide', () => {
    const res = ensureInbox({ dir, token, guide: 'hello' })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(join(res.path, 'HOW-TO.md'), 'utf8')).toBe('hello')
  })

  it('takes requests oldest first and deletes them', () => {
    const { path } = ensureInbox({ dir, token })
    fs.writeFileSync(join(path, 'b.json'), '{"action":"message","to":"team","text":"2"}')
    fs.utimesSync(join(path, 'b.json'), new Date(), new Date(Date.now() + 1000))
    fs.writeFileSync(join(path, 'a.json'), '﻿{"action":"message","to":"team","text":"1"}')
    fs.utimesSync(join(path, 'a.json'), new Date(), new Date(Date.now() - 60000))
    fs.writeFileSync(join(path, 'note.txt'), 'ignored')
    const res = takeInbox({ dir, token })
    expect(res.items.map((i) => i.data.text)).toEqual(['1', '2'])
    expect(fs.readdirSync(path).sort()).toEqual(['note.txt'])
    expect(takeInbox({ dir, token }).items).toEqual([])
  })

  it('says when the folder is missing', () => {
    expect(takeInbox({ dir, token })).toEqual({ ok: true, items: [], missing: true })
  })

  it('waits for a half-written file, then reports it', () => {
    const { path } = ensureInbox({ dir, token })
    const f = join(path, 'x.json')
    fs.writeFileSync(f, '{"action":')
    expect(takeInbox({ dir, token }).items).toEqual([])
    fs.utimesSync(f, new Date(), new Date(Date.now() - 10000))
    const res = takeInbox({ dir, token })
    expect(res.items[0].error).toMatch(/not valid JSON/)
    expect(fs.existsSync(f)).toBe(false)
  })

  it('removes the inbox', () => {
    const { path } = ensureInbox({ dir, token })
    removeInbox({ dir, token })
    expect(fs.existsSync(path)).toBe(false)
  })
})
