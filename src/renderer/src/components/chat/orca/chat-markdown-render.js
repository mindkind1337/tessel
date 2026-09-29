// After Orca's components/sidebar/CommentMarkdown.tsx and
// comment-markdown-element-renderers.tsx (MIT, Copyright (c) 2026 Lovecast Inc.).
//
// ChatMarkdown's pipeline. The reference runs react-markdown (remark-gfm,
// remark-breaks, rehype-sanitize) with per-element renderers. Tessel renders
// Markdown once, with markdownView.js renderMarkdown (markdown-it, then
// DOMPurify), and this module turns THAT sanitized output into Vue vnodes:
//   1. parse the sanitized HTML into an inert <template> fragment;
//   2. the reference's remark transforms, done on that DOM: file paths made
//      links (remarkNativeChatFileLinks), GitHub #refs (remarkGitHubReferences);
//   3. each element through the reference's renderer for its variant, with an
//      allowlist of tags and attributes (class, style, id, on*, … never pass),
//      single newlines as <br> (remark-breaks).
// Nothing is ever given to v-html: the vnodes carry text and allowlisted
// attributes only, on top of DOMPurify's output.
import { defineComponent, h, onMounted, ref, watch } from 'vue'
import { t } from '../../../i18n'
import { renderMermaid } from '../../../markdownView'
import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../chat/orca/shared/native-chat-href-routing.js'
import { formatFileLinkLocation } from '../../../chat/orca/shared/file-link-location.js'
import { inlineCodeFileLink, splitTextNode } from './comment-markdown-native-chat-file-links.js'
import ExpandableMarkdownImage from './ExpandableMarkdownImage.vue'

const TEXT_NODE = 3
const ELEMENT_NODE = 1

// --- GitHub references (CommentMarkdown.tsx) ----------------------------------

