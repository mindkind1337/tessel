// File and folder paths in terminal text, optionally with a line and column,
// so a click can open them:
//   src/main/index.js:123:5   C:\Proj\app.ts:12   ./a/b.py   app.cs(12,7)
//   src/app.js#L12            File "a b/c.py", line 3   ~/notes.md
//   'C:\My Folder\read me.txt'   ünïcødé/文件.md   src/components/   Makefile
// Only something that looks like a path: a name with an extension that
// starts with a letter, a path with a separator (a folder, an extensionless
// file: whether it exists decides, on disk or on the host), or a well-known
// extensionless name. Never URLs, version numbers or e-mail addresses.
// -> [{ index, text, path, line, col, quoted }] (index and text: the whole
// link as written, quotes and line included; path: what to look up).

// One name of a path: letters of any script, digits, marks and the usual
// name characters. A dot only after its first character (".git/" and
// ".env" need a folder before them, or a quote around them).
const NAME = String.raw`[\p{L}\p{N}\p{M}_@~+\-][\p{L}\p{N}\p{M}_.@~+\-]*|\.[\p{L}\p{N}_][\p{L}\p{N}\p{M}_.@~+\-]*`
// How a path starts: a WSL share (\\wsl.localhost\Ubuntu, \\wsl$\Ubuntu), a
// drive, the home folder, "./" or "../", or a separator. Other network
// shares never link (looking one up could hand your sign-in to a server).
const START = String.raw`[\\/]{2}wsl(?:\$|\.localhost)[\\/]|[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/]`
const PATH_RE = new RegExp(String.raw`(?=[^\s])(?:${START})?(?:(?:${NAME})[\\/])*(?:${NAME})?`, 'gu')
// What may follow a path: :12, :12:5, (12), (12,7), #L12, #L12C5, #L12-L20,
// ", line 12", " line 12".
const LOC_RE = /(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\)|#L(\d+)(?:C(\d+))?(?:-L?\d+)?|,?[ \t]+line[ \t]+(\d+))/y
// A quoted path: anything but quotes and control characters between them,
// checked below (it may hold spaces).
const QUOTED_RE = /(["'`])([^"'`\u0000-\u001f]{1,1000}?)\1/g
const QUOTED_PATH = new RegExp(String.raw`^(?:${START})?(?:[^\\/\u0000-\u001f"'\x60<>|*?:]+[\\/])*[^\\/\u0000-\u001f"'\x60<>|*?:]*$`, 'u')
const EXT_RE = /[^\\/.]\.[A-Za-z][A-Za-z0-9]{0,7}$/
const LETTER = /\p{L}/u
// Extensionless files known by their name alone.
const BARE_NAMES = new Set([
  'Makefile',
  'makefile',
  'GNUmakefile',
  'Dockerfile',
  'Containerfile',
  'Jenkinsfile',
  'Vagrantfile',
  'Procfile',
  'Gemfile',
  'Rakefile',
  'Brewfile',
  'Justfile',
  'justfile',
  'LICENSE',
  'LICENCE',
  'COPYING',
  'README',
  'CHANGELOG',
  'AUTHORS',
  'NOTICE',
  'CODEOWNERS'
])

function locAt(s, at) {
  LOC_RE.lastIndex = at
  const m = LOC_RE.exec(s)
  if (!m) return { text: '', line: null, col: null }
  const line = m[1] || m[3] || m[5] || m[7]
  const col = m[2] || m[4] || m[6]
  return { text: m[0], line: line ? Number(line) : null, col: col ? Number(col) : null }
}

// Does `path` look like one worth looking up?
function pathLike(path) {
  if (!path || !LETTER.test(path)) return false
  if (/:\/\//.test(path)) return false
  const sep = /[\\/]/.test(path)
  const last = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  if (EXT_RE.test(last)) return true
  if (sep) return path.replace(/[\\/.~]/g, '') !== '' || path.startsWith('~')
  return BARE_NAMES.has(path)
}

// A line number written inside the quotes ("src/a.js:12").
function splitInnerLoc(inner) {
  const m = /:(\d+)(?::(\d+))?$/.exec(inner)
  if (!m || /^[A-Za-z]:$/.test(inner.slice(0, m.index))) return { path: inner, line: null, col: null }
  return { path: inner.slice(0, m.index), line: Number(m[1]), col: m[2] ? Number(m[2]) : null }
}

function quotedRefs(s) {
  const out = []
  for (const m of s.matchAll(QUOTED_RE)) {
    const inner = m[2]
    if (inner !== inner.trim()) continue
    const own = splitInnerLoc(inner)
    if (!QUOTED_PATH.test(own.path) || !pathLike(own.path)) continue
    // Not a word's apostrophe ("it's here's a.txt").
    if (m[1] === "'" && /[\p{L}\p{N}]/u.test(s[m.index - 1] || '')) continue
    const after = m.index + m[0].length
    const loc = own.line ? { text: '', line: own.line, col: own.col } : locAt(s, after)
    out.push({ index: m.index, text: m[0] + loc.text, path: own.path, line: loc.line, col: loc.col, quoted: true })
  }
  return out
}

export function findFileRefs(text) {
  const s = String(text || '')
  const quoted = quotedRefs(s)
  const out = [...quoted]
  PATH_RE.lastIndex = 0
  let m
  while ((m = PATH_RE.exec(s))) {
    if (!m[0]) {
      // On by one character: an emoji is two UTF-16 units (a "u" regex
      // started inside it would find the same empty match forever).
      PATH_RE.lastIndex = m.index + ((s.codePointAt(m.index) || 0) > 0xffff ? 2 : 1)
      continue
    }
    const index = m.index
    // A sentence's full stop is not part of the name ("see src/a.js.").
    const path = m[0].replace(/\.+$/, '')
    const loc = locAt(s, index + path.length)
    if (loc.text) PATH_RE.lastIndex = index + path.length + loc.text.length
    const before = s.slice(Math.max(0, index - 3), index)
    // Part of a URL (http://x/y.js) or of an e-mail address: not a file.
    // After a separator: the rest of a path that did not match (a network
    // share's \\server\share).
    if (/:\/\/?$|\/\/$/.test(before) || /[\p{L}\p{N}_.\-\\/]$/u.test(s[index - 1] || '')) continue
    if (/^[\p{L}\p{N}_.-]+@/u.test(path)) continue
    if (!pathLike(path)) continue
    // The same path already found between quotes (File "a.py", line 3).
    if (quoted.some((q) => q.path === path && index > q.index && index < q.index + q.text.length)) continue
    out.push({ index, text: path + loc.text, path, line: loc.line, col: loc.col, quoted: false })
  }
  return out.sort((a, b) => a.index - b.index)
}

// The links to show among the refs that exist (ok(ref) -> truthy): two
// overlapping refs ('see the docs/ here' and docs/ inside it) give one link,
// the quoted one first, then the longer one.
export function pickFileLinks(refs, ok = () => true) {
  const found = refs.filter((r) => ok(r)).sort((a, b) => Number(b.quoted) - Number(a.quoted) || b.text.length - a.text.length)
  const kept = []
  for (const r of found) {
    const end = r.index + r.text.length
    if (kept.some((k) => r.index < k.index + k.text.length && k.index < end)) continue
    kept.push(r)
  }
  return kept.sort((a, b) => a.index - b.index)
}
