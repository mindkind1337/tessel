// @vitest-environment node
// The task board file (several MB, saved at every card change): compact,
// unchanged saves skipped, the .bak renewed once a minute, the deletions and
// the history read from the file only when it was changed by someone else,
// and a board written by the previous version read and kept.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { loadBoard, saveTasks, taskBoardFilePath } from '../taskBoardPersistence'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-bigboard-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const file = () => taskBoardFilePath(dir)
const card = (i) => ({ id: `t-${i}`, title: `card ${i}`, column: i % 2 ? 'done' : 'todo' })
const record = (i) => ({ id: `t-${i}`, title: `card ${i}`, doneAt: i })

describe('saveTasks on a big board', () => {
  it('writes compact JSON that loadBoard reads back whole', () => {
    const tasks = Array.from({ length: 300 }, (_, i) => card(i))
    const history = Array.from({ length: 100 }, (_, i) => record(i))
    saveTasks(dir, tasks, ['a/b'], ['gone'], history)
    expect(fs.readFileSync(file(), 'utf8')).not.toContain('\n')
    const back = loadBoard(dir)
    expect(back.tasks).toEqual(tasks)
    expect(back.appliedRequests).toEqual(['a/b'])
    expect(back.deleted).toEqual(['gone'])
    expect(back.history.map((r) => r.id)).toEqual(history.map((r) => r.id))
  })

  it('an unchanged board is not written again; a change is', () => {
    const tasks = [card(1), card(2)]
    saveTasks(dir, tasks, [], [], [record(1)])
    const before = fs.statSync(file()).mtimeMs
    const write = vi.spyOn(fs, 'writeFileSync')
    saveTasks(dir, tasks, [], [], null)
    expect(write).not.toHaveBeenCalled()
    expect(fs.statSync(file()).mtimeMs).toBe(before)
    saveTasks(dir, [card(1), { ...card(2), title: 'renamed' }], [], [], null)
    expect(write).toHaveBeenCalled()
    expect(loadBoard(dir).tasks[1].title).toBe('renamed')
  })

  it('a board another program changed is written over by the next save, not skipped', () => {
    const tasks = [card(1)]
    saveTasks(dir, tasks, [], [])
    fs.writeFileSync(file(), '{"version":2,"tasks":[],"appliedRequests":[]}')
    saveTasks(dir, tasks, [], [])
    expect(loadBoard(dir).tasks).toEqual(tasks)
  })

  it('a save without history keeps the history in the file, without reading the file again', () => {
    saveTasks(dir, [card(1)], [], [], [record(1), record(2)])
    saveTasks(dir, [card(1), card(2)], [], [], null) // renews the .bak: the file is read to check it
    const read = vi.spyOn(fs, 'readFileSync')
    saveTasks(dir, [card(1), card(2), card(3)], [], [], null)
    saveTasks(dir, [card(1), card(2), card(3), card(4)], [], [], null)
    // The history and the deletions come from memory: the file is not read at all.
    expect(read.mock.calls.filter(([p]) => String(p) === file())).toEqual([])
    expect(loadBoard(dir).history.map((r) => r.id)).toEqual(['t-1', 't-2'])
  })

  it('deletions made by another window (file changed meanwhile) are still added up', () => {
    saveTasks(dir, [card(1)], [], ['x'], [])
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'))
    data.deleted.push('y')
    fs.writeFileSync(file(), JSON.stringify(data))
    saveTasks(dir, [card(1)], [], ['z'], null)
    expect(loadBoard(dir).deleted).toEqual(['x', 'y', 'z'])
  })

  it('the .bak is the previous copy at the first change, then renewed at most once a minute', () => {
    saveTasks(dir, [card(1)], [], [])
    saveTasks(dir, [card(1), card(2)], [], [])
    const bak = `${file()}.bak`
    expect(JSON.parse(fs.readFileSync(bak, 'utf8')).tasks).toHaveLength(1)
    saveTasks(dir, [card(1), card(2), card(3)], [], [])
    expect(JSON.parse(fs.readFileSync(bak, 'utf8')).tasks).toHaveLength(1)
    // A minute later
    const old = new Date(Date.now() - 61 * 1000)
    fs.utimesSync(bak, old, old)
    saveTasks(dir, [card(1), card(2), card(3), card(4)], [], [])
    expect(JSON.parse(fs.readFileSync(bak, 'utf8')).tasks).toHaveLength(3)
  })

  it('a .bak dated in the future (the clock set back since) is renewed, not kept for ever', () => {
    saveTasks(dir, [card(1)], [], [])
    saveTasks(dir, [card(1), card(2)], [], [])
    const bak = `${file()}.bak`
    const future = new Date(Date.now() + 24 * 3600 * 1000)
    fs.utimesSync(bak, future, future)
    saveTasks(dir, [card(1), card(2), card(3)], [], [])
    expect(JSON.parse(fs.readFileSync(bak, 'utf8')).tasks).toHaveLength(2)
  })
})

describe('a board written by the previous version', () => {
  it('is read as it was, kept whole as .before-compact at the first save, then compact', () => {
    const tasks = Array.from({ length: 50 }, (_, i) => card(i))
    const old = { version: 2, tasks, appliedRequests: ['k'], deleted: ['d1'], history: [record(1), record(2)] }
    const text = JSON.stringify(old, null, 2)
    fs.writeFileSync(file(), text)
    expect(loadBoard(dir).history).toHaveLength(2)
    saveTasks(dir, tasks, ['k'], null, null)
    expect(fs.readFileSync(`${file()}.before-compact`, 'utf8')).toBe(text)
    expect(fs.readFileSync(file(), 'utf8')).not.toContain('\n')
    const back = loadBoard(dir)
    expect(back.tasks).toEqual(tasks)
    expect(back.deleted).toEqual(['d1'])
    expect(back.history.map((r) => r.id)).toEqual(['t-1', 't-2'])
    // Kept once: a later save does not replace it.
    saveTasks(dir, tasks.slice(1), ['k'], null, null)
    expect(fs.readFileSync(`${file()}.before-compact`, 'utf8')).toBe(text)
  })
})
