// An agent's input in a browser page, over the page's debugger (CDP): a ref
// from the last snapshot back to its element, a click at its centre, text
// put into a field, a key, the wheel. After Orca's src/main/browser/
// cdp-ref-resolution.ts, cdp-text-input-commands.ts, cdp-pointer-input.ts
// and browser-text-insertion.ts (MIT, Copyright (c) 2026 Lovecast Inc.),
// ported to plain JS.
//
// Tessel's differences: text never goes into a password field. The ref's
// element and the element that really has the keyboard (through shadow
// roots and same-origin frames; a frame from another site in its own debugger
// session) are checked in an isolated world before each fill, type or
// printable key; a field once seen as a password stays one for the page's
// life; focus Tessel cannot see is refused (fail closed).

export class BrowserInputError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// Text one fill or type may put in (characters).
export const MAX_INPUT_TEXT = 20000
const INSERT_CHUNK = 4000

// Modifier bits of Input.dispatchKeyEvent / dispatchMouseEvent.
const MODIFIERS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 }

// Input.dispatchKeyEvent needs `text` for keys with a default action
// (Enter, Tab), or Chromium skips the action.
const KEY_DEFINITIONS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
}
const KEY_ALIASES = { esc: 'Escape', return: 'Enter', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pgup: 'PageUp', pgdn: 'PageDown', spacebar: 'Space', ' ': 'Space' }

export function keyDefinition(key) {
  const canonical = KEY_DEFINITIONS[key] ? key : Object.keys(KEY_DEFINITIONS).find((k) => k.toLowerCase() === String(key).toLowerCase()) || KEY_ALIASES[String(key).toLowerCase()]
  if (canonical && KEY_DEFINITIONS[canonical]) return { ...KEY_DEFINITIONS[canonical] }
  if (/^F([1-9]|1[0-2])$/i.test(key)) {
    const n = Number(key.slice(1))
    return { key: `F${n}`, code: `F${n}`, windowsVirtualKeyCode: 111 + n }
  }
  // Sites that check event.code drop events with a wrong one.
  if ([...key].length === 1) {
    const c = key.charCodeAt(0)
    if (c >= 48 && c <= 57) return { key, code: `Digit${key}`, windowsVirtualKeyCode: c, text: key }
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), text: key }
    return { key, code: '', windowsVirtualKeyCode: c, text: key }
  }
  return null
}

// "Enter", "Control+a", "Shift+Tab" -> { def, modifiers } or throws.
export function parseKeyCombo(combo) {
  const raw = String(combo || '').trim()
  if (!raw || raw.length > 40) throw new BrowserInputError('invalid_argument', 'Give a key such as "Enter", "Tab", "ArrowDown", "a" or "Control+a".')
  // A lone "+" is the key itself.
  const parts = raw === '+' ? ['+'] : raw.split('+').map((p) => p.trim())
  if (parts.some((p) => !p)) throw new BrowserInputError('invalid_argument', `Not a key: ${raw}`)
  let modifiers = 0
  for (const m of parts.slice(0, -1)) {
    const bit = MODIFIERS[m.toLowerCase()]
    if (!bit) throw new BrowserInputError('invalid_argument', `Unknown modifier "${m}" (use Control, Shift, Alt or Meta).`)
    modifiers |= bit
  }
  const def = keyDefinition(parts[parts.length - 1])
  if (!def) throw new BrowserInputError('invalid_argument', `Unknown key "${parts[parts.length - 1]}".`)
  // With Control, Alt or Meta held a key types nothing (a shortcut).
  if (modifiers & 7) delete def.text
  return { def, modifiers }
}

// --- Elements ---------------------------------------------------------------------------

// A DOM node's attributes ([name, value, name, value...]) -> object, names lower case.
function attributes(node) {
  const out = {}
  const list = node && Array.isArray(node.attributes) ? node.attributes : []
  for (let i = 0; i + 1 < list.length; i += 2) out[String(list[i]).toLowerCase()] = String(list[i + 1])
  return out
}

// A password field (or one the page marks for a password).
export function isPasswordNode(node) {
  if (!node) return false
  const attrs = attributes(node)
  const name = String(node.nodeName || node.localName || '').toLowerCase()
  if (name === 'input' && String(attrs.type || '').toLowerCase() === 'password') return true
  return /(^|\s)(current|new)-password(\s|$)/i.test(String(attrs.autocomplete || ''))
}

export async function describe(send, backendNodeId) {
  const { node } = await send('DOM.describeNode', { backendNodeId })
  return node
}

// The main frame's isolated world for Tessel's own scripts (the page's
// scripts never see it, nor change what it reads). One per document: kept in
// `cache.world` ({ frameId, loaderId, contextId }) until the page loads
// another document. -> executionContextId
export async function isolatedWorld(send, cache = null) {
  const { frameTree } = await send('Page.getFrameTree')
  const frame = frameTree && frameTree.frame
  if (!frame || !frame.id) throw new BrowserInputError('page_error', 'The page has no frame yet.')
  const w = cache && cache.world
  if (w && w.frameId === frame.id && w.loaderId === (frame.loaderId || null)) return w.contextId
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'tessel-agent', grantUniveralAccess: false })
  if (cache) cache.world = { frameId: frame.id, loaderId: frame.loaderId || null, contextId: executionContextId }
  return executionContextId
}

