import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import os from 'os'
import fs from 'fs'

import {
  TASK_BOARD_FILENAME,
  taskBoardFilePath,
  loadTasks,
  saveTasks
} from '../taskBoardPersistence'

// Sample tasks in the real taskModel schema from src/shared/taskModel.js:
// { id, title, column, paneId } (COLUMNS = todo|doing|review|done). Persistence
// is schema-agnostic, but exercising the real shape guards against accidental
// field loss on round-trip.
function sampleTasks() {
  return [
    { id: 't1', title: 'Wire IPC', column: 'todo', paneId: null },
    { id: 't2', title: 'Build board', column: 'doing', paneId: 'pane-7' },
    { id: 't3', title: 'Ship docs', column: 'done', paneId: null }
  ]
}

describe('taskBoardPersistence', () => {
  /** @type {string} */
  let dir

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'taskboard-test-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('taskBoardFilePath', () => {
    it('joins the userData directory with the task-board filename', () => {
      expect(taskBoardFilePath(dir)).toBe(join(dir, TASK_BOARD_FILENAME))
    })

    it('uses a filename distinct from workspace-layout.json (back-compat)', () => {
      expect(TASK_BOARD_FILENAME).not.toBe('workspace-layout.json')
    })

    it('throws when no directory is provided', () => {
      expect(() => taskBoardFilePath()).toThrow()
    })
  })

  describe('loadTasks', () => {
    it('returns [] when the file is absent', () => {
      expect(loadTasks(dir)).toEqual([])
    })

    it('returns [] when the file is empty or whitespace', () => {
      fs.writeFileSync(taskBoardFilePath(dir), '   \n', 'utf8')
      expect(loadTasks(dir)).toEqual([])
    })

    it('returns the persisted array', () => {
      const tasks = sampleTasks()
      fs.writeFileSync(taskBoardFilePath(dir), JSON.stringify(tasks), 'utf8')
      expect(loadTasks(dir)).toEqual(tasks)
    })

    it('accepts a { tasks: [...] } envelope for forward-compatibility', () => {
      const tasks = sampleTasks()
      fs.writeFileSync(taskBoardFilePath(dir), JSON.stringify({ version: 2, tasks }), 'utf8')
      expect(loadTasks(dir)).toEqual(tasks)
    })

    it('returns [] when the JSON is neither an array nor a task envelope', () => {
      fs.writeFileSync(taskBoardFilePath(dir), JSON.stringify({ foo: 'bar' }), 'utf8')
      expect(loadTasks(dir)).toEqual([])
    })

    it('throws on corrupt JSON so the caller can log it explicitly', () => {
      fs.writeFileSync(taskBoardFilePath(dir), '{ not json', 'utf8')
      expect(() => loadTasks(dir)).toThrow()
    })
  })

  describe('saveTasks', () => {
    it('persists tasks that round-trip through loadTasks', () => {
      const tasks = sampleTasks()
      saveTasks(dir, tasks)
      expect(loadTasks(dir)).toEqual(tasks)
    })

    it('writes the file to the expected path', () => {
      saveTasks(dir, sampleTasks())
      expect(fs.existsSync(taskBoardFilePath(dir))).toBe(true)
    })

    it('writes pretty-printed JSON for human-readable diffs', () => {
      saveTasks(dir, sampleTasks())
      expect(fs.readFileSync(taskBoardFilePath(dir), 'utf8')).toContain('\n  ')
    })

    it('overwrites prior contents', () => {
      saveTasks(dir, sampleTasks())
      saveTasks(dir, [])
      expect(loadTasks(dir)).toEqual([])
    })

    it('does not touch workspace-layout.json', () => {
      const layout = join(dir, 'workspace-layout.json')
      fs.writeFileSync(layout, '{"layout":true}', 'utf8')
      saveTasks(dir, sampleTasks())
      expect(fs.readFileSync(layout, 'utf8')).toBe('{"layout":true}')
    })

    it('throws on non-array input instead of failing silently', () => {
      expect(() => saveTasks(dir, { not: 'an array' })).toThrow()
      expect(() => saveTasks(dir, null)).toThrow()
    })
  })
})