const GITHUB_REFERENCE_PATTERN = /(?:\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#([1-9][0-9]*)\b/g

function createGitHubIssueUrl(owner, repo, number) {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}` // i18n-ignore
}

function isEmbeddedGitHubReference(value, index) {
  if (index === 0) return false
  return /[A-Za-z0-9_./-]/.test(value[index - 1] ?? '')
}

function createGitHubReferenceLinkNode(label, owner, repo, number) {
  return {
    type: 'link',
    url: createGitHubIssueUrl(owner, repo, number),
    title: null,
    children: [{ type: 'text', value: label }]
  }
}

export function splitGitHubReferenceText(value, defaultRepo) {
  const parts = []
  let cursor = 0

  for (const match of value.matchAll(GITHUB_REFERENCE_PATTERN)) {
    const label = match[0]
    const index = match.index ?? 0
    if (isEmbeddedGitHubReference(value, index)) continue

    const owner = match[1] ?? defaultRepo.owner
    const repo = match[2] ?? defaultRepo.repo
    const number = match[3]
    if (!number) continue

    if (index > cursor) parts.push({ type: 'text', value: value.slice(cursor, index) })
    parts.push(createGitHubReferenceLinkNode(label, owner, repo, number))
    cursor = index + label.length
  }

  if (cursor === 0) return [{ type: 'text', value }]
  if (cursor < value.length) parts.push({ type: 'text', value: value.slice(cursor) })
  return parts
}

function transformGitHubReferenceChildren(node, defaultRepo) {
  if (!node.children || node.type === 'link' || node.type === 'image') return

  const nextChildren = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      // Why: generated agent comments can contain thousands of issue refs;
      // appending iteratively avoids V8's argument-list limit.
      for (const part of splitGitHubReferenceText(child.value, defaultRepo)) nextChildren.push(part)
    } else {
      transformGitHubReferenceChildren(child, defaultRepo)
      nextChildren.push(child)
    }
  }
  node.children = nextChildren
}

// The reference's remark plugin, kept for its tree shape (and its spec).
export function remarkGitHubReferences(defaultRepo) {
  return () => (tree) => transformGitHubReferenceChildren(tree, defaultRepo)
}

// --- Images -----------------------------------------------------------------------

export function isTrustedCompactImageSrc(src) {
  if (!src) return false
  const normalized = src.trim().toLowerCase()
  return (
    normalized.startsWith('blob:') || /^data:image\/(?:png|jpe?g|gif|webp);base64,/.test(normalized)
  )
}

// --- 1. Parse -------------------------------------------------------------------

export function parseSanitizedHtml(html) {
  const template = document.createElement('template')
  // Inert: nothing in a template's content runs or loads.
  template.innerHTML = html
  return template.content
}

// --- 2. Transforms on the sanitized DOM ------------------------------------------

function isMermaidPlaceholder(element) {
  return element.localName === 'div' && element.classList.contains('md-mermaid')
}

// Markdown nodes from the reference's remark helpers -> DOM nodes.
function markdownNodesToDom(doc, nodes) {
  return nodes.map((node) => {
    if (node.type === 'link') {
      const anchor = doc.createElement('a')
      anchor.setAttribute('href', node.url)
      for (const child of node.children ?? []) {
        anchor.appendChild(doc.createTextNode(child.value ?? ''))
      }
      return anchor
    }
    return doc.createTextNode(node.value ?? '')
  })
}

function replaceTextNode(textNode, split) {
  const value = textNode.nodeValue ?? ''
  // remark-breaks splits text at newlines before other plugins run: a link
  // never spans a line break.
  const segments = value.split(/(\n)/)
  const nodes = []
  let changed = false
  for (const segment of segments) {
    if (segment === '' || segment === '\n') {
      if (segment) nodes.push({ type: 'text', value: segment })
      continue
    }
    const parts = split(segment)
    if (parts.some((part) => part.type === 'link')) changed = true
    nodes.push(...parts)
  }
  if (!changed) return
  const doc = textNode.ownerDocument
  const replacement = markdownNodesToDom(doc, nodes)
  textNode.replaceWith(...replacement)
}

function transformTextNodes(root, split, { rewriteAnchor, inlineCode } = {}) {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      replaceTextNode(child, split)
      continue
    }
    if (child.nodeType !== ELEMENT_NODE) continue
    const tag = child.localName
    if (tag === 'a') {
      rewriteAnchor?.(child)
      continue
    }
    if (tag === 'pre' || tag === 'img' || isMermaidPlaceholder(child)) continue
    if (tag === 'code') {
      inlineCode?.(child)
      continue
    }
    transformTextNodes(child, split, { rewriteAnchor, inlineCode })
  }
}

// remarkNativeChatFileLinks on the DOM.
export function linkifyFilePaths(root) {
  transformTextNodes(root, splitTextNode, {
    rewriteAnchor(anchor) {
      const route = routeNativeChatHref(anchor.getAttribute('href'))
      if (route.kind === 'file') {
        // Why: the wrapped href carries literal location text, so URL syntax is resolved here, once.
        anchor.setAttribute('href', createNativeChatFileHref(formatFileLinkLocation(route)))
      }
    },
    inlineCode(code) {
      const link = inlineCodeFileLink({ type: 'inlineCode', value: code.textContent ?? '' })
      if (!link) return
      const anchor = code.ownerDocument.createElement('a')
      anchor.setAttribute('href', link.url)
      code.replaceWith(anchor)
      anchor.appendChild(code)
    }
  })
}

// remarkGitHubReferences on the DOM.
export function linkifyGitHubReferences(root, repo) {
  transformTextNodes(root, (value) => splitGitHubReferenceText(value, repo))
}

// --- 3. Vnodes ----------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul'
])

// Rendered as themselves, with no attribute (or the listed ones).
const PASSTHROUGH_TAGS = {
  abbr: ['title'],
  b: [],
  br: [],
  caption: [],
  cite: [],
  dd: [],
  del: [],
  details: ['open'],
  div: [],
  dl: [],
  dt: [],
  em: [],
  figcaption: [],
  figure: [],
  i: [],
  ins: [],
  kbd: [],
  mark: [],
  q: [],
  s: [],
  samp: [],
  small: [],
  span: [],
  strike: [],
  strong: [],
  sub: [],
  summary: [],
  sup: [],
  tbody: [],
  td: ['align', 'colspan', 'rowspan'],
  tfoot: [],
  th: ['align', 'colspan', 'rowspan', 'scope'],
  thead: [],
  tr: [],
  u: [],
  var: []
}

// Never rendered, not even their text.
const DROPPED_TAGS = new Set([
  'audio',
  'base',
  'button',
  'canvas',
  'embed',
  'form',
  'frame',
  'frameset',
  'head',
  'iframe',
  'input',
  'link',
  'math',
  'meta',
  'noscript',
  'object',
  'picture',
  'script',
  'select',
  'source',
  'style',
  'svg',
  'template',
  'textarea',
  'title',
  'track',
  'video'
])

const SAFE_ATTRIBUTE_VALUE = /^[^\0]*$/

function pickAttributes(element, names) {
  const attrs = {}
  for (const name of names) {
    const value = element.getAttribute(name)
    if (value !== null && SAFE_ATTRIBUTE_VALUE.test(value)) attrs[name] = value
  }
  return attrs
}

// Only what DOMPurify let through AND a scheme a link may carry.
function safeHref(href) {
  if (href == null) return undefined
  const trimmed = href.trim()
  if (!trimmed) return undefined
  if (/^(?:javascript|vbscript|data):/i.test(trimmed.replace(/[\s\0]/g, ''))) return undefined
  return href
}

function codeFenceLanguage(pre) {
  const code = pre.firstElementChild
  if (!code || code.localName !== 'code') return undefined
  return code.getAttribute('class')?.match(/(?:^|\s)language-([^\s]+)/)?.[1]
}

// remark-breaks: a single newline inside prose is a line break. Newlines that
// only separate blocks, and the one markdown-it writes after a hard <br>, are not.
function textWithBreaks(node) {
  const value = node.nodeValue ?? ''
  if (!value.includes('\n') || /^\s*$/.test(value)) return [value]
  const prev = node.previousSibling
  const next = node.nextSibling
  let text = value
  let lead = ''
  let tail = ''
  if (prev?.nodeName === 'BR') text = text.replace(/^\n/, '')
  const blockBefore = !prev || (prev.nodeType === ELEMENT_NODE && BLOCK_TAGS.has(prev.localName))
  const blockAfter = !next || (next.nodeType === ELEMENT_NODE && BLOCK_TAGS.has(next.localName))
  if (blockBefore) {
    lead = text.match(/^\s*/)[0]
    text = text.slice(lead.length)
  }
  if (blockAfter) {
    tail = text.match(/\s*$/)[0]
    text = text.slice(0, text.length - tail.length)
  }
  const out = lead ? [lead] : []
  text.split('\n').forEach((part, index) => {
    if (index > 0) out.push(h('br'))
    if (part) out.push(part)
  })
  if (tail) out.push(tail)
  return out
}

function renderChildren(node, ctx, state) {
  const out = []
  for (const child of Array.from(node.childNodes)) {
    const rendered = renderNode(child, ctx, state)
    if (Array.isArray(rendered)) out.push(...rendered)
    else if (rendered !== null && rendered !== undefined) out.push(rendered)
  }
  return out
}

function renderNode(node, ctx, state) {
  if (node.nodeType === TEXT_NODE) {
    return textWithBreaks(node)
  }
  if (node.nodeType !== ELEMENT_NODE) return null
  const element = node
  const tag = element.localName
  if (DROPPED_TAGS.has(tag)) return null
  const renderer = ctx.renderers[tag]
  if (tag === 'div' && isMermaidPlaceholder(element)) return ctx.renderers.mermaid(element, ctx)
  if (renderer) return renderer(element, ctx, state)
  const allowed = PASSTHROUGH_TAGS[tag]
  if (allowed) return h(tag, pickAttributes(element, allowed), renderChildren(element, ctx, state))
  // Anything else: its content, without the element.
  return renderChildren(element, ctx, state)
}

// --- Links -------------------------------------------------------------------------

function anchorHandlers(href, ctx) {
  return {
    onClick: (event) => ctx.onAnchorClick(event, href),
    onAuxclick: (event) => {
      if (event.button === 1) ctx.onAnchorClick(event, href)
    }
  }
}

function renderAnchor(element, ctx, state, className) {
  const href = safeHref(element.getAttribute('href'))
  return h(
    'a',
    {
      href,
      title: element.getAttribute('title') ?? undefined,
      target: '_blank',
      rel: 'noreferrer',
      class: className,
      ...anchorHandlers(href, ctx)
    },
    renderChildren(element, ctx, state)
  )
}

// --- Mermaid ------------------------------------------------------------------------

function mermaidSource(element) {
  try {
    return decodeURIComponent(element.getAttribute('data-mermaid') || '').trimEnd()
  } catch {
    return ''
  }
}

function pageIsDark() {
  try {
    const c = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)
    if (!c) return true
    const [r, g, b] = c.map(Number)
    return 0.299 * r + 0.587 * g + 0.114 * b < 128
  } catch {
    return true
  }
}

// The reference's CommentMermaidBlock. The diagram (renderMermaid: mermaid in
// strict mode, then DOMPurify) is shown as an <img> of its SVG: an image
// cannot run anything nor style the page, even if a diagram carried CSS.
export const ChatMarkdownMermaid = defineComponent({
  name: 'ChatMarkdownMermaid',
  props: { content: { type: String, required: true } },
  setup(props) {
    const svgUrl = ref(null)
    const failed = ref(false)
    let run = 0
    function draw() {
      const current = ++run
      svgUrl.value = null
      failed.value = false
      renderMermaid(props.content, { dark: pageIsDark() }).then((result) => {
        if (current !== run) return
        if (result?.svg) {
          svgUrl.value = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}` // i18n-ignore
        } else failed.value = true
      })
    }
    onMounted(draw)
    watch(() => props.content, draw)
    return () =>
      h('div', { class: 'mermaid-block' }, [
        svgUrl.value
          ? h('img', {
              class: 'mermaid-block-img',
              src: svgUrl.value,
              alt: t('chat.orca.markdown.diagram', 'Diagram')
            })
          : failed.value
            ? h('pre', null, h('code', null, props.content))
            : null
      ])
  }
})