// Run on an element in the isolated world: does it hold a secret? A password
// input, a field the page marks for a password, or text drawn as dots
// (-webkit-text-security).
const SECRET_FN = `function() {
  const tag = String(this.tagName || '').toLowerCase();
  if (tag === 'input' && String(this.type || '').toLowerCase() === 'password') return true;
  const ac = String((this.getAttribute && this.getAttribute('autocomplete')) || '');
  if (/(^|\\s)(current|new)-password(\\s|$)/i.test(ac)) return true;
  try {
    const view = this.ownerDocument && this.ownerDocument.defaultView;
    const st = view && view.getComputedStyle(this);
    const sec = st && (st.webkitTextSecurity || st.getPropertyValue('-webkit-text-security'));
    if (sec && sec !== 'none') return true;
  } catch (e) {}
  return false;
}`

// The element that really has the keyboard: through open shadow roots and
// same-origin frames. 'opaque' when focus is somewhere Tessel cannot see
// (a cross-origin frame).
const DEEP_ACTIVE = `(() => {
  let el = document.activeElement;
  for (let i = 0; el && i < 64; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'iframe' || tag === 'frame') {
      let d = null;
      try { d = el.contentDocument; } catch (e) { d = null; }
      if (!d) return 'opaque';
      if (d.activeElement && d.activeElement !== d.body) { el = d.activeElement; continue; }
    }
    break;
  }
  return el || null;
})()`

// The same walk, to the <iframe> it cannot look into (where DEEP_ACTIVE said
// 'opaque'): that frame has the keyboard. null when there is none.
const DEEP_FRAME = `(() => {
  let el = document.activeElement;
  for (let i = 0; el && i < 64; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    const tag = String(el.tagName || '').toLowerCase();
    if (tag !== 'iframe' && tag !== 'frame') return null;
    let d = null;
    try { d = el.contentDocument; } catch (e) { d = null; }
    if (!d) return el;
    if (!d.activeElement || d.activeElement === d.body) return null;
    el = d.activeElement;
  }
  return null;
})()`

// The password fields of the page (its document, open shadow roots and
// same-origin frames), as elements, for the page's remembered secrets.
const SECRET_SCAN = `(() => {
  const out = [];
  const visit = (root, depth) => {
    if (!root || depth > 8 || out.length > 200) return;
    let all = [];
    try { all = root.querySelectorAll('*'); } catch (e) { return; }
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if ((tag === 'input' && String(el.type).toLowerCase() === 'password') || /(^|\\s)(current|new)-password(\\s|$)/i.test(el.getAttribute('autocomplete') || '')) out.push(el);
      if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
      if (tag === 'iframe' || tag === 'frame') { let d = null; try { d = el.contentDocument; } catch (e) {} if (d) visit(d, depth + 1); }
    }
  };
  visit(document, 0);
  return out;
})()`

// A page's remembered secret fields (backend node ids): a field seen once as
// a password stays one for the page's life ("show password" toggles its type).
function remembered(cache) {
  if (!cache) return new Set()
  if (!cache.secretIds) cache.secretIds = new Set()
  return cache.secretIds
}

// The password fields one document's isolated world sees, into `ids`.
async function scanSecrets(send, contextId, ids) {
  const { result } = await send('Runtime.evaluate', { expression: SECRET_SCAN, contextId, returnByValue: false })
  if (!result || !result.objectId) return
  const { result: props } = await send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true })
  for (const p of props || []) {
    if (!/^\d+$/.test(p.name) || !p.value || !p.value.objectId) continue
    try {
      const { node } = await send('DOM.describeNode', { objectId: p.value.objectId })
      if (node && node.backendNodeId) ids.add(node.backendNodeId)
    } catch {
      // gone meanwhile
    }
  }
  send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {})
}

// Notes every password field the page has now: its document (and the frames
// it can look into), then each frame of its own process it cannot (another
// site, sandboxed), in that frame's isolated world.
export async function rememberSecrets(send, cache) {
  const ids = remembered(cache)
  try {
    await scanSecrets(send, await isolatedWorld(send, cache), ids)
  } catch {
    // the checks below still apply
  }
  for (const f of await localFrames(send)) {
    try {
      await scanSecrets(send, await frameWorld(send, cache, f.id, f.loaderId), ids)
    } catch {
      // a frame gone meanwhile
    }
  }
  return ids
}

// An element (by objectId in the isolated world) -> { secret, opaque, backendNodeId }.
async function inspectElement(send, objectId, cache) {
  const { result } = await send('Runtime.callFunctionOn', { objectId, functionDeclaration: SECRET_FN, returnByValue: true })
  const { node } = await send('DOM.describeNode', { objectId, depth: 1, pierce: true })
  const backendNodeId = node && node.backendNodeId
  // Focus inside a closed shadow root cannot be seen from here.
  const closed = !!(node && Array.isArray(node.shadowRoots) && node.shadowRoots.some((r) => r && r.shadowRootType === 'closed'))
  const ids = remembered(cache)
  const secret = (result && result.value === true) || (backendNodeId != null && ids.has(backendNodeId))
  if (secret && backendNodeId != null) ids.add(backendNodeId)
  return { secret, opaque: closed, backendNodeId }
}

