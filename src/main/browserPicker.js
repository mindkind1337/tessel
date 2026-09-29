// After Orca's browser grab tools (MIT, Copyright (c) 2026 Lovecast Inc.):
// src/main/browser/grab-guest-*.ts, browser-grab-payload.ts, src/shared/browser-grab-types.ts
//
// Design Mode's element picker. pickerScript('arm') is run in the browser
// pane's guest page (guest.executeJavaScript(script, true)); its promise
// resolves with the context of the element the user clicks, or
// { cancelled: true }. clampPickPayload() re-checks that result in main,
// because whatever comes back from a web page is untrusted.

// Size budgets, enforced in the guest and again by clampPickPayload.
export const PICK_BUDGET = Object.freeze({
  tag: 50,
  selector: 700,
  path: 900,
  classes: 500,
  classAttribute: 200,
  text: 200,
  selectedText: 500,
  html: 4096,
  react: 500,
  source: 500,
  title: 300,
  url: 2048,
  role: 100,
  accessibleName: 500,
  attributeValue: 300,
  attributes: 20,
  styleValue: 500,
  ancestors: 10,
  ancestorEntry: 200,
  nearbyText: 10,
  nearbyTextEntry: 200,
  label: 40
})

// Only these attributes (plus aria-*) leave the page.
export const PICK_SAFE_ATTRIBUTES = Object.freeze([
  'id', 'class', 'name', 'type', 'role', 'href', 'src', 'alt',
  'title', 'placeholder', 'for', 'action', 'method'
])

// Values containing one of these are replaced by '[redacted]'. Narrow on
// purpose: broad words like 'code' or 'state' match ordinary class names.
export const PICK_SECRET_PATTERNS = Object.freeze([
  'access_token', 'auth_token', 'api_key', 'apikey', 'client_secret',
  'oauth_state', 'x-amz-', 'session_id', 'sessionid', 'csrf',
  'secret', 'password', 'passwd'
])

export const PICK_STYLE_PROPS = Object.freeze([
  'display', 'position', 'width', 'height', 'margin', 'padding',
  'color', 'backgroundColor', 'border', 'borderRadius', 'fontFamily',
  'fontSize', 'fontWeight', 'lineHeight', 'textAlign', 'zIndex'
])

export const PICK_HOST_ID = '__tessel-pick-host'

// Attributes holding a URL: their query and hash can carry tokens.
const URL_ATTRIBUTES = ['href', 'src', 'action', 'formaction', 'poster']

// ---------------------------------------------------------------------------
// Guest script. String.raw so regexes and escapes read as they run; it must
// never contain a backtick or a dollar-brace. No line may start with ( or [
// (the script has no semicolons).
// ---------------------------------------------------------------------------