// --- Renderers per variant -----------------------------------------------------------

function inlineCode(element, ctx, state, className) {
  return h('code', { class: className }, renderChildren(element, ctx, state))
}

function preCode(element, ctx) {
  const code = element.firstElementChild?.localName === 'code' ? element.firstElementChild : element
  return h('code', null, code.textContent ?? '')
}

function headingRenderer(level, className) {
  return (element, ctx, state) =>
    h(`h${level}`, { class: className }, renderChildren(element, ctx, state))
}

function compactHeading(level, weightClass) {
  return (element, ctx, state) =>
    h(
      'span',
      {
        class: ['comment-md-h', level <= 3 ? `comment-md-h${level}` : null, weightClass], // i18n-ignore
        role: 'heading',
        'aria-level': level
      },
      renderChildren(element, ctx, state)
    )
}

function tableRenderer(wrapperClass, tableClass) {
  return (element, ctx, state) =>
    h('div', { class: wrapperClass }, [
      h('table', { class: tableClass }, renderChildren(element, ctx, state))
    ])
}

function list(tag, className) {
  return (element, ctx, state) =>
    h(
      tag,
      { class: className, ...pickAttributes(element, tag === 'ol' ? ['start'] : []) },
      renderChildren(element, ctx, state)
    )
}

export function createCompactRenderers() {
  return {
    // Strip <p> wrappers to avoid double margins in the tight card layout.
    p: (element, ctx, state) =>
      h('span', { class: 'comment-md-p' }, renderChildren(element, ctx, state)),
    a: (element, ctx, state) => renderAnchor(element, ctx, state, 'cm-c-link'),
    code: (element, ctx, state) => inlineCode(element, ctx, state, 'cm-c-code'),
    // Compact pre blocks — no syntax highlighting needed for short comments.
    pre: (element, ctx) => h('pre', { class: 'cm-c-pre' }, [preCode(element, ctx)]),
    // Why: compact comment previews live in dense cards; keep diagram fences as
    // bounded source blocks so async SVG renders do not reshape the list.
    mermaid: (element) =>
      h('pre', { class: 'cm-c-pre' }, [h('code', null, mermaidSource(element))]),
    ul: list('ul', 'cm-c-ul'),
    ol: list('ol', 'cm-c-ol'),
    li: (element, ctx, state) => h('li', { class: 'cm-c-li' }, renderChildren(element, ctx, state)),
    h1: compactHeading(1, 'cm-bold'),
    h2: compactHeading(2, 'cm-bold'),
    h3: compactHeading(3, 'cm-semibold'),
    h4: compactHeading(4, 'cm-semibold'),
    h5: compactHeading(5, 'cm-semibold'),
    h6: compactHeading(6, 'cm-semibold'),
    hr: () => h('hr', { class: 'cm-c-hr' }),
    blockquote: (element, ctx, state) =>
      h('blockquote', { class: 'cm-c-blockquote' }, renderChildren(element, ctx, state)),
    // Why: agent replies often carry screenshot markdown like "Image #1"; only
    // app-managed images show inline, a remote URL is never fetched.
    img: (element, ctx) => {
      const alt = element.getAttribute('alt') ?? ''
      const src = element.getAttribute('src') ?? undefined
      const localSrc = element.getAttribute('data-local-src') ?? undefined
      if (!isTrustedCompactImageSrc(src)) {
        if (!localSrc) return alt ? h('span', null, alt) : null
        const href = safeHref(localSrc)
        return h(
          'a',
          {
            href,
            target: '_blank',
            rel: 'noreferrer',
            class: 'cm-c-link',
            ...anchorHandlers(href, ctx)
          },
          alt || localSrc
        )
      }
      if (ctx.expandImages) {
        return h(ExpandableMarkdownImage, { src, alt, variant: 'compact' })
      }
      return h(
        'a',
        { href: src, target: '_blank', rel: 'noreferrer', ...anchorHandlers(src, ctx) },
        [h('img', { src, alt, class: 'cm-c-img' })]
      )
    },
    // Why: GFM tables in a narrow column would overflow; the wrapper scrolls.
    table: tableRenderer('cm-c-table-wrap', 'cm-c-table')
  }
}

