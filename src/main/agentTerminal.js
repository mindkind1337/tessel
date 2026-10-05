// Agents running commands in terminals: the main process's side of the
// terminal tools of teamMcp/server.cjs (run_in_terminal, get_terminal_output,
// send_to_terminal, kill_terminal, terminal_last_command, terminal_selection,
// terminal_list), after Visual Studio Code's chat terminal tools (MIT,
// Copyright (c) Microsoft Corporation: src/vs/workbench/contrib/
// terminalContrib/chatAgentTools/browser/tools/runInTerminalTool.ts and the
// other tools there; the texts the agent reads follow theirs).
//
// An agent runs its commands in terminals of its own, visible panes next to
// it (on its project's SSH host through the host's signed-in connection, or
// one it names), each command approved by the user unless the user's rules
// allow it (shared/terminalRules.js); or, Tessel's own addition, in one of the
// user's terminals it names, approved once per terminal, never automatically.
//
// Who may do what (each request, in this order):
// - The request comes over the tessel command's pipe (cliServer.js: this
//   Windows user only, the per-install token) and is signed with the sending
//   pane's own team secret (teamAuth.js, team key "terminal"): an agent can
//   never act as another pane.
// - "Let agents use terminals" (Settings > Agents) is on.
// - The window says which pane (agentTerminalTargets.js): only an agent or
//   chat pane may call; another agent's pane is read-only; nothing is typed
//   while the user types in one of their terminals (user_typing).
// - The user's Stop on a terminal's "<agent> is using this terminal" badge:
//   that agent's next writes there are refused (stopped_by_user) until the
//   user allows it again.
// - A command is at most 8 KB without control characters (but new lines and
//   tabs); keys are named keys only, never paste (Ctrl+V, Shift+Insert);
//   writes are rate-limited per agent; each one is logged (the terminal's
//   badge, and a log file in Tessel's data folder).
// - A question for a secret (a password...) is never answered by an agent:
//   needs_user_input, and the user is told.
import fs from 'fs'
import { join } from 'path'
import crypto from 'crypto'
import { CliError } from './cliServer'
import { analyzeCommandLine, buildRules, rewritePwshChain, rulesOfAction, cleanRules } from '../shared/terminalRules'
import { MAX_OUTPUT_LENGTH, MAX_POLL_OUTPUT, truncateLargeOutput, truncateOutputKeepingTail, detectsSensitiveInputPrompt } from '../shared/terminalOutput'

export const TERMINAL_OPS = ['list', 'run', 'output', 'send', 'kill', 'lastCommand', 'selection']
export const MAX_COMMAND_BYTES = 8 * 1024
export const MAX_TEXT = 1000
export const RUN_MAX_TIMEOUT_MS = 120000
export const ASYNC_DEFAULT_TIMEOUT_MS = 20000
export const MAX_KEYS = 32
// Writes per agent: at most RATE_MAX in RATE_WINDOW_MS.
export const RATE_MAX = 20
export const RATE_WINDOW_MS = 10000
// The badge goes after this long without a write.
export const IDLE_MS = 60 * 1000
// The user has this long to answer an approval.
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
export const LOG_MAX_BYTES = 1024 * 1024
// Output files kept (the newest).
export const KEEP_OUTPUT_FILES = 30
// The stopped notice ("Allow again") at most once per agent and terminal in this time.
const STOPPED_NOTICE_MS = 60 * 1000

const fail = (code, message) => new CliError(code, message)

// Escape sequences and control characters out of a text (the window gives
// plain text already; this is the last guard before an answer).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[@-Z\\-_]|\x1b[ -/]*[0-~]?/g
export function stripAnsi(text) {
  return (
    String(text == null ? '' : text)
      .replace(ANSI_RE, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, '')
  )
}

