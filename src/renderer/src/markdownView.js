// Markdown for the file viewer: markdown-it, then DOMPurify (raw HTML in the
// file is allowed, but only what DOMPurify keeps). ```mermaid blocks become
// placeholders drawn afterwards (renderMermaid); local images are read
// through Tessel (the page may only show data: images).
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({ html: true, linkify: true, typographer: false })

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

const defaultFence = md.renderer.rules.fence
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const lang = (token.info || '').trim().split(/\s+/)[0].toLowerCase()
  // Encoded: DOMPurify drops an attribute holding "-->" (a comment trick).
  if (lang === 'mermaid')
    return `<div class="md-mermaid" data-mermaid="${escapeAttr(encodeURIComponent(token.content))}"></div>\n` // i18n-ignore
  return defaultFence(tokens, idx, options, env, self)
}

// Images: a local path is kept aside (data-local-src) and read by the viewer;
// remote ones cannot load in Tessel (only their text shows).
function onElement(node) {
  if (node.nodeName === 'IMG') {
    const src = node.getAttribute('src') || ''
    if (!/^data:image\//i.test(src)) {
      node.removeAttribute('src')
      if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src)) node.setAttribute('data-local-src', src)
      else if (/^file:/i.test(src)) node.setAttribute('data-local-src', src)
    }
  }
  // Links open outside (http) or in Tessel (a relative file): never here.
  if (node.nodeName === 'A' && node.hasAttribute('href')) node.setAttribute('rel', 'noreferrer')
}

// { untrusted: true }: text Tessel did not open itself (an agent's chat
// answer): no style or class attributes either, so it cannot be positioned
// or styled over Tessel's own interface.
export function renderMarkdown(text, { untrusted = false } = {}) {
  const html = md.render(String(text || ''))
  DOMPurify.addHook('afterSanitizeAttributes', onElement)
  try {
    return DOMPurify.sanitize(html, {
      ADD_ATTR: ['data-mermaid', 'data-local-src'],
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
      ...(untrusted ? { FORBID_ATTR: ['style', 'class'] } : {})
    })
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
}

// --- Mermaid ------------------------------------------------------------------
// Loaded only when a diagram is shown; one render at a time (mermaid keeps
// global state). Its SVG is sanitized again before it goes in the page.
let mermaidReady = null
let queue = Promise.resolve()
let counter = 0

function loadMermaid(dark) {
  if (!mermaidReady) mermaidReady = import('mermaid').then((m) => m.default)
  return mermaidReady.then((mermaid) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      // HTML labels need <foreignObject>, which the sanitizer removes.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      suppressErrorRendering: true
    })
    return mermaid
  })
}

// -> { svg } | { error }
export function renderMermaid(source, { dark = true } = {}) {
  const run = queue.then(async () => {
    try {
      const mermaid = await loadMermaid(dark)
      const { svg } = await mermaid.render(`tessel-mmd-${++counter}`, String(source || '')) // i18n-ignore
      return { svg: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }) }
    } catch (err) {
      return { error: (err && err.message) || String(err) }
    }
  })
  queue = run.catch(() => {})
  return run
}
