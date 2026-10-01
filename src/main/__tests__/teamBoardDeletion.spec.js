// A card deleted on the board must stay deleted: an older copy of the board
// (saved again by a window that still had it, or loaded back) never brings it
// back, and the copies published for the agents (team and workspace boards)
// lose it at once, so no agent keeps seeing (and asking about) a card that is
// gone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { loadBoard, saveTasks, loadTasks } from '../taskBoardPersistence'
import { publishTeamTasks, forgetPublishedTasks } from '../teamTasks'

const card = (id, extra = {}) => ({ id, title: `Card ${id}`, column: 'todo', paneId: null, wsId: 'ws-1', createdAt: 1, ...extra })

describe('a deleted card on the saved board', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-board-del-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is not written back by a save of an older copy of the board', () => {
    saveTasks(dir, [card('a'), card('b')], [])
    // The user deletes b: the board is saved without it.
    saveTasks(dir, [card('a')], [], ['b'])
    // A copy of the board from before the deletion is saved again (a window
    // that still had it): b must not come back, with the same id.
    saveTasks(dir, [card('a'), card('b')], [])
    const board = loadBoard(dir)
    expect(board.tasks.map((t) => t.id)).toEqual(['a'])
    expect(board.deleted).toEqual(['b'])
    expect(loadTasks(dir).map((t) => t.id)).toEqual(['a'])
  })

  it('is left out when the file still lists it', () => {
    fs.writeFileSync(join(dir, 'task-board.json'), JSON.stringify({ version: 2, tasks: [card('a'), card('b')], appliedRequests: [], deleted: ['b'] }))
    expect(loadBoard(dir).tasks.map((t) => t.id)).toEqual(['a'])
  })

  it('keeps the deletions of every save (they add up, the newest kept)', () => {
    saveTasks(dir, [card('a'), card('b'), card('c')], [], ['x'])
    saveTasks(dir, [card('a'), card('c')], [], ['b'])
    saveTasks(dir, [card('a')], [], ['c'])
    expect(loadBoard(dir).deleted).toEqual(['x', 'b', 'c'])
  })

  it('a board without deletions reads as before', () => {
    saveTasks(dir, [card('a')], ['team-1/p__1.json'])
    expect(loadBoard(dir)).toEqual({ tasks: [card('a')], appliedRequests: ['team-1/p__1.json'], deleted: [] })
  })
})

describe('forgetPublishedTasks', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-board-pub-'))
    fs.mkdirSync(join(dir, '.tessel', 'team-channel', 'team-1'), { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const read = (...p) => JSON.parse(fs.readFileSync(join(dir, '.tessel', ...p, 'tasks.json'), 'utf8')).tasks.map((t) => t.id)

  it('removes a deleted card from every published copy (team and workspace boards)', () => {
    const cards = [card('a'), card('b')]
    publishTeamTasks({ dir, teamId: 'team-1', tasks: cards })
    publishTeamTasks({ dir, board: 'ws-1', tasks: cards })
    publishTeamTasks({ dir, board: 'ws-2', tasks: [card('c')] })
    const res = forgetPublishedTasks({ dir, ids: ['b'] })
    expect(res.ok).toBe(true)
    expect(read('team-channel', 'team-1')).toEqual(['a'])
    expect(read('board', 'ws-1')).toEqual(['a'])
    expect(read('board', 'ws-2')).toEqual(['c'])
    expect(res.changed).toBe(2)
  })

  it('refuses a relative folder and ignores ids that are not card ids', () => {
    expect(forgetPublishedTasks({ dir: 'relative', ids: ['b'] }).ok).toBe(false)
    publishTeamTasks({ dir, board: 'ws-1', tasks: [card('a')] })
    expect(forgetPublishedTasks({ dir, ids: ['../x', 5] })).toEqual({ ok: true, changed: 0 })
    expect(read('board', 'ws-1')).toEqual(['a'])
  })

  it('a project with no published board is left alone', () => {
    const empty = fs.mkdtempSync(join(os.tmpdir(), 'tessel-board-none-'))
    try {
      expect(forgetPublishedTasks({ dir: empty, ids: ['a'] })).toEqual({ ok: true, changed: 0 })
      expect(fs.existsSync(join(empty, '.tessel'))).toBe(false)
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })
})