const GUEST_HELPERS = String.raw`
var TEXT_NODE_SCAN_LIMIT = 80
var NEARBY_ELEMENT_SCAN_LIMIT = 80
var SAFE_ATTR_SET = Object.create(null)
for (var sai = 0; sai < SAFE_ATTRS.length; sai++) SAFE_ATTR_SET[SAFE_ATTRS[sai]] = true
var URL_ATTR_SET = Object.create(null)
for (var uai = 0; uai < URL_ATTRS.length; uai++) URL_ATTR_SET[URL_ATTRS[uai]] = true

function clampStr(s, max) {
  if (!s || typeof s !== 'string') return ''
  if (s.length <= max) return s
  return s.slice(0, max) + ' (truncated)'
}

function containsSecret(value) {
  if (!value) return false
  var lower = String(value).toLowerCase()
  for (var i = 0; i < SECRET_PATTERNS.length; i++) {
    if (lower.indexOf(SECRET_PATTERNS[i]) !== -1) return true
  }
  return false
}

// Page URL: http(s) only, without query or hash (tokens live there).
function sanitizeUrl(url) {
  try {
    var u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    u.search = ''
    u.hash = ''
    return clampStr(u.toString(), BUDGET.url)
  } catch (e) {
    return ''
  }
}

// URL attribute (often relative): drop script/data schemes, cut query and hash.
function stripUrlAttr(value) {
  var v = String(value || '').trim()
  if (/^(?:javascript|vbscript|data):/i.test(v.replace(/[\s\u0000-\u001f]+/g, ''))) return ''
  var cut = v.search(/[?#]/)
  return cut === -1 ? v : v.slice(0, cut)
}

function createTextAccumulator() {
  return { text: '', pendingSpace: false }
}

function isWhitespaceCode(code) {
  return code === 32 || (code >= 9 && code <= 13) || code === 160 ||
    code === 5760 || (code >= 8192 && code <= 8202) || code === 8232 ||
    code === 8233 || code === 8239 || code === 8287 || code === 12288 ||
    code === 65279
}

function appendTextSeparator(acc) {
  if (acc.text.length > 0) acc.pendingSpace = true
}

function appendNormalizedText(acc, text, max) {
  var limit = max + 20
  var value = String(text || '')
  for (var i = 0; i < value.length && acc.text.length < limit; i++) {
    var code = value.charCodeAt(i)
    if (isWhitespaceCode(code)) {
      if (acc.text.length > 0) acc.pendingSpace = true
      continue
    }
    if (acc.pendingSpace) {
      acc.text += ' '
      acc.pendingSpace = false
      if (acc.text.length >= limit) break
    }
    acc.text += value.charAt(i)
  }
}

function finishAccumulatedText(acc, max) {
  return clampStr(acc.text, max)
}

// Whitespace-collapsed text of an element, reading only what fits the budget.
function getBoundedText(el, max) {
  try {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    var acc = createTextAccumulator()
    var inspected = 0
    var node = walker.nextNode()
    while (node && acc.text.length < max + 20 && inspected < TEXT_NODE_SCAN_LIMIT) {
      inspected++
      appendTextSeparator(acc)
      var remaining = max + 20 - acc.text.length - (acc.pendingSpace ? 1 : 0)
      if (remaining <= 0) break
      appendNormalizedText(acc, (node.nodeValue || '').slice(0, remaining), max)
      node = walker.nextNode()
    }
    return finishAccumulatedText(acc, max)
  } catch (e) {
    return ''
  }
}

function getSelectedText() {
  try {
    var selection = window.getSelection ? window.getSelection() : null
    if (!selection || selection.rangeCount === 0) return ''
    var acc = createTextAccumulator()
    var inspected = 0
    var max = BUDGET.selectedText
    for (var i = 0; i < selection.rangeCount && acc.text.length < max + 20; i++) {
      var range = selection.getRangeAt(i)
      var walkerRoot = range.commonAncestorContainer
      var walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (range.intersectsNode && !range.intersectsNode(node)) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        }
      })
      var node = walkerRoot.nodeType === Node.TEXT_NODE ? walkerRoot : walker.nextNode()
      while (node && acc.text.length < max + 20 && inspected < TEXT_NODE_SCAN_LIMIT) {
        inspected++
        var value = node.nodeValue || ''
        appendTextSeparator(acc)
        var remaining = max + 20 - acc.text.length - (acc.pendingSpace ? 1 : 0)
        if (remaining <= 0) break
        if (value) {
          var start = node === range.startContainer ? range.startOffset : 0
          var end = node === range.endContainer ? range.endOffset : value.length
          if (end > start + remaining) end = start + remaining
          if (node === range.startContainer) start = Math.min(start, value.length)
          appendNormalizedText(acc, value.slice(start, end), max)
        }
        node = walker.nextNode()
      }
    }
    return finishAccumulatedText(acc, max)
  } catch (e) {
    return ''
  }
}

// Scripts removed; secret-looking attributes, hidden/password input values
// and URL queries scrubbed, since the snippet goes to an agent verbatim.
function scrubClone(root) {
  var nodes = [root]
  var inner = root.querySelectorAll ? root.querySelectorAll('*') : []
  for (var i = 0; i < inner.length && nodes.length < 5000; i++) nodes.push(inner[i])
  for (var n = 0; n < nodes.length; n++) {
    var node = nodes[n]
    var tag = node.tagName ? node.tagName.toLowerCase() : ''
    if (tag === 'script') {
      if (node.parentNode) node.parentNode.removeChild(node)
      continue
    }
    var attrs = node.attributes ? Array.prototype.slice.call(node.attributes) : []
    var type = tag === 'input' ? String(node.getAttribute('type') || '').toLowerCase() : ''
    for (var a = 0; a < attrs.length; a++) {
      var name = attrs[a].name
      var lower = name.toLowerCase()
      var value = attrs[a].value
      if (lower === 'value' && (type === 'password' || type === 'hidden')) {
        node.setAttribute(name, '[redacted]')
      } else if (containsSecret(lower) || containsSecret(value)) {
        node.setAttribute(name, '[redacted]')
      } else if (URL_ATTR_SET[lower] && value) {
        node.setAttribute(name, stripUrlAttr(value))
      }
    }
  }
}

function getHtmlSnippet(el) {
  var clone = el.cloneNode(true)
  scrubClone(clone)
  return clampStr(clone.outerHTML || '', BUDGET.html)
}

function getSafeAttributes(el) {
  var attrs = {}
  var count = 0
  for (var i = 0; i < el.attributes.length && count < BUDGET.attributes; i++) {
    var attr = el.attributes[i]
    var name = attr.name.toLowerCase()
    var isAria = name.indexOf('aria-') === 0
    if (!SAFE_ATTR_SET[name] && !isAria) continue
    var value = attr.value
    if (containsSecret(value)) {
      attrs[name] = '[redacted]'
    } else if (URL_ATTR_SET[name] && value) {
      attrs[name] = clampStr(stripUrlAttr(value), BUDGET.attributeValue)
    } else if (name === 'class') {
      attrs[name] = clampStr(value, BUDGET.classAttribute)
    } else {
      attrs[name] = clampStr(value, BUDGET.attributeValue)
    }
    count++
  }
  return attrs
}

// aria-labelledby is page-controlled: split it without a regex on huge values.
function getAriaLabelledByIds(value) {
  var ids = []
  var tokenStart = -1
  for (var index = 0; index <= value.length; index++) {
    var isEnd = index === value.length
    if (!isEnd && !isWhitespaceCode(value.charCodeAt(index))) {
      if (tokenStart === -1) tokenStart = index
      continue
    }
    if (tokenStart !== -1) {
      ids.push(value.slice(tokenStart, index))
      tokenStart = -1
      if (ids.length >= 32) break
    }
  }
  return ids
}

function getAccessibility(el) {
  var role = el.getAttribute('role') || el.tagName.toLowerCase()
  var ariaLabel = el.getAttribute('aria-label') || null
  var ariaLabelledBy = el.getAttribute('aria-labelledby') || null
  var accessibleName = null
  if (ariaLabel) {
    accessibleName = ariaLabel
  } else if (ariaLabelledBy) {
    var parts = getAriaLabelledByIds(ariaLabelledBy)
    var names = []
    for (var i = 0; i < parts.length; i++) {
      var ref = document.getElementById(parts[i])
      if (ref) names.push(getBoundedText(ref, 100))
    }
    if (names.length) accessibleName = names.join(' ')
  } else {
    var tag = el.tagName.toLowerCase()
    if (tag === 'button' || tag === 'a' || tag === 'label') {
      accessibleName = getBoundedText(el, 100)
    } else if (el.getAttribute('title')) {
      accessibleName = el.getAttribute('title')
    } else if (el.getAttribute('alt')) {
      accessibleName = el.getAttribute('alt')
    }
  }
  if (accessibleName && containsSecret(accessibleName)) accessibleName = '[redacted]'
  return {
    role: clampStr(role, BUDGET.role) || null,
    accessibleName: clampStr(accessibleName, BUDGET.accessibleName) || null
  }
}

function getComputedStyleSubset(el) {
  var result = {}
  var cs = null
  try { cs = window.getComputedStyle(el) } catch (e) {}
  for (var i = 0; i < STYLE_PROPS.length; i++) {
    var css = STYLE_PROPS[i].replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase() })
    result[STYLE_PROPS[i]] = cs ? clampStr(cs.getPropertyValue(css) || '', BUDGET.styleValue) : ''
  }
  return result
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value)
  return String(value).replace(/[^a-zA-Z0-9_-]/g, function (ch) { return '\\' + ch })
}

// Build-generated class names (css-1x2y3z, hashes) change on every build.
function looksHashy(value) {
  return /^[A-Za-z0-9_-]{12,}$/.test(value) && /\d/.test(value) && /[A-Z]/.test(value)
}

function getStableClasses(el, maxCount) {
  if (!el.classList) return []
  var result = []
  for (var i = 0; i < el.classList.length && result.length < maxCount; i++) {
    var cls = el.classList[i]
    if (!cls || cls.length > 60 || containsSecret(cls)) continue
    if (/^css-[a-z0-9]+$/i.test(cls) || looksHashy(cls)) continue
    result.push(cls)
  }
  return result
}

function buildSelectorPart(el) {
  var tag = el.tagName.toLowerCase()
  var id = el.id
  if (id && !containsSecret(id)) return tag + '#' + cssEscape(id)
  var classes = getStableClasses(el, 2)
  if (classes.length > 0) {
    return tag + classes.map(function (cls) { return '.' + cssEscape(cls) }).join('')
  }
  return tag
}

function isUniqueSelector(selector) {
  try {
    return document.querySelectorAll(selector).length === 1
  } catch (e) {
    return false
  }
}

function getNthOfTypeSuffix(current) {
  var tag = current.tagName
  var index = 1
  var sibling = current.previousElementSibling
  while (sibling) {
    if (sibling.tagName === tag) index++
    sibling = sibling.previousElementSibling
  }
  if (index > 1) return ':nth-of-type(' + index + ')'
  sibling = current.nextElementSibling
  while (sibling) {
    if (sibling.tagName === tag) return ':nth-of-type(1)'
    sibling = sibling.nextElementSibling
  }
  return ''
}

// Shortest unique selector walking up from the element (at most 10 steps).
function buildSelector(el) {
  var parts = []
  var current = el
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && parts.length < 10) {
    var part = buildSelectorPart(current)
    var parent = current.parentElement
    if (parent && !isUniqueSelector([part].concat(parts).join(' > '))) {
      part += getNthOfTypeSuffix(current)
    }
    parts.unshift(part)
    var selector = parts.join(' > ')
    if (isUniqueSelector(selector)) return clampStr(selector, BUDGET.selector)
    current = parent
  }
  return clampStr(parts.join(' > ') || el.tagName.toLowerCase(), BUDGET.selector)
}

function buildReadablePath(el) {
  var parts = []
  var current = el
  while (current && current !== document.documentElement && parts.length < 6) {
    var tag = current.tagName.toLowerCase()
    if (tag === 'html' || tag === 'body') break
    var label = tag
    var aria = current.getAttribute('aria-label')
    var role = current.getAttribute('role')
    var stableClasses = getStableClasses(current, 1)
    if (current.id && !containsSecret(current.id)) {
      label = '#' + cssEscape(current.id)
    } else if (aria && !containsSecret(aria)) {
      label = tag + '[aria-label="' + clampStr(aria, 40).replace(/"/g, '\\"') + '"]'
    } else if (role && !containsSecret(role)) {
      label = tag + '[role="' + clampStr(role, 30).replace(/"/g, '\\"') + '"]'
    } else if (stableClasses.length > 0) {
      label = '.' + cssEscape(stableClasses[0])
    }
    parts.unshift(label)
    current = current.parentElement
  }
  return clampStr(parts.join(' > '), BUDGET.path)
}

function buildFullPath(el) {
  var parts = []
  var current = el
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement && parts.length < 20) {
    parts.unshift(buildSelectorPart(current))
    current = current.parentElement
  }
  return clampStr(parts.join(' > '), BUDGET.path)
}

// Text of the closest siblings, alternating before and after.
function getNearbyText(el) {
  var results = []
  if (!el.parentElement) return results
  function addSiblingText(sibling) {
    var text = getBoundedText(sibling, BUDGET.nearbyTextEntry)
    if (text) results.push(text)
  }
  var inspected = 0
  var previous = el.previousElementSibling
  var next = el.nextElementSibling
  while (results.length < BUDGET.nearbyText && inspected < NEARBY_ELEMENT_SCAN_LIMIT && (previous || next)) {
    if (previous) {
      var previousSibling = previous
      previous = previous.previousElementSibling
      inspected++
      addSiblingText(previousSibling)
    }
    if (next && results.length < BUDGET.nearbyText && inspected < NEARBY_ELEMENT_SCAN_LIMIT) {
      var nextSibling = next
      next = next.nextElementSibling
      inspected++
      addSiblingText(nextSibling)
    }
  }
  return results
}

function getAncestorPath(el) {
  var path = []
  var current = el.parentElement
  while (current && current !== document.documentElement && path.length < BUDGET.ancestors) {
    var tag = current.tagName.toLowerCase()
    var role = current.getAttribute('role')
    path.push(clampStr(role ? tag + '[role=' + role + ']' : tag, BUDGET.ancestorEntry))
    current = current.parentElement
  }
  return path
}

function getFiberFromElement(el) {
  var keys = Object.keys(el)
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) {
      try {
        return el[keys[i]] || null
      } catch (e) {
        return null
      }
    }
  }
  return null
}

function getComponentNameFromFiber(fiber) {
  if (!fiber) return null
  var type = fiber.type || fiber.elementType
  if (!type || typeof type === 'string') return null
  if (type.displayName || type.name) return type.displayName || type.name
  if (type.render && (type.render.displayName || type.render.name)) {
    return type.render.displayName || type.render.name
  }
  if (type.type && (type.type.displayName || type.type.name)) {
    return type.type.displayName || type.type.name
  }
  return null
}

// Framework plumbing (providers, routers, boundaries) says nothing about the UI.
function shouldSkipReactName(name) {
  if (!name || typeof name !== 'string' || name.length <= 2) return true
  return /^(Fragment|Root|Routes|Route|Outlet|Provider|Consumer|Profiler|Suspense)$/.test(name) ||
    /(?:Boundary|BoundaryHandler|Router|Provider|Consumer|Context|Wrapper)$/.test(name) ||
    /^(Inner|Outer|Client|Server|RSC|Dev|React|Hot)/.test(name)
}

function cleanSourcePath(path) {
  if (!path) return ''
  return String(path)
    .replace(/[?#].*$/, '')
    .replace(/^turbopack:\/\/\/\[project\]\//, '')
    .replace(/^webpack-internal:\/\/\/\.\//, '')
    .replace(/^webpack-internal:\/\/\//, '')
    .replace(/^webpack:\/\/\/\.\//, '')
    .replace(/^webpack:\/\/\//, '')
    .replace(/^turbopack:\/\/\//, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^file:\/\/\//, '/')
    .replace(/^\([^)]+\)\/\.\//, '')
    .replace(/^\.\//, '')
}

function getReactMetadata(el) {
  try {
    var fiber = getFiberFromElement(el)
    var components = []
    var sourceFile = null
    var depth = 0
    while (fiber && depth < 35) {
      var name = getComponentNameFromFiber(fiber)
      if (name && !shouldSkipReactName(name) && components.indexOf(name) === -1 && components.length < 6) {
        components.push(name)
      }
      var source = fiber._debugSource || (fiber._debugOwner && fiber._debugOwner._debugSource)
      if (!sourceFile && source && source.fileName && source.lineNumber) {
        sourceFile = cleanSourcePath(source.fileName) + ':' + source.lineNumber +
          (source.columnNumber !== undefined ? ':' + source.columnNumber : '')
        if (containsSecret(sourceFile)) sourceFile = null
      }
      fiber = fiber.return
      depth++
    }
    return {
      react: components.length > 0
        ? clampStr(components.slice().reverse().map(function (c) { return '<' + c + '>' }).join(' '), BUDGET.react)
        : null,
      source: sourceFile ? clampStr(sourceFile, BUDGET.source) : null
    }
  } catch (e) {
    return { react: null, source: null }
  }
}

function extractPayload(el) {
  var rect = el.getBoundingClientRect()
  var react = getReactMetadata(el)
  var a11y = getAccessibility(el)
  var classAttr = el.getAttribute('class') || ''
  return {
    url: sanitizeUrl(window.location.href),
    title: clampStr(document.title || '', BUDGET.title),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
    devicePixelRatio: window.devicePixelRatio || 1,
    element: {
      tag: el.tagName.toLowerCase(),
      selector: buildSelector(el),
      path: buildReadablePath(el),
      fullPath: buildFullPath(el),
      classes: containsSecret(classAttr) ? '[redacted]' : clampStr(classAttr, BUDGET.classes),
      role: a11y.role,
      accessibleName: a11y.accessibleName,
      text: getBoundedText(el, BUDGET.text),
      selectedText: getSelectedText() || null,
      html: getHtmlSnippet(el),
      attributes: getSafeAttributes(el),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles: getComputedStyleSubset(el),
      react: react.react,
      source: react.source,
      ancestors: getAncestorPath(el),
      nearbyText: getNearbyText(el)
    }
  }
}
`

