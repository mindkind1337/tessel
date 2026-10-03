// The window's page (its renderer process) recovers when it crashes.
//
// The terminals live in the terminal host (ptyHost.js), not in the page, so a
// crashed page loses nothing that matters: reloading it restores the layout
// and re-attaches every terminal (pty:attach replays its output). So a page
// that dies for any reason but a clean exit is reloaded on its own, with two
// limits:
// - a crash-loop breaker: after 3 reloads within 60 s, it stops and asks
//   (Reload / Quit) instead of reloading forever;
// - on Windows, a second out-of-memory crash while the PC is low on free
//   memory asks too, and says to close apps: reloading would only run out of
//   memory again.
// Reloading never touches the terminal host; only Quit (the user's choice)
// stops it, the way closing the window does.
//
// After renderer-recovery-circuit-breaker.ts, low-commit-oom-recovery-gate.ts,
// renderer-recovery-prompt.ts and main-window-focus-lifecycle.ts
// (MIT, Copyright (c) 2026 Lovecast Inc.).

import os from 'os'
import { t as translate } from './i18n'

// After renderer-recovery-circuit-breaker.ts: 3 reloads in 60 s is well above
// any single transient crash but far below a runaway loop.
export const RECOVERY_WINDOW_MS = 60_000
export const RECOVERY_MAX_RELOADS = 3
// After low-commit-oom-recovery-gate.ts: a repeat out-of-memory crash within
// 5 minutes, with under 512 MB free, asks instead of reloading.
export const LOW_MEMORY_REPEAT_OOM_WINDOW_MS = 5 * 60_000
export const LOW_MEMORY_FREE_MB_THRESHOLD = 512
// The reload waits a moment after the crash (as in the reference).
export const RECOVERY_RELOAD_DELAY_MS = 250

// Reasons a page dies that call for a reload: every crash, never a clean exit.
// integrity-failure: Chromium no longer trusts the page's code, so a reload
// cannot safely recover it.
const RECOVERABLE_REASONS = new Set(['abnormal-exit', 'crashed', 'killed', 'launch-failed', 'memory-eviction', 'oom'])

// Should this render-process-gone be recovered by a reload? A page 'killed'
// while it was navigating (a reload under way) is the old page torn down,
// not a crash.
export function shouldRecoverRenderer(details, { navigating = false } = {}) {
  if (!details || !RECOVERABLE_REASONS.has(details.reason)) return false
  if (details.reason === 'killed' && navigating) return false
  return true
}

// Counts recent automatic reloads in a rolling window. Not reset when the page
// finishes loading: a crash loop loads fine on every cycle before it dies, so
// a load-based reset would never let it trip. Old reloads age out instead.
// After RendererRecoveryCircuitBreaker (renderer-recovery-circuit-breaker.ts).
export function createRecoveryBreaker({ windowMs = RECOVERY_WINDOW_MS, maxReloads = RECOVERY_MAX_RELOADS } = {}) {
  let attempts = []
  const prune = (now) => {
    const cutoff = now - windowMs
    attempts = attempts.filter((at) => at > cutoff)
  }
  return {
    recentCount(now) {
      prune(now)
      return attempts.length
    },
    // Records a reload at `now`; { allowed: false } once maxReloads happened
    // within the window (the caller then stops reloading on its own).
    registerAttempt(now) {
      prune(now)
      if (attempts.length >= maxReloads) return { allowed: false, recentCount: attempts.length }
      attempts.push(now)
      return { allowed: true, recentCount: attempts.length }
    },
    // After a reload the user asked for: a fresh budget.
    reset() {
      attempts = []
    }
  }
}

function freeMegabytes(freemem) {
  try {
    const bytes = freemem()
    return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes / (1024 * 1024)) : null
  } catch {
    return null
  }
}

