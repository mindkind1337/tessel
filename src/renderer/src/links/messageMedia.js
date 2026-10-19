// What a message shares, for the Conversations tab's type filter and its
// Media view (ConversationsPanel.vue, ConversationMedia.vue): its web links,
// images, videos, files, folders and code blocks.
//
// Found in its text the way the chat finds them (the chat's own path finder,
// comment-markdown-native-chat-file-links.js, and the link router's
// classifier, openTarget.js), plus the images and files a terminal line
// carries (terminalConversations.js attachImages: WP3's images contract).
//   link    a web page or a mail address (not a video, not an image)
//   image   an image the line holds, a data: image, an image file or address
//   video   YouTube, Vimeo or Twitch, or a video file or address (.mp4, .webm…)
//   file    a path to a file (a PDF too); a file a prompt held
//   folder  a path written with a trailing separator, or whose last part has
//           no extension (a rooted path: "C:\proj\src")
//   code    a fenced code block
//   commit  a commit hash in prose or inline code (commitRefs.js; it opens
//           only once its repository says it is a commit: CommitRef.vue)
// A message is read once per text (memoized): the threads are rebuilt often,
// the texts stay the same.
import { classifyTarget } from './openTarget.js'
import { splitTextNode } from '../components/chat/orca/comment-markdown-native-chat-file-links.js'
import { routeNativeChatHref } from '../chat/orca/shared/native-chat-href-routing.js'
import { parseFileLinkLocation } from '../chat/orca/shared/file-link-location.js'
import { extOf, fileKind } from '../../../shared/fileKinds.js'
import { findCommitRefs } from './commitRefs.js'

export const MEDIA_TYPES = Object.freeze(['link', 'image', 'video', 'file', 'folder', 'code', 'commit'])

const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv', 'wmv'])
const VIDEO_HOST = /(?:^|\.)(?:youtube\.com|youtu\.be|youtube-nocookie\.com|vimeo\.com|twitch\.tv)$/i
// A fenced block, closed or running to the end of the text.
const FENCE = /^ {0,3}(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)(?:\n {0,3}\1[^\n]*(?=\n|(?![\s\S]))|(?![\s\S]))/gm
const MD_IMAGE = /!\[([^\]\n]{0,200})\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\s*\)/g
const MD_LINK = /\[([^\]\n]{1,300})\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\s*\)/g
const BARE_URL = /\b(?:https?:\/\/|mailto:)[^\s<>"'`]+/gi
const MAX_TEXT = 20000
const MAX_ITEMS = 60

// A URL found in prose loses the punctuation that ends its sentence, and a
// closing bracket it does not open.
function trimUrl(raw) {
  let s = raw.replace(/[.,;:!?'"»]+$/, '')
  while (/[)\]}]$/.test(s)) {
    const close = s[s.length - 1]
    const open = close === ')' ? '(' : close === ']' ? '[' : '{'
    if (s.split(open).length >= s.split(close).length) break
    s = s.slice(0, -1).replace(/[.,;:!?]+$/, '')
  }
  return s
}

export function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

export function isVideoUrl(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  return VIDEO_HOST.test(u.hostname) || VIDEO_EXT.has(extOf(u.pathname))
}
export const isVideoPath = (path) => VIDEO_EXT.has(extOf(String(path || '').replace(/[\\/]+$/, '')))

const lastPart = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '')

// A path's type: video, image, folder or file.
export function pathType(path) {
  if (isVideoPath(path)) return 'video'
  if (/[\\/]$/.test(path)) return 'folder'
  if (fileKind(path) === 'image') return 'image'
  const name = lastPart(path)
  // A rooted path whose last part has no extension names a folder
  // ("C:\proj\src", "~/work/app"); a dotfile (".env") is a file.
  if (!/\.[^.\\/]+$/.test(name) && /^(?:[A-Za-z]:[\\/]|[\\/~])/.test(path)) return 'folder'
  return 'file'
}

