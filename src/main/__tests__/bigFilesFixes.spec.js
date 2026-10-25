// @vitest-environment node
// The reviewed risks of the big-file changes: a board file that cannot be read
// at save time never wipes the history, an archive that cannot be written never
// stops the channel, the activity archive is bounded and safe with a wrong
// clock, and the caches check the file's identity.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { loadBoard, saveTasks, taskBoardFilePath } from '../taskBoardPersistence'
import { writeJsonSafe } from '../safeJson'
import { createActivityArchive } from '../activityArchive'
import { mergeSavedActivity, parseActivityLines, MAX_EVENTS } from '../../shared/activity'
import { ensureTeamChannel, pollTeamChannel, ackTeamDelivery, readTeamArchive, joinWithArchive } from '../teamChannel'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-fixes-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const card = (i) => ({ id: `t-${i}`, title: `card ${i}`, column: 'todo' })
const record = (i) => ({ id: `t-${i}`, title: `card ${i}`, doneAt: i })

describe('F1: a board file that cannot be read at save time', () => {
  const file = () => taskBoardFilePath(dir)

  it('a damaged file with a good .bak: the history comes from the .bak, not empty', () => {
    saveTasks(dir, [card(1)], [], [], [record(1), record(2)])
    saveTasks(dir, [card(1), card(2)], [], [], null) // the .bak is made here
    fs.writeFileSync(file(), '{ cut')
    saveTasks(dir, [card(1), card(2), card(3)], [], [], null)
    expect(loadBoard(dir).history.map((r) => r.id)).toEqual(['t-1', 't-2'])
  })

  it('unreadable and no copy: this process\'s last known history is kept', () => {
    saveTasks(dir, [card(1)], [], [], [record(1), record(2)])
    fs.writeFileSync(file(), '{ cut')
    fs.rmSync(`${file()}.bak`, { force: true })
    saveTasks(dir, [card(1), card(2)], [], [], null)
    expect(loadBoard(dir).history.map((r) => r.id)).toEqual(['t-1', 't-2'])
  })

  it('nothing known at all and no history sent: nothing is written, the save fails (the window sends the history again)', () => {
    fs.writeFileSync(file(), '{ cut')
    expect(() => saveTasks(dir, [card(1)], [], [], null)).toThrow(/history could not be read/)
    expect(fs.readFileSync(file(), 'utf8')).toBe('{ cut')
    // With the history sent, the save goes through.
    saveTasks(dir, [card(1)], [], [], [record(5)])
    expect(loadBoard(dir).history.map((r) => r.id)).toEqual(['t-5'])
  })

  it('a failed read is not remembered: once the file is good again its history is used', () => {
    fs.writeFileSync(file(), '{ cut')
    expect(() => saveTasks(dir, [card(1)], [], [], null)).toThrow()
    fs.writeFileSync(file(), JSON.stringify({ version: 2, tasks: [], appliedRequests: [], history: [record(7), record(8)] }))
    saveTasks(dir, [card(1)], [], [], null)
    expect(loadBoard(dir).history.map((r) => r.id)).toEqual(['t-7', 't-8'])
  })

  it('a file held by another program (read refused) falls back to what was last known', () => {
    saveTasks(dir, [card(1)], [], [], [record(1)])
    // Another window's save changes the file; then it is held.
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'))
    data.tasks.push(card(9))
    fs.writeFileSync(file(), JSON.stringify(data))
    const real = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
      if (String(p).startsWith(file())) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return real(p, ...rest)
    })
    saveTasks(dir, [card(1), card(2)], [], [], null)
    vi.restoreAllMocks()
    expect(loadBoard(dir).history.map((r) => r.id)).toEqual(['t-1'])
  })
})

describe('the board\'s deletions and history between saves (only Tessel writes the file)', () => {
  const file = () => taskBoardFilePath(dir)

  it('the board file removed while Tessel runs: the next save keeps the history it knows', () => {
    saveTasks(dir, [card(1)], [], ['gone-1'], [record(1), record(2)])
    fs.rmSync(file())
    fs.rmSync(`${file()}.bak`, { force: true })
    saveTasks(dir, [card(1)], [], [], null)
    const back = loadBoard(dir)
    expect(back.history.map((r) => r.id)).toEqual(['t-1', 't-2'])
    expect(back.deleted).toEqual(['gone-1'])
  })

  it('what loadBoard read is what a save keeps: no second read of the file, which may be held by then', () => {
    fs.writeFileSync(file(), JSON.stringify({ version: 2, tasks: [card(1)], appliedRequests: [], deleted: ['x'], history: [record(7), record(8)] }))
    expect(loadBoard(dir).history).toHaveLength(2)
    const real = fs.readFileSync
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
      if (String(p) === file()) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return real(p, ...rest)
    })
    saveTasks(dir, [card(1), card(2)], [], [], null)
    spy.mockRestore()
    const back = loadBoard(dir)
    expect(back.tasks.map((t) => t.id)).toEqual(['t-1', 't-2'])
    expect(back.history.map((r) => r.id)).toEqual(['t-7', 't-8'])
    expect(back.deleted).toEqual(['x'])
  })

  it('a file that cannot be looked at (not missing) is not taken for none', () => {
    saveTasks(dir, [card(1)], [], [], [record(1)])
    const real = fs.statSync
    const spy = vi.spyOn(fs, 'statSync').mockImplementation((p, ...rest) => {
      if (String(p) === file()) throw Object.assign(new Error('denied'), { code: 'EPERM' })
      return real(p, ...rest)
    })
    saveTasks(dir, [card(1), card(2)], [], [], null)
    spy.mockRestore()
    expect(loadBoard(dir).history.map((r) => r.id)).toEqual(['t-1'])
  })
})

