// Live Share in App.vue's own code (run in a vm, as remotePaneRestore.spec.js
// does): a pane never moves between a Live Share project and a project of
// this computer, either way, and a host's pane is never saved with the
// layout.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { reactive } from 'vue'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

const t = (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : ''))

function leavesOf(node, out = []) {
  if (!node) return out
  if (node.type === 'leaf') out.push(node)
  else for (const c of node.children) leavesOf(c, out)
  return out
}

function loadMove(workspaces) {
  const findLeaf = (id) => workspaces.flatMap((w) => leavesOf(w.tree)).find((l) => l.id === id) || null
  const wsOfLeaf = (id) => workspaces.find((w) => leavesOf(w.tree).some((l) => l.id === id)) || null
  const ctx = {
    t,
    reactive,
    agentTerminalTargets: { touch: () => {} },
    wsOfLeaf,
    findLeaf,
    wsById: (id) => workspaces.find((w) => w.id === id) || null,
    liveShare: { isGuestWs: (ws) => !!(ws && ws.liveShare), isGuestLeaf: (l) => !!(l && l.backend === 'liveshare') },
    showToast: vi.fn(),
    detachLeaf: vi.fn((ws, id) => {
      ws.tree = ws.tree && ws.tree.type === 'leaf' && ws.tree.id === id ? null : ws.tree
    }),
    replaceNode: (tree, id, fn) => (tree.type === 'leaf' && tree.id === id ? fn(tree) : tree),
    selectWorkspace: vi.fn(),
    refitSoon: () => {},
    placeLeaf: vi.fn((tree, _target, leaf) => leaf),
    makeSplit: (dir, children, sizes) => ({ type: 'split', dir, children, sizes }),
    mapLeaves: (tree) => tree,
    firstLeafId: (tree) => leavesOf(tree)[0]?.id || null,
    newId: () => 'split-new',
    // Auto-tile off here (autoTile.spec.js covers a pane moved to a project).
    isTabLeaf: () => false,
    canAutoTile: () => false
  }
  vm.createContext(ctx)
  vm.runInContext(slice('function movePane(srcId, target) {', 'const makeSplit') + '\nthis.movePane = movePane', ctx)
  return ctx
}

const term = (id, extra = {}) => reactive({ type: 'leaf', id, kind: 'shell', title: id, ...extra })

describe('App: panes and Live Share projects never mix', () => {
  function setup() {
    const local = reactive({ id: 'ws-local', tree: term('pane-1'), activeId: 'pane-1' })
    const empty = reactive({ id: 'ws-empty', tree: null, activeId: null })
    const share = reactive({ id: 'ws-ls', liveShare: { session: 1 }, tree: term('pane-ls1-p', { backend: 'liveshare' }), activeId: 'pane-ls1-p' })
    const ctx = loadMove([local, empty, share])
    return { local, empty, share, ctx }
  }

  it('a host pane does not move into a project of this computer', () => {
    const { empty, share, ctx } = setup()
    ctx.movePane('pane-ls1-p', { kind: 'ws', id: 'ws-empty' })
    ctx.movePane('pane-ls1-p', { kind: 'edge', id: 'ws-empty', side: 'left' })
    ctx.movePane('pane-ls1-p', { kind: 'pane', id: 'pane-1', zone: 'center' })
    expect(empty.tree).toBe(null)
    expect(share.tree.id).toBe('pane-ls1-p')
    expect(ctx.detachLeaf).not.toHaveBeenCalled()
    expect(ctx.showToast).toHaveBeenCalledTimes(3)
  })

  it('a terminal of this computer does not move into a Live Share project', () => {
    const { local, share, ctx } = setup()
    ctx.movePane('pane-1', { kind: 'ws', id: 'ws-ls' })
    ctx.movePane('pane-1', { kind: 'edge', id: 'ws-ls', side: 'right' })
    ctx.movePane('pane-1', { kind: 'pane', id: 'pane-ls1-p', zone: 'left' })
    expect(local.tree.id).toBe('pane-1')
    expect(share.tree.id).toBe('pane-ls1-p')
    expect(ctx.detachLeaf).not.toHaveBeenCalled()
  })

  it('panes still move between projects of this computer', () => {
    const { empty, ctx } = setup()
    ctx.movePane('pane-1', { kind: 'ws', id: 'ws-empty' })
    expect(ctx.detachLeaf).toHaveBeenCalled()
    expect(empty.tree.id).toBe('pane-1')
    expect(ctx.showToast).not.toHaveBeenCalled()
  })
})

describe('App: the saved layout', () => {
  const ctx = { t, allowedBrowserUrl: (u) => u, CHAT_AGENTS: ['claude'] }
  vm.createContext(ctx)
  vm.runInContext(slice('function serializeNode(node) {', '// Rebuild a live tree from a snapshot') + '\nthis.serializeNode = serializeNode', ctx)
  const editor = (id) => ({ type: 'leaf', id, kind: 'editor', title: id, files: [], activePath: null })
  const hostPane = (id) => ({ type: 'leaf', id, kind: 'shell', backend: 'liveshare', title: id })

  it('never has a Live Share host pane; the panes beside it share its room', () => {
    expect(ctx.serializeNode(hostPane('pane-ls1-a'))).toBe(null)
    const out = ctx.serializeNode({ type: 'split', dir: 'row', sizes: [20, 30, 50], children: [editor('pane-e1'), hostPane('pane-ls1-a'), editor('pane-e2')] })
    expect(out.children.map((c) => c.id)).toEqual(['pane-e1', 'pane-e2'])
    expect(out.sizes.map((s) => Math.round(s * 10) / 10)).toEqual([28.6, 71.4])
    const one = ctx.serializeNode({ type: 'split', dir: 'col', sizes: [50, 50], children: [hostPane('pane-ls1-b'), editor('pane-e3')] })
    expect(one.id).toBe('pane-e3')
  })

  it('a split without host panes is saved as it was', () => {
    const out = ctx.serializeNode({ type: 'split', dir: 'row', sizes: [40, 60], children: [editor('pane-e1'), editor('pane-e2')] })
    expect(out).toMatchObject({ type: 'split', dir: 'row', sizes: [40, 60] })
    expect(out.children).toHaveLength(2)
  })
})
