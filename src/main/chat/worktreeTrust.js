// Which project a git worktree belongs to, verified both ways: the copy's
// .git file names <project>/.git/worktrees/<name>, and that entry's gitdir
// file names the copy back. So a folder cannot claim a project with a
// hand-written .git file. On its own this grants no trust: only copies that
// Tessel made itself from the project's own code, and only for its workers,
// count as their project (workerCopies.js).
import fs from 'fs'
import { basename, dirname, join, resolve as resolvePath } from 'path'

// -> [project root] or [] (not a worktree, or not a verified one).
export function worktreeProjectRoot(cwd) {
  try {
    const dotGit = join(cwd, '.git')
    if (!fs.statSync(dotGit).isFile()) return []
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8').slice(0, 4096))
    if (!m) return []
    // Relative to the copy (git writes it so with worktree.useRelativePaths).
    const gitdir = resolvePath(cwd, m[1])
    // <project>/.git/worktrees/<name>, taken apart with dirname so that a UNC
    // path (\\server\share\...) keeps its leading backslashes.
    const worktrees = dirname(gitdir)
    const dotGitDir = dirname(worktrees)
    const project = dirname(dotGitDir)
    if (
      !basename(gitdir) ||
      basename(worktrees).toLowerCase() !== 'worktrees' ||
      basename(dotGitDir).toLowerCase() !== '.git' ||
      project === dotGitDir
    )
      return []
    // A relative back-link is relative to the gitdir file's own folder (the
    // worktrees/<name> entry), never to Tessel's current folder.
    const back = fs.readFileSync(join(gitdir, 'gitdir'), 'utf8').trim()
    if (!back || resolvePath(gitdir, back).toLowerCase() !== resolvePath(dotGit).toLowerCase()) return []
    return [project]
  } catch {
    return []
  }
}
