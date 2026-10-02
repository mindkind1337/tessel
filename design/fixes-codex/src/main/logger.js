// Small file logger for diagnosing problems after the fact.
//
//   %APPDATA%\tessel\logs\tessel.log   (current)
//   tessel.1.log ... tessel.3.log       (older, rotated at 1 MB)
//
// Lines look like:
//   2026-09-24T16:20:01.123Z ERROR [main] pty:create failed: ...
// Writes are synchronous and best-effort: logging must never crash the app.
import fs from 'fs'
import { join } from 'path'

const LEVELS = ['debug', 'info', 'warn', 'error']

export function createLogger({
  dir,
  name = 'tessel',
  maxBytes = 1024 * 1024,
  keep = 3,
  minLevel = 'info'
} = {}) {
  const file = join(dir, `${name}.log`)
  const min = Math.max(0, LEVELS.indexOf(minLevel))
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* best-effort */
  }

  function rotate() {
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size < maxBytes) return
      for (let i = keep; i >= 1; i--) {
        const from = i === 1 ? file : join(dir, `${name}.${i - 1}.log`)
        const to = join(dir, `${name}.${i}.log`)
        if (fs.existsSync(from)) {
          if (fs.existsSync(to)) fs.unlinkSync(to)
          fs.renameSync(from, to)
        }
      }
    } catch {
      /* best-effort */
    }
  }

  function write(level, source, message, extra) {
    if (LEVELS.indexOf(level) < min) return
    let text = typeof message === 'string' ? message : describe(message)
    if (extra !== undefined) text += ` ${describe(extra)}`
    // One entry per line; keep stack traces readable but bounded.
    text = redact(text).replace(/\r?\n/g, '\n    ').slice(0, 8000)
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${text}\n`
    try {
      rotate()
      fs.appendFileSync(file, line)
    } catch {
      /* best-effort */
    }
  }

  // Last `bytes` of the current log, for "Copy diagnostics".
  function tail(bytes = 20000) {
    try {
      const size = fs.statSync(file).size
      const fd = fs.openSync(file, 'r')
      const len = Math.min(size, bytes)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      fs.closeSync(fd)
      const text = buf.toString('utf8')
      return size > bytes ? text.slice(text.indexOf('\n') + 1) : text
    } catch {
      return ''
    }
  }

  return {
    file,
    dir,
    debug: (src, msg, extra) => write('debug', src, msg, extra),
    info: (src, msg, extra) => write('info', src, msg, extra),
    warn: (src, msg, extra) => write('warn', src, msg, extra),
    error: (src, msg, extra) => write('error', src, msg, extra),
    write,
    tail
  }
}

export function describe(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// Strip things that look like secrets before they reach a log file.
export function redact(text) {
  return String(text)
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, '$1***')
    .replace(/\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{10,}/g, '$1***')
    .replace(/\b(AIza)[A-Za-z0-9_-]{20,}/g, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1***')
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, '$1***')
}
