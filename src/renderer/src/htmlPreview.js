import DOMPurify from 'dompurify'

export function htmlPreview(text) {
  const clean = DOMPurify.sanitize(String(text || '').slice(0, 2 * 1024 * 1024), {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'base', 'meta', 'form', 'link'],
    FORBID_ATTR: ['srcdoc', 'srcset', 'action', 'formaction', 'autofocus']
  })
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  for (const a of doc.querySelectorAll('a[href]')) {
    a.dataset.tesselHref = a.getAttribute('href')
    a.setAttribute('href', '#')
    a.removeAttribute('target')
    a.removeAttribute('download')
  }
  for (const img of doc.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src')
    if (/^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(src)) continue
    img.dataset.localSrc = src
    img.removeAttribute('src')
  }
  const policy = doc.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"
  doc.head.prepend(policy)
  return '<!doctype html>' + doc.documentElement.outerHTML
}

export function htmlPlainText(text) {
  const doc = new DOMParser().parseFromString(htmlPreview(text), 'text/html')
  for (const node of doc.querySelectorAll('style, script, head')) node.remove()
  for (const node of doc.querySelectorAll('br')) node.replaceWith('\n')
  for (const node of doc.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, tr, section, article, pre')) node.append('\n')
  for (const node of doc.querySelectorAll('td, th')) node.append('\t')
  return (doc.body.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