// A command line an agent may type: at most 8 KB, no control characters
// but new lines and tabs. -> the line, or throws.
export function checkCommand(raw, { allowEmpty = false } = {}) {
  if (typeof raw !== 'string' || (!allowEmpty && !raw.trim())) throw fail('invalid_argument', 'Give the "command" to run.')
  if (Buffer.byteLength(raw, 'utf8') > MAX_COMMAND_BYTES) throw fail('too_large', `The command is longer than ${MAX_COMMAND_BYTES} bytes.`)
  const line = raw.replace(/\r\n?/g, '\n')
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/.test(line)) throw fail('invalid_argument', 'The command has control characters: send keys like Ctrl+C with send_to_terminal "keys".')
  return line
}
// Ctrl+C, Ctrl+D, Ctrl+\ alone (send_to_terminal "command", as VS Code takes them).
export const isCancelSignal = (s) => s === '\x03' || s === '\x04' || s === '\x1c'

// --- Named keys -> what a terminal sends -------------------------------------------
const NAMED = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  escape: '\x1b',
  esc: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  del: '\x1b[3~',
  space: ' ',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~'
}
const ARROWS = { up: 'A', down: 'B', right: 'C', left: 'D' }
const FKEYS = ['\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS', '\x1b[15~', '\x1b[17~', '\x1b[18~', '\x1b[19~', '\x1b[20~', '\x1b[21~', '\x1b[23~', '\x1b[24~']

// One key name ("Enter", "Ctrl+C", "ArrowUp", "y", "Shift+Tab", "F5") ->
// { data } or { error, code }. appCursor: the program asked for application
// cursor keys (arrows as ESC O x).
export function keyData(name, { appCursor = false } = {}) {
  const raw = String(name == null ? '' : name).trim()
  if (!raw || raw.length > 20) return { code: 'invalid_argument', error: `Not a key: "${raw.slice(0, 20)}"` }
  if ([...raw].length === 1) {
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f-\x9f]/.test(raw)) return { code: 'invalid_argument', error: 'Name control keys, e.g. "Ctrl+C".' }
    return { data: raw }
  }
  const parts = raw.split('+').map((p) => p.trim().toLowerCase())
  const key = parts.pop()
  const mods = new Set(parts)
  for (const m of mods) if (!['ctrl', 'control', 'alt', 'shift'].includes(m)) return { code: 'invalid_argument', error: `Unknown modifier in "${raw}".` }
  const ctrl = mods.has('ctrl') || mods.has('control')
  const alt = mods.has('alt')
  const shift = mods.has('shift')
  // Paste: never (the clipboard would go into the terminal).
  if ((ctrl && key === 'v') || (shift && key === 'insert')) return { code: 'reserved_key', error: `${raw} pastes the clipboard: agents cannot press it.` }
  let data = null
  if (ctrl && !shift && /^[a-z]$/.test(key)) data = String.fromCharCode(key.charCodeAt(0) - 96)
  else if (!ctrl && alt && !shift && /^[a-z0-9]$/.test(key)) data = `\x1b${key}`
  else if (mods.size === 0) {
    const arrow = ARROWS[key] || ARROWS[key.replace(/^arrow/, '')]
    if (arrow) data = `${appCursor ? '\x1bO' : '\x1b['}${arrow}`
    else if (NAMED[key]) data = NAMED[key]
    else if (/^f([1-9]|1[0-2])$/.test(key)) data = FKEYS[Number(key.slice(1)) - 1]
  } else if (shift && mods.size === 1 && key === 'tab') data = '\x1b[Z'
  if (data == null) return { code: 'invalid_argument', error: `Unknown key "${raw}": use Enter, Tab, Escape, Backspace, Delete, Space, arrows (Up, Down, Left, Right), Home, End, PageUp, PageDown, F1-F12, Ctrl+<letter>, Alt+<letter>, Shift+Tab or one character.` }
  return { data }
}

// keys: an array of names (or a string of names separated by spaces) -> the data.
export function keysData(keys, opts = {}) {
  const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? keys.split(/\s+/).filter(Boolean) : null
  if (!list || !list.length) throw fail('invalid_argument', 'Give "keys": a list of key names, e.g. ["Ctrl+C"] or ["y", "Enter"].')
  if (list.length > MAX_KEYS) throw fail('too_large', `At most ${MAX_KEYS} keys at a time.`)
  let data = ''
  for (const k of list) {
    const r = keyData(k, opts)
    if (r.error) throw fail(r.code, r.error)
    data += r.data
  }
  return { data, shown: list.map((k) => String(k).trim()).join(' ') }
}

