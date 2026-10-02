import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createLogger, redact } from '../logger'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'sp-log-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('createLogger', () => {
  it('writes timestamped, levelled lines', () => {
    const log = createLogger({ dir })
    log.info('main', 'started', { version: '1.0.0' })
    log.error('renderer', new Error('boom'))
    const text = fs.readFileSync(log.file, 'utf8')
    expect(text).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO  \[main\] started {"version":"1.0.0"}$/m)
    expect(text).toMatch(/ERROR \[renderer\] Error: boom/)
  })

  it('skips levels below the minimum', () => {
    const log = createLogger({ dir, minLevel: 'warn' })
    log.info('main', 'quiet')
    log.warn('main', 'loud')
    const text = fs.readFileSync(log.file, 'utf8')
    expect(text).not.toContain('quiet')
    expect(text).toContain('loud')
  })

  it('rotates at the size limit and keeps a bounded number of files', () => {
    const log = createLogger({ dir, maxBytes: 200, keep: 2 })
    for (let i = 0; i < 40; i++) log.info('main', `line ${i} ${'x'.repeat(30)}`)
    const files = fs.readdirSync(dir).sort()
    expect(files).toEqual(['tessel.1.log', 'tessel.2.log', 'tessel.log'])
    for (const f of files) expect(fs.statSync(join(dir, f)).size).toBeLessThan(400)
    expect(fs.readFileSync(log.file, 'utf8')).toContain('line 39')
  })

  it('returns the end of the log for diagnostics', () => {
    const log = createLogger({ dir })
    for (let i = 0; i < 50; i++) log.info('main', `entry ${i}`)
    const t = log.tail(300)
    expect(t).toContain('entry 49')
    expect(t).not.toContain('entry 0 ')
    expect(t.startsWith('20')).toBe(true) // starts on a whole line
  })
})

describe('redact', () => {
  it('hides tokens and keys', () => {
    const out = redact(
      'gh token ghp_abcdefghijklmnopqrstuvwxyz0123 key sk-ant-abcdefghijklmnop Authorization: Bearer abc.def.ghijklmnop API_KEY=supersecret123'
    )
    expect(out).not.toMatch(/abcdefghijklmnopqrstuvwxyz0123|supersecret123|ghijklmnop/)
    expect(out).toContain('ghp_***')
    expect(out).toContain('Bearer ***')
  })
})
