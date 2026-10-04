// Clean up worktrees: rows, risks, default selection and the removal run.
import { describe, it, expect } from 'vitest'
import {
  cleanupRows,
  visibleRows,
  defaultSelection,
  toggleSelection,
  pruneSelection,
  removeRows,
  riskLabel,
  INACTIVE_MS
} from '../worktreeCleanup'

const NOW = 10_000_000_000_000
const OLD = NOW - INACTIVE_MS - 1000
const ev = (path, extra = {}) => ({
  path,
  branch: path.split('\\').pop(),
  head: 'abc',
  detached: false,
  locked: false,
  missing: false,
  onDefault: false,
  dirty: false,
  changes: 0,
  merged: true,
  ahead: 0,
  behind: 2,
  lastCommitAt: OLD,
  lastCommitSubject: 'x',
  activityAt: OLD,
  ...extra
})
const project = (panes = []) => ({ id: 'ws1', name: 'Shop', cwd: 'C:\\repo', branch: 'main', panes, copies: [], worktrees: [] })
const rowsOf = (items, opts = {}) => cleanupRows({ defaultBranch: 'main', items }, { project: project(opts.panes), tasks: opts.tasks || [], now: NOW })
const by = (rows, name) => rows.find((r) => r.path.endsWith(name))

describe('cleanupRows', () => {
  it('a folder left behind by a failed removal: risky (said why), listed, ticked only by hand', () => {
    const rows = rowsOf([ev('C:\\w\\left',{ leftover: true, dirty: null, merged: true, activityAt: NOW - 1000, lastCommitAt: NOW - 1000 })])
    expect(rows[0]).toMatchObject({ removable: true, safe: false, risks: ['leftover'], force: false })
    expect(visibleRows(rows)).toHaveLength(1)
    expect(riskLabel('leftover', rows[0])).toBe('Folder left behind by a removal that failed')
  })

  it('a clean, merged worktree with no pane is safe and needs no force', () => {
    const [r] = rowsOf([ev('C:\\w\\done')])
    expect(r).toMatchObject({ safe: true, removable: true, risks: [], force: false, inactive: true, label: 'done' })
  })

  it('dirty, unmerged or unknown evidence is risky and needs force', () => {
    const rows = rowsOf([
      ev('C:\\w\\dirty', { dirty: true, changes: 3 }),
      ev('C:\\w\\ahead', { merged: false, ahead: 2 }),
      ev('C:\\w\\unknown', { dirty: null, merged: null })
    ])
    expect(by(rows, 'dirty')).toMatchObject({ safe: false, removable: true, risks: ['dirty'], force: true })
    expect(by(rows, 'ahead')).toMatchObject({ risks: ['unmerged'], force: true })
    expect(by(rows, 'unknown').risks).toEqual(['unknown-status', 'unknown-merge'])
    expect(riskLabel('dirty', by(rows, 'dirty'))).toBe('3 uncommitted changes')
    expect(riskLabel('unmerged', by(rows, 'ahead'))).toBe('2 commits not merged')
  })

  it('a folder already gone is not "unknown status" (nothing on disk to lose)', () => {
    const [r] = rowsOf([ev('C:\\w\\gone', { missing: true, dirty: null })])
    expect(r).toMatchObject({ safe: true, risks: [] })
  })

  it('open panes or agents make it risky, closed first, no force for them alone', () => {
    const rows = rowsOf([ev('C:\\w\\busy')], {
      panes: [
        { id: 'p1', num: 1, kind: 'agent', title: 'a', agentId: 'claude', state: 'working', copyPath: 'C:\\w\\busy', copyBranch: 'busy' },
        { id: 'p2', num: 2, kind: 'shell', title: 'sh', copyPath: 'C:\\w\\busy' }
      ]
    })
    expect(rows[0]).toMatchObject({ safe: false, panes: 2, agents: 1, risks: ['open-panes'], force: false, paneIds: ['p1', 'p2'] })
    expect(riskLabel('open-panes', rows[0])).toBe('2 open panes (1 agents): closed first')
    // Their activity counts.
    expect(rows[0].activityAt).toBeGreaterThanOrEqual(OLD)
  })

  it('the copy of a task not merged yet is risky; a merged task is not', () => {
    const tasks = [
      { id: 'T1', title: 'Login', worktree: { path: 'c:/w/task' } },
      { id: 'T2', title: 'Old', worktree: { path: 'C:\\w\\merged' }, mergedAt: 5 }
    ]
    const rows = rowsOf([ev('C:\\w\\task'), ev('C:\\w\\merged')], { tasks })
    expect(by(rows, 'task')).toMatchObject({ risks: ['task'], taskId: 'T1', taskTitle: 'Login' })
    expect(by(rows, 'merged')).toMatchObject({ safe: true, taskId: null })
  })

  it('detached, default-branch and locked worktrees are blocked', () => {
    const rows = rowsOf([
      ev('C:\\w\\det', { detached: true, branch: '' }),
      ev('C:\\w\\main2', { onDefault: true }),
      ev('C:\\w\\lock', { locked: true })
    ])
    expect(rows.map((r) => r.blocker)).toEqual(['detached', 'default-branch', 'locked'])
    expect(rows.every((r) => !r.removable && !r.safe)).toBe(true)
    expect(by(rows, 'det').label).toBe('det')
  })
})

