// Pane numbers (#n), run on App.vue's own numberPanes: terminals and chats
// only, never a browser or an editor.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { ensureAgentNames } from '../../../shared/agentNames'
import { join } from 'path'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const from = source.indexOf('function numberPanes()')
const to = source.indexOf('\nwatch(', from)

function forEachLeaf(node, fn) {
  if (!node) return
  if (node.type === 'leaf') fn(node)
  else for (const c of node.children) forEachLeaf(c, fn)
}

describe('pane numbers', () => {
  it('terminals and chats are numbered; a browser or an editor is not (and loses an old number)', () => {
    const tree = {
      type: 'split',
      children: [
        { type: 'leaf', kind: 'agent', id: 'a' },
        { type: 'leaf', kind: 'browser', id: 'b', num: 2 },
        { type: 'leaf', kind: 'chat', id: 'c' },
        { type: 'leaf', kind: 'editor', id: 'e' },
        { type: 'leaf', kind: 'shell', id: 's' }
      ]
    }
    const ctx = { workspaces: { value: [{ tree }] }, forEachLeaf, ensureAgentNames, forEachWsLeaf: (fn) => forEachLeaf(tree, fn), Set, Number }
    vm.createContext(ctx)
    vm.runInContext(source.slice(from, to) + '\nnumberPanes()', ctx)
    const nums = Object.fromEntries(tree.children.map((l) => [l.id, l.num]))
    expect(nums).toEqual({ a: 1, b: undefined, c: 2, e: undefined, s: 3 })
    expect(tree.children.map((l) => l.paneName)).toEqual(['Ada', undefined, 'Bohr', undefined, undefined])
  })

  it('uses one name pool across workspaces and keeps names after a move or mode switch', () => {
    const a = { type: 'leaf', kind: 'agent', id: 'a', paneName: 'Curie' }
    const b = { type: 'leaf', kind: 'chat', id: 'b' }
    const workspaces = { value: [{ tree: a }, { tree: b }] }
    const ctx = { workspaces, forEachLeaf, ensureAgentNames, forEachWsLeaf: (fn) => workspaces.value.forEach((w) => forEachLeaf(w.tree, fn)), Set, Number }
    vm.createContext(ctx)
    vm.runInContext(source.slice(from, to) + '\nnumberPanes()', ctx)
    expect([a.paneName, b.paneName]).toEqual(['Curie', 'Ada'])
    a.kind = 'chat'
    workspaces.value = [{ tree: { type: 'split', children: [b, a] } }]
    vm.runInContext('numberPanes()', ctx)
    expect([a.paneName, b.paneName]).toEqual(['Curie', 'Ada'])
  })
})
