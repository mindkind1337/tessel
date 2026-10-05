// A terminal pane's screen and its shell's reports, for the agents' terminal
// tools (agentTerminalTargets.js, executeStrategy.js): plain text from
// xterm's buffer (escape codes already interpreted, wrapped rows joined),
// markers, and the shell integration sequences (OSC 633 / 133) a shell prints
// around each command when set up for it.
//
// The shell integration follows Visual Studio Code's command detection.
// Copyright (c) Microsoft Corporation. Licensed under the MIT License
// (https://github.com/microsoft/vscode/blob/main/LICENSE.txt):
// src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts (the
// sequences and the value escaping) and src/vs/platform/terminal/common/
// capabilities/commandDetectionCapability.ts (prompt start, command start,
// executed, finished with its exit code, the command line); getRawOutput from
// src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/outputHelpers.ts.
import { detectsCommonPromptPattern } from '../../../shared/terminalOutput'

export { detectsCommonPromptPattern as looksLikePrompt }

// The last row holding any text, or -1.
export function lastContentRow(buf) {
  for (let y = buf.length - 1; y >= 0; y--) {
    const line = buf.getLine(y)
    if (line && line.translateToString(true).trim()) return y
  }
  return -1
}

// Logical lines (wrapped rows joined) from row `from` to row `to`, inclusive.
export function logicalLines(buf, from, to) {
  const out = []
  let cur = null
  for (let y = Math.max(0, from); y <= to; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    const text = line.translateToString(true)
    if (line.isWrapped && cur != null) cur += text
    else {
      if (cur != null) out.push(cur.replace(/\s+$/, ''))
      cur = text
    }
  }
  if (cur != null) out.push(cur.replace(/\s+$/, ''))
  return out
}

// The last `n` lines of the screen and scrollback.
export function readText(term, n = 60) {
  if (!term) return ''
  const buf = term.buffer.active
  const last = lastContentRow(buf)
  if (last < 0) return ''
  const from = Math.max(0, last - n * 4)
  let lines = logicalLines(buf, from, last)
  if (from > 0 && buf.getLine(from) && buf.getLine(from).isWrapped) lines = lines.slice(1)
  return lines.slice(-n).join('\n')
}

// The text from a marker's line (back to the start of its wrapped line) to
// an end marker or the end of the buffer (VS Code's getRawOutput).
export function getRawOutput(term, startMarker, endMarker = null) {
  if (!term) return ''
  const buffer = term.buffer.active
  let startLine = Math.max(startMarker && startMarker.line >= 0 ? startMarker.line : 0, 0)
  while (startLine > 0 && buffer.getLine(startLine) && buffer.getLine(startLine).isWrapped) startLine--
  const endLine = endMarker && endMarker.line >= 0 ? Math.min(buffer.length, endMarker.line + 1) : buffer.length
  const lines = []
  let current = ''
  for (let y = startLine; y < endLine; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    const next = buffer.getLine(y + 1)
    const wrapped = !!(next && next.isWrapped)
    current += line.translateToString(!wrapped)
    if (!wrapped) {
      lines.push(current)
      current = ''
    }
  }
  if (current) lines.push(current)
  return lines.join('\n').replace(/\n+$/, '')
}

// The cursor's line up to the cursor, trailing spaces kept (a prompt waiting
// for input ends with a space: "Continue? (y/n) ").
export function cursorLine(term) {
  if (!term) return ''
  const buf = term.buffer.active
  const line = buf.getLine(buf.baseY + buf.cursorY)
  if (!line) return ''
  const text = line.translateToString(false, 0, Math.max(buf.cursorX, line.translateToString(true).length))
  return text
}

// --- Shell integration ---------------------------------------------------------------------
// OSC 633 / 133:
//   A  prompt start      B  command start (input begins)
//   C  command executed  D[;<exit code>]  command finished (no code: nothing ran)
//   E;<command line>[;<nonce>]  (633)     P;<Key>=<Value>  (633: Cwd, HasRichCommandDetection)
// A value escapes "\" as "\\" and ";" and characters below 0x20 as \xAB.
export function deserializeValue(value) {
  let out = ''
  const s = String(value || '')
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      if (s[i + 1] === '\\') {
        out += '\\'
        i++
        continue
      }
      if (s[i + 1] === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
        out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16))
        i += 3
        continue
      }
    }
    out += s[i]
  }
  return out
}

export function parseShellSequence(data) {
  const s = String(data || '')
  const m = /^([ABCDEFGP])(?:;([\s\S]*))?$/.exec(s)
  if (!m) return null
  const out = { type: m[1] }
  const rest = m[2]
  if (m[1] === 'D' && rest != null) {
    const code = rest.split(';')[0]
    if (/^-?\d{1,10}$/.test(code)) out.exitCode = Number(code)
  }
  if (m[1] === 'E' && rest != null) out.commandLine = deserializeValue(rest.split(';')[0])
  if (m[1] === 'P' && rest != null) {
    const eq = rest.indexOf('=')
    if (eq > 0) {
      out.key = rest.slice(0, eq)
      out.value = deserializeValue(rest.slice(eq + 1))
    }
  }
  return out
}

