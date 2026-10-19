// Live Share: what a guest may do beyond watching its projects, as one list.
//
// Each right has an id (what goes over the wire and into saved files) and
// its default (every one is off until the host turns it on). The host's
// Tessel enforces each one where the guest's request is taken
// (src/main/liveShare/shareHost.js); the window names each one
// (src/renderer/src/liveShareRights.js) and every editor (the accept prompt,
// an invitation, a person, a trusted person, a project's people) shows them
// from this list. Adding a right means adding an entry here, its label there,
// and its check on the host.
//
// Rights from an older or newer Tessel are read through cleanRights: an id
// this list does not know is dropped (never granted), and a known one is on
// only when it is exactly true.
//
// Besides these on/off rights, rights may carry `agents`: which of the
// host's agents and models the person may use (src/shared/liveShareAgents.js).
// It is there only when one was set; without it, the share's setting counts
// (every agent and model unless the host limits them), which is how every
// record saved before it reads.
import { cleanAgentRule, sameAgentRule } from './liveShareAgents'

export const SHARE_RIGHTS = Object.freeze([
  // Type in the shared terminals and agents (run any command as the host).
  Object.freeze({ id: 'type', default: false }),
  // Open terminals and agents in a shared project, on the host's computer.
  // Without it, a guest's request asks the host.
  Object.freeze({ id: 'open', default: false }),
  // Ask to close panes (an agent or a busy terminal still asks the host).
  Object.freeze({ id: 'close', default: false }),
  // See the host's usage (plans, % used, reset times): host-wide data.
  Object.freeze({ id: 'usage', default: false }),
  // In each project the person sees (phase 2: the host's Files, editor,
  // Changes and Tasks on the guest's screen): save, create, rename and move
  // to the Recycle Bin files; stage, unstage, discard and commit; add, move,
  // edit and delete task cards and answer their questions.
  Object.freeze({ id: 'edit', default: false }),
  Object.freeze({ id: 'git', default: false }),
  Object.freeze({ id: 'tasks', default: false }),
  // See the host's browser pages: their addresses and titles, which the
  // guest opens in its own browser (its own session, never the host's). The
  // old "use my pages" (pagesUse) is gone: a record that still has it reads
  // without it.
  Object.freeze({ id: 'pagesView', default: false })
])

export const RIGHT_IDS = Object.freeze(SHARE_RIGHTS.map((r) => r.id))

export const isRightId = (id) => typeof id === 'string' && RIGHT_IDS.includes(id)

// Every known right with its default.
export function defaultRights() {
  const out = {}
  for (const r of SHARE_RIGHTS) out[r.id] = r.default
  return out
}

// A rights object as given by anyone (a peer, a saved file, the window):
// every known right, on only when it is exactly true; nothing else.
export function cleanRights(rights) {
  const given = rights && typeof rights === 'object' ? rights : null
  const out = {}
  for (const r of SHARE_RIGHTS) out[r.id] = !!given && Object.hasOwn(given, r.id) && given[r.id] === true
  // A right that needs another is off without it (a record can only lose
  // rights this way, never gain one).
  for (const r of SHARE_RIGHTS) if (r.needs && !out[r.needs]) out[r.id] = false
  const agents = cleanAgentRule(given && given.agents)
  if (agents) out.agents = agents
  return out
}

// Rights with their agents rule set (null: none, the share's setting counts).
export function withAgents(rights, rule) {
  const out = cleanRights(rights)
  delete out.agents
  return cleanRights({ ...out, agents: rule })
}

// The right another one needs (pagesUse: pagesView), or null.
export const neededBy = (id) => (SHARE_RIGHTS.find((r) => r.id === id) || {}).needs || null

// Rights with one of them turned on or off, as a person's click means it:
// turning on a right that needs another turns that one on too; turning one
// off turns off the rights that need it. -> clean rights.
export function setRight(rights, id, on) {
  if (!isRightId(id)) return cleanRights(rights)
  const out = { ...cleanRights(rights), [id]: !!on }
  if (on && neededBy(id)) out[neededBy(id)] = true
  return cleanRights(out)
}

export const NO_RIGHTS = Object.freeze(cleanRights(null))

// The same rights (every known id equal, and the same agents rule).
export const sameRights = (a, b) => RIGHT_IDS.every((id) => !!(a && a[id]) === !!(b && b[id])) && sameAgentRule(a && a.agents, b && b.agents)
