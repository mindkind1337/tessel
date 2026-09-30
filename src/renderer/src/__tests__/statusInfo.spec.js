// The status bar's left text, run on App.vue's own statusInfo: chats count
// like terminals, the editor and browser panes do not.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const from = source.indexOf('const statusInfo = computed(')
const to = source.indexOf('\n})\n', from) + 4

describe('status bar summary', () => {
  it('counts chat agents and their state', () => {
    const leaves = [
      { kind: 'agent', id: 'a', title: 'Codex' },
      { kind: 'chat', id: 'c', title: 'Claude Code' },
      { kind: 'chat', id: 'd', title: 'Fable' },
      { kind: 'browser', id: 'b', title: 'Browser' },
      { kind: 'editor', id: 'e', title: 'file.js' }
    ]
    const states = { a: 'ready', c: 'working', d: 'working' }
    const ctx = {
      computed: (fn) => ({ get value() { return fn() } }),
      forEachLeaf: (_tree, fn) => leaves.forEach(fn),
      tree: { value: {} },
      activeId: { value: 'c' },
      broadcast: { value: false },
      currentWs: { value: { cwd: 'C:\Tessel' } },
      paneState: (l) => states[l.id],
      chatPaneState: (l) => states[l.id],
      t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : ''))
    }
    vm.createContext(ctx)
    vm.runInContext(source.slice(from, to) + '\nthis.info = statusInfo.value', ctx)
    expect(ctx.info.summary).toBe('3 panes · 2 working')
    expect(ctx.info.target).toBe('Input → Claude Code')
  })
})