// A web address's type: video, image or link (mailto: is a link).
function urlType(url) {
  if (/^mailto:/i.test(url)) return 'link'
  if (isVideoUrl(url)) return 'video'
  try {
    if (fileKind(new URL(url).pathname) === 'image') return 'image'
  } catch {
    return null
  }
  return 'link'
}

function urlItem(raw, title = '') {
  const url = trimUrl(raw.replace(/^<|>$/g, ''))
  const t = classifyTarget(url)
  if (!t || (t.kind !== 'url' && t.kind !== 'mailto')) return null
  const type = urlType(t.url)
  if (!type) return null
  const site = t.kind === 'mailto' ? '' : siteOf(t.url)
  return { type, id: `u:${t.url}`, url: t.url, site, title: title && title !== url ? title : '', label: title || site || t.url } // i18n-ignore
}

function pathItem(text, title = '') {
  const loc = parseFileLinkLocation(text)
  if (!loc || !loc.pathText) return null
  const type = pathType(loc.pathText)
  return { type, id: `p:${loc.pathText}`, path: loc.pathText, line: loc.line, col: loc.column, title, label: title || lastPart(loc.pathText) } // i18n-ignore
}

// The paths in prose, as the chat links them. A rooted path may hold spaces
// ("C:\Program Files\app\a.exe"); a span with a bare word in it ("C:\proj
// and ~/work/app") is prose between paths: each of its tokens on its own.
function pathsIn(text, add, depth = 0) {
  for (const node of splitTextNode(text)) {
    if (node.type !== 'link') continue
    const route = routeNativeChatHref(node.url)
    if (route.kind !== 'file') continue
    const tokens = route.pathText.split(/\s+/).filter(Boolean)
    if (depth === 0 && tokens.length > 1 && tokens.some((tok) => !/[\\/.]/.test(tok))) {
      for (const tok of tokens) if (/[\\/]/.test(tok)) pathsIn(tok, add, 1)
      continue
    }
    add(pathItem(route.pathText))
  }
}

