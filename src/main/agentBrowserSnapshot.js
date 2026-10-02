// The page as an agent reads it: the accessibility tree, flattened to one
// line per landmark, heading, text and control, each control with a ref
// ("@e3") the agent clicks or fills by. After Orca's
// src/main/browser/snapshot-engine.ts, snapshot-ax-tree-walk.ts and
// snapshot-cursor-interactive-elements.ts (MIT, Copyright (c) 2026 Lovecast
// Inc.), ported to plain JS.
//
// Tessel's differences: no cross-origin iframe sessions (their content is
// not listed); the pass that finds clickable <div>s runs in an isolated
// world (the page never sees it, nothing is left on window); the text is
// capped (MAX_SNAPSHOT_CHARS) and says so; a control's value is never
// listed (a control's children are not read; an editable area's text is not
// its name). A control says its state instead: checked / unchecked, pressed,
// selected, expanded / collapsed, disabled, required, and for a field only
// whether it is filled or empty (a list's chosen option is named: a label of
// the page, not something typed). Pieces of text that follow each other in
// the same element (a word cut into styled letters) are one line.

export const MAX_SNAPSHOT_CHARS = 60000
// Clickable elements without a role, at most.
const MAX_CURSOR_INTERACTIVE = 50
const MAX_NAME = 200
// One line of merged text, at most (more starts another line).
const MAX_TEXT = 1000

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'treeitem'
])

const LANDMARK_ROLES = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'form', 'search'])

const SKIP_ROLES = new Set(['none', 'presentation', 'generic'])

const CHECKABLE_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'])
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'spinbutton'])
// Looked through for a list's chosen option, at most.
const MAX_OPTION_NODES = 500

// A node's accessibility property (checked, disabled, editable…), or undefined.
function prop(node, name) {
  if (!Array.isArray(node.properties)) return undefined
  const p = node.properties.find((x) => x && x.name === name)
  return p && p.value ? p.value.value : undefined
}
const isTrue = (v) => v === true || v === 'true'
const isFalse = (v) => v === false || v === 'false'

// Whether a field holds something: its value's presence, never the value.
function hasText(node, nodeById) {
  if (node.value && node.value.value != null) return String(node.value.value).length > 0
  const stack = [...(node.childIds || [])]
  let looked = 0
  while (stack.length && looked++ < MAX_OPTION_NODES) {
    const child = nodeById.get(stack.pop())
    if (!child) continue
    const role = (child.role && child.role.value) || ''
    if ((role === 'StaticText' || role === 'staticText') && String((child.name && child.name.value) || '').trim()) return true
    if (Array.isArray(child.childIds)) stack.push(...child.childIds)
  }
  return false
}

// The labels of a list's chosen options (its option nodes marked selected).
function chosenOptions(node, nodeById) {
  const out = []
  const stack = [...(node.childIds || [])].reverse()
  let looked = 0
  while (stack.length && looked++ < MAX_OPTION_NODES && out.length < 3) {
    const child = nodeById.get(stack.pop())
    if (!child) continue
    const role = String((child.role && child.role.value) || '').toLowerCase()
    if (role.endsWith('option')) {
      const label = clip(child.name && child.name.value)
      if (label && isTrue(prop(child, 'selected'))) out.push(label)
      continue
    }
    if (Array.isArray(child.childIds)) stack.push(...[...child.childIds].reverse())
  }
  return out
}