describe('F8: caches check the file\'s identity', () => {
  it('writeJsonSafe does not skip a save when the file was replaced by another with the same size and time', () => {
    const f = join(dir, 'x.json')
    writeJsonSafe(f, { a: 'a' }, undefined, { indent: 0, skipIfSame: true })
    const st = fs.statSync(f)
    // Another file, same length, same time, other identity.
    const other = join(dir, 'other.json')
    fs.writeFileSync(other, '{"a":"b"}')
    fs.utimesSync(other, st.atime, st.mtime)
    fs.renameSync(other, f)
    expect(fs.statSync(f).size).toBe(st.size)
    expect(writeJsonSafe(f, { a: 'a' }, undefined, { indent: 0, skipIfSame: true })).toEqual({ written: true })
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ a: 'a' })
  })
})

describe('F3: an archive that cannot be written does not stop the channel', () => {
  const teamId = 'team-1'
  const members = [
    { id: 'pane-a', num: 1, title: 'Codex' },
    { id: 'pane-b', num: 2, title: 'Claude' }
  ]
  const delivered = (i) => ({ id: `m-${i}`, fromId: 'pane-a', toId: 'pane-b', text: 'x', status: 'delivered', createdAt: i, deliveredAt: i })
  const pending = { id: 'wait', fromId: 'tessel', toId: 'pane-a', text: 'later', status: 'pending', createdAt: 1 }

  function setup(count) {
    ensureTeamChannel({ dir, teamId, members })
    const root = join(dir, '.tessel', 'team-channel', teamId)
    const stateFile = join(root, 'state.json')
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    state.messages = [pending, ...Array.from({ length: count }, (_, i) => delivered(i))]
    fs.writeFileSync(stateFile, JSON.stringify(state))
    // The archive file is a folder: appending to it fails.
    fs.mkdirSync(join(root, 'archive.jsonl'))
    return { root, stateFile }
  }

  it('state.json is still written, untrimmed; the archive is retried at the next save', async () => {
    const { root, stateFile } = setup(700)
    expect(ackTeamDelivery({ dir, teamId, id: 'wait', toId: 'pane-a' }).ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).messages).toHaveLength(701)
    expect(pollTeamChannel({ dir, teamId }).ok).toBe(true)
    fs.rmdirSync(join(root, 'archive.jsonl'))
    expect(ensureTeamChannel({ dir, teamId, members }).ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).messages).toHaveLength(500)
    const archive = await readTeamArchive({ dir, teamId, limit: 5000 })
    expect(archive.messages).toHaveLength(201)
  })

  it('stays bounded while the archive fails: the oldest delivered go past 2000', () => {
    const { stateFile } = setup(2600)
    expect(ackTeamDelivery({ dir, teamId, id: 'wait', toId: 'pane-a' }).ok).toBe(true)
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    expect(saved.messages.filter((m) => m.status === 'delivered')).toHaveLength(2000)
    expect(saved.messages.at(-1).id).toBe('m-2599')
  })
})

describe('F9: the poll cache is bounded; the archive is read async and joins state.json by id', () => {
  it('the parse of a team not read for a while is dropped (16 kept)', () => {
    const members = [{ id: 'pane-a', num: 1, title: 'Codex' }]
    for (let i = 1; i <= 20; i++) ensureTeamChannel({ dir, teamId: `team-${i}`, members })
    for (let i = 1; i <= 20; i++) pollTeamChannel({ dir, teamId: `team-${i}` })
    const read = vi.spyOn(fs, 'readFileSync')
    pollTeamChannel({ dir, teamId: 'team-20' })
    expect(read.mock.calls.filter(([p]) => String(p).endsWith('state.json')).length).toBe(0)
    pollTeamChannel({ dir, teamId: 'team-1' })
    expect(read.mock.calls.filter(([p]) => String(p).endsWith('state.json')).length).toBe(1)
  })

  it('readTeamArchive answers a promise; joinWithArchive keeps each id once, state.json\'s copy last', async () => {
    const members = [{ id: 'pane-a', num: 1, title: 'Codex' }]
    ensureTeamChannel({ dir, teamId: 'team-1', members })
    const root = join(dir, '.tessel', 'team-channel', 'team-1')
    const m = (id, text) => ({ id, fromId: 'pane-a', toId: 'pane-a', text, status: 'delivered' })
    fs.writeFileSync(join(root, 'archive.jsonl'), ['a', 'b', 'c'].map((id) => JSON.stringify(m(id, 'old'))).join('\n'))
    const promise = readTeamArchive({ dir, teamId: 'team-1' })
    expect(promise).toBeInstanceOf(Promise)
    const archive = await promise
    const joined = joinWithArchive(archive.messages, [m('c', 'new'), m('d', 'new')])
    expect(joined.map((x) => `${x.id}:${x.text}`)).toEqual(['a:old', 'b:old', 'c:new', 'd:new'])
  })
})

