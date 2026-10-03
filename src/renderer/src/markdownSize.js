// How large a Markdown file may be before its rendered preview is held back
// (after Orca's markdown-rich-size-limit.ts and MarkdownPreviewSizeGate.tsx;
// MIT, Copyright (c) 2026 Lovecast Inc.). The whole document is built in one
// task: a 2 MB file froze the renderer for seconds and took gigabytes. Over
// 600 KB the preview waits for "Render anyway"; over 1 MiB it is never
// rendered, the file shows as its source instead.
export const MARKDOWN_PREVIEW_GATE_BYTES = 600 * 1024
export const MARKDOWN_PREVIEW_MAX_BYTES = 1024 * 1024

let encoder = null

// Whether the text is over `limit` bytes in UTF-8. A UTF-16 unit is 1 to 3
// bytes, so most sizes are known from the length alone.
export function overUtf8Bytes(text, limit) {
  const s = String(text || '')
  if (s.length > limit) return true
  if (s.length * 3 <= limit) return false
  encoder = encoder || new TextEncoder()
  return encoder.encode(s).length > limit
}

// -> 'render' | 'gate' (waits for "Render anyway") | 'too-large' (never).
// renderAnyway: the user asked to render a file over the gate.
export function markdownPreviewState(text, renderAnyway = false) {
  if (overUtf8Bytes(text, MARKDOWN_PREVIEW_MAX_BYTES)) return 'too-large'
  if (!renderAnyway && overUtf8Bytes(text, MARKDOWN_PREVIEW_GATE_BYTES)) return 'gate'
  return 'render'
}
