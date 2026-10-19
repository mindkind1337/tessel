import { describe, it, expect } from 'vitest'
import { logicalLine, rangeOf, onRow } from '../links/terminalLinkLines'
import { findFileRefs } from '../../../shared/fileLinks'

// A fake xterm buffer: rows of { text, wrapped }, `cols` cells each. A wide
// character (CJK, emoji) takes two cells, its second one width 0, as xterm
// stores it; a wide character that does not fit at a row's end leaves the
// last cell empty and goes to the next row.
const isWide = (ch) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1f300}-\u{1faff}]/u.test(ch)
function fakeBuffer(text, cols) {
  const rows = [[]]
  for (const ch of Array.from(text)) {
    const w = isWide(ch) ? 2 : 1
    let row = rows[rows.length - 1]
    if (row.length + w > cols) {
      while (row.length < cols) row.push({ chars: '', w: 1 })
      row = []
      rows.push(row)
    }
    row.push({ chars: ch, w })
    if (w === 2) row.push({ chars: '', w: 0 })
  }
  return {
    rows,
    getLine(y) {
      const row = rows[y]
      if (!row) return undefined
      return {
        isWrapped: y > 0,
        length: cols,
        getCell(x) {
          const c = row[x] || { chars: '', w: 1 }
          return { getChars: () => c.chars, getWidth: () => c.w }
        }
      }
    }
  }
}

describe('terminal link positions', () => {
  it('a path after wide characters keeps its screen cells', () => {
    const buf = fakeBuffer('错误 文件 src/a.js:3', 80)
    const ll = logicalLine(buf, 0)
    expect(ll.text).toBe('错误 文件 src/a.js:3')
    const [r] = findFileRefs(ll.text)
    // 错误 = 4 cells, space, 文件 = 4 cells, space: the path starts in cell 11.
    expect(rangeOf(ll, r.index, r.text.length)).toEqual({ start: { x: 11, y: 1 }, end: { x: 20, y: 1 } })
  })
  it('an emoji (two UTF-16 units, two cells) before a path', () => {
    const ll = logicalLine(fakeBuffer('🚀 done src/b.ts', 80), 0)
    const [r] = findFileRefs(ll.text)
    expect(r.path).toBe('src/b.ts')
    expect(rangeOf(ll, r.index, r.text.length)).toEqual({ start: { x: 9, y: 1 }, end: { x: 16, y: 1 } })
  })
  it('a path ending in a wide character ends on its second cell', () => {
    const ll = logicalLine(fakeBuffer('x 文件/说明', 80), 0)
    const [r] = findFileRefs(ll.text)
    expect(r.path).toBe('文件/说明')
    expect(rangeOf(ll, r.index, r.text.length)).toEqual({ start: { x: 3, y: 1 }, end: { x: 11, y: 1 } })
  })
  it('a path wrapped across rows is one link, found from either row', () => {
    const text = 'Error in src/components/very/long/folder/name/file.vue:42'
    const buf = fakeBuffer(text, 20)
    expect(buf.rows.length).toBe(3)
    for (const row of [0, 1, 2]) {
      const ll = logicalLine(buf, row)
      expect(ll.text).toBe(text)
      const [r] = findFileRefs(ll.text)
      expect(r.path).toBe('src/components/very/long/folder/name/file.vue')
      expect(r.line).toBe(42)
      expect(onRow(ll, r.index, r.text.length, row)).toBe(true)
      expect(rangeOf(ll, r.index, r.text.length)).toEqual({ start: { x: 10, y: 1 }, end: { x: 17, y: 3 } })
    }
  })
  it('the gap a wide character leaves at a row end is not in the text', () => {
    // 9 cells of "abcdefghi" then 文 does not fit in 10: it goes on row 2.
    const buf = fakeBuffer('abcdefghi文件/a.md', 10)
    const ll = logicalLine(buf, 1)
    expect(ll.text).toBe('abcdefghi文件/a.md')
  })
  it('a row that does not wrap stands alone', () => {
    const buf = {
      getLine: (y) =>
        [
          { isWrapped: false, length: 3, getCell: (x) => ({ getChars: () => 'abc'[x], getWidth: () => 1 }) },
          { isWrapped: false, length: 3, getCell: (x) => ({ getChars: () => 'def'[x], getWidth: () => 1 }) }
        ][y]
    }
    expect(logicalLine(buf, 1).text).toBe('def')
    expect(logicalLine(buf, 0).text).toBe('abc')
  })
})
