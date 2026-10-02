// A small Markdown reader for the project notes: headings, lists, quotes,
// code blocks, paragraphs, and inline `code`, **bold** and *italic*.
// It returns blocks of plain text pieces that the view renders as elements,
// so nothing in the file is ever interpreted as HTML.
//
// parseMarkdown(text) -> [
//   { type: 'h1' | 'h2' | 'h3', parts },
//   { type: 'p' | 'quote', parts },
//   { type: 'ul', items: [parts, ...] },
//   { type: 'code', text },
//   { type: 'hr' }
// ]  where parts = [{ kind: 'text' | 'code' | 'bold' | 'italic', text }]

export function parseInline(text) {
  const parts = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ kind: 'text', text: text.slice(last, m.index) })
    const tok = m[0]
    if (m[1]) parts.push({ kind: 'code', text: tok.slice(1, -1) })
    else if (m[2]) parts.push({ kind: 'bold', text: tok.slice(2, -2) })
    else parts.push({ kind: 'italic', text: tok.slice(1, -1) })
    last = m.index + tok.length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}

export function parseMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let para = null
  let list = null
  const flush = () => {
    if (para) blocks.push({ type: para.type, parts: parseInline(para.lines.join(' ')) })
    if (list) blocks.push({ type: 'ul', items: list.map((l) => parseInline(l)) })
    para = null
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^```/.test(line)) {
      flush()
      const code = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++])
      blocks.push({ type: 'code', text: code.join('\n') })
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      blocks.push({ type: 'h' + h[1].length, parts: parseInline(h[2].trim()) })
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush()
      blocks.push({ type: 'hr' })
      continue
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line)
    if (li) {
      if (para) flush()
      if (!list) list = []
      list.push(li[1])
      continue
    }
    // A wrapped list line continues the item above it.
    if (list && /^\s{2,}\S/.test(line)) {
      list[list.length - 1] += ' ' + line.trim()
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const q = /^>\s?(.*)$/.exec(line)
    const type = q ? 'quote' : 'p'
    if (list || (para && para.type !== type)) flush()
    if (!para) para = { type, lines: [] }
    para.lines.push(q ? q[1] : line.trim())
  }
  flush()
  return blocks
}
