// Closing the main window quits Tessel and stops every terminal and agent.
// Before it closes (the window's ×, Alt+F4, the taskbar's Close), the page is
// asked first: it checks unsaved editor files and running agents or terminals
// (Settings > General) and answers "close" (allow) or nothing (Cancel).
//
// Quitting is never held up when:
// - the page said yes already (allow), or the app is quitting (an update
//   install, a second copy exiting: before-quit / before-quit-for-update);
// - Windows is signing out or shutting down (query-session-end / session-end);
// - the page cannot answer (crashed, loading, unresponsive);
// - the page did not even say it got the question within timeoutMs.
// Once the page says it got the question (ack), its dialog may stay open as
// long as the user wants: Cancel just leaves the window open.

export const CLOSE_ACK_TIMEOUT_MS = 4000
// A shutdown another program cancelled: asking again after this long.
export const SESSION_END_RESET_MS = 60000

// Should this close wait for the page's answer?
export function shouldAskBeforeClose(s) {
  if (!s) return false
  if (s.allowed || s.quitting || s.sessionEnding) return false
  if (s.crashed || s.loading || s.unresponsive) return false
  return true
}

export function createCloseGuard({
  isQuitting = () => false,
  log = null,
  timeoutMs = CLOSE_ACK_TIMEOUT_MS,
  sessionResetMs = SESSION_END_RESET_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let allowed = false
  let sessionEnding = false
  let unresponsive = false
  let ackTimer = null
  let sessionTimer = null

  function note(text) {
    if (log && log.info) log.info('window', text)
  }
  function stopAckTimer() {
    if (ackTimer) clearTimer(ackTimer)
    ackTimer = null
  }
  function closeNow(win) {
    allowed = true
    stopAckTimer()
    if (win && !win.isDestroyed()) win.close()
  }

  return {
    // The window's 'close' event. Returns true when the close waits for the page.
    onClose(event, win) {
      const wc = win && !win.isDestroyed() ? win.webContents : null
      const ask = shouldAskBeforeClose({
        allowed,
        quitting: !!isQuitting(),
        sessionEnding,
        crashed: !wc || wc.isDestroyed() || wc.isCrashed(),
        loading: !!wc && !wc.isDestroyed() && wc.isLoading(),
        unresponsive
      })
      if (!ask) {
        stopAckTimer()
        return false
      }
      event.preventDefault()
      wc.send('editor:confirmClose')
      if (!ackTimer) {
        ackTimer = setTimer(() => {
          ackTimer = null
          note('the page did not answer the close: closing')
          closeNow(win)
        }, timeoutMs)
        if (ackTimer && ackTimer.unref) ackTimer.unref()
      }
      return true
    },
    // The page got the question (its dialog may now take its time).
    ack() {
      stopAckTimer()
    },
    // The page said yes: close for real.
    allow(win) {
      closeNow(win)
    },
    // Windows is signing out or shutting down: never hold the window.
    sessionEnding() {
      sessionEnding = true
      stopAckTimer()
      if (sessionTimer) clearTimer(sessionTimer)
      sessionTimer = setTimer(() => {
        sessionTimer = null
        sessionEnding = false
      }, sessionResetMs)
      if (sessionTimer && sessionTimer.unref) sessionTimer.unref()
    },
    setUnresponsive(value) {
      unresponsive = !!value
    },
    // A page reloaded or gone: a question it never answered is dropped.
    pageGone() {
      stopAckTimer()
      unresponsive = false
    },
    get allowed() {
      return allowed
    }
  }
}
