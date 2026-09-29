// After Orca's comment-markdown-native-chat-file-links.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../chat/orca/shared/native-chat-href-routing.js'
import {
  formatFileLinkLocation,
  parseFileLinkLocation
} from '../../../chat/orca/shared/file-link-location.js'
import { extractTerminalFileLinks } from '../../../chat/orca/lib/terminal-links.js'

const ROOTED_PATH_PREFIX_PATTERN = /^(?:~[\\/]|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/

// Why: a link is underlined only when it names a path; a bare `name.md` resolves nowhere
// reliable, so underlining it promises a click that cannot open anything.
function isLinkifiableFile(link, isProse) {
  const hasRootedPrefix = ROOTED_PATH_PREFIX_PATTERN.test(link.pathText)
  const hasLineSuffix = link.line !== null || link.column !== null
  const hasAlphabeticExtension = /\.[\p{L}][\p{L}\p{N}\p{M}_+-]*$/u.test(link.pathText)
  const hasPathExtension = /\.[\p{L}\p{N}][\p{L}\p{N}\p{M}_+-]*$/u.test(link.pathText)
  return (
    /[\\/]/.test(link.pathText) &&
    (hasRootedPrefix || hasLineSuffix || (isProse ? hasPathExtension : hasAlphabeticExtension)) &&
    routeNativeChatHref(link.displayText).kind === 'file'
  )
}

const SAFE_LEADING_BOUNDARY_PATTERN = /[\s([{'",;=]/
const SAFE_TRAILING_BOUNDARY_PATTERN = /[\s)\]}>'",;.:。！？，、；：]/
const SENTENCE_PATH_PUNCTUATION_PATTERN =
  /\.[\p{L}\p{N}][\p{L}\p{N}\p{M}_+-]*([!?—。！？，、；：])/gu
const QUOTED_TEXT_PATTERN = /"([^"\r\n]+)"|'([^"'\r\n]+)'/gu
const MAX_DASHED_PROSE_WORD_LENGTH = 32

function hasBoundedProseAfterDash(value, startIndex) {
  const endIndex = Math.min(value.length, startIndex + MAX_DASHED_PROSE_WORD_LENGTH)
  for (let index = startIndex; index < endIndex; index += 1) {
    const char = value[index]
    if (!char || SAFE_TRAILING_BOUNDARY_PATTERN.test(char)) {
      return true
    }
    if (char === '/' || char === '\\') {
      return false
    }
  }
  return endIndex === value.length
}

function isSafeTrailingBoundary(value, endIndex) {
  const boundary = value[endIndex]
  if (boundary === undefined || SAFE_TRAILING_BOUNDARY_PATTERN.test(boundary)) {
    return true
  }
  if (boundary === '!' || boundary === '?') {
    const next = value[endIndex + 1]
    return next === undefined || SAFE_TRAILING_BOUNDARY_PATTERN.test(next)
  }
  if (boundary === '—') {
    return hasBoundedProseAfterDash(value, endIndex + 1)
  }
  return false
}

function hasPartialPathBoundary(value, link) {
  const before = value[link.startIndex - 1]
  return (
    (before !== undefined && !SAFE_LEADING_BOUNDARY_PATTERN.test(before)) ||
    !isSafeTrailingBoundary(value, link.endIndex)
  )
}

// Why: wrap the parsed location, not the display text; a `file://` URI must not reach the literal href.
function createFileLinkNode(link, child) {
  return {
    type: 'link',
    url: createNativeChatFileHref(formatFileLinkLocation(link)),
    children: [child]
  }
}

// Why: the terminal extractor spans "src/a.ts and src/b.ts" as one spaced path.
// An unrooted span holding a bare word or several linkable tokens is prose
// joining paths, so link the tokens on their own; a spaced folder name keeps
// every token path-shaped and stays one link.
function splitProseJoinedLinks(link) {
  if (ROOTED_PATH_PREFIX_PATTERN.test(link.pathText)) {
    return [link]
  }
  const tokens = Array.from(link.displayText.matchAll(/\S+/g))
  const tokenLinks = []
  for (const match of tokens) {
    const token = match[0]
    const exactLink = extractTerminalFileLinks(token).find(
      (candidate) => candidate.startIndex === 0 && candidate.endIndex === token.length
    )
    if (exactLink && isLinkifiableFile(exactLink, true)) {
      const startIndex = link.startIndex + (match.index ?? 0)
      tokenLinks.push({ ...exactLink, startIndex, endIndex: startIndex + token.length })
    }
  }
  const hasBareWord = tokens.some((match) => !/[\\/.]/.test(match[0]))
  return hasBareWord || tokenLinks.length > 1 ? tokenLinks : [link]
}

function splitTextSegment(value) {
  const links = extractTerminalFileLinks(value)
    .filter((link) => !hasPartialPathBoundary(value, link))
    .filter((link) => isLinkifiableFile(link, true))
    .flatMap(splitProseJoinedLinks)
  if (links.length === 0) {
    return [{ type: 'text', value }]
  }

  const children = []
  let cursor = 0
  for (const link of links) {
    if (link.startIndex < cursor) {
      continue
    }
    if (link.startIndex > cursor) {
      children.push({ type: 'text', value: value.slice(cursor, link.startIndex) })
    }
    children.push(createFileLinkNode(link, { type: 'text', value: link.displayText }))
    cursor = link.endIndex
  }
  if (cursor < value.length) {
    children.push({ type: 'text', value: value.slice(cursor) })
  }
  return children
}

function splitUnquotedText(value) {
  const children = []
  let cursor = 0
  for (const match of value.matchAll(SENTENCE_PATH_PUNCTUATION_PATTERN)) {
    const punctuationIndex = (match.index ?? 0) + match[0].length - 1
    if (!isSafeTrailingBoundary(value, punctuationIndex)) {
      continue
    }
    children.push(...splitTextSegment(value.slice(cursor, punctuationIndex)))
    children.push({ type: 'text', value: value[punctuationIndex] })
    cursor = punctuationIndex + 1
  }
  if (cursor === 0) {
    return splitTextSegment(value)
  }
  children.push(...splitTextSegment(value.slice(cursor)))
  return children
}

function exactFileLink(value, allowSpacedRelative) {
  const exactLink = extractTerminalFileLinks(value).find(
    (link) => link.startIndex === 0 && link.endIndex === value.length
  )
  if (exactLink && isLinkifiableFile(exactLink, false)) {
    return exactLink
  }
  if (!allowSpacedRelative || !/\s/.test(value)) {
    return null
  }
  const parsed = parseFileLinkLocation(value)
  if (!parsed) {
    return null
  }
  const looksLikePath =
    ROOTED_PATH_PREFIX_PATTERN.test(parsed.pathText) ||
    /[\\/]/.test(parsed.pathText) ||
    /\.[\p{L}][\p{L}\p{N}\p{M}_+-]*$/u.test(parsed.pathText)
  if (!looksLikePath) {
    return null
  }
  const explicitLink = {
    ...parsed,
    startIndex: 0,
    endIndex: value.length,
    displayText: value
  }
  return isLinkifiableFile(explicitLink, false) ? explicitLink : null
}

export function splitTextNode(value) {
  const children = []
  let cursor = 0
  for (const match of value.matchAll(QUOTED_TEXT_PATTERN)) {
    const content = match[1] ?? match[2]
    const link = content ? exactFileLink(content, true) : null
    if (!content || !link) {
      continue
    }
    const matchIndex = match.index ?? 0
    const quote = match[0][0]
    children.push(...splitUnquotedText(value.slice(cursor, matchIndex)))
    children.push({ type: 'text', value: quote })
    children.push(createFileLinkNode(link, { type: 'text', value: content }))
    children.push({ type: 'text', value: quote })
    cursor = matchIndex + match[0].length
  }
  if (cursor === 0) {
    return splitUnquotedText(value)
  }
  children.push(...splitUnquotedText(value.slice(cursor)))
  return children
}

export function inlineCodeFileLink(node) {
  const value = node.value?.trim()
  if (!value) {
    return null
  }
  const link = exactFileLink(value, true)
  return link ? createFileLinkNode(link, node) : null
}

function transformFileLinks(node) {
  if (node.type === 'link') {
    const route = routeNativeChatHref(node.url)
    if (route.kind === 'file') {
      // Why: the wrapped href carries literal location text, so URL syntax is resolved here, once.
      node.url = createNativeChatFileHref(formatFileLinkLocation(route))
    }
    return
  }
  if (!node.children || node.type === 'image') {
    return
  }

  const children = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      children.push(...splitTextNode(child.value))
      continue
    }
    if (child.type === 'inlineCode') {
      children.push(inlineCodeFileLink(child) ?? child)
      continue
    }
    transformFileLinks(child)
    children.push(child)
  }
  node.children = children
}

export function remarkNativeChatFileLinks() {
  return (tree) => transformFileLinks(tree)
}
