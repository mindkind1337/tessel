// Word, PowerPoint and OpenDocument files for the editor's document view,
// read-only: their text and structure, never their formatting.
//   readDocument(bytes, ext) -> { blocks } for .docx / .odt
//   readSlides(bytes, ext)   -> { slides: [{ blocks }] } for .pptx / .odp
// A block is { type: 'p', style: 'h1'…'h6' | 'p' | 'li', level, runs } or
// { type: 'table', rows: string[][] }; a run is { text, b, i, u, href }
// (href: a web link, opened only by the link router). Pictures, charts and
// shapes other than text are not read.
import { openZip, xml, els, resolveTarget } from './zip'

export const MAX_BLOCKS = 20000

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
const TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0'
const XLINK = 'http://www.w3.org/1999/xlink'

const kids = (node, name) => Array.from(node.children).filter((c) => !name || c.localName === name)
const webLink = (href) => (/^(https?:|mailto:)/i.test(String(href || '')) ? String(href) : '')
const on = (el) => !!el && !/^(0|false|none)$/i.test(el.getAttributeNS(W, 'val') || el.getAttribute('w:val') || '')

async function relsOf(zip, part) {
  const dir = part.split('/').slice(0, -1).join('/')
  const name = part.split('/').pop()
  const text = await zip.read(`${dir}/_rels/${name}.rels`) // i18n-ignore
  const map = new Map()
  if (text)
    for (const r of els(xml(text), 'Relationship'))
      map.set(r.getAttribute('Id'), { target: r.getAttribute('Target') || '', external: r.getAttribute('TargetMode') === 'External', type: r.getAttribute('Type') || '' })
  return map
}

// --- Word (.docx) ----------------------------------------------------------------------
function wordRuns(p, rels) {
  const runs = []
  const add = (r, href) => {
    const props = kids(r, 'rPr')[0]
    const style = { b: on(props && kids(props, 'b')[0]), i: on(props && kids(props, 'i')[0]), u: !!(props && kids(props, 'u')[0] && on(kids(props, 'u')[0])) }
    let text = ''
    for (const c of kids(r)) {
      if (c.localName === 't') text += c.textContent
      else if (c.localName === 'tab') text += '\t'
      else if (c.localName === 'br' || c.localName === 'cr') text += '\n'
      else if (c.localName === 'noBreakHyphen') text += '‑'
    }
    if (text) runs.push({ text, ...style, href })
  }
  for (const c of kids(p)) {
    if (c.localName === 'r') add(c, '')
    else if (c.localName === 'hyperlink') {
      const rel = rels.get(c.getAttributeNS(R, 'id') || c.getAttribute('r:id'))
      const href = rel && rel.external ? webLink(rel.target) : ''
      for (const r of kids(c, 'r')) add(r, href)
    } else if (c.localName === 'ins' || c.localName === 'smartTag' || c.localName === 'sdt') {
      for (const r of els(c, 'r')) add(r, '')
    }
  }
  return runs
}
function wordStyle(p, headingIds) {
  const pr = kids(p, 'pPr')[0]
  if (!pr) return { style: 'p', level: 0 }
  const ps = kids(pr, 'pStyle')[0]
  const id = ps ? ps.getAttributeNS(W, 'val') || ps.getAttribute('w:val') || '' : ''
  const h = headingIds.get(id) || /^(?:heading|titre)\s*([1-6])$/i.exec(id)?.[1] || (/^title$/i.test(id) ? '1' : '')
  if (h) return { style: `h${h}`, level: 0 }
  const num = kids(pr, 'numPr')[0]
  if (num) {
    const ilvl = kids(num, 'ilvl')[0]
    return { style: 'li', level: Number((ilvl && (ilvl.getAttributeNS(W, 'val') || ilvl.getAttribute('w:val'))) || 0) }
  }
  return { style: 'p', level: 0 }
}
function cellText(cell, rels) {
  return els(cell, 'p')
    .map((p) => wordRuns(p, rels).map((r) => r.text).join(''))
    .join('\n')
}

async function readDocx(zip) {
  const text = await zip.read('word/document.xml')
  if (!text) throw new Error('not a document')
  const rels = await relsOf(zip, 'word/document.xml')
  // Heading styles by id (a style named "heading 2" whatever its id).
  const headingIds = new Map()
  const st = await zip.read('word/styles.xml')
  if (st)
    for (const s of els(xml(st), 'style')) {
      const name = kids(s, 'name')[0]
      const m = /^heading\s*([1-6])$/i.exec(name ? name.getAttributeNS(W, 'val') || name.getAttribute('w:val') || '' : '')
      if (m) headingIds.set(s.getAttributeNS(W, 'styleId') || s.getAttribute('w:styleId'), m[1])
    }
  const body = els(xml(text), 'body')[0]
  const blocks = []
  const walk = (node) => {
    for (const c of kids(node)) {
      if (blocks.length >= MAX_BLOCKS) return
      if (c.localName === 'p') blocks.push({ type: 'p', ...wordStyle(c, headingIds), runs: wordRuns(c, rels) })
      else if (c.localName === 'tbl')
        blocks.push({ type: 'table', rows: kids(c, 'tr').map((tr) => kids(tr, 'tc').map((tc) => cellText(tc, rels))) })
      else if (c.localName === 'sdt') {
        const content = kids(c, 'sdtContent')[0]
        if (content) walk(content)
      }
    }
  }
  if (body) walk(body)
  return { blocks }
}