describe('visibleRows and selection', () => {
  const rows = rowsOf([
    ev('C:\\w\\recent-unmerged', { merged: false, ahead: 1, activityAt: NOW - 1000, lastCommitAt: NOW - 1000 }),
    ev('C:\\w\\recent-merged', { activityAt: NOW - 1000 }),
    ev('C:\\w\\old-dirty', { dirty: true, changes: 1 }),
    ev('C:\\w\\old-clean'),
    ev('C:\\w\\det', { detached: true })
  ])

  it('lists merged, inactive or missing ones; Show all lists every one', () => {
    const names = visibleRows(rows).map((r) => r.label)
    expect(names).not.toContain('recent-unmerged')
    expect(names[0]).toBe('old-clean') // safe and oldest first
    expect(visibleRows(rows, { showAll: true })).toHaveLength(5)
  })

  it('selects only the safe ones by default', () => {
    expect([...defaultSelection(visibleRows(rows))].sort()).toEqual(['C:\\w\\old-clean', 'C:\\w\\recent-merged'])
  })

  it('a risky row needs an explicit tick; a blocked one can never be ticked', () => {
    const dirty = by(rows, 'old-dirty')
    let sel = toggleSelection(new Set(), dirty)
    expect(sel.has(dirty.key)).toBe(true)
    sel = toggleSelection(sel, dirty)
    expect(sel.has(dirty.key)).toBe(false)
    expect(toggleSelection(new Set(), by(rows, 'det')).size).toBe(0)
  })

  it('a rescan drops selected rows that are gone or blocked', () => {
    const sel = new Set(['C:\\w\\old-clean', 'C:\\w\\vanished', 'C:\\w\\det'])
    expect([...pruneSelection(sel, rows)]).toEqual(['C:\\w\\old-clean'])
  })
})

describe('removeRows', () => {
  it('removes one at a time, in order, and goes on after a failure', async () => {
    const rows = rowsOf([ev('C:\\w\\a'), ev('C:\\w\\b'), ev('C:\\w\\c')])
    const log = []
    let running = 0
    const remove = async (row) => {
      running++
      expect(running).toBe(1)
      await new Promise((r) => setTimeout(r, 5))
      running--
      if (row.label === 'b') return { ok: false, error: 'busy file' }
      return { ok: true }
    }
    const res = await removeRows(rows, remove, (key, state, error) => log.push([key.split('\\').pop(), state, error]))
    expect(res).toEqual({ done: ['C:\\w\\a', 'C:\\w\\c'], failed: [{ key: 'C:\\w\\b', error: 'busy file' }] })
    expect(log).toEqual([
      ['a', 'removing', undefined],
      ['a', 'done', undefined],
      ['b', 'removing', undefined],
      ['b', 'failed', 'busy file'],
      ['c', 'removing', undefined],
      ['c', 'done', undefined]
    ])
  })

  it('a thrown error or an empty answer is a failure with a message', async () => {
    const rows = rowsOf([ev('C:\\w\\a'), ev('C:\\w\\b')])
    const res = await removeRows(rows, async (row) => {
      if (row.label === 'a') throw new Error('ipc down')
      return null
    })
    expect(res.failed).toEqual([
      { key: 'C:\\w\\a', error: 'ipc down' },
      { key: 'C:\\w\\b', error: 'Unknown error' }
    ])
  })
})
