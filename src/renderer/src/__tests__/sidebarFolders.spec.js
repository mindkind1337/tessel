import { describe, it, expect } from 'vitest'
import { buildSidebarRows } from '../sidebarModel'
import { validSidebarFolders } from '../settings'

const project = (id, name) => ({ id, name, cwd: `C:/p/${id}`, panes: [], tree: null })

describe('sidebar groups of projects', () => {
  const projects = [project('a', 'A'), project('b', 'B'), project('c', 'C')]
  const types = (rows) => rows.map((r) => (r.type === 'folder' ? `folder:${r.label}` : r.type === 'header' ? `${r.folderId ? '  ' : ''}${r.label}` : null)).filter(Boolean)

  it('puts a group where its first project is, with its projects after it', () => {
    const rows = buildSidebarRows(projects, { folders: [{ id: 'f1', name: 'Web', projectIds: ['c', 'a'] }] })
    expect(types(rows)).toEqual(['folder:Web', '  A', '  C', 'B'])
    expect(rows.find((r) => r.type === 'folder').count).toBe(2)
  })
  it('folds the projects of a collapsed group into its row', () => {
    const rows = buildSidebarRows(projects, { folders: [{ id: 'f1', name: 'Web', projectIds: ['a', 'b'] }], collapsedGroups: ['folder:f1'] })
    expect(types(rows)).toEqual(['folder:Web', 'C'])
  })
  it('keeps an empty group and ignores a project that is gone', () => {
    const rows = buildSidebarRows(projects, { folders: [{ id: 'f1', name: 'Empty', projectIds: [] }, { id: 'f2', name: 'Old', projectIds: ['zz'] }] })
    expect(types(rows)).toEqual(['A', 'B', 'C', 'folder:Empty', 'folder:Old'])
  })
  it('does not group in the flat list', () => {
    const rows = buildSidebarRows(projects, { groupBy: 'none', folders: [{ id: 'f1', name: 'Web', projectIds: ['a'] }] })
    expect(rows.some((r) => r.type === 'folder')).toBe(false)
  })
})

describe('validSidebarFolders', () => {
  it('keeps one group per project and drops bad entries', () => {
    const out = validSidebarFolders([
      { id: 'x', name: ' Web ', projectIds: ['a', 'a', 'b', 3] },
      { id: 'y', name: 'Api', projectIds: ['b', 'c'] },
      { id: 'x', name: 'Dup', projectIds: [] },
      { id: 'z', name: '  ', projectIds: [] },
      null
    ])
    expect(out).toEqual([
      { id: 'x', name: 'Web', projectIds: ['a', 'b'] },
      { id: 'y', name: 'Api', projectIds: ['c'] }
    ])
    expect(validSidebarFolders('no')).toEqual([])
  })
})
