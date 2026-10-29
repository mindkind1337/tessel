// Excel workbooks in the editor (sheet/xlsx.js): a real .xlsx built here (a
// zip of XML parts, deflated as Excel writes them) is read back as tables.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { readWorkbook, cellRef, colName, serialToDate, MAX_ROWS } from '../sheet/xlsx'
import { fileKind } from '../../../shared/fileKinds'

// A zip with each part deflated (method 8), or stored (method 0) when asked.
function zip(parts, stored = []) {
  const enc = new TextEncoder()
  const locals = []
  const central = []
  let offset = 0
  for (const [name, text] of Object.entries(parts)) {
    const raw = enc.encode(text)
    const store = stored.includes(name)
    const data = store ? raw : new Uint8Array(deflateRawSync(raw))
    const nameBytes = enc.encode(name)
    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const dv = new DataView(local.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(8, store ? 0 : 8, true)
    dv.setUint32(18, data.length, true)
    dv.setUint32(22, raw.length, true)
    dv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    const cen = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, store ? 0 : 8, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    cen.set(nameBytes, 46)
    locals.push(local)
    central.push(cen)
    offset += local.length
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, central.length, true)
  ev.setUint16(10, central.length, true)
  ev.setUint32(12, cenSize, true)
  ev.setUint32(16, offset, true)
  const all = [...locals, ...central, end]
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of all) {
    out.set(a, o)
    o += a.length
  }
  return out
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const workbook = (sheet1) => ({
  'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS}><sheets><sheet name="Ventes" sheetId="1" r:id="rId1"/><sheet name="Vide" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': `<?xml version="1.0"?><sst ${NS}><si><t>Produit</t></si><si><t>Date</t></si><si><r><t>Ban</t></r><r><t>ane</t></r></si></sst>`,
  'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${NS}><numFmts><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd hh:mm"/><numFmt numFmtId="165" formatCode="0.00&quot; $&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`,
  'xl/worksheets/sheet1.xml': sheet1,
  'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet ${NS}><sheetData/></worksheet>`
})
const SHEET1 = `<?xml version="1.0"?><worksheet ${NS}><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Note</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>45658</v></c><c r="C2" s="3"><v>0.30000000000000004</v></c><c r="D2" t="b"><v>1</v></c></row>
<row r="4"><c r="A4" t="str"><f>CONCAT("a","b")</f><v>ab</v></c><c r="B4" s="2"><v>45658.5</v></c><c r="AB4"><v>7</v></c></row>
</sheetData></worksheet>`

describe('readWorkbook', () => {
  it('reads every sheet: shared, rich and inline strings, numbers, booleans, formula results, dates', async () => {
    const { sheets } = await readWorkbook(zip(workbook(SHEET1)))
    expect(sheets.map((s) => s.name)).toEqual(['Ventes', 'Vide'])
    const [s] = sheets
    expect(s.rows[0]).toEqual(['Produit', 'Date', '', 'Note'])
    // A rich string's runs joined; a date format shown as a date; 0.1+0.2 as Excel shows it.
    expect(s.rows[1]).toEqual(['Banane', '2025-01-01', '0.3', 'TRUE'])
    // Row 3 is missing in the file: an empty row keeps the numbers right.
    expect(s.rows[2]).toEqual([])
    expect(s.rows[3][0]).toBe('ab')
    expect(s.rows[3][1]).toBe('2025-01-01 12:00:00')
    expect(s.rows[3][27]).toBe('7')
    expect(s.cols).toBe(28)
    expect(s.more).toBe(0)
    expect(sheets[1]).toMatchObject({ rows: [], cols: 0 })
  })

  it('a part stored without compression reads the same', async () => {
    const { sheets } = await readWorkbook(zip(workbook(SHEET1), ['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']))
    expect(sheets[0].rows[1][0]).toBe('Banane')
  })

  it(`a sheet keeps at most ${MAX_ROWS} rows and says how many more there are`, async () => {
    const rows = Array.from({ length: MAX_ROWS + 3 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('')
    const { sheets } = await readWorkbook(zip(workbook(`<?xml version="1.0"?><worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`)))
    expect(sheets[0].rows).toHaveLength(MAX_ROWS)
    expect(sheets[0].more).toBe(3)
  })

  it('not a workbook: an error, nothing shown', async () => {
    await expect(readWorkbook(new TextEncoder().encode('hello'))).rejects.toThrow()
    await expect(readWorkbook(zip({ 'a.txt': 'x' }))).rejects.toThrow()
  })
})

describe('helpers', () => {
  it('cell references and column letters', () => {
    expect(cellRef('C12')).toEqual({ col: 2, row: 11 })
    expect(cellRef('AB4')).toEqual({ col: 27, row: 3 })
    expect([0, 25, 26, 27, 701, 702].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  })
  it('Excel date serials (1900 and 1904 systems)', () => {
    expect(serialToDate(45658)).toBe('2025-01-01')
    expect(serialToDate(0.75)).toBe('18:00:00')
    expect(serialToDate(44196, true)).toBe('2025-01-01')
  })
})

describe('in the editor', () => {
  const pane = readFileSync(join(__dirname, '..', 'components', 'EditorPane.vue'), 'utf8')
  const rich = readFileSync(join(__dirname, '..', 'components', 'RichView.vue'), 'utf8')
  it('.xlsx and .xlsm open as a sheet view (read whole, like an image), never as text', () => {
    expect(fileKind('C:/a/Budget.xlsx')).toBe('sheet')
    expect(fileKind('ssh://h/srv/b.XLSM')).toBe('sheet')
    expect(fileKind('old.xls')).toBe('text')
    expect(pane).toContain("if (k === 'image' || k === 'sheet') return 'image'")
    expect(pane).toContain(":kind=\"mode === 'image' ? (kind === 'sheet' ? 'sheet' : 'image') : kind\"")
    expect(rich).toContain('<SheetView v-else-if="kind === \'sheet\'" :file="file" />')
  })
})
