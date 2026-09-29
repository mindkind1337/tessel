// Agent CLI updates run in the background, in the main process: no pane.
//
// - The steps are Tessel's own constants (agentUpdates.js: `npm install -g
//   <pkg>@latest`, `claude update`). Each is split into words and every word
//   must be plain (letters, digits, @ . _ / : = + -): no shell syntax can
//   reach the command line. On Windows they run through `cmd.exe /d /s /c`
//   (npm is a .cmd script, which Node only starts through a shell), exactly
//   like the update check's own `npm ls -g` (agentUpdates.js), with the same
//   environment: the terminals' one (freshEnv in index.js: PATH as it is now
//   in the registry, without the variables of an agent session that started
//   Tessel), so npm and claude resolve to the same files as in a pane and as
//   in the check that found the update.
// - Bounded in time (10 min by default): past that, the process tree it
//   started is ended by its PID (never by image name).
// - The output goes to the same install log as a pane's
//   (<logs>/installs/Update-<name>-<date>.log, installLog.js).
// - A failure is recognised (classifyFailure): files in use, network, no
//   permission, not found, time out; the window explains it in plain words.
//
// For tests and TESSEL_AGENT_UPDATES_FAKE, `spawn` is replaced (fakeSpawn):
// nothing is ever installed by them.
import { EventEmitter } from 'events'
import { t } from './i18n'

export const UPDATE_TIMEOUT_MS = 10 * 60 * 1000
const KEEP_OUTPUT = 64 * 1024 // the end of the output, for classifyFailure

const PLAIN_WORD = /^[A-Za-z0-9@._/:=+-]+$/

// 'npm install -g --ignore-scripts pkg@latest' -> ['npm', 'install', ...];
// null when a word is not plain (never run).
export function stepArgv(step) {
  const words = String(step || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length || words.length > 16) return null
  return words.every((w) => PLAIN_WORD.test(w) && w.length <= 200) ? words : null
}

// How to start one step: { file, args }.
export function commandFor(argv, platform = process.platform) {
  if (platform === 'win32') return { file: 'cmd.exe', args: ['/d', '/s', '/c', argv.join(' ')] }
  return { file: argv[0], args: argv.slice(1) }
}

// --- Failures ---------------------------------------------------------------------
// Files in use: npm replacing a CLI whose .exe runs (EBUSY, EPERM on a rename
// or unlink), Windows' "being used by another process", claude.exe in use.
const IN_USE = /\bEBUSY\b|resource busy or locked|being used by another process|\bEPERM\b[^\n]*\b(?:rename|unlink|rmdir|scandir|lstat|chmod)\b|\.exe\b[^\n]*\b(?:in use|locked|busy)\b|\b(?:in use|is locked)\b[^\n]*\.exe\b/i
// No right to write npm's global folder (e.g. under Program Files).
const PERMISSION = /\bEACCES\b|\bEPERM\b[^\n]*\b(?:mkdir|open|symlink|copyfile|access)\b|permission denied|access is denied|requires elevation|as (?:an )?administrator|run this command again as root/i
const ANY_EPERM = /\bEPERM\b/
const NETWORK = /\bENOTFOUND\b|\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|\bENETUNREACH\b|\bEHOSTUNREACH\b|network (?:error|request|timeout)|socket hang up|\bERR_SOCKET_|UNABLE_TO_(?:GET_ISSUER_CERT|VERIFY_LEAF_SIGNATURE)|SELF_SIGNED_CERT|getaddrinfo|could not resolve host|unable to connect/i
const NOT_FOUND = /\bE404\b|404 Not Found|is not recognized as an internal or external command|command not found|spawn \S+ ENOENT|no such file or directory/i

function lineMatching(text, re) {
  const lines = String(text || '').split(/\r?\n/)
  const line = lines.find((l) => re.test(l))
  return line ? line.trim().slice(0, 240) : ''
}
function lastErrorLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const err = [...lines].reverse().find((l) => /^(npm (?:error|ERR!)|error\b|Error\b)/.test(l) && !/A complete log of this run|verbose/.test(l))
  return (err || lines[lines.length - 1] || '').slice(0, 240)
}

// -> { kind, detail }: kind 'in-use' | 'permission' | 'network' |
// 'not-found' | 'timeout' | 'failed'; detail: the line that tells it.
export function classifyFailure({ output = '', exitCode = null, timedOut = false, spawnError = null } = {}) {
  if (timedOut) return { kind: 'timeout', detail: lastErrorLine(output) }
  if (spawnError) {
    const code = spawnError.code || ''
    return { kind: code === 'ENOENT' ? 'not-found' : 'failed', detail: String(spawnError.message || code).slice(0, 240) }
  }
  const text = String(output || '')
  if (IN_USE.test(text)) return { kind: 'in-use', detail: lineMatching(text, IN_USE) }
  if (PERMISSION.test(text)) return { kind: 'permission', detail: lineMatching(text, PERMISSION) }
  // A bare EPERM on Windows is almost always a file held by a running program.
  if (ANY_EPERM.test(text)) return { kind: 'in-use', detail: lineMatching(text, ANY_EPERM) }
  if (NETWORK.test(text)) return { kind: 'network', detail: lineMatching(text, NETWORK) }
  if (NOT_FOUND.test(text)) return { kind: 'not-found', detail: lineMatching(text, NOT_FOUND) }
  // cmd's "not recognized" is exit code 9009.
  if (exitCode === 9009) return { kind: 'not-found', detail: lastErrorLine(text) }
  return { kind: 'failed', detail: lastErrorLine(text) || (exitCode != null ? t('main.agentUpdate.exitCode', 'exit code {{code}}', { code: exitCode }) : '') }
}

