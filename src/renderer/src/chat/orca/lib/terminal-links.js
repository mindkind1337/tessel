// After Orca's terminal-links.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
import { normalizeAbsolutePath } from './terminal-path-normalization.js'
import { resolveExplicitFileLinkTarget } from './explicit-file-link-target.js'
import { detectBareFilenameLinks } from './terminal-bare-file-link-detection.js'
import {
  detectTerminalFileLinkRanges,
  insertTerminalFileLinkClaimedRange,
  mergeTerminalFileLinkRanges,
  terminalFileLinkRangesOverlap,
  toParsedTerminalFileLink
} from './terminal-file-link-detection-ranges.js'
import { detectTerminalFileUriLinks } from './terminal-file-uri-link.js'

// Ported from VSCode's terminal link detectors (MIT): local paths from
// `terminalLocalLinkDetector.ts`, bare words from `terminalWordLinkDetector.ts`.
// Two passes match VSCode's split: separator paths, plus conservative bare
// filename tokens that only become links if they resolve against the cwd.

// Matches a path with at least one `/` separator, optionally followed by
// `:line` and `:col` suffixes (e.g. `src/foo.ts:12:3`, `./bin`, `/abs/path`).
// Why: framework route files commonly use punctuation segments like
// `app/(shop)/products/[id]/page.tsx`; keep those links whole.
// Keep Japanese middle dots and tildes without admitting prose delimiters.
const LOCAL_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\p{L}\p{N}\p{M}._-]+[\\/])[\p{L}\p{N}\p{M}._~\-/%+@\\()[\]\u30FB\uFF65\u301C\uFF5E]*(?::\d+)?(?::\d+)?/gu

// Matches separator paths whose file or folder names include spaces. This runs
// before LOCAL_PATH_REGEX so `/Users/A/Foo Bar/file.ts` is claimed as one link
// instead of split into `/Users/A/Foo` and `Bar/file.ts`.
// Why this is intentionally broad: validating "space followed by a later
// separator" inside the regex creates overlapping whitespace backtracking on
// large ConPTY TUI lines. Keep the scan linear and filter candidates in code.
const SPACED_PATH_WITH_SEPARATOR_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
// Why this shares the broad candidate shape: extension paths with prose after
// them still need trimming, but the whitespace/extension test stays in code.
const SPACED_PATH_WITH_EXTENSION_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
// Why this is also broad: the candidates path runs on hover, including huge
// space-padded TUI lines, so reject line-ending spaced paths outside the regex.
const LINE_ENDING_SPACED_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
const SPACED_LOCAL_PATH_REGEXES = [
  SPACED_PATH_WITH_SEPARATOR_REGEX,
  SPACED_PATH_WITH_EXTENSION_REGEX,
  LINE_ENDING_SPACED_PATH_REGEX
]

const URI_PREFIX_CHAR_PATTERN = /^[A-Za-z0-9+./:-]$/

function hasPathSeparator(text) {
  return text.includes('/') || text.includes('\\')
}

function hasSeparatorAfterWhitespace(text) {
  let sawWhitespace = false
  for (const char of text) {
    if (/\s/.test(char)) {
      sawWhitespace = true
      continue
    }
    if (sawWhitespace && (char === '/' || char === '\\')) {
      return true
    }
  }
  return false
}

function hasInternalWhitespaceBeforeTrimmedEnd(text) {
  const trimmed = text.trimEnd()
  return /\s/.test(trimmed)
}

function isAtTrimmedLineEnd(lineText, endIndex) {
  return lineText.slice(endIndex).trim().length === 0
}

function hasSpacedPathExtension(text) {
  const trimmedRange = trimSpacedPathTrailingProse({
    text,
    startIndex: 0,
    endIndex: text.length
  })
  const trimmedText = trimmedRange.text.trimEnd()
  return /\s/.test(trimmedText) && /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?$/.test(trimmedText)
}

function getImmediateUriPrefix(lineText, endIndex) {
  let start = endIndex
  while (start > 0 && URI_PREFIX_CHAR_PATTERN.test(lineText[start - 1])) {
    start -= 1
  }
  return lineText.slice(start, endIndex)
}

