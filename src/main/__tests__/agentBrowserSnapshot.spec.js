import { describe, it, expect } from 'vitest'
import { walkTree, formatSnapshot, buildSnapshot, ordinal } from '../agentBrowserSnapshot'
import { parseKeyCombo, isPasswordNode, electronKeyEvents } from '../agentBrowserInput'

function walk(nodes) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const entries = []
  let n = 1
  walkTree(nodes[0], byId, 0, entries, () => n++)
  return entries
}

describe('snapshot of the accessibility tree', () => {
  it('lists landmarks, headings, text and controls with refs; skips the rest', () => {
    const entries = walk([
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '6'] },
      { nodeId: '2', role: { value: 'navigation' }, name: { value: '' }, childIds: ['3', '4'] },
      { nodeId: '3', role: { value: 'link' }, name: { value: 'Home' }, backendDOMNodeId: 3 },
      { nodeId: '4', role: { value: 'generic' }, childIds: ['5'] },
      { nodeId: '5', role: { value: 'searchbox' }, name: { value: 'Search' }, backendDOMNodeId: 5 },
      { nodeId: '6', role: { value: 'main' }, name: { value: '' }, childIds: ['7', '8', '9'] },
      { nodeId: '7', role: { value: 'heading' }, name: { value: 'Title' } },
      { nodeId: '8', role: { value: 'StaticText' }, name: { value: '  Hello   world ' } },
      { nodeId: '9', role: { value: 'button' }, name: { value: 'Hidden' }, ignored: true }
    ])
    const { snapshot, refs } = formatSnapshot(entries)
    expect(snapshot).toBe(['[Navigation] "navigation"', '  [@e1] link "Home"', '  [@e2] text input "Search"', '[Main Content] "main"', '  heading "Title"', '  text "Hello world"'].join('\n'))
    expect(refs).toEqual([
      { ref: '@e1', role: 'link', name: 'Home' },
      { ref: '@e2', role: 'text input', name: 'Search' }
    ])
  })

  // M1: an unlabelled field's children are its value.
  it('never reads a control\'s children: an unlabelled field\'s value stays out', () => {
    const entries = walk([
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '4', '6', '8', '10'] },
      { nodeId: '2', role: { value: 'textbox' }, name: { value: '' }, backendDOMNodeId: 2, childIds: ['3'] },
      { nodeId: '3', role: { value: 'StaticText' }, name: { value: 'secret-token-123' } },
      { nodeId: '4', role: { value: 'searchbox' }, backendDOMNodeId: 4, childIds: ['5'] },
      { nodeId: '5', role: { value: 'generic' }, childIds: ['5b'] },
      { nodeId: '5b', role: { value: 'StaticText' }, name: { value: 'my search' } },
      { nodeId: '6', role: { value: 'combobox' }, name: { value: '' }, backendDOMNodeId: 6, childIds: ['7'] },
      { nodeId: '7', role: { value: 'StaticText' }, name: { value: 'chosen value' } },
      { nodeId: '8', role: { value: 'spinbutton' }, name: { value: 'Age' }, backendDOMNodeId: 8, childIds: ['9'] },
      { nodeId: '9', role: { value: 'StaticText' }, name: { value: '42' } },
      { nodeId: '10', role: { value: 'textbox' }, name: { value: '' }, childIds: ['11'] },
      { nodeId: '11', role: { value: 'StaticText' }, name: { value: 'no backend id' } }
    ])
    const { snapshot } = formatSnapshot(entries)
    expect(snapshot.split('\n')).toEqual(['[@e1] text input "(unlabeled)"', '[@e2] text input "(unlabeled) (2nd)"', '[@e3] combobox "(unlabeled)"', '[@e4] number input "Age"', '[@e5] text input "(unlabeled) (3rd)"'])
    for (const leak of ['secret-token', 'my search', 'chosen value', '42', 'no backend id']) expect(snapshot).not.toContain(leak)
  })

  it('the clickable pass never names an editable area by its text', async () => {
    const send = async (m, p) => {
      if (m === 'Accessibility.getFullAXTree') return { nodes: [] }
      if (m === 'Runtime.evaluate') {
        expect(p.expression).toContain("el.isContentEditable ? 'editable area'")
        return { result: {} }
      }
      return {}
    }
    await buildSnapshot(send, { contextId: 1 })
  })

  it('names duplicates (2nd, 3rd) and keeps which occurrence each ref is', () => {
    const entries = walk([
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '3', '4'] },
      { nodeId: '2', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 2 },
      { nodeId: '3', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 3 },
      { nodeId: '4', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 4 }
    ])
    const { snapshot, refMap } = formatSnapshot(entries)
    expect(snapshot.split('\n')).toEqual(['[@e1] button "Save"', '[@e2] button "Save (2nd)"', '[@e3] button "Save (3rd)"'])
    expect(refMap.get('@e3')).toMatchObject({ backendDOMNodeId: 4, nth: 3, axRole: 'button', axName: 'Save' })
    expect(ordinal(11)).toBe('11th')
    expect(ordinal(22)).toBe('22nd')
  })

  it('is capped, says so, and gives no ref past the cut', () => {
    const nodes = [{ nodeId: 'r', role: { value: 'RootWebArea' }, childIds: [] }]
    for (let i = 0; i < 500; i++) {
      nodes[0].childIds.push(String(i))
      nodes.push({ nodeId: String(i), role: { value: 'button' }, name: { value: `Button number ${i}` }, backendDOMNodeId: i + 1 })
    }
    const { snapshot, refMap, truncated } = formatSnapshot(walk(nodes), 1000)
    expect(truncated).toBe(true)
    expect(snapshot.length).toBeLessThan(1200)
    expect(snapshot).toContain('snapshot cut at 1000 characters')
    expect(refMap.size).toBeLessThan(500)
    expect(refMap.has('@e500')).toBe(false)
  })

  it('a very long name is clipped; a cycle in the tree does not loop', () => {
    const entries = walk([
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '1'] },
      { nodeId: '2', role: { value: 'link' }, name: { value: 'x'.repeat(1000) }, backendDOMNodeId: 2 }
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0].name.length).toBeLessThanOrEqual(201)
  })

  it('buildSnapshot reads the tree through the debugger', async () => {
    const calls = []
    const send = async (m) => {
      calls.push(m)
      if (m === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', role: { value: 'button' }, name: { value: 'OK' }, backendDOMNodeId: 7 }] }
      return {}
    }
    const r = await buildSnapshot(send)
    expect(r.snapshot).toBe('[@e1] button "OK"')
    expect(calls).toEqual(['Accessibility.enable', 'Accessibility.getFullAXTree'])
  })
})

