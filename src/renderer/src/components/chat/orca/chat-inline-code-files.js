// Tessel: inline code that names a file (`tessel-logo.mp4`, `src/main/index.js`,
// `C:\x\y.gif`) becomes a link when, and only when, the file (or folder)
// exists. Where it is looked for: the chat's folders and, for a bare name,
// the folders the same message names (a link or a path to .../video/). The
// main process says what exists (shellApi.chatFiles.stat: one bounded batch
// per message, cached); nothing is guessed, a plain word is never a link.
import { routeNativeChatHref, createNativeChatFileHref } from '../../../chat/orca/shared/native-chat-href-routing.js'
import {
  parseExplicitFileLinkTarget,
  resolveExplicitFileLinkTargetPath
} from '../../../chat/orca/lib/explicit-file-link-target.js'
import { chatPathExt, chatPathProblem } from '../../../../../shared/chatFileLinks.js'

export const MAX_STAT_PER_MESSAGE = 64
const MAX_CACHED_MESSAGES = 200

const ELEMENT_NODE = 1
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|~[\\/]|\/(?![\\/]))/
const SEPARATOR = /[\\/]/
// An extension with a letter in it: `a.mp4`, `notes.md`, never `1.2` nor `...`.
const EXTENSION = /[^\\/.]\.[A-Za-z0-9_-]*[A-Za-z][A-Za-z0-9_-]{0,11}$/

// Inline code text that could name a file: an extension or a path separator,
// no URL, no control character, nothing a file name cannot hold.
export function looksLikeFileName(raw) {
  const value = String(raw ?? '').trim()
  if (!value || value.length > 260) return false
  if (/[\u0000-\u001f\u007f<>|"*?`]/.test(value)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('-')) return false
  if (/^[\\/]{2}/.test(value)) return false
  const hasSeparator = SEPARATOR.test(value)
  if (!hasSeparator) {
    // A bare name: one token, like a file name (not `fn(a, b)` nor `a = b`).
    if (/[\s(),;=]/.test(value)) return false
    return EXTENSION.test(value)
  }
  return EXTENSION.test(value) || /[\\/]$/.test(value)
}

function insideAnchorOrPre(element) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.localName === 'a' || node.localName === 'pre') return true
  }
  return false
}

function inlineCodes(root) {
  return Array.from(root.querySelectorAll ? root.querySelectorAll('code') : []).filter(
    (code) => !insideAnchorOrPre(code)
  )
}

