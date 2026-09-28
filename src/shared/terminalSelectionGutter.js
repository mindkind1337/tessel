// "Trim Gutter on Copy" (Orca's shared/terminal-selection-gutter.ts, MIT).
// An xterm selection is a rectangle of screen cells, not logical text. Agent
// CLIs paint their messages behind a fixed left gutter, so every copied line
// carried that gutter into the clipboard and pasted replies came out indented.
//
// Only the run of spaces that *every* non-blank line shares is removed, so
// relative indentation (nested bullets, fenced code, YAML) survives. A
// selection that starts mid-line, or that covers any column-0 line, shares a
// run of zero and comes back untouched.
const LEADING_SPACES = /^ */

// xterm joins rows with CRLF on Windows, so split('\n') leaves the CR behind:
// it travels with its line (a blank CRLF row is still blank).
function parseLine(rawLine) {
  const cr = rawLine.endsWith('\r')
  const text = cr ? rawLine.slice(0, -1) : rawLine
  return { indent: LEADING_SPACES.exec(text)[0].length, text, terminator: cr ? '\r' : '' }
}

function measureGutter(lines) {
  let gutter = Infinity
  for (const { indent, text } of lines) {
    // Blank and whitespace-only lines say nothing either way.
    if (indent === text.length) continue
    gutter = Math.min(gutter, indent)
    if (gutter === 0) return 0
  }
  return Number.isFinite(gutter) ? gutter : 0
}

export function stripTerminalSelectionGutter(selection) {
  const text = String(selection || '')
  const lines = text.split('\n').map(parseLine)
  const gutter = measureGutter(lines)
  if (gutter === 0) return text
  return lines.map(({ indent, text: t, terminator }) => t.slice(Math.min(indent, gutter)) + terminator).join('\n')
}
