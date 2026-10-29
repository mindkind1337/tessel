// Reading an Excel workbook (.xlsx / .xlsm) for the editor's sheet view,
// read-only and with nothing added to the app: a workbook is a zip of XML
// files, the zip is read here (its central directory), each part inflated by
// Chromium's own DecompressionStream, the XML read with DOMParser.
//   readWorkbook(bytes) -> { sheets: [{ name, rows: string[][], cols, more }] }
// rows hold the text each cell shows: shared and inline strings, numbers,
// booleans, formula results (their last saved value), dates in a date format
// as YYYY-MM-DD (and the time when there is one). Formatting, charts and
// pictures are not read. A sheet keeps at most MAX_ROWS rows and MAX_COLS
// columns; `more` says how many rows were left out.

export const MAX_ROWS = 5000
export const MAX_COLS = 200
import { zipEntries, readPart, xml, els, resolveTarget } from '../office/zip'

function textOf(node) {
  // A rich string: its runs' <t>; phonetic runs (<rPh>) are not shown.
  const ts = els(node, 't').filter((t) => !t.closest || !t.closest('rPh'))
  return ts.length ? ts.map((t) => t.textContent).join('') : node.textContent || ''
}

// "C12" -> { col: 2, row: 11 } (0-based)
export function cellRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref || ''))
  if (!m) return null
  let col = 0
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { col: col - 1, row: Number(m[2]) - 1 }
}
// 0 -> "A", 27 -> "AB"
export function colName(i) {
  let s = ''
  let n = i + 1
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// --- Dates ----------------------------------------------------------------------------
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])
function isDateFormat(code) {
  // Quoted text and [colours] taken out: a d, m, y, h or s left is a date or a time.
  const bare = String(code || '')
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
  return /[dmyhs]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare)
}
export function serialToDate(v, date1904 = false) {
  const ms = Math.round((v - (date1904 ? -1462 : 0) - 25569) * 86400000)
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return String(v)
  const iso = d.toISOString()
  const day = iso.slice(0, 10)
  const time = iso.slice(11, 19)
  if (v < 1 && v >= 0) return time
  return time === '00:00:00' ? day : `${day} ${time}`
}
function numberText(v) {
  if (!Number.isFinite(v)) return ''
  // 0.1 + 0.2 as Excel shows it, not 0.30000000000000004.
  return String(Number(v.toPrecision(15)))
}

