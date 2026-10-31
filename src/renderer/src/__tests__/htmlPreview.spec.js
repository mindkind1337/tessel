import { it, expect } from 'vitest'
import { htmlPreview, htmlPlainText } from '../htmlPreview'
import { fileKind } from '../../../shared/fileKinds'

it('renders local HTML with styling but strips executable content and active navigation', () => {
  const output = htmlPreview('<!doctype html><html><head><style>h1 { color: red }</style><meta http-equiv="refresh" content="0;url=https://other.test"></head><body><h1 onclick="alert(1)">Title</h1><script>evil()</script><iframe src="https://other.test"></iframe><a href="reports/document.pdf">PDF</a><img src="image.png"></body></html>')
  const doc = new DOMParser().parseFromString(output, 'text/html')
  expect(doc.querySelector('h1').textContent).toBe('Title')
  expect(doc.querySelector('style').textContent).toContain('color: red')
  expect(doc.querySelector('script, iframe, [onclick]')).toBeNull()
  expect(doc.querySelector('meta').content).toContain("script-src 'none'")
  expect(doc.querySelectorAll('meta')).toHaveLength(1)
  expect(doc.querySelector('a').dataset.tesselHref).toBe('reports/document.pdf')
  expect(doc.querySelector('a').getAttribute('href')).toBe('#')
  expect(doc.querySelector('img').getAttribute('src')).toBeNull()
  expect(doc.querySelector('img').dataset.localSrc).toBe('image.png')
  expect(fileKind('INDEX.html')).toBe('html')
})

it('provides readable plain content without tags, scripts or styles', () => {
  expect(htmlPlainText('<style>body{color:red}</style><h1>Title</h1><p>First &amp; second</p><p>Last<br>line</p><script>evil()</script>')).toBe('Title\nFirst & second\nLast\nline')
})
