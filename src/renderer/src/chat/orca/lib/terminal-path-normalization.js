// After Orca's terminal-path-normalization.ts (MIT, Copyright (c) 2026 Lovecast Inc.)

function normalizeSegments(pathValue) {
  const segments = pathValue.split(/[\\/]+/)
  const stack = []
  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (stack.length > 0) {
        stack.pop()
      }
      continue
    }
    stack.push(segment)
  }

  return stack
}

export function normalizeAbsolutePath(pathValue) {
  const windowsDriveMatch = /^([A-Za-z]):[\\/]*(.*)$/.exec(pathValue)
  if (windowsDriveMatch) {
    const driveLetter = windowsDriveMatch[1].toUpperCase()
    const suffix = normalizeSegments(windowsDriveMatch[2]).join('/')
    const normalized = suffix ? `${driveLetter}:/${suffix}` : `${driveLetter}:/`
    return {
      normalized,
      comparisonKey: normalized.toLowerCase(),
      rootKind: 'windows',
    }
  }

  const uncMatch = /^(?:\\\\|\/\/)([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]*(.*))?$/.exec(pathValue)
  if (uncMatch) {
    const server = uncMatch[1]
    const share = uncMatch[2]
    const suffix = normalizeSegments(uncMatch[3] ?? '').join('/')
    const normalizedRoot = `//${server}/${share}`
    const normalized = suffix ? `${normalizedRoot}/${suffix}` : normalizedRoot
    return {
      normalized,
      comparisonKey: normalized.toLowerCase(),
      rootKind: 'unc',
    }
  }

  if (pathValue.startsWith('/')) {
    const normalized = `/${normalizeSegments(pathValue).join('/')}`.replace(/\/+$/, '') || '/'
    return {
      normalized,
      comparisonKey: normalized,
      rootKind: 'posix',
    }
  }

  return null
}

function inferHomePathFromCwd(cwd) {
  const normalizedCwd = normalizeAbsolutePath(cwd)
  if (!normalizedCwd) {
    return null
  }

  const segments = normalizeSegments(normalizedCwd.normalized)
  if (normalizedCwd.rootKind === 'windows') {
    const [drive, usersSegment, userSegment] = segments
    if (!drive || !usersSegment || !userSegment || usersSegment.toLowerCase() !== 'users') {
      return null
    }
    return `${drive}/${usersSegment}/${userSegment}`
  }

  if (normalizedCwd.rootKind === 'posix') {
    const [rootParent, userSegment] = segments
    if ((rootParent === 'Users' || rootParent === 'home') && userSegment) {
      return `/${rootParent}/${userSegment}`
    }
    if (rootParent === 'root') {
      return '/root'
    }
  }

  return null
}

function normalizeExplicitHomePath(homePath) {
  const trimmedHomePath = homePath?.trim()
  if (!trimmedHomePath) {
    return null
  }

  return normalizeAbsolutePath(trimmedHomePath)?.normalized ?? null
}

export function resolveTildePath(pathValue, cwd, homePath) {
  if (!/^~[\\/]/.test(pathValue)) {
    return null
  }

  // Why: remote/devcontainer terminals can have cwd outside the user's home;
  // prefer the terminal's explicit home when the caller has it.
  const resolvedHomePath = normalizeExplicitHomePath(homePath) ?? inferHomePathFromCwd(cwd)
  if (!resolvedHomePath) {
    return null
  }

  return joinAbsolutePath(resolvedHomePath, pathValue.slice(2))
}

export function joinAbsolutePath(basePath, relativePath) {
  const normalizedBase = normalizeAbsolutePath(basePath)
  if (!normalizedBase) {
    return null
  }

  return normalizeJoinedPath(normalizedBase, relativePath)
}

function normalizeJoinedPath(basePath, relativePath) {
  const normalizedBaseSegments = normalizeSegments(basePath.normalized)
  // Normalize after joining: ../ must traverse the base rather than disappear.
  // Preserve drive roots and UNC server/share while reducing parent segments.
  const rootLength = basePath.rootKind === 'unc' ? 2 : basePath.rootKind === 'windows' ? 1 : 0
  const joinedSegments = [...normalizedBaseSegments]
  for (const segment of relativePath.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (joinedSegments.length > rootLength) joinedSegments.pop()
    } else joinedSegments.push(segment)
  }

  if (basePath.rootKind === 'unc') {
    const [server, share, ...rest] = joinedSegments
    return rest.length > 0 ? `//${server}/${share}/${rest.join('/')}` : `//${server}/${share}`
  }

  if (basePath.rootKind === 'windows') {
    const [drive, ...rest] = joinedSegments
    return rest.length > 0 ? `${drive}/${rest.join('/')}` : drive
  }

  return `/${joinedSegments.join('/')}`.replace(/\/+$/, '') || '/'
}
