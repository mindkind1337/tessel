// After Orca's terminal-file-url-target.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
import { fileUriToFilesystemPath } from './file-uri-path.js'

function parseFileUrlLineHash(hash) {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash
  const match = /^L(\d+)(?:C(\d+))?$/i.exec(trimmed)
  if (!match) {
    return null
  }
  return {
    line: Number(match[1]),
    column: match[2] ? Number(match[2]) : null
  }
}

function parseFilePathTrailingLineTarget(filePath) {
  const match = /^(.*?)(?::(\d+))(?::(\d+))?$/.exec(filePath)
  if (!match || !match[1] || match[1].endsWith('/') || match[1].endsWith('\\')) {
    return null
  }
  return {
    filePath: match[1],
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : null
  }
}

export function resolveTerminalFileUrlTarget(parsed, options = {}) {
  if (parsed.hostname && parsed.hostname !== 'localhost' && !options.allowUncHost) {
    return null
  }

  const filePath = fileUriToFilesystemPath(parsed)
  if (!filePath) {
    return null
  }

  const hashTarget = parseFileUrlLineHash(parsed.hash)
  if (hashTarget) {
    return { filePath, line: hashTarget.line, column: hashTarget.column }
  }

  return parseFilePathTrailingLineTarget(filePath) ?? { filePath, line: null, column: null }
}