function isInsideUriScheme(lineText, range) {
  const prefix = getImmediateUriPrefix(lineText, range.startIndex)
  // Why: local-path matching can start at the `//host/path` portion of a URL.
  return (
    range.text.includes('://') ||
    (/[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/)?$/.test(prefix) &&
      (prefix.endsWith('://') || range.text.startsWith('//')))
  )
}

function trimSpacedPathTrailingProse(range) {
  // Why: keep one extension-terminated path, but drop trailing prose or a
  // second unrelated path that the broad spaced-path scan also captured. A
  // line-end extension token only extends the span when the added segment is
  // path-like (contains a separator) — "v1.2 reports/result.json" extends,
  // prose like "failed to start app.py" must not be swallowed.
  let selected = null
  const extensionPrefixPattern = /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?(?=\s+|$)/g
  const pathStartPattern = /(?:^|\s)(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/g
  let pathStartCount = 0
  let nextPathStart = pathStartPattern.exec(range.text)
  let match
  while ((match = extensionPrefixPattern.exec(range.text)) !== null) {
    const end = match.index + match[0].length
    const text = range.text.slice(0, end)
    while (nextPathStart && nextPathStart.index + nextPathStart[0].length <= end) {
      pathStartCount += 1
      nextPathStart = pathStartPattern.exec(range.text)
    }
    if (pathStartCount > 1) {
      continue
    }
    if (
      end < range.text.length ||
      selected === null ||
      /[\\/]/.test(range.text.slice(selected.length, end))
    ) {
      selected = text
    }
  }
  if (!selected) {
    return range
  }
  return {
    text: selected,
    startIndex: range.startIndex,
    endIndex: range.startIndex + selected.length
  }
}

function trimTrailingWhitespace(range) {
  const text = range.text.trimEnd()
  return {
    text,
    startIndex: range.startIndex,
    endIndex: range.startIndex + text.length
  }
}

function buildLineEndingSpacedPathPrefixRanges(range) {
  const ranges = []
  for (const match of range.text.matchAll(/\s+/g)) {
    const endIndex = match.index ?? 0
    const text = range.text.slice(0, endIndex).trimEnd()
    if (text.includes(' ')) {
      ranges.push({
        text,
        startIndex: range.startIndex,
        endIndex: range.startIndex + text.length
      })
    }
  }
  return ranges.toReversed()
}

// Ported from VSCode's TerminalLocalLinkDetector. Extracts anything that
// contains a path separator, optionally with a `:line:col` suffix — covers
// `./src/foo.ts`, `/abs/bar`, `src/foo.ts:12:3`, etc.
function detectLocalPathLinks(lineText, includeLineEndingPrefixCandidates = false) {
  if (!hasPathSeparator(lineText)) {
    return []
  }

  const links = []
  const spacedLinks = detectSpacedLocalPathLinks(lineText, includeLineEndingPrefixCandidates)
  const spacedRanges = mergeTerminalFileLinkRanges(
    spacedLinks.map(({ startIndex, endIndex }) => [startIndex, endIndex])
  )
  for (const link of spacedLinks) {
    links.push(link)
  }
  for (const range of detectTerminalFileLinkRanges(lineText, LOCAL_PATH_REGEX)) {
    if (terminalFileLinkRangesOverlap(range, spacedRanges)) {
      continue
    }
    if (isInsideUriScheme(lineText, range)) {
      continue
    }
    if (!/[\\/]/.test(range.text)) {
      continue
    }
    const link = toParsedTerminalFileLink(range)
    if (link) {
      links.push(link)
    }
  }
  return links.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)
}