// The same, in a frame from another site: only if that frame's document
// has the keyboard ('elsewhere' if not).
const FRAME_DEEP_ACTIVE = `(document.hasFocus() ? ${DEEP_ACTIVE} : 'elsewhere')`

// An isolated world in one frame of the page's own process (by its frame id),
// kept in cache.frameWorlds until that frame loads another document.
async function frameWorld(send, cache, frameId, loaderId) {
  const worlds = cache ? cache.frameWorlds || (cache.frameWorlds = new Map()) : null
  const w = worlds && worlds.get(frameId)
  if (w && w.loaderId === loaderId) return w.contextId
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: 'tessel-agent', grantUniveralAccess: false })
  if (worlds) {
    if (worlds.size > 64) worlds.clear()
    worlds.set(frameId, { loaderId, contextId: executionContextId })
  }
  return executionContextId
}

// The frames of the page's own process below its main frame: [{ id, loaderId }].
// A frame from another site is here when Chromium kept it in the page's
// process, and so is a sandboxed frame (srcdoc, about:blank, a game embed):
// the page's own document cannot look into them, an isolated world of that
// frame can. Frames in a process of their own are not here (their own
// debugger sessions, `frames`).
const MAX_LOCAL_FRAMES = 32
async function localFrames(send) {
  try {
    const { frameTree } = await send('Page.getFrameTree')
    const out = []
    const walk = (node, depth) => {
      for (const child of (node && node.childFrames) || []) {
        if (out.length >= MAX_LOCAL_FRAMES || depth > 8) return
        if (child.frame && child.frame.id) out.push({ id: child.frame.id, loaderId: child.frame.loaderId || null })
        walk(child, depth + 1)
      }
    }
    walk(frameTree, 0)
    return out
  } catch {
    return []
  }
}

// One document's keyboard: { none }, { elsewhere }, { inFrame } (in a frame
// it cannot see into) or { secret, opaque }. Errors: opaque.
// world: the frame's isolated world (default: the main frame's).
async function focusIn(send, cache, expression, world = null) {
  try {
    const contextId = world ? await world() : await isolatedWorld(send, cache)
    const { result } = await send('Runtime.evaluate', { expression, contextId, returnByValue: false })
    if (result && result.type === 'string' && result.value === 'elsewhere') return { elsewhere: true }
    if (result && result.type === 'string' && result.value === 'opaque') return { secret: false, opaque: true, inFrame: true }
    if (!result || !result.objectId) return { none: true, secret: false, opaque: false }
    const info = await inspectElement(send, result.objectId, cache)
    send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {})
    return info
  } catch {
    return { secret: false, opaque: true }
  }
}

// Where the keyboard is: { none } (nowhere), or { secret, opaque }. Any
// error counts as opaque (the caller refuses: fail closed). frames: the
// page's frames from other sites ([{ send, cache }], their own debugger
// sessions): focus in one of them is looked at there ({ remote: true }).
// The frame id of the <iframe> a document cannot look into, where its
// keyboard went (DEEP_FRAME), or null.
async function stuckFrameId(send, cache, world = null) {
  try {
    const contextId = world ? await world() : await isolatedWorld(send, cache)
    const { result } = await send('Runtime.evaluate', { expression: DEEP_FRAME, contextId, returnByValue: false })
    if (!result || !result.objectId) return null
    const { node } = await send('DOM.describeNode', { objectId: result.objectId })
    send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {})
    return (node && node.frameId) || null
  } catch {
    return null
  }
}

export async function focusedField(send, cache = null, frames = []) {
  const top = await focusIn(send, cache, DEEP_ACTIVE)
  if (!top.inFrame) return top
  const list = frames || []
  // Down the <iframe> elements that have the keyboard, one document at a
  // time: a frame in a process of its own by its debugger session (its target
  // id is its frame id), one of the page's own process (another site,
  // sandboxed) by an isolated world of that frame. A frame out of sight does
  // not say document.hasFocus() even with the keyboard (harness, 2026-10-25):
  // the <iframe> that has it in its parent is what counts.
  let at = { send, cache, world: null }
  let frameId = await stuckFrameId(send, cache)
  for (let depth = 0; frameId && depth < 8; depth++) {
    const f = list.find((x) => x.cache && x.cache.targetId === frameId)
    if (f) {
      const r = await focusIn(f.send, f.cache, DEEP_ACTIVE)
      if (!r.inFrame) return { ...r, remote: true, frame: f }
      at = { send: f.send, cache: f.cache, world: null }
      frameId = await stuckFrameId(f.send, f.cache)
      continue
    }
    const local = (await localFrames(at.send)).find((x) => x.id === frameId)
    if (!local) break
    const world = () => frameWorld(at.send, at.cache, local.id, local.loaderId)
    const r = await focusIn(at.send, at.cache, DEEP_ACTIVE, world)
    if (!r.inFrame && !(r.opaque && !r.backendNodeId)) return { ...r, remote: true }
    if (!r.inFrame) break
    at = { ...at, world }
    frameId = await stuckFrameId(at.send, at.cache, world)
  }
  // Else the frame whose document says it has the keyboard (its parent frames
  // have it too, but only see their <iframe>).
  for (const f of list) {
    const r = await focusIn(f.send, f.cache, FRAME_DEEP_ACTIVE)
    if (r.elsewhere || r.inFrame) continue
    return { ...r, remote: true, frame: f }
  }
  return { secret: false, opaque: true }
}