const GUEST_ARM = String.raw`
// Why: a page may predefine window.__tesselPick; always tear down what is
// there. Our own state lives in this closure, never read back from window.
var prev = window.__tesselPick
if (prev) {
  try { if (typeof prev.cancel === 'function') prev.cancel() } catch (e) {}
  try { delete window.__tesselPick } catch (e) {}
}
try {
  var stale = document.getElementById(HOST_ID)
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale)
} catch (e) {}

// Why: pages can replace window.Promise (Zone.js and the like), and Electron
// only unwraps a real promise. An async function's promise is the engine's own.
var NativePromise = (async function () {})().constructor
var nativeRaf = window.requestAnimationFrame
var nativeCaf = window.cancelAnimationFrame
var nativeSetTimeout = window.setTimeout
function raf(fn) {
  if (typeof nativeRaf === 'function') return nativeRaf.call(window, fn)
  return nativeSetTimeout.call(window, fn, 16)
}

return await new NativePromise(function (resolve) {
  var done = false
  var host = null
  var box = null
  var label = null
  var hoverEl = null
  var frame = 0
  var api = null
  var BLOCKED = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'pointerdown', 'pointerup']

  function teardown() {
    try { window.removeEventListener('keydown', onKey, true) } catch (e) {}
    try { window.removeEventListener('scroll', onScroll, true) } catch (e) {}
    if (frame && typeof nativeCaf === 'function') {
      try { nativeCaf.call(window, frame) } catch (e) {}
    }
    frame = 0
    try { if (host && host.parentNode) host.parentNode.removeChild(host) } catch (e) {}
    try { if (window.__tesselPick === api) delete window.__tesselPick } catch (e) {}
  }

  // Remove the overlay first, then resolve after a painted frame so a
  // screenshot taken right after does not show it. The timer covers hidden
  // pages, where frames never come.
  function finish(result) {
    if (done) return
    done = true
    teardown()
    raf(function () { raf(function () { resolve(result) }) })
    nativeSetTimeout.call(window, function () { resolve(result) }, 100)
  }

  // The overlay covers the page: hide it for a moment to see what is under it.
  function hitTest(x, y) {
    var el = null
    host.style.setProperty('pointer-events', 'none', 'important')
    try { el = document.elementFromPoint(x, y) } catch (e) {}
    host.style.setProperty('pointer-events', 'all', 'important')
    if (!el || el === host || host.contains(el)) return null
    if (el === document.documentElement || el === document.body) return null
    return el
  }

  function draw() {
    frame = 0
    if (done) return
    var el = hoverEl
    if (!el || !el.isConnected) {
      box.style.display = 'none'
      label.style.display = 'none'
      return
    }
    var rect = el.getBoundingClientRect()
    box.style.left = rect.x + 'px'
    box.style.top = rect.y + 'px'
    box.style.width = rect.width + 'px'
    box.style.height = rect.height + 'px'
    box.style.display = 'block'

    var parts = [el.tagName.toLowerCase()]
    var role = el.getAttribute('role')
    if (role) parts.push('role=' + role)
    var text = getBoundedText(el, BUDGET.label)
    if (text.length > BUDGET.label) text = text.slice(0, BUDGET.label - 1) + '…'
    if (text) parts.push('"' + text + '"')
    parts.push(Math.round(rect.width) + 'x' + Math.round(rect.height))
    label.textContent = parts.join('  ')

    // Below the element, or above it when the label would leave the viewport.
    var labelY = rect.bottom + 6
    if (labelY + 28 > window.innerHeight) labelY = rect.top - 28
    label.style.left = Math.max(4, rect.x) + 'px'
    label.style.top = Math.max(4, labelY) + 'px'
    label.style.display = 'block'
  }

  function schedule() {
    if (!frame && !done) frame = raf(draw)
  }

  function onMove(e) {
    hoverEl = hitTest(e.clientX, e.clientY)
    schedule()
  }

  function onScroll() {
    schedule()
  }

  // The page never sees the pick: every pointer event stops at the overlay.
  function onBlock(e) {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    if (e.type !== 'click' || done) return
    var el = hoverEl && hoverEl.isConnected ? hoverEl : hitTest(e.clientX, e.clientY)
    if (!el) return
    var payload = null
    try {
      payload = extractPayload(el)
    } catch (err) {
      finish({ error: 'extract-failed' })
      return
    }
    finish(payload)
  }

  function onKey(e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    finish({ cancelled: true })
  }

  try {
    host = document.createElement('div')
    host.id = HOST_ID
    host.style.cssText = 'all:initial !important;position:fixed !important;inset:0 !important;top:0 !important;left:0 !important;' +
      'width:100vw !important;height:100vh !important;margin:0 !important;padding:0 !important;display:block !important;' +
      'z-index:2147483647 !important;pointer-events:all !important;cursor:crosshair !important;background:transparent !important;'
    var shadow = host.attachShadow({ mode: 'closed' })
    box = document.createElement('div')
    box.style.cssText = 'position:fixed;display:none;box-sizing:border-box;border:2px solid rgba(255,255,255,0.9);border-radius:3px;' +
      'background:rgba(255,255,255,0.08);box-shadow:0 0 0 1px rgba(0,0,0,0.3),0 2px 8px rgba(0,0,0,0.15);pointer-events:none;transition:all 0.05s ease-out;'
    label = document.createElement('div')
    label.style.cssText = 'position:fixed;display:none;padding:3px 8px;background:rgba(30,30,30,0.92);color:#e5e5e5;' +
      'font:11px/1.4 system-ui,-apple-system,sans-serif;border-radius:4px;pointer-events:none;white-space:nowrap;' +
      'max-width:300px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,0.3);'
    shadow.appendChild(box)
    shadow.appendChild(label)
    host.addEventListener('mousemove', onMove, true)
    for (var b = 0; b < BLOCKED.length; b++) host.addEventListener(BLOCKED[b], onBlock, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    document.documentElement.appendChild(host)

    api = { cancel: function () { finish({ cancelled: true }) } }
    try {
      Object.defineProperty(window, '__tesselPick', { value: api, configurable: true, writable: true, enumerable: false })
    } catch (e) {
      try { window.__tesselPick = api } catch (e2) {}
    }
  } catch (err) {
    done = true
    teardown()
    resolve({ error: 'arm-failed' })
  }
})
`

