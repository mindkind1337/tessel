import { describe, it, expect } from 'vitest'
import { isReactive, reactive } from 'vue'
import { hostLayoutFromWorkspace, buildGuestTree, hostChatsFromWorkspace } from '../liveShareLayout'

const leaf = (id, extra = {}) => ({ type: 'leaf', id, title: id, ...extra })
const split = (dir, sizes, children) => ({ type: 'split', id: `split-${Math.random()}`, dir, sizes, children })

describe('hostLayoutFromWorkspace', () => {
  const ws = {
    name: 'tessel',
    activeId: 'pane-2',
    tree: split('row', [60, 40], [
      leaf('pane-1', { kind: 'agent', agentId: 'claude', accent: '#d97757', paneName: 'Reviewer', title: 'Claude Code', pid: 42 }),
      split('col', [50, 25, 25], [
        leaf('pane-2', { kind: 'shell', title: 'PowerShell' }),
        leaf('pane-3', { kind: 'editor', title: 'App.vue', files: [] }),
        leaf('pane-4', { kind: 'browser', paneName: 'Docs' })
      ])
    ])
  }

  it('keeps the splits and describes each pane, nothing more', () => {
    expect(hostLayoutFromWorkspace(ws, 'pane-1')).toEqual({
      project: 'tessel',
      activeId: 'pane-2',
      maximizedId: 'pane-1',
      // Its grid on screen (the active pane is a terminal), no task copy.
      shown: 'terminal',
      copy: null,
      tree: {
        type: 'split',
        dir: 'row',
        sizes: [60, 40],
        children: [
          { type: 'leaf', id: 'pane-1', view: 'terminal', title: 'Reviewer', kind: 'agent', agentId: 'claude', accent: '#d97757' },
          {
            type: 'split',
            dir: 'col',
            sizes: [50, 25, 25],
            children: [
              { type: 'leaf', id: 'pane-2', view: 'terminal', title: 'PowerShell', kind: 'shell', agentId: null, accent: null },
              // Not shared: their place only, not their names (a file, a page).
              { type: 'leaf', id: 'pane-3', view: 'editor', title: '', kind: 'shell', agentId: null, accent: null },
              { type: 'leaf', id: 'pane-4', view: 'browser', title: '', kind: 'shell', agentId: null, accent: null }
            ]
          }
        ]
      }
    })
  })

  it('a chat pane is a chat view', () => {
    const layout = hostLayoutFromWorkspace({ name: 'p', tree: leaf('pane-9', { kind: 'chat', title: 'Chat' }), activeId: 'pane-9' })
    expect(layout.tree).toMatchObject({ type: 'leaf', view: 'chat', kind: 'shell' })
  })

  it('an active or fullscreen pane that is not in the tree is null', () => {
    const layout = hostLayoutFromWorkspace({ ...ws, activeId: 'pane-gone' }, 'pane-other')
    expect(layout.activeId).toBeNull()
    expect(layout.maximizedId).toBeNull()
  })

  it('an empty project has no tree; no project gives null', () => {
    expect(hostLayoutFromWorkspace({ name: 'empty', tree: null, activeId: null })).toEqual({ project: 'empty', tree: null, activeId: null, maximizedId: null, shown: 'terminal', copy: null })
    expect(hostLayoutFromWorkspace(null)).toBeNull()
  })

  it('only the view on screen: the panes of a task copy (its own grid) stay out', () => {
    const project = {
      name: 'tessel',
      cwd: 'C:/code/tessel',
      activeId: 'pane-1',
      tree: {
        type: 'split',
        dir: 'row',
        sizes: [50, 50],
        children: [leaf('pane-1', { kind: 'shell', title: 'PowerShell' }), leaf('pane-wt', { kind: 'agent', title: 'Codex', worktree: { path: 'C:/code/tessel-wt/fix', branch: 'fix' } })]
      }
    }
    const layout = hostLayoutFromWorkspace(project)
    expect(layout.tree).toMatchObject({ type: 'leaf', id: 'pane-1' })
    // The copy's view on screen: only its panes.
    const copy = hostLayoutFromWorkspace({ ...project, activeId: 'pane-wt' })
    expect(copy.tree).toMatchObject({ type: 'leaf', id: 'pane-wt' })
    expect(copy.activeId).toBe('pane-wt')
  })

  it('does not change the workspace', () => {
    const before = JSON.stringify(ws)
    const layout = hostLayoutFromWorkspace(ws)
    layout.tree.sizes[0] = 1
    expect(JSON.stringify(ws)).toBe(before)
  })
})