// An element by its backend node id -> { secret, opaque } (errors: opaque).
export async function nodeField(send, backendNodeId, cache = null) {
  try {
    if (remembered(cache).has(backendNodeId)) return { secret: true, opaque: false, backendNodeId }
    const contextId = await isolatedWorld(send, cache)
    const { object } = await send('DOM.resolveNode', { backendNodeId, executionContextId: contextId })
    if (!object || !object.objectId) return { secret: false, opaque: true }
    const info = await inspectElement(send, object.objectId, cache)
    send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})
    return info
  } catch {
    return { secret: false, opaque: true }
  }
}

const PASSWORD_REFUSAL = 'Agents may not type into password fields. Ask the user to fill it in.'
export const OPAQUE_REFUSAL =
  'Tessel cannot see what has the keyboard here (a frame from another site it cannot inspect, or a closed component), so it types no characters there: it could be a password field. Click into the game, canvas or field first (browser_click with x/y read on a browser_screenshot), then press again. Keys that type nothing (arrows, Enter, Escape, Tab, F1-F12) work anywhere.'

function refuseField(info) {
  if (info.secret) throw new BrowserInputError('password_field', PASSWORD_REFUSAL)
  if (info.opaque) throw new BrowserInputError('field_not_visible', OPAQUE_REFUSAL)
}

// The current page's navigation entry: refs belong to one.
export async function navigationKey(send) {
  try {
    const { currentIndex, entries } = await send('Page.getNavigationHistory')
    const e = Array.isArray(entries) ? entries[currentIndex] : null
    return e ? `${e.id}` : null
  } catch {
    return null
  }
}

// state: { refMap, navKey } of the page's last snapshot. -> the entry (its
// backendDOMNodeId refreshed when the page re-rendered it) or throws.
// sendOf(entry): the debugger session of the entry's frame (one from another
// site), or throws (that frame is gone); default: the page's own.
export async function resolveRef(send, state, ref, sendOf = null) {
  if (typeof ref !== 'string' || !/^@?e\d{1,6}$/.test(ref)) throw new BrowserInputError('invalid_argument', 'Give a "ref" from browser_snapshot, like "@e3".')
  const key = ref.startsWith('@') ? ref : `@${ref}`
  if (!state || !state.refMap) throw new BrowserInputError('stale_ref', 'No snapshot of this page yet: call browser_snapshot first.')
  const entry = state.refMap.get(key)
  if (!entry) throw new BrowserInputError('ref_not_found', `${key} is not in the last snapshot: call browser_snapshot to see the refs.`)
  const nav = await navigationKey(send)
  if (state.navKey && nav && nav !== state.navKey) {
    state.refMap = null
    throw new BrowserInputError('stale_ref', 'The page changed since the last snapshot: call browser_snapshot again.')
  }
  const at = sendOf ? sendOf(entry) : send
  try {
    await describe(at, entry.backendDOMNodeId)
    // Removed from the page but not yet freed: describeNode still answers.
    if (!(await connected(at, entry.backendDOMNodeId))) throw new Error('detached')
    return entry
  } catch {
    // Re-rendered by the page: the same role and name (the same occurrence) again.
    const found = await recoverRef(at, entry)
    if (found) {
      entry.backendDOMNodeId = found
      return entry
    }
    state.refMap = null
    throw new BrowserInputError('stale_ref', `${key} is no longer on the page: call browser_snapshot again.`)
  }
}

// false only when the element is known to be out of the document.
async function connected(send, backendNodeId) {
  try {
    const { object } = await send('DOM.resolveNode', { backendNodeId })
    if (!object || !object.objectId) return true
    const { result } = await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { return this.isConnected }', returnByValue: true })
    send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})
    return !(result && result.value === false)
  } catch {
    return true
  }
}

