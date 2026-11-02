// Live Share: a command the host's agent asks to run on a guest's computer.
//
// The person who wrote to the agent is on their own computer, so what they
// report (a crash, a file, a log) is there, not on the host's. The host's agent
// can ask to run a command there, and only the guest can say yes.
//
// The host is not trusted: its Tessel may be anyone's. So, on the guest's side:
// - nothing runs without the guest's click on a card showing the whole command,
//   each time: no rule, no Yolo, nothing remembered as allowed;
// - what the card shows is what runs: plain ASCII and the accented letters of Western and Central
//   European words only. Anything else can read differently from what it does: PowerShell takes
//   curly quotes for real quotes and no-break spaces for spaces, marks can hide or reorder a line,
//   and some Latin letters are pixel-for-pixel an l, a K or a quote. A list of bad characters
//   would keep missing some, so it is a list of good ones. Bounded in size;
// - it runs in a fresh Windows PowerShell with no profile, no input and no
//   Tessel secrets in its environment, for a bounded time, and can be stopped;
// - the host's other words (agent, project, reason) come in as short plain text.
//
// This file is plain data and checks, and the process: no network, no Electron.
import { spawn, spawnSync } from 'child_process'
import { StringDecoder } from 'string_decoder'
import os from 'os'
import path from 'path'

export const GUEST_COMMAND_LIMITS = Object.freeze({
  commandBytes: 8 * 1024,
  commandLines: 40,
  label: 80,
  text: 500,
  output: 64 * 1024,
  defaultMs: 60 * 1000,
  maxMs: 5 * 60 * 1000,
  // Cards a host can put on a guest's screen in a minute.
  perMinute: 6
})

const NOT_PLAIN = /[^\t\n\x20-\x7e\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u0130\u0132-\u0137\u0139-\u013e\u0141-\u0148\u014a-\u017e]/
// Blanks that would push the end of a line out of sight.
const LONG_BLANKS = /[ \t]{40,}/

export const isCommandId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id)

export function plain(text, max) {
  return String(typeof text === 'string' ? text : '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- control characters are what it removes
    .replace(/[\x00-\x1f\x7f-\x9f\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cs}\p{Cn}\p{Co}\p{M}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

// What the host asked, on the guest's side. null: not something to show.
export function cleanCommandAsk(msg) {
  if (!msg || !isCommandId(msg.id) || typeof msg.command !== 'string') return null
  const command = msg.command.replace(/\r\n?/g, '\n')
  const L = GUEST_COMMAND_LIMITS
  if (!command.trim() || Buffer.byteLength(command, 'utf8') > L.commandBytes) return null
  if (NOT_PLAIN.test(command) || LONG_BLANKS.test(command)) return null
  // It must fit on the card: no blank lines pushing a part out of sight.
  if (/\n[ \t]*\n[ \t]*\n/.test(command) || command.split('\n').length > L.commandLines) return null
  const t = Number(msg.timeoutMs)
  return {
    id: msg.id,
    command,
    agent: plain(msg.agent, L.label) || 'agent', // i18n-ignore
    project: plain(msg.project, L.label),
    why: plain(msg.why, L.text),
    goal: plain(msg.goal, L.text),
    timeoutMs: Number.isFinite(t) && t > 0 ? Math.min(L.maxMs, Math.max(1000, Math.round(t))) : L.defaultMs
  }
}

const STATES = new Set(['completed', 'stopped', 'timeout', 'failed'])
const REFUSALS = new Set(['denied', 'blocked', 'off', 'busy', 'bad', 'timeout', 'failed'])

// What the guest answered, on the host's side.
export function cleanCommandResult(msg) {
  if (msg && msg.ok === true) {
    return {
      ok: true,
      state: STATES.has(msg.state) ? msg.state : 'failed',
      exitCode: Number.isInteger(msg.exitCode) ? msg.exitCode : null,
      output: typeof msg.output === 'string' ? msg.output.slice(-GUEST_COMMAND_LIMITS.output) : ''
    }
  }
  return { ok: false, code: msg && REFUSALS.has(msg.code) ? msg.code : 'failed' }
}

// Windows only: what the card and the agent are told, and how Stop reaches a whole tree.
export const commandsPossible = (platform = process.platform) => platform === 'win32'

const cleanEnv = (env) => Object.fromEntries(Object.entries(env || {}).filter(([k]) => !/^(TESSEL_|ELECTRON_)/i.test(k)))

// Full paths: a program of that name in the folder it runs from must not be the one started.
function programs(env) {
  const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
  return { shell: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), kill: path.win32.join(root, 'System32', 'taskkill.exe') }
}

function shellArgs(command) {
  // In base64, so no quoting can change what runs. Not -EncodedCommand: with its
  // output redirected, PowerShell then writes errors as CLIXML.
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  const line = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ProgressPreference = 'SilentlyContinue'; Invoke-Expression ([System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${encoded}')))`
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', line]
}

// -> { promise: Promise<{ state, exitCode, output }>, stop() }
export function runGuestCommand({ command, timeoutMs = GUEST_COMMAND_LIMITS.defaultMs, spawnFn = spawn, spawnSyncFn = spawnSync, env = process.env, cwd = os.homedir(), killWaitMs = 3000 }) {
  const { shell, kill: killer } = programs(env)
  const limit = GUEST_COMMAND_LIMITS.output
  let output = ''
  let dropped = false
  let child = null
  let reason = null
  let settled = false
  let timer = null
  let finish = () => {}
  const add = (text) => {
    output += text
    if (output.length > limit * 2) {
      output = output.slice(-limit)
      dropped = true
    }
  }
  // now: Tessel is quitting, and a taskkill started in the background could die with it.
  function kill({ now = false } = {}) {
    if (!child) return
    try {
      const args = ['/PID', String(child.pid), '/T', '/F']
      if (child.pid && now) spawnSyncFn(killer, args, { windowsHide: true, stdio: 'ignore', timeout: 5000 })
      else if (child.pid) spawnFn(killer, args, { windowsHide: true, stdio: 'ignore' }).on?.('error', () => {})
    } catch {
      // already gone
    }
    // A program left holding its output open must not hold this up.
    setTimeout(() => finish(reason || 'stopped'), killWaitMs).unref?.()
  }
  const promise = new Promise((resolve) => {
    finish = (state, exitCode = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const kept = output.length > limit || dropped
      resolve({ state, exitCode, output: `${kept ? '[older output dropped]\n' : ''}${output.slice(-limit)}` }) // i18n-ignore
    }
    try {
      child = spawnFn(shell, shellArgs(command), { cwd, env: cleanEnv(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      add(String((err && err.message) || err))
      return finish('failed')
    }
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8')
      stream?.on('data', (chunk) => add(decoder.write(chunk)))
    }
    child.on('error', (err) => {
      add(String((err && err.message) || err))
      finish('failed')
    })
    child.on('close', (code) => finish(reason || 'completed', Number.isInteger(code) ? code : null))
    timer = setTimeout(() => {
      reason = 'timeout'
      kill()
    }, timeoutMs)
    timer.unref?.()
  })
  return {
    promise,
    stop(how = {}) {
      if (settled || reason) return
      reason = 'stopped'
      kill(how)
    }
  }
}