// --- Workbook -------------------------------------------------------------------------
export async function readWorkbook(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const entries = zipEntries(data)
  const wbText = await readPart(data, entries, 'xl/workbook.xml')
  if (!wbText) throw new Error('not a workbook')
  const wb = xml(wbText)
  const date1904 = els(wb, 'workbookPr').some((p) => /^(1|true)$/.test(p.getAttribute('date1904') || ''))
  const rels = new Map()
  const relText = await readPart(data, entries, 'xl/_rels/workbook.xml.rels')
  if (relText) for (const r of els(xml(relText), 'Relationship')) rels.set(r.getAttribute('Id'), resolveTarget('xl/workbook.xml', r.getAttribute('Target') || ''))

  const shared = []
  const ssText = await readPart(data, entries, 'xl/sharedStrings.xml')
  if (ssText) for (const si of els(xml(ssText), 'si')) shared.push(textOf(si))

  // Each style (cell s="…") -> whether its number format is a date.
  const dateStyle = []
  const stText = await readPart(data, entries, 'xl/styles.xml')
  if (stText) {
    const st = xml(stText)
    const custom = new Map(els(st, 'numFmt').map((f) => [Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') || '']))
    const xfs = els(st, 'cellXfs')[0]
    if (xfs)
      for (const xf of Array.from(xfs.children).filter((c) => c.localName === 'xf')) {
        const id = Number(xf.getAttribute('numFmtId') || 0)
        dateStyle.push(DATE_FORMAT_IDS.has(id) || (custom.has(id) && isDateFormat(custom.get(id))))
      }
  }

  const sheets = []
  for (const s of els(wb, 'sheet')) {
    // A sheet without a name: Excel's own default name (data, not Tessel's text).
    const name = s.getAttribute('name') || `Sheet${sheets.length + 1}` // i18n-ignore
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id')
    const path = rels.get(rid)
    const text = path ? await readPart(data, entries, path) : null
    sheets.push(text ? readSheet(xml(text), name, shared, dateStyle, date1904) : { name, rows: [], cols: 0, more: 0 })
  }
  return { sheets }
}

function cellText(c, shared, dateStyle, date1904) {
  const type = c.getAttribute('t') || 'n'
  const v = els(c, 'v')[0]
  const raw = v ? v.textContent : ''
  if (type === 'inlineStr') {
    const is = els(c, 'is')[0]
    return is ? textOf(is) : ''
  }
  if (type === 's') return shared[Number(raw)] ?? ''
  if (type === 'b') return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw
  if (type === 'str' || type === 'e') return raw
  if (raw === '') return ''
  const num = Number(raw)
  if (!Number.isFinite(num)) return raw
  const style = Number(c.getAttribute('s') || 0)
  return dateStyle[style] ? serialToDate(num, date1904) : numberText(num)
}

function readSheet(doc, name, shared, dateStyle, date1904) {
  const rows = []
  let cols = 0
  let lastRow = -1
  for (const r of els(doc, 'row')) {
    const rn = Number(r.getAttribute('r'))
    const ri = Number.isInteger(rn) && rn > 0 ? rn - 1 : lastRow + 1
    lastRow = ri
    if (ri >= MAX_ROWS) continue
    const row = []
    let lastCol = -1
    for (const c of Array.from(r.children).filter((x) => x.localName === 'c')) {
      const ref = cellRef(c.getAttribute('r'))
      const ci = ref ? ref.col : lastCol + 1
      lastCol = ci
      if (ci >= MAX_COLS) continue
      const text = cellText(c, shared, dateStyle, date1904)
      if (text === '') continue
      while (row.length < ci) row.push('')
      row[ci] = text
    }
    if (row.length) {
      while (rows.length < ri) rows.push([])
      rows[ri] = row
      cols = Math.max(cols, row.length)
    }
  }
  return { name, rows, cols, more: Math.max(0, lastRow + 1 - MAX_ROWS) }
}

// --- OpenDocument spreadsheet (.ods) -------------------------------------------------------
const TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0'
const OFFICE_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'
function odsCellText(c) {
  const type = c.getAttributeNS(OFFICE_NS, 'value-type') || ''
  const ps = els(c, 'p')
  const shown = ps.map((p) => p.textContent).join('\n')
  if (shown) return shown
  if (type === 'date') return (c.getAttributeNS(OFFICE_NS, 'date-value') || '').replace('T', ' ')
  if (type === 'boolean') return (c.getAttributeNS(OFFICE_NS, 'boolean-value') || '').toUpperCase()
  const v = c.getAttributeNS(OFFICE_NS, 'value')
  return v ? numberText(Number(v)) : ''
}
// Rows and cells may say "repeated N times" (an empty tail is often a
// million rows): repeats are cut at the caps, empty ones never stored.
export async function readOds(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const entries = zipEntries(data)
  const text = await readPart(data, entries, 'content.xml')
  if (!text) throw new Error('not a spreadsheet')
  const sheets = []
  for (const tbl of els(xml(text), 'table')) {
    if (tbl.namespaceURI !== TABLE_NS) continue
    const rows = []
    let cols = 0
    let ri = 0
    let total = 0
    for (const tr of els(tbl, 'table-row')) {
      const rep = Math.max(1, Number(tr.getAttributeNS(TABLE_NS, 'number-rows-repeated') || 1))
      const row = []
      let ci = 0
      for (const c of Array.from(tr.children).filter((x) => x.localName === 'table-cell' || x.localName === 'covered-table-cell')) {
        const crep = Math.max(1, Number(c.getAttributeNS(TABLE_NS, 'number-columns-repeated') || 1))
        const t = odsCellText(c)
        if (t !== '')
          for (let k = 0; k < crep && ci + k < MAX_COLS; k++) {
            while (row.length < ci + k) row.push('')
            row[ci + k] = t
          }
        ci += crep
      }
      if (row.length) {
        total = ri + rep
        for (let k = 0; k < rep && ri + k < MAX_ROWS; k++) {
          while (rows.length < ri + k) rows.push([])
          rows[ri + k] = row
        }
        cols = Math.max(cols, row.length)
      }
      ri += rep
    }
    sheets.push({ name: tbl.getAttributeNS(TABLE_NS, 'name') || String(sheets.length + 1), rows, cols, more: Math.max(0, total - MAX_ROWS) })
  }
  return { sheets }
}