async function recoverRef(send, entry) {
  if (!entry.axRole) return null
  try {
    // In the entry's own document (a frame's, by its id).
    const { nodes } = await send('Accessibility.getFullAXTree', entry.frameId ? { frameId: entry.frameId } : {})
    const clipName = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const matches = []
    for (const n of nodes || []) {
      if (n.role && n.role.value === entry.axRole && clipName(n.name && n.name.value).slice(0, 200) === String(entry.axName || '').replace(/…$/, '').slice(0, 200) && n.backendDOMNodeId)
        matches.push(n.backendDOMNodeId)
    }
    // The same occurrence only: with fewer matches than before (an item
    // removed), another element of the same name would be a wrong guess. A
    // name that was unique is taken again only while it still is.
    const candidates = entry.nth ? (entry.nth <= matches.length ? [matches[entry.nth - 1]] : []) : matches.length === 1 ? matches : []
    for (const id of candidates) {
      try {
        await describe(send, id)
        if (!(await connected(send, id))) continue
        return id
      } catch {
        // next
      }
    }
  } catch {
    // none
  } finally {
    // Reading the tree left the page's accessibility on: off again, as
    // agentBrowserSnapshot.js buildSnapshot does (a busy page works harder
    // while it stays on).
    await Promise.resolve()
      .then(() => send('Accessibility.disable'))
      .catch(() => {})
  }
  return null
}

// The element's box in the page's viewport ({ x, y, width, height }: its top
// left corner and size, CSS pixels), after scrolling it into view.
export async function elementBox(send, backendNodeId) {
  try {
    await send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
  } catch {
    // not scrollable (fixed): its box anyway
  }
  let quad = null
  try {
    const { quads } = await send('DOM.getContentQuads', { backendNodeId })
    quad = Array.isArray(quads) && quads.length ? quads[0] : null
  } catch {
    quad = null
  }
  if (!quad) {
    try {
      const { model } = await send('DOM.getBoxModel', { backendNodeId })
      quad = model && model.content
    } catch {
      quad = null
    }
  }
  if (!Array.isArray(quad) || quad.length < 8) throw new BrowserInputError('not_visible', 'This element has no box on the page (hidden or not laid out).')
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

const centerOf = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

// The element's centre in the page's viewport, after scrolling it into view.
export async function elementCenter(send, backendNodeId) {
  return centerOf(await elementBox(send, backendNodeId))
}

// The box of an element of a frame from another site, in the page's
// viewport: in the frame's own viewport (its session's send), plus where the
// frame's box is in its parent, and so on up. frame: { send, owner (its
// <iframe> in the parent session), parent (frame or null: the page) }.
export async function frameElementBox(send, frame, backendNodeId) {
  const at = await elementBox(frame.send, backendNodeId)
  for (let f = frame, depth = 0; f; f = f.parent, depth++) {
    if (!f.owner || depth > 8) throw new BrowserInputError('stale_ref', 'The frame of this element is gone: call browser_snapshot again.')
    const up = f.parent ? f.parent.send : send
    try {
      await up('DOM.scrollIntoViewIfNeeded', { backendNodeId: f.owner })
    } catch {
      // its box anyway
    }
    const { model } = await up('DOM.getBoxModel', { backendNodeId: f.owner })
    const q = model && model.content
    if (!Array.isArray(q) || q.length < 8) throw new BrowserInputError('not_visible', 'The frame of this element has no box on the page (hidden or not laid out).')
    at.x += Math.min(q[0], q[2], q[4], q[6])
    at.y += Math.min(q[1], q[3], q[5], q[7])
  }
  return at
}

export async function frameElementCenter(send, frame, backendNodeId) {
  return centerOf(await frameElementBox(send, frame, backendNodeId))
}

// --- Points (canvas, games: what a screenshot shows) ------------------------------------
// Input.dispatchMouseEvent's buttons bits.
export const BUTTON_BITS = { left: 1, right: 2, middle: 4 }
export function mouseButton(raw) {
  if (raw == null || raw === '') return 'left'
  const b = String(raw).toLowerCase()
  if (!BUTTON_BITS[b]) throw new BrowserInputError('invalid_argument', '"button" must be left, right or middle.')
  return b
}

// A point a little outside (rounding on a scaled screenshot) is taken as the edge.
export const POINT_SLACK = 2
const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v))

// A point an agent gives, in CSS pixels of the page's viewport (vp: { width,
// height }, as browser_screenshot shows it) -> inside it, or throws.
export function viewportPoint(x, y, vp, names = ['x', 'y']) {
  const px = num(x)
  const py = num(y)
  if (!Number.isFinite(px) || !Number.isFinite(py)) throw new BrowserInputError('invalid_argument', `Give "${names[0]}" and "${names[1]}" as numbers: CSS pixels of the page's viewport, as on browser_screenshot.`)
  const w = Math.max(1, Math.floor(vp.width))
  const h = Math.max(1, Math.floor(vp.height))
  if (px < -POINT_SLACK || py < -POINT_SLACK || px > w - 1 + POINT_SLACK || py > h - 1 + POINT_SLACK)
    throw new BrowserInputError('out_of_viewport', `(${Math.round(px)}, ${Math.round(py)}) is outside the page's viewport (${w}x${h} CSS pixels): pick a point on a browser_screenshot, or scroll first.`)
  return { x: Math.min(w - 1, Math.max(0, Math.round(px))), y: Math.min(h - 1, Math.max(0, Math.round(py))) }
}

