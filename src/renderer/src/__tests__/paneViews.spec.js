import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import { viewKey, treeViews, activeViewKey, pruneTree, writeViewSizes, workspaceViews } from '../paneViews'

const leaf = (id, extra = {}) => ({ type: 'leaf', id, ...extra })
const split = (id, dir, children, sizes) => ({ type: 'split', id, dir, children, sizes: sizes || children.map(() => 100 / children.length) })
const copy = (path) => ({ worktree: { path, branch: 'codex/usage-providers' } })

describe('paneViews', () => {
  it("puts a pane in its worktree's view, the project folder's own panes in the main one", () => {
    expect(viewKey(leaf('a'), 'C:\\Tessel')).toBe('')
    expect(viewKey(leaf('b', copy('C:\\Tessel-codex\\stabilize')), 'C:\\Tessel')).toBe('c:/tessel-codex/stabilize')
    // The project folder itself as a "copy" is the main view.
    expect(viewKey(leaf('c', copy('c:/tessel/')), 'C:\\Tessel')).toBe('')
    // An editor or a browser opened in a copy's grid.
    expect(viewKey(leaf('d', { viewPath: 'C:\\Tessel-codex\\stabilize' }), 'C:\\Tessel')).toBe('c:/tessel-codex/stabilize')
  })

  it('lists the main view first, then each copy as met', () => {
    const tree = split('s', 'row', [leaf('w', copy('C:\\wt')), leaf('a'), leaf('b')])
    const views = treeViews(tree, 'C:\\Tessel')
    expect(views.map((v) => v.key)).toEqual(['', 'c:/wt'])
    expect([...views[0].ids]).toEqual(['a', 'b'])
    expect(activeViewKey(views, 'w')).toBe('c:/wt')
    expect(activeViewKey(views, 'gone')).toBe('')
  })

  it("keeps a split whole when all its panes are in the view, and copies a mixed one with its panes' shares", () => {
    const own = split('own', 'col', [leaf('a'), leaf('b')])
    const tree = split('root', 'row', [own, leaf('w', copy('C:\\wt')), leaf('c')], [50, 30, 20])
    const main = pruneTree(tree, (l) => !l.worktree)
    expect(main.children[0]).toBe(own)
    expect(main.source).toBe(tree)
    expect(main.sizes).toEqual([50 / 70 * 100, 20 / 70 * 100])
    expect(pruneTree(tree, (l) => !!l.worktree)).toBe(tree.children[1])
    expect(pruneTree(tree, () => false)).toBe(null)
  })

  it("writes a divider move in a view back to the split, leaving the other worktree's share", () => {
    const tree = reactive(split('root', 'row', [leaf('a'), leaf('w', copy('C:\\wt')), leaf('c')], [50, 30, 20]))
    const main = pruneTree(tree, (l) => !l.worktree)
    main.sizes = [50, 50]
    writeViewSizes(main)
    expect(tree.sizes).toEqual([35, 30, 35])
  })

  it('shows the active pane\'s grid and hides the others', () => {
    const ws = { cwd: 'C:\\Tessel', activeId: 'w', tree: split('root', 'col', [leaf('a'), leaf('b'), leaf('w', copy('C:\\wt'))]) }
    const views = workspaceViews(ws)
    expect(views.map((v) => [v.key, v.active])).toEqual([
      [':main', false],
      ['c:/wt', true]
    ])
    expect(views[1].tree.id).toBe('w')
    // One grid only: the tree as it is.
    const single = { cwd: 'C:\\Tessel', activeId: 'a', tree: split('root', 'row', [leaf('a'), leaf('b')]) }
    expect(workspaceViews(single)[0].tree).toBe(single.tree)
    expect(workspaceViews({ cwd: null, tree: null })).toEqual([])
  })
})
