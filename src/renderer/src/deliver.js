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
//      Orca's image send, MIT, Copyright (c) 2026 Lovecast Inc.). Where the
//      pane reads its input's images (pane.imageMarkers() -> count | null:
//      Claude Code, OpenClaude, Codex), each path must show as one more
//      "[Image #N]" before the next one or the text goes; one that does not
//      within imageWaitMs stops the delivery, unconfirmed, Enter never
//      pressed. Elsewhere each path gets imageSettleMs,
//      command: optional 'paste' | 'type' (a slash command from that chat
//      view: pasted, or typed key by key with pane.typeKeys for Codex, which
//      takes a fast write as pasted prose; Enter is pressed once and that is
//      all: a command starts no turn to watch),
//      taken(id, at): optional, its own hooks show it took a message whose
//      Enter was pressed at `at` (agentStatus.js agentTookMessage),
//      submitted({ at, wasBusy }): optional, told when Enter is pressed,
//      stopped(why): optional, told when it ends unconfirmed before any Enter
//      ('image': an image never showed in its input; 'noEnter': the user's
//      keys, an approval or its pane came in first),
//      now(): optional clock }
// A pane's agentObservation().input ('empty' | 'draft') is evidence too: the
// pasted text was in its input before Enter and is gone after it.
// -> 'confirmed' | 'unconfirmed' | 'requeue' (approval prompt before the
//    paste) | 'failed' (no pane: nothing was typed)

export const DELIVER = {
  settleMs: 500, // between paste and Enter
  imageSettleMs: 500, // after each pasted image, for an agent whose input is not read
  imageMinMs: 200, // after each pasted image at least, its marker seen or not
  imageWaitMs: 5000, // its "[Image #N]" not shown by then: stop, no Enter
  imageRetryMs: 1500, // not shown by then and the path still plain text: pasted again
  imageRetries: 2,
  imagePollMs: 100,
  stepMs: 500,
  acceptBusyMs: 4000, // working this long after Enter = it took the message
  quietMs: 1500, // quiet this long after Enter = look for a draft
  evidenceMs: 6000, // no draft left: its hooks may still tell, this long
  watchMs: 15000,
  retries: 2
}

// A message that waits for a quiet agent, just after one was taken: the
// agent may not show it works yet (Codex reports its turn a moment after
// Enter), so quiet alone is not enough. p: { at (its Enter), sawBusy }, kept
// by the caller between checks; busy: the agent works now; endedAt: when its
// hooks last saw a turn end (or null). -> true: wait. Over after it worked
// and stopped, a turn ended since, or maxMs without seeing it work.
export function turnStarting(p, { busy, endedAt = null, now = Date.now(), maxMs = 20000 }) {
  if (!p) return false
  if (Number.isFinite(endedAt) && endedAt >= p.at) return false
  if (busy) {
    p.sawBusy = true
    return true
  }
  return !p.sawBusy && now - p.at < maxMs
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

// How many images its input shows ("[Image #N]"), or null: not known.
function markersOf(pane) {
  try {
    const n = pane && typeof pane.imageMarkers === 'function' ? pane.imageMarkers() : null
    return Number.isInteger(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

// After a pasted image path: its pane once the agent shows it as one more
// image in its input (or, where that is not read, after imageSettleMs), or
// a reason to stop here, nothing more typed and Enter not pressed: 'image'
// (it never showed) or 'noEnter' (the pane is gone, an approval or the
// user's keys came in).
async function imageTaken(id, before, d, waitMs = d.cfg.imageWaitMs) {
  let waited = 0
  for (;;) {
    const step = before === null ? d.cfg.imageSettleMs : waited < d.cfg.imageMinMs ? d.cfg.imageMinMs : d.cfg.imagePollMs
    await d.sleep(step)
    waited += step
    const pane = d.getPane(id)
    if (!pane) return 'noEnter'
    if (d.awaitingApproval(id) || (d.userTyping && d.userTyping(id))) return 'noEnter'
    if (before === null) return pane
    const now = markersOf(pane)
    if (now !== null && now > before) return pane
    if (waited >= waitMs) return 'image'
  }
}

// The pasted path is still there as plain text at the end of its input (the
// agent did not take it as an image): its last characters on the last lines.
function pathShown(pane, file) {
  try {
    const tail = String(file).replace(/\s+/g, '').slice(-24)
    return tail.length >= 8 && String(pane.screenText(8) || '').replace(/\s+/g, '').includes(tail)
  } catch {
    return false
  }
}

export async function pasteAndConfirm(id, text, deps) {
  const d = { ...deps, cfg: { ...DELIVER, ...(deps.cfg || {}) } }
  // Unconfirmed before Enter was ever pressed: said why.
  const stop = (why) => {
    try {
      if (d.stopped) d.stopped(why)
    } catch {
      /* only a note */
    }
    return 'unconfirmed'
  }
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
    // One image at a time: the agent turns each pasted path into its image
    // ("[Image #1]") a moment later; a second path pasted meanwhile is lost.
    for (const [i, file] of images.entries()) {
      for (let attempt = 0; ; attempt++) {
        const before = markersOf(pane)
        // A space apart: a path never joins the one before it (not needed
        // after an image the agent already shows as "[Image #N]").
        if (i > 0 && before === null) pane.paste(' ')
        pane.paste(file)
        // Pasted again only where the pane can erase it (Codex): elsewhere a
        // slow image (a big screenshot) gets the whole wait.
        const last = before === null || attempt >= d.cfg.imageRetries || typeof pane.erase !== 'function'
        const next = await imageTaken(id, before, d, last ? d.cfg.imageWaitMs : d.cfg.imageRetryMs)
        if (typeof next !== 'string') {
          pane = next
          break
        }
        if (next !== 'image' || last) return stop(next)
        // Codex on Windows sees a paste as typed keys and now and then
        // misses that they were one (the path stays plain text): erased,
        // exactly what was pasted, and pasted again. Only when the path is
        // what ends its input, and never if anything else came in.
        // A beat first: the image may show just after the wait (the screen
        // lags the terminal). Taken, it is never erased (the backspaces would
        // eat it and the images before it), nor called missing.
        await d.sleep(d.cfg.imagePollMs)
        pane = d.getPane(id)
        if (!pane) return stop('image')
        const late = markersOf(pane)
        if (late !== null && late > before) break
        if (!pathShown(pane, file) || late !== before) return stop('image')
        pane.erase(file.length)
        await d.sleep(d.cfg.imageMinMs)
        pane = d.getPane(id)
        if (!pane || pathShown(pane, file) || markersOf(pane) !== before) return stop('image')
        if (d.awaitingApproval(id) || (d.userTyping && d.userTyping(id))) return stop('noEnter')
      }
    }
    // The text after its images, one space apart (it never joins a path).
    const body = images.length && text ? ` ${text}` : text
    if (d.command === 'type' && typeof pane.typeKeys === 'function') await pane.typeKeys(body)
    else if (body) pane.paste(body)
  } catch {
    return stop('noEnter')
  }
  await d.sleep(d.cfg.settleMs)
  for (let tries = 0; ; tries++) {
    pane = d.getPane(id)
    const held = (why) => (tries === 0 ? stop(why) : 'unconfirmed')
    if (!pane) return held('noEnter')
    // Never press Enter into an approval prompt, nor on a line the user
    // started typing into meanwhile (it would send their text).
    if (d.awaitingApproval(id)) return held('noEnter')
    if (d.userTyping && d.userTyping(id)) return held('noEnter')
    if (d.guard && !d.guard(id)) return held('noEnter')
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
