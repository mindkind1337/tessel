// File paths in terminal text, optionally with a line and column
// (src/main/index.js:123:5, C:\Proj\app.ts:12, ./a/b.py, app.py(12)), so a
// click can open them. Only something that looks like a file (a name with an
// extension that starts with a letter): not URLs, not version numbers.
// -> [{ index, text, path, line, col }]
const PATH_RE =
  /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@~+-]+[\\/])*[\w@~+-][\w.@~+-]*\.[A-Za-z][A-Za-z0-9]{0,7}(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?/g

export function findFileRefs(text) {
  const out = []
  const s = String(text || '')
  for (const m of s.matchAll(PATH_RE)) {
    const before = s.slice(Math.max(0, m.index - 3), m.index)
    // Part of a URL (http://x/y.js) or of an e-mail address: not a file.
    if (/:\/\/?$|\/\/$/.test(before) || /[\w.-]$/.test(s[m.index - 1] || '')) continue
    if (/^[\w.-]+@/.test(m[0])) continue
    const full = m[0]
    const loc = /(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))$/.exec(full)
    const path = loc ? full.slice(0, loc.index) : full
    // A bare "name.ext" with no folder and no line is usually prose
    // ("see README.md" still counts: it has an extension, checked on disk).
    out.push({
      index: m.index,
      text: full,
      path,
      line: loc ? Number(loc[1] || loc[3]) : null,
      col: loc && (loc[2] || loc[4]) ? Number(loc[2] || loc[4]) : null
    })
  }
  return out
}
