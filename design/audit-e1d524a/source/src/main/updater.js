// Updates: checks GitHub releases (see "publish" in package.json) for a newer
// version, downloads it in the background and tells the window. Nothing is
// installed until the user clicks "Restart and update": the app then saves its
// layout and terminal output, stops the terminal host, runs the installer
// silently and relaunches, and the panes reopen where they were (agents resume
// their conversations).
//
// Only the installed app updates itself. TESSEL_UPDATE_TEST=1 lets a dev build
// check too, against dev-app-update.yml (e.g. a local test feed).
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

const FIRST_CHECK_MS = 15 * 1000
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

// GitHub gives release notes as HTML; the dialog shows plain text.
export function htmlToText(html) {
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<\/\s*(p|li|h[1-6]|ul|ol|div|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function createUpdater({ log, send, beforeInstall }) {
  const enabled = app.isPackaged || process.env.TESSEL_UPDATE_TEST === '1'
  let status = { state: enabled ? 'idle' : 'disabled', current: app.getVersion() }

  const set = (next) => {
    status = { current: app.getVersion(), ...next }
    send('update:status', status)
  }

  function notesText(notes) {
    if (Array.isArray(notes)) notes = notes.map((n) => n.note || '').join('\n\n')
    return htmlToText(typeof notes === 'string' ? notes : '')
  }

  if (enabled) {
    autoUpdater.autoDownload = true
    // Installing asks for admin rights on a per-machine install; never spring
    // that on the user when they just close the window.
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true
    autoUpdater.logger = {
      info: (m) => log.info('update', String(m)),
      warn: (m) => log.warn('update', String(m)),
      error: (m) => log.error('update', String(m)),
      debug: () => {}
    }

    autoUpdater.on('checking-for-update', () => {
      if (status.state !== 'downloading' && status.state !== 'ready') set({ state: 'checking' })
    })
    autoUpdater.on('update-not-available', () => set({ state: 'none' }))
    autoUpdater.on('update-available', (info) =>
      set({ state: 'downloading', version: info.version, percent: 0 })
    )
    autoUpdater.on('download-progress', (p) =>
      set({ state: 'downloading', version: status.version, percent: Math.round(p.percent || 0) })
    )
    autoUpdater.on('update-downloaded', (info) => {
      log.info('update', `v${info.version} downloaded, ready to install`)
      set({
        state: 'ready',
        version: info.version,
        notes: notesText(info.releaseNotes),
        date: info.releaseDate || null
      })
    })
    autoUpdater.on('error', (err) => {
      log.warn('update', `update check failed: ${err && err.message}`)
      // Keep a finished download usable even if a later check fails.
      if (status.state !== 'ready') set({ state: 'error', message: String(err && err.message) })
    })
  }

  async function check() {
    if (!enabled) return status
    if (status.state === 'downloading' || status.state === 'ready') return status
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      /* reported through the 'error' event */
    }
    return status
  }

  function start() {
    if (!enabled) return
    setTimeout(check, FIRST_CHECK_MS).unref()
    setInterval(check, CHECK_EVERY_MS).unref()
  }

  let installing = false
  async function install() {
    if (status.state !== 'ready' || installing) return false
    installing = true
    log.info('update', `installing v${status.version} and restarting`)
    try {
      await beforeInstall(status.version)
    } catch (err) {
      log.warn('update', `preparing the update: ${err.message}`)
    }
    // Silent install, then start the app again.
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
    return true
  }

  return {
    start,
    check,
    install,
    get status() {
      return status
    }
  }
}
