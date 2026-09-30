// A team as a short mark: "Team 2" -> "2"; a team named otherwise: its
// first two letters. Shown at the far left of its agents' rows and panes.
export function teamNumber(name) {
  const label = String(name || '').trim()
  const n = /(\d+)\s*$/.exec(label)
  return n ? n[1] : label.slice(0, 2)
}
