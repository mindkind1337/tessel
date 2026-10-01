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
//      guard(id): optional, the message's own condition to type now,
//      images: optional image files pasted before the text (a terminal
//      agent's chat view: each path pasted on its own, as Claude Code and
//      Codex attach a pasted image path, then the text after a pause, after
//      Orca's image send, MIT, Copyright (c) 2026 Lovecast Inc.),
//      command: optional 'paste' | 'type' (a slash command from that chat
//      view: pasted, or typed key by key with pane.typeKeys for Codex, which
//      takes a fast write as pasted prose; Enter is pressed once and that is
//      all: a command starts no turn to watch),
//      taken(id, at): optional, its own hooks show it took a message whose
//      Enter was pressed at `at` (agentStatus.js agentTookMessage),
//      submitted({ at, wasBusy }): optional, told when Enter is pressed,
//      now(): optional clock }
// A pane's agentObservation().input ('empty' | 'draft') is evidence too: the
// pasted text was in its input before Enter and is gone after it.
// -> 'confirmed' | 'unconfirmed' | 'requeue' (approval prompt before the
//    paste) | 'failed' (no pane: nothing was typed)

export const DELIVER = {
  settleMs: 500, // between paste and Enter
  imageSettleMs: 300, // between pasted images and the text
  stepMs: 500,
  acceptBusyMs: 4000, // working this long after Enter = it took the message
  quietMs: 1500, // quiet this long after Enter = look for a draft
  evidenceMs: 6000, // no draft left: its hooks may still tell, this long
  watchMs: 15000,
  retries: 2
}

// The end of the message is still in the last lines on screen. Compared
// without whitespace: an agent's input box wraps a long line itself (Codex,
// Claude Code), with its own indentation, so the words can be cut anywhere.
export function draftVisible(pane, text) {
  if (!pane || !pane.screenText) return false
  const tail = String(text || '').replace(/\s+/g, '').slice(-20)
  if (tail.length < 8) return false
  return String(pane.screenText(4) || '').replace(/\s+/g, '').includes(tail)
}

// What its input line holds ('empty' | 'draft'), or null: not known.
function inputOf(pane) {
  try {
    const seen = pane && typeof pane.agentObservation === 'function' ? pane.agentObservation() : null
    return seen && (seen.input === 'empty' || seen.input === 'draft') ? seen.input : null
  } catch {
    return null
  }
}

// Evidence that the agent took the message, besides working a few seconds: a
// turn its hooks opened or ended since Enter (a fast answer, a question
// asked at once), or the text that was in its input before Enter gone. Only
// ever ends the watch: it never causes anything to be typed again.
function tookIt(id, pane, enter, d) {
  if (!enter.wasBusy && d.taken && d.taken(id, enter.at)) return true
  return enter.input === 'draft' && inputOf(pane) === 'empty'
}

async function watchAfterEnter(id, text, d, enter) {
  let busyFor = 0
  let quietFor = 0
  for (let t = d.cfg.stepMs; t <= d.cfg.watchMs; t += d.cfg.stepMs) {
    await d.sleep(d.cfg.stepMs)
    const pane = d.getPane(id)
    if (!pane) return 'gone'
    // It asks to approve something: it is acting on the message.
    if (d.awaitingApproval(id)) return 'accepted'
    if (tookIt(id, pane, enter, d)) return 'accepted'
    if (d.isBusy(id)) {
      busyFor += d.cfg.stepMs
      quietFor = 0
      if (busyFor >= d.cfg.acceptBusyMs) return 'accepted'
    } else {
      quietFor += d.cfg.stepMs
      busyFor = 0
      if (quietFor >= d.cfg.quietMs) {
        if (draftVisible(pane, text) && inputOf(pane) !== 'empty') return 'draft'
        // Nothing left in its input, nothing seen yet: its hooks reach
        // Tessel through a file, a moment later. Look a little longer.
        if (t >= d.cfg.evidenceMs) return 'unknown'
      }
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
  const images = Array.isArray(d.images) ? d.images.filter((f) => typeof f === 'string' && f) : []
  try {
    for (const file of images) pane.paste(file)
    if (images.length) {
      await d.sleep(d.cfg.imageSettleMs)
      pane = d.getPane(id)
      if (!pane) return 'unconfirmed'
    }
    // The text after its images, one space apart (it never joins a path).
    const body = images.length && text ? ` ${text}` : text
    if (d.command === 'type' && typeof pane.typeKeys === 'function') await pane.typeKeys(body)
    else if (body) pane.paste(body)
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
    const enter = { at: d.now ? d.now() : Date.now(), wasBusy: !!d.isBusy(id), input: d.command ? null : inputOf(pane) }
    try {
      pane.submit()
    } catch {
      return 'unconfirmed'
    }
    if (d.submitted) d.submitted(enter)
    if (d.command) return 'confirmed'
    const seen = await watchAfterEnter(id, text, d, enter)
    if (seen === 'accepted') return 'confirmed'
    if (seen === 'draft' && tries < d.cfg.retries) continue
    return 'unconfirmed'
  }
}
