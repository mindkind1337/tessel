// Paste a message into an agent's terminal, press Enter, and find out whether
// the agent really took it. Pure (every effect goes through `d`), so the
// tests drive it with fake panes and timers.
//
// The screen cannot tell an agent's input box from its transcript, so the
// main evidence is what the agent does: once it works for a few seconds (or
// asks for approval) after Enter, it took the message. Enter is pressed again
// only when the agent stays quiet and the end of the message is still at the
// bottom of the screen (a draft); after two retries the delivery stays
// unconfirmed: no acknowledgement, and no blind second paste.
//
// d: { getPane(id) -> { paste, submit, screenText } | null, isBusy(id),
//      awaitingApproval(id), sleep(ms) -> Promise, waitIdle: bool,
//      userTyping(id): the user has a line in progress there,
//      guard(id): optional, the message's own condition to type now }
// -> 'confirmed' | 'unconfirmed' | 'requeue' (approval prompt before the
//    paste) | 'failed' (no pane: nothing was typed)

export const DELIVER = {
  settleMs: 500, // between paste and Enter
  stepMs: 500,
  acceptBusyMs: 4000, // working this long after Enter = it took the message
  quietMs: 1500, // quiet this long after Enter = look for a draft
  watchMs: 15000,
  retries: 2
}

// The end of the message is still in the last lines on screen.
export function draftVisible(pane, text) {
  if (!pane || !pane.screenText) return false
  const tail = String(text || '').replace(/\s+/g, ' ').trim().slice(-24)
  if (tail.length < 8) return false
  return pane.screenText(4).replace(/\s+/g, ' ').includes(tail)
}

async function watchAfterEnter(id, text, d) {
  let busyFor = 0
  let quietFor = 0
  for (let t = d.cfg.stepMs; t <= d.cfg.watchMs; t += d.cfg.stepMs) {
    await d.sleep(d.cfg.stepMs)
    const pane = d.getPane(id)
    if (!pane) return 'gone'
    // It asks to approve something: it is acting on the message.
    if (d.awaitingApproval(id)) return 'accepted'
    if (d.isBusy(id)) {
      busyFor += d.cfg.stepMs
      quietFor = 0
      if (busyFor >= d.cfg.acceptBusyMs) return 'accepted'
    } else {
      quietFor += d.cfg.stepMs
      busyFor = 0
      if (quietFor >= d.cfg.quietMs) return draftVisible(pane, text) ? 'draft' : 'unknown'
    }
  }
  return busyFor >= d.cfg.acceptBusyMs ? 'accepted' : 'unknown'
}

export async function pasteAndConfirm(id, text, deps) {
  const d = { ...deps, cfg: { ...DELIVER, ...(deps.cfg || {}) } }
  let pane = d.getPane(id)
  if (!pane) return 'failed'
  if (d.awaitingApproval(id)) return 'requeue'
  // A message that waits for a quiet agent: checked again right before it is
  // typed (the agent may have started working meanwhile).
  if (d.waitIdle && d.isBusy(id)) return 'requeue'
  // The user is typing in this pane: never type into their line.
  if (d.userTyping && d.userTyping(id)) return 'requeue'
  // The message's own condition (e.g. a wake-up: the user is not there).
  if (d.guard && !d.guard(id)) return 'requeue'
  // From here on some text may be in the agent's terminal (which outlives a
  // reload): anything that goes wrong is 'unconfirmed', never 'failed', so
  // the message is not pasted there a second time.
  try {
    pane.paste(text)
  } catch {
    return 'unconfirmed'
  }
  await d.sleep(d.cfg.settleMs)
  for (let tries = 0; ; tries++) {
    pane = d.getPane(id)
    if (!pane) return 'unconfirmed'
    // Never press Enter into an approval prompt, nor on a line the user
    // started typing into meanwhile (it would send their text).
    if (d.awaitingApproval(id)) return 'unconfirmed'
    if (d.userTyping && d.userTyping(id)) return 'unconfirmed'
    if (d.guard && !d.guard(id)) return 'unconfirmed'
    try {
      pane.submit()
    } catch {
      return 'unconfirmed'
    }
    const seen = await watchAfterEnter(id, text, d)
    if (seen === 'accepted') return 'confirmed'
    if (seen === 'draft' && tries < d.cfg.retries) continue
    return 'unconfirmed'
  }
}