// Decides when a reload would run straight back into an out-of-memory crash:
// on Windows, an 'oom' death that follows another recovered one within 5
// minutes while free memory is under 512 MB. Read at crash time, after the
// dead page gave its memory back, so it can only over-report free memory and
// miss a prompt, never ask for nothing.
// After createLowCommitOomRecoveryGate (low-commit-oom-recovery-gate.ts); the
// reference reads Windows' commit (page file), Node gives os.freemem().
export function createLowMemoryGate({
  platform = process.platform,
  freemem = os.freemem,
  totalmem = os.totalmem,
  repeatWindowMs = LOW_MEMORY_REPEAT_OOM_WINDOW_MS,
  thresholdMB = LOW_MEMORY_FREE_MB_THRESHOLD
} = {}) {
  let previousOomAt = null
  return {
    // A verdict { freeMB, totalMB, sincePreviousOomMs } when the user should
    // be asked, null when a reload is fine.
    assess(details, now) {
      const previous = previousOomAt
      if (
        platform !== 'win32' ||
        !details ||
        details.reason !== 'oom' ||
        previous === null ||
        !Number.isFinite(now) ||
        now <= previous ||
        now - previous > repeatWindowMs
      )
        return null
      const freeMB = freeMegabytes(freemem)
      if (freeMB === null || freeMB >= thresholdMB) return null
      return { freeMB, totalMB: freeMegabytes(totalmem), sincePreviousOomMs: now - previous }
    },
    // Only once the death is really recovered, so a crash that was not (the
    // window closing) cannot start the repeat window.
    recordRecoveredDeath(details, goneAt) {
      if (details && details.reason === 'oom') previousOomAt = goneAt
    }
  }
}

// The question shown instead of another reload: { title, message, detail,
// buttons } for the cause ('crash-loop', 'launch-failed', 'low-memory').
// After renderer-recovery-prompt.ts.
export function recoveryPromptContent({ cause, recentCount = 0, freeMB = 0 }, t = translate) {
  const keepRunning = t(
    'main.rendererRecovery.keepRunning',
    'Your terminals and agents keep running: reloading brings them back. Quitting stops them.'
  )
  const quit = t('main.rendererRecovery.quit', 'Quit')
  const title = t('main.rendererRecovery.title', 'Tessel keeps failing to load')
  if (cause === 'low-memory') {
    const detail = t(
      'main.rendererRecovery.lowMemoryDetail',
      'Windows has only {{freeMB}} MB of memory free, so the window ran out of memory again after reloading.',
      { freeMB }
    )
    const advice = t(
      'main.rendererRecovery.lowMemoryAdvice',
      'Free memory by closing apps you are not using (or some agents), then click Reload.'
    )
    return {
      title,
      message: t('main.rendererRecovery.lowMemoryMessage', 'Windows is out of memory.'),
      detail: `${detail}\n\n${advice}\n\n${keepRunning}`,
      buttons: [t('main.rendererRecovery.reload', 'Reload'), quit]
    }
  }
  if (cause === 'launch-failed') {
    const retried = t('main.rendererRecovery.launchFailedDetail', 'Tessel retried {{recoveryCount}} times without success.', {
      recoveryCount: recentCount
    })
    const advice = t(
      'main.rendererRecovery.launchFailedAdvice',
      'The system refused to start it. Free up memory or close other apps, then click Try Again. If this keeps happening, reinstall Tessel.'
    )
    return {
      title,
      message: t('main.rendererRecovery.launchFailedMessage', 'Tessel could not start the process that draws its window.'),
      detail: `${retried}\n\n${advice}\n\n${keepRunning}`,
      buttons: [t('main.rendererRecovery.tryAgain', 'Try Again'), quit]
    }
  }
  const tried = t('main.rendererRecovery.crashLoopDetail', 'Tessel tried to recover {{recoveryCount}} times in a row without success.', {
    recoveryCount: recentCount
  })
  const advice = t(
    'main.rendererRecovery.crashLoopAdvice',
    'This is often a graphics-driver or installation problem. Reload to try again, or quit and start Tessel again.'
  )
  return {
    title,
    message: t('main.rendererRecovery.crashLoopMessage', 'The window crashed repeatedly and stopped reloading on its own.'),
    detail: `${tried}\n\n${advice}\n\n${keepRunning}`,
    buttons: [t('main.rendererRecovery.reload', 'Reload'), quit]
  }
}

