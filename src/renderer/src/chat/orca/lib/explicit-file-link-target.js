// After Orca's explicit-file-link-target.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
import { parseFileLinkLocation } from '../shared/file-link-location.js'
import {
  joinAbsolutePath,
  normalizeAbsolutePath,
  resolveTildePath,
} from './terminal-path-normalization.js'

function canKeepTrailingSeparator(pathText) {
  // Why: bare roots ("/", "~/", "C:/") are ambiguous link targets, while
  // absolute/tilde paths with a real segment are unambiguous directories.
  if (/^[\\/]+$/.test(pathText) || /^~[\\/]$/.test(pathText) || /^[A-Za-z]:[\\/]$/.test(pathText)) {
    return false
  }
  return /^(?:~[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(pathText)
}

export function parseExplicitFileLinkTarget(value, options = {}) {
  const parsed = parseFileLinkLocation(value)
  if (!parsed) {
    return null
  }
  const { pathText, line, column } = parsed
  const hasLineOrColumn = line !== null || column !== null
  if (/^[\\/]\s/.test(pathText)) {
    return null
  }
  if (/[\\/]$/.test(pathText)) {
    const canKeepRelativeDirectory = options.allowRelativeDirectoryPath === true && !hasLineOrColumn
    if (hasLineOrColumn || (!canKeepRelativeDirectory && !canKeepTrailingSeparator(pathText))) {
      return null
    }
  }

  return { pathText, line, column }
}

export function resolveExplicitFileLinkTargetPath(pathText, cwd, homePath) {
  if (/^~[\\/]/.test(pathText)) {
    return resolveTildePath(pathText, cwd, homePath)
  }
  return normalizeAbsolutePath(pathText)?.normalized ?? joinAbsolutePath(cwd, pathText)
}

export function resolveExplicitFileLinkTarget(parsed, cwd, homePath) {
  const absolutePath = resolveExplicitFileLinkTargetPath(parsed.pathText, cwd, homePath)
  if (!absolutePath) {
    return null
  }

  return {
    absolutePath,
    line: parsed.line,
    column: parsed.column,
  }
}
