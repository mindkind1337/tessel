import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.resolve(__dirname, '../App.vue'), 'utf8')

describe('a new pane on an SSH host and the host agent check', () => {
  it('waits a few seconds at most (the check stays queued behind the host\'s other work), a restored pane that must know keeps the long wait', () => {
    expect(src).toMatch(/const REMOTE_LAUNCH_CHECK_MS = 4000/)
    expect(src).toMatch(/const waitMs = newPane \? REMOTE_LAUNCH_CHECK_MS : REMOTE_CHECK_MS/)
    expect(src).toMatch(/askHostAgents\(hostId, \{ newPane: !strict \}\)/)
    expect(REMOTE_LAUNCH < REMOTE_LONG).toBe(true)
  })
})
const REMOTE_LAUNCH = Number(/const REMOTE_LAUNCH_CHECK_MS = (\d+)/.exec(src)[1])
const REMOTE_LONG = Number(/const REMOTE_CHECK_MS = (\d+)/.exec(src)[1])
