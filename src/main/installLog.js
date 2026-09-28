// Installs run from Tessel (an agent, a tool from Tools) are recorded: the
// pane's output goes to <logs>/installs/<name>-<date>.log, and the end is
// told to the window: the command line prints a marker when the install
// steps succeed or fail (see installChain in shellChain.js). The log can be
// opened from the failure message and attached to a bug report.
import fs from 'fs'
import os from 'os'
import { join } from 'path'

export const MARK_OK = 'TESSEL-INSTALL-OK'
export const MARK_FAILED = 'TESSEL-INSTALL-FAILED'
const MAX_MS = 45 * 60 * 1000 // no end seen by then: closed as unknown
// Files in use by a running program (Windows): npm's EBUSY/EPERM when it
// replaces a CLI whose .exe is running. Told with the result (locked), so an
// agent update can stop those agents safely and try again.
export const LOCKED_OUTPUT = /\bEBUSY\b|\bEPERM\b|resource busy or locked|being used by another process/i

// Terminal output as plain text: no colors, cursor moves or titles.
export function plainText(data) {
  return String(data || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (titles, links)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI (colors, moves)
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r(?!\n)/g, '\n')
}

function safeName(s) {
  return (
    String(s || 'install')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'install'
  )
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// dir: where logs go; notify({ paneId, name, ok, reason, file }) when one ends.
export function createInstallLogs({ dir, notify, appVersion = '' }) {
  const active = new Map() // paneId -> { file, name, tail, timer }

  function write(file, text) {
    try {
      fs.appendFileSync(file, text)
    } catch {
      /* disk full or folder gone: the install goes on */
    }
  }

  function finish(paneId, ok, reason) {
    const a = active.get(paneId)
    if (!a) return
    active.delete(paneId)
    clearTimeout(a.timer)
    const verdict = ok === true ? 'SUCCEEDED' : ok === false ? 'FAILED' : 'UNKNOWN'
    write(a.file, `\n\n===== ${verdict}${reason ? ` (${reason})` : ''} at ${new Date().toISOString()} =====\n`)
    notify({ paneId, name: a.name, ok, reason: reason || '', file: a.file, ...(ok !== true && a.locked ? { locked: true } : {}) })
  }

  return {
    // -> { file } or { error }
    start({ paneId, name, shell, steps }) {
      if (typeof paneId !== 'string' || !paneId) return { error: 'No pane.' }
      if (active.has(paneId)) finish(paneId, null, 'another run started in this pane')
      const folder = join(dir, 'installs')
      const file = join(folder, `${safeName(name)}-${stamp()}.log`)
      try {
        fs.mkdirSync(folder, { recursive: true })
        fs.writeFileSync(
          file,
          [
            `Tessel ${appVersion} install log`,
            `What:    ${name}`,
            `When:    ${new Date().toISOString()}`,
            `Windows: ${os.release()} ${os.arch()}`,
            `Shell:   ${shell || '?'}`,
            'Steps:',
            ...(Array.isArray(steps) ? steps : [steps]).filter(Boolean).map((s) => `  ${s}`),
            '',
            '===== Output =====',
            ''
          ].join('\n')
        )
      } catch (err) {
        return { error: err.message }
      }
      const timer = setTimeout(() => finish(paneId, null, 'no end seen after 45 minutes'), MAX_MS)
      if (timer.unref) timer.unref()
      active.set(paneId, { file, name: String(name || ''), tail: '', timer })
      return { file }
    },
    onData(paneId, data) {
      const a = active.get(paneId)
      if (!a) return
      const text = plainText(data)
      write(a.file, text)
      // A marker may arrive cut in two chunks: look in the end of the last
      // one plus this one.
      const look = a.tail + text
      a.tail = look.slice(-64)
      if (!a.locked && LOCKED_OUTPUT.test(look)) a.locked = true
      const ok = look.indexOf(MARK_OK)
      const bad = look.indexOf(MARK_FAILED)
      if (ok >= 0 && (bad < 0 || ok < bad)) finish(paneId, true)
      else if (bad >= 0) finish(paneId, false)
    },
    onExit(paneId, exitCode) {
      if (active.has(paneId)) finish(paneId, false, `the terminal closed (exit code ${exitCode})`)
    },
    isLog(file) {
      const folder = join(dir, 'installs')
      return typeof file === 'string' && file.startsWith(folder) && file.endsWith('.log') && !file.includes('..')
    }
  }
}
