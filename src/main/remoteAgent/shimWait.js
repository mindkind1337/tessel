// How long a new pane on an SSH host waits for the host's shim (the helper
// Tessel installs in ~/.tessel-server, over the Files session's queue).
//
// The pane's shell used to wait for the whole install, and the install waits
// its turn behind everything else asked of that host (a Live Share guest
// browsing the shared project, an earlier check): a pane could stay blank for
// a minute. Past SHIM_WAIT_MS the pane starts without the agent's Tessel tools
// (its card says they took too long, with Retry) while the install goes on in
// the background; the next pane or Retry finds it done.
export const SHIM_WAIT_MS = 10_000

// -> the install's answer, or { ok: false, reason: 'timeout' } once ms passed.
export function waitForShim(install, ms = SHIM_WAIT_MS, timers = { setTimeout, clearTimeout }) {
  let timer = null
  const late = new Promise((resolve) => {
    timer = timers.setTimeout(() => resolve({ ok: false, reason: 'timeout', detail: '', late: true }), ms)
  })
  const done = Promise.resolve(install)
  // The install may still fail after the wait: nobody is waiting for it then.
  done.catch(() => {})
  return Promise.race([done, late]).finally(() => timers.clearTimeout(timer))
}