// A point inside an element's box (box: { x, y, width, height }; offset from
// its top left corner) -> a point of the viewport, or throws.
export function pointInBox(box, ox, oy, vp) {
  const dx = num(ox)
  const dy = num(oy)
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new BrowserInputError('invalid_argument', 'With a "ref", "x" and "y" are a point inside the element (CSS pixels from its top left corner): give both.')
  if (dx < -POINT_SLACK || dy < -POINT_SLACK || dx > box.width + POINT_SLACK || dy > box.height + POINT_SLACK)
    throw new BrowserInputError('out_of_element', `(${Math.round(dx)}, ${Math.round(dy)}) is outside the element (${Math.round(box.width)}x${Math.round(box.height)} CSS pixels).`)
  return viewportPoint(box.x + Math.min(box.width, Math.max(0, dx)), box.y + Math.min(box.height, Math.max(0, dy)), vp)
}

export const MAX_DRAG_STEPS = 100
// A drag: the pointer to `from`, the button pressed, `steps` moves to `to`
// with it held, released there. -> Input.dispatchMouseEvent parameters, in order.
export function dragEvents(from, to, { button = 'left', steps = 10 } = {}) {
  const bit = BUTTON_BITS[button] || 1
  const n = Math.min(MAX_DRAG_STEPS, Math.max(1, Math.round(num(steps)) || 10))
  const out = [
    { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 },
    { type: 'mousePressed', x: from.x, y: from.y, button, buttons: bit, clickCount: 1 }
  ]
  for (let i = 1; i <= n; i++) {
    out.push({ type: 'mouseMoved', x: Math.round(from.x + ((to.x - from.x) * i) / n), y: Math.round(from.y + ((to.y - from.y) * i) / n), button, buttons: bit })
  }
  out.push({ type: 'mouseReleased', x: to.x, y: to.y, button, buttons: 0, clickCount: 1 })
  return out
}

// A mouse move is answered once the page draws its next frame: a page slowed
// to a frame a second (its window minimized after a capture) made each move
// of a drag wait a second. Waited for at most `ms`: the events still reach
// the page in order (a press or release comes after the moves sent before
// it; moves the page could not draw in between are merged, as in a browser).
export function moveSoon(send, params, ms = 100) {
  let timer
  const answered = Promise.resolve()
    .then(() => send('Input.dispatchMouseEvent', params))
    .catch(() => {})
  return Promise.race([answered, new Promise((r) => (timer = setTimeout(r, ms)))]).finally(() => clearTimeout(timer))
}

// at(): where to click (default: the element's centre, in the page's session).
// before(event): called right before each press and release (a right-click's
// page menu kept closed for that point, browserGuest.js quietContextMenu).
export async function click(send, backendNodeId, { button = 'left', clickCount = 1, at = null, before = null } = {}) {
  const { x, y } = at ? await at() : await elementCenter(send, backendNodeId)
  await moveSoon(send, { type: 'mouseMoved', x, y })
  const bit = BUTTON_BITS[button] || 1
  const press = async (ev) => {
    if (before) before(ev)
    await send('Input.dispatchMouseEvent', ev)
  }
  for (let n = 1; n <= clickCount; n++) {
    await press({ type: 'mousePressed', x, y, button, buttons: bit, clickCount: n })
    await press({ type: 'mouseReleased', x, y, button, buttons: 0, clickCount: n })
  }
  return { x: Math.round(x), y: Math.round(y) }
}

// The field itself (a remembered secret, a password, dots) and, after it
// took the keyboard, where the keyboard really is (a component that hands
// focus to an inner password field): refused when either is a secret or
// cannot be seen.
export async function refuseIfPassword(send, backendNodeId, cache = null) {
  refuseField(await nodeField(send, backendNodeId, cache))
}

// insert(text): the page's own input pipeline (webContents.insertText):
// CDP's Input.insertText types nothing in an Electron guest (Orca found the
// same and edits through the browser instead).
// Where the keyboard is, looked at again right before each piece goes in:
// the page can move it after the first look (a focus handler's timer,
// auto-advance to the next field), never into a password field.
// Focus in a frame from another site: CDP's Input.insertText, which types
// there (webContents.insertText crashes such a frame's page in Electron 42).
async function insertText(keys, text, insert = null, focusNow) {
  for (let i = 0; i < text.length; i += INSERT_CHUNK) {
    const part = text.slice(i, i + INSERT_CHUNK)
    const focus = await focusNow()
    if (focus.none) throw new BrowserInputError('not_focusable', 'The keyboard left the field: call browser_snapshot again.')
    refuseField(focus)
    if (insert && !focus.remote) await insert(part)
    else await keys('Input.insertText', { text: part })
  }
}

// The same typing, by another name (for a caller that types at the page's
// keyboard wherever it is): the same path, the same checks.
export { insertText as insertFocusedText }

function checkText(text) {
  if (typeof text !== 'string') throw new BrowserInputError('invalid_argument', 'Give the "text" to put in.')
  if (text.length > MAX_INPUT_TEXT) throw new BrowserInputError('invalid_argument', `The text is too long (at most ${MAX_INPUT_TEXT} characters).`)
}

