// Team mail for terminal agents: a short pointer typed into the agent's
// terminal ("You have N new team messages: read them with team_inbox."),
// never the messages themselves (they stay in the team channel, the agent
// pulls them with its team tools).
//
// How a pointer goes, per pane:
// - only when the agent's idle was observed (its hooks, or Codex's turn end
//   read from its rollout) and nothing else rules it out (deps.blocked says
//   why not: working, approval, the user typing there...);
// - the text first, Enter as a separate write about 500 ms later (agent TUIs
//   can take an Enter that arrives with the text as part of it);
// - one flight per pane: a trigger during a flight is parked and runs again
//   once the flight has settled;
// - a watermark (the message ids already pointed at): the same mail is not
//   pointed at again by every trigger;
// - a short check after Enter: the agent is still idle, the mail unread and
//   the pointer still in its input box: Enter is pressed again, once;
// - a bounded retry: while the mail stays unread and the agent idle, the
//   pointer goes again every 30 s, 3 times at most; it stops as soon as the
//   agent reads its inbox (the pointed messages are no longer unread).
//
// Pure: every effect goes through `deps`, so the tests drive it with fake
// panes and fake timers.
//
// deps: {
//   now() -> ms, setTimeout(fn, ms) -> handle, clearTimeout(handle),
//   unread(id) -> { count, ids: string[] | null } (ids null: only the count),
//   blocked(id, { retry, phase }) -> '' | why the pointer cannot be typed now
//     (phase 'write' before the text, 'enter' before Enter, 'verify' before
//     Enter is pressed again),
//   getPane(id) -> { paste(text), submit(), screenText(n) } | null,
//   inputEmpty(id) -> true (the input line is shown empty) | false | null,
//   noSubmit(id) -> true when Enter is left to the user (Cursor Agent),
//   generation(id) -> a value that changes when the agent is relaunched,
//   label(id) -> '#1 Codex CLI (pane-1)', log(level, text),
//   onPointed(id): a pointer was just typed there
// }

export const POINTER = {
  enterDelayMs: 500,
  verifyMs: 4000,
  retryMs: 30000,
  maxRetries: 3
}

export function pointerText(count) {
  const n = Math.max(1, count | 0)
  return `[Tessel] You have ${n} new team message${n > 1 ? 's' : ''}: read ${n > 1 ? 'them' : 'it'} with team_inbox.` // i18n-ignore
}

// The pointer, whitespace removed (a TUI wraps its input box itself, with
// its own indentation, so the words can be cut anywhere on screen).
const POINTER_SQUASHED = /\[Tessel\]Youhave\d+newteammessages?:read(?:it|them)withteam_inbox\./

// A pointer is still typed in the agent's input box (not sent). The screen
// cannot always tell the input box from the transcript: an input line shown
// empty (Codex's placeholder) says no; otherwise the pointer's words near the
// bottom say yes (pressing Enter on an empty line does nothing in the agent
// CLIs, so a wrong yes costs nothing).
export function pointerStillTyped(pane, inputEmpty) {
  if (inputEmpty === true) return false
  if (!pane || typeof pane.screenText !== 'function') return false
  return POINTER_SQUASHED.test(String(pane.screenText(5) || '').replace(/\s+/g, ''))
}

