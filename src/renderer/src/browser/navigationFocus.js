// Grid and side-panel browsers have separate pane contexts. Native mouse
// navigation must nevertheless go to just one page: the last focused active
// browser. Keeping earlier owners lets closing a side tab return to the grid.
const owners = new Map()

export function registerNavigationOwner(owner, isActive) {
  owners.set(owner, isActive)
}

export function focusNavigationOwner(owner) {
  const active = owners.get(owner)
  if (!active) return
  owners.delete(owner)
  owners.set(owner, active)
}

export function isNavigationOwner(owner) {
  for (const [candidate, active] of [...owners].reverse()) {
    if (active()) return candidate === owner
  }
  return false
}

export function releaseNavigationOwner(owner) {
  owners.delete(owner)
}
