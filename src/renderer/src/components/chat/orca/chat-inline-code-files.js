// Tessel: inline code that names a file (`tessel-logo.mp4`, `src/main/index.js`,
// `C:\x\y.gif`) becomes a link when, and only when, the file (or folder)
// exists. Where it is looked for: the chat's folders and, for a bare name,
// the folders the same message names (a link or a path to .../video/). The
// main process says what exists (shellApi.chatFiles.stat: one bounded batch
// per message, cached); nothing is guessed, a plain word is never a link.
import { routeNativeChatHref, createNativeChatFileHref } from '../../../chat/orca/shared/native-chat-href-routing.js'
import { resolveExplicitFileLinkTargetPath } from '../../../chat/orca/lib/explicit-file-link-target.js'
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
export function candidatePaths(names, mentions, context) {
  const roots = (Array.isArray(context?.roots) && context.roots.length ? context.roots : [context?.worktreePath]).filter(
    (r) => typeof r === 'string' && r
  )
  const folders = mentionedFolders(mentions, context)
  const out = new Map()
  let total = 0
  for (const name of names) {
    const list = []
    const add = (p) => {
      if (!p || chatPathProblem(p) || list.includes(p) || total >= MAX_STAT_PER_MESSAGE) return
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

// -> Promise<Map(name -> absolute path)> of the inline code names that exist.
export function resolveInlineCodeFiles({ fragment, content, context, stat }) {
  if (!context?.worktreePath || context.remote || context.runtimeEnvironmentId || typeof stat !== 'function')
    return Promise.resolve(new Map())
  const { names, mentions } = collectInlineCodeFileCandidates(fragment, content)
  if (!names.length) return Promise.resolve(new Map())
  const roots = Array.isArray(context.roots) ? context.roots : []
  const key = `${context.worktreePath}\u0000${roots.join('\u0001')}\u0000${content}`
  if (cache.has(key)) return cache.get(key)
  const candidates = candidatePaths(names, mentions, context)
  const all = [...new Set([...candidates.values()].flat())]
  const job = (all.length ? Promise.resolve(stat(all)) : Promise.resolve({}))
    .then((kinds) => {
      const found = new Map()
      for (const [name, list] of candidates) {
        const hit = list.find((p) => kinds?.[p] === 'file' || kinds?.[p] === 'dir')
        if (hit) found.set(name, hit)
      }
      return found
    })
    .catch(() => {
      cache.delete(key)
      return new Map()
    })
  cache.set(key, job)
  if (cache.size > MAX_CACHED_MESSAGES) cache.delete(cache.keys().next().value)
  return job
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
