// Design Mode's list of annotations (after Orca's browser annotations, MIT,
// Copyright (c) 2026 Lovecast Inc.: src/renderer/src/components/browser-pane/
// annotate/use-browser-page-grab-annotations.ts, browser-page-annotation-tray.tsx).
// Pure logic, kept out of DesignModePanel.vue so it can be tested alone.
// An item is an element picked in the page with a comment, or a screenshot
// of the whole visible page:
//   { id, kind: 'element'|'screenshot', payload|null, comment, intent, screenshot: {path,width,height}|null }
// The functions change the array they get (a reactive one in the panel).
import { formatDesignFeedback, inlineText } from '../../../shared/browserContext'

export const MAX_ITEMS = 20
export const MAX_COMMENT = 2000
export const INTENTS = ['change', 'question']

let seq = 0
function newId() {
  seq += 1
  return `dm-${Date.now().toString(36)}-${seq}` // i18n-ignore
}

// The comment as stored: trimmed, at most MAX_COMMENT characters.
export function cleanComment(text) {
  return String(text == null ? '' : text).trim().slice(0, MAX_COMMENT)
}

export function cleanIntent(intent) {
  return INTENTS.includes(intent) ? intent : 'change'
}

export function canAdd(items) {
  return items.length < MAX_ITEMS
}

// A picked element: needs a comment (what the agent should do with it).
// -> { ok: true, item } | { ok: false, reason: 'full' | 'empty' | 'invalid' }
export function addElementItem(items, { payload, comment, intent, screenshot } = {}) {
  if (!payload || !payload.element) return { ok: false, reason: 'invalid' }
  if (!canAdd(items)) return { ok: false, reason: 'full' }
  const text = cleanComment(comment)
  if (!text) return { ok: false, reason: 'empty' }
  const item = {
    id: newId(),
    kind: 'element',
    payload,
    comment: text,
    intent: cleanIntent(intent),
    screenshot: screenshot && screenshot.path ? screenshot : null
  }
  items.push(item)
  return { ok: true, item }
}

// A screenshot of the page: the comment is optional (the image may say it all).
export function addScreenshotItem(items, screenshot, comment = '') {
  if (!screenshot || !screenshot.path) return { ok: false, reason: 'invalid' }
  if (!canAdd(items)) return { ok: false, reason: 'full' }
  const item = { id: newId(), kind: 'screenshot', payload: null, comment: cleanComment(comment), intent: 'change', screenshot }
  items.push(item)
  return { ok: true, item }
}

// Edit a comment and intent. An element keeps needing a comment.
export function updateItem(items, id, { comment, intent } = {}) {
  const item = items.find((i) => i.id === id)
  if (!item) return false
  const text = cleanComment(comment)
  if (!text && item.kind === 'element') return false
  item.comment = text
  item.intent = cleanIntent(intent)
  return true
}

export function removeItem(items, id) {
  const at = items.findIndex((i) => i.id === id)
  if (at < 0) return false
  items.splice(at, 1)
  return true
}

// After a send: only the items that went (new ones added meanwhile stay).
export function removeItems(items, ids) {
  const gone = new Set(ids)
  for (let i = items.length - 1; i >= 0; i--) if (gone.has(items[i].id)) items.splice(i, 1)
}

// What a row shows as its name: the element's accessible name, its text, or
// its tag. Page text, so shown as text only. null for a screenshot (the panel
// shows its own translated label).
export function itemName(item) {
  if (!item || item.kind !== 'element') return null
  return payloadName(item.payload)
}

export function payloadName(payload) {
  const el = (payload && payload.element) || {}
  const name = String(el.accessibleName || el.text || el.tag || '').replace(/\s+/g, ' ').trim()
  return name.length > 80 ? `${name.slice(0, 79)}…` : name
}

export function fileName(path) {
  return String(path || '').split(/[\\/]/).pop()
}

// The message for the agent (Markdown, English: it is read by the agent).
// Elements go through the shared formatter; page screenshots follow, numbered
// after them, as file paths the agent can open.
export function buildFeedbackMessage({ url, title, viewport, items }, format = formatDesignFeedback) {
  const elements = items.filter((i) => i.kind === 'element')
  const shots = items.filter((i) => i.kind === 'screenshot')
  const parts = []
  if (elements.length) {
    parts.push(
      format({
        url,
        title,
        viewport: viewport || lastViewport(elements),
        items: elements.map((i) => ({
          payload: i.payload,
          comment: i.comment,
          intent: i.intent,
          screenshot: i.screenshot ? i.screenshot.path : null
        }))
      })
    )
  } else if (shots.length) {
    const lines = [`## Design Feedback: ${inlineText(title) || inlineText(url)}`, ''] // i18n-ignore
    if (url) lines.push(`**URL:** ${inlineText(url)}`)
    if (title) lines.push(`**Title:** ${inlineText(title)}`) // i18n-ignore
    parts.push(lines.join('\n').trimEnd())
  }
  shots.forEach((s, n) => {
    const lines = [`### ${elements.length + n + 1}. Page screenshot`] // i18n-ignore
    lines.push(`Screenshot of the page: ${inlineText(s.screenshot.path)}`) // i18n-ignore
    if (s.comment) {
      lines.push(`**Intent:** ${s.intent === 'question' ? 'question' : 'change'}`) // i18n-ignore
      lines.push(`**Feedback:** ${inlineText(s.comment)}`) // i18n-ignore
    }
    parts.push(lines.join('\n'))
  })
  return parts.join('\n\n')
}

function lastViewport(elements) {
  for (let i = elements.length - 1; i >= 0; i--) {
    const v = elements[i].payload && elements[i].payload.viewport
    if (v) return v
  }
  return null
}
