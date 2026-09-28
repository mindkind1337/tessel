// @vitest-environment node
import { afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createResetHistory } from '../resetHistory'
const dirs = []
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-reset-history-'))
  dirs.push(dir)
  const file = path.join(dir, 'reset-history.json')
  const log = { info: vi.fn() }
  return { file, log, store: createResetHistory({ file, log, ...options }) }
}
const row = {
  id: 'request-1',
  at: 1000,
  provider: 'codex',
  accountId: null,
  accountLabel: 'Default',
  outcome: 'pending',
  creditsBefore: 2,
  windows: [{ label: 'Weekly', usedPct: 90, resetsAt: 2000 }]
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
describe('reset audit persistence', () => {
  it('survives restart, keeps interrupted attempts uncertain and upserts the final result', () => {
    const { file, store, log } = fixture()
    store.record(row)
    const restarted = createResetHistory({ file })
    expect(restarted.read().entries[0]).toMatchObject({ outcome: 'pending', uncertain: true })
    store.record({ ...row, outcome: 'reset', creditsAfter: 1, completedAt: 1500 })
    expect(restarted.read().entries).toHaveLength(1)
    expect(restarted.read().entries[0]).toMatchObject({
      outcome: 'reset',
      uncertain: false,
      creditsBefore: 2,
      creditsAfter: 1
    })
    expect(log.info).toHaveBeenCalledTimes(2)
  })
  it('allowlists disk and log fields, distinguishes system account from all accounts', () => {
    const { file, store, log } = fixture()
    store.record({
      ...row,
      token: 'secret',
      resetToken: 'secret',
      headers: { Authorization: 'secret' },
      error: 'secret'
    })
    store.record({ ...row, id: 'two', accountId: 'work', at: 2000 })
    expect(store.read().entries).toHaveLength(2)
    expect(store.read({ accountId: null }).entries).toHaveLength(1)
    expect(store.read({ accountId: 'work' }).entries[0].id).toBe('two')
    expect(fs.readFileSync(file, 'utf8')).not.toContain('secret')
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('secret')
  })
  it('keeps the old file intact on a failed atomic replace and cleans the temp', () => {
    const { file, store } = fixture()
    store.record(row)
    const before = fs.readFileSync(file, 'utf8')
    const broken = createResetHistory({
      file,
      io: {
        ...fs,
        renameSync: () => {
          throw new Error('EPERM')
        }
      }
    })
    expect(() => broken.record({ ...row, outcome: 'reset' })).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['reset-history.json'])
  })
  it('preserves a corrupt file and refuses to overwrite it', () => {
    const { file, store } = fixture()
    fs.writeFileSync(file, '{bad')
    expect(store.read().ok).toBe(false)
    expect(() => store.record(row)).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('{bad')
  })
  it('retains at most 500 records within 1 MiB', () => {
    const { file, store } = fixture()
    for (let i = 0; i < 505; i++)
      store.record({ ...row, id: `r-${i}`, at: i + 1, accountLabel: 'x'.repeat(10000) })
    const result = store.read()
    expect(result.entries).toHaveLength(500)
    expect(result.entries.at(-1).id).toBe('r-5')
    expect(fs.statSync(file).size).toBeLessThan(1024 * 1024)
  })
})