const GUEST_TEARDOWN = String.raw`
var pick = window.__tesselPick
if (pick) {
  try { if (typeof pick.cancel === 'function') pick.cancel() } catch (e) {}
  try { delete window.__tesselPick } catch (e) {}
}
try {
  var host = document.getElementById(HOST_ID)
  if (host && host.parentNode) host.parentNode.removeChild(host)
} catch (e) {}
return true
`

// Constants go in as JSON so guest and main share one source of truth.
function wrap (body) {
  return [
    '(async () => {',
    "'use strict'",
    'var BUDGET = ' + JSON.stringify(PICK_BUDGET),
    'var SAFE_ATTRS = ' + JSON.stringify(PICK_SAFE_ATTRIBUTES),
    'var SECRET_PATTERNS = ' + JSON.stringify(PICK_SECRET_PATTERNS),
    'var STYLE_PROPS = ' + JSON.stringify(PICK_STYLE_PROPS),
    'var URL_ATTRS = ' + JSON.stringify(URL_ATTRIBUTES),
    'var HOST_ID = ' + JSON.stringify(PICK_HOST_ID),
    body,
    '})()'
  ].join('\n')
}

const ARM_SCRIPT = wrap(GUEST_HELPERS + GUEST_ARM)
const TEARDOWN_SCRIPT = wrap(GUEST_TEARDOWN)

