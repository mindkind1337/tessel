// Each project's git worktrees (the other checkouts of its repository), for
// the sidebar's "N other branches" line. Refreshed when the project branches
// are (a project folder changes, the window gets the focus), and only while
// the window is visible (windowVisibility.js): a refresh asked while hidden
// waits until it is shown again.
//
// list(cwd) -> { ok: true, worktrees } | { ok: false, error } (the main
// process only answers for an open project's folder: a project just added
// is known there once the layout is saved, so 'unknown-folder' is asked
// again once, a little later).
export function createProjectWorktrees({
  list,
  store,
  visible = () => typeof document === 'undefined' || document.visibilityState === 'visible',
  retryMs = 1500,
  setTimer = setTimeout
} = {}) {
  let wanted = []
  let pending = false // asked while hidden
  let running = false
  let again = false
  const retried = new Set()

  const signature = (l) => l.map((w) => `${w.path}\n${w.branch}\n${w.head}\n${w.locked ? 1 : 0}${w.prunable ? 1 : 0}`).join('\n\n')
  function put(cwd, worktrees) {
    const next = Array.isArray(worktrees) ? worktrees : []
    const cur = store[cwd]
    // The same list is not written again (nothing to redraw).
    if (!cur || signature(cur) !== signature(next)) store[cwd] = next
  }

  async function run() {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      const cwds = wanted.slice()
      for (const key of Object.keys(store)) if (!cwds.includes(key)) delete store[key]
      for (const cwd of cwds) {
        let res = null
        try {
          res = await list(cwd)
        } catch {
          res = null // next time
        }
        if (!wanted.includes(cwd)) continue
        if (res && res.ok) {
          retried.delete(cwd)
          put(cwd, res.worktrees)
        } else if (res && res.error === 'unknown-folder') {
          if (!retried.has(cwd)) {
            retried.add(cwd)
            setTimer(() => refresh(wanted), retryMs)
          }
        } else if (res && res.error === 'not-repo') put(cwd, [])
        // Anything else (git failed once): what was shown stays.
      }
    } finally {
      running = false
      if (again) {
        again = false
        run()
      }
    }
  }

  function refresh(cwds) {
    wanted = [...new Set((cwds || []).filter((c) => typeof c === 'string' && c))]
    if (!visible()) {
      pending = true
      return Promise.resolve()
    }
    pending = false
    return run()
  }

  return {
    refresh,
    // The window is shown again: what was asked while hidden runs now.
    shown() {
      if (pending && visible()) return refresh(wanted)
      return Promise.resolve()
    }
  }
}