// What a control is in now, as words: never what it holds.
export function controlState(node, role, nodeById = new Map()) {
  const out = []
  if (CHECKABLE_ROLES.has(role)) {
    const checked = prop(node, 'checked')
    out.push(checked === 'mixed' ? 'mixed' : isTrue(checked) ? 'checked' : 'unchecked')
  }
  const pressed = prop(node, 'pressed')
  if (pressed !== undefined && !CHECKABLE_ROLES.has(role)) out.push(pressed === 'mixed' ? 'mixed' : isTrue(pressed) ? 'pressed' : 'not pressed')
  if (isTrue(prop(node, 'selected'))) out.push('selected')
  const expanded = prop(node, 'expanded')
  if (isTrue(expanded)) out.push('expanded')
  else if (isFalse(expanded)) out.push('collapsed')
  // A field (a combobox one types in too): filled or empty. A list: its chosen option.
  if (FIELD_ROLES.has(role) || (role === 'combobox' && prop(node, 'editable') !== undefined)) out.push(hasText(node, nodeById) ? 'filled' : 'empty')
  else if (role === 'combobox' || role === 'listbox') {
    const chosen = chosenOptions(node, nodeById)
    if (chosen.length) out.push(`option ${chosen.map((c) => `"${c}"`).join(', ')}`)
  }
  if (isTrue(prop(node, 'disabled'))) out.push('disabled')
  if (isTrue(prop(node, 'required'))) out.push('required')
  return out.join(', ')
}

const clip = (s) => {
  const text = String(s || '').replace(/\s+/g, ' ').trim()
  return text.length > MAX_NAME ? `${text.slice(0, MAX_NAME)}…` : text
}

// One AX node and its children -> entries ({ ref, role, name, state,
// backendDOMNodeId, depth }). container: the nearest element the tree keeps
// (not ignored) around this node; text pieces of one container are one line.
export function walkTree(node, nodeById, depth, entries, nextRef, seen = new Set(), container = null) {
  if (!node || seen.has(node.nodeId)) return
  seen.add(node.nodeId)

  const role = (node.role && node.role.value) || ''
  const isStaticText = role === 'staticText' || role === 'StaticText'
  const raw = String((node.name && node.name.value) || '')
  // A space or a line break between two pieces of text: they are two words.
  if (role === 'LineBreak' || (isStaticText && raw && !raw.trim())) {
    const last = entries[entries.length - 1]
    if (last && last.role === 'text' && last.container === container) last.spaceAfter = true
    return
  }
  if (node.ignored) return walkChildren(node, nodeById, depth, entries, nextRef, seen, container)

  const name = clip(raw)

  if (SKIP_ROLES.has(role)) return walkChildren(node, nodeById, depth, entries, nextRef, seen, node.nodeId)

  const isInteractive = INTERACTIVE_ROLES.has(role)
  const isHeading = role === 'heading'
  const isLandmark = LANDMARK_ROLES.has(role)

  if (!isInteractive && !isHeading && !isLandmark && !isStaticText) return walkChildren(node, nodeById, depth, entries, nextRef, seen, node.nodeId)
  // A control is one line, its children never read: a text field's,
  // a combobox's or a number input's children are the value it holds.
  if (isInteractive) {
    if (isFocusable(node) || node.backendDOMNodeId) {
      const state = controlState(node, role, nodeById)
      entries.push({ ref: `@e${nextRef()}`, role: formatInteractiveRole(role), axRole: role, axName: name, name: name || '(unlabeled)', ...(state ? { state } : {}), backendDOMNodeId: node.backendDOMNodeId || 0, depth })
    }
    return
  }
  if (!name && !isLandmark) return walkChildren(node, nodeById, depth, entries, nextRef, seen, node.nodeId)

  if (isLandmark) {
    entries.push({ ref: '', role: formatLandmarkRole(role, name), name: name || role, backendDOMNodeId: node.backendDOMNodeId || 0, depth })
    return walkChildren(node, nodeById, depth + 1, entries, nextRef, seen, node.nodeId)
  }
  if (isHeading) {
    entries.push({ ref: '', role: 'heading', name, backendDOMNodeId: node.backendDOMNodeId || 0, depth })
    return
  }
  if (isStaticText) {
    // The text that follows another piece in the same element continues its
    // line: joined as written (a letter styled on its own stays in its
    // word; whole words get the space the page drew between them).
    const last = entries[entries.length - 1]
    if (last && last.role === 'text' && last.container === container && last.depth === depth) {
      // (Two spaces in a row, each in its own element, leave no trace in the
      // tree: a capital right after the end of a sentence starts a new word.)
      const space = last.spaceAfter || /\s$/.test(last.raw) || /^\s/.test(raw) || (name.length > 1 && last.lastPiece > 1) || (/[.!?;:]$/.test(last.name) && /^\p{Lu}/u.test(name))
      const joined = `${last.name}${space ? ' ' : ''}${name}`
      if (joined.length <= MAX_TEXT) {
        last.name = joined
        last.raw = raw
        last.lastPiece = name.length
        last.spaceAfter = false
        return
      }
    }
    entries.push({ ref: '', role: 'text', name, raw, lastPiece: name.length, container, backendDOMNodeId: node.backendDOMNodeId || 0, depth })
    return
  }
  walkChildren(node, nodeById, depth, entries, nextRef, seen, node.nodeId)
}