// Select what the element holds (fill replaces it).
async function selectContents(send, backendNodeId) {
  const { object } = await send('DOM.resolveNode', { backendNodeId })
  if (!object || !object.objectId) return
  await send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: `function() {
      if (typeof this.select === 'function' && 'value' in this) { this.select(); return; }
      const sel = this.ownerDocument.getSelection();
      if (sel && this.isContentEditable) { const r = this.ownerDocument.createRange(); r.selectNodeContents(this); sel.removeAllRanges(); sel.addRange(r); }
    }`
  })
  send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})
}

// Replaces the field's text (fill) or adds at the cursor (type). cache: the
// page's state (its isolated world, its remembered secret fields).
// A list (<select>) takes no typed text: its option is chosen by label (or
// value), as a person picks it. -> { label } or throws, naming the options.
const CHOOSE_OPTION = `function (want) {
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().toLowerCase()
  const w = norm(want)
  const opts = Array.from(this.options || [])
  const o = opts.find((x) => norm(x.label || x.text) === w) || opts.find((x) => norm(x.value) === w)
  const labels = opts.slice(0, 50).map((x) => String(x.label || x.text).slice(0, 80))
  if (this.disabled) return { ok: false, disabled: true, labels }
  if (!o || o.disabled) return { ok: false, labels }
  o.selected = true
  this.dispatchEvent(new Event('input', { bubbles: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, label: String(o.label || o.text).slice(0, 80) }
}`
async function chooseOption(send, backendNodeId, text) {
  const { object } = await send('DOM.resolveNode', { backendNodeId })
  if (!object || !object.objectId) throw new BrowserInputError('stale_ref', 'The list is gone: call browser_snapshot again.')
  try {
    const r = await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: CHOOSE_OPTION, arguments: [{ value: text }], returnByValue: true })
    const v = (r && r.result && r.result.value) || {}
    if (v.ok) return { option: v.label }
    if (v.disabled) throw new BrowserInputError('disabled_field', 'This list is disabled.')
    const choices = Array.isArray(v.labels) && v.labels.length ? v.labels.join(', ') : '(none)'
    throw new BrowserInputError('no_option', `No option "${String(text).slice(0, 80)}" in this list. Its options: ${choices}`)
  } finally {
    send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})
  }
}

// send and cache: the element's document's (a frame from another site: its
// own session's). keys: the page's session (input goes through the page),
// focusNow(): where the keyboard really is, from the page down
// (focusedField with the page's frames); defaults: the element's own.
export async function putText(send, backendNodeId, text, { clear, insert = null, cache = null, keys = send, focusNow = () => focusedField(send, cache) }) {
  checkText(text)
  await rememberSecrets(send, cache)
  await refuseIfPassword(send, backendNodeId, cache)
  const node = await describe(send, backendNodeId).catch(() => null)
  if (node && String(node.nodeName || '').toUpperCase() === 'SELECT') return chooseOption(send, backendNodeId, text)
  await send('DOM.focus', { backendNodeId })
  // Where the keyboard went (a host may delegate it to an inner field).
  const focus = await focusNow()
  if (focus.none) throw new BrowserInputError('not_focusable', 'This element does not take the keyboard: pick a text field from browser_snapshot.')
  refuseField(focus)
  if (clear) await selectContents(send, backendNodeId)
  if (text) await insertText(keys, text, insert, focusNow)
  else if (clear) {
    await keys('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
    await keys('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
  }
  // Frameworks that listen for "change" (React's onChange on some inputs) hear it.
  try {
    const { object } = await send('DOM.resolveNode', { backendNodeId })
    if (object && object.objectId) {
      await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: "function() { this.dispatchEvent(new Event('change', { bubbles: true })) }" })
      send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})
    }
  } catch {
    // the element went away (a form that submitted)
  }
}

// A key that types a character (Enter and Tab act on their keyDown).
const typesChar = (def) => !!def.text && def.key !== 'Enter' && def.key !== 'Tab'

// Electron's names for keys (webContents.sendInputEvent's keyCode).
const ELECTRON_KEYS = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space' }
const MODIFIER_NAMES = [
  [1, 'alt'],
  [2, 'control'],
  [4, 'meta'],
  [8, 'shift']
]

// def + modifiers -> the input events of webContents.sendInputEvent.
export function electronKeyEvents(def, modifiers) {
  const keyCode = ELECTRON_KEYS[def.key] || def.key
  const mods = MODIFIER_NAMES.filter(([bit]) => modifiers & bit).map(([, name]) => name)
  const events = [{ type: 'keyDown', keyCode, modifiers: mods }]
  // A character is typed by its char event. Enter too (alone or with Shift):
  // without it a form is not submitted and a text area gets no new line.
  // Tab acts on its keyDown.
  if (typesChar(def) || (def.key === 'Enter' && !(modifiers & 7))) events.push({ type: 'char', keyCode: def.text, modifiers: mods })
  events.push({ type: 'keyUp', keyCode, modifiers: mods })
  return events
}