function detectSpacedLocalPathLinks(lineText, includeLineEndingPrefixCandidates = false) {
  const links = []
  const claimedRanges = []
  for (const regex of SPACED_LOCAL_PATH_REGEXES) {
    for (const range of detectTerminalFileLinkRanges(lineText, regex)) {
      if (regex === SPACED_PATH_WITH_SEPARATOR_REGEX && !hasSeparatorAfterWhitespace(range.text)) {
        continue
      }
      if (regex === SPACED_PATH_WITH_EXTENSION_REGEX && !hasSpacedPathExtension(range.text)) {
        continue
      }
      if (
        regex === LINE_ENDING_SPACED_PATH_REGEX &&
        (!hasInternalWhitespaceBeforeTrimmedEnd(range.text) ||
          !isAtTrimmedLineEnd(lineText, range.endIndex))
      ) {
        continue
      }
      if (
        terminalFileLinkRangesOverlap(range, claimedRanges) ||
        isInsideUriScheme(lineText, range)
      ) {
        continue
      }
      const candidateRanges =
        includeLineEndingPrefixCandidates && regex === LINE_ENDING_SPACED_PATH_REGEX
          ? [range, ...buildLineEndingSpacedPathPrefixRanges(range)]
          : [range]
      const candidateLinks = candidateRanges
        .map((candidateRange) =>
          toParsedTerminalFileLink(
            trimSpacedPathTrailingProse(trimTrailingWhitespace(candidateRange))
          )
        )
        .filter((link) => link !== null)
      const link = candidateLinks[0]
      if (link) {
        for (const candidateLink of candidateLinks) {
          links.push(candidateLink)
        }
        insertTerminalFileLinkClaimedRange(claimedRanges, [link.startIndex, link.endIndex])
      }
    }
  }
  return links
}

// Runs the file-uri, local-path, and bare-filename passes in that precedence.
// `file://` and separator paths claim their ranges first so the bare-filename
// pass never re-links a token already covered by a longer explicit link.
function assembleFileLinks(lineText, includeLineEndingPrefixCandidates) {
  const uriLinks = detectTerminalFileUriLinks(lineText)
  const pathLinks = detectLocalPathLinks(lineText, includeLineEndingPrefixCandidates)
  const explicitLinks = uriLinks.length > 0 ? [...uriLinks, ...pathLinks] : pathLinks
  const claimed = mergeTerminalFileLinkRanges(
    explicitLinks.map(({ startIndex, endIndex }) => [startIndex, endIndex])
  )
  const wordLinks = detectBareFilenameLinks(lineText, claimed)
  for (const link of wordLinks) {
    explicitLinks.push(link)
  }
  return explicitLinks
}

export function extractTerminalFileLinks(lineText) {
  return assembleFileLinks(lineText, false)
}

export function extractTerminalFileLinkCandidates(lineText) {
  return assembleFileLinks(lineText, true)
}

export function resolveTerminalFileLink(parsed, cwd, homePath) {
  return resolveExplicitFileLinkTarget(parsed, cwd, homePath)
}

export function resolveTerminalFileLinkText(linkText, cwd, homePath) {
  const links = extractTerminalFileLinks(linkText)
  const exactLink = links.find((link) => link.startIndex === 0 && link.endIndex === linkText.length)
  return exactLink ? resolveTerminalFileLink(exactLink, cwd, homePath) : null
}

export function isPathInsideWorktree(filePath, worktreePath) {
  const normalizedFile = normalizeAbsolutePath(filePath)
  const normalizedWorktree = normalizeAbsolutePath(worktreePath)
  if (
    !normalizedFile ||
    !normalizedWorktree ||
    normalizedFile.rootKind !== normalizedWorktree.rootKind
  ) {
    return false
  }
  if (normalizedFile.comparisonKey === normalizedWorktree.comparisonKey) {
    return true
  }
  return normalizedFile.comparisonKey.startsWith(`${normalizedWorktree.comparisonKey}/`)
}

export function toWorktreeRelativePath(filePath, worktreePath) {
  const normalizedFile = normalizeAbsolutePath(filePath)
  const normalizedWorktree = normalizeAbsolutePath(worktreePath)
  if (
    !normalizedFile ||
    !normalizedWorktree ||
    normalizedFile.rootKind !== normalizedWorktree.rootKind
  ) {
    return null
  }
  if (normalizedFile.comparisonKey === normalizedWorktree.comparisonKey) {
    return ''
  }
  if (!normalizedFile.comparisonKey.startsWith(`${normalizedWorktree.comparisonKey}/`)) {
    return null
  }
  return normalizedFile.normalized.slice(normalizedWorktree.normalized.length + 1)
}
