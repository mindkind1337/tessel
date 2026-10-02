// A team lead (an agent) asks Tessel to act by writing small JSON files into
// its own inbox folder. Only four requests exist, and none can merge, discard
// or close anything: those stay the user's.
//
//   { "action": "task", "title": "...", "brief": "...", "agent": "#3" | "codex", "own_copy": true }
//   { "action": "message", "to": "#3" | "team", "text": "..." }
//   { "action": "approve", "task": "<title>", "note": "..." }
//   { "action": "changes", "task": "<title>", "text": "..." }
//
// parseLeadRequest(json) -> { ok: true, ...normalized } | { ok: false, error }.

const MAX_TITLE = 120
const MAX_TEXT = 6000

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

// "#3", "3" or 3 -> 3; anything else -> null.
function paneNum(v) {
  const m = /^#?(\d{1,3})$/.exec(String(v == null ? '' : v).trim())
  return m ? Number(m[1]) : null
}

export function parseLeadRequest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'not a JSON object' }
  const action = str(data.action, 20).toLowerCase()
  if (action === 'task') {
    const title = str(data.title, MAX_TITLE)
    if (!title) return { ok: false, error: 'a task needs a "title"' }
    const agent = str(String(data.agent == null ? '' : data.agent), 40)
    const num = paneNum(agent)
    const kind = num == null && /^[a-z0-9_-]{1,40}$/i.test(agent) ? agent.toLowerCase() : null
    if (num == null && !kind) return { ok: false, error: 'a task needs an "agent": a teammate like "#3", or an agent kind like "codex"' }
    return {
      ok: true,
      action,
      title,
      brief: str(data.brief, MAX_TEXT),
      num,
      kind,
      ownCopy: data.own_copy !== false
    }
  }
  if (action === 'message') {
    const text = str(data.text, MAX_TEXT)
    if (!text) return { ok: false, error: 'a message needs a "text"' }
    const to = String(data.to == null ? '' : data.to).trim().toLowerCase()
    if (to === 'team' || to === 'all') return { ok: true, action, to: 'team', num: null, text }
    if (to === 'lead') return { ok: true, action, to: 'lead', num: null, text }
    const num = paneNum(to)
    if (num == null) return { ok: false, error: 'a message needs "to": "#3", "team" or "lead"' }
    return { ok: true, action, to: 'one', num, text }
  }
  if (action === 'approve' || action === 'changes') {
    const task = str(data.task, MAX_TITLE)
    if (!task) return { ok: false, error: `"${action}" needs the "task" id (or its title)` }
    const text = str(action === 'approve' ? data.note : data.text, MAX_TEXT)
    if (action === 'changes' && !text) return { ok: false, error: '"changes" needs a "text" saying what to change' }
    return { ok: true, action, task, text }
  }
  return { ok: false, error: `unknown action "${action || '(none)'}": use task, message, approve or changes` }
}

// Find the task a lead means: its id first, then its exact title, then the
// title ignoring case, then a title prefix. Two tasks matching the same way is
// ambiguous: then nothing is picked.
// -> { task } | { error }
export function findTaskRef(tasks, ref) {
  const r = String(ref || '').trim()
  if (!r) return { error: 'no task given' }
  const byId = tasks.find((x) => x.id === r)
  if (byId) return { task: byId }
  const low = r.toLowerCase()
  const rounds = [
    (x) => x.title === r,
    (x) => x.title.toLowerCase() === low,
    (x) => x.title.toLowerCase().startsWith(low)
  ]
  for (const match of rounds) {
    const hits = tasks.filter(match)
    if (hits.length === 1) return { task: hits[0] }
    if (hits.length > 1)
      return { error: `"${r}" matches ${hits.length} tasks (${hits.map((x) => x.id).join(', ')}): use the task id` }
  }
  return { error: null }
}

// What every team member is told: how to reach its teammates without the
// user relaying (also written as HOW-TO.md in its inbox).
export function memberGuide({ teamName, inbox, me, members, lead }) {
  return [
    `Team "${teamName}". You are ${me}. Teammates: ${members.length ? members.join(', ') : 'none yet'}${lead ? `; ${lead} leads the team` : ''}.`,
    'To talk to your teammates, use your Tessel team tools: team_inbox reads new messages (call it when you start and after each step), team_send writes to a teammate ("#3") or to "team". Nothing is ever typed into anyone\'s terminal. Talk to each other this way: do not ask the user to pass messages on.'
  ].join('\n')
}

// What the lead is told when it takes the role (also written as HOW-TO.md in
// its inbox).
export function leadGuide({ teamName, inbox, members, kinds }) {
  return [
    `You now lead the team "${teamName}". Your teammates: ${members.length ? members.join(', ') : 'none yet'}.`,
    'Your job: split the goal into small tasks, give each to a teammate (or start a new agent), review what they finish, and tell the user when work is ready. You do not merge, discard or close anything: the user does that.',
    `To give tasks and review, write one JSON file per request into ${inbox} (any name ending in .json). Tessel reads it within a few seconds, deletes it, and answers in your team inbox (team_inbox).`,
    '- Give a task: {"action":"task","title":"Short title","brief":"What to do, which files, how to check it","agent":"#3"}. "agent" is a teammate number, or ' +
      (kinds.length ? kinds.map((k) => `"${k}"`).join(', ') : 'an agent kind') +
      ' to start a new agent. New agents work in their own copy (git branch); if the project cannot have one, the request is refused: add "own_copy": false to work in the project folder instead.',
    '- Messages to teammates go through your Tessel team tools (team_send; read yours with team_inbox), not this folder. The review requests and answers from Tessel arrive there too.',
    '- After a teammate finishes, you get a review request with the task id. Then either {"action":"approve","task":"<task id>","note":"why it is good"} (the user is told it is ready to merge) or {"action":"changes","task":"<task id>","text":"what to fix"} (it goes back to the teammate).',
    'Keep tasks independent so teammates do not edit the same files at once.'
  ].join('\n')
}
