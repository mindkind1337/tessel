// The built-in browser's addresses: what the address bar makes of what you
// type, and which pages the browser may show at all. After Orca's
// src/shared/browser-url.ts (MIT, Copyright (c) 2026 Lovecast Inc.), ported
// to plain JS.
//
// Tessel's difference: only http and https pages (and the blank page). No
// file: pages (a page could read other files of this computer through them)
// and no other scheme (javascript:, data:, ...).

export const BLANK_URL = 'about:blank'

const LOCAL_ADDRESS = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/i
// "example.com" or "foo.bar/path" is an address, "react hooks" a search.
const LOOKS_LIKE_URL = /^[^\s]+\.[a-z]{2,}(\/.*)?$/i

export const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q='
}
export const DEFAULT_SEARCH_ENGINE = 'google'

// "localhost:5173", "127.0.0.1:3000/x", "[::1]:8080" -> http://...
function localDevAddress(input) {
  if (!LOCAL_ADDRESS.test(input)) return null
  try {
    return new URL(`http://${input}`)
  } catch {
    return null
  }
}

function isValidDnsName(name) {
  if (!name || name.length > 253) return false
  return name.split('.').every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
}

// "app.test:8443/x": a dotted host and a port (not a scheme); *.localhost is http.
function domainPortAddress(input) {
  const m = /^([^\s/\\:@?#]+):\d+(?:[/?#].*)?$/.exec(input)
  if (!m || !m[1].includes('.')) return null
  try {
    const url = new URL(`https://${input}`)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!isValidDnsName(host)) return null
    return host.endsWith('.localhost') ? new URL(`http://${input}`) : url
  } catch {
    return null
  }
}

export function looksLikeSearch(input) {
  if (input.includes(' ')) return true
  if (LOOKS_LIKE_URL.test(input)) return false
  if (input.includes('.') || input.includes(':')) return false
  return true
}

export function searchUrl(query, engine = DEFAULT_SEARCH_ENGINE) {
  const base = SEARCH_ENGINES[engine] || SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE]
  return `${base}${encodeURIComponent(String(query))}`
}

// A page the browser may show: http(s) or the blank page. -> the URL as the
// browser writes it, or null.
export function allowedBrowserUrl(raw) {
  const s = String(raw || '').trim()
  if (s === BLANK_URL) return BLANK_URL
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    // user:password@host is refused: it hides where the page really is.
    if (u.username || u.password) return null
    return u.toString()
  } catch {
    return null
  }
}

// What the address bar makes of what you typed: an http(s) URL, the blank
// page, a search (when `search` is on), or null (refused).
export function normalizeBrowserInput(raw, { search = true, engine = DEFAULT_SEARCH_ENGINE } = {}) {
  const s = String(raw || '').trim()
  if (!s || s === BLANK_URL) return BLANK_URL
  const local = localDevAddress(s)
  if (local) return allowedBrowserUrl(local.toString())
  const domainPort = domainPortAddress(s)
  if (domainPort) return allowedBrowserUrl(domainPort.toString())
  // A URL with its scheme: only the schemes the browser shows.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(s)) {
    let u = null
    try {
      u = new URL(s)
    } catch {
      u = null
    }
    if (u) return allowedBrowserUrl(u.toString())
  }
  if (search && looksLikeSearch(s)) return searchUrl(s, engine)
  try {
    return allowedBrowserUrl(new URL(`https://${s}`).toString())
  } catch {
    return search ? searchUrl(s, engine) : null
  }
}

// A page on this computer (a dev server): what the address bar shows plainly.
export function isLocalUrl(raw) {
  try {
    const host = new URL(String(raw)).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(host)
  } catch {
    return false
  }
}

// The address shown in the bar: the blank page shows nothing.
export function displayUrl(url) {
  return !url || url === BLANK_URL ? '' : String(url)
}

// "Can't reach localhost:5173": the host (and port) of a page.
export function hostOf(url) {
  try {
    return new URL(String(url)).host || String(url)
  } catch {
    return String(url || '')
  }
}