function walkChildren(node, nodeById, depth, entries, nextRef, seen, container = null) {
  if (!Array.isArray(node.childIds)) return
  for (const id of node.childIds) {
    const child = nodeById.get(id)
    if (child) walkTree(child, nodeById, depth, entries, nextRef, seen, container)
  }
}

function isFocusable(node) {
  if (!Array.isArray(node.properties)) return true
  const focusable = node.properties.find((p) => p && p.name === 'focusable')
  return !(focusable && focusable.value && focusable.value.value === false)
}

function formatInteractiveRole(role) {
  switch (role) {
    case 'textbox':
    case 'searchbox':
      return 'text input'
    case 'menuitem':
    case 'menuitemcheckbox':
    case 'menuitemradio':
      return 'menu item'
    case 'spinbutton':
      return 'number input'
    case 'treeitem':
      return 'tree item'
    default:
      return role
  }
}

function formatLandmarkRole(role, name) {
  if (name) return `[${name}]`
  switch (role) {
    case 'banner':
      return '[Header]'
    case 'navigation':
      return '[Navigation]'
    case 'main':
      return '[Main Content]'
    case 'complementary':
      return '[Sidebar]'
    case 'contentinfo':
      return '[Footer]'
    case 'search':
      return '[Search]'
    default:
      return `[${role}]`
  }
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

// entries -> { snapshot (text), refs: [{ ref, role, name }], refMap: Map(ref ->
// { backendDOMNodeId, role, name, axRole, axName, nth }), truncated }. axRole
// and axName (the tree's own) find a control again after the page re-rendered it.
export function formatSnapshot(entries, maxChars = MAX_SNAPSHOT_CHARS) {
  // Several controls with the same role and name ("Submit" three times): the
  // 2nd and later say so, so the agent can tell them apart.
  const counts = new Map()
  for (const e of entries) if (e.ref) counts.set(`${e.role}:${e.name}`, (counts.get(`${e.role}:${e.name}`) || 0) + 1)
  const occurrence = new Map()
  const refMap = new Map()
  const refs = []
  const lines = []
  let size = 0
  let truncated = false
  for (const e of entries) {
    const indent = '  '.repeat(Math.min(e.depth, 20))
    let line
    if (e.ref) {
      const key = `${e.role}:${e.name}`
      const total = counts.get(key) || 1
      const nth = (occurrence.get(key) || 0) + 1
      occurrence.set(key, nth)
      const shown = total > 1 && nth > 1 ? `${e.name} (${ordinal(nth)})` : e.name
      line = `${indent}[${e.ref}] ${e.role} "${shown}"${e.state ? ` (${e.state})` : ''}`
      // Refs past the cap are not given: the agent only sees what it can use.
      if (!truncated && size + line.length + 1 <= maxChars) {
        refs.push({ ref: e.ref, role: e.role, name: shown, ...(e.state ? { state: e.state } : {}) })
        refMap.set(e.ref, { backendDOMNodeId: e.backendDOMNodeId, role: e.role, name: e.name, axRole: e.axRole || null, axName: e.axName == null ? null : e.axName, nth: total > 1 ? nth : undefined })
      }
    } else line = `${indent}${e.role} "${e.name}"`
    if (truncated) continue
    if (size + line.length + 1 > maxChars) {
      truncated = true
      continue
    }
    lines.push(line)
    size += line.length + 1
  }
  if (truncated) lines.push(`… (snapshot cut at ${maxChars} characters: scroll or use browser_wait / a narrower page to see more)`)
  return { snapshot: lines.join('\n'), refs, refMap, truncated }
}

// The clickable elements the accessibility tree misses (styled <div>s with
// cursor:pointer, onclick, tabindex, contenteditable), found in an isolated
// world. -> entries (role 'clickable', ref to be given).
const CURSOR_SCRIPT = `(() => {
  const SKIP_ROLES = new Set(['button','link','textbox','checkbox','radio','tab','menuitem','option','switch','slider','combobox','searchbox','spinbutton','treeitem','menuitemcheckbox','menuitemradio']);
  const SKIP_TAGS = new Set(['input','button','select','textarea','a']);
  const seen = new Set();
  const found = [];
  function check(el) {
    if (found.length >= ${MAX_CURSOR_INTERACTIVE} || seen.has(el)) return;
    seen.add(el);
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role)) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const text = (el.getAttribute('aria-label') || (el.isContentEditable ? 'editable area' : el.textContent) || '').trim().slice(0, 80);
    if (!text) return;
    found.push(el);
  }
  document.querySelectorAll('[onclick], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]').forEach(check);
  document.querySelectorAll('div, span, li, td, img, svg, label').forEach((el) => {
    if (found.length >= ${MAX_CURSOR_INTERACTIVE}) return;
    try { if (getComputedStyle(el).cursor === 'pointer') check(el); } catch {}
  });
  return found;
})()`

export async function findCursorInteractiveElements(send, existingEntries, contextId) {
  const existing = new Set(existingEntries.map((e) => e.backendDOMNodeId))
  const out = []
  try {
    const { result } = await send('Runtime.evaluate', { expression: CURSOR_SCRIPT, contextId, returnByValue: false })
    if (!result || !result.objectId) return out
    const { result: props } = await send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true })
    for (const p of props || []) {
      if (!/^\d+$/.test(p.name) || !p.value || !p.value.objectId) continue
      try {
        const { node } = await send('DOM.describeNode', { objectId: p.value.objectId })
        if (!node || existing.has(node.backendNodeId)) continue
        const { result: text } = await send('Runtime.callFunctionOn', {
          objectId: p.value.objectId,
          functionDeclaration: "function() { return (this.getAttribute('aria-label') || (this.isContentEditable ? 'editable area' : this.textContent) || '').trim().slice(0, 80) }",
          returnByValue: true
        })
        const name = clip(text && text.value)
        if (name) out.push({ ref: '', role: 'clickable', name, backendDOMNodeId: node.backendNodeId, depth: 0 })
      } catch {
        // gone meanwhile
      }
    }
    await send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {})
  } catch {
    // not critical: the tree alone
  }
  return out
}

// send(method, params) -> CDP result. contextId: an isolated world's (or
// null: no clickable pass).
export async function buildSnapshot(send, { contextId = null, maxChars = MAX_SNAPSHOT_CHARS } = {}) {
  await send('Accessibility.enable')
  const { nodes } = await send('Accessibility.getFullAXTree')
  const list = Array.isArray(nodes) ? nodes : []
  const nodeById = new Map()
  for (const n of list) nodeById.set(n.nodeId, n)
  const entries = []
  let counter = 1
  if (list[0]) walkTree(list[0], nodeById, 0, entries, () => counter++)
  if (contextId != null) {
    for (const e of await findCursorInteractiveElements(send, entries, contextId)) {
      e.ref = `@e${counter++}`
      entries.push(e)
    }
  }
  return formatSnapshot(entries, maxChars)
}
