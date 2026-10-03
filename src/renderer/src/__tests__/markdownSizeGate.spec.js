import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import {
  overUtf8Bytes,
  markdownPreviewState,
  MARKDOWN_PREVIEW_GATE_BYTES,
  MARKDOWN_PREVIEW_MAX_BYTES
} from '../markdownSize'
import { renderMarkdown } from '../markdownView'
import RichView from '../components/RichView.vue'
import FileViewer from '../components/FileViewer.vue'

// Rendering a whole large document in jsdom takes minutes: what the gate
// lets through is rendered by a stub that only shows the title.
vi.mock('../markdownView', () => ({
  renderMarkdown: vi.fn((text) => `<h1>${String(text).match(/^# (.*)/)[1]}</h1>`),
  renderMermaid: vi.fn(async () => ({ svg: '' }))
}))

const KB = 1024
// A Markdown document of exactly n bytes (ASCII), on three lines.
const doc = (n) => '# Title\n\n' + 'x'.repeat(n - 9)

describe('Markdown preview size limits', () => {
  it('counts UTF-8 bytes, not characters', () => {
    expect(overUtf8Bytes('abc', 3)).toBe(false)
    expect(overUtf8Bytes('abcd', 3)).toBe(true)
    // "é" is 2 bytes, "€" 3: 2 characters, 5 bytes.
    expect(overUtf8Bytes('é€', 4)).toBe(true)
    expect(overUtf8Bytes('é€', 5)).toBe(false)
    expect(overUtf8Bytes(null, 0)).toBe(false)
  })

  it('renders up to 600 KB, gates above, never renders over 1 MiB', () => {
    expect(MARKDOWN_PREVIEW_GATE_BYTES).toBe(600 * KB)
    expect(MARKDOWN_PREVIEW_MAX_BYTES).toBe(1024 * KB)
    expect(markdownPreviewState(doc(600 * KB))).toBe('render')
    expect(markdownPreviewState(doc(600 * KB + 1))).toBe('gate')
    expect(markdownPreviewState(doc(600 * KB + 1), true)).toBe('render')
    expect(markdownPreviewState(doc(1024 * KB), true)).toBe('render')
    expect(markdownPreviewState(doc(1024 * KB + 1), true)).toBe('too-large')
    expect(markdownPreviewState(doc(1024 * KB + 1))).toBe('too-large')
    // 400 K characters of 2 bytes each: 800 KB, gated although short.
    expect(markdownPreviewState('é'.repeat(400 * KB / 1))).toBe('gate')
  })
})

describe('the editor preview (RichView) holds a large file back', () => {
  afterEach(() => vi.clearAllMocks())

  it('renders a small file at once', () => {
    const w = mount(RichView, { props: { file: 'C:\\p\\a.md', kind: 'markdown', text: '# Hello' } })
    expect(w.find('[data-test="markdown-size-gate"]').exists()).toBe(false)
    expect(w.find('article.fview-md h1').text()).toBe('Hello')
  })

  it('shows "Render anyway" over 600 KB, and renders only once asked', async () => {
    const spy = renderMarkdown
    const w = mount(RichView, { props: { file: 'C:\\p\\big.md', kind: 'markdown', text: doc(700 * KB) } })
    expect(w.find('[data-test="markdown-size-gate"]').attributes('data-state')).toBe('gate')
    expect(w.find('article.fview-md').exists()).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    await w.find('[data-test="markdown-render-anyway"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="markdown-size-gate"]').exists()).toBe(false)
    expect(w.find('article.fview-md h1').text()).toBe('Title')
  })

  it('never renders over 1 MiB: it offers the source instead', async () => {
    const spy = renderMarkdown
    const w = mount(RichView, { props: { file: 'C:\\p\\huge.md', kind: 'markdown', text: doc(1100 * KB) } })
    const gate = w.find('[data-test="markdown-size-gate"]')
    expect(gate.attributes('data-state')).toBe('too-large')
    expect(w.find('[data-test="markdown-render-anyway"]').exists()).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    await w.find('[data-test="markdown-show-source"]').trigger('click')
    expect(w.emitted('source')).toHaveLength(1)
  })
})

describe('the file viewer holds a large Markdown file back', () => {
  afterEach(() => {
    vi.clearAllMocks()
    delete window.shellApi
  })
  const open = async (text) => {
    window.shellApi = { viewFile: vi.fn(async () => ({ ok: true, kind: 'markdown', text, size: text.length })) }
    const w = mount(FileViewer, { props: { file: 'C:\\p\\notes.md' }, attachTo: document.body })
    await flushPromises()
    return w
  }

  it('gates a file over 600 KB until "Render anyway"', async () => {
    const w = await open(doc(650 * KB))
    expect(w.find('[data-test="markdown-size-gate"]').attributes('data-state')).toBe('gate')
    expect(w.find('article.fview-md').exists()).toBe(false)
    await w.find('[data-test="markdown-render-anyway"]').trigger('click')
    await flushPromises()
    expect(w.find('article.fview-md h1').text()).toBe('Title')
    w.unmount()
  })

  it('shows a file over 1 MiB as its text, under a note', async () => {
    const spy = renderMarkdown
    const w = await open(doc(1200 * KB))
    expect(w.find('[data-test="markdown-size-gate"]').attributes('data-state')).toBe('too-large')
    expect(w.find('article.fview-md').exists()).toBe(false)
    expect(w.find('pre.fview-code').exists()).toBe(true)
    expect(w.find('[data-line="1"]').text()).toContain('# Title')
    expect(spy).not.toHaveBeenCalled()
    w.unmount()
  })
})
