import { describe, it, expect, vi } from 'vitest'
import { createAgentBrowserTargets, addPageNear } from '../browser/agentBrowserTargets'

function forEachLeaf(node, fn) {
  if (!node) return
  if (node.type === 'leaf') fn(node)
  else node.children.forEach((c) => forEachLeaf(c, fn))
}
const leaf = (id, kind, extra = {}) => ({ type: 'leaf', id, kind, ...extra })
const split = (...children) => ({ type: 'split', children })

// Project A: an agent, a chat, a shell, two browser pages in the main grid,
// one in a worktree's grid. Project B: its own browser page.
function world() {
  const wsA = {
    id: 'A',
    cwd: 'C:\\a',
    activeId: 'browser-a2',
    tree: split(
      leaf('agent-a', 'agent'),
      leaf('chat-a', 'chat'),
      leaf('shell-a', 'shell'),
      leaf('browser-a1', 'browser', { url: 'http://localhost:1/', title: 'One' }),
      leaf('browser-a2', 'browser', { url: 'http://localhost:2/', title: 'Two' }),
      leaf('browser-wt', 'browser', { view: 'wt' }),
      leaf('agent-wt', 'agent', { view: 'wt' })
    )
  }
  const wsB = { id: 'B', cwd: 'C:\\b', tree: split(leaf('agent-b', 'agent'), leaf('browser-b', 'browser')) }
  const remote = { id: 'R', remote: { hostId: 'h' }, tree: split(leaf('agent-r', 'agent'), leaf('browser-r', 'browser')) }
  return [wsA, wsB, remote]
}

function setup({ enabled = true, guests = { 'browser-a1': 101, 'browser-a2': 102, 'browser-b': 201, 'browser-wt': 301 } } = {}) {
  const wss = world()
  const opened = []
  const targets = createAgentBrowserTargets({
    enabled: () => enabled,
    workspaces: () => wss,
    forEachLeaf,
    sameView: (l, other) => (l.view || '') === (other.view || ''),
    guestOf: (id) => (id in guests ? guests[id] : null),
    paneLabel: (l) => `Agent ${l.id}`,
    openPage: ({ ws, near, url }) => {
      const page = leaf(`new-${opened.length}`, 'browser', { url })
      opened.push({ ws: ws.id, near: near.id, url })
      guests[page.id] = 900
      return page
    },
    sleep: () => Promise.resolve()
  })
  return { targets, opened, guests }
}