function terminalLine(t) {
  const kind = t.kind === 'agent' ? `agent${t.agentName ? ` ${t.agentName}` : ''}, read-only` : t.own ? `your terminal${t.host ? ` on SSH ${t.host}` : ''}` : t.host ? `SSH ${t.host}` : 'shell'
  const state = [t.busy === true ? 'busy' : t.busy === false ? 'idle' : null, t.notConnected ? 'not connected' : null, t.exited ? 'exited' : null, !t.own && t.approved ? 'you may write' : null, t.stopped ? 'stopped by the user' : null]
    .filter(Boolean)
    .join(', ')
  const ws = t.workspace && !t.sameWorkspace ? `  [${t.workspace}]` : ''
  return `${t.id}  #${t.num || '?'} "${t.name}"  (${kind})${state ? `  ${state}` : ''}${t.folder ? `  — ${t.folder}` : ''}${ws}`
}

// The note after a command left running (VS Code's _buildInputNeededSteeringText).
function steering(id, hung) {
  const lines = ['This note is not a signal to end the turn — pick one of the actions below and continue.']
  lines.push(`  1. If the command may still be producing output or the shell prompt has not returned, call get_terminal_output with id="${id}" to continue polling. This is the default and safest action when unsure.`)
  lines.push(
    `  2. Only if the output clearly ends with a real non-secret input prompt (Continue? (y/n), Enter selection, etc. — a normal shell prompt like \`$\` or \`#\` does NOT count), ask the user if you do not know the answer, then send it using send_to_terminal with id="${id}". Repeat one prompt at a time. NEVER send passwords, passphrases, tokens or other secrets: tell the user to type them directly into the terminal and stop.`
  )
  if (hung) lines.push(`  3. ${hung === 'timeout' ? 'A timeout' : 'No output for a while'} does not mean the command failed — call get_terminal_output with id="${id}" to continue polling. Only call kill_terminal if the command is genuinely hung and you need to retry with a different approach.`)
  return lines.join('\n')
}

