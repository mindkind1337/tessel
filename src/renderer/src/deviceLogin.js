// Device sign-in prompts in a terminal screen (Grok, Claude Code, Codex,
// Gemini CLI, GitHub CLI): a program on an SSH host cannot open a browser, so
// it prints a page and a code to use on another computer. detectDeviceLogin()
// reads the visible screen lines and answers { provider, host, url, code,
// known, showUrl } or null. Nothing here opens anything: the pane shows a
// banner and the person decides. The URL is taken from the screen text only
// (https, no credentials), never invented, except GitHub CLI's fixed page when
// it only says "open github.com in your browser".
//
// Grok shows no URL at first: "Click here to show full URL" (a click the
// program handles itself with mouse reporting). showUrl is then the cell of
// that "here", for the banner's button to click on the person's behalf.

const CODE = /\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/
const USER_CODE_PARAM = /[?&]user_code=([A-Za-z0-9-]{4,16})/
const URL_TEXT = /https:\/\/[^\s<>"'`)\]]+/g
const MAX_URL = 4096
// Rows between a trigger phrase and the code it goes with.
const CODE_NEAR = 6

// Phrases of a sign-in prompt. One must match for any banner to show.
const TRIGGERS = [
  /approve in your browser/i,
  /finish signing in/i,
  /one-time code/i,
  /device (?:code|login|activation|authori[sz]ation)/i,
  /(?:enter|type) (?:the|this|your) (?:verification |authori[sz]ation |device )?code/i,
  /use the url below to sign in/i,
  /browser didn['’]t open/i,
  /visit the following url to authori[sz]e/i,
  /open this link in your browser/i,
  /github\.com in your browser/i,
  /select the url below/i,
  /https:\/\/\S*(?:[?&]user_code=|\/login\/device|\/oauth2\/device|\/codex\/device)/i
]

// Provider by page host: label for the banner. A host alone vouches for
// nothing (a page under github.com can be any OAuth app's, a bucket on
// googleapis.com anyone's): "known" needs the host AND a device-flow page.
const PROVIDERS = [
  { id: 'grok', label: 'Grok', host: /(^|\.)x\.ai$/ },
  { id: 'github', label: 'GitHub', host: /^(www\.)?github\.com$/ },
  { id: 'codex', label: 'Codex', host: /^(auth\.)?openai\.com$|^(www\.)?chatgpt\.com$/ },
  { id: 'claude', label: 'Claude', host: /^(www\.)?claude\.(ai|com)$|^console\.anthropic\.com$/ },
  { id: 'gemini', label: 'Gemini', host: /^accounts\.google\.com$/ },
  { id: 'microsoft', label: 'Microsoft', host: /^login\.microsoftonline\.com$|^microsoft\.com$|^login\.live\.com$/ }
]

function providerOf(host) {
  return PROVIDERS.find((p) => p.host.test(host)) || null
}

// The page a device flow really uses: .../device or a user_code parameter.
function deviceFlowPage(u) {
  return /(^|\/)device(\/|$)/.test(u.pathname) || USER_CODE_PARAM.test(u.search)
}

function cleanUrl(raw) {
  const text = String(raw || '').replace(/[.,;:!?]+$/, '')
  if (!text || text.length > MAX_URL) return null
  let u
  try {
    u = new URL(text)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null
  return u
}

// Rows joined where a row continues the one above it (wrapped[i]): a URL the
// terminal wrapped is whole again.
function logicalLines(lines, wrapped) {
  const out = []
  lines.forEach((line, i) => {
    if (wrapped && wrapped[i] && out.length) out[out.length - 1] += line
    else out.push(line)
  })
  return out
}

// lines: the screen rows (strings), first row = row 1. wrapped: optional
// booleans, true for a row that continues the one above. Returns null when the
// screen is no device sign-in, or shows several different pages.
export function detectDeviceLogin(lines, wrapped) {
  if (!Array.isArray(lines) || !lines.length) return null
  const logical = logicalLines(lines, wrapped)
  const text = logical.join('\n')
  if (!TRIGGERS.some((re) => re.test(text))) return null

  const urls = new Map()
  for (const m of text.matchAll(URL_TEXT)) {
    const u = cleanUrl(m[0])
    if (u) urls.set(u.href, u)
  }
  // Two different pages: which one is the sign-in is not for us to guess.
  if (urls.size > 1) return null
  let url = urls.size ? [...urls.values()][0] : null

  // The code: from the URL, else the nearest code line to a trigger phrase.
  let code = null
  const fromUrl = url && USER_CODE_PARAM.exec(url.search)
  if (fromUrl) code = fromUrl[1].toUpperCase()
  else {
    const triggerRows = []
    logical.forEach((l, i) => {
      if (TRIGGERS.some((re) => re.test(l))) triggerRows.push(i)
    })
    let best = Infinity
    logical.forEach((line, i) => {
      if (/https:\/\//.test(line)) return
      const m = CODE.exec(line)
      if (!m || !/[0-9]|[A-Z]{4}/.test(m[0])) return
      const d = Math.min(...triggerRows.map((r) => Math.abs(r - i)))
      if (d <= CODE_NEAR && d < best) {
        best = d
        code = m[0]
      }
    })
  }
  let provider = null
  if (!url && /github\.com in your browser/i.test(text)) {
    url = new URL('https://github.com/login/device')
    provider = PROVIDERS[1]
  }
  if (url && !provider) provider = providerOf(url.hostname)

  // Grok before its URL: the row and string index of "here" in "Click here to
  // show full URL" (the pane turns the index into a cell column).
  let showUrl = null
  if (!url) {
    for (let i = 0; i < lines.length; i++) {
      const m = /\bhere\b(?= to show full URL)/i.exec(lines[i])
      if (m) {
        showUrl = { row: i + 1, index: m.index }
        provider = PROVIDERS[0]
        break
      }
    }
  }
  if (!url && !showUrl) return null
  // A bare code and no page to open is nothing to offer.
  if (!url && !code) return null
  if (!provider && /approve in your browser/i.test(text)) provider = PROVIDERS[0]
  const known = !!(url && provider && deviceFlowPage(url))
  return {
    provider: provider ? provider.id : 'other',
    label: known ? provider.label : '',
    host: url ? url.hostname : '',
    // What the banner shows: where the button goes, port included, no query.
    page: url ? url.origin + url.pathname : '',
    url: url ? url.href : null,
    code,
    known,
    showUrl,
    key: (url ? url.href : 'nourl') + '|' + (code || '')
  }
}

// The terminal column (1-based) of a string index in a buffer row: walks the
// cells, so wide characters and surrogate pairs do not shift it. A cell with
// no characters is one blank in translateToString; a wide char's trailing
// cell (width 0) adds nothing.
export function columnOfIndex(line, index) {
  if (!line || !(index >= 0)) return null
  let offset = 0
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell) return null
    const width = cell.getWidth()
    const chars = cell.getChars()
    const len = width === 0 ? 0 : chars === '' ? 1 : chars.length
    if (index < offset + len) return x + 1
    offset += len
  }
  return null
}

// An SGR (1006) left click at a screen cell: press, then release.
export function mouseClickBytes(col, row) {
  const c = Math.max(1, Math.floor(col))
  const r = Math.max(1, Math.floor(row))
  return `\x1b[<0;${c};${r}M\x1b[<0;${c};${r}m`
}

// A link click while the program takes the mouse (mouse reporting on): the
// plain click belongs to the program, so a link opens with Ctrl, Cmd or Shift
// held (xterm's convention). With no mouse reporting, a plain click opens it.
export function linkClickOpens(mouseTrackingMode, event) {
  if (!mouseTrackingMode || mouseTrackingMode === 'none') return true
  return !!(event && (event.ctrlKey || event.metaKey || event.shiftKey))
}
