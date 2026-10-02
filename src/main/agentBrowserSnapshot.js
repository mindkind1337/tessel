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
// listed (a field's text, a password).

export const MAX_SNAPSHOT_CHARS = 60000
// Clickable elements without a role, at most.
const MAX_CURSOR_INTERACTIVE = 50
const MAX_NAME = 200

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

const clip = (s) => {
  const text = String(s || '').replace(/\s+/g, ' ').trim()
  return text.length > MAX_NAME ? `${text.slice(0, MAX_NAME)}…` : text
}

// One AX node and its children -> entries ({ ref, role, name, backendDOMNodeId, depth }).
export function walkTree(node, nodeById, depth, entries, nextRef, seen = new Set()) {
  if (!node || seen.has(node.nodeId)) return
  seen.add(node.nodeId)
  if (node.ignored) return walkChildren(node, nodeById, depth, entries, nextRef, seen)

  const role = (node.role && node.role.value) || ''
  const name = clip(node.name && node.name.value)

  if (SKIP_ROLES.has(role)) return walkChildren(node, nodeById, depth, entries, nextRef, seen)

  const isInteractive = INTERACTIVE_ROLES.has(role)
  const isHeading = role === 'heading'
  const isLandmark = LANDMARK_ROLES.has(role)
  const isStaticText = role === 'staticText' || role === 'StaticText'

  if (!isInteractive && !isHeading && !isLandmark && !isStaticText) return walkChildren(node, nodeById, depth, entries, nextRef, seen)
  if (!name && !isLandmark) return walkChildren(node, nodeById, depth, entries, nextRef, seen)

  if (isLandmark) {
    entries.push({ ref: '', role: formatLandmarkRole(role, name), name: name || role, backendDOMNodeId: node.backendDOMNodeId || 0, depth })
    return walkChildren(node, nodeById, depth + 1, entries, nextRef, seen)
  }
  if (isHeading) {
    entries.push({ ref: '', role: 'heading', name, backendDOMNodeId: node.backendDOMNodeId || 0, depth })
    return
  }
  if (isStaticText) {
    entries.push({ ref: '', role: 'text', name, backendDOMNodeId: node.backendDOMNodeId || 0, depth })
    return
  }
  if (isInteractive && (isFocusable(node) || node.backendDOMNodeId)) {
    entries.push({ ref: `@e${nextRef()}`, role: formatInteractiveRole(role), axRole: role, axName: name, name: name || '(unlabeled)', backendDOMNodeId: node.backendDOMNodeId || 0, depth })
    return
  }
  walkChildren(node, nodeById, depth, entries, nextRef, seen)
}

function walkChildren(node, nodeById, depth, entries, nextRef, seen) {
  if (!Array.isArray(node.childIds)) return
  for (const id of node.childIds) {
    const child = nodeById.get(id)
    if (child) walkTree(child, nodeById, depth, entries, nextRef, seen)
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
      line = `${indent}[${e.ref}] ${e.role} "${shown}"`
      // Refs past the cap are not given: the agent only sees what it can use.
      if (!truncated && size + line.length + 1 <= maxChars) {
        refs.push({ ref: e.ref, role: e.role, name: shown })
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
    const text = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80);
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
          functionDeclaration: "function() { return (this.getAttribute('aria-label') || this.textContent || '').trim().slice(0, 80) }",
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
