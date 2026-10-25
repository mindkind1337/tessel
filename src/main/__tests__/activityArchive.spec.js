// @vitest-environment node
// The archive of the settled activity events (activityArchive.js): appended
// once per event in a file per day, read back oldest first, old days removed,
// the previous version's whole activity.json kept once.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createActivityArchive } from '../activityArchive'
import { mergeSavedActivity, parseActivityLines } from '../../shared/activity'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-actarch-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const DAY = 86400000
const ev = (t, n) => ({ t, type: 'task', action: 'x', n })

describe('activity archive', () => {
  it('appends events to a file per UTC day and reads them back in order', async () => {
    const a = createActivityArchive(dir)
    const day1 = Date.UTC(2026, 9, 18, 10)
    const day2 = Date.UTC(2026, 9, 19, 10)
    expect(await a.append([ev(day1, 1), ev(day1 + 1000, 2), ev(day2, 3)])).toMatchObject({ ok: true })
    expect(await a.append([ev(day2 + 5, 4)])).toMatchObject({ ok: true })
    expect(fs.readdirSync(a.dir).sort()).toEqual(['2026-10-18.jsonl', '2026-10-19.jsonl'])
    const text = await a.read(day2 + 1000)
    expect(parseActivityLines(text).map((e) => e.n)).toEqual([1, 2, 3, 4])
  })

  it('appends made at once stay in order and whole', async () => {
    const a = createActivityArchive(dir)
    const t = Date.UTC(2026, 9, 18, 10)
    await Promise.all(Array.from({ length: 20 }, (_, i) => a.append([ev(t + i, i)])))
    expect(parseActivityLines(await a.read(t)).map((e) => e.n)).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('a line cut by a kill does not spoil the next batch', async () => {
    const a = createActivityArchive(dir)
    const t = Date.UTC(2026, 9, 18, 10)
    await a.append([ev(t, 1)])
    fs.appendFileSync(join(a.dir, '2026-10-18.jsonl'), '{"t":1,"typ') // cut
    await a.append([ev(t + 1, 2)])
    expect(parseActivityLines(await a.read(t)).map((e) => e.n)).toEqual([1, 2])
  })

  it('removes the days older than the log keeps', async () => {
    const a = createActivityArchive(dir)
    const now = Date.UTC(2026, 9, 20, 12)
    await a.append([ev(now - 40 * DAY, 1), ev(now - 29 * DAY, 2), ev(now - DAY, 3)], now)
    expect(parseActivityLines(await a.read(now)).map((e) => e.n)).toEqual([2, 3])
    await new Promise((r) => setTimeout(r, 50))
    expect(fs.readdirSync(a.dir)).toHaveLength(2)
  })

  it('keeps the previous version\'s activity.json once, before the first archiving', async () => {
    fs.writeFileSync(join(dir, 'activity.json'), '[{"t":1,"type":"a"}]')
    const a = createActivityArchive(dir)
    await a.append([ev(Date.UTC(2026, 9, 18), 1)])
    expect(fs.readFileSync(join(dir, 'activity.json.before-archive'), 'utf8')).toBe('[{"t":1,"type":"a"}]')
    // A smaller activity.json later does not replace that copy.
    fs.writeFileSync(join(dir, 'activity.json'), '[]')
    const b = createActivityArchive(dir)
    await b.append([ev(Date.UTC(2026, 9, 18), 2)])
    expect(fs.readFileSync(join(dir, 'activity.json.before-archive'), 'utf8')).toBe('[{"t":1,"type":"a"}]')
  })

  it('reports a failed append, and later appends still work', async () => {
    const warn = vi.fn()
    const a = createActivityArchive(dir, { warn })
    const spy = vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(new Error('disk full'))
    expect(await a.append([ev(Date.UTC(2026, 9, 18), 1)])).toEqual({ ok: false, error: 'disk full' })
    spy.mockRestore()
    expect(await a.append([ev(Date.UTC(2026, 9, 18), 2)])).toMatchObject({ ok: true })
    expect(warn).toHaveBeenCalled()
  })

  it('an event sent again is stored once, also by a later process (the window resending, a save cut off)', async () => {
    const t = Date.UTC(2026, 9, 18, 10)
    const a = createActivityArchive(dir)
    await a.append([ev(t, 1), ev(t + 1, 2)], t)
    expect(await a.append([ev(t, 1), ev(t + 1, 2), ev(t + 2, 3), ev(t + 2, 3)], t)).toMatchObject({ ok: true, count: 1 })
    const b = createActivityArchive(dir) // Tessel restarted
    expect(await b.append([ev(t, 1), ev(t + 2, 3)], t)).toMatchObject({ ok: true, count: 0 })
    const lines = fs.readFileSync(join(a.dir, '2026-10-18.jsonl'), 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
  })

  it('a team message is stored once per status, whatever else its copies say', async () => {
    const t = Date.UTC(2026, 9, 18, 10)
    const msg = (status, title) => ({ t, type: 'message', msgId: 'm-1', status, agent: { title } })
    const a = createActivityArchive(dir)
    await a.append([msg('unread', 'Ada')], t)
    expect(await a.append([msg('unread', 'Ada (renamed)')], t)).toMatchObject({ count: 0 })
    expect(await a.append([msg('read', 'Ada')], t)).toMatchObject({ count: 1 })
    expect(await createActivityArchive(dir).append([msg('read', 'Ada again')], t)).toMatchObject({ count: 0 })
    const back = mergeSavedActivity('[]', await a.read(t), t)
    expect(back.events).toHaveLength(1)
    expect(back.events[0].status).toBe('read')
  })

  it('read: exact copies (left by earlier versions) are read once, count once toward the limit, and leave the file', async () => {
    const warn = vi.fn()
    const a = createActivityArchive(dir, { warn })
    const now = Date.UTC(2026, 9, 20, 12)
    fs.mkdirSync(a.dir, { recursive: true })
    // Two days of 12,000 events each, the newest stored five times over.
    const day = (d, n) => Array.from({ length: n }, (_, i) => JSON.stringify(ev(now - d * DAY + i, `${d}-${i}`)))
    const newest = day(0, 12000)
    fs.writeFileSync(join(a.dir, '2026-10-20.jsonl'), '\n' + [...newest, ...newest, ...newest, ...newest, ...newest].join('\n') + '\n')
    fs.writeFileSync(join(a.dir, '2026-10-19.jsonl'), '\n' + day(1, 12000).join('\n') + '\n')
    const events = parseActivityLines(await a.read(now))
    // Both days are read (24,000 different events), each once.
    expect(events).toHaveLength(24000)
    expect(new Set(events.map((e) => e.n)).size).toBe(24000)
    // The copies leave the file (in turn with the appends: one made meanwhile is kept).
    await a.append([ev(now + 5, 'new')], now)
    const lines = fs.readFileSync(join(a.dir, '2026-10-20.jsonl'), 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(12001)
    expect(new Set(lines).size).toBe(12001)
    expect(JSON.parse(lines.at(-1)).n).toBe('new')
    expect(warn).toHaveBeenCalledWith('activity', expect.stringMatching(/48000 copies removed/))
    // The file with no copies is left as it was.
    expect(fs.readFileSync(join(a.dir, '2026-10-19.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(12000)
  })

  it('an append made while a day loses its copies is not lost', async () => {
    const a = createActivityArchive(dir)
    const now = Date.UTC(2026, 9, 20, 12)
    await a.append([ev(now - 10, 1)], now)
    fs.appendFileSync(join(a.dir, '2026-10-20.jsonl'), JSON.stringify(ev(now - 10, 1)) + '\n') // an exact copy
    const reading = a.read(now)
    const appending = a.append([ev(now - 5, 2)], now)
    await Promise.all([reading, appending])
    await a.append([], now)
    await new Promise((r) => setTimeout(r, 20))
    const after = parseActivityLines(fs.readFileSync(join(a.dir, '2026-10-20.jsonl'), 'utf8')).map((e) => e.n)
    expect(after).toEqual([1, 2])
  })

  it('a missing archive reads as empty', async () => {
    expect(await createActivityArchive(dir).read()).toBe('')
  })

  it('migration: a whole activity.json (the previous version) is archived and read back with nothing lost', async () => {
    const now = Date.UTC(2026, 9, 20, 12)
    const all = Array.from({ length: 6000 }, (_, i) => ev(now - 10 * DAY + i * 120000, i))
    const a = createActivityArchive(dir)
    fs.writeFileSync(join(dir, 'activity.json'), JSON.stringify(all))
    // What the window does: everything settled goes to the archive, the rest stays live.
    await a.append(all.slice(0, 5990))
    const live = JSON.stringify(all.slice(5990))
    const back = mergeSavedActivity(live, await a.read(now), now)
    expect(back.events.map((e) => e.n)).toEqual(all.map((e) => e.n))
    expect(back.archived).toBe(5990)
    // A crash between the archive and the live file: the live file still holds everything.
    const crashed = mergeSavedActivity(JSON.stringify(all), await a.read(now), now)
    expect(crashed.events).toHaveLength(6000)
    expect(crashed.archived).toBe(5990)
  })
})
