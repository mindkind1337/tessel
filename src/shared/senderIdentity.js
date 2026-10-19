// Who sent a team message: a snapshot Tessel takes of the sending pane when it
// takes the message in (pane, agent, model, session, host, copy, team, card),
// never anything the agent wrote, so it cannot be faked. Stored with the
// channel message (main) and with its activity event (window).
//
// Only the fields below are kept, each a short string; anything that looks
// like a secret (a token, a key, a password in an address) is hidden.

const TEXT = {
  paneId: 100,
  name: 80,
  agentId: 40,
  agentName: 60,
  model: 80,
  modelId: 120,
  effort: 30,
  sessionId: 120,
  accountId: 120,
  hostLabel: 80,
  hostAddress: 160,
  remotePath: 400,
  worktree: 400,
  branch: 200,
  teamId: 100,
  cardId: 100,
  cardTitle: 160,
  tesselVersion: 40
}

const HOST_ID = /^ssh-[\w-]{1,60}$/

const SECRETS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+\S+/gi
]

export function scrubSecrets(value) {
  let out = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ')
  // A login with its password (user:password@host): the password goes.
  out = out.replace(/([A-Za-z0-9._%+-]+):[^@\s/\\]+@/g, '$1@')
  // ?token=... &password=...
  out = out.replace(/((?:^|[?&;\s])(?:token|key|password|passwd|pwd|secret|api_?key|access_token|auth)=)[^&\s]*/gi, '$1[hidden]')
  for (const re of SECRETS) out = out.replace(re, '[hidden]')
  return out
}

// A snapshot reduced to its known fields (null when it names nobody).
export function cleanSender(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = { v: 1 }
  for (const [key, max] of Object.entries(TEXT)) {
    const v = raw[key]
    if (typeof v === 'string' && v.trim()) out[key] = scrubSecrets(v.trim()).slice(0, max)
  }
  if (Number.isInteger(raw.num) && raw.num > 0 && raw.num < 1000) out.num = raw.num
  if (raw.host === 'local' || raw.host === 'ssh') out.host = raw.host
  // The saved SSH host it runs on (its id, never a name the agent wrote):
  // its paths are that host's files (useMessageLinks.js), never this PC's.
  if (out.host === 'ssh' && typeof raw.hostId === 'string' && HOST_ID.test(raw.hostId)) out.hostId = raw.hostId
  if (typeof raw.lead === 'boolean') out.lead = raw.lead
  if (Number.isFinite(raw.at) && raw.at > 0) out.at = Math.round(raw.at)
  return out.paneId || out.name ? out : null
}

// Where a sender's paths are: { hostId, path, label } for an agent on an SSH
// host (hostId null on a record older than the host's id: its paths open
// nowhere), null for one on this computer (or an older record that does not
// say).
export function senderRemote(s) {
  if (!s || typeof s !== 'object' || s.host !== 'ssh') return null
  return {
    hostId: typeof s.hostId === 'string' && HOST_ID.test(s.hostId) ? s.hostId : null,
    path: typeof s.remotePath === 'string' && s.remotePath ? s.remotePath : '~',
    label: s.hostLabel || s.hostAddress || ''
  }
}

// "Opus 5.5 · high" -> "Opus 5.5 high" (one dot fewer in a line of dots).
function modelWords(s) {
  return s && s.model ? s.model.replace(/\s*·\s*/g, ' ') : ''
}

// "Ada · Claude Code · Opus 5.5 high · local · main". `local` is the word for
// a pane on this computer (the window passes it translated).
export function senderLine(s, { local = 'local' } = {}) {
  if (!s || typeof s !== 'object') return ''
  const host = s.host === 'ssh' ? s.hostLabel || s.hostAddress || 'ssh' : s.host === 'local' ? local : ''
  return [s.name, s.agentName, modelWords(s), host, s.branch].filter(Boolean).join(' · ')
}

// The short form given to the receiving agent: "Ada · Claude Code · Opus 5.5 high".
export function senderTag(s) {
  if (!s || typeof s !== 'object') return ''
  return [s.name, s.agentName, modelWords(s)].filter(Boolean).join(' · ')
}
