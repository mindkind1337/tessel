// Device sign-in prompts in a terminal screen (Grok, Codex, GitHub CLI,
// Claude Code, Gemini CLI): a program on an SSH host cannot open a browser,
// so it prints a page and a code to use on another computer.
// detectDeviceLogin() reads the visible screen rows and answers
// { provider, label, host, page, url, code, known, showUrl, key } or null.
// Nothing here opens anything: the pane shows a banner and the person
// decides. The URL is taken from the screen text only (https, no
// credentials), never invented, except GitHub CLI's fixed page when it only
// says "open github.com in your browser".
//
// What the banner shows is what opens: a known device page is opened as
// origin + path + its user_code (anything else in it makes it unknown), any
// other page is shown whole.
//
// Grok (1.0.62, checked on a real screen) shows no URL at first: "Copying not
// working? Click here to show full URL." is a hit area of its own (mouse
// reporting), and only the first row of that paragraph answers a click once
// the pane is narrow enough to wrap it. showUrl is then the first character
// of that row, for the banner's button to click on the person's behalf. On
// its URL screen Grok wraps a long URL itself (rows filled to the last
// column, not marked as wrapped): such rows are joined again.

const CODE = /\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/
const USER_CODE = /^[A-Za-z0-9-]{4,16}$/
const URL_TEXT = /https:\/\/[^\s<>"'`)\]]+/g
// Characters a URL can go on with at the start of the next row.
const URL_GOES_ON = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/
const URL_AT_END = /https:\/\/[^\s<>"'`)\]]*$/
const MAX_URL = 4096
// Rows between a sign-in phrase and the code it goes with.
const CODE_NEAR = 6
const SHOW_URL = /\bclick here to show full URL\b/i

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
  /open the url below in your browser/i,
  /copy the code displayed in the browser/i,
  /https:\/\/\S*(?:[?&]user_code=|\/login\/device|\/oauth2\/device|\/codex\/device)/i
]

// The exact page of each provider's device flow. A host alone vouches for
// nothing (any OAuth app's page is on github.com, any repository named
// "device" too): only these pages get the provider's name in the banner.
const DEVICE_PAGES = [
  { id: 'grok', label: 'Grok', host: 'accounts.x.ai', path: '/oauth2/device' },
  { id: 'codex', label: 'Codex', host: 'auth.openai.com', path: '/codex/device' },
  { id: 'github', label: 'GitHub', host: 'github.com', path: '/login/device' },
  { id: 'microsoft', label: 'Microsoft', host: 'microsoft.com', path: '/devicelogin' },
  { id: 'microsoft', label: 'Microsoft', host: 'login.microsoft.com', path: '/device' }
]
const GITHUB_DEVICE = 'https://github.com/login/device'

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

// A known device page: its entry, and the code its URL carries (or null).
// Any other query, a fragment or a port: not known.
function knownPage(u) {
  if (u.port || u.hash) return null
  const path = u.pathname.replace(/\/$/, '')
  const page = DEVICE_PAGES.find((p) => p.host === u.hostname && p.path === path)
  if (!page) return null
  const keys = [...u.searchParams.keys()]
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'user_code')) return null
  const code = u.searchParams.get('user_code')
  if (code !== null && !USER_CODE.test(code)) return null
  return { page, code }
}

// Rows joined where a row goes on in the next one: marked by the terminal
// (wrapped[i]), or a URL that fills its row to the last column and goes on
// at the start of the next (a program that wraps it itself).
function logicalLines(lines, wrapped, cols) {
  const out = []
  lines.forEach((line, i) => {
    const goesOn =
      out.length > 0 &&
      ((wrapped && wrapped[i]) || (cols > 0 && String(lines[i - 1]).length >= cols && URL_AT_END.test(out[out.length - 1]) && URL_GOES_ON.test(line)))
    if (goesOn) out[out.length - 1] += line
    else out.push(line)
  })
  return out
}

// The rows of a sign-in phrase: a row that says one, or two rows that say
// one together (a program wrapped the phrase).
function triggerRows(rows) {
  const out = new Set()
  const says = (text) => TRIGGERS.some((re) => re.test(text))
  rows.forEach((row, i) => {
    if (says(row)) out.add(i)
    else if (i + 1 < rows.length && row.trim() && rows[i + 1].trim() && says(row.trim() + ' ' + rows[i + 1].trim())) {
      out.add(i)
      out.add(i + 1)
    }
  })
  return [...out]
}