// Wires recovery into the window. deps:
// - win: the BrowserWindow (its webContents' render-process-gone,
//   did-start-navigation, did-finish-load, did-fail-load; its 'closed');
// - loadPage(): loads the window's page again (the same page as at start);
// - isQuitting(): true while the app quits (never reload then);
// - showMessageBox(win, opts) -> Promise<{ response }>;
// - quit(): the app's normal quit;
// - log, platform, freemem, totalmem, now, setTimer, clearTimer, delayMs, t.
// Returns { dispose, state() }.
export function installRendererRecovery({
  win,
  loadPage,
  isQuitting = () => false,
  showMessageBox,
  quit,
  log = null,
  platform = process.platform,
  freemem = os.freemem,
  totalmem = os.totalmem,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  delayMs = RECOVERY_RELOAD_DELAY_MS,
  t = translate
}) {
  const wc = win.webContents
  const breaker = createRecoveryBreaker()
  const lowMemory = createLowMemoryGate({ platform, freemem, totalmem })
  let timer = null
  let prompting = false
  let navigating = false
  let disposed = false

  const gone = () => disposed || win.isDestroyed() || wc.isDestroyed()
  const stopped = () => gone() || !!isQuitting()

  function reload(why) {
    if (stopped()) return
    log?.info?.('window', `reloading the window's page (${why})`)
    try {
      Promise.resolve(loadPage()).catch((err) => log?.error?.('window', `the page did not load again: ${err?.message || err}`))
    } catch (err) {
      log?.error?.('window', `the page did not load again: ${err?.message || err}`)
    }
  }

  // One question at a time; asked again while the app is not quitting.
  async function ask(cause, info) {
    if (prompting || stopped()) return
    prompting = true
    try {
      const content = recoveryPromptContent({ cause, ...info }, t)
      log?.error?.('window', `renderer recovery stopped (${cause}): asking`)
      const { response } = await showMessageBox(win, {
        type: 'error',
        title: content.title,
        message: content.message,
        detail: content.detail,
        buttons: content.buttons,
        defaultId: 0,
        // Escape reloads instead of ending the session.
        cancelId: 0,
        noLink: true
      })
      if (stopped()) return
      if (response === content.buttons.length - 1) {
        log?.info?.('window', 'renderer recovery: the user chose to quit')
        quit()
        return
      }
      breaker.reset()
      reload('asked')
    } catch (err) {
      log?.error?.('window', `renderer recovery question failed: ${err?.message || err}`)
    } finally {
      prompting = false
    }
  }

  function onGone(_event, details) {
    if (timer || prompting || stopped()) return
    if (!shouldRecoverRenderer(details, { navigating })) return
    const goneAt = now()
    // Read at crash time: later, other programs may have taken the memory back.
    const lowMem = lowMemory.assess(details, goneAt)
    timer = setTimer(() => {
      timer = null
      if (stopped()) return
      lowMemory.recordRecoveredDeath(details, goneAt)
      if (lowMem) {
        // A reload would run out of memory again: only the user can free it.
        void ask('low-memory', { freeMB: lowMem.freeMB, recentCount: breaker.recentCount(now()) })
        return
      }
      const attempt = breaker.registerAttempt(now())
      if (!attempt.allowed) {
        void ask(details.reason === 'launch-failed' ? 'launch-failed' : 'crash-loop', { recentCount: attempt.recentCount })
        return
      }
      reload(`after a crash: ${details.reason}, ${attempt.recentCount}/${RECOVERY_MAX_RELOADS} in ${RECOVERY_WINDOW_MS / 1000} s`)
    }, delayMs)
  }
  function onStartNavigation(details) {
    if (details && details.isMainFrame && !details.isSameDocument) navigating = true
  }
  function onFinishLoad() {
    navigating = false
    // The page is back (a reload of its own got there first).
    if (timer) {
      clearTimer(timer)
      timer = null
    }
  }
  function onFailLoad(_e, _code, _desc, _url, isMainFrame) {
    if (isMainFrame) navigating = false
  }

  wc.on('render-process-gone', onGone)
  wc.on('did-start-navigation', onStartNavigation)
  wc.on('did-finish-load', onFinishLoad)
  wc.on('did-fail-load', onFailLoad)

  function dispose() {
    if (disposed) return
    disposed = true
    if (timer) clearTimer(timer)
    timer = null
    if (!wc.isDestroyed()) {
      wc.removeListener('render-process-gone', onGone)
      wc.removeListener('did-start-navigation', onStartNavigation)
      wc.removeListener('did-finish-load', onFinishLoad)
      wc.removeListener('did-fail-load', onFailLoad)
    }
  }
  win.once('closed', dispose)

  return {
    dispose,
    state: () => ({ pending: !!timer, prompting, navigating, recentCount: breaker.recentCount(now()) })
  }
}
