// How Tessel shows a file (the file viewer, after Orca's): by its extension.
//   markdown  rendered (Preview) or as text (Source), Mermaid blocks drawn
//   mermaid   a diagram file (.mmd)
//   table     CSV / TSV
//   json      formatted JSON (JSON Lines: one value per line)
//   image     png, jpg, gif, webp, bmp, ico, svg (svg shown as an image)
//   pdf       Chromium's PDF viewer, in its own window
//   text      anything else that is text (shown with line numbers)
const EXT = {
  markdown: ['md', 'markdown', 'mdx'],
  mermaid: ['mmd', 'mermaid'],
  table: ['csv', 'tsv'],
  json: ['json', 'jsonc', 'jsonl', 'ndjson'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'],
  pdf: ['pdf']
}

export const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}

export function extOf(file) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(file || ''))
  return m ? m[1].toLowerCase() : ''
}

// -> 'markdown' | 'mermaid' | 'table' | 'json' | 'image' | 'pdf' | 'text'
export function fileKind(file) {
  const ext = extOf(file)
  for (const [kind, list] of Object.entries(EXT)) if (list.includes(ext)) return kind
  return 'text'
}

// Kinds Tessel shows itself when you open a file from a terminal link or
// Jump to file (code files still go to your editor).
export const VIEWED_KINDS = ['markdown', 'mermaid', 'table', 'json', 'image', 'pdf']
export const isViewed = (file) => VIEWED_KINDS.includes(fileKind(file))

// CSV / TSV (RFC 4180: quoted fields, "" for a quote, newlines inside quotes).
// The delimiter: tab for .tsv, else the most frequent of , ; tab in the first line.
export function parseTable(text, file = '') {
  let s = String(text || '').replace(/^﻿/, '')
  let delim = ','
  if (extOf(file) === 'tsv') delim = '\t'
  else {
    const first = s.slice(0, s.search(/\r?\n|$/))
    const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length - 1])
    counts.sort((a, b) => b[1] - a[1])
    if (counts[0][1] > 0) delim = counts[0][0]
  }
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === delim) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return { delim, rows }
}

// JSON shown formatted; JSON Lines one formatted value per line. A value
// that does not parse is shown as it is, with the error.
export function formatJson(text, file = '') {
  const src = String(text || '').replace(/^﻿/, '')
  const lines = ['jsonl', 'ndjson'].includes(extOf(file))
  if (lines) {
    const out = []
    let bad = 0
    for (const line of src.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        out.push(JSON.stringify(JSON.parse(line), null, 2))
      } catch {
        bad++
        out.push(line)
      }
    }
    return { text: out.join('\n'), error: bad ? `${bad} line${bad > 1 ? 's are' : ' is'} not valid JSON` : '' }
  }
  try {
    return { text: JSON.stringify(JSON.parse(src), null, 2), error: '' }
  } catch (err) {
    // JSON with comments (.jsonc, settings files): shown as written.
    return { text: src, error: extOf(file) === 'jsonc' ? '' : `Not valid JSON: ${err.message}` }
  }
}
