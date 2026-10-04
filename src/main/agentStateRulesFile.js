// The user's agent-state rules override (agent-state-rules.json in Tessel's
// user data folder): read, checked (src/shared/agentStateRules.js), sent to
// the renderer, and read again whenever it changes. The renderer never reads
// the file. A file with an error is ignored: a log line says why, and the
// renderer shows it (a notice, and Settings > Agents > Detection rules).
// After the reference app's agent-state-rules live update (MIT, Copyright (c)
// 2026 Lovecast Inc.), local file only: nothing is downloaded.
import fs from 'fs'
import { basename, dirname } from 'path'
import { OVERRIDE_TEMPLATE, describeRuleError, overrideSize, parseJsonc, validateOverride } from '../shared/agentStateRules'
import { t } from './i18n'

// A rules file larger than this is refused unread (a real one is a few KB).
export const MAX_RULES_FILE_BYTES = 256 * 1024

// -> { state: 'builtin' | 'override' | 'invalid', reason, problem, file, size, override }
// problem: why the file is refused, a code with its values
// (agentStateRules.js describeRuleError): the window says it in its own
// language. reason: the same in main's language.
export function readRulesFile(file, { knownAgents = null, fsApi = fs } = {}) {
  const base = { state: 'builtin', reason: '', problem: null, file, size: 0, override: null }
  const invalid = (problem) => ({ ...base, state: 'invalid', problem, reason: describeRuleError(problem, t) })
  let text
  try {
    const stat = fsApi.statSync(file)
    if (stat.size > MAX_RULES_FILE_BYTES) return invalid({ code: 'tooLarge', kb: MAX_RULES_FILE_BYTES / 1024 })
    text = fsApi.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return base
    return invalid({ code: 'unreadable', detail: String(err?.message || err) })
  }
  let value
  try {
    value = parseJsonc(text)
  } catch (err) {
    return invalid({ code: 'badJson', detail: String(err?.message || err) })
  }
  const checked = validateOverride(value, { knownAgents })
  if (!checked.ok) return invalid(checked.error)
  return { ...base, state: 'override', size: overrideSize(checked.override), override: checked.override }
}

// send(payload): to the renderer ('agentRules:changed'). watch: fs.watch.
export function createAgentStateRulesFile({
  file,
  knownAgents = null,
  send = () => {},
  log = null,
  watch = fs.watch,
  fsApi = fs,
  debounceMs = 200
}) {
  let current = readRulesFile(file, { knownAgents, fsApi })
  let watcher = null
  let timer = null
  const key = (p) => JSON.stringify([p.state, p.problem, p.override])

  function report(p) {
    if (p.state === 'invalid') log?.warn?.('agent-rules', `${file} ignored, the built-in rules stay in use: ${describeRuleError(p.problem)}`)
    else if (p.state === 'override') log?.info?.('agent-rules', `${file} in use (${p.size} rule change(s))`)
    else log?.info?.('agent-rules', 'built-in rules in use (no rules file)')
  }

  function reload() {
    timer = null
    const next = readRulesFile(file, { knownAgents, fsApi })
    if (key(next) === key(current)) return current
    current = next
    report(current)
    try {
      send(current)
    } catch {
      /* a window being torn down */
    }
    return current
  }

  return {
    current: () => current,
    reload,
    start() {
      report(current)
      if (watcher) return
      // The folder, not the file: it may not exist yet, and editors save by
      // replacing it.
      try {
        const name = basename(file).toLowerCase()
        watcher = watch(dirname(file), { persistent: false }, (_event, changed) => {
          if (changed && String(changed).toLowerCase() !== name) return
          clearTimeout(timer)
          timer = setTimeout(reload, debounceMs)
        })
        watcher?.on?.('error', () => {})
      } catch (err) {
        log?.warn?.('agent-rules', `cannot watch ${file}: ${err?.message || err}`)
      }
    },
    stop() {
      clearTimeout(timer)
      timer = null
      try {
        watcher?.close?.()
      } catch {
        /* already closed */
      }
      watcher = null
    },
    // "Open rules file": creates it with the commented example when missing.
    // -> the file's path.
    ensureFile() {
      try {
        fsApi.writeFileSync(file, OVERRIDE_TEMPLATE, { encoding: 'utf8', flag: 'wx' })
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err
      }
      return file
    }
  }
}