export function createTeamDelivery(deps) {
  const cfg = { ...POINTER, ...(deps.cfg || {}) }
  const panes = new Map() // id -> state

  function stateOf(id) {
    let s = panes.get(id)
    if (!s) {
      s = {
        flying: false,
        parked: false,
        gen: deps.generation ? deps.generation(id) : null,
        pointed: new Set(), // the watermark: message ids pointed at
        pointedCount: 0,
        attempts: 0, // pointers for the current mail (1 + retries)
        lastAt: 0,
        outstanding: false, // pointed mail not read yet
        why: '',
        gaveUp: false,
        retryTimer: null,
        verifyTimer: null
      }
      panes.set(id, s)
    }
    return s
  }
  const log = (level, id, text) => {
    if (deps.log) deps.log(level, `${deps.label ? deps.label(id) : id}: ${text}`)
  }
  function clearTimers(s) {
    if (s.retryTimer) deps.clearTimeout(s.retryTimer)
    if (s.verifyTimer) deps.clearTimeout(s.verifyTimer)
    s.retryTimer = null
    s.verifyTimer = null
  }
  function resetMail(s) {
    clearTimers(s)
    s.pointed = new Set()
    s.pointedCount = 0
    s.attempts = 0
    s.outstanding = false
    s.gaveUp = false
    s.why = ''
  }

  // Everything pointed at is read (or gone): the delivery worked.
  function settleReads(id, s, mail) {
    if (!s.outstanding) return
    const stillUnread = mail.ids ? mail.ids.some((m) => s.pointed.has(m)) : mail.count > 0 && mail.count >= s.pointedCount
    if (mail.count && stillUnread) return
    log('info', id, `read confirmed after ${s.attempts} pointer${s.attempts === 1 ? '' : 's'}`) // i18n-ignore
    // Mail that came after the pointed one and is still unread is "new":
    // pointed at by this or the next trigger.
    resetMail(s)
  }

  function notify(id) {
    const s = stateOf(id)
    if (s.flying) {
      s.parked = true
      return Promise.resolve()
    }
    return run(id, s)
  }

  async function run(id, s) {
    // Relaunched since (restart, resume): a new process, nothing pointed there.
    const gen = deps.generation ? deps.generation(id) : null
    if (gen !== s.gen) {
      resetMail(s)
      s.gen = gen
    }
    const raw = deps.unread(id) || {}
    const mail = { count: raw.count | 0, ids: Array.isArray(raw.ids) && raw.ids.length ? raw.ids : null }
    if (!mail.count) {
      if (s.outstanding) log('info', id, `read confirmed after ${s.attempts} pointer${s.attempts === 1 ? '' : 's'}`) // i18n-ignore
      resetMail(s)
      return
    }
    settleReads(id, s, mail)
    const fresh = mail.ids ? mail.ids.some((m) => !s.pointed.has(m)) : mail.count > s.pointedCount
    let retry = false
    if (!fresh) {
      if (!s.outstanding) return
      if (s.attempts > cfg.maxRetries) {
        if (!s.gaveUp) {
          s.gaveUp = true
          log('warn', id, `still unread after ${cfg.maxRetries} retries: no more pointers until new mail arrives`) // i18n-ignore
        }
        return
      }
      if (deps.now() - s.lastAt < cfg.retryMs) return
      retry = true
    }
    const why = deps.blocked(id, { retry, phase: 'write' }) || ''
    if (why) {
      if (s.why !== why) log('info', id, `pointer waits: ${why}`) // i18n-ignore
      s.why = why
      return
    }
    s.why = ''
    const pane = deps.getPane(id)
    if (!pane) return
    s.flying = true
    try {
      await flight(id, s, pane, mail, retry, gen)
    } catch (err) {
      log('warn', id, `pointer failed: ${(err && err.message) || err}`) // i18n-ignore
    } finally {
      s.flying = false
      if (s.parked) {
        s.parked = false
        deps.setTimeout(() => notify(id), 0)
      }
    }
  }

  async function flight(id, s, pane, mail, retry, gen) {
    const n = retry ? s.attempts : 0
    // A pointer from before is still in the input box (its Enter was
    // lost): Enter only, never a second pointer on top of it.
    const typed = s.outstanding && pointerStillTyped(pane, deps.inputEmpty ? deps.inputEmpty(id) : null)
    if (!typed) pane.paste(pointerText(mail.count))
    // The watermark moves as soon as something is in the terminal.
    for (const m of mail.ids || []) s.pointed.add(m)
    s.pointedCount = mail.count
    s.attempts = retry ? s.attempts + 1 : 1
    s.lastAt = deps.now()
    s.outstanding = true
    s.gaveUp = false
    if (deps.onPointed) deps.onPointed(id)
    const what = `${mail.count} message${mail.count === 1 ? '' : 's'}` // i18n-ignore
    if (retry) log('info', id, `retry ${n}/${cfg.maxRetries}: ${typed ? 'the pointer is still in the input box, Enter only' : `pointer written again (${what})`}`) // i18n-ignore
    else log('info', id, typed ? `a pointer is still in the input box: Enter only (${what})` : `pointer written (${what})`) // i18n-ignore
    armRetry(id, s)
    if (deps.noSubmit && deps.noSubmit(id)) {
      log('info', id, 'Enter left to the user (this agent does not take typed input as sent)') // i18n-ignore
      return
    }
    if (!typed) await sleep(cfg.enterDelayMs)
    // Checked again at the moment of Enter: same process, still safe.
    const now = deps.getPane(id)
    if (now !== pane || (deps.generation && deps.generation(id) !== gen)) {
      log('warn', id, 'Enter not sent: the pane changed meanwhile') // i18n-ignore
      return
    }
    const why = deps.blocked(id, { retry, phase: 'enter' }) || ''
    if (why) {
      log('warn', id, `Enter not sent: ${why} (the pointer stays in the input box; the next try presses it)`) // i18n-ignore
      return
    }
    pane.submit()
    log('info', id, 'Enter sent') // i18n-ignore
    armVerify(id, s, pane, gen)
  }

  function sleep(ms) {
    return new Promise((resolve) => deps.setTimeout(resolve, ms))
  }

  function armRetry(id, s) {
    if (s.retryTimer) deps.clearTimeout(s.retryTimer)
    s.retryTimer = deps.setTimeout(() => {
      s.retryTimer = null
      notify(id)
    }, cfg.retryMs)
  }

  // Shortly after Enter: the agent did not start (still idle, mail unread)
  // and the pointer is still in its input box: Enter again, once.
  function armVerify(id, s, pane, gen) {
    if (s.verifyTimer) deps.clearTimeout(s.verifyTimer)
    const attempt = s.attempts
    s.verifyTimer = deps.setTimeout(() => {
      s.verifyTimer = null
      if (s.flying || !s.outstanding || s.attempts !== attempt) return
      if (deps.getPane(id) !== pane || (deps.generation && deps.generation(id) !== gen)) return
      const raw = deps.unread(id) || {}
      const ids = Array.isArray(raw.ids) && raw.ids.length ? raw.ids : null
      const unread = (raw.count | 0) > 0 && (!ids || ids.some((m) => s.pointed.has(m)))
      if (!unread) return
      if (!pointerStillTyped(pane, deps.inputEmpty ? deps.inputEmpty(id) : null)) return
      const why = deps.blocked(id, { retry: true, phase: 'verify' }) || ''
      if (why) return
      pane.submit()
      log('warn', id, 'the agent did not start and the pointer is still in its input box: Enter sent again')
    }, cfg.verifyMs)
  }

  function forget(id) {
    const s = panes.get(id)
    if (!s) return
    clearTimers(s)
    panes.delete(id)
  }

  return {
    notify,
    forget,
    dispose: () => {
      for (const id of [...panes.keys()]) forget(id)
    },
    // A flight is typing into this pane right now (nothing else types there).
    inFlight: (id) => !!(panes.get(id) && panes.get(id).flying),
    state: (id) => panes.get(id) || null
  }
}
