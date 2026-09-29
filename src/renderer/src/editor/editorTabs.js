// The tabs of an editor pane (like Orca's editor tabs), as plain data:
// files: [{ path, preview }] and the active path. A preview tab (a file
// opened with one click, shown in italic) is replaced by the next file opened
// that way, until it is edited or its tab double-clicked (then it stays).
// Pure: EditorPane.vue and App.vue apply the results.

// Windows paths: one file whatever the case or the slashes.
export function pathKey(p) {
  return String(p || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}
export const samePath = (a, b) => pathKey(a) === pathKey(b)

// A diff tab (after Orca's "diff" editor tabs, MIT, Copyright (c) 2026
// Lovecast Inc.): its own tab next to the file's, so its path is the file's
// with a suffix no real path can have (a NUL). Its tab entry carries
// diff: { root, rel, oldRel, area, full }.
export const DIFF_SEP = '\u0000'
export function diffTabPath(full, area, commit = null) {
  if (area === 'commit') return `${full}${DIFF_SEP}diff:commit:${String(commit || '')}` // i18n-ignore
  return `${full}${DIFF_SEP}diff:${area === 'staged' ? 'staged' : 'unstaged'}` // i18n-ignore
}
export const isDiffTabPath = (p) => String(p || '').includes(DIFF_SEP)
// The file a tab shows (a diff tab: its file on disk).
export function docPathOf(f) {
  if (!f) return null
  if (f.diff && f.diff.full) return f.diff.full
  const p = String(f.path || '')
  const i = p.indexOf(DIFF_SEP)
  return i >= 0 ? p.slice(0, i) : p
}

export function fileName(p) {
  const parts = String(p || '').split(/[\\/]/)
  return parts[parts.length - 1] || String(p || '')
}

// Open `path`. opts: { preview: a one-click open, previewTabs: the setting,
// isDirty(path): a tab with unsaved edits is never replaced }.
// -> { files, activePath, replaced: the preview tab it replaced, or null }
export function openTab(files, activePath, path, opts = {}) {
  const list = Array.isArray(files) ? files.map((f) => ({ ...f })) : []
  const preview = !!opts.preview && opts.previewTabs !== false
  const isDirty = opts.isDirty || (() => false)
  const found = list.find((f) => samePath(f.path, path))
  if (found) {
    if (!preview) found.preview = false
    return { files: list, activePath: found.path, replaced: null }
  }
  const tab = { path, preview }
  const previewIdx = preview ? list.findIndex((f) => f.preview && !isDirty(f.path)) : -1
  if (previewIdx >= 0) {
    const replaced = list[previewIdx].path
    list[previewIdx] = tab
    return { files: list, activePath: path, replaced }
  }
  // After the active tab, like VS Code; at the end when none is active.
  const at = list.findIndex((f) => samePath(f.path, activePath))
  if (at >= 0) list.splice(at + 1, 0, tab)
  else list.push(tab)
  return { files: list, activePath: path, replaced: null }
}

// Close `path`. -> { files, activePath } (the tab to the right becomes active,
// else the one to the left).
export function closeTab(files, activePath, path) {
  const list = Array.isArray(files) ? files.slice() : []
  const idx = list.findIndex((f) => samePath(f.path, path))
  if (idx < 0) return { files: list, activePath }
  list.splice(idx, 1)
  if (!samePath(activePath, path)) return { files: list, activePath }
  const next = list[idx] || list[idx - 1] || null
  return { files: list, activePath: next ? next.path : null }
}

// The tab stays (edited, or its tab double-clicked).
export function pinTab(files, path) {
  return (Array.isArray(files) ? files : []).map((f) => (samePath(f.path, path) && f.preview ? { ...f, preview: false } : f))
}

// The auto-save delay from settings, kept within 250 ms and 10 s (Orca's
// normalizeAutoSaveDelayMs).
export function autoSaveDelay(v, { min = 250, max = 10000, fallback = 1000 } = {}) {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  const ok = Number.isFinite(n) ? n : fallback
  return Math.min(max, Math.max(min, Math.round(ok)))
}

// Saved editor tabs from a layout: only well-formed absolute paths, no
// duplicates, at most 50.
export function validSavedFiles(files) {
  const out = []
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.path !== 'string' || f.path.length > 4000) continue
    if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(f.path)) continue
    if (isDiffTabPath(f.path)) continue // a diff tab is opened again from Changes
    if (out.some((o) => samePath(o.path, f.path))) continue
    out.push({ path: f.path, preview: f.preview === true })
    if (out.length >= 50) break
  }
  return out
}

// The smallest edit turning `before` into `after`: the text between their
// common start and common end. -> { start, endBefore, text } as offsets in
// `before`, or null when they are equal. (An external change is applied this
// way, so the cursor and scroll stay put when it is elsewhere in the file.)
export function minimalEdit(before, after) {
  if (before === after) return null
  const max = Math.min(before.length, after.length)
  let start = 0
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++
  let end = 0
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++
  // Never split a CRLF pair or a surrogate pair.
  while (start > 0 && (isLow(before.charCodeAt(start)) || (before[start - 1] === '\r' && before[start] === '\n'))) start--
  while (end > 0 && (isLow(before.charCodeAt(before.length - end)) || (before[before.length - end - 1] === '\r' && before[before.length - end] === '\n'))) end--
  return { start, endBefore: before.length - end, text: after.slice(start, after.length - end) }
}
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff

// The line ending most used in `text`: '\r\n' or '\n' (null when it has none).
export function mainEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length
  const lf = (text.match(/\n/g) || []).length - crlf
  if (!crlf && !lf) return null
  return crlf > lf ? '\r\n' : '\n'
}
