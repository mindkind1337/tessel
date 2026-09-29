import { describe, it, expect } from 'vitest'
import { fileKind, isViewed, parseTable, formatJson } from '../../../shared/fileKinds'
import { resolveFrom } from '../../../shared/viewPaths'
import { renderMarkdown } from '../markdownView'

describe('file viewer: kinds, tables, JSON, paths', () => {
  it('knows how to show a file by its extension', () => {
    expect(fileKind('C:\\p\\README.md')).toBe('markdown')
    expect(fileKind('flow.MMD')).toBe('mermaid')
    expect(fileKind('a.tsv')).toBe('table')
    expect(fileKind('x.jsonl')).toBe('json')
    expect(fileKind('logo.svg')).toBe('image')
    expect(fileKind('doc.pdf')).toBe('pdf')
    expect(fileKind('main.js')).toBe('text')
    expect(isViewed('main.js')).toBe(false)
    expect(isViewed('notes.md')).toBe(true)
  })

  it('reads CSV with quotes, doubled quotes, newlines in quotes; guesses ; and tab', () => {
    expect(parseTable('a,b\n"x, y","he said ""hi"""\n1,"two\nlines"\n').rows).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['1', 'two\nlines']
    ])
    expect(parseTable('\uFEFFa;b;c\r\n1;2;3').delim).toBe(';')
    expect(parseTable('a\tb\n1\t2', 'x.tsv').rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('formats JSON, JSON Lines, and says what is not valid', () => {
    expect(formatJson('{"a":[1,2]}').text).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}')
    expect(formatJson('{"a":1}\n\nnope\n{"b":2}', 'x.jsonl')).toEqual({ text: '{\n  "a": 1\n}\nnope\n{\n  "b": 2\n}', error: '1 line is not valid JSON' })
    expect(formatJson('{bad').error).toMatch(/Not valid JSON/)
    expect(formatJson('// c\n{"a":1}', 'settings.jsonc').error).toBe('')
  })

  it('resolves links and images from the file’s folder', () => {
    expect(resolveFrom('C:\\p\\docs\\README.md', '../src/a.md#part')).toBe('C:\\p\\src\\a.md')
    expect(resolveFrom('C:\\p\\README.md', 'img/logo%20x.png')).toBe('C:\\p\\img\\logo x.png')
    expect(resolveFrom('C:\\p\\README.md', 'file:///D:/x/y.md')).toBe('D:\\x\\y.md')
    expect(resolveFrom('C:\\p\\README.md', 'https://x.y')).toBe(null)
    expect(resolveFrom('C:\\p\\README.md', 'javascript:alert(1)')).toBe(null)
    expect(resolveFrom('\\\\srv\\share\\a\\b.md', '../c.md')).toBe('\\\\srv\\share\\c.md')
  })
})

describe('Markdown rendering is sanitized', () => {
  it('renders GitHub-style Markdown; scripts, handlers and frames are removed', () => {
    const html = renderMarkdown('# Title\n\n- [x] done\n\n<script>alert(1)</script><img src=x onerror=alert(1)><iframe src="https://e.vil"></iframe>\n\n[site](https://example.com) [js](javascript:alert(1))')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).not.toMatch(/<script|onerror|<iframe|href="javascript:/i)
    expect(html).toContain('href="https://example.com"')
  })

  it('untrusted (chat) markdown loses style and class; the file viewer keeps them', () => {
    const src = '<div style="position:fixed;inset:0;z-index:9999" class="modal-backdrop">cover</div>\n\n```js\nx\n```'
    const chat = renderMarkdown(src, { untrusted: true })
    expect(chat).toContain('cover')
    expect(chat).not.toMatch(/style=|class=/)
    const file = renderMarkdown(src)
    expect(file).toMatch(/style="position:fixed/)
    expect(file).toMatch(/class="modal-backdrop"/)
  })

  it('mermaid blocks become placeholders; local images are kept aside to be read', () => {
    const html = renderMarkdown('```mermaid\ngraph TD; A-->B\n```\n\n![logo](img/logo.png) ![web](https://x.y/a.png)')
    expect(html).toContain(`class="md-mermaid" data-mermaid="${encodeURIComponent('graph TD; A-->B\n')}"`)
    expect(html).toMatch(/data-local-src="img\/logo.png"/)
    expect(html).not.toMatch(/src="https:\/\/x.y/)
  })
})
