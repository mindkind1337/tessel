// The tessel_logs tool: an agent reads Tessel's own log files on this
// computer, filtered, without a shell. For an agent that works on an SSH
// server (it sees none of this computer's files) and for any agent that would
// otherwise ask for a PowerShell command on every look at the logs.
//
// What it can read: the two log files Tessel writes in its own log folder (the
// app's, the terminal host's) and their rotated copies, nothing else: the
// names are fixed here, never given by the agent. Read only. What the logger
// wrote was already stripped of keys and tokens (logger.js redact); it is
// stripped again here. Times are the logs' own (UTC).
import fs from 'fs'
import { join } from 'path'
import { redact } from './logger'

export const LOG_FILES = Object.freeze({
  app: ['tessel.log', 'tessel.1.log', 'tessel.2.log', 'tessel.3.log'],
  terminals: ['pty-host.log', 'pty-host.1.log', 'pty-host.2.log', 'pty-host.3.log']
})
export const MAX_LINES = 400
export const DEFAULT_LINES = 200
export const MAX_LINE_CHARS = 600
export const MAX_OUTPUT_CHARS = 60000
const MAX_FILE_BYTES = 12 * 1024 * 1024
const MAX_TERMS = 8
const MAX_TERM = 80
const LEVELS = ['info', 'warn', 'error']

// A time the agent gives: an ISO date or date-time (read as UTC, as the logs
// are), or "30m", "2h", "3d" before now. -> ms | null (not given) | NaN (bad).
export function parseWhen(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null
  const s = String(value).trim()
  const rel = /^(\d{1,4})\s*([mhd])$/i.exec(s)
  if (rel) return now - Number(rel[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[rel[2].toLowerCase()]
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?))?(Z)?$/.exec(s)
  if (!iso) return NaN
  return Date.parse(`${iso[1]}T${iso[2] || '00:00:00'}Z`)
}

// "app starts|network" -> ['app starts', 'network'] (plain words, any of them), or an error text.
export function parseTerms(value) {
  if (value === undefined || value === null || value === '') return { terms: [] }
  const list = String(value)
    .split('|')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  if (list.length > MAX_TERMS) return { error: `"contains": at most ${MAX_TERMS} words separated by |.` } // i18n-ignore read by the agent, not the user
  if (list.some((x) => x.length > MAX_TERM)) return { error: `"contains": each word at most ${MAX_TERM} characters.` } // i18n-ignore read by the agent, not the user
  return { terms: list }
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (INFO|WARN|ERROR|DEBUG) /

// A log's text -> entries [{ at (ms), level, text }]; a line that does not
// start with a time (a stack trace's) belongs to the entry above.
export function parseEntries(text) {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue
    const m = STAMP.exec(line)
    if (m) out.push({ at: Date.parse(m[1]), level: m[2].toLowerCase(), text: line })
    else if (out.length) out[out.length - 1].text += `\n${line}`
  }
  return out
}

function readTail(file, fsImpl) {
  try {
    const st = fsImpl.statSync(file)
    if (!st.isFile()) return ''
    if (st.size <= MAX_FILE_BYTES) return fsImpl.readFileSync(file, 'utf8')
    const fd = fsImpl.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(MAX_FILE_BYTES)
      fsImpl.readSync(fd, buf, 0, MAX_FILE_BYTES, st.size - MAX_FILE_BYTES)
      return buf.toString('utf8')
    } finally {
      fsImpl.closeSync(fd)
    }
  } catch {
    return ''
  }
}

// args: { file: 'app' | 'terminals', since, until, contains, level, max }
// -> { ok: true, text } | { ok: false, error }
export function readLogs({ dir, args = {}, now = Date.now(), fsImpl = fs } = {}) {
  const which = args.file === undefined || args.file === null || args.file === '' ? 'app' : String(args.file)
  if (!LOG_FILES[which]) return { ok: false, error: '"file" is "app" (Tessel\'s log) or "terminals" (the terminal host\'s log).' } // i18n-ignore read by the agent, not the user
  const since = parseWhen(args.since, now)
  const until = parseWhen(args.until, now)
  if (Number.isNaN(since) || Number.isNaN(until)) return { ok: false, error: '"since" and "until" are an ISO date or time in UTC (2026-11-01T07:00), or a delay like 30m, 2h, 3d.' } // i18n-ignore read by the agent, not the user
  const level = args.level === undefined || args.level === null || args.level === '' ? null : String(args.level).toLowerCase()
  if (level && !LEVELS.includes(level)) return { ok: false, error: '"level" is info, warn or error (that level and worse).' } // i18n-ignore read by the agent, not the user
  const { terms, error } = parseTerms(args.contains)
  if (error) return { ok: false, error }
  const asked = args.max === undefined || args.max === null || args.max === '' ? DEFAULT_LINES : Number(args.max)
  if (!Number.isFinite(asked) || asked < 1) return { ok: false, error: `"max" is 1 to ${MAX_LINES}.` } // i18n-ignore read by the agent, not the user
  const max = Math.min(MAX_LINES, Math.floor(asked))

  const entries = []
  const present = []
  for (const name of LOG_FILES[which]) {
    const text = readTail(join(dir, name), fsImpl)
    if (!text) continue
    present.push(name)
    entries.push(...parseEntries(text))
  }
  if (!entries.length) return { ok: true, text: `No ${which === 'app' ? 'Tessel' : 'terminal host'} log lines were found.` }
  entries.sort((a, b) => a.at - b.at)

  const rank = { debug: 0, info: 1, warn: 2, error: 3 }
  const kept = entries.filter((e) => {
    if (since !== null && e.at < since) return false
    if (until !== null && e.at > until) return false
    if (level && rank[e.level] < rank[level]) return false
    if (terms.length) {
      const low = e.text.toLowerCase()
      if (!terms.some((x) => low.includes(x))) return false
    }
    return true
  })

  const count = (lvl) => kept.filter((e) => e.level === lvl).length
  const starts = kept.filter((e) => /\[app\] started v/.test(e.text)).length
  const head =
    `${which === 'app' ? 'Tessel' : 'Terminal host'} log (${present.join(', ')}), times in UTC. ` +
    `Log covers ${new Date(entries[0].at).toISOString()} to ${new Date(entries[entries.length - 1].at).toISOString()}. ` +
    `${kept.length} matching line${kept.length === 1 ? '' : 's'} (${count('error')} error, ${count('warn')} warn, ${count('info')} info)` +
    `${which === 'app' ? `, ${starts} app start${starts === 1 ? '' : 's'}` : ''}.`
  if (!kept.length) return { ok: true, text: `${head}\nNothing matches: widen "since"/"until", or drop "contains" or "level".` }

  const shown = kept.slice(-max)
  let body = shown.map((e) => redact(e.text).slice(0, MAX_LINE_CHARS)).join('\n')
  let cut = kept.length - shown.length
  if (body.length > MAX_OUTPUT_CHARS) {
    body = body.slice(body.length - MAX_OUTPUT_CHARS)
    body = body.slice(body.indexOf('\n') + 1)
    cut = kept.length - body.split('\n').length
  }
  const note = cut > 0 ? `\n(${cut} older matching line${cut === 1 ? '' : 's'} not shown: narrow "since"/"until", add "contains" or "level".)` : ''
  return { ok: true, text: `${head}\n${body}${note}` }
}
