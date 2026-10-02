import { describe, it, expect } from 'vitest'
import { walkTree, formatSnapshot, buildSnapshot, ordinal, controlState } from '../agentBrowserSnapshot'
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
    expect(snapshot).toBe(['[Navigation] "navigation"', '  [@e1] link "Home"', '  [@e2] text input "Search" (empty)', '[Main Content] "main"', '  heading "Title"', '  text "Hello world"'].join('\n'))
    expect(refs).toEqual([
      { ref: '@e1', role: 'link', name: 'Home' },
      { ref: '@e2', role: 'text input', name: 'Search', state: 'empty' }
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
    expect(snapshot.split('\n')).toEqual(['[@e1] text input "(unlabeled)" (filled)', '[@e2] text input "(unlabeled) (2nd)" (filled)', '[@e3] combobox "(unlabeled)"', '[@e4] number input "Age" (filled)', '[@e5] text input "(unlabeled) (3rd)" (filled)'])
    for (const leak of ['secret-token', 'my search', 'chosen value', '42', 'no backend id']) expect(snapshot).not.toContain(leak)
  })

  // What a control is in, never what it holds (M1).
  it('a control says its state: checked, selected, expanded, disabled, required; a field only filled or empty', () => {
    const P = (o) => Object.entries(o).map(([name, value]) => ({ name, value: { value } }))
    const entries = walk([
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '3', '4', '5', '6', '7', '9', '10', '14', '15', '16', '17', '18', '20'] },
      { nodeId: '2', role: { value: 'checkbox' }, name: { value: 'Bacon' }, backendDOMNodeId: 2, properties: P({ checked: 'true' }) },
      { nodeId: '3', role: { value: 'checkbox' }, name: { value: 'Onion' }, backendDOMNodeId: 3, properties: P({ checked: 'false' }) },
      { nodeId: '4', role: { value: 'checkbox' }, name: { value: 'All' }, backendDOMNodeId: 4, properties: P({ checked: 'mixed' }) },
      { nodeId: '5', role: { value: 'radio' }, name: { value: 'Medium' }, backendDOMNodeId: 5, properties: P({ checked: 'true' }) },
      { nodeId: '6', role: { value: 'switch' }, name: { value: 'Dark' }, backendDOMNodeId: 6, properties: [] },
      { nodeId: '7', role: { value: 'textbox' }, name: { value: 'Name' }, backendDOMNodeId: 7, value: { value: 'secret-typed-value' }, properties: P({ required: true, editable: 'plaintext' }), childIds: ['8'] },
      { nodeId: '8', role: { value: 'StaticText' }, name: { value: 'secret-typed-value' } },
      { nodeId: '9', role: { value: 'textbox' }, name: { value: 'Phone' }, backendDOMNodeId: 9, value: { value: '' }, properties: P({ editable: 'plaintext' }) },
      { nodeId: '10', role: { value: 'combobox' }, name: { value: 'Size' }, backendDOMNodeId: 10, value: { value: 'Medium size' }, properties: P({ expanded: false }), childIds: ['11'] },
      { nodeId: '11', role: { value: 'MenuListPopup' }, childIds: ['12', '13'] },
      { nodeId: '12', role: { value: 'option' }, name: { value: 'Small' }, properties: P({ selected: false }) },
      { nodeId: '13', role: { value: 'MenuListOption' }, name: { value: 'Medium size' }, properties: P({ selected: true }) },
      // A combobox one types in: its value is a typed one.
      { nodeId: '14', role: { value: 'combobox' }, name: { value: 'City' }, backendDOMNodeId: 14, value: { value: 'typed-city' }, properties: P({ editable: 'plaintext' }) },
      { nodeId: '15', role: { value: 'button' }, name: { value: 'Off' }, backendDOMNodeId: 15, properties: P({ disabled: true }) },
      { nodeId: '16', role: { value: 'button' }, name: { value: 'Bold' }, backendDOMNodeId: 16, properties: P({ pressed: 'true' }) },
      { nodeId: '17', role: { value: 'tab' }, name: { value: 'Files' }, backendDOMNodeId: 17, properties: P({ selected: true }) },
      // An editable area: no value of its own, its text is in its children.
      { nodeId: '18', role: { value: 'textbox' }, name: { value: 'Editor' }, backendDOMNodeId: 18, properties: P({ editable: 'richtext' }), childIds: ['19'] },
      { nodeId: '19', role: { value: 'StaticText' }, name: { value: 'draft-text' } },
      { nodeId: '20', role: { value: 'spinbutton' }, name: { value: 'Age' }, backendDOMNodeId: 20, value: { value: '42' } }
    ])
    const { snapshot, refs } = formatSnapshot(entries)
    expect(snapshot.split('\n')).toEqual([
      '[@e1] checkbox "Bacon" (checked)',
      '[@e2] checkbox "Onion" (unchecked)',
      '[@e3] checkbox "All" (mixed)',
      '[@e4] radio "Medium" (checked)',
      '[@e5] switch "Dark" (unchecked)',
      '[@e6] text input "Name" (filled, required)',
      '[@e7] text input "Phone" (empty)',
      '[@e8] combobox "Size" (collapsed, option "Medium size")',
      '[@e9] combobox "City" (filled)',
      '[@e10] button "Off" (disabled)',
      '[@e11] button "Bold" (pressed)',
      '[@e12] tab "Files" (selected)',
      '[@e13] text input "Editor" (filled)',
      '[@e14] number input "Age" (filled)'
    ])
    for (const leak of ['secret-typed-value', 'typed-city', 'draft-text', '42']) expect(JSON.stringify({ snapshot, refs })).not.toContain(leak)
    expect(refs[0]).toEqual({ ref: '@e1', role: 'checkbox', name: 'Bacon', state: 'checked' })
    // A plain button says nothing; a list names a chosen option only from its option nodes, never from its value.
    expect(controlState({ properties: [] }, 'button')).toBe('')
    expect(controlState({ value: { value: 'typed' }, properties: [] }, 'combobox')).toBe('')
  })

  it('pieces of text that follow each other in one element are one line: letters keep their word, words their space', () => {
    const letters = (text, from) => text.split('').map((c, i) => ({ nodeId: `${from}${i}`, role: { value: 'StaticText' }, name: { value: c } }))
    const hi = letters('Hi there. Ok', 'h')
    // Two spaces in a row leave nothing in the tree: "end.  Next" comes as "end." then "N".
    const two = letters('end.Next', 't')
    const entries = walk([
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['p1', 'p2', 'p3', 'd1', 'd2', 'p4'] },
      { nodeId: 'p1', role: { value: 'paragraph' }, childIds: hi.map((n) => n.nodeId) },
      ...hi,
      { nodeId: 'p2', role: { value: 'paragraph' }, childIds: ['a', 'i1', 'c', 'br', 'd'] },
      { nodeId: 'a', role: { value: 'StaticText' }, name: { value: 'Hello ' } },
      // An inline element the tree ignores (<b>): its text is still the paragraph's.
      { nodeId: 'i1', ignored: true, childIds: ['b'] },
      { nodeId: 'b', role: { value: 'StaticText' }, name: { value: 'big' } },
      { nodeId: 'c', role: { value: 'StaticText' }, name: { value: ' world' } },
      { nodeId: 'br', role: { value: 'LineBreak' }, name: { value: '\n' } },
      { nodeId: 'd', role: { value: 'StaticText' }, name: { value: 'second line' } },
      { nodeId: 'p3', role: { value: 'paragraph' }, childIds: ['w1', 'w2', 'lk', 'w3'] },
      { nodeId: 'w1', role: { value: 'StaticText' }, name: { value: 'Price' } },
      { nodeId: 'w2', role: { value: 'StaticText' }, name: { value: '$10' } },
      // A control between two pieces: they stay apart.
      { nodeId: 'lk', role: { value: 'link' }, name: { value: 'Buy' }, backendDOMNodeId: 9 },
      { nodeId: 'w3', role: { value: 'StaticText' }, name: { value: 'today' } },
      // Two elements the tree keeps (<div>s): two lines.
      { nodeId: 'd1', role: { value: 'generic' }, childIds: ['l1'] },
      { nodeId: 'l1', role: { value: 'StaticText' }, name: { value: 'Line one' } },
      { nodeId: 'd2', role: { value: 'generic' }, childIds: ['l2'] },
      { nodeId: 'l2', role: { value: 'StaticText' }, name: { value: 'Line two' } },
      { nodeId: 'p4', role: { value: 'paragraph' }, childIds: two.map((n) => n.nodeId) },
      ...two
    ])
    expect(formatSnapshot(entries).snapshot.split('\n')).toEqual([
      'text "Hi there. Ok"',
      'text "Hello big world second line"',
      'text "Price $10"',
      '[@e1] link "Buy"',
      'text "today"',
      'text "Line one"',
      'text "Line two"',
      'text "end. Next"'
    ])
  })

  it('a merged line stays under its cap: more text starts another line', () => {
    const words = Array.from({ length: 300 }, (_, i) => ({ nodeId: `w${i}`, role: { value: 'StaticText' }, name: { value: `word${i} ` } }))
    const entries = walk([{ nodeId: '1', role: { value: 'paragraph' }, childIds: words.map((w) => w.nodeId) }, ...words])
    expect(entries.length).toBeGreaterThan(1)
    for (const e of entries) expect(e.name.length).toBeLessThanOrEqual(1000)
    expect(entries.map((e) => e.name).join(' ')).toBe(words.map((w) => w.name.value.trim()).join(' '))
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
