// After Orca's browser grab/annotate output (MIT, Copyright (c) 2026 Lovecast Inc.):
// src/renderer/src/components/browser-pane/annotate/browser-annotation-output.ts,
// GrabConfirmationSheet.tsx (formatGrabPayloadAsText)
//
// Turns a Design Mode pick (the payload of src/main/browserPicker.js) into
// text for a coding agent. The text is pasted into a terminal, so every
// page-derived string is cleaned of control characters, and it stays English
// on purpose: it is read by the agent, not shown in the interface.

export const INLINE_TEXT_MAX = 2048

// C0 controls except \t and \n, DEL, C1 controls (0x9b is a CSI on some
// terminals) and bidi overrides/isolates that could disguise text.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g

function asText (value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function num (value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// Multi-line text (HTML): line breaks kept as \n, other controls removed.
export function stripControls (value) {
  return asText(value).replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '')
}

function isInlineWhitespaceCode (code) {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}

// One line: whitespace runs collapsed to a space (scanning only what is
// kept, page text can be paste-sized), then controls removed.
export function inlineText (value, maxLength = INLINE_TEXT_MAX) {
  const content = asText(value)
  let normalized = ''
  let pendingSpace = false
  for (let index = 0; index < content.length && normalized.length < maxLength;) {
    const code = content.charCodeAt(index)
    if (isInlineWhitespaceCode(code)) {
      pendingSpace = normalized.length > 0
      index += 1
      continue
    }
    const codePoint = content.codePointAt(index)
    if (codePoint === undefined) break
    const char = String.fromCodePoint(codePoint)
    const extraSpaceLength = pendingSpace ? 1 : 0
    if (normalized.length + extraSpaceLength + char.length > maxLength) break
    if (pendingSpace) {
      normalized += ' '
      pendingSpace = false
    }
    normalized += char
    index += char.length
  }
  return normalized.replace(CONTROL_CHARS, '')
}

// Longest backtick run, counted without spreading huge strings.
function maxBacktickRunLength (content, floor) {
  let maxRun = floor
  let currentRun = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 96) {
      currentRun = 0
      continue
    }
    currentRun += 1
    if (currentRun > maxRun) maxRun = currentRun
  }
  return maxRun
}

// A fence longer than any backtick run inside, so page HTML cannot close it.
export function fence (language, content) {
  const marker = '`'.repeat(maxBacktickRunLength(content, 3) + 1)
  return [`${marker}${language}`, content, marker]
}

function inlineCode (value) {
  const content = inlineText(value)
  const marker = '`'.repeat(maxBacktickRunLength(content, 0) + 1)
  const padding = content.startsWith('`') || content.endsWith('`') ? ' ' : ''
  return `${marker}${padding}${content}${padding}${marker}`
}

function elementOf (payload) {
  return payload && typeof payload === 'object' && payload.element && typeof payload.element === 'object'
    ? payload.element
    : null
}

function listOf (value) {
  return Array.isArray(value) ? value : []
}

// ---------------------------------------------------------------------------
// One element (Orca's Grab text)
// ---------------------------------------------------------------------------

export function formatElementContext (payload) {
  const el = elementOf(payload)
  if (!el) return ''
  const lines = []

  lines.push(`Attached browser context from ${inlineText(payload.url)}`) // i18n-ignore agent text
  lines.push('')

  lines.push('Selected element:') // i18n-ignore agent text
  lines.push(inlineText(el.tag))
  if (el.accessibleName) lines.push(`Accessible name: "${inlineText(el.accessibleName)}"`) // i18n-ignore agent text
  if (el.role) lines.push(`Role: ${inlineText(el.role)}`)
  lines.push(`Selector: ${inlineText(el.selector)}`)
  if (el.source) lines.push(`Source: ${inlineText(el.source)}`)
  if (el.react) lines.push(`React: ${inlineText(el.react)}`)
  const rect = el.rect || {}
  lines.push(`Dimensions: ${Math.round(num(rect.width))}x${Math.round(num(rect.height))}`)
  lines.push('')

  const text = inlineText(el.text)
  if (text) {
    lines.push('Text content:') // i18n-ignore agent text
    lines.push(text)
    lines.push('')
  }

  const nearby = listOf(el.nearbyText).map((t) => inlineText(t)).filter(Boolean)
  if (nearby.length > 0) {
    lines.push('Nearby context:') // i18n-ignore agent text
    for (const t of nearby) lines.push(`- ${t}`)
    lines.push('')
  }

  const styles = el.styles || {}
  const style = (key) => inlineText(styles[key])
  const styleLines = []
  if (style('display') && style('display') !== 'inline') styleLines.push(`display: ${style('display')}`)
  if (style('position') && style('position') !== 'static') styleLines.push(`position: ${style('position')}`)
  if (style('fontSize')) styleLines.push(`font-size: ${style('fontSize')}`)
  if (style('color')) styleLines.push(`color: ${style('color')}`)
  if (style('backgroundColor') && style('backgroundColor') !== 'rgba(0, 0, 0, 0)') {
    styleLines.push(`background: ${style('backgroundColor')}`)
  }
  if (styleLines.length > 0) {
    lines.push('Computed styles:') // i18n-ignore agent text
    for (const sl of styleLines) lines.push(`  ${sl}`)
    lines.push('')
  }

  const html = stripControls(el.html)
  if (html) {
    lines.push('HTML:')
    lines.push(html)
    lines.push('')
  }

  const ancestors = listOf(el.ancestors).map((a) => inlineText(a)).filter(Boolean)
  if (ancestors.length > 0) lines.push(`Ancestor path: ${ancestors.join(' > ')}`) // i18n-ignore agent text
  if (el.fullPath) lines.push(`Full DOM path: ${inlineText(el.fullPath)}`) // i18n-ignore agent text

  return lines.join('\n').trimEnd()
}

