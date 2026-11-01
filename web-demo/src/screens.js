// The simulated terminals: what a PTY would print, as bytes for xterm.
//   AgentScreen: an agent CLI's screen (its conversation above, its input box below),
//     in the look of the agent it plays (claude, codex, gemini or any other).
//   ShellScreen: a shell with a prompt, its line editing and a few commands.
// Each takes emit(data), the same output a real terminal sends through pty:data.

const ESC = '\x1b['
const paint = (code, text) => `${ESC}${code}m${text}${ESC}0m`
const dim = (text) => paint('2', text)
const bold = (text) => paint('1', text)
const color = (n, text) => paint(`38;5;${n}`, text)

const ACCENT = { claude: 173, codex: 79, gemini: 75, opencode: 252 }
const SPIN = {
  claude: ['✶', '✸', '✹', '✺', '✹', '✸'],
  codex: ['•', '◦', '•', '◦'],
  gemini: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  other: ['-', '\\', '|', '/']
}

// Wrap plain text at cols: words stay whole, long ones are cut.
export function wrapText(text, cols) {
  const width = Math.max(10, cols)
  const out = []
  for (const para of String(text).split('\n')) {
    // A line that fits stays as it is, its own spaces included.
    if (para.length <= width) {
      out.push(para)
      continue
    }
    let line = ''
    for (let word of para.split(' ')) {
      while (word.length > width) {
        if (line) {
          out.push(line)
          line = ''
        }
        out.push(word.slice(0, width))
        word = word.slice(width)
      }
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out
}

function cut(text, cols) {
  const s = String(text)
  return s.length > cols ? s.slice(0, Math.max(0, cols)) : s
}

// One entry of a conversation -> its rows on screen, in that agent's look.
//   { user: text } your prompt          { say: text } the agent speaks
//   { tool: name, arg } a tool ran      { out: [lines] } what it printed
//   { add: line } / { del: line } a line of a diff
function entryRows(kind, entry, cols) {
  const w = Math.max(16, cols)
  const hang = (first, firstWidth, rest, text, style = (s) => s) =>
    wrapText(text, w - firstWidth).map((row, i) => (i ? rest : first) + style(row))
  if (entry.user !== undefined) {
    if (kind === 'codex') return hang(`${bold('›')} `, 2, '  ', entry.user).concat('')
    if (kind === 'gemini') return hang(`${color(75, '>')} `, 2, '  ', entry.user).concat('')
    return hang(`${bold('>')} `, 2, '  ', entry.user, (s) => dim(s)).concat('')
  }
  if (entry.say !== undefined) {
    if (kind === 'gemini') return hang(`${color(75, '✦')} `, 2, '  ', entry.say).concat('')
    if (kind === 'codex') return hang('• ', 2, '  ', entry.say).concat('')
    return hang(`${color(15, '●')} `, 2, '  ', entry.say).concat('')
  }
  if (entry.tool !== undefined) {
    const arg = entry.arg ? cut(entry.arg, w - entry.tool.length - 5) : ''
    if (kind === 'gemini') return [` ${color(77, '✓')}  ${bold(entry.tool)} ${dim(arg)}`]
    if (kind === 'codex') return [`${color(77, '•')} ${bold(entry.tool)} ${arg}`]
    return [`${color(77, '●')} ${bold(entry.tool)}(${arg})`]
  }
  if (entry.out !== undefined) {
    const mark = kind === 'codex' ? '  └ ' : kind === 'gemini' ? '    ' : '  ⎿  '
    const rest = kind === 'gemini' ? '    ' : kind === 'codex' ? '    ' : '     '
    return entry.out
      .flatMap((line, i) => wrapText(line, w - rest.length).map((row, j) => (i === 0 && j === 0 ? mark : rest) + dim(row)))
      .concat('')
  }
  if (entry.add !== undefined) return [`     ${paint('38;5;114', cut(`+ ${entry.add}`, w - 5))}`]
  if (entry.del !== undefined) return [`     ${paint('38;5;174', cut(`- ${entry.del}`, w - 5))}`]
  return ['']
}

export class AgentScreen {
  constructor({ kind, emit, cols = 80, rows = 24, placeholder = '', footerNote = '' }) {
    this.kind = kind
    this.emit = emit
    this.cols = cols
    this.rows = rows
    this.placeholder = placeholder
    this.footerNote = footerNote
    this.entries = []
    this.draft = ''
    this.work = null // { text, since }
    this.frame = 0
    this.toTop = 0 // rows from the cursor up to the footer's first row
  }

  // The rows below the conversation, and which of them holds the cursor.
  footer() {
    const w = Math.max(16, this.cols - 1)
    const rows = []
    if (this.work) {
      const frames = SPIN[this.kind] || SPIN.other
      const glyph = frames[this.frame % frames.length]
      const secs = Math.max(0, Math.round((Date.now() - this.work.since) / 1000))
      const hint = this.kind === 'gemini' ? `(esc to cancel, ${secs}s)` : this.kind === 'codex' ? `(${secs}s • esc to interrupt)` : `(${secs}s · esc to interrupt)`
      // A narrow pane keeps the words and gives up the hint.
      const short = `(${secs}s)`
      const shown = this.work.text.length + hint.length + 3 <= w ? hint : short
      rows.push(`${color(ACCENT[this.kind] || 252, glyph)} ${cut(this.work.text, Math.max(4, w - shown.length - 3))} ${dim(shown)}`)
      rows.push('')
    }
    const typed = cut(this.draft, w - 6)
    const placeholder = typed ? '' : cut(this.placeholder, w - 6)
    const hint = placeholder ? dim(placeholder) : ''
    if (this.kind === 'codex') {
      rows.push(`${bold('›')} ${typed}${hint}`)
      const cursorAt = rows.length - 1
      rows.push('')
      rows.push(dim(cut(this.footerNote, w)))
      return { rows, cursorAt, cursorCol: 2 + typed.length }
    }
    if (this.kind === 'gemini') {
      const inner = Math.max(8, w - 2)
      const fill = Math.max(0, inner - 3 - typed.length - placeholder.length)
      rows.push(color(75, `╭${'─'.repeat(inner)}╮`))
      rows.push(`${color(75, '│')} > ${typed}${hint}${' '.repeat(fill)}${color(75, '│')}`)
      const cursorAt = rows.length - 1
      rows.push(color(75, `╰${'─'.repeat(inner)}╯`))
      rows.push(dim(cut(this.footerNote, w)))
      return { rows, cursorAt, cursorCol: 4 + typed.length }
    }
    rows.push(dim('─'.repeat(w)))
    rows.push(`> ${typed}${hint}`)
    const cursorAt = rows.length - 1
    rows.push(dim('─'.repeat(w)))
    rows.push(dim(cut(this.footerNote, w)))
    return { rows, cursorAt, cursorCol: 2 + typed.length }
  }

  // Up to the footer's first row, clear down, new conversation rows, footer again.
  draw(newRows = []) {
    const { rows, cursorAt, cursorCol } = this.footer()
    let out = '\r'
    if (this.toTop > 0) out += `${ESC}${this.toTop}A`
    out += `${ESC}J`
    for (const row of newRows) out += `${row}\r\n`
    out += rows.join('\r\n')
    const below = rows.length - 1 - cursorAt
    if (below > 0) out += `${ESC}${below}A`
    out += `\r${cursorCol > 0 ? `${ESC}${cursorCol}C` : ''}`
    this.toTop = cursorAt
    this.emit(out)
  }

  // All of it again, at the terminal's present size.
  redrawAll() {
    this.toTop = 0
    this.emit(`${ESC}2J${ESC}3J${ESC}H`)
    this.draw(this.entries.flatMap((e) => entryRows(this.kind, e, this.cols)))
  }

  // What a re-attach replays: this screen as bytes.
  snapshot() {
    const sent = []
    const emit = this.emit
    this.emit = (d) => sent.push(d)
    this.redrawAll()
    this.emit = emit
    return sent.join('')
  }

  add(entries) {
    const list = Array.isArray(entries) ? entries : [entries]
    this.entries.push(...list)
    if (this.entries.length > 400) this.entries.splice(0, this.entries.length - 400)
    this.draw(list.flatMap((e) => entryRows(this.kind, e, this.cols)))
  }

  setWork(text) {
    this.work = text ? { text, since: this.work ? this.work.since : Date.now() } : null
    this.draw()
  }

  tick() {
    if (!this.work) return
    this.frame++
    this.draw()
  }

  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.redrawAll()
  }
}

// A shell: a prompt, its line editing, and the few commands `commands` knows.
// commands(line, shell) -> { lines?: [...], clear?: true } | 'taken' | null.
export class ShellScreen {
  constructor({ emit, prompt, commands, cols = 80, rows = 24, banner = [] }) {
    this.emit = emit
    this.promptText = prompt
    this.commands = commands
    this.cols = cols
    this.rows = rows
    this.line = ''
    this.at = 0
    this.history = []
    this.place = 0
    this.log = banner.length ? `${banner.join('\r\n')}\r\n` : ''
  }

  snapshot() {
    return `${this.log}${this.line}`
  }

  start() {
    this.emit(this.snapshot())
  }

  write(text) {
    this.log += text
    if (this.log.length > 60000) this.log = this.log.slice(-40000)
    this.emit(text)
  }

  // A command run by the script, as if typed.
  run(line) {
    this.write(`${line}\r\n`)
    this.finish(line)
  }

  // The prompt is in the log once a line is entered: what snapshot() shows stays right.
  finish(line) {
    const res = this.commands(line.trim(), this)
    if (res === 'taken') return
    if (res && res.clear) {
      this.log = ''
      this.emit(`${ESC}2J${ESC}3J${ESC}H`)
    }
    if (res && res.lines && res.lines.length) this.write(`${res.lines.flatMap((line) => wrapText(line, this.cols - 1)).join('\r\n')}\r\n`)
    this.showPrompt()
  }

  showPrompt() {
    this.log += this.promptText()
    this.emit(this.promptText())
  }

  input(data) {
    // A paste in bracketed mode comes whole; the rest key by key.
    // eslint-disable-next-line no-control-regex -- a terminal's escape sequences
    const text = String(data).replace(/\x1b\[20[01]~/g, '')
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (ch === '\x1b') {
        // eslint-disable-next-line no-control-regex -- a terminal's escape sequences
        const seq = /^\x1b\[([0-9;]*[A-Za-z~])/.exec(text.slice(i))
        if (seq) {
          i += seq[0].length - 1
          this.key(seq[1])
        }
        continue
      }
      if (ch === '\r' || ch === '\n') this.enter()
      else if (ch === '\x7f' || ch === '\b') this.backspace()
      else if (ch === '\x03') this.interrupt()
      else if (ch === '\x0c') {
        this.log = this.promptText()
        this.emit(`${ESC}2J${ESC}3J${ESC}H${this.promptText()}${this.line}`)
      } else if (ch >= ' ') this.insert(ch)
    }
  }

  key(code) {
    if (code === 'A' || code === 'B') this.recall(code === 'A' ? -1 : 1)
    else if (code === 'D' && this.at > 0) {
      this.at--
      this.emit(`${ESC}D`)
    } else if (code === 'C' && this.at < this.line.length) {
      this.at++
      this.emit(`${ESC}C`)
    }
  }

  insert(ch) {
    this.line = this.line.slice(0, this.at) + ch + this.line.slice(this.at)
    this.at++
    const after = this.line.slice(this.at)
    this.emit(`${ch}${after}${after.length ? `${ESC}${after.length}D` : ''}`)
  }

  backspace() {
    if (this.at <= 0) return
    this.line = this.line.slice(0, this.at - 1) + this.line.slice(this.at)
    this.at--
    const after = this.line.slice(this.at)
    this.emit(`\b${ESC}K${after}${after.length ? `${ESC}${after.length}D` : ''}`)
  }

  enter() {
    const line = this.line
    this.line = ''
    this.at = 0
    this.log += `${line}\r\n`
    this.emit('\r\n')
    if (line.trim()) {
      this.history.push(line)
      this.place = this.history.length
    }
    this.finish(line)
  }

  interrupt() {
    this.log += `${this.line}^C\r\n`
    this.emit('^C\r\n')
    this.line = ''
    this.at = 0
    this.showPrompt()
  }

  recall(step) {
    const next = Math.max(0, Math.min(this.history.length, this.place + step))
    if (next === this.place) return
    this.place = next
    const line = this.history[next] || ''
    this.emit(`${'\b'.repeat(this.at)}${ESC}K${line}`)
    this.line = line
    this.at = line.length
  }

  resize(cols, rows) {
    this.cols = cols
    this.rows = rows
  }
}
