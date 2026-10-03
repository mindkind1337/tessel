// An agent's input in a browser page, over the page's debugger (CDP): a ref
// from the last snapshot back to its element, a click at its centre, text
// put into a field, a key, the wheel. After Orca's src/main/browser/
// cdp-ref-resolution.ts, cdp-text-input-commands.ts, cdp-pointer-input.ts
// and browser-text-insertion.ts (MIT, Copyright (c) 2026 Lovecast Inc.),
// ported to plain JS.
//
// Tessel's differences: text never goes into a password field. The ref's
// element and the element that really has the keyboard (through shadow
// roots and same-origin frames) are checked in an isolated world before
// each fill, type or printable key; a field once seen as a password stays
// one for the page's life; focus Tessel cannot see is refused (fail closed).

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

// Notes every password field the page has now.
export async function rememberSecrets(send, cache) {
  const ids = remembered(cache)
  try {
    const contextId = await isolatedWorld(send, cache)
    const { result } = await send('Runtime.evaluate', { expression: SECRET_SCAN, contextId, returnByValue: false })
    if (!result || !result.objectId) return ids
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
  } catch {
    // the checks below still apply
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

// Where the keyboard is: { none } (nowhere), or { secret, opaque }. Any
// error counts as opaque (the caller refuses: fail closed).
export async function focusedField(send, cache = null) {
  try {
    const contextId = await isolatedWorld(send, cache)
    const { result } = await send('Runtime.evaluate', { expression: DEEP_ACTIVE, contextId, returnByValue: false })
    if (result && result.type === 'string' && result.value === 'opaque') return { secret: false, opaque: true }
    if (!result || !result.objectId) return { none: true, secret: false, opaque: false }
    const info = await inspectElement(send, result.objectId, cache)
    send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {})
    return info
  } catch {
    return { secret: false, opaque: true }
  }
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
const OPAQUE_REFUSAL = 'Tessel cannot see where the keyboard is in this page (a frame from another site, or a closed component): agents may not type there.'

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
export async function resolveRef(send, state, ref) {
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
  try {
    await describe(send, entry.backendDOMNodeId)
    return entry
  } catch {
    // Re-rendered by the page: the same role and name (the same occurrence) again.
    const found = await recoverRef(send, entry)
    if (found) {
      entry.backendDOMNodeId = found
      return entry
    }
    state.refMap = null
    throw new BrowserInputError('stale_ref', `${key} is no longer on the page: call browser_snapshot again.`)
  }
}

async function recoverRef(send, entry) {
  if (!entry.axRole) return null
  try {
    const { nodes } = await send('Accessibility.getFullAXTree')
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
        return id
      } catch {
        // next
      }
    }
  } catch {
    // none
  }
  return null
}

// The element's centre in the page's viewport, after scrolling it into view.
export async function elementCenter(send, backendNodeId) {
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
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

export async function click(send, backendNodeId, { button = 'left', clickCount = 1 } = {}) {
  const { x, y } = await elementCenter(send, backendNodeId)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (let n = 1; n <= clickCount; n++) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'right' ? 2 : 1, clickCount: n })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: n })
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
async function insertText(send, text, insert = null) {
  for (let i = 0; i < text.length; i += INSERT_CHUNK) {
    const part = text.slice(i, i + INSERT_CHUNK)
    if (insert) await insert(part)
    else await send('Input.insertText', { text: part })
  }
}

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
export async function putText(send, backendNodeId, text, { clear, insert = null, cache = null }) {
  checkText(text)
  await rememberSecrets(send, cache)
  await refuseIfPassword(send, backendNodeId, cache)
  await send('DOM.focus', { backendNodeId })
  // Where the keyboard went (a host may delegate it to an inner field).
  const focus = await focusedField(send, cache)
  if (focus.none) throw new BrowserInputError('not_focusable', 'This element does not take the keyboard: pick a text field from browser_snapshot.')
  refuseField(focus)
  if (clear) await selectContents(send, backendNodeId)
  if (text) await insertText(send, text, insert)
  else if (clear) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
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

// sendInput(event): the page's own input pipeline
// (webContents.sendInputEvent); CDP key events are unreliable in an Electron
// guest (a Backspace or a second character can be lost).
export async function pressKey(send, combo, sendInput = null, cache = null) {
  const { def, modifiers } = parseKeyCombo(combo)
  // A character into a password field is typing a password; focus Tessel
  // cannot see counts as one (fail closed).
  if (typesChar(def) && !(modifiers & 7)) {
    await rememberSecrets(send, cache)
    const focus = await focusedField(send, cache)
    if (!focus.none) refuseField(focus)
  }
  if (sendInput) {
    for (const ev of electronKeyEvents(def, modifiers)) await sendInput(ev)
    return def.key
  }
  const down = { ...def, modifiers, type: def.text ? 'keyDown' : 'rawKeyDown' }
  await send('Input.dispatchKeyEvent', down)
  const up = { ...def, modifiers, type: 'keyUp' }
  delete up.text
  await send('Input.dispatchKeyEvent', up)
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
