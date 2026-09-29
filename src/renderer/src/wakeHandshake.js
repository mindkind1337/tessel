// May Tessel wake this agent on the strength of its ready handshake (see
// src/main/launchReady.js)? Only for WAKING, never for what the interface
// shows. Hooks confirm an agent's state as before; the handshake covers the
// first wake of a launch that reported nothing yet (a Codex resumed in
// place), and only while nothing shows it did anything since it started:
//   ready      { launchToken, at } verified by the main process for the
//              pane's launch (first ready of a launch started without a
//              first prompt), or null
//   leaf       the pane: { agentLaunchToken, launchedAt }
//   state      the main process's state for this launch (agentStatus.js
//              getAgentState), or null
//   status     'busy' | 'idle' | 'unknown' (screen and hooks, display)
//   approval, limit   an approval prompt or a usage limit is showing
//   lastUserKeyAt     the user's last key in that pane (0 when none)
//   lastSentAt        the last text Tessel queued for that pane (0 when none)
// The screen can only veto (busy, approval, limit); it never authorizes.
export function handshakeAllowsWake({ ready, leaf, state, status, approval, limit, lastUserKeyAt = 0, lastSentAt = 0 }) {
  if (!ready || ready.spent || !leaf || !leaf.agentLaunchToken || ready.launchToken !== leaf.agentLaunchToken) return false
  // Any hook: the agent has worked since; hooks decide from now on.
  if (state && (state.hookSeen || ['working', 'approval', 'limited'].includes(state.state))) return false
  if (status === 'busy' || approval || limit) return false
  // Nothing typed there since this launch started, by the user or by Tessel
  // (a task, a note): it would be working on it.
  const since = Math.min(Number(leaf.launchedAt) || ready.at, ready.at)
  if ((lastUserKeyAt || 0) >= since || (lastSentAt || 0) >= since) return false
  return true
}