describe('which browser page an agent drives', () => {
  it('lists only its own project and worktree grid, the shown page first', async () => {
    const { targets } = setup()
    const r = await targets.handle({ agent: 'agent-a', op: 'list' })
    expect(r.agent).toBe('Agent agent-a')
    expect(r.pages.map((p) => p.page)).toEqual(['browser-a2', 'browser-a1'])
    expect(r.pages[0].current).toBe(true)
    const wt = await targets.handle({ agent: 'agent-wt', op: 'list' })
    expect(wt.pages.map((p) => p.page)).toEqual(['browser-wt'])
  })

  it('resolves the last page used, else the shown one, else refuses', async () => {
    const { targets } = setup()
    expect(await targets.handle({ agent: 'agent-a', op: 'resolve' })).toMatchObject({ page: 'browser-a2', guestId: 102 })
    expect(await targets.handle({ agent: 'agent-a', op: 'resolve', last: 'browser-a1' })).toMatchObject({ page: 'browser-a1', guestId: 101 })
    // A last page from another project is ignored.
    expect(await targets.handle({ agent: 'agent-a', op: 'resolve', last: 'browser-b' })).toMatchObject({ page: 'browser-a2' })
  })

  it('never another project\'s page, even named', async () => {
    const { targets } = setup()
    await expect(targets.handle({ agent: 'agent-a', op: 'resolve', page: 'browser-b' })).rejects.toMatchObject({ code: 'page_not_found' })
    await expect(targets.handle({ agent: 'agent-a', op: 'resolve', page: 'browser-wt' })).rejects.toMatchObject({ code: 'page_not_found' })
    expect(await targets.handle({ agent: 'agent-b', op: 'resolve', page: 'browser-b' })).toMatchObject({ guestId: 201 })
  })

  it('only agent and chat panes; not a shell, an unknown pane, a remote project', async () => {
    const { targets } = setup()
    expect(await targets.handle({ agent: 'chat-a', op: 'resolve' })).toMatchObject({ page: 'browser-a2' })
    await expect(targets.handle({ agent: 'shell-a', op: 'resolve' })).rejects.toMatchObject({ code: 'not_agent' })
    await expect(targets.handle({ agent: 'browser-a1', op: 'resolve' })).rejects.toMatchObject({ code: 'not_agent' })
    await expect(targets.handle({ agent: 'nope', op: 'resolve' })).rejects.toMatchObject({ code: 'not_agent' })
    await expect(targets.handle({ op: 'resolve' })).rejects.toMatchObject({ code: 'not_agent' })
    await expect(targets.handle({ agent: 'agent-r', op: 'resolve' })).rejects.toMatchObject({ code: 'remote_project' })
  })

  it('nothing while the setting is off', async () => {
    const { targets } = setup({ enabled: false })
    await expect(targets.handle({ agent: 'agent-a', op: 'list' })).rejects.toMatchObject({ code: 'disabled' })
  })

  it('no page yet: says to open one; open puts it next to the agent', async () => {
    const { targets, opened } = setup()
    await expect(targets.handle({ agent: 'agent-wt', op: 'resolve', page: null, last: null })).resolves.toMatchObject({ page: 'browser-wt' })
    const lone = createAgentBrowserTargets({
      enabled: () => true,
      workspaces: () => [{ id: 'C', tree: leaf('agent-c', 'agent') }],
      forEachLeaf,
      sameView: () => true,
      guestOf: () => null,
      paneLabel: () => 'C',
      openPage: () => null,
      sleep: () => Promise.resolve()
    })
    await expect(lone.handle({ agent: 'agent-c', op: 'resolve' })).rejects.toMatchObject({ code: 'no_page' })
    await expect(lone.handle({ agent: 'agent-c', op: 'open', url: 'http://x/' })).rejects.toMatchObject({ code: 'open_failed' })
    const r = await targets.handle({ agent: 'agent-a', op: 'open', url: 'http://localhost:3000/' })
    expect(opened).toEqual([{ ws: 'A', near: 'agent-a', url: 'http://localhost:3000/' }])
    expect(r).toMatchObject({ page: 'new-0', guestId: 900 })
  })

  // L1: an agent cannot fill the screen with pages.
  it('at most 5 pages opened by one agent; another agent still may', async () => {
    const wss = world()
    const targets = createAgentBrowserTargets({
      enabled: () => true,
      workspaces: () => wss,
      forEachLeaf,
      sameView: (l, other) => (l.view || '') === (other.view || ''),
      guestOf: () => 7,
      paneLabel: (l) => l.id,
      openPage: ({ ws, url }) => {
        const page = leaf(`p-${Math.random()}`, 'browser', { url })
        ws.tree.children.push(page)
        return page
      },
      sleep: () => Promise.resolve()
    })
    for (let i = 0; i < 5; i++) await targets.handle({ agent: 'agent-a', op: 'open', url: 'http://x/' })
    await expect(targets.handle({ agent: 'agent-a', op: 'open', url: 'http://x/' })).rejects.toMatchObject({ code: 'too_many_pages' })
    await expect(targets.handle({ agent: 'chat-a', op: 'open', url: 'http://x/' })).resolves.toBeTruthy()
    // One closed: room again.
    const i = wss[0].tree.children.findIndex((l) => l.openedBy === 'agent-a')
    wss[0].tree.children.splice(i, 1)
    await expect(targets.handle({ agent: 'agent-a', op: 'open', url: 'http://x/' })).resolves.toBeTruthy()
  })

  // Found in a real window: each page an agent opened halved its pane; after
  // five pages the agent was a sliver. The next pages go with its pages.
  it("an agent's next pages are stacked with its pages, in equal rows; its own pane keeps its room", async () => {
    const ws = { id: 'S', cwd: 'C:\\s', tree: split(leaf('shell-s', 'shell'), leaf('agent-s', 'agent')) }
    ws.tree.dir = 'row'
    ws.tree.sizes = [50, 50]
    let n = 0
    const nears = []
    const targets = createAgentBrowserTargets({
      enabled: () => true,
      workspaces: () => [ws],
      forEachLeaf,
      sameView: () => true,
      guestOf: () => 7,
      paneLabel: (l) => l.id,
      openPage: ({ ws: w, near, url, stack }) => {
        nears.push([near.id, !!stack])
        const page = leaf(`p${n++}`, 'browser', { url })
        w.tree = addPageNear(w.tree, near.id, page, {
          dir: stack ? 'col' : 'row',
          mine: (x) => x === page || (x.type === 'leaf' && x.kind === 'browser' && !!near.openedBy && x.openedBy === near.openedBy),
          makeSplit: (dir, children, sizes) => ({ type: 'split', dir, sizes, children })
        })
        return page
      },
      sleep: () => Promise.resolve()
    })
    for (let i = 0; i < 4; i++) await targets.handle({ agent: 'agent-s', op: 'open', url: 'http://x/' })
    expect(nears).toEqual([
      ['agent-s', false],
      ['p0', true],
      ['p1', true],
      ['p2', true]
    ])
    // shell | (agent | (p0 / p1 / p2 / p3))
    const right = ws.tree.children[1]
    expect(right.dir).toBe('row')
    expect(right.children[0].id).toBe('agent-s')
    expect(right.sizes).toEqual([50, 50])
    const stack = right.children[1]
    expect(stack.dir).toBe('col')
    expect(stack.children.map((c) => c.id)).toEqual(['p0', 'p1', 'p2', 'p3'])
    expect(stack.sizes).toEqual([25, 25, 25, 25])
  })

  it('addPageNear never merges into a group that holds other panes', () => {
    const tree = { type: 'split', dir: 'col', sizes: [50, 50], children: [leaf('p0', 'browser', { openedBy: 'a' }), leaf('shell', 'shell')] }
    const page = leaf('p1', 'browser')
    const out = addPageNear(tree, 'p0', page, { dir: 'col', mine: (x) => x === page || x.openedBy === 'a', makeSplit: (dir, children, sizes) => ({ type: 'split', dir, sizes, children }) })
    expect(out.children.map((c) => c.id || c.children.map((x) => x.id).join('+'))).toEqual(['p0+p1', 'shell'])
    expect(out.sizes).toEqual([50, 50])
    expect(tree.children[0].id).toBe('p0')
  })

  it('a page still loading: null after the wait', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 2000))
    const { targets } = setup({ guests: {} })
    expect(await targets.handle({ agent: 'agent-a', op: 'resolve' })).toMatchObject({ page: 'browser-a2', guestId: null })
    vi.restoreAllMocks()
  })
})
