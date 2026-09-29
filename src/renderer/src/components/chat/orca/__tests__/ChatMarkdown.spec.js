// After Orca's components/sidebar/CommentMarkdown.test.tsx and
// CommentMarkdown.link-click.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.),
// on ChatMarkdown (renderMarkdown + DOMPurify, vnodes). Class assertions use
// the port's class names (cm-*) where the reference checked Tailwind ones.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import {
  routeNativeChatHref,
  NATIVE_CHAT_FILE_HREF_PREFIX
} from '../../../../chat/orca/shared/native-chat-href-routing.js'

vi.mock('../../../../markdownView', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    renderMermaid: vi.fn(async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }))
  }
})

import ChatMarkdown from '../ChatMarkdown.vue'
import NativeChatCodeBlock from '../NativeChatCodeBlock.vue'
import { remarkGitHubReferences } from '../chat-markdown-render.js'

let wrapper = null
function render(props) {
  wrapper = mount(ChatMarkdown, {
    props,
    attachTo: document.body,
    global: { stubs: { transition: false } }
  })
  return wrapper.element
}
function click(element, init = {}) {
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, ...init })
  element.dispatchEvent(event)
  return event
}

let prevApi
beforeEach(() => {
  prevApi = window.shellApi
  window.shellApi = { writeClipboard: vi.fn() }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  window.shellApi = prevApi
  document.body.replaceChildren()
})

