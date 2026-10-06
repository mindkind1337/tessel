// The Files tree's row model: compact folders, indentation, indent guides.
import { describe, expect, it } from 'vitest'
import { buildRows, toggledPaths, soleSubfolder, activeGuide, segmentOf, rowPadding, guideX, ROW_HEIGHT, INDENT, TWISTIE } from '../explorerRows'

const R = 'C:\\p'
const d = (rel) => ({ name: rel.split('\\').pop(), path: `${R}\\${rel}`, dir: true })
const f = (rel) => ({ name: rel.split('\\').pop(), path: `${R}\\${rel}`, dir: false })
const P = (rel) => `${R}\\${rel}`

// a/b/c (each a sole folder) holding x.txt and y.txt; top.md beside a.
function tree() {
  return {
    [R]: { entries: [d('a'), f('top.md')] },
    [P('a')]: { entries: [d('a\\b')] },
    [P('a\\b')]: { entries: [d('a\\b\\c')] },
    [P('a\\b\\c')]: { entries: [f('a\\b\\c\\x.txt'), f('a\\b\\c\\y.txt')] }
  }
}
const labels = (rows) => rows.map((r) => '  '.repeat(r.depth) + r.chain.map((e) => e.name).join('/'))

describe('compact folders', () => {
  it('a chain of sole folders is one row, standing for its last folder', () => {
    const { rows, index } = buildRows({ root: R, nodes: tree(), open: {} })
    expect(labels(rows)).toEqual(['a/b/c', 'top.md'])
    expect(rows[0].path).toBe(P('a\\b\\c'))
    expect(rows[0].open).toBe(false)
    // Every folder of the row finds it.
    expect([P('a'), P('a\\b'), P('a\\b\\c')].map((p) => index.get(p))).toEqual([0, 0, 0])
    expect(index.get(P('top.md'))).toBe(1)
  })

  it('the row is open when its last folder is; its children follow one level down', () => {
    const open = { [P('a')]: true, [P('a\\b')]: true, [P('a\\b\\c')]: true }
    const { rows } = buildRows({ root: R, nodes: tree(), open })
    expect(labels(rows)).toEqual(['a/b/c', '  x.txt', '  y.txt', 'top.md'])
  })

  it('off: one row per folder', () => {
    const open = { [P('a')]: true, [P('a\\b')]: true, [P('a\\b\\c')]: true }
    const { rows } = buildRows({ root: R, nodes: tree(), open, compact: false })
    expect(labels(rows)).toEqual(['a', '  b', '    c', '      x.txt', '      y.txt', 'top.md'])
  })

  it('a folder not read yet ends the chain (nothing is read to build a row)', () => {
    const nodes = tree()
    delete nodes[P('a\\b')]
    delete nodes[P('a\\b\\c')]
    expect(labels(buildRows({ root: R, nodes, open: {} }).rows)).toEqual(['a/b', 'top.md'])
  })

  it('the chain breaks when a folder gets a second child', () => {
    const nodes = tree()
    const open = { [P('a')]: true, [P('a\\b')]: true, [P('a\\b\\c')]: true }
    nodes[P('a\\b')] = { entries: [d('a\\b\\c'), f('a\\b\\new.js')] }
    expect(labels(buildRows({ root: R, nodes, open }).rows)).toEqual(['a/b', '  c', '    x.txt', '    y.txt', '  new.js', 'top.md'])
  })

  it('a file never joins, and a folder holding one file stays alone', () => {
    const nodes = { [R]: { entries: [d('a')] }, [P('a')]: { entries: [f('a\\only.txt')] } }
    expect(labels(buildRows({ root: R, nodes, open: { [P('a')]: true } }).rows)).toEqual(['a', '  only.txt'])
  })

  it('hidden entries do not count: a folder whose other child is hidden joins', () => {
    const nodes = tree()
    nodes[P('a')] = { entries: [d('a\\b'), f('a\\ignored.log')] }
    const hidden = (e) => e.name === 'ignored.log'
    expect(labels(buildRows({ root: R, nodes, open: {}, hidden }).rows)).toEqual(['a/b/c', 'top.md'])
    expect(labels(buildRows({ root: R, nodes, open: {} }).rows)).toEqual(['a', 'top.md'])
  })

  it('a folder being edited stands on its own row', () => {
    const open = { [P('a')]: true, [P('a\\b')]: true, [P('a\\b\\c')]: true }
    const rows = buildRows({ root: R, nodes: tree(), open, noJoin: new Set([P('a\\b')]) }).rows
    expect(labels(rows)).toEqual(['a', '  b', '    c', '      x.txt', '      y.txt', 'top.md'])
    const rows2 = buildRows({ root: R, nodes: tree(), open, noJoin: new Set([P('a')]) }).rows
    expect(labels(rows2)).toEqual(['a', '  b/c', '    x.txt', '    y.txt', 'top.md'])
  })

  it('expand / collapse: all the folders of the row, and the sole sub-folder next', () => {
    const { rows } = buildRows({ root: R, nodes: tree(), open: {} })
    expect(toggledPaths(rows[0])).toEqual([P('a'), P('a\\b'), P('a\\b\\c')])
    expect(toggledPaths(rows[1])).toEqual([])
    const nodes = tree()
    expect(soleSubfolder(nodes, P('a'))).toEqual(d('a\\b'))
    expect(soleSubfolder(nodes, P('a\\b\\c'))).toBe(null)
    expect(soleSubfolder(nodes, P('unknown'))).toBe(null)
  })

  it('selection of a segment', () => {
    const { rows } = buildRows({ root: R, nodes: tree(), open: {} })
    expect(segmentOf(rows[0], P('a'))).toBe(0)
    expect(segmentOf(rows[0], P('a\\b'))).toBe(1)
    expect(segmentOf(rows[0], P('a\\b\\c'))).toBe(2)
    expect(segmentOf(rows[0], P('elsewhere'))).toBe(2)
  })
})

describe('geometry and indent guides', () => {
  it('VS Code numbers: 22 px rows, 8 px per level, 16 px twistie', () => {
    expect(ROW_HEIGHT).toBe(22)
    expect(INDENT).toBe(8)
    expect(TWISTIE).toBe(16)
    expect([0, 1, 2].map(rowPadding)).toEqual([8, 16, 24])
    // A guide sits under the middle of its folder's twistie.
    expect([0, 1, 2].map(guideX)).toEqual([16, 24, 32])
  })

  it('the active guide: under the selected open folder, else its parent', () => {
    const nodes = {
      [R]: { entries: [d('src'), f('z.md')] },
      [P('src')]: { entries: [d('src\\lib'), f('src\\main.js')] },
      [P('src\\lib')]: { entries: [f('src\\lib\\u.js')] }
    }
    const open = { [P('src')]: true, [P('src\\lib')]: true }
    const { rows, index } = buildRows({ root: R, nodes, open })
    expect(labels(rows)).toEqual(['src', '  lib', '    u.js', '  main.js', 'z.md'])
    expect(activeGuide(rows, index, P('src'))).toEqual({ depth: 0, from: 1, to: 4 })
    expect(activeGuide(rows, index, P('src\\main.js'))).toEqual({ depth: 0, from: 1, to: 4 })
    expect(activeGuide(rows, index, P('src\\lib\\u.js'))).toEqual({ depth: 1, from: 2, to: 3 })
    // At the top: no parent folder, no guide.
    expect(activeGuide(rows, index, P('z.md'))).toBe(null)
    expect(activeGuide(rows, index, null)).toBe(null)
  })
})