describe('keys and password fields', () => {
  it('parses keys and combinations', () => {
    expect(parseKeyCombo('Enter')).toMatchObject({ def: { key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, modifiers: 0 })
    expect(parseKeyCombo('Control+a')).toMatchObject({ def: { key: 'a', code: 'KeyA' }, modifiers: 2 })
    expect(parseKeyCombo('Control+a').def.text).toBeUndefined()
    expect(parseKeyCombo('Shift+Tab').modifiers).toBe(8)
    expect(parseKeyCombo('esc').def.key).toBe('Escape')
    expect(parseKeyCombo('F5').def.windowsVirtualKeyCode).toBe(116)
    expect(() => parseKeyCombo('')).toThrow()
    expect(() => parseKeyCombo('Foo+a')).toThrow()
    expect(() => parseKeyCombo('NotAKey')).toThrow()
  })

  it('keys go through Electron\'s input events: a char event only for a character', () => {
    const ev = (combo) => {
      const { def, modifiers } = parseKeyCombo(combo)
      return electronKeyEvents(def, modifiers)
    }
    expect(ev('c')).toEqual([
      { type: 'keyDown', keyCode: 'c', modifiers: [] },
      { type: 'char', keyCode: 'c', modifiers: [] },
      { type: 'keyUp', keyCode: 'c', modifiers: [] }
    ])
    expect(ev('Enter').map((e) => e.type)).toEqual(['keyDown', 'keyUp'])
    expect(ev('ArrowDown')[0].keyCode).toBe('Down')
    expect(ev('Control+a')).toEqual([
      { type: 'keyDown', keyCode: 'a', modifiers: ['control'] },
      { type: 'keyUp', keyCode: 'a', modifiers: ['control'] }
    ])
  })

  it('knows a password field', () => {
    expect(isPasswordNode({ nodeName: 'INPUT', attributes: ['type', 'Password'] })).toBe(true)
    expect(isPasswordNode({ nodeName: 'INPUT', attributes: ['autocomplete', 'current-password'] })).toBe(true)
    expect(isPasswordNode({ nodeName: 'DIV', attributes: ['autocomplete', 'new-password'] })).toBe(true)
    expect(isPasswordNode({ nodeName: 'INPUT', attributes: ['type', 'text'] })).toBe(false)
    expect(isPasswordNode(null)).toBe(false)
  })
})