// A key held (games read held keys) and pressed again: browser_press's
// "hold_ms" and "repeat" -> { holdMs, repeat, gapMs } or throws.
export const MAX_HOLD_MS = 10000
export const MAX_REPEAT = 100
export const MAX_PRESS_MS = 30000
export const REPEAT_GAP_MS = 30
// A hold is looked at this often for a Stop.
const HOLD_STEP_MS = 50
export function keyTiming(holdMs, repeat) {
  const hold = holdMs == null || holdMs === '' ? 0 : num(holdMs)
  const times = repeat == null || repeat === '' ? 1 : num(repeat)
  if (!Number.isFinite(hold) || hold < 0 || hold > MAX_HOLD_MS) throw new BrowserInputError('invalid_argument', `"hold_ms" must be 0 to ${MAX_HOLD_MS} (milliseconds the key stays down).`)
  if (!Number.isInteger(times) || times < 1 || times > MAX_REPEAT) throw new BrowserInputError('invalid_argument', `"repeat" must be a whole number from 1 to ${MAX_REPEAT}.`)
  if (times * (hold + REPEAT_GAP_MS) > MAX_PRESS_MS) throw new BrowserInputError('invalid_argument', `hold_ms x repeat must stay under ${MAX_PRESS_MS / 1000} seconds.`)
  return { holdMs: Math.round(hold), repeat: times, gapMs: REPEAT_GAP_MS }
}

// sendInput(event): the page's own input pipeline
// (webContents.sendInputEvent); CDP key events are unreliable in an Electron
// guest (a Backspace or a second character can be lost).
// frames: the page's frames from other sites (see focusedField).
// timing: { holdMs, repeat, gapMs } (keyTiming): the key stays down holdMs
// between its keyDown and its keyUp, `repeat` times.
// check(): throws when the press must stop (the user's Stop, the setting
// turned off, the command's time up): looked at before each press and all
// through a hold; a key held down is let up first.
export async function pressKey(send, combo, sendInput = null, cache = null, frames = [], timing = null, check = null) {
  const { def, modifiers } = parseKeyCombo(combo)
  const { holdMs = 0, repeat = 1, gapMs = REPEAT_GAP_MS } = timing || {}
  const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null)
  const stop = () => {
    if (check) check()
  }
  const hold = async (ms, up) => {
    const until = Date.now() + ms
    for (;;) {
      try {
        stop()
      } catch (err) {
        await Promise.resolve()
          .then(up)
          .catch(() => {})
        throw err
      }
      const left = until - Date.now()
      if (left <= 0) return
      await wait(Math.min(HOLD_STEP_MS, left))
    }
  }
  const printable = typesChar(def) && !(modifiers & 7)
  for (let i = 0; i < repeat; i++) {
    if (i) await wait(gapMs)
    stop()
    // A character into a password field is typing a password; focus Tessel
    // cannot see counts as one (fail closed). Looked at before each press.
    if (printable) {
      await rememberSecrets(send, cache)
      for (const f of frames || []) await rememberSecrets(f.send, f.cache)
    }
    // Where the keyboard is also says where the keys go: webContents.sendInputEvent
    // reaches the page's own process only, so a frame in a process of its
    // own (another site, a sandboxed game embed) gets them by its debugger
    // session (harness, 2026-10-25: sent the other way they were lost).
    const focus = await focusedField(send, cache, frames)
    if (printable && !focus.none) refuseField(focus)
    const frameSend = focus && focus.frame && typeof focus.frame.send === 'function' ? focus.frame.send : null
    if (sendInput && !frameSend) {
      const events = electronKeyEvents(def, modifiers)
      const upEvent = events[events.length - 1]
      for (const ev of events.slice(0, -1)) await sendInput(ev)
      await hold(holdMs, () => sendInput(upEvent))
      await sendInput(upEvent)
      continue
    }
    const keys = frameSend || send
    const down = { ...def, modifiers, type: def.text ? 'keyDown' : 'rawKeyDown' }
    const up = { ...def, modifiers, type: 'keyUp' }
    delete up.text
    await keys('Input.dispatchKeyEvent', down)
    await hold(holdMs, () => keys('Input.dispatchKeyEvent', up))
    await keys('Input.dispatchKeyEvent', up)
  }
  return def.key
}

const SCROLL_DIRS = { down: [0, 1], up: [0, -1], right: [1, 0], left: [-1, 0] }
export const MAX_SCROLL_PX = 20000

// The wheel at the viewport's centre (or over an element).
export async function wheel(send, direction, amount, at = null) {
  const dir = SCROLL_DIRS[String(direction || 'down').toLowerCase()]
  if (!dir) throw new BrowserInputError('invalid_argument', '"direction" must be up, down, left or right.')
  const px = Math.min(MAX_SCROLL_PX, Math.max(1, Math.round(Number(amount) || 600)))
  let x = at ? at.x : 0
  let y = at ? at.y : 0
  if (!at) {
    const m = await send('Page.getLayoutMetrics')
    const v = (m && (m.cssLayoutViewport || m.layoutViewport)) || { clientWidth: 800, clientHeight: 600 }
    x = v.clientWidth / 2
    y = v.clientHeight / 2
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dir[0] * px, deltaY: dir[1] * px })
  return px
}