// A pane's command detection. registerMarker() -> an xterm marker at the
// cursor (or null). Listeners get { exitCode, commandLine, startMarker,
// endMarker, cwd } when a command finishes.
export function createShellIntegration({ registerMarker = () => null } = {}) {
  const s = { seen: false, rich: false, executing: false, ends: 0, exitCode: null, prompt: false, cwd: null }
  let current = null // { promptMarker, startMarker, executedMarker, commandLine }
  let last = null
  const finished = new Set()
  const sequences = new Set()
  function feed(data) {
    const e = parseShellSequence(data)
    if (!e) return false
    s.seen = true
    for (const fn of sequences) fn(e.type)
    switch (e.type) {
      case 'A':
        s.prompt = true
        current = { promptMarker: registerMarker(), startMarker: null, executedMarker: null, commandLine: null }
        break
      case 'B':
        s.prompt = true
        if (!current) current = { promptMarker: null, startMarker: null, executedMarker: null, commandLine: null }
        current.startMarker = registerMarker()
        break
      case 'C':
        s.executing = true
        s.prompt = false
        if (!current) current = { promptMarker: null, startMarker: null, executedMarker: null, commandLine: null }
        current.executedMarker = registerMarker()
        break
      case 'E':
        if (!current) current = { promptMarker: null, startMarker: null, executedMarker: null, commandLine: null }
        current.commandLine = e.commandLine
        break
      case 'D': {
        s.executing = false
        s.ends++
        s.exitCode = Number.isInteger(e.exitCode) ? e.exitCode : null
        const cmd = current || {}
        const done = { exitCode: s.exitCode, commandLine: cmd.commandLine || null, startMarker: cmd.startMarker || cmd.promptMarker || null, executedMarker: cmd.executedMarker || null, endMarker: registerMarker(), cwd: s.cwd, seq: s.ends }
        current = null
        last = done
        for (const fn of finished) fn(done)
        break
      }
      case 'P':
        if (e.key === 'Cwd') s.cwd = String(e.value || '').slice(0, 1000)
        if (e.key === 'HasRichCommandDetection' && /^true$/i.test(e.value)) s.rich = true
        break
      default:
        break
    }
    return true
  }
  return {
    feed,
    // 'rich' | 'basic' | 'none'
    quality: () => (s.rich ? 'rich' : s.seen ? 'basic' : 'none'),
    executing: () => s.executing,
    state: () => ({ integration: s.seen, running: s.seen ? s.executing : null, ends: s.ends, exitCode: s.exitCode, prompt: s.prompt, cwd: s.cwd, quality: s.rich ? 'rich' : s.seen ? 'basic' : 'none' }),
    lastCommand: () => last,
    onCommandFinished(fn) {
      finished.add(fn)
      return () => finished.delete(fn)
    },
    // Each sequence's type ('A', 'C', 'D'...), for trackIdleOnPrompt.
    onSequence(fn) {
      sequences.add(fn)
      return () => sequences.delete(fn)
    }
  }
}

// The terminal adapter executeStrategy.js works with, over a pane's xterm.
// hooks: { writePty(data), paste(text), exitCode() -> number | null,
//          onExit(fn) -> off, onDispose(fn) -> off, isDisposed() -> bool }
export function createTerminalAdapter(term, shell, hooks) {
  const sub = (d) => () => d && d.dispose && d.dispose()
  return {
    shell,
    onData: (fn) => sub(term.onWriteParsed(() => fn())),
    onUserInput: (fn) => sub(term.onData(() => fn())),
    registerMarker: () => term.registerMarker(0) || null,
    getOutput: (start, end) => getRawOutput(term, start, end),
    cursorLine: () => cursorLine(term),
    cursorRow: () => term.buffer.active.baseY + term.buffer.active.cursorY,
    isAltBuffer: () => term.buffer.active.type === 'alternate',
    onBufferChange: (fn) => sub(term.buffer.onBufferChange(() => fn())),
    hasOutput: () => lastContentRow(term.buffer.active) >= 0,
    appCursorKeys: () => !!(term.modes && term.modes.applicationCursorKeysMode),
    // The line (bracketed paste when the program asked for it), then Enter
    // on its own a moment later, as team messages are typed.
    sendText(text) {
      const s = String(text == null ? '' : text)
      if (s) hooks.paste(s)
      setTimeout(() => hooks.writePty('\r'), s ? 30 : 0)
    },
    write: (data) => hooks.writePty(String(data || '')),
    exitCode: () => hooks.exitCode(),
    onExit: (fn) => hooks.onExit(fn),
    isDisposed: () => hooks.isDisposed(),
    onDispose: (fn) => hooks.onDispose(fn)
  }
}
