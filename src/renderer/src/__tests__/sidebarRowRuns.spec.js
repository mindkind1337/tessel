// The sidebar frames the current project and everything under it as one block.
import { describe, expect, it } from 'vitest'
import { sidebarRowRuns } from '../sidebarModel'

const a = { id: 'a' }
const b = { id: 'b' }

describe('sidebarRowRuns', () => {
  it('keeps a header with the rows under it', () => {
    const rows = [
      { type: 'header', key: 'repo:a', project: a },
      { type: 'card', key: 'c1', project: a },
      { type: 'others', key: 'repo:a:others', project: a },
      { type: 'header', key: 'repo:b', project: b },
      { type: 'card', key: 'c2', project: b }
    ]
    const runs = sidebarRowRuns(rows)
    expect(runs.map((r) => r.project)).toEqual([a, b])
    expect(runs.map((r) => r.rows.map((x) => x.key))).toEqual([['repo:a', 'c1', 'repo:a:others'], ['repo:b', 'c2']])
  })
  it('leaves a group of projects out of the frame', () => {
    const runs = sidebarRowRuns([
      { type: 'folder', key: 'folder:f' },
      { type: 'header', key: 'repo:a', project: a, folderId: 'f' }
    ])
    expect(runs.map((r) => r.project)).toEqual([null, a])
  })
  it('has no project to frame in the flat list', () => {
    const runs = sidebarRowRuns([
      { type: 'header', key: 'all', project: null },
      { type: 'card', key: 'c1', project: a },
      { type: 'card', key: 'c2', project: b }
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0].project).toBe(null)
  })
  it('is empty with no rows', () => {
    expect(sidebarRowRuns([])).toEqual([])
  })
})