describe('ChatMarkdown (CommentMarkdown)', () => {
  it('marks compact headings so a parent can opt into block flow', () => {
    const root = render({ content: '## Walkthrough\n\nAdds verify:changed, which collects.' })
    const heading = root.querySelector('[role="heading"]')
    expect(heading.className).toContain('comment-md-h comment-md-h2')
    expect(heading.getAttribute('aria-level')).toBe('2')
    // Weight-only styling stays the compact default; block flow is opt-in.
    expect(heading.classList.contains('cm-bold')).toBe(true)
    expect(root.querySelector('.comment-md-p')).not.toBeNull()
  })

  it('marks adjacent compact paragraphs inside disclosure content', () => {
    const root = render({
      content:
        '<details><summary>More</summary>\n\nFirst paragraph.\n\nSecond paragraph.\n\n</details>'
    })
    const paragraphs = root.querySelectorAll('details .comment-md-p')
    expect(Array.from(paragraphs).map((p) => p.textContent)).toEqual([
      'First paragraph.',
      'Second paragraph.'
    ])
    expect(paragraphs[0].nextSibling.nodeValue).toBe('\n')
  })

  it('autolinks same-repo GitHub issue references when repo context is provided', () => {
    const root = render({
      variant: 'document',
      githubRepo: { owner: 'stablyai', repo: 'orca' },
      content: 'Automated fix-PR from pr-bug-scan for parent **#2316**.'
    })
    const link = root.querySelector('a[href="https://github.com/stablyai/orca/issues/2316"]')
    expect(link).not.toBeNull()
    expect(link.parentElement.tagName).toBe('STRONG')
  })

  it('autolinks cross-repo GitHub issue references', () => {
    const root = render({
      variant: 'document',
      githubRepo: { owner: 'stablyai', repo: 'orca' },
      content: 'See another-org/other-repo#42.'
    })
    expect(
      root.querySelector('a[href="https://github.com/another-org/other-repo/issues/42"]')
    ).not.toBeNull()
  })

  it('does not autolink GitHub issue references inside existing links or code', () => {
    const root = render({
      variant: 'document',
      githubRepo: { owner: 'stablyai', repo: 'orca' },
      content: '[`#2316`](https://example.com/already-linked) and `#2317`'
    })
    expect(root.querySelector('a[href="https://example.com/already-linked"]')).not.toBeNull()
    expect(root.querySelector('a[href="https://github.com/stablyai/orca/issues/2316"]')).toBeNull()
    expect(root.querySelector('a[href="https://github.com/stablyai/orca/issues/2317"]')).toBeNull()
  })

  // Tessel: a remote image is never fetched; renderMarkdown drops its URL, so
  // (unlike the reference, which kept it as a link) only its text stays.
  it('never loads a remote compact markdown image (its text stays)', () => {
    const root = render({ content: 'See this: ![Image #1](https://example.com/screenshot.png)' })
    expect(root.querySelector('img')).toBeNull()
    expect(root.innerHTML).not.toContain('example.com')
    expect(root.textContent).toContain('Image #1')
  })

  it('renders trusted compact markdown images inline', () => {
    const root = render({ content: 'See this: ![Image #1](data:image/png;base64,abc123)' })
    const img = root.querySelector('img')
    expect(img.getAttribute('alt')).toBe('Image #1')
    expect(img.getAttribute('src')).toBe('data:image/png;base64,abc123')
  })

  it('renders document markdown images with an expand control for the lightbox', () => {
    const root = render({
      variant: 'document',
      content: 'See this: ![ui.png](data:image/png;base64,abc123)'
    })
    expect(root.querySelector('img').getAttribute('src')).toBe('data:image/png;base64,abc123')
    const button = root.querySelector('button[aria-label="Expand image"]')
    expect(button.getAttribute('type')).toBe('button')
  })

  it('adds an expand control to compact images only when requested', () => {
    const plain = render({ content: 'See this: ![ui.png](data:image/png;base64,abc123)' })
    expect(plain.querySelector('button[aria-label="Expand image"]')).toBeNull()
    wrapper.unmount()
    const root = render({
      expandImages: true,
      content: 'See this: ![ui.png](data:image/png;base64,abc123)'
    })
    expect(root.querySelector('button[aria-label="Expand image"]')).not.toBeNull()
    expect(root.querySelector('img.is-compact')).not.toBeNull()
  })

  it('keeps non-attachment document links as links', () => {
    const url = 'https://github.com/stablyai/orca/pull/5265'
    const root = render({ variant: 'document', content: url })
    expect(root.querySelector('video')).toBeNull()
    expect(root.querySelector(`a[href="${url}"]`)).not.toBeNull()
  })

  it('autolinks very large generated GitHub reference comments', () => {
    const referenceCount = 130_000
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'text',
              value: Array.from({ length: referenceCount }, (_, index) => `#${index + 1}`).join(' ')
            }
          ]
        }
      ]
    }
    const transform = remarkGitHubReferences({ owner: 'stablyai', repo: 'orca' })()
    expect(() => transform(tree)).not.toThrow()
    expect(tree.children[0]?.children).toHaveLength(referenceCount * 2 - 1)
    expect(tree.children[0]?.children[0]).toMatchObject({
      type: 'link',
      url: 'https://github.com/stablyai/orca/issues/1'
    })
  })

  it('strips single-line and multi-line HTML comments', () => {
    const root = render({
      variant: 'document',
      content: 'before <!-- secret\nmulti-line\nnote --> after'
    })
    expect(root.innerHTML).not.toContain('secret')
    expect(root.innerHTML).not.toContain('multi-line')
    expect(root.textContent).toContain('before')
    expect(root.textContent).toContain('after')
  })

  it('renders <details>/<summary> as a disclosure section', () => {
    const root = render({
      variant: 'document',
      content: '<details><summary>Show more</summary>\n\nhidden body\n\n</details>'
    })
    expect(root.querySelector('details summary').textContent).toBe('Show more')
    expect(root.querySelector('details').textContent).toContain('hidden body')
  })

  it('renders markdown blockquotes', () => {
    const root = render({ variant: 'document', content: '> quoted text' })
    expect(root.querySelector('blockquote').textContent).toContain('quoted text')
  })

  it('renders raw HTML blockquotes', () => {
    const root = render({ variant: 'document', content: '<blockquote>html quote</blockquote>' })
    expect(root.querySelector('blockquote').textContent).toContain('html quote')
  })

  it('renders GFM tables', () => {
    const root = render({ variant: 'document', content: '| a | b |\n|---|---|\n| 1 | 2 |' })
    expect(root.querySelector('.cm-d-table-wrap > table')).not.toBeNull()
    expect(root.querySelector('th').textContent).toBe('a')
    expect(root.querySelector('td').textContent).toBe('1')
  })

  it('renders mermaid code fences as a mermaid container instead of a pre block', async () => {
    const root = render({ variant: 'document', content: '```mermaid\ngraph TD; A-->B;\n```' })
    expect(root.querySelector('.cm-d-mermaid .mermaid-block')).not.toBeNull()
    expect(root.querySelector('pre')).toBeNull()
    await flushPromises()
    // Drawn as an image of its (sanitized) SVG, never inline SVG.
    const img = root.querySelector('.mermaid-block img')
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(root.querySelector('svg')).toBeNull()
  })

  it('uses the supplied code-block renderer for fenced document markdown', () => {
    const root = render({
      variant: 'document',
      content: '```ts\nconst answer = 42\n```',
      renderCodeBlock: NativeChatCodeBlock
    })
    expect(root.querySelector('button[aria-label="Copy code"]')).not.toBeNull()
    expect(root.querySelector('[data-code-language="ts"]')).not.toBeNull()
    expect(root.textContent).toContain('const answer = 42')
  })

  it('does not invent a language label for a bare code fence', () => {
    const root = render({
      variant: 'document',
      content: '```\nconst answer = 42\n```',
      renderCodeBlock: NativeChatCodeBlock
    })
    expect(root.querySelector('button[aria-label="Copy code"]')).not.toBeNull()
    expect(root.querySelector('[data-code-language]')).toBeNull()
  })

  it('keeps compact mermaid fences as bounded source blocks', () => {
    const root = render({ content: '```mermaid\ngraph TD; A-->B;\n```' })
    expect(root.querySelector('pre.cm-c-pre').textContent).toContain('graph TD; A-->B;')
    expect(root.querySelector('.mermaid-block')).toBeNull()
  })

  it('renders headings as block elements with hierarchy in the document variant', () => {
    const root = render({ variant: 'document', content: '## Problem to solve\n\nSome body text.' })
    expect(root.querySelector('h2').textContent).toBe('Problem to solve')
  })

  it('flattens headings to inline text in the compact variant', () => {
    const root = render({ content: '## Problem to solve\n\nSome body text.' })
    expect(root.querySelector('h2')).toBeNull()
    expect(root.textContent).toContain('Problem to solve')
  })

  it('contains long PR body markdown inside its available width', () => {
    const root = render({
      variant: 'document',
      content: [
        '`src/main/hooks.ts:289 getEffectiveHookScript with policy=shared-only returns yamlScript?.trim() only; localScript is ignored`',
        '',
        '```',
        'const veryLongLine = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
        '```'
      ].join('\n')
    })
    expect(root.classList.contains('chat-md')).toBe(true)
    expect(root.querySelector('pre.cm-d-pre')).not.toBeNull()
  })

  it('turns single newlines into line breaks (remark-breaks), not a hard break twice', () => {
    const root = render({ variant: 'document', content: 'one\ntwo  \nthree' })
    const p = root.querySelector('p')
    expect(p.querySelectorAll('br')).toHaveLength(2)
    expect(p.textContent).toBe('onetwothree')
  })

  it('keeps list item text without a stray break before a nested list', () => {
    const root = render({ variant: 'document', content: '- item\n  - sub' })
    expect(root.querySelectorAll('br')).toHaveLength(0)
    expect(root.querySelector('li li').textContent).toBe('sub')
  })
})

