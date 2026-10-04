// The existing agents offered by "Fix failing checks" / "Resolve review
// comments" of a pull request (GitHubDialog.vue): first the ones already on
// it (a copy on its head branch, or its task "#N …"), then the project's
// other agents, in its main folder or any of its worktrees, each with its
// folder and, when it is not on the PR's branch, its branch as a hint.
// Pure: App gives the panes, the project folder and its git worktrees.

function normPath(p) {
  return String(p || '')
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

// `dir` is `root` or inside it (case and slashes aside).
function within(dir, root) {
  const d = normPath(dir)
  const r = normPath(root)
  return !!r && (d === r || d.startsWith(r + '/'))
}

// A pane's folder: its copy, the copy it was opened in, or where it started;
// the project folder when it has none.
function folderOf(leaf, cwd) {
  return (leaf.worktree && leaf.worktree.path) || leaf.viewPath || leaf.startDir || cwd
}

export function prAgentTargets({ agents, cwd, mainBranch = '', worktrees = [], number, head = '', label, taskOf }) {
  const n = Number(number)
  if (!cwd || !Number.isSafeInteger(n) || n < 1) return []
  const copies = (Array.isArray(worktrees) ? worktrees : []).filter((w) => w && w.path && !within(w.path, cwd) && !within(cwd, w.path))
  const best = []
  const others = []
  for (const leaf of Array.isArray(agents) ? agents : []) {
    const path = folderOf(leaf, cwd)
    const copy = leaf.worktree && leaf.worktree.path ? null : copies.find((w) => within(path, w.path))
    let branch
    if (leaf.worktree && leaf.worktree.path) branch = leaf.worktree.branch || ''
    else if (copy) branch = copy.branch || ''
    else if (within(path, cwd)) branch = mainBranch || ''
    else continue // another folder: not this project's repo
    const task = taskOf ? taskOf(leaf.id) : null
    const onHead = !!head && branch === head
    const match = onHead || (!!task && !!task.worktree && String(task.title || '').startsWith(`#${n} `))
    const entry = { id: leaf.id, label: label(leaf), path, branch, hint: !onHead && branch ? branch : '', match }
    ;(match ? best : others).push(entry)
  }
  return [...best, ...others]
}