describe('buildGuestTree', () => {
  const term = (id, extra = {}) => ({ type: 'leaf', id, view: 'terminal', title: id, kind: 'shell', agentId: null, accent: null, ...extra })
  const lsplit = (dir, sizes, children) => ({ type: 'split', dir, sizes, children })
  // The guest's panes: the same object for the same id, like App's reactive leaves.
  const pool = () => {
    const leaves = new Map()
    return (l) => {
      if (!leaves.has(l.id)) leaves.set(l.id, reactive({ type: 'leaf', id: l.id, title: l.title }))
      return leaves.get(l.id)
    }
  }

  it('builds splits as App does, with the leaves getLeaf gives', () => {
    const getLeaf = pool()
    const tree = buildGuestTree({ tree: lsplit('row', [30, 70], [term('a'), lsplit('col', [50, 50], [term('b'), term('c')])]) }, getLeaf)
    expect(isReactive(tree)).toBe(true)
    expect(tree).toMatchObject({ type: 'split', id: 'ls-split-r', dir: 'row', sizes: [30, 70] })
    expect(tree.children[0]).toBe(getLeaf({ id: 'a' }))
    expect(tree.children[1]).toMatchObject({ type: 'split', id: 'ls-split-r-1', dir: 'col', sizes: [50, 50] })
    expect(tree.children[1].children.map((c) => c.id)).toEqual(['b', 'c'])
  })

  it('gives the same split ids and leaves when built again', () => {
    const getLeaf = pool()
    const layout = { tree: lsplit('row', [50, 50], [term('a'), lsplit('col', [50, 50], [term('b'), term('c')])]) }
    const first = buildGuestTree(layout, getLeaf)
    const second = buildGuestTree(layout, getLeaf)
    expect(second).not.toBe(first)
    expect(second.id).toBe(first.id)
    expect(second.children[1].id).toBe(first.children[1].id)
    expect(second.children[1].children[1]).toBe(first.children[1].children[1])
  })

  it('leaves out editors, browsers and chats; the others share their room', () => {
    const tree = buildGuestTree({ tree: lsplit('row', [20, 30, 50], [term('a'), { ...term('e'), view: 'editor' }, term('b')]) }, pool())
    expect(tree.children.map((c) => c.id)).toEqual(['a', 'b'])
    expect(tree.sizes[0]).toBeCloseTo((20 / 70) * 100)
    expect(tree.sizes[1]).toBeCloseTo((50 / 70) * 100)
    expect(tree.sizes[0] + tree.sizes[1]).toBeCloseTo(100)
  })

  it('a split left with one pane is that pane', () => {
    const getLeaf = pool()
    const tree = buildGuestTree(
      { tree: lsplit('row', [50, 50], [term('a'), lsplit('col', [50, 50], [{ ...term('w'), view: 'browser' }, term('b')])]) },
      getLeaf
    )
    expect(tree.id).toBe('ls-split-r')
    expect(tree.children[1]).toBe(getLeaf({ id: 'b' }))
    expect(tree.sizes).toEqual([50, 50])
    // Only one pane in all: no split at all (an editor is never one).
    expect(buildGuestTree({ tree: lsplit('row', [50, 50], [term('a'), { ...term('x'), view: 'editor' }]) }, getLeaf)).toBe(getLeaf({ id: 'a' }))
  })

  it('a pane getLeaf has none for is left out', () => {
    const getLeaf = pool()
    const tree = buildGuestTree({ tree: lsplit('row', [50, 25, 25], [term('a'), term('gone'), term('b')]) }, (l) => (l.id === 'gone' ? null : getLeaf(l)))
    expect(tree.children.map((c) => c.id)).toEqual(['a', 'b'])
    expect(tree.sizes).toEqual([((50 / 75) * 100), ((25 / 75) * 100)])
  })

  it('missing or zero sizes are shared equally', () => {
    expect(buildGuestTree({ tree: lsplit('col', undefined, [term('a'), term('b')]) }, pool()).sizes).toEqual([50, 50])
    expect(buildGuestTree({ tree: lsplit('col', [0, 0, 0], [term('a'), term('b'), term('c')]) }, pool()).sizes).toEqual([100 / 3, 100 / 3, 100 / 3])
  })

  it('a split direction other than col is row', () => {
    expect(buildGuestTree({ tree: lsplit('sideways', [50, 50], [term('a'), term('b')]) }, pool()).dir).toBe('row')
  })

  it('null when nothing is left', () => {
    expect(buildGuestTree(null, pool())).toBeNull()
    expect(buildGuestTree({ tree: null }, pool())).toBeNull()
    expect(buildGuestTree({ tree: lsplit('row', [50, 50], [{ ...term('e'), view: 'editor' }, { ...term('w'), view: 'browser' }]) }, pool())).toBeNull()
    expect(buildGuestTree({ tree: term('a') }, () => null)).toBeNull()
  })

  it('takes what hostLayoutFromWorkspace makes', () => {
    const ws = {
      name: 'p',
      activeId: 'pane-1',
      tree: split('row', [50, 50], [leaf('pane-1', { kind: 'agent', agentId: 'codex' }), leaf('pane-2', { kind: 'editor' })])
    }
    const getLeaf = pool()
    expect(buildGuestTree(hostLayoutFromWorkspace(ws), getLeaf)).toBe(getLeaf({ id: 'pane-1' }))
  })
})

