import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import { viewKey, treeViews, activeViewKey, pruneTree, writeViewSizes, workspaceViews, isTabLeaf, shownTab, addTabLeaf, gridLeafFor } from '../paneViews'

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

  it('lists the main view first, then each copy by its folder, whatever the tree’s order', () => {
    const tree = split('s', 'row', [leaf('w', copy('C:\\wt')), leaf('a'), leaf('b')])
    const views = treeViews(tree, 'C:\\Tessel')
    expect(views.map((v) => v.key)).toEqual(['', 'c:/wt'])
    // The copies' layers are keyed in the page: a tree laid out again never reorders them.
    const k = leaf('k', copy('C:\\copies\\k'))
    const j = leaf('j', copy('C:\\copies\\j'))
    expect(treeViews(split('s', 'row', [k, leaf('a'), j]), 'C:\\Tessel').map((v) => v.key)).toEqual(['', 'c:/copies/j', 'c:/copies/k'])
    expect(treeViews(split('s', 'row', [j, k, leaf('a')]), 'C:\\Tessel').map((v) => v.key)).toEqual(['', 'c:/copies/j', 'c:/copies/k'])
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

describe('tabs above the grid', () => {
  const editor = (id, extra = {}) => leaf(id, { kind: 'editor', ...extra })
  const browser = (id, extra = {}) => leaf(id, { kind: 'browser', ...extra })
  const makeSplit = (dir, children, sizes) => ({ type: 'split', id: `s-${children.map((c) => c.id).join('-')}`, dir, children, sizes })

  it('an editor or a browser is a tab; a terminal, an agent or a chat is in the grid', () => {
    expect(isTabLeaf(editor('e'))).toBe(true)
    expect(isTabLeaf(browser('b'))).toBe(true)
    expect(isTabLeaf(leaf('t', { kind: 'shell' }))).toBe(false)
    expect(isTabLeaf(leaf('a', { kind: 'agent' }))).toBe(false)
    expect(isTabLeaf(leaf('c', { kind: 'chat' }))).toBe(false)
    expect(isTabLeaf(null)).toBe(false)
  })

  it('a tab opened beside the grid leaves the grid as it is (the same tree, all its room)', () => {
    const grid = split('g', 'col', [leaf('a'), leaf('b')], [70, 30])
    const withEditor = addTabLeaf(grid, editor('e'), makeSplit)
    const withBoth = addTabLeaf(withEditor, browser('w'), makeSplit)
    const ws = { cwd: 'C:\\p', activeId: 'a', tree: withBoth }
    const [view] = workspaceViews(ws)
    expect(view.grid).toBe(grid)
    expect(grid.sizes).toEqual([70, 30])
    expect(view.tabs.map((l) => l.id)).toEqual(['e', 'w'])
    // The whole tree is still the view's (saved, listed as before).
    expect(view.tree).toBe(withBoth)
    // No tab yet: the first one is the whole tree.
    expect(addTabLeaf(null, editor('e'), makeSplit).id).toBe('e')
  })

  it("prunes the tabs out of the grid, also with one view, and a divider moved there writes back to the tree's split", () => {
    const tree = reactive(split('root', 'row', [leaf('a'), editor('e'), leaf('b')], [40, 20, 40]))
    const ws = { cwd: 'C:\\p', activeId: 'a', tree }
    const [view] = workspaceViews(ws)
    expect(view.grid.children.map((c) => c.id)).toEqual(['a', 'b'])
    expect(view.grid.sizes).toEqual([50, 50])
    view.grid.sizes = [25, 75]
    writeViewSizes(view.grid)
    expect(tree.sizes).toEqual([20, 20, 60])
    // Only tabs: no grid.
    expect(workspaceViews({ cwd: 'C:\\p', activeId: 'e', tree: editor('e') })[0].grid).toBe(null)
  })

  it("each worktree's view has its own grid and tabs", () => {
    const wt = { viewPath: 'C:\\wt' }
    const tree = split('root', 'row', [leaf('a'), editor('e'), leaf('w', copy('C:\\wt')), browser('p', wt)])
    const views = workspaceViews({ cwd: 'C:\\p', activeId: 'p', tree })
    expect(views.map((v) => [v.key, v.tabs.map((l) => l.id), v.grid.id, v.active])).toEqual([
      [':main', ['e'], 'a', false],
      ['c:/wt', ['p'], 'w', true]
    ])
  })

  it('shows the active pane: its own tab, or the grid for a terminal or an agent', () => {
    const tree = split('root', 'row', [split('g', 'col', [leaf('a'), leaf('b')]), editor('e'), browser('w')])
    const shown = (activeId, view) => workspaceViews({ cwd: 'C:\\p', activeId, view, tree })[0].shown
    expect(shown('a')).toBe('terminal')
    expect(shown('e')).toBe('e')
    expect(shown('w', 'terminal')).toBe('w')
    // The Terminal tab chosen in a view with no terminal: it stays (the
    // launcher shows there).
    const only = split('root', 'row', [editor('e'), browser('w')])
    expect(workspaceViews({ cwd: 'C:\\p', activeId: 'e', view: 'terminal', tree: only })[0].shown).toBe('terminal')
    expect(workspaceViews({ cwd: 'C:\\p', activeId: 'e', view: 'e', tree: only })[0].shown).toBe('e')
    // A view not on screen keeps the tab chosen there.
    const view = { ids: new Set(['x', 'y']), grid: leaf('x'), tabs: [editor('y')] }
    expect(shownTab({ activeId: 'other', view: 'y' }, view)).toBe('y')
    expect(shownTab({ activeId: 'other', view: 'gone' }, view)).toBe('terminal')
  })

  it("a pane opened from a tab goes beside the grid's terminal or agent last used, in the tab's own worktree", () => {
    const tree = split('root', 'row', [leaf('a'), leaf('b'), editor('e'), leaf('w', copy('C:\\wt')), editor('f', { viewPath: 'C:\\wt' })])
    const ws = { cwd: 'C:\\p', tree, gridId: 'b' }
    expect(gridLeafFor(ws, tree.children[2]).id).toBe('b')
    // The last one used is in another worktree: that tab's own grid.
    expect(gridLeafFor(ws, tree.children[4]).id).toBe('w')
    // None used yet (or it closed): the first one.
    expect(gridLeafFor({ ...ws, gridId: 'gone' }, tree.children[2]).id).toBe('a')
    // A grid with none.
    expect(gridLeafFor({ cwd: 'C:\\p', tree: split('r', 'row', [editor('e'), browser('p')]) }, editor('e'))).toBe(null)
  })
})