// --- Runner ------------------------------------------------------------------------
// deps:
//   spawn(file, args, opts) -> a child_process-like object
//   getEnv() -> the environment (freshEnv)
//   logs: installLog.js's createInstallLogs() (start / onData / end)
//   killTree(pid): end that process and everything it started (by PID)
//   cwd, platform, timeoutMs, graceMs (wait for its end after the kill),
//   log(level, text)
export function createUpdateRunner({
  spawn,
  getEnv = () => process.env,
  logs,
  killTree = () => {},
  cwd = undefined,
  platform = process.platform,
  timeoutMs = UPDATE_TIMEOUT_MS,
  graceMs = 5000,
  log = () => {}
}) {
  let current = null // { agentId }

  // One step: -> { exitCode, timedOut, spawnError }
  function runStep(argv, runId, deadline, onOutput) {
    return new Promise((resolve) => {
      const { file, args } = commandFor(argv, platform)
      let child
      try {
        child = spawn(file, args, { cwd, env: getEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        return resolve({ exitCode: null, timedOut: false, spawnError: err })
      }
      let done = false
      let timedOut = false
      const finish = (r) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ timedOut, ...r })
      }
      const left = Math.max(0, deadline - Date.now())
      const timer = setTimeout(() => {
        timedOut = true
        log('warn', `agent update ${runId}: no end after ${Math.round(timeoutMs / 1000)} s; stopping it`)
        try {
          if (child.pid) killTree(child.pid)
          else if (child.kill) child.kill()
        } catch {
          /* already gone */
        }
        // Its streams may stay open a moment; do not wait for them forever.
        setTimeout(() => finish({ exitCode: null }), graceMs)
      }, left)
      if (timer.unref) timer.unref()
      const onData = (chunk) => onOutput(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
      if (child.stdout) child.stdout.on('data', onData)
      if (child.stderr) child.stderr.on('data', onData)
      child.on('error', (err) => finish({ exitCode: null, spawnError: err }))
      child.on('close', (code) => finish({ exitCode: typeof code === 'number' ? code : null }))
    })
  }

  return {
    busy: () => (current ? current.agentId : null),
    // -> { ok, kind?, detail?, reason, file, exitCode }
    async run({ agentId, name, steps }) {
      if (current) return { ok: false, kind: 'busy', detail: '', reason: t('main.agentUpdate.beingUpdated', '{{agent}} is being updated', { agent: current.agentId }), file: null }
      const list = Array.isArray(steps) ? steps.map(String) : []
      const argvs = list.map(stepArgv)
      if (!list.length || argvs.some((a) => !a)) {
        return { ok: false, kind: 'failed', detail: t('main.agentUpdate.notCommand', 'not a command Tessel runs'), reason: t('main.agentUpdate.notCommand', 'not a command Tessel runs'), file: null }
      }
      current = { agentId }
      const runId = `agent-update-${agentId}-${Date.now()}`
      const started = logs ? logs.start({ paneId: runId, name: `Update ${name || agentId}`, shell: 'background (no pane)', steps: list }) : {}
      const file = started && started.file ? started.file : null
      let output = ''
      const onOutput = (text) => {
        output = (output + text).slice(-KEEP_OUTPUT)
        if (logs) logs.onData(runId, text)
      }
      const deadline = Date.now() + timeoutMs
      let last = { exitCode: 0, timedOut: false, spawnError: null }
      try {
        for (const argv of argvs) {
          onOutput(`\n> ${argv.join(' ')}\n`)
          last = await runStep(argv, runId, deadline, onOutput)
          if (last.timedOut || last.spawnError || last.exitCode !== 0) break
        }
      } finally {
        current = null
      }
      const ok = !last.timedOut && !last.spawnError && last.exitCode === 0
      if (ok) {
        if (logs) logs.end(runId, true, '')
        return { ok: true, reason: '', file, exitCode: 0 }
      }
      const { kind, detail } = classifyFailure({ output, ...last })
      const reason = last.timedOut
        ? t('main.agentUpdate.noEnd', 'no end after {{minutes}} min', { minutes: Math.round(timeoutMs / 60000) })
        : last.spawnError
          ? t('main.agentUpdate.couldNotStart', 'could not start: {{error}}', { error: last.spawnError.message || last.spawnError.code })
          : t('main.agentUpdate.exitCode', 'exit code {{code}}', { code: last.exitCode })
      if (logs) logs.end(runId, false, `${kind}: ${reason}`)
      return { ok: false, kind, detail, reason, file, exitCode: last.exitCode }
    }
  }
}

// A spawn that starts nothing: plays a scripted run (tests,
// TESSEL_AGENT_UPDATES_FAKE). script(file, args) -> { output, exitCode,
// delayMs, hang, error } (defaults: success, no output).
export function fakeSpawn(script = () => ({})) {
  return (file, args) => {
    const s = script(file, args) || {}
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 0
    let ended = false
    child.kill = () => {
      if (ended) return
      ended = true
      setTimeout(() => child.emit('close', null), 0)
    }
    setTimeout(() => {
      if (s.error) {
        ended = true
        return child.emit('error', Object.assign(new Error(s.error.message || 'spawn failed'), { code: s.error.code }))
      }
      if (s.output) child.stdout.emit('data', Buffer.from(String(s.output)))
      if (s.stderr) child.stderr.emit('data', Buffer.from(String(s.stderr)))
      if (s.hang) return
      ended = true
      child.emit('close', Number.isInteger(s.exitCode) ? s.exitCode : 0)
    }, Math.max(0, Number(s.delayMs) || 0))
    return child
  }
}