describe('Live Share conversations: the host’s agent panes, a guest’s chat panes', () => {
  const UUID = '0b8f3c1e-5a2d-4c7b-9e1f-2a3b4c5d6e7f'

  it('lists the agent panes whose conversation is known, with where it is (for the host’s main only)', () => {
    const ws = {
      name: 'site',
      cwd: 'C:\\work\\site',
      tree: split('row', [25, 25, 25, 25], [
        leaf('pane-1', { kind: 'agent', agentId: 'claude', sessionId: UUID, accountId: 'acct-1', startDir: 'C:\\work\\site\\app', paneName: 'Reviewer' }),
        leaf('pane-2', { kind: 'chat', agentId: 'codex', sessionId: UUID, cwd: 'C:\\work\\site', paneName: 'Codex chat' }),
        split('col', [50, 50], [
          // No conversation yet, an agent Tessel does not read, an SSH host's.
          leaf('pane-3', { kind: 'agent', agentId: 'claude' }),
          leaf('pane-4', { kind: 'agent', agentId: 'aider', sessionId: UUID })
        ]),
        leaf('pane-5', { kind: 'agent', agentId: 'claude', sessionId: UUID, remoteHostId: 'ssh-h1', cwd: 'ssh://ssh-h1/home/x/app', remotePath: '/home/x' }),
        leaf('pane-6', { kind: 'agent', agentId: 'antigravity', sessionId: UUID, remoteHostId: 'ssh-h1', cwd: 'ssh://ssh-h1/home/x' }),
        leaf('pane-7', { kind: 'agent', agentId: 'codex', sessionId: UUID, remoteHostId: 'ssh-h1', detected: true }),
        leaf('pane-8', { kind: 'shell', title: 'PowerShell' })
      ])
    }
    expect(hostChatsFromWorkspace(ws)).toEqual([
      { id: 'pane-1', agentId: 'claude', sessionId: UUID, accountId: 'acct-1', terminal: true, title: '', roots: ['C:\\work\\site\\app', 'C:\\work\\site'] },
      { id: 'pane-2', agentId: 'codex', sessionId: UUID, terminal: false, title: 'Codex chat', roots: ['C:\\work\\site'] },
      // No conversation yet; an agent Tessel does not read: listed with why.
      { id: 'pane-3', agentId: 'claude', terminal: true, title: '', reason: 'none' },
      { id: 'pane-4', agentId: 'aider', terminal: true, title: '', reason: 'agent' },
      // On an SSH host: Claude Code and Codex are read there (the roots are the host's);
      // another agent, or one only detected in a shell, is listed as one that cannot be read (a guest is not told it is SSH).
      { id: 'pane-5', agentId: 'claude', sessionId: UUID, hostId: 'ssh-h1', terminal: true, title: '', roots: ['/home/x/app', '/home/x'] },
      { id: 'pane-6', agentId: 'antigravity', terminal: true, title: '', reason: 'agent' },
      { id: 'pane-7', agentId: 'codex', terminal: true, title: '', reason: 'agent' }
    ])
    expect(hostChatsFromWorkspace(null)).toEqual([])
  })

  it('a pane the host has in chat mode is kept in the guest’s tree when the guest’s window has a leaf for it', () => {
    const term = (id, view = 'terminal') => ({ type: 'leaf', id, view, title: id, kind: 'shell', agentId: null, accent: null })
    const leaves = new Map([['a', reactive({ type: 'leaf', id: 'a' })], ['c', reactive({ type: 'leaf', id: 'c' })]])
    const tree = buildGuestTree({ tree: { type: 'split', dir: 'row', sizes: [40, 30, 30], children: [term('a'), term('c', 'chat'), term('e', 'editor')] } }, (l) => leaves.get(l.id) || null)
    expect(tree.children.map((c) => c.id)).toEqual(['a', 'c'])
    // An older guest window (no leaf for it): left out, as before.
    expect(buildGuestTree({ tree: { type: 'split', dir: 'row', sizes: [50, 50], children: [term('a'), term('c', 'chat')] } }, (l) => (l.id === 'a' ? leaves.get('a') : null)).id).toBe('a')
  })
})
