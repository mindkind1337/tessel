// A terminal row's text as links see it, and where each character sits on
// screen. Two things make string positions and screen cells differ:
//   - a wide character (CJK, most emoji) takes two cells, and an emoji is
//     two UTF-16 units in a JS string;
//   - a long path the terminal wrapped continues on the next row(s).
// logicalLine() joins a row with the rows it wraps into (or from), and
// keeps, for each UTF-16 unit of the text, its cell { x, y, w } (0-based);
// rangeOf() turns a match in that text into xterm's 1-based link range,
// which may span rows.
//
// buffer: xterm's IBuffer (getLine(y) -> { isWrapped, length, getCell(x) }).

const MAX_ROWS = 12

function rowCells(line, y, trimEnd) {
  const out = []
  if (!line) return out
  let cell
  for (let x = 0; x < line.length; x++) {
    cell = line.getCell(x, cell)
    if (!cell) break
    const w = cell.getWidth()
    // The second half of a wide character.
    if (w === 0) continue
    const chars = cell.getChars()
    out.push({ chars, x, y, w })
  }
  // Cells never written at the row's end: nothing for the last row; for a
  // row that wraps on, the gap a wide character left (it did not fit).
  while (out.length && out[out.length - 1].chars === '') out.pop()
  if (trimEnd) while (out.length && out[out.length - 1].chars === ' ') out.pop()
  return out
}

// row: 0-based buffer row. -> { text, cells, first, last }
export function logicalLine(buffer, row, maxRows = MAX_ROWS) {
  let first = row
  while (first > 0 && row - first < maxRows) {
    const l = buffer.getLine(first)
    if (!l || !l.isWrapped) break
    first--
  }
  let last = row
  while (last - first < maxRows) {
    const next = buffer.getLine(last + 1)
    if (!next || !next.isWrapped) break
    last++
  }
  let text = ''
  const cells = []
  for (let y = first; y <= last; y++) {
    for (const c of rowCells(buffer.getLine(y), y, y === last)) {
      const chars = c.chars || ' '
      text += chars
      for (let i = 0; i < chars.length; i++) cells.push({ x: c.x, y: c.y, w: c.w })
    }
  }
  return { text, cells, first, last }
}

// A match at [index, index + length) of a logical line -> xterm's range
// ({ start: { x, y }, end: { x, y } }, 1-based, end inclusive), or null.
export function rangeOf(ll, index, length) {
  const a = ll.cells[index]
  const b = ll.cells[index + Math.max(1, length) - 1]
  if (!a || !b) return null
  return { start: { x: a.x + 1, y: a.y + 1 }, end: { x: b.x + b.w, y: b.y + 1 } }
}

// Does a match touch buffer row `row` (0-based)?
export function onRow(ll, index, length, row) {
  const r = rangeOf(ll, index, length)
  return !!r && r.start.y - 1 <= row && r.end.y - 1 >= row
}