export function createDocumentRenderers() {
  return {
    p: (element, ctx, state) => h('p', { class: 'cm-d-p' }, renderChildren(element, ctx, state)),
    a: (element, ctx, state) => renderAnchor(element, ctx, state, 'cm-d-link'),
    code: (element, ctx, state) => inlineCode(element, ctx, state, 'cm-d-code'),
    pre: (element, ctx) => {
      const language = codeFenceLanguage(element)
      const code = preCode(element, ctx)
      if (ctx.renderCodeBlock) {
        return h(ctx.renderCodeBlock, { language }, { default: () => [code] })
      }
      return h('pre', { class: 'cm-d-pre' }, [code])
    },
    mermaid: (element) =>
      h('div', { class: 'cm-d-mermaid' }, [
        h(ChatMarkdownMermaid, { content: mermaidSource(element) })
      ]),
    ul: list('ul', 'cm-d-ul'),
    ol: list('ol', 'cm-d-ol'),
    li: (element, ctx, state) => h('li', { class: 'cm-d-li' }, renderChildren(element, ctx, state)),
    h1: headingRenderer(1, 'cm-d-h1'),
    h2: headingRenderer(2, 'cm-d-h2'),
    h3: headingRenderer(3, 'cm-d-h3'),
    h4: headingRenderer(4, 'cm-d-h4'),
    h5: headingRenderer(5, 'cm-d-h4'),
    h6: headingRenderer(6, 'cm-d-h4'),
    hr: () => h('hr', { class: 'cm-d-hr' }),
    blockquote: (element, ctx, state) =>
      h('blockquote', { class: 'cm-d-blockquote' }, renderChildren(element, ctx, state)),
    img: (element, ctx) => {
      const alt = element.getAttribute('alt') ?? ''
      const src = element.getAttribute('src') ?? undefined
      const localSrc = element.getAttribute('data-local-src') ?? undefined
      if (!isTrustedCompactImageSrc(src)) {
        // Tessel: a local image is a link to it (the viewer opens it); a
        // remote one is never fetched, its text stays.
        if (localSrc) {
          const href = safeHref(localSrc)
          return h(
            'a',
            {
              href,
              target: '_blank',
              rel: 'noreferrer',
              class: 'cm-d-link',
              ...anchorHandlers(href, ctx)
            },
            alt || localSrc
          )
        }
        return alt ? h('span', null, alt) : null
      }
      if (ctx.hasLinkClick) {
        return h('img', {
          src,
          alt,
          class: 'cm-d-img is-clickable',
          onClick: (event) => {
            event.stopPropagation()
            ctx.onImageClick(event, src)
          }
        })
      }
      return h(ExpandableMarkdownImage, { src, alt, variant: 'document' })
    },
    // Why: agents' answers commonly contain GFM tables; wide ones scroll.
    table: tableRenderer('cm-d-table-wrap', 'cm-d-table')
  }
}

export function renderMarkdownFragment(fragment, ctx) {
  const out = renderChildren(fragment, ctx, {})
  // markdown-it ends every block with a newline; the last one is not content.
  while (out.length > 0 && typeof out[out.length - 1] === 'string' && !out[out.length - 1].trim()) {
    out.pop()
  }
  return out
}
