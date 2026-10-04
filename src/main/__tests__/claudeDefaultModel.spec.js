import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { holdClaudeDefaultModel } from '../claudeDefaultModel'

// A manual clock: run() fires the pending tick.
function clock() {
  let pending = null
  return {
    setTimer: (fn) => (pending = fn),
    clearTimer: () => (pending = null),
    run() {
      const fn = pending
      pending = null
      if (fn) fn()
      return !!fn
    },
    get waiting() {
      return !!pending
    }
  }
}

describe('holdClaudeDefaultModel', () => {
  let dir, file
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'cdm-'))
    file = join(dir, 'settings.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('puts the default back once Claude Code saves the pick, keeping the other keys', () => {
    fs.writeFileSync(file, JSON.stringify({ model: 'opus', theme: 'dark' }, null, 2) + '\n')
    const c = clock()
    holdClaudeDefaultModel({ file, ...c })
    c.run()
    fs.writeFileSync(file, JSON.stringify({ model: 'haiku', theme: 'dark', effortLevel: 'high' }, null, 2) + '\n')
    c.run()
    const text = fs.readFileSync(file, 'utf8')
    expect(JSON.parse(text)).toEqual({ model: 'opus', theme: 'dark', effortLevel: 'high' })
    expect(text.endsWith('\n')).toBe(true)
    expect(c.waiting).toBe(false)
  })

  it('removes the model key when there was no default', () => {
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark' }))
    const c = clock()
    holdClaudeDefaultModel({ file, ...c })
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', model: 'haiku' }))
    c.run()
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ theme: 'dark' })
  })

  it('handles a settings file Claude Code creates', () => {
    const c = clock()
    holdClaudeDefaultModel({ file, ...c })
    fs.writeFileSync(file, JSON.stringify({ model: 'haiku' }))
    c.run()
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({})
  })

  it('never writes when the file could not be read at the start', () => {
    fs.writeFileSync(file, '{ not json')
    const c = clock()
    holdClaudeDefaultModel({ file, ...c })
    expect(c.waiting).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json')
  })

  it('gives up after the timeout without touching the file', () => {
    fs.writeFileSync(file, JSON.stringify({ model: 'opus' }))
    const c = clock()
    holdClaudeDefaultModel({ file, timeoutMs: 1000, intervalMs: 250, ...c })
    let ticks = 0
    while (c.run()) ticks++
    expect(ticks).toBe(4)
    fs.writeFileSync(file, JSON.stringify({ model: 'haiku' }))
    expect(c.run()).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ model: 'haiku' })
  })

  it('two picks in a row keep the first default', () => {
    fs.writeFileSync(file, JSON.stringify({ model: 'opus' }))
    const c = clock()
    holdClaudeDefaultModel({ file, ...c })
    const second = holdClaudeDefaultModel({ file, ...c })
    fs.writeFileSync(file, JSON.stringify({ model: 'sonnet' }))
    c.run()
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ model: 'opus' })
    second.stop()
  })
})
