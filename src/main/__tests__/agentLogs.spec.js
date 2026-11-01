// @vitest-environment node
// tessel_logs (agentLogs.js): Tessel's own log files, filtered, read only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readLogs, parseWhen, parseTerms, parseEntries, LOG_FILES, MAX_LINES } from '../agentLogs'

const NOW = Date.parse('2026-11-01T12:00:00Z')
let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-logs-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
const put = (name, lines) => fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n')
const line = (at, level, src, msg) => `${at} ${level.padEnd(5)} [${src}] ${msg}`

describe('what it is asked', () => {
  it('times: ISO in UTC, or a delay before now; anything else is refused', () => {
    expect(parseWhen('2026-11-01T07:00', NOW)).toBe(Date.parse('2026-11-01T07:00:00Z'))
    expect(parseWhen('2026-11-01', NOW)).toBe(Date.parse('2026-11-01T00:00:00Z'))
    expect(parseWhen('2026-11-01 07:30:15.5Z', NOW)).toBe(Date.parse('2026-11-01T07:30:15.500Z'))
    expect(parseWhen('2h', NOW)).toBe(NOW - 2 * 3600e3)
    expect(parseWhen('3d', NOW)).toBe(NOW - 3 * 86400e3)
    expect(parseWhen('', NOW)).toBeNull()
    expect(parseWhen('yesterday', NOW)).toBeNaN()
    expect(parseWhen('../../x', NOW)).toBeNaN()
  })
  it('words: plain text split on |, bounded (never a regular expression)', () => {
    expect(parseTerms('Lost | closed')).toEqual({ terms: ['lost', 'closed'] })
    expect(parseTerms('(a+)+$')).toEqual({ terms: ['(a+)+$'] })
    expect(parseTerms('a|b|c|d|e|f|g|h|i').error).toBeTruthy()
    expect(parseTerms('x'.repeat(81)).error).toBeTruthy()
  })
  it('entries: a line without a time belongs to the one above', () => {
    const e = parseEntries([line('2026-11-01T07:00:00.000Z', 'ERROR', 'main', 'boom'), '    at foo (bar.js:1)', line('2026-11-01T07:00:01.000Z', 'INFO', 'app', 'ok')].join('\n'))
    expect(e).toHaveLength(2)
    expect(e[0].text).toContain('at foo')
    expect(e[1].level).toBe('info')
  })
  it('only its own two files, by fixed names: nothing an agent writes picks a file', () => {
    expect(Object.keys(LOG_FILES)).toEqual(['app', 'terminals'])
    expect(readLogs({ dir, args: { file: '../../secret' } }).ok).toBe(false)
    expect(readLogs({ dir, args: { file: 'tessel.log' } }).ok).toBe(false)
    expect(readLogs({ dir, args: { level: 'debug' } }).ok).toBe(false)
    expect(readLogs({ dir, args: { since: 'soon' } }).ok).toBe(false)
    expect(readLogs({ dir, args: { max: 0 } }).ok).toBe(false)
  })
})

describe('what it gives', () => {
  beforeEach(() => {
    put('tessel.log', [
      line('2026-11-01T06:50:00.000Z', 'INFO', 'app', 'started v1.17.2 (dev)'),
      line('2026-11-01T07:30:00.000Z', 'WARN', 'remote', 'remote session for ssh-a ended: closed'),
      line('2026-11-01T07:31:00.000Z', 'INFO', 'ui', 'board: something else'),
      line('2026-11-01T12:00:00.000Z', 'ERROR', 'main', 'renderer gone token=abc123secret'),
      '    at stack line'
    ])
    put('tessel.1.log', [line('2026-10-31T20:00:00.000Z', 'INFO', 'app', 'started v1.17.2 (dev)'), line('2026-10-31T20:05:00.000Z', 'WARN', 'remote', 'remote session for ssh-a ended: closed')])
    put('pty-host.log', [line('2026-11-01T07:30:00.000Z', 'WARN', 'host', 'ssh: ssh connection to 1.2.3.4:22 lost')])
  })
  it('the rotated files too, in time order, with a header: range, counts, app starts (UTC)', () => {
    const r = readLogs({ dir, args: {}, now: NOW })
    expect(r.ok).toBe(true)
    expect(r.text).toContain('tessel.log, tessel.1.log')
    expect(r.text).toContain('times in UTC')
    expect(r.text).toMatch(/6 matching lines \(1 error, 2 warn, 3 info\), 2 app starts/)
    expect(r.text.indexOf('2026-10-31T20:00')).toBeLessThan(r.text.indexOf('2026-11-01T07:30'))
  })
  it('a window, a level, words', () => {
    const w = readLogs({ dir, args: { since: '2026-11-01T07:00', until: '2026-11-01T08:00' }, now: NOW })
    expect(w.text).toMatch(/2 matching lines/)
    expect(w.text).toContain('ended: closed')
    expect(w.text).not.toContain('started v1.17.2')
    const lv = readLogs({ dir, args: { level: 'warn' }, now: NOW })
    expect(lv.text).toMatch(/3 matching lines \(1 error, 2 warn, 0 info\)/)
    const wd = readLogs({ dir, args: { contains: 'ended|STARTED' }, now: NOW })
    expect(wd.text).toMatch(/4 matching lines/)
    const rel = readLogs({ dir, args: { since: '5h' }, now: NOW })
    expect(rel.text).toMatch(/3 matching lines/)
  })
  it('the other file; nothing found says how to widen', () => {
    const t = readLogs({ dir, args: { file: 'terminals' }, now: NOW })
    expect(t.text).toContain('connection to 1.2.3.4:22 lost')
    const none = readLogs({ dir, args: { contains: 'nothing like this' }, now: NOW })
    expect(none.ok).toBe(true)
    expect(none.text).toContain('Nothing matches')
  })
  it('keys and tokens are stripped again, a stack trace stays with its line', () => {
    const r = readLogs({ dir, args: { level: 'error' }, now: NOW })
    expect(r.text).not.toContain('abc123secret')
    expect(r.text).toContain('token=***')
    expect(r.text).toContain('at stack line')
  })
  it('bounded: the newest lines, and it says how many older ones were left out', () => {
    put('tessel.log', Array.from({ length: 900 }, (_, i) => line(new Date(Date.parse('2026-11-01T00:00:00Z') + i * 1000).toISOString(), 'INFO', 'app', `line ${i}`)))
    fs.rmSync(path.join(dir, 'tessel.1.log'))
    const r = readLogs({ dir, args: { max: 1000 }, now: NOW })
    expect(r.text.split('\n').filter((l) => /\[app\] line/.test(l))).toHaveLength(MAX_LINES)
    expect(r.text).toContain('line 899')
    expect(r.text).not.toContain('line 499 ')
    expect(r.text).toMatch(/500 older matching lines not shown/)
  })
  it('no log files: said plainly', () => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir)
    expect(readLogs({ dir, args: {}, now: NOW }).text).toContain('No Tessel log lines were found')
  })
})