// deps:
//   verify(body, paneId) -> { ok } | { unsigned } | { error }   (teamAuth, team key "terminal")
//   settings() -> { enabled, autoApprove, ignoreDefaults, userRules, workspaceRules }
//   ask(method, params, opts)  the window (cliBridge): 'terminalTarget'
//   busyOf(ids) -> Promise<{ id: bool | null }>   (local shells: a program running under it)
//   send(channel, payload)     to the window: 'terminal:agentControl', 'terminal:agentLog'
//   logFile                    the commands log (JSON lines), or null
//   outputDir                  where outputs over 20 KB are written, or null
//   log, now
export function createAgentTerminal({ verify, settings = () => ({ enabled: true }), ask, busyOf = async () => ({}), send = () => {}, logFile = null, outputDir = null, log = null, now = () => Date.now(), fsImpl = fs }) {
  const approvedPanes = new Set() // "agent|pane": the user allowed this agent in this user terminal
  const stopped = new Set() // "agent|pane": the user stopped it there
  const stoppedNoticeAt = new Map()
  const sessions = new Map() // agent pane -> { allowAll, rules }
  const writes = new Map() // agent pane -> [times]
  const control = new Map() // target pane -> { agent, agentPane, timer }
  const warn = (msg) => log && log.warn('agent-terminal', msg)
  const key = (agent, pane) => `${agent}|${pane}`
  const conf = () => settings() || {}

  function allowedNow() {
    if (conf().enabled === false) throw fail('disabled', 'The user turned off "Let agents use terminals" (Tessel Settings > Agents).')
  }
  function sessionOf(agentPane) {
    let s = sessions.get(agentPane)
    if (!s) sessions.set(agentPane, (s = { allowAll: false, rules: {} }))
    return s
  }

  // --- The badge ("Ada is using this terminal · Stop") ------------------------------
  function controlled(target, agentPane, agent) {
    const c = control.get(target)
    if (c) clearTimeout(c.timer)
    if (!c || c.agentPane !== agentPane) send('terminal:agentControl', { paneId: target, active: true, agent, agentPane })
    control.set(target, { agent, agentPane, timer: setTimeout(() => release(target), IDLE_MS) })
  }
  function release(target, extra = {}) {
    const c = control.get(target)
    if (!c) return
    clearTimeout(c.timer)
    control.delete(target)
    send('terminal:agentControl', { paneId: target, active: false, agentPane: c.agentPane, ...extra })
  }
  function releaseAll() {
    for (const id of [...control.keys()]) release(id)
  }
  // The user's Stop on a terminal's badge.
  function stop(target, agentPane = null) {
    if (typeof target !== 'string' || !target) return false
    const c = control.get(target)
    const who = agentPane || (c && c.agentPane)
    if (!who) return false
    stopped.add(key(who, target))
    approvedPanes.delete(key(who, target))
    release(target, { stopped: true })
    return true
  }
  // "Allow again" (the notice after Stop).
  function allowAgain(target, agentPane) {
    if (typeof target !== 'string' || typeof agentPane !== 'string') return false
    stopped.delete(key(agentPane, target))
    return true
  }
  // A pane closed: what was decided for it, or by it, goes.
  function forgetPane(id) {
    for (const set of [approvedPanes, stopped]) for (const k of [...set]) if (k.endsWith(`|${id}`) || k.startsWith(`${id}|`)) set.delete(k)
    sessions.delete(id)
    writes.delete(id)
    release(id)
  }

  function rateLimit(agentPane) {
    const t = now()
    const list = (writes.get(agentPane) || []).filter((x) => t - x < RATE_WINDOW_MS)
    if (list.length >= RATE_MAX) throw fail('rate_limited', `Too many writes: at most ${RATE_MAX} in ${RATE_WINDOW_MS / 1000} s. Wait a moment.`)
    list.push(t)
    writes.set(agentPane, list)
  }

  function writeLog(entry) {
    send('terminal:agentLog', entry)
    if (!logFile) return
    try {
      try {
        if (fsImpl.statSync(logFile).size > LOG_MAX_BYTES) fsImpl.renameSync(logFile, `${logFile}.old`)
      } catch {
        // no log yet
      }
      fsImpl.appendFileSync(logFile, `${JSON.stringify({ at: new Date(entry.at).toISOString(), agent: entry.agent, agentPane: entry.agentPane, pane: entry.paneId, paneName: entry.paneName, kind: entry.kind, text: entry.text })}\n`)
    } catch (err) {
      warn(`log not written: ${err.message}`)
    }
  }

  // An output over 20 KB: written to a file, a preview and its tail in the answer.
  function bigOutput(text) {
    const s = String(text || '')
    if (s.length <= MAX_OUTPUT_LENGTH) return s
    let file = null
    if (outputDir) {
      try {
        fsImpl.mkdirSync(outputDir, { recursive: true })
        const names = fsImpl
          .readdirSync(outputDir)
          .filter((n) => /^terminal-output-\d+-[0-9a-f]{8}\.txt$/.test(n))
          .sort((a, b) => Number(a.split('-')[2]) - Number(b.split('-')[2]))
        for (const n of names.slice(0, Math.max(0, names.length - (KEEP_OUTPUT_FILES - 1)))) {
          try {
            fsImpl.unlinkSync(join(outputDir, n))
          } catch {
            // in use
          }
        }
        file = join(outputDir, `terminal-output-${now()}-${crypto.randomBytes(4).toString('hex')}.txt`)
        let content = s
        const trimmed = s.trim()
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            content = JSON.stringify(JSON.parse(trimmed), null, 2)
          } catch {
            content = s
          }
        }
        fsImpl.writeFileSync(file, content)
      } catch (err) {
        warn(`output not saved: ${err.message}`)
        file = null
      }
    }
    return truncateLargeOutput(s, file || undefined)
  }

  function targetFrom(reply) {
    if (!reply || typeof reply !== 'object' || typeof reply.id !== 'string') throw fail('no_terminal', 'Tessel\'s window did not name a terminal.')
    return reply
  }

  function notStopped(agentPane, t) {
    const k = key(agentPane, t.id)
    if (!stopped.has(k)) return
    const last = stoppedNoticeAt.get(k) || 0
    if (now() - last > STOPPED_NOTICE_MS) {
      stoppedNoticeAt.set(k, now())
      ask('terminalTarget', { agent: agentPane, op: 'stoppedNotice', terminal: t.id }).catch(() => {})
    }
    throw fail('stopped_by_user', `The user stopped you from using "${t.name}". Ask them if you need it again.`)
  }

  function writable(t) {
    if (t.kind === 'agent') throw fail('read_only', `"${t.name}" is an agent's pane (${t.agentName || 'agent'}): read it with get_terminal_output, talk to it with team_send. Agents never type into each other.`)
    if (t.notConnected) throw fail('not_connected', `"${t.name}" is not connected: ask the user to connect it.`)
    if (t.exited) throw fail('exited', `The shell in "${t.name}" has exited.`)
  }

  // The user's answer on the approval card.
  async function card(agentPane, t, c) {
    const answer = await ask('terminalTarget', { agent: agentPane, op: 'approve', terminal: t.id, card: c }, { timeoutMs: APPROVAL_TIMEOUT_MS }).catch((err) => {
      if (err && err.code === 'timeout') throw fail('approval_timeout', 'The user did not answer in time.')
      throw err
    })
    allowedNow()
    if (stopped.has(key(agentPane, t.id))) throw fail('stopped_by_user', `The user stopped you from using "${t.name}".`)
    if (!answer || answer.allow !== true) throw fail('denied', `The user skipped this ${c.kind === 'send' ? 'input' : 'command'}${t.own ? '' : ` in "${t.name}"`}. Do not run it again unless they ask.`)
    return answer
  }

  // May this command run in this terminal? Asks the user when needed.
  // -> { command (maybe edited by the user), edited, rule }
  async function mayRun(agentPane, t, command, args) {
    writable(t)
    notStopped(agentPane, t)
    const s = conf()
    const lang = t.lang === 'powershell' ? 'powershell' : 'bash'
    const rules = buildRules({ user: s.userRules, workspace: (s.workspaceRules || {})[t.workspaceKey], ignoreDefaults: !!s.ignoreDefaults })
    const session = sessionOf(agentPane)
    const analysis = analyzeCommandLine(command, { lang, rules, session, enabled: !!s.autoApprove })
    const base = { kind: 'command', command, explanation: String(args.explanation || '').slice(0, MAX_TEXT), goal: String(args.goal || '').slice(0, MAX_TEXT), info: analysis.info, disclaimers: analysis.disclaimers, own: !!t.own }
    if (t.own) {
      if (analysis.isAutoApproved) return { command, edited: false, rule: analysis.info }
      const answer = await card(agentPane, t, { ...base, actions: analysis.actions })
      applyAction(agentPane, t, answer.action)
      const edited = typeof answer.command === 'string' && answer.command.trim() && answer.command !== command ? checkCommand(answer.command) : null
      return { command: edited || command, edited: !!edited, rule: null }
    }
    // One of the user's terminals: approved once for this terminal; a command
    // a deny rule matches asks every time. Never by rules or the session.
    const k = key(agentPane, t.id)
    if (approvedPanes.has(k) && !analysis.isDenied) return { command, edited: false, rule: null }
    const answer = await card(agentPane, t, { ...base, kind: approvedPanes.has(k) ? 'command' : 'pane', actions: [], userTerminal: true })
    if (answer.remember === 'pane') approvedPanes.add(k)
    const edited = typeof answer.command === 'string' && answer.command.trim() && answer.command !== command ? checkCommand(answer.command) : null
    return { command: edited || command, edited: !!edited, rule: null }
  }

  // An "Allow ..." choice on the card: session rules here; the user's and the
  // project's are saved in Settings by the window (it sends them back).
  function applyAction(agentPane, t, action) {
    if (!action || typeof action !== 'object') return
    const session = sessionOf(agentPane)
    if (action.kind === 'session') {
      session.allowAll = true
      return
    }
    for (const r of rulesOfAction(action)) if (r.scope === 'session') session.rules = cleanRules({ ...session.rules, [r.key]: r.value })
  }

  async function run(agentPane, args) {
    let command = checkCommand(args.command)
    const mode = args.mode === 'async' || args.isBackground === true ? 'async' : 'sync'
    const timeout = Number(args.timeout)
    // async: how long to wait for its first quiet moment (VS Code's first window: 20 s).
    const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? Math.min(RUN_MAX_TIMEOUT_MS, Math.max(1000, Math.round(timeout))) : mode === 'async' ? ASYNC_DEFAULT_TIMEOUT_MS : RUN_MAX_TIMEOUT_MS
    const t = targetFrom(await ask('terminalTarget', { agent: agentPane, op: 'prepare', terminal: args.id == null ? null : args.id, host: args.host || null, mode }, { timeoutMs: 60000 }))
    writable(t)
    notStopped(agentPane, t)
    // Windows PowerShell 5.1 has no &&: ; instead (VS Code rewrites it too).
    let simplified = null
    if (t.own && t.lang === 'powershell' && t.shellKind === 'powershell' && /&&/.test(command)) {
      const r = rewritePwshChain(command)
      if (r !== command) simplified = command = r
    }
    const approved = await mayRun(agentPane, t, command, args)
    command = approved.command
    rateLimit(agentPane)
    allowedNow()
    notStopped(agentPane, t)
    controlled(t.id, agentPane, t.agentLabel)
    writeLog({ at: now(), paneId: t.id, paneName: t.name, agent: t.agentLabel, agentPane, kind: 'run', text: command })
    const r = await ask('terminalTarget', { agent: agentPane, op: 'run', terminal: t.id, command, mode, timeoutMs }, { timeoutMs: timeoutMs + 60000 })
    controlled(t.id, agentPane, t.agentLabel)
    const id = t.id
    const out = bigOutput(stripAnsi(r && r.output))
    const head = []
    if (approved.edited) head.push(`Note: The user manually edited the command to \`${command}\`, and this is the output of running that command instead:`)
    else if (simplified) head.push(`Note: The tool simplified the command to \`${command}\` (Windows PowerShell 5.1 has no &&).`)
    if (approved.rule) head.push(`(${approved.rule})`)
    const state = r && r.state
    if (state === 'sensitive') {
      throw fail(
        'needs_user_input',
        `The command in terminal ID ${id} is asking for a password, passphrase or other secret ("${String(r.prompt || '').trim().slice(0, 120)}"). The user was told to type it in the terminal "${t.name}". Do NOT send it yourself and do NOT retry the command: wait for the user, then call get_terminal_output with id="${id}".`
      )
    }
    let body
    if (state === 'completed') {
      body = [out || '', r.additionalInformation ? `\n${r.additionalInformation}` : ''].join('')
      if (t.own) body += `\n[terminal id: ${id}]`
    } else if (state === 'alternateBuffer') body = `The command opened the alternate buffer (a full-screen program) in terminal ID ${id}. Use get_terminal_output and send_to_terminal with id="${id}" to drive it, or kill_terminal.`
    else if (state === 'cancelled') body = `The command was stopped by the user in terminal ID ${id}.${out ? `\nOutput so far:\n${out}` : ''}`
    else if (state === 'background') body = `Command is running in terminal with ID=${id}\nThe command became idle with output:\n${out}\nYou will be notified when it ends (when its shell reports it). Use get_terminal_output with id="${id}" to read more; do not poll in a loop.`
    else if (state === 'input') body = `Note: The command is running in terminal ID ${id} and may be waiting for input.\n${steering(id, null)}\n\n${out}`
    else body = `Note: Command timed out after ${timeoutMs}ms. The command may still be running in terminal ID ${id}. You will be notified when it ends.\n${steering(id, 'timeout')}\n\nOutput so far:\n${out}`
    return { text: [...head, body].join('\n') }
  }

  async function output(agentPane, args) {
    const r = await ask('terminalTarget', { agent: agentPane, op: 'output', terminal: args.id, lines: args.lines })
    if (!r || typeof r !== 'object') throw fail('no_terminal', 'Tessel\'s window did not answer with the terminal.')
    const text = truncateOutputKeepingTail(stripAnsi(r.output), MAX_POLL_OUTPUT)
    const state = r.command ? ` (command \`${String(r.command).slice(0, 200)}\`${r.running ? ', still running' : Number.isInteger(r.exitCode) ? `, exit code ${r.exitCode}` : ', ended'})` : ''
    return { text: `Output of terminal "${r.name}"${state}:\n${text || '(empty)'}` }
  }

  async function sendInput(agentPane, args) {
    const t = targetFrom(await ask('terminalTarget', { agent: agentPane, op: 'resolve', terminal: args.id }))
    writable(t)
    notStopped(agentPane, t)
    let data
    let mode
    let shown
    if (args.keys != null) {
      const k = keysData(args.keys, { appCursor: !!t.appCursor })
      data = k.data
      shown = k.shown
      mode = 'keys'
    } else {
      const raw = typeof args.command === 'string' ? args.command : ''
      if (isCancelSignal(raw)) {
        data = raw
        mode = 'keys'
        shown = raw === '\x03' ? 'Ctrl+C' : raw === '\x04' ? 'Ctrl+D' : 'Ctrl+\\'
      } else {
        data = checkCommand(raw, { allowEmpty: true })
        mode = 'text'
        shown = data || '(Enter)'
      }
    }
    // A question for a secret on screen: never answered by an agent (it may
    // still cancel it: Ctrl+C, Ctrl+D, Ctrl+\, Escape).
    const cancelOnly = mode === 'keys' && /^(?:\x03|\x04|\x1c|\x1b)+$/.test(data)
    if (!cancelOnly && detectsSensitiveInputPrompt(t.cursorLine || '') && /[:?]\s*$/.test(String(t.cursorLine || ''))) {
      throw fail('needs_user_input', `"${t.name}" is asking for a password or other secret: the user types it there. Do not send it.`)
    }
    // VS Code asks before each input to a terminal; the user's "Allow all
    // commands in this session" covers it. The user's terminals: their approval.
    const s = conf()
    const k = key(agentPane, t.id)
    if (t.own) {
      if (!(s.autoApprove && sessionOf(agentPane).allowAll)) await card(agentPane, t, { kind: 'send', command: shown, own: true, explanation: '', goal: '', info: null, disclaimers: [], actions: [{ kind: 'session' }] }).then((a) => applyAction(agentPane, t, a.action))
    } else if (!approvedPanes.has(k)) {
      const a = await card(agentPane, t, { kind: 'pane', command: shown, own: false, explanation: '', goal: '', info: null, disclaimers: [], actions: [], userTerminal: true, send: true })
      if (a.remember === 'pane') approvedPanes.add(k)
    }
    rateLimit(agentPane)
    allowedNow()
    notStopped(agentPane, t)
    controlled(t.id, agentPane, t.agentLabel)
    writeLog({ at: now(), paneId: t.id, paneName: t.name, agent: t.agentLabel, agentPane, kind: mode === 'keys' ? 'keys' : 'run', text: shown })
    const r = await ask('terminalTarget', { agent: agentPane, op: 'send', terminal: t.id, mode, data, waitForOutput: args.waitForOutput === true }, { timeoutMs: 60000 })
    const recent = stripAnsi(r && r.output)
    const cancelNote =
      mode === 'keys' && ['\x03', '\x04', '\x1c'].includes(data)
        ? '\n\nNote: The input you sent was a cancel signal (Ctrl-C / Ctrl-D / Ctrl-\\). The previously running command was interrupted, not completed. This is not a signal to end the turn — if you intend to run a recovery or follow-up command, issue it now in this same turn. Call get_terminal_output first if you need to verify the shell is back at a prompt.'
        : ''
    return { text: `Successfully sent ${mode === 'keys' ? 'keys' : 'command'} to terminal ${t.id}.${recent ? `\n\nTerminal output:\n${truncateOutputKeepingTail(recent, MAX_POLL_OUTPUT)}` : ''}${cancelNote}` }
  }

  async function kill(agentPane, args) {
    const r = await ask('terminalTarget', { agent: agentPane, op: 'kill', terminal: args.id })
    const out = truncateOutputKeepingTail(stripAnsi(r && r.output), MAX_POLL_OUTPUT)
    return { text: `Successfully killed terminal ${String(args.id)}.${out ? ` Final output before termination:\n${out}` : ''}` }
  }

  async function list(agentPane, args) {
    const r = await ask('terminalTarget', { agent: agentPane, op: 'list', all: args.all === true })
    const terms = r && Array.isArray(r.terminals) ? r.terminals : []
    if (!terms.length) return { text: args.all === true ? 'No other terminal is open in Tessel.' : 'No other terminal in your project: set "all" to see every project\'s. Run commands in your own terminal with run_in_terminal.' }
    const unknown = terms.filter((x) => x.busy == null && !x.host && x.kind !== 'agent').map((x) => x.id)
    let busy = {}
    if (unknown.length) busy = (await Promise.resolve(busyOf(unknown)).catch(() => ({}))) || {}
    for (const x of terms) {
      if (x.busy == null && typeof busy[x.id] === 'boolean') x.busy = busy[x.id]
      const k = key(agentPane, x.id)
      x.approved = x.kind !== 'agent' && approvedPanes.has(k)
      x.stopped = stopped.has(k)
    }
    return {
      text: `Terminals${args.all === true ? '' : ' of your project'} (id, number, name, kind, state, folder):\n${terms.map(terminalLine).join('\n')}\nRead one with get_terminal_output. run_in_terminal runs commands in your own terminal; give it "id" to run in one of the user's shells instead (the user approves it first).`
    }
  }

  async function lastCommand(agentPane) {
    const r = await ask('terminalTarget', { agent: agentPane, op: 'lastCommand' })
    if (!r || r.none) return { text: 'No active terminal.' }
    if (!r.commandLine && !r.output) {
      return { text: `The active terminal "${r.name}" ${r.integration ? 'has not finished a command yet' : 'does not report its commands (no shell integration)'}.${r.screen ? ` Its last lines:\n${truncateOutputKeepingTail(stripAnsi(r.screen), MAX_POLL_OUTPUT)}` : ''}` }
    }
    const lines = [`The active terminal "${r.name}":`]
    if (r.running) lines.push('A command is running now.')
    if (r.commandLine) lines.push(`Last command: ${r.commandLine}`)
    if (r.cwd) lines.push(`Directory: ${r.cwd}`)
    if (Number.isInteger(r.exitCode)) lines.push(`Exit code: ${r.exitCode}`)
    if (r.output != null) lines.push(`Output:\n${truncateOutputKeepingTail(stripAnsi(r.output), MAX_POLL_OUTPUT)}`)
    return { text: lines.join('\n') }
  }

  async function selection(agentPane) {
    const r = await ask('terminalTarget', { agent: agentPane, op: 'selection' })
    if (!r || r.none) return { text: 'No active terminal.' }
    return { text: r.text ? `The selection in the active terminal "${r.name}":\n${truncateOutputKeepingTail(stripAnsi(r.text), MAX_POLL_OUTPUT)}` : `Nothing is selected in the active terminal "${r.name}".` }
  }

  // params: { pane, op, args, auth } (checked by cliServer.js) -> { text }
  async function handle(params) {
    const { pane, op, args = {}, auth } = params || {}
    const v = verify({ op, args, auth }, pane)
    if (!v || v.unsigned) throw fail('unauthorized', 'This request is not signed by a pane Tessel started: restart the agent from Tessel.')
    if (v.error) throw fail(/no team secret/.test(v.error) ? 'unknown_pane' : 'unauthorized', `Refused: ${v.error}.`)
    if (!TERMINAL_OPS.includes(op)) throw fail('unknown_method', `Unknown terminal operation: ${String(op).slice(0, 40)}`)
    allowedNow()
    if (['output', 'send', 'kill'].includes(op) && typeof args.id !== 'string' && typeof args.id !== 'number') throw fail('invalid_argument', 'Give the terminal "id" (from run_in_terminal or terminal_list).')
    try {
      if (op === 'list') return await list(pane, args)
      if (op === 'run') return await run(pane, args)
      if (op === 'output') return await output(pane, args)
      if (op === 'send') return await sendInput(pane, args)
      if (op === 'kill') return await kill(pane, args)
      if (op === 'lastCommand') return await lastCommand(pane)
      return await selection(pane)
    } catch (err) {
      if (err instanceof CliError) throw err
      warn(`${op} failed: ${err && err.message}`)
      throw fail('failed', `Tessel could not do it: ${String((err && err.message) || err).slice(0, 300)}`)
    }
  }

  return { handle, stop, allowAgain, forgetPane, release, releaseAll, _approvedPanes: approvedPanes, _stopped: stopped, _sessions: sessions }
}