// One text -> [items] (without the line's own images and files).
function scan(text) {
  const items = []
  const seen = new Set()
  const add = (item) => {
    if (!item || seen.has(item.id) || items.length >= MAX_ITEMS) return
    seen.add(item.id)
    items.push(item)
  }
  let rest = String(text || '').slice(0, MAX_TEXT)
  // Code blocks: one item each; a block holding only a path is that path
  // (the chat links it too), the rest of a block is not read for links.
  let n = 0
  rest = rest.replace(FENCE, (_m, _fence, info, body) => {
    const lines = String(body || '').split('\n')
    const first = lines.find((l) => l.trim()) || ''
    add({ type: 'code', id: `c:${n++}`, lang: String(info || '').trim().split(/\s+/)[0].slice(0, 24), preview: first.trim().slice(0, 120), lines: lines.length, label: first.trim().slice(0, 60) }) // i18n-ignore
    if (lines.filter((l) => l.trim()).length === 1) pathsIn(first.trim(), add)
    return '\n'
  })
  rest = rest.replace(MD_IMAGE, (_m, alt, target) => {
    const raw = target.replace(/^<|>$/g, '')
    if (/^data:image\//i.test(raw)) {
      const t = classifyTarget(raw)
      if (t && t.src) add({ type: 'image', id: `d:${raw.length}:${raw.slice(-24)}`, src: t.src, label: alt || 'image', title: alt }) // i18n-ignore
    } else if (/^(?:https?:|mailto:)/i.test(raw)) {
      const item = urlItem(raw, alt)
      if (item) add({ ...item, type: item.type === 'link' ? 'image' : item.type })
    } else add(pathItem(raw, alt))
    return ' '
  })
  rest = rest.replace(MD_LINK, (m, title, target) => {
    const raw = target.replace(/^<|>$/g, '')
    if (/^(?:https?:|mailto:)/i.test(raw)) add(urlItem(raw, title.trim()))
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) || /^[a-z]:[\\/]/i.test(raw) || /^file:/i.test(raw)) {
      const t = /^file:/i.test(raw) ? classifyTarget(raw) : null
      add(t ? (t.path ? pathItem(t.path, title.trim()) : null) : pathItem(raw, title.trim()))
    }
    return ` ${title} `
  })
  rest = rest.replace(BARE_URL, (raw) => {
    add(urlItem(raw))
    return ' '
  })
  // Inline code is read like prose (`src/a.js` is a path, as in the chat).
  const prose = rest.replace(/`([^`\n]+)`/g, ' $1 ')
  pathsIn(prose, add)
  for (const r of findCommitRefs(prose)) add({ type: 'commit', id: `h:${r.hash}`, hash: r.hash, label: r.hash }) // i18n-ignore
  return items
}

// The line's own images (WP3) and files: items too.
function heldItems(line) {
  const out = []
  ;(Array.isArray(line.images) ? line.images : []).forEach((img, i) => {
    if (!img || typeof img !== 'object') return
    const label = img.name || (img.path ? lastPart(img.path) : 'image') // i18n-ignore
    out.push({ type: 'image', id: `i:${img.key || img.path || i}`, image: img, label, held: true }) // i18n-ignore
  })
  ;(Array.isArray(line.files) ? line.files : []).forEach((f, i) => {
    if (!f || typeof f !== 'object') return
    const type = f.path ? pathType(f.path) : isVideoPath(f.name) ? 'video' : 'file'
    out.push({ type: type === 'folder' ? 'file' : type, id: `f:${f.path || f.name || i}`, path: f.path || null, label: f.name || lastPart(f.path), file: f, held: true }) // i18n-ignore
  })
  return out
}

const byText = new Map() // text -> items (the newest MEMO texts)
const MEMO = 3000
const byLine = new WeakMap() // line -> { types, items }
function textItems(text) {
  const key = String(text || '')
  const hit = byText.get(key)
  if (hit) {
    byText.delete(key)
    byText.set(key, hit)
    return hit
  }
  const items = scan(key)
  byText.set(key, items)
  if (byText.size > MEMO) byText.delete(byText.keys().next().value)
  return items
}

// -> { types: [type], items: [item] } of a line ({ text, images?, files? }).
export function mediaOf(line) {
  if (!line || typeof line !== 'object') return { types: [], items: [] }
  const memo = byLine.get(line)
  if (memo) return memo
  const held = heldItems(line)
  const items = held.length ? [...held, ...textItems(line.text).filter((x) => !held.some((h) => h.id === x.id))] : textItems(line.text)
  const types = MEDIA_TYPES.filter((type) => items.some((x) => x.type === type))
  const out = { types, items }
  byLine.set(line, out)
  return out
}

// The threads with only the lines holding one of `types` (any of them);
// every thread as it is when none is asked.
export function filterByTypes(threads, types) {
  const want = (Array.isArray(types) ? types : []).filter((x) => MEDIA_TYPES.includes(x))
  if (!want.length) return threads
  const out = []
  for (const thread of threads) {
    const lines = thread.lines.filter((l) => mediaOf(l).types.some((x) => want.includes(x)))
    if (lines.length) out.push({ ...thread, lines, count: lines.length })
  }
  return out
}

// How many messages hold each type: { link, image, video, file, folder, code, commit }.
export function typeCounts(threads) {
  const counts = Object.fromEntries(MEDIA_TYPES.map((x) => [x, 0]))
  for (const thread of threads || []) for (const line of thread.lines) for (const x of mediaOf(line).types) counts[x]++
  return counts
}

// Every item shared in the threads (of `types` when given), newest first:
// [{ ...item, key, line, thread }].
export function mediaItems(threads, types = []) {
  const want = (Array.isArray(types) ? types : []).filter((x) => MEDIA_TYPES.includes(x))
  const out = []
  for (const thread of threads || [])
    for (const line of thread.lines)
      for (const item of mediaOf(line).items) if (!want.length || want.includes(item.type)) out.push({ ...item, key: `${thread.key}|${line.key}|${item.id}`, line, thread }) // i18n-ignore
  return out.sort((a, b) => b.line.t - a.line.t)
}
