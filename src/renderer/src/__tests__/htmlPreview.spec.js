import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

it('the preview is a real website first (its own server), the static preview only as a fallback', () => {
  const view = readFileSync(join(__dirname, '..', 'components', 'HtmlView.vue'), 'utf8')
  const html = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8')
  expect(view).toContain('window.shellApi.previewUrl({ file: props.file, root: props.root, text: props.text, scripts: scripts.value })')
  // Scripts only once turned on for the folder; never popups, dialogs or downloads from the page.
  expect(view).toContain(":sandbox=\"scripts ? 'allow-scripts allow-same-origin allow-forms' : 'allow-same-origin'\"")
  expect(view).not.toMatch(/allow-(popups|modals|downloads|top-navigation)/)
  expect(view).toContain('const scripts = ref(readTrusted().includes(folderKey()))')
  expect(view).toContain('<iframe v-else-if="liveSrc" :src="liveSrc" ')
  // The static one is still there for a file no server can serve.
  expect(view).toContain('<iframe v-if="liveFailed" :srcdoc="src" sandbox="allow-same-origin"')
  // The page's frame may only be the preview server on the loopback.
  expect(html).toContain('frame-src http://*.localhost:*;')
})