// Paragraphs: runs of non-blank rows, as { first, last, text } (row indexes
// into `rows`, text with the rows joined by a space).
function paragraphs(rows) {
  const out = []
  let cur = null
  rows.forEach((row, i) => {
    if (!row.trim()) {
      cur = null
      return
    }
    if (!cur) {
      cur = { first: i, last: i, text: row.trim() }
      out.push(cur)
    } else {
      cur.last = i
      cur.text += ' ' + row.trim()
    }
  })
  return out
}

// lines: the screen rows (strings, trailing blanks trimmed), first = row 1.
// opts.wrapped: booleans, true for a row the terminal wrapped from the one
// above. opts.cols: the screen's width (rows filled to it may go on below).
// Returns null when the screen is no device sign-in, or shows several pages.
export function detectDeviceLogin(lines, { wrapped = null, cols = 0 } = {}) {
  if (!Array.isArray(lines) || !lines.length) return null
  const logical = logicalLines(lines, wrapped, cols)
  const triggered = triggerRows(logical)
  if (!triggered.length) return null

  const urls = new Map()
  for (const line of logical)
    for (const m of line.matchAll(URL_TEXT)) {
      const u = cleanUrl(m[0])
      if (u) urls.set(u.href, u)
    }
  // Two different pages: which one is the sign-in is not for us to guess.
  if (urls.size > 1) return null
  let url = urls.size ? [...urls.values()][0] : null
  if (!url && logical.some((l) => /github\.com in your browser/i.test(l))) url = new URL(GITHUB_DEVICE)
  const known = url ? knownPage(url) : null

  // The code: from a known page's URL, else the code nearest a sign-in phrase.
  let code = known && known.code ? known.code.toUpperCase() : null
  if (!code) {
    let best = Infinity
    logical.forEach((line, i) => {
      if (/https:\/\//.test(line)) return
      const m = CODE.exec(line)
      if (!m || !/[0-9]|[A-Z]{4}/.test(m[0])) return
      const d = Math.min(...triggered.map((r) => Math.abs(r - i)))
      if (d <= CODE_NEAR && d < best) {
        best = d
        code = m[0]
      }
    })
  }

  // Grok before its URL: the first row of its "show full URL" paragraph (on
  // the screen rows, for the pane to turn into a cell).
  let showUrl = null
  if (!url) {
    const p = paragraphs(lines).find((x) => SHOW_URL.test(x.text))
    if (p) showUrl = { row: p.first + 1, index: lines[p.first].search(/\S/) }
  }
  if (!url && !showUrl) return null
  // A bare code and no page to open is nothing to offer.
  if (!url && !code) return null
  const opened = known ? new URL(url.origin + url.pathname) : url
  if (known && known.code) opened.searchParams.set('user_code', known.code)
  return {
    // Named only once a known page is on the screen (the phrases alone vouch
    // for nothing).
    provider: known ? known.page.id : 'other',
    label: known ? known.page.label : '',
    host: url ? url.hostname : '',
    // What the banner shows: a known page without its query (its code is
    // shown apart), any other page whole.
    page: url ? (known ? opened.origin + opened.pathname : opened.href) : '',
    url: url ? opened.href : null,
    code,
    known: !!known,
    showUrl,
    key: (url ? opened.href : 'nourl') + '|' + (code || '')
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

// "Always select with the mouse" drops a program's mouse requests, so a drag
// always selects. A plain single click (no modifier, no drag, no selection
// made, not on a link) still goes to a program that asked for clicks in the
// SGR form, on the alternate screen: its buttons and "click here" work.
// Never when xterm reports the mouse itself (a request that also set other
// modes went through: the program got the click already), nor for the click
// that only gave the terminal the keyboard.
// down / up: { col, row, button, detail, mods, focused } of the mousedown / mouseup.
export function clickPassesThrough({ alwaysSelect, programWantsClicks, xtermReports = false, down, up, selection, onLink }) {
  if (!alwaysSelect || !programWantsClicks || xtermReports || selection || onLink || !down || !up) return false
  if (!down.focused || down.button !== 0 || up.button !== 0 || down.mods || up.mods) return false
  // detail: the click count (2 on a double click, which selects a word).
  if (up.detail !== 1) return false
  return down.col === up.col && down.row === up.row
}