// Source of an async IIFE for guest.executeJavaScript(script, true).
// 'arm': resolves with the picked element's payload, { cancelled: true }
// (Escape, teardown) or { error: 'extract-failed' | 'arm-failed' }.
// 'teardown': cancels a pending pick and removes the overlay; resolves true.
export function pickerScript (action) {
  if (action === 'arm') return ARM_SCRIPT
  if (action === 'teardown') return TEARDOWN_SCRIPT
  throw new Error(`unknown picker action: ${action}`) // i18n-ignore programming error
}

// ---------------------------------------------------------------------------
// Main-side check of what the guest returned (Orca's clampGrabPayload).
// ---------------------------------------------------------------------------

const SAFE_ATTRIBUTE_SET = new Set(PICK_SAFE_ATTRIBUTES)
const URL_ATTRIBUTE_SET = new Set(URL_ATTRIBUTES)

function isObject (value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clampStr (value, max) {
  const s = typeof value === 'string' ? value : ''
  return s.length <= max ? s : `${s.slice(0, max)} (truncated)`
}

function num (value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function containsSecret (value) {
  const lower = String(value).toLowerCase()
  return PICK_SECRET_PATTERNS.some((p) => lower.includes(p))
}

// Metadata that could echo a secret is dropped whole, not trimmed.
function metaStr (value, max) {
  const s = clampStr(value, max)
  return s && containsSecret(s) ? '[redacted]' : s
}

function nullableMeta (value, max) {
  return metaStr(value, max) || null
}

function sanitizeUrl (value) {
  // A huge string is not a URL anyone typed; do not parse it.
  if (typeof value !== 'string' || !value || value.length > 64 * 1024) return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    url.search = ''
    url.hash = ''
    return clampStr(url.toString(), PICK_BUDGET.url)
  } catch {
    return ''
  }
}

function stripUrlAttr (value) {
  const v = value.trim()
  if (/^(?:javascript|vbscript|data):/i.test(v.replace(/[\s\u0000-\u001f]+/g, ''))) return ''
  const cut = v.search(/[?#]/)
  return cut === -1 ? v : v.slice(0, cut)
}

// Re-filter names (no event handlers or odd keys) and values.
function safeAttributes (attrs) {
  const out = {}
  if (!isObject(attrs)) return out
  let count = 0
  for (const [key, value] of Object.entries(attrs)) {
    if (count >= PICK_BUDGET.attributes) break
    const name = key.toLowerCase()
    const isAria = /^aria-[a-z-]{1,40}$/.test(name)
    if (!isAria && !SAFE_ATTRIBUTE_SET.has(name)) continue
    if (typeof value !== 'string') continue
    const long = value.length > 2000 ? value.slice(0, 2000) : value
    if (containsSecret(long)) out[name] = '[redacted]'
    else if (URL_ATTRIBUTE_SET.has(name) && long) out[name] = clampStr(stripUrlAttr(long), PICK_BUDGET.attributeValue)
    else if (name === 'class') out[name] = clampStr(long, PICK_BUDGET.classAttribute)
    else out[name] = clampStr(long, PICK_BUDGET.attributeValue)
    count++
  }
  return out
}

function safeRect (rect) {
  const r = isObject(rect) ? rect : {}
  return { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) }
}

function safeStyles (styles) {
  const s = isObject(styles) ? styles : {}
  const out = {}
  for (const prop of PICK_STYLE_PROPS) out[prop] = clampStr(s[prop], PICK_BUDGET.styleValue)
  return out
}

function clampArray (value, maxEntries, maxLength) {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, maxEntries)
    .map((item) => metaStr(item, maxLength))
    .filter(Boolean)
}

function clampUnsafe (raw) {
  if (!isObject(raw)) return null
  if (raw.cancelled === true) return { cancelled: true }
  const el = raw.element
  if (!isObject(el)) return null
  const tag = clampStr(el.tag, PICK_BUDGET.tag).toLowerCase()
  if (!tag) return null
  const viewport = isObject(raw.viewport) ? raw.viewport : {}
  const scroll = isObject(raw.scroll) ? raw.scroll : {}
  const dpr = num(raw.devicePixelRatio, 1)
  return {
    url: sanitizeUrl(raw.url),
    title: clampStr(raw.title, PICK_BUDGET.title),
    viewport: { width: num(viewport.width), height: num(viewport.height) },
    scroll: { x: num(scroll.x), y: num(scroll.y) },
    devicePixelRatio: dpr > 0 ? dpr : 1,
    element: {
      tag,
      selector: clampStr(el.selector, PICK_BUDGET.selector),
      path: metaStr(el.path, PICK_BUDGET.path),
      fullPath: metaStr(el.fullPath, PICK_BUDGET.path),
      classes: metaStr(el.classes, PICK_BUDGET.classes),
      role: nullableMeta(el.role, PICK_BUDGET.role),
      accessibleName: nullableMeta(el.accessibleName, PICK_BUDGET.accessibleName),
      text: clampStr(el.text, PICK_BUDGET.text),
      selectedText: nullableMeta(el.selectedText, PICK_BUDGET.selectedText),
      html: clampStr(el.html, PICK_BUDGET.html),
      attributes: safeAttributes(el.attributes),
      rect: safeRect(el.rect),
      styles: safeStyles(el.styles),
      react: nullableMeta(el.react, PICK_BUDGET.react),
      source: nullableMeta(el.source, PICK_BUDGET.source),
      ancestors: clampArray(el.ancestors, PICK_BUDGET.ancestors, PICK_BUDGET.ancestorEntry),
      nearbyText: clampArray(el.nearbyText, PICK_BUDGET.nearbyText, PICK_BUDGET.nearbyTextEntry)
    }
  }
}

// A sanitized copy of the guest's answer: { cancelled: true }, the payload
// with every budget re-applied and unknown keys dropped, or null when it is
// not a pick (wrong shape, { error }, a getter that throws).
export function clampPickPayload (raw) {
  try {
    return clampUnsafe(raw)
  } catch {
    return null
  }
}
