// How a task copy (git worktree) is named and where it goes, from Settings:
// Branch Prefix (Orca's shared/branch-prefix.ts, MIT) and Workspace Directory
// (Orca's computeWorktreePath with Nest Workspaces on).

// The raw prefix the chosen mode gives, or null for none.
export function selectBranchPrefixInput({ branchPrefix, branchPrefixCustom } = {}, gitUsername) {
  switch (branchPrefix) {
    case 'git-username':
      return gitUsername || null
    case 'none':
      return null
    case 'custom':
    default:
      return typeof branchPrefixCustom === 'string' ? branchPrefixCustom : null
  }
}

// "team/" or " /team// " -> "team": the join adds the one "/".
export function normalizeBranchPrefix(raw) {
  return String(raw || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
}

const hasControlOrSpace = (v) => [...v].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f)

// null when git accepts the prefix, else 'invalid-characters' (the rules of
// git check-ref-format that a prefix can break).
export function getBranchPrefixIssue(raw) {
  const p = normalizeBranchPrefix(raw)
  if (!p) return null
  if (
    hasControlOrSpace(p) ||
    /[~^:?*[\\]/.test(p) ||
    p.includes('..') ||
    p.includes('@{') ||
    p.startsWith('-') ||
    p.endsWith('.') ||
    p.split('/').some((seg) => seg.startsWith('.') || seg.endsWith('.lock'))
  )
    return 'invalid-characters'
  return null
}

// The prefix that applies (normalized), or null. A git username that git
// would reject is skipped; a custom prefix it would reject is an error.
export function branchPrefixFor(settings, gitUsername) {
  const p = normalizeBranchPrefix(selectBranchPrefixInput(settings, gitUsername))
  if (!p) return null
  if (getBranchPrefixIssue(p)) {
    if (settings && settings.branchPrefix === 'git-username') return null
    throw new Error(`Branch prefix "${p}" contains characters git rejects. Change it in Settings > Git & Source Control.`)
  }
  return p
}

export function branchNameFor(name, prefix) {
  return prefix ? `${prefix}/${name}` : name
}

// Where the copies of a project go. '' = Tessel's own place, next to the
// project: <parent>/<project>.worktrees. A relative path is inside the
// project; an absolute one holds a folder per project (Orca's nesting).
// `path` is node's path module (win32 or posix).
export function worktreeBaseDir(root, workspaceDir, path) {
  const dir = String(workspaceDir || '').trim()
  if (!dir) return path.join(path.dirname(root), `${path.basename(root)}.worktrees`)
  const repoName = path.basename(root).replace(/\.git$/, '')
  const base = path.isAbsolute(dir) ? dir : path.join(root, dir)
  return path.join(base, repoName)
}