describe('ChatMarkdown link click handler', () => {
  it('lets callers intercept rendered document links', () => {
    const onLinkClick = vi.fn((event) => event.preventDefault())
    const root = render({ variant: 'document', content: '[docs](docs/guide.md)', onLinkClick })
    const anchor = root.querySelector('a[href="docs/guide.md"]')
    expect(anchor).not.toBeNull()
    const event = click(anchor)
    expect(onLinkClick).toHaveBeenCalledWith(expect.any(Object), 'docs/guide.md')
    expect(event.defaultPrevented).toBe(true)
  })

  it('intercepts auxiliary clicks on generated native file links', () => {
    const onLinkClick = vi.fn((event) => event.preventDefault())
    const root = render({
      variant: 'document',
      content: 'Open src/foo.ts',
      onLinkClick,
      linkifyFilePaths: true
    })
    const anchor = root.querySelector('a')
    const event = new window.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    anchor.dispatchEvent(event)
    expect(onLinkClick).toHaveBeenCalledWith(expect.any(Object), expect.stringMatching(/^#orca-/))
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not activate generated native file links on right-click', () => {
    const onLinkClick = vi.fn()
    const root = render({
      variant: 'document',
      content: 'Open src/foo.ts',
      onLinkClick,
      linkifyFilePaths: true
    })
    const event = new window.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 })
    root.querySelector('a').dispatchEvent(event)
    expect(onLinkClick).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('sanitizes file URI links unless the caller opts in', () => {
    const root = render({
      variant: 'document',
      content: '[source](file:///repo/worktree/src/main.ts)'
    })
    expect(root.querySelector('a[href^="file:"]')).toBeNull()
  })

  it('sanitizes raw HTML file URI links unless the caller opts in', () => {
    const root = render({
      variant: 'document',
      content: '<a href="file:///repo/worktree/src/main.ts">source</a>'
    })
    const anchor = root.querySelector('a')
    expect(anchor).not.toBeNull()
    expect(anchor.getAttribute('href')).toBeNull()
  })

  // Tessel: renderMarkdown always drops file: link targets (markdown-it and
  // DOMPurify); with linkifyFilePaths the URI in the text still becomes a file link.
  it('opted-in callers get a plain-text file URI as a file link', () => {
    const onLinkClick = vi.fn()
    const root = render({
      variant: 'document',
      content: 'See file:///repo/worktree/src/main.ts',
      onLinkClick,
      allowFileUriLinks: true,
      linkifyFilePaths: true
    })
    const anchor = root.querySelector('a')
    expect(routeNativeChatHref(anchor.getAttribute('href'))).toMatchObject({
      kind: 'file',
      pathText: '/repo/worktree/src/main.ts'
    })
    const event = click(anchor)
    expect(onLinkClick).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
  })

  // Tessel: a local image is not loaded from the page; it is a link to the file.
  it('lets callers intercept rendered local document images', () => {
    const onLinkClick = vi.fn((event) => event.preventDefault())
    const root = render({
      variant: 'document',
      content: '![diagram](assets/diagram.png)',
      onLinkClick
    })
    expect(root.querySelector('img')).toBeNull()
    const anchor = root.querySelector('a[href="assets/diagram.png"]')
    expect(anchor.textContent).toBe('diagram')
    const event = click(anchor)
    expect(onLinkClick).toHaveBeenCalledWith(expect.any(Object), 'assets/diagram.png')
    expect(event.defaultPrevented).toBe(true)
  })

  it('lets callers intercept rendered in-page document images', () => {
    const onLinkClick = vi.fn()
    const root = render({
      variant: 'document',
      content: '![diagram](data:image/png;base64,abc123)',
      onLinkClick
    })
    click(root.querySelector('img[alt="diagram"]'))
    expect(onLinkClick).toHaveBeenCalledWith(expect.any(Object), 'data:image/png;base64,abc123')
  })

  it('linkifies bare POSIX and Windows document paths without an extension allowlist', () => {
    const root = render({
      variant: 'document',
      content: String.raw`Open /tmp/sta-6481-explainer.html, docs/review.docx, C:\Reports\final.pages, ./scripts/release, and src/release:12.`,
      onLinkClick: vi.fn(),
      linkifyFilePaths: true
    })
    const routes = Array.from(root.querySelectorAll('a')).map((anchor) =>
      routeNativeChatHref(anchor.getAttribute('href'))
    )
    expect(routes).toEqual([
      { kind: 'file', pathText: '/tmp/sta-6481-explainer.html', line: null },
      { kind: 'file', pathText: 'docs/review.docx', line: null },
      { kind: 'file', pathText: String.raw`C:\Reports\final.pages`, line: null },
      { kind: 'file', pathText: './scripts/release', line: null },
      { kind: 'file', pathText: 'src/release:12', line: null }
    ])
  })

  it('makes an inline-code file path clickable while preserving code styling', () => {
    const onLinkClick = vi.fn((event) => event.preventDefault())
    const root = render({
      variant: 'document',
      content: 'Open `C:\\Reports\\release.docx`.',
      onLinkClick,
      linkifyFilePaths: true
    })
    const code = root.querySelector('code')
    expect(code.classList.contains('cm-d-code')).toBe(true)
    const anchor = code.closest('a')
    expect(routeNativeChatHref(anchor.getAttribute('href'))).toEqual({
      kind: 'file',
      pathText: String.raw`C:\Reports\release.docx`,
      line: null
    })
    click(anchor)
    expect(onLinkClick).toHaveBeenCalledOnce()
  })

  it('leaves prose-shaped slash tokens and numeric versions unlinked', () => {
    const proseFalsePositives = ['and/or', 'TCP/IP', '24/7', 'N/A', 'km/h', 'A/B test']
    const inlineCodeFalsePositives = ['origin/main', 'v1.2.3', '1.0']
    const quotedFalsePositives = ['"and/or"', '"A/B test"']
    const root = render({
      variant: 'document',
      content: `${proseFalsePositives.join(', ')}; ${inlineCodeFalsePositives.map((value) => `\`${value}\``).join(', ')}; ${quotedFalsePositives.join(', ')}`,
      onLinkClick: vi.fn(),
      linkifyFilePaths: true
    })
    expect(root.querySelectorAll('a')).toHaveLength(0)
    for (const value of proseFalsePositives) expect(root.textContent).toContain(value)
    for (const value of quotedFalsePositives) expect(root.textContent).toContain(value)
    expect(Array.from(root.querySelectorAll('code')).map((code) => code.textContent)).toEqual(
      inlineCodeFalsePositives
    )
  })

  it('links each relative path separately when prose joins them', () => {
    const root = render({
      variant: 'document',
      content: 'Updated src/foo.ts and src/bar.ts, then docs/My Folder/notes.md.',
      onLinkClick: vi.fn(),
      linkifyFilePaths: true
    })
    expect(Array.from(root.querySelectorAll('a')).map((a) => a.textContent)).toEqual([
      'src/foo.ts',
      'src/bar.ts',
      'docs/My Folder/notes.md'
    ])
  })

  it('links quoted spaced-first-segment paths around apostrophes', () => {
    const root = render({
      variant: 'document',
      content: "Don't skip \"Brennan's Folder/notes.md\"; open 'My Folder/guide.md'.",
      onLinkClick: vi.fn(),
      linkifyFilePaths: true
    })
    const anchors = root.querySelectorAll('a')
    expect(Array.from(anchors).map((a) => a.textContent)).toEqual([
      "Brennan's Folder/notes.md",
      'My Folder/guide.md'
    ])
    expect(root.textContent).toBe(
      "Don't skip \"Brennan's Folder/notes.md\"; open 'My Folder/guide.md'."
    )
    expect(Array.from(anchors).map((a) => routeNativeChatHref(a.getAttribute('href')))).toEqual([
      { kind: 'file', pathText: "Brennan's Folder/notes.md", line: null },
      { kind: 'file', pathText: 'My Folder/guide.md', line: null }
    ])
  })

  it('links a spaced-first-segment relative path when inline code disambiguates it', () => {
    const root = render({
      variant: 'document',
      content: 'Open `My Folder/notes.md`.',
      onLinkClick: vi.fn(),
      linkifyFilePaths: true
    })
    const anchor = root.querySelector('a')
    expect(anchor.textContent).toBe('My Folder/notes.md')
    expect(routeNativeChatHref(anchor.getAttribute('href'))).toEqual({
      kind: 'file',
      pathText: 'My Folder/notes.md',
      line: null
    })
  })

  it('requires path shape before a spaced line suffix can make a link', () => {
    const root = render({
      variant: 'document',
      content: 'Keep `aspect 16:9` and "John 3:16" as references.',
      onLinkClick: vi.fn(),
      linkifyFilePaths: true
    })
    expect(root.querySelectorAll('a')).toHaveLength(0)
    expect(root.querySelector('code').textContent).toBe('aspect 16:9')
    expect(root.textContent).toContain('"John 3:16"')
  })

  it('preserves line suffixes on valid spaced path shapes, but not on bare file names', () => {
    const root = render({
      variant: 'document',
      content: 'Open "My Folder/notes:12", `My Notes.md:7`, and "C:\\My Folder\\notes.txt:12:3".',
      onLinkClick: vi.fn(),
      linkifyFilePaths: true
    })
    const anchors = Array.from(root.querySelectorAll('a'))
    expect(anchors.map((a) => a.textContent)).toEqual([
      'My Folder/notes:12',
      String.raw`C:\My Folder\notes.txt:12:3`
    ])
    expect(anchors.map((a) => routeNativeChatHref(a.getAttribute('href')))).toEqual([
      { kind: 'file', pathText: 'My Folder/notes:12', line: null },
      { kind: 'file', pathText: String.raw`C:\My Folder\notes.txt:12:3`, line: null }
    ])
  })

  it('links complete Unicode paths and extensions that begin with a digit', () => {
    const root = render({
      variant: 'document',
      content:
        'Open /tmp/报告.html, docs/报告/file.html, docs/café/report.pdf, and docs/archive.7z.',
      onLinkClick: vi.fn(),
      linkifyFilePaths: true
    })
    expect(Array.from(root.querySelectorAll('a')).map((a) => a.textContent)).toEqual([
      '/tmp/报告.html',
      'docs/报告/file.html',
      'docs/café/report.pdf',
      'docs/archive.7z'
    ])
  })

  it('never links an ASCII suffix inside a path containing an unsupported character', () => {
    const root = render({
      variant: 'document',
      content: 'Leave /tmp/$draft/report.html as one path or plain text.',
      onLinkClick: vi.fn(),
      linkifyFilePaths: true
    })
    expect(root.querySelectorAll('a')).toHaveLength(0)
    expect(root.textContent).toContain('/tmp/$draft/report.html')
  })

  it('links paths before common sentence punctuation', () => {
    const root = render({
      variant: 'document',
      content: 'Open src/foo.ts! Read docs/guide.md? View assets/report.pdf—then continue.',
      onLinkClick: vi.fn(),
      linkifyFilePaths: true
    })
    expect(Array.from(root.querySelectorAll('a')).map((a) => a.textContent)).toEqual([
      'src/foo.ts',
      'docs/guide.md',
      'assets/report.pdf'
    ])
  })

  it('links paths after CLI assignment and before Unicode sentence punctuation', () => {
    const root = render({
      variant: 'document',
      content: 'Run --config=./config.yaml。然后打开 docs/指南.md！再看 docs/报告.pdf？',
      onLinkClick: vi.fn(),
      linkifyFilePaths: true
    })
    expect(Array.from(root.querySelectorAll('a')).map((a) => a.textContent)).toEqual([
      './config.yaml',
      'docs/指南.md',
      'docs/报告.pdf'
    ])
  })

  it('does not link partial paths across unsupported punctuation', () => {
    const root = render({
      variant: 'document',
      content: 'Leave src/foo.ts!draft/file.html, src/foo.ts—draft/file.html.',
      onLinkClick: vi.fn(),
      linkifyFilePaths: true
    })
    expect(root.querySelectorAll('a')).toHaveLength(0)
  })

  it('prevents the default action for an unresolved internal file href', () => {
    const onLinkClick = vi.fn()
    const root = render({
      variant: 'document',
      content: 'Open ~/x',
      onLinkClick,
      linkifyFilePaths: true
    })
    const anchor = root.querySelector('a')
    expect(anchor.getAttribute('href')).toMatch(new RegExp(`^${NATIVE_CHAT_FILE_HREF_PREFIX}`))
    const event = click(anchor)
    expect(onLinkClick).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
  })

  // Tessel: a Windows drive target in a markdown link loses its href in
  // renderMarkdown (DOMPurify refuses "C:" as a scheme); fenced paths stay text.
  it('leaves fenced paths as source text and never keeps a Windows drive href', () => {
    const root = render({
      variant: 'document',
      content: [
        String.raw`[report](C:\Reports\summary.pdf)`,
        '',
        '```text',
        '/tmp/not-a-link.html',
        '```'
      ].join('\n'),
      onLinkClick: vi.fn(),
      linkifyFilePaths: true
    })
    expect(root.querySelectorAll('a[href]')).toHaveLength(0)
    expect(root.querySelector('pre').textContent).toContain('/tmp/not-a-link.html')
  })
})

