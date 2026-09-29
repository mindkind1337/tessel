// A git worktree (an orchestration worker's copy of a project) counts, for
// the chat agents' folder trust, as the project it belongs to. Checked both
// ways: the copy's .git file names <project>/.git/worktrees/<name>, and that
// entry's gitdir file names the copy back. So a folder cannot borrow a
// trusted project's trust with a hand-written .git file.
import fs from 'fs'
import { join, resolve as resolvePath, sep as pathSep } from 'path'

// -> [project root] or [] (not a worktree, or not a verified one).
export function worktreeProjectRoot(cwd) {
  try {
    const dotGit = join(cwd, '.git')
    if (!fs.statSync(dotGit).isFile()) return []
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8').slice(0, 4096))
    if (!m) return []
    const gitdir = resolvePath(cwd, m[1])
    const parts = gitdir.split(/[\\/]+/)
    const i = parts.length - 2
    if (i < 2 || parts[i].toLowerCase() !== 'worktrees' || parts[i - 1].toLowerCase() !== '.git') return []
    const back = fs.readFileSync(join(gitdir, 'gitdir'), 'utf8').trim()
    if (resolvePath(back).toLowerCase() !== resolvePath(dotGit).toLowerCase()) return []
    return [parts.slice(0, i - 1).join(pathSep)]
  } catch {
    return []
  }
}
