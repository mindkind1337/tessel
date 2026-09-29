// "This launch of this pane is ready": a structured handshake that lets
// Tessel wake an agent it cannot otherwise confirm idle (a Codex relaunched
// in place with its conversation resumed sends no hook before its next turn).
//
// When the tessel-team MCP server starts inside an agent, it sends ONE signed
// request { action: 'ready', launch: <TESSEL_AGENT_LAUNCH> } (teamAuth.js: a
// MAC over pane, team, content, nonce and time). It counts only when:
//   - the pane's current launch (registered in pty:create) has that token;
//   - Tessel launched it without a first prompt (resume or plain start: it
//     waits at its prompt; a worker started with a prompt works at once);
//   - it is the first ready of that launch (an MCP server restarted
//     mid-session is ignored). The same request file read again before it
//     is finished (an abandoned round) is the same handshake, not a second.
// A launch is forgotten when its terminal ends or the pane is relaunched.
// Nothing here authorizes typing on its own: the renderer also requires no
// sign of work since (hooks, busy or approval screens, the user's input).
const launches = new Map() // pane id -> { token, startsIdle, ready: null | { at, key } }

export function registerLaunch(paneId, token, { startsIdle = false } = {}) {
  if (paneId == null || typeof token !== 'string' || !token) return
  launches.set(String(paneId), { token, startsIdle: startsIdle === true, ready: null })
}

export function endLaunch(paneId) {
  launches.delete(String(paneId))
}

// key: what identifies the request (team, file name, nonce).
// -> { ok: true, at } or { error }
export function markReady(paneId, token, key, now = Date.now()) {
  const l = launches.get(String(paneId))
  if (!l || typeof token !== 'string' || l.token !== token) return { error: 'not the current launch of this pane' } // i18n-ignore (internal, never shown)
  if (!l.startsIdle) return { error: 'this launch started with a prompt: it is not idle' } // i18n-ignore (internal, never shown)
  if (l.ready) return l.ready.key === key ? { ok: true, at: l.ready.at } : { error: 'this launch already said it is ready' } // i18n-ignore (internal, never shown)
  l.ready = { at: now, key }
  return { ok: true, at: now }
}

// Tests only.
export function _resetLaunchReady() {
  launches.clear()
}