// --- OpenDocument text (.odt) and slides (.odp) ------------------------------------------
function odfRuns(node) {
  const runs = []
  const visit = (n, style, href) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) {
        if (c.nodeValue) runs.push({ text: c.nodeValue, ...style, href })
        continue
      }
      if (c.nodeType !== 1) continue
      const ln = c.localName
      if (ln === 's') runs.push({ text: ' '.repeat(Math.min(Number(c.getAttributeNS(TEXT_NS, 'c') || 1), 100)), ...style, href })
      else if (ln === 'tab') runs.push({ text: '\t', ...style, href })
      else if (ln === 'line-break') runs.push({ text: '\n', ...style, href })
      else if (ln === 'a') visit(c, style, webLink(c.getAttributeNS(XLINK, 'href')))
      else if (ln === 'span') visit(c, style, href)
      else if (ln !== 'note' && ln !== 'annotation') visit(c, style, href)
    }
  }
  visit(node, { b: false, i: false, u: false }, '')
  return runs
}
function odfBlocks(container, blocks, level = 0) {
  for (const c of kids(container)) {
    if (blocks.length >= MAX_BLOCKS) return
    const ns = c.namespaceURI
    if (ns === TEXT_NS && c.localName === 'h') {
      const lvl = Math.min(6, Math.max(1, Number(c.getAttributeNS(TEXT_NS, 'outline-level') || 1)))
      blocks.push({ type: 'p', style: `h${lvl}`, level: 0, runs: odfRuns(c) })
    } else if (ns === TEXT_NS && c.localName === 'p') blocks.push({ type: 'p', style: level ? 'li' : 'p', level: Math.max(0, level - 1), runs: odfRuns(c) })
    else if (ns === TEXT_NS && c.localName === 'list') {
      for (const item of kids(c)) odfBlocks(item, blocks, level + 1)
    } else if (ns === TABLE_NS && c.localName === 'table') {
      const rows = []
      for (const tr of els(c, 'table-row').slice(0, 5000))
        rows.push(kids(tr, 'table-cell').map((tc) => els(tc, 'p').map((p) => odfRuns(p).map((r) => r.text).join('')).join('\n')))
      blocks.push({ type: 'table', rows })
    } else if (c.localName === 'section' || c.localName === 'frame' || c.localName === 'text-box' || c.localName === 'custom-shape' || c.localName === 'g') odfBlocks(c, blocks, level)
  }
}

async function readOdfContent(zip) {
  const text = await zip.read('content.xml')
  if (!text) throw new Error('not an OpenDocument file')
  return xml(text)
}

// --- PowerPoint (.pptx) -----------------------------------------------------------------
function slideBlocks(doc) {
  const blocks = []
  for (const p of els(doc, 'p')) {
    if (p.namespaceURI !== 'http://schemas.openxmlformats.org/drawingml/2006/main') continue
    const runs = []
    for (const c of kids(p)) {
      if (c.localName === 'r' || c.localName === 'fld') {
        const t = kids(c, 't')[0]
        const pr = kids(c, 'rPr')[0]
        if (t && t.textContent) runs.push({ text: t.textContent, b: !!pr && pr.getAttribute('b') === '1', i: !!pr && pr.getAttribute('i') === '1', u: !!pr && !!pr.getAttribute('u') && pr.getAttribute('u') !== 'none', href: '' })
      } else if (c.localName === 'br') runs.push({ text: '\n', b: false, i: false, u: false, href: '' })
    }
    const ppr = kids(p, 'pPr')[0]
    const lvl = ppr ? Number(ppr.getAttribute('lvl') || 0) : 0
    if (runs.length) blocks.push({ type: 'p', style: lvl ? 'li' : 'p', level: Math.max(0, lvl - 1), runs })
  }
  return blocks
}

async function readPptx(zip) {
  const pres = await zip.read('ppt/presentation.xml')
  if (!pres) throw new Error('not a presentation')
  const rels = await relsOf(zip, 'ppt/presentation.xml')
  const slides = []
  for (const id of els(xml(pres), 'sldId')) {
    const rel = rels.get(id.getAttributeNS(R, 'id') || id.getAttribute('r:id'))
    if (!rel) continue
    const text = await zip.read(resolveTarget('ppt/presentation.xml', rel.target))
    slides.push({ blocks: text ? slideBlocks(xml(text)) : [] })
  }
  return { slides }
}

// --- Entry points -----------------------------------------------------------------------
export async function readDocument(bytes, ext) {
  const zip = openZip(bytes)
  if (ext === 'odt') {
    const doc = await readOdfContent(zip)
    const blocks = []
    const body = els(doc, 'text')[0]
    if (body) odfBlocks(body, blocks)
    return { blocks }
  }
  return readDocx(zip)
}

export async function readSlides(bytes, ext) {
  const zip = openZip(bytes)
  if (ext === 'odp') {
    const doc = await readOdfContent(zip)
    const slides = []
    for (const page of els(doc, 'page')) {
      const blocks = []
      odfBlocks(page, blocks)
      slides.push({ blocks, name: page.getAttributeNS('urn:oasis:names:tc:opendocument:xmlns:drawing:1.0', 'name') || '' })
    }
    return { slides }
  }
  return readPptx(zip)
}
