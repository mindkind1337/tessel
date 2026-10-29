// Word, PowerPoint and OpenDocument files in the editor (office/docs.js,
// sheet/xlsx.js readOds): real files built here, read back as text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zip } from './zipBuild'
import { readDocument, readSlides } from '../office/docs'
import { readOds } from '../sheet/xlsx'
import { fileKind, BYTE_KINDS, BINARY_MIME } from '../../../shared/fileKinds'

const text = (b) => b.runs.map((r) => r.text).join('')

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const DOCX = {
  'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Titre1"/></w:pPr><w:r><w:t>Rapport</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Gras </w:t></w:r><w:r><w:rPr><w:i/><w:b w:val="0"/></w:rPr><w:t>italique</w:t></w:r><w:r><w:br/><w:t>suite</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Point</w:t></w:r></w:p>
<w:p><w:hyperlink r:id="rId9"><w:r><w:t>site</w:t></w:r></w:hyperlink><w:hyperlink r:id="rId8"><w:r><w:t>local</w:t></w:r></w:hyperlink></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`,
  'word/_rels/document.xml.rels':
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Target="https://example.com/a" TargetMode="External"/><Relationship Id="rId8" Target="file:///C:/secret.txt" TargetMode="External"/></Relationships>',
  'word/styles.xml': `<?xml version="1.0"?><w:styles ${W}><w:style w:styleId="Titre1"><w:name w:val="heading 1"/></w:style></w:styles>`
}

describe('Word (.docx)', () => {
  it('headings (by style name), bold and italic runs, line breaks, list levels, tables', async () => {
    const { blocks } = await readDocument(zip(DOCX), 'docx')
    expect(blocks[0]).toMatchObject({ type: 'p', style: 'h1' })
    expect(text(blocks[0])).toBe('Rapport')
    expect(blocks[1].runs.map((r) => [r.text, r.b, r.i])).toEqual([
      ['Gras ', true, false],
      ['italique', false, true],
      ['\nsuite', false, false]
    ])
    expect(blocks[2]).toMatchObject({ style: 'li', level: 1 })
    expect(blocks[4]).toEqual({ type: 'table', rows: [['A', 'B']] })
  })
  it('a link opens only as a web page: a file: link is plain text', async () => {
    const { blocks } = await readDocument(zip(DOCX), 'docx')
    expect(blocks[3].runs.map((r) => [r.text, r.href])).toEqual([
      ['site', 'https://example.com/a'],
      ['local', '']
    ])
  })
  it('not a document: an error', async () => {
    await expect(readDocument(zip({ 'a.xml': '<a/>' }), 'docx')).rejects.toThrow()
  })
})

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const slide = (body) => `<?xml version="1.0"?><p:sld ${A}><p:cSld><p:spTree><p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
describe('PowerPoint (.pptx)', () => {
  it('the slides in the order of the presentation, each with its paragraphs', async () => {
    const pptx = zip({
      'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${A}><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels':
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide1.xml': slide('<a:p><a:r><a:t>Second</a:t></a:r></a:p>'),
      'ppt/slides/slide2.xml': slide('<a:p><a:r><a:rPr b="1"/><a:t>Titre</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>Puce</a:t></a:r></a:p>')
    })
    const { slides } = await readSlides(pptx, 'pptx')
    expect(slides.map((s) => s.blocks.map(text))).toEqual([['Titre', 'Puce'], ['Second']])
    expect(slides[0].blocks[0].runs[0].b).toBe(true)
    expect(slides[0].blocks[1]).toMatchObject({ style: 'li', level: 0 })
  })
})

const ODF = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"'
describe('OpenDocument', () => {
  it('.odt: headings, paragraphs with spaces and links, lists, tables', async () => {
    const odt = zip({
      'content.xml': `<?xml version="1.0"?><office:document-content ${ODF}><office:body><office:text>
<text:h text:outline-level="2">Partie</text:h>
<text:p>Un<text:s text:c="3"/>deux <text:a xlink:href="https://example.com">lien</text:a></text:p>
<text:list><text:list-item><text:p>Item</text:p></text:list-item></text:list>
<table:table><table:table-row><table:table-cell><text:p>C1</text:p></table:table-cell></table:table-row></table:table>
</office:text></office:body></office:document-content>`
    })
    const { blocks } = await readDocument(odt, 'odt')
    expect(blocks[0]).toMatchObject({ style: 'h2' })
    expect(text(blocks[1])).toBe('Un   deux lien')
    expect(blocks[1].runs.find((r) => r.text === 'lien').href).toBe('https://example.com')
    expect(blocks[2]).toMatchObject({ style: 'li', level: 0 })
    expect(blocks[3]).toEqual({ type: 'table', rows: [['C1']] })
  })
  it('.odp: each page a slide', async () => {
    const odp = zip({
      'content.xml': `<?xml version="1.0"?><office:document-content ${ODF}><office:body><office:presentation>
<draw:page draw:name="p1"><draw:frame><draw:text-box><text:p>Bonjour</text:p></draw:text-box></draw:frame></draw:page>
<draw:page draw:name="p2"><draw:frame><draw:text-box><text:p>Fin</text:p></draw:text-box></draw:frame></draw:page>
</office:presentation></office:body></office:document-content>`
    })
    const { slides } = await readSlides(odp, 'odp')
    expect(slides.map((s) => s.blocks.map(text))).toEqual([['Bonjour'], ['Fin']])
  })
  it('.ods: sheets, values, repeated cells and rows (an empty tail of a million rows is not stored)', async () => {
    const ods = zip({
      'content.xml': `<?xml version="1.0"?><office:document-content ${ODF}><office:body><office:spreadsheet>
<table:table table:name="Budget">
<table:table-row><table:table-cell office:value-type="string"><text:p>Nom</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="float" office:value="12.5"/></table:table-row>
<table:table-row table:number-rows-repeated="2"><table:table-cell office:value-type="boolean" office:boolean-value="true"/></table:table-row>
<table:table-row table:number-rows-repeated="1048570"><table:table-cell/></table:table-row>
</table:table></office:spreadsheet></office:body></office:document-content>`
    })
    const { sheets } = await readOds(ods)
    expect(sheets[0].name).toBe('Budget')
    expect(sheets[0].rows).toEqual([['Nom', '', '', '12.5'], ['TRUE'], ['TRUE']])
    expect(sheets[0].more).toBe(0)
  })
})

describe('in the editor', () => {
  const pane = readFileSync(join(__dirname, '..', 'components', 'EditorPane.vue'), 'utf8')
  const html = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8')
  it('each kind opens in its own view, read whole like an image', () => {
    expect(['a.docx', 'a.odt', 'a.pptx', 'a.odp', 'a.ods', 'a.mp3', 'a.mp4', 'a.webm', 'a.avif'].map(fileKind)).toEqual(['doc', 'doc', 'slides', 'slides', 'sheet', 'audio', 'video', 'video', 'image'])
    for (const ext of ['docx', 'odt', 'pptx', 'odp', 'ods', 'mp3', 'mp4']) expect(BINARY_MIME[ext]).toBeTruthy()
    expect(BYTE_KINDS).toEqual(['image', 'pdf', 'sheet', 'doc', 'slides', 'audio', 'video'])
    expect(pane).toContain("const VIEW_KINDS = ['image', 'pdf', 'sheet', 'doc', 'slides', 'audio', 'video']")
    // Audio and video play from blob: URLs only (no data:, no other origin).
    expect(html).toContain("media-src 'self' blob:;")
  })
})

describe('PDF in an editor tab', () => {
  const app = readFileSync(join(__dirname, '..', 'App.vue'), 'utf8')
  const view = readFileSync(join(__dirname, '..', 'components', 'PdfView.vue'), 'utf8')
  it('opens in the editor first, its own window only when no workspace can hold an editor', () => {
    const fn = app.slice(app.indexOf('async function viewFile('), app.indexOf('async function viewFile(') + 600)
    expect(fn.indexOf("if (openInTesselEditor({ file, line: null, preview })) return")).toBeGreaterThan(0)
    expect(fn.indexOf("if (openInTesselEditor({ file, line: null, preview })) return")).toBeLessThan(fn.indexOf('window.shellApi.openPdf'))
  })
  it("pdf.js never runs the PDF's scripts or XFA forms", () => {
    expect(view).toContain('getDocument({ data: r.bytes, isEvalSupported: false, enableXfa: false })')
  })
})