const ABSOLUTE_IN_TEXT = /(?:[A-Za-z]:[\\/]|~[\\/])[^\s`'"<>|*?()[\]]+/g

// What a message offers: the inline code names to look for, and the paths it
// mentions (links, inline code with a separator, absolute paths in the text).
export function collectInlineCodeFileCandidates(fragment, content = '') {
  const names = []
  const mentions = []
  for (const code of inlineCodes(fragment)) {
    const value = (code.textContent ?? '').trim()
    if (!looksLikeFileName(value)) continue
    if (!names.includes(value)) names.push(value)
    if (SEPARATOR.test(value)) mentions.push(value)
  }
  for (const anchor of Array.from(fragment.querySelectorAll ? fragment.querySelectorAll('a[href]') : [])) {
    const route = routeNativeChatHref(anchor.getAttribute('href'))
    if (route.kind === 'file' && route.pathText) mentions.push(route.pathText)
  }
  for (const match of String(content).matchAll(ABSOLUTE_IN_TEXT)) mentions.push(match[0].replace(/[.,;:!]+$/, ''))
  return { names, mentions: [...new Set(mentions)] }
}

function resolveIn(base, pathText, homePath) {
  try {
    return resolveExplicitFileLinkTargetPath(pathText, base, homePath) || null
  } catch {
    return null
  }
}

function parentOf(p) {
  const trimmed = p.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut > 0 ? trimmed.slice(0, cut) : null
}

// The folders a message names: a path ending with a separator or without an
// extension is a folder; a file's folder is its parent.
function mentionedFolders(mentions, context) {
  const out = []
  for (const mention of mentions) {
    const text = mention.replace(/:\d+(?::\d+)?$/, '')
    const full = resolveIn(context.worktreePath, text, context.homePath)
    if (!full || chatPathProblem(full)) continue
    const folder = /[\\/]$/.test(text) || !chatPathExt(text) ? full.replace(/[\\/]+$/, '') : parentOf(full)
    if (folder && !out.includes(folder)) out.push(folder)
  }
  return out
}

// name -> the absolute paths to try, best first.
export function candidatePaths(names, mentions, context, limit = MAX_STAT_PER_MESSAGE) {
  const roots = (Array.isArray(context?.roots) && context.roots.length ? context.roots : [context?.worktreePath]).filter(
    (r) => typeof r === 'string' && r
  )
  const folders = mentionedFolders(mentions, context)
  const out = new Map()
  let total = 0
  for (const name of names) {
    const list = []
    const add = (p) => {
      if (!p || chatPathProblem(p) || list.includes(p) || total >= limit) return
      list.push(p)
      total++
    }
    if (ABSOLUTE.test(name)) add(resolveIn(context.worktreePath, name, context.homePath))
    else {
      for (const root of roots) add(resolveIn(root, name, context.homePath))
      if (!SEPARATOR.test(name)) for (const folder of folders) add(resolveIn(folder, name, context.homePath))
    }
    if (list.length) out.set(name, list)
  }
  return out
}

const cache = new Map() // key -> Promise<Map(name -> absolute path)>

export function clearInlineCodeFileCache() {
  cache.clear()
}

// Tessel: plain-text paths in a message that does not link them on sight (the
// user's, a teammate's): the prose linkifier marks what it would link, and
// only what exists stays a link (applyCheckedLinks).
export const GATED_ATTR = 'data-tessel-gated'

const TEXT_NODE = 3

function textBefore(node) {
  const prev = node.previousSibling
  return prev && prev.nodeType === TEXT_NODE ? prev.nodeValue ?? '' : ''
}
function textAfter(node) {
  const next = node.nextSibling
  return next && next.nodeType === TEXT_NODE ? next.nodeValue ?? '' : ''
}

// Plain text is never a link when the linkifier only caught part of a path
// (the tail of \\server\share\x, after a separator), nor a path with spaces
// that is not quoted (inline code is its own quote).
function plainTextSlip(anchor) {
  const isCode = anchor.childNodes.length === 1 && anchor.firstChild.nodeType === ELEMENT_NODE && anchor.firstChild.localName === 'code'
  if (isCode) return false
  if (/[\\/:]$/.test(textBefore(anchor))) return true
  if (/\s/.test(anchor.textContent ?? '')) {
    const open = textBefore(anchor).slice(-1)
    const close = textAfter(anchor).slice(0, 1)
    return !((open === '"' || open === "'") && close === open)
  }
  return false
}

export function markGatedLinks(fragment, linkify) {
  const before = new Set(Array.from(fragment.querySelectorAll('a')))
  linkify(fragment)
  for (const anchor of Array.from(fragment.querySelectorAll('a'))) {
    if (before.has(anchor)) continue
    if (plainTextSlip(anchor)) anchor.replaceWith(...Array.from(anchor.childNodes))
    else anchor.setAttribute(GATED_ATTR, '')
  }
  return fragment
}

function gatedAnchors(root) {
  return Array.from(root.querySelectorAll ? root.querySelectorAll(`a[${GATED_ATTR}]`) : [])
}

export function hasGatedLinks(fragment) {
  return gatedAnchors(fragment).length > 0
}

// href of a gated link -> the absolute paths to try, best first, with its location.
function gatedCandidates(fragment, context, roots, budget) {
  const out = new Map()
  for (const anchor of gatedAnchors(fragment)) {
    const href = anchor.getAttribute('href')
    if (!href || out.has(href)) continue
    const route = routeNativeChatHref(href)
    if (route.kind !== 'file') continue
    const parsed = parseExplicitFileLinkTarget(route.pathText, { allowRelativeDirectoryPath: true })
    if (!parsed || chatPathProblem(parsed.pathText, { requireAbsolute: false })) continue
    // "\server\share" is a UNC path Markdown ate a backslash of, or a
    // drive-relative one: neither is looked up.
    if (/^\\/.test(parsed.pathText)) continue
    const list = []
    const add = (p) => {
      if (!p || chatPathProblem(p) || list.includes(p) || budget.left <= 0) return
      list.push(p)
      budget.left--
    }
    if (ABSOLUTE.test(parsed.pathText)) add(resolveIn(context.worktreePath, parsed.pathText, context.homePath))
    else for (const root of roots) add(resolveIn(root, parsed.pathText, context.homePath))
    if (list.length) out.set(href, { list, line: parsed.line ?? route.line ?? null, column: parsed.column ?? null })
  }
  return out
}

function locationHref(path, line, column) {
  return createNativeChatFileHref(line ? `${path}:${line}${column ? `:${column}` : ''}` : path)
}

// -> Promise<Map(name -> absolute path)> of the inline code names that exist;
// its .links: Map(href of a gated link -> href of the file that exists).
// One stat batch (at most 64 paths) per message, cached.
export function resolveInlineCodeFiles({ fragment, content, context, stat }) {
  const none = () => Object.assign(new Map(), { links: new Map() })
  if (!context?.worktreePath || context.remote || context.runtimeEnvironmentId || typeof stat !== 'function')
    return Promise.resolve(none())
  const { names, mentions } = collectInlineCodeFileCandidates(fragment, content)
  if (!names.length && !hasGatedLinks(fragment)) return Promise.resolve(none())
  const roots = (Array.isArray(context.roots) && context.roots.length ? context.roots : [context.worktreePath]).filter(
    (r) => typeof r === 'string' && r
  )
  const key = `${context.worktreePath}\u0000${roots.join('\u0001')}\u0000${hasGatedLinks(fragment) ? 'g' : ''}\u0000${content}`
  if (cache.has(key)) return cache.get(key)
  const budget = { left: MAX_STAT_PER_MESSAGE }
  const gated = gatedCandidates(fragment, context, roots, budget)
  const used = MAX_STAT_PER_MESSAGE - budget.left
  const candidates = candidatePaths(names, mentions, context, MAX_STAT_PER_MESSAGE - used)
  const all = [...new Set([...[...gated.values()].map((g) => g.list), ...candidates.values()].flat())]
  const job = (all.length ? Promise.resolve(stat(all)) : Promise.resolve({}))
    .then((kinds) => {
      const exists = (p) => kinds?.[p] === 'file' || kinds?.[p] === 'dir'
      const found = none()
      for (const [name, list] of candidates) {
        const hit = list.find(exists)
        if (hit) found.set(name, hit)
      }
      for (const [href, g] of gated) {
        const hit = g.list.find(exists)
        if (hit) found.links.set(href, locationHref(hit, g.line, g.column))
      }
      return found
    })
    .catch(() => {
      cache.delete(key)
      return none()
    })
  cache.set(key, job)
  if (cache.size > MAX_CACHED_MESSAGES) cache.delete(cache.keys().next().value)
  return job
}

// Gated links: the ones that exist point at the file found; the others go
// back to plain text (until, or unless, the lookup says they exist).
export function applyCheckedLinks(fragment, found) {
  for (const anchor of gatedAnchors(fragment)) {
    const next = found?.links?.get(anchor.getAttribute('href'))
    if (next) {
      anchor.setAttribute('href', next)
      anchor.removeAttribute(GATED_ATTR)
    } else anchor.replaceWith(...Array.from(anchor.childNodes))
  }
  return fragment
}

// Wraps each resolved inline code in a file link (the same href as any other
// file link: the click goes through the same checks).
export function applyInlineCodeFileLinks(fragment, found) {
  if (!found?.size) return fragment
  for (const code of inlineCodes(fragment)) {
    const hit = found.get((code.textContent ?? '').trim())
    if (!hit) continue
    const anchor = code.ownerDocument.createElement('a')
    anchor.setAttribute('href', createNativeChatFileHref(hit))
    code.replaceWith(anchor)
    anchor.appendChild(code)
  }
  return fragment
}
