// Claude Code's /model saves the pick as the default model of every new
// session ("model" in ~/.claude/settings.json). A model picked in Tessel is
// for that pane's session only: once Claude Code writes the pick, the default
// it had is put back (the key removed when there was none). The rest of the
// file is kept as Claude Code wrote it.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { writeFileAtomic } from './safeJson'

export function claudeSettingsFile(home = os.homedir()) {
  return join(home, '.claude', 'settings.json')
}

// -> { data, text, has, model } | { missing: true } | null (unreadable or not an object)
function readSettings(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return err && err.code === 'ENOENT' ? { missing: true } : null
  }
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    const has = Object.prototype.hasOwnProperty.call(data, 'model')
    return { data, text, has, model: has ? data.model : undefined }
  } catch {
    return null
  }
}

const sameDefault = (a, b) => a.has === b.has && JSON.stringify(a.model) === JSON.stringify(b.model)

let active = null // one hold at a time: two picks in a row keep the first default

// Starts watching for the pick being saved. -> { stop } (stops watching
// without changing anything). Nothing is ever written when the file could not
// be read at the start, or when it changes in another way than its "model".
export function holdClaudeDefaultModel({
  file = claudeSettingsFile(),
  timeoutMs = 20000,
  intervalMs = 250,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (active && active.file === file) {
    active.extend(timeoutMs)
    return { stop: active.stop }
  }
  const start = readSettings(file)
  if (!start) return { stop() {} }
  const before = start.missing ? { has: false, model: undefined } : start
  let left = Math.ceil(timeoutMs / intervalMs)
  let timer = null
  const hold = {
    file,
    extend(ms) {
      left = Math.max(left, Math.ceil(ms / intervalMs))
    },
    stop() {
      if (timer) clearTimer(timer)
      timer = null
      if (active === hold) active = null
    }
  }
  const tick = () => {
    timer = null
    const now = readSettings(file)
    if (now && !now.missing && !sameDefault(now, before)) {
      const data = { ...now.data }
      if (before.has) data.model = before.model
      else delete data.model
      const eol = /\r\n/.test(now.text) ? '\r\n' : '\n'
      let text = JSON.stringify(data, null, 2)
      if (eol !== '\n') text = text.replace(/\n/g, eol)
      if (/\r?\n$/.test(now.text)) text += eol
      try {
        writeFileAtomic(file, text)
      } catch {
        // left as Claude Code wrote it
      }
      hold.stop()
      return
    }
    if (--left <= 0) return hold.stop()
    timer = setTimer(tick, intervalMs)
  }
  active = hold
  timer = setTimer(tick, intervalMs)
  return { stop: hold.stop }
}
