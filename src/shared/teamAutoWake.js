// Teammate auto-wake: which cards have been left stranded.
//
// When a teammate's pane closes mid-task, its card stays in "doing" or "review"
// with an assignee that is no longer a member of the team. Nothing in Tessel
// recovers it: the board is the only writer, so the card just sits there and the
// work it stands for is lost. A lead can only fork a NEW card by asking for a
// "task" (src/shared/leadRequests.js), never attach a dispatch to the existing
// one, so recovery by hand leaves two cards for the same work.
//
// This module is the decision only: given the board and the team's members, it
// says which cards are stranded. Deciding is kept separate from acting so it can
// be tested without a team, a window or a filesystem.
//
//   WHICH cards are stranded (ACTIVE_COLUMNS): a card is stranded when no member
//   of the team is assigned to it. That is an assignee that matches no active
//   member by name or by "#num"; a card with no assignee at all is stranded too,
//   because it is exactly what a closed pane leaves behind. Cards in "todo",
//   "done" and "failed" are never stranded: they are either not started, or
//   already finished.
//
//   ONE per piece of work: a card is only reported when no other card with the
//   same title has a live assignee. Recovery by forking makes the same title
//   exist twice (the old stranded card and the new live one); without this rule
//   the stranded card would be picked up forever, and its work done twice.

export const ACTIVE_COLUMNS = ['doing', 'review']

// Two addresses match when both are absent (an unassigned card), or when the
// assignee names an active member. "#3" is the legacy form of a member number.
function isAssigned(task, liveNames) {
  const assignee = typeof task?.assignee === 'string' ? task.assignee.trim() : ''
  if (!assignee) return false
  if (liveNames.includes(assignee)) return true
  return false
}

// A member is addressable by "Ada" or by "#3"; both resolve to the same seat.
function memberOf(assignee, liveMembers) {
  const name = String(assignee || '').trim()
  if (!name) return null
  const legacy = /^#(\d{1,3})$/.exec(name)
  return liveMembers.find((m) => (legacy ? m.num === Number(legacy[1]) : m.name === name)) || null
}

/**
 * The cards whose work has been left without anyone doing it.
 *
 * @param tasks    the board's cards (TASK_COLUMNS columns, an optional assignee)
 * @param members  the team's members: { name, num } for each, only members
 *                 active in the team count (a stale seat must never be picked)
 * @returns the stranded cards, oldest first, without any that a live teammate
 *          is already covering under the same title
 */
export function strandedCards(tasks = [], members = []) {
  const live = (members || []).filter((m) => m && typeof m.name === 'string' && m.name)
  if (!Array.isArray(tasks) || !tasks.length) return []
  const active = tasks.filter((t) => t && ACTIVE_COLUMNS.includes(t.column))
  const covered = new Set(
    active
      .filter((t) => memberOf(t.assignee, live))
      .map((t) => String(t.title || ''))
      .filter(Boolean)
  )
  return active
    .filter((t) => !memberOf(t.assignee, live))
    .filter((t) => !covered.has(String(t.title || '')))
    .slice()
    .sort((a, b) => {
      const at = Number(a && a.columnSince) || 0
      const bt = Number(b && b.columnSince) || 0
      return at - bt || String((a && a.id) || '').localeCompare(String((b && b.id) || ''))
    })
}

/**
 * How many tasks count against a team's in-progress ceiling. Tessel's own lead
 * requests are refused at LEAD_MAX_ACTIVE and count "doing" and "review"
 * together (src/renderer/src/App.vue), so anything watching that line must count
 * both or it will think there is room when there is none.
 */
export function inProgressCount(tasks = []) {
  if (!Array.isArray(tasks)) return 0
  return tasks.filter((t) => t && ACTIVE_COLUMNS.includes(t.column)).length
}