describe('F5, F6, F7: the activity archive', () => {
  const DAY = 86400000
  const ev = (t, n) => ({ t, type: 'task', action: 'x', n })

  it('F5: reads the newest days first and stops once the window\'s limit is reached', async () => {
    const a = createActivityArchive(dir)
    const now = Date.UTC(2026, 9, 20, 12)
    fs.mkdirSync(a.dir, { recursive: true })
    for (let d = 0; d < 20; d++) {
      const t = now - d * DAY
      const lines = Array.from({ length: 4000 }, (_, i) => JSON.stringify(ev(t - i, d * 10000 + i))).join('\n')
      fs.writeFileSync(join(a.dir, `${new Date(t).toISOString().slice(0, 10)}.jsonl`), `\n${lines}\n`)
    }
    const read = vi.spyOn(fs.promises, 'readFile')
    const text = await a.read(now)
    const files = read.mock.calls.filter(([p]) => String(p).endsWith('.jsonl')).length
    expect(files).toBeLessThanOrEqual(6) // 5 days make 20,000 lines
    const events = parseActivityLines(text)
    expect(events.length).toBeGreaterThanOrEqual(MAX_EVENTS)
    // Oldest day read first in the text, the newest day is there.
    expect(events.some((e) => e.n === 0)).toBe(true)
    expect(events.some((e) => e.n >= 19 * 10000)).toBe(false)
  })

  it('F5: a day\'s file stops growing past its cap', async () => {
    const warn = vi.fn()
    const a = createActivityArchive(dir, { warn })
    const now = Date.UTC(2026, 9, 20, 12)
    await a.append([ev(now - 1000, 1)], now)
    const file = join(a.dir, '2026-10-20.jsonl')
    fs.appendFileSync(file, ' '.repeat(25 * 1024 * 1024))
    const size = fs.statSync(file).size
    expect(await a.append([ev(now - 500, 2)], now)).toMatchObject({ ok: true })
    expect(fs.statSync(file).size).toBe(size)
    expect(warn).toHaveBeenCalled()
  })

  it('F6: events with an impossible time are left out, the rest is archived, nothing throws', async () => {
    const a = createActivityArchive(dir)
    const now = Date.UTC(2026, 9, 20, 12)
    const res = await a.append([ev(1e16, 'huge'), ev(-1e16, 'negative'), ev(now - 90 * DAY, 'ancient'), ev(now + 10 * DAY, 'future'), ev(now - 1000, 'good')], now)
    expect(res).toMatchObject({ ok: true })
    expect(fs.readdirSync(a.dir)).toEqual(['2026-10-20.jsonl'])
    expect(parseActivityLines(await a.read(now)).map((e) => e.n)).toEqual(['good'])
  })

  it('F7: the merged list is in time order (stable for equal times)', () => {
    const now = Date.UTC(2026, 9, 20, 12)
    const archive = [ev(now - 3000, 'b'), ev(now - 2000, 'c')].map((e) => JSON.stringify(e)).join('\n')
    const live = [ev(now - 2500, 'x'), ev(now - 2000, 'd'), ev(now - 1000, 'e')]
    const out = mergeSavedActivity(JSON.stringify(live), archive, now)
    expect(out.events.map((e) => e.n)).toEqual(['b', 'x', 'c', 'd', 'e'])
  })

  it('F7: a clock far in the future at start deletes nothing; a sane clock deletes the old days', async () => {
    const a = createActivityArchive(dir)
    const now = Date.UTC(2026, 9, 20, 12)
    fs.mkdirSync(a.dir, { recursive: true })
    for (const d of [60, 40, 2, 1]) fs.writeFileSync(join(a.dir, `${new Date(now - d * DAY).toISOString().slice(0, 10)}.jsonl`), `\n${JSON.stringify(ev(now - d * DAY, d))}\n`)
    await a.read(now + 5 * 365 * DAY)
    await new Promise((r) => setTimeout(r, 50))
    expect(fs.readdirSync(a.dir)).toHaveLength(4)
    await a.read(now)
    await new Promise((r) => setTimeout(r, 50))
    expect(fs.readdirSync(a.dir)).toHaveLength(2)
  })
})
