// A browser page's debugger (webContents.debugger, CDP), shared in the main
// process by everyone who needs it: agents driving the page
// (agentBrowser.js) and any other holder. A page has one debugger: before,
// an agent let it go after a minute without a command, which would have cut
// another holder's use in the middle.
//
// Each user takes a lease. The first lease attaches the debugger, the last
// one released detaches it; a lease released in between leaves it to the
// others (its holder undoes what it turned on itself). Each lease hears the
// debugger's events through its own listeners, removed when it is released.
// When the debugger goes away on its own (the page closed, its devtools
// opened), every lease ends at once and its holder is told (onDetach).
//
// The registry is keyed by the page itself (a WeakMap): nothing is kept for
// a page that is gone, and every module that leases the same page shares it.

export class DebuggerUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.code = 'debugger_unavailable'
  }
}

const pages = new WeakMap() // webContents -> { leases: Set, installed, detaching }

function stateOf(guest) {
  let state = pages.get(guest)
  if (!state) {
    state = { leases: new Set(), installed: false, detaching: false }
    pages.set(guest, state)
  }
  return state
}

// Every lease of the page ends (the debugger detached on its own).
function endAll(state, reason) {
  const list = [...state.leases]
  state.leases.clear()
  for (const lease of list) lease._end(reason)
}

// The debugger's events go to the leases' listeners. Installed once per
// page: its listeners stay for the page's life (a debugger can be attached
// and detached many times).
function install(guest, state) {
  if (state.installed) return
  state.installed = true
  const dbg = guest.debugger
  dbg.on('message', (event, method, params, sessionId) => {
    for (const lease of [...state.leases]) lease._emit(event, method, params, sessionId)
  })
  dbg.on('detach', (_event, reason) => {
    // Our own detach (the last lease released): nothing more to end.
    if (state.detaching) return
    endAll(state, typeof reason === 'string' ? reason : 'detached')
  })
}

// holder: who takes it ('agent', 'live-share'...), for holders() and logs.
// onDetach(reason): the debugger went away on its own; the lease is over.
// -> lease { holder, active, alone, send(method, params, sessionId),
//            on(listener) -> off, release() -> detached? }
// Throws when the debugger cannot be attached (its devtools are open): the
// error of webContents.debugger.attach, for the caller to word.
export function leaseDebugger(guest, holder, { onDetach = null } = {}) {
  if (!guest || !guest.debugger || (typeof guest.isDestroyed === 'function' && guest.isDestroyed())) throw new DebuggerUnavailableError('The page is gone.')
  const dbg = guest.debugger
  const state = stateOf(guest)
  install(guest, state)
  if (!dbg.isAttached()) {
    // Leases that never heard the debugger go: they are over.
    if (state.leases.size) endAll(state, 'detached')
    dbg.attach('1.3')
  }
  const listeners = new Set()
  let ended = false
  const lease = {
    holder: String(holder || 'unknown'),
    get active() {
      return !ended
    },
    // No other lease holds the page's debugger.
    get alone() {
      return !ended && state.leases.size === 1
    },
    send(method, params = {}, sessionId = undefined) {
      if (ended) return Promise.reject(new DebuggerUnavailableError('The page\'s debugger was let go.'))
      try {
        return Promise.resolve(sessionId ? dbg.sendCommand(method, params, sessionId) : dbg.sendCommand(method, params))
      } catch (err) {
        return Promise.reject(err)
      }
    },
    // listener(event, method, params, sessionId), as the debugger's 'message'.
    on(listener) {
      if (ended || typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // -> true when this was the last lease (the debugger is detached).
    release() {
      if (ended) return false
      ended = true
      listeners.clear()
      state.leases.delete(lease)
      if (state.leases.size) return false
      try {
        if (!(typeof guest.isDestroyed === 'function' && guest.isDestroyed()) && dbg.isAttached()) {
          state.detaching = true
          dbg.detach()
        }
      } catch {
        // gone
      } finally {
        state.detaching = false
      }
      return true
    },
    _emit(...args) {
      for (const fn of [...listeners]) {
        try {
          fn(...args)
        } catch {
          // one holder's listener never stops the others
        }
      }
    },
    _end(reason) {
      if (ended) return
      ended = true
      listeners.clear()
      try {
        onDetach?.(reason)
      } catch {
        // the holder's own cleanup
      }
    }
  }
  state.leases.add(lease)
  return lease
}

// The holders of the page's debugger now (['agent', 'live-share']).
export function debuggerHolders(guest) {
  const state = guest ? pages.get(guest) : null
  return state ? [...state.leases].map((lease) => lease.holder) : []
}