describe('ChatMarkdown safety (Tessel)', () => {
  it('a javascript: link and raw <script> / <img onerror> in agent markdown are inert', () => {
    window.__ncPwned = undefined
    const onLinkClick = vi.fn()
    const root = render({
      variant: 'document',
      onLinkClick,
      content: [
        '[md link](javascript:window.__ncPwned=1)',
        '<a href="javascript:window.__ncPwned=2">raw link</a>',
        '<a href=" JaVaScRiPt:window.__ncPwned=3">spaced</a>',
        '<script>window.__ncPwned = 4</script>',
        '<img src="x" onerror="window.__ncPwned=5">',
        '<svg><script>window.__ncPwned=6</script></svg>',
        '<div style="position:fixed;inset:0" class="overlay" id="x" onclick="window.__ncPwned=7">styled</div>'
      ].join('\n\n')
    })
    expect(root.querySelector('script')).toBeNull()
    expect(root.querySelector('svg')).toBeNull()
    expect(root.querySelector('[onerror]')).toBeNull()
    expect(root.querySelector('[onclick]')).toBeNull()
    expect(root.querySelector('[style]')).toBeNull()
    expect(root.querySelector('.overlay')).toBeNull()
    expect(root.querySelector('#x')).toBeNull()
    for (const anchor of root.querySelectorAll('a')) {
      expect(String(anchor.getAttribute('href') ?? '')).not.toMatch(/script:/i)
      const event = click(anchor)
      expect(event.defaultPrevented).toBe(true)
    }
    for (const call of onLinkClick.mock.calls) expect(String(call[1] ?? '')).not.toMatch(/script:/i)
    expect(root.querySelector('img')).toBeNull()
    expect(window.__ncPwned).toBeUndefined()
    expect(root.textContent).toContain('styled')
  })

  it('without a click handler, a web link goes to the browser opener and never navigates', () => {
    const openExternal = vi.fn()
    window.shellApi = { openExternal }
    const root = render({
      variant: 'document',
      content: '[site](https://example.com/a) and [mail](mailto:a@b.c)'
    })
    const [web, mail] = root.querySelectorAll('a')
    const webEvent = click(web)
    expect(webEvent.defaultPrevented).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a', expect.any(Object))
    const mailEvent = click(mail)
    expect(mailEvent.defaultPrevented).toBe(true)
    expect(openExternal).toHaveBeenCalledOnce()
  })

  it('without a click handler, a file link goes to the file viewer (panelCtx.viewFile)', async () => {
    const viewFile = vi.fn()
    wrapper = mount(ChatMarkdown, {
      props: {
        variant: 'document',
        content: '[guide](docs/guide.md)',
        linkifyFilePaths: true,
        fileLinkContext: { worktreeId: 'w', worktreePath: '/repo' }
      },
      attachTo: document.body,
      global: { provide: { panelCtx: { viewFile } } }
    })
    const event = click(wrapper.element.querySelector('a'))
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(viewFile).toHaveBeenCalledWith(
      expect.objectContaining({ file: '/repo/docs/guide.md' }),
      expect.any(Object)
    )
  })
})