// ---------------------------------------------------------------------------
// Several annotated elements (Orca's Design Feedback markdown)
// ---------------------------------------------------------------------------

function pageHeading (url) {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`
  } catch {
    return url || 'current page'
  }
}

function elementLabel (el) {
  const react = inlineText(el.react)
  const tag = inlineText(el.tag)
  const name = inlineText(el.accessibleName)
  const text = inlineText(el.text)
  const base = name
    ? `${tag} "${name}"`
    : text
      ? `${tag} "${text.slice(0, 60)}"`
      : tag
  return react ? `${react} ${base}` : base
}

function formatStyles (styles) {
  const s = styles && typeof styles === 'object' ? styles : {}
  const entries = [
    ['display', s.display],
    ['position', s.position],
    ['width', s.width],
    ['height', s.height],
    ['margin', s.margin],
    ['padding', s.padding],
    ['color', s.color],
    ['background', s.backgroundColor],
    ['border', s.border],
    ['border-radius', s.borderRadius],
    ['font-family', s.fontFamily],
    ['font-size', s.fontSize],
    ['font-weight', s.fontWeight],
    ['line-height', s.lineHeight],
    ['text-align', s.textAlign],
    ['z-index', s.zIndex]
  ]
  const lines = []
  for (const [name, raw] of entries) {
    const value = inlineText(raw)
    if (!value || value === 'auto' || value === 'normal') continue
    if (name === 'position' && value === 'static') continue
    if (name === 'display' && value === 'inline') continue
    if (name === 'background' && value === 'rgba(0, 0, 0, 0)') continue
    lines.push(`- ${name}: ${value}`)
  }
  return lines
}

// items: [{ payload, comment, intent: 'change' | 'question', screenshot: path | null }]
export function formatDesignFeedback ({ url, title, viewport, items } = {}) {
  const list = listOf(items).filter((item) => item && elementOf(item.payload))
  if (list.length === 0) return ''

  const first = list[0].payload
  const pageUrl = inlineText(url || first.url)
  const vp = viewport && typeof viewport === 'object' ? viewport : first.viewport || {}
  const pageTitle = inlineText(title)
  const lines = [`## Design Feedback: ${pageHeading(pageUrl)}`, ''] // i18n-ignore agent text
  if (pageUrl) lines.push(`**URL:** ${pageUrl}`)
  if (pageTitle) lines.push(`**Title:** ${pageTitle}`)
  lines.push(`**Viewport:** ${Math.round(num(vp.width))}x${Math.round(num(vp.height))}`)
  lines.push('')

  list.forEach((item, index) => {
    const el = elementOf(item.payload)
    const rect = el.rect || {}
    const intent = item.intent === 'question' ? 'question' : 'change'

    lines.push(`### ${index + 1}. ${elementLabel(el)}`)
    lines.push(`**Intent:** ${intent}`)
    lines.push(`**Selector:** ${inlineCode(el.selector)}`)
    if (el.path) lines.push(`**Location:** ${inlineCode(el.path)}`)
    if (el.source) lines.push(`**Source:** ${inlineText(el.source)}`)
    if (el.react) lines.push(`**React:** ${inlineText(el.react)}`)
    lines.push(
      `**Bounds:** x=${Math.round(num(rect.x))}, y=${Math.round(num(rect.y))}, ${Math.round(num(rect.width))}x${Math.round(num(rect.height))}`
    )
    if (el.classes) lines.push(`**Classes:** ${inlineCode(el.classes)}`)
    const selected = inlineText(el.selectedText)
    const text = inlineText(el.text)
    if (selected) lines.push(`**Selected text:** "${selected}"`) // i18n-ignore agent text
    else if (text) lines.push(`**Text:** "${text}"`)
    const nearby = listOf(el.nearbyText).map((t) => inlineText(t)).filter(Boolean)
    if (nearby.length > 0) {
      lines.push('**Nearby text:**') // i18n-ignore agent text
      for (const t of nearby) lines.push(`- ${t}`)
    }
    const styleLines = formatStyles(el.styles)
    if (styleLines.length > 0) {
      lines.push('**Computed styles:**') // i18n-ignore agent text
      lines.push(...styleLines)
    }
    if (el.fullPath) lines.push(`**Full DOM path:** ${inlineCode(el.fullPath)}`) // i18n-ignore agent text
    const html = stripControls(el.html)
    if (html) {
      lines.push('**HTML:**')
      lines.push(...fence('html', html))
    }
    // Tessel: the agent can open the element's screenshot from this path.
    const shot = inlineText(item.screenshot)
    if (shot) lines.push(`**Screenshot:** ${shot}`)
    lines.push(`**Feedback:** ${inlineText(item.comment)}`)
    lines.push('')
  })

  return lines.join('\n').trimEnd()
}
