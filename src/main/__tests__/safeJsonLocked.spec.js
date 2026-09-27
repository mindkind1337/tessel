// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { readJsonSafe, writeJsonSafe } from '../safeJson'
import { loadBoard, loadTasks, saveTasks, taskBoardFilePath } from '../taskBoardPersistence'

describe('startup while the saved JSON cannot be read', () => {
  let dir, file
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-locked-load-'))
    file = join(dir, 'workspace-layout.json')
    vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  function denyRead(target, code = 'EBUSY', times = Infinity) {
    const original = fs.readFileSync
    return vi.spyOn(fs, 'readFileSync').mockImplementation((name, ...args) => {
      if (name === target && times-- > 0) throw Object.assign(new Error(code), { code })
      return original(name, ...args)
    })
  }
  function seed() {
    writeJsonSafe(file, { workspaces: ['previous'] })
    writeJsonSafe(file, { workspaces: ['previous', 'latest'] })
  }

  it.each(['EACCES', 'EBUSY', 'EPERM'])(
    'retries a temporary %s and loads the newest layout',
    (code) => {
      seed()
      denyRead(file, code, 2)
      expect(readJsonSafe(file)).toMatchObject({
        from: 'file',
        data: { workspaces: ['previous', 'latest'] }
      })
      expect(fs.readdirSync(dir).some((n) => n.includes('.corrupt-'))).toBe(false)
    }
  )

  it('keeps a backup read-only until a successful primary load, even after the lock disappears', () => {
    seed()
    const primary = fs.readFileSync(file, 'utf8')
    const backup = fs.readFileSync(`${file}.bak`, 'utf8')
    const denied = denyRead(file)
    const loaded = readJsonSafe(file, undefined, { onLocked: 'backup' })
    expect(loaded).toEqual({
      data: { workspaces: ['previous'] },
      from: 'backup',
      locked: true,
      corrupt: null
    })
    denied.mockRestore()
    expect(() => writeJsonSafe(file, loaded.data)).toThrow(/not been loaded/)
    expect(fs.readFileSync(file, 'utf8')).toBe(primary)
    expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe(backup)
    expect(fs.readdirSync(dir).some((n) => n.includes('.corrupt-'))).toBe(false)
    const fresh = readJsonSafe(file)
    expect(fresh.data.workspaces).toEqual(['previous', 'latest'])
    writeJsonSafe(file, { ...fresh.data, theme: 'warp' })
    expect(readJsonSafe(file).data).toEqual({ workspaces: ['previous', 'latest'], theme: 'warp' })
  })

  it('protects strict callers from a save after their failed load', () => {
    seed()
    const denied = denyRead(file)
    expect(() => readJsonSafe(file)).toThrow('EBUSY')
    denied.mockRestore()
    expect(() => writeJsonSafe(file, {})).toThrow(/not been loaded/)
    expect(readJsonSafe(file).data.workspaces).toEqual(['previous', 'latest'])
  })

  it('signals a locked first save with no backup instead of treating it as a new empty layout', () => {
    writeJsonSafe(file, { workspaces: ['only'] })
    const denied = denyRead(file)
    expect(readJsonSafe(file, undefined, { onLocked: 'backup' })).toEqual({
      data: null,
      from: null,
      locked: true,
      corrupt: null
    })
    denied.mockRestore()
    expect(() => writeJsonSafe(file, {})).toThrow(/not been loaded/)
    expect(readJsonSafe(file).data.workspaces).toEqual(['only'])
  })

  it('keeps the board and request ledger together and propagates the lock through both load APIs', () => {
    const old = [{ id: 'old', column: 'doing' }]
    const latest = [...old, { id: 'new', column: 'review' }]
    saveTasks(dir, old, ['first'])
    saveTasks(dir, latest, ['first', 'second'])
    const boardFile = taskBoardFilePath(dir)
    const denied = denyRead(boardFile)
    const readonly = { tasks: old, appliedRequests: ['first'], locked: true }
    expect(loadBoard(dir)).toEqual(readonly)
    expect(loadTasks(dir)).toEqual(readonly)
    denied.mockRestore()
    expect(() => saveTasks(dir, [], [])).toThrow(/not been loaded/)
    expect(loadBoard(dir)).toEqual({ tasks: latest, appliedRequests: ['first', 'second'] })
    saveTasks(dir, latest, ['first', 'second'])
  })
})
