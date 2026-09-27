// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { ensureTeamChannel, pollTeamChannel } from '../teamChannel'

const require = createRequire(import.meta.url)
const server = join(__dirname, '..', 'teamMcp', 'server.cjs')
const mcp = require(server)

describe('two readers of the same team inbox', () => {
  let dir, root, ctx
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-inbox-race-'))
    const teamId = 'team-race'
    root = join(dir, '.tessel', 'team-channel', teamId)
    const ready = ensureTeamChannel({
      dir,
      teamId,
      members: [
        { id: 'pane-a', num: 1, title: 'Codex' },
        { id: 'pane-b', num: 2, title: 'Claude' }
      ]
    })
    for (let i = 0; i < 2; i++)
      fs.writeFileSync(
        join(ready.outboxes[0].outbox, `${i}.json`),
        JSON.stringify({ to: '#2', text: `message-${i}` })
      )
    pollTeamChannel({ dir, teamId })
    ctx = {
      root,
      meId: 'pane-b',
      state: JSON.parse(fs.readFileSync(join(root, 'state.json'), 'utf8'))
    }
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('only one reader claims a message selected before another reader acknowledged it', () => {
    const selectedByHook = mcp.unread(ctx)
    const selectedByTool = mcp.unread(ctx)
    expect(mcp.markRead(ctx, selectedByHook)).toHaveLength(2)
    expect(mcp.markRead(ctx, selectedByTool)).toEqual([])
  })

  it('skips an already claimed message but still claims later unread messages', () => {
    const selected = mcp.unread(ctx)
    mcp.markRead(ctx, [selected[0]])
    expect(mcp.markRead(ctx, selected).map((m) => m.id)).toEqual([selected[1].id])
    const acks = fs.readdirSync(join(root, 'acks'))
    expect(acks.filter((n) => n.endsWith('.json'))).toHaveLength(2)
    expect(acks.some((n) => n.endsWith('.tmp'))).toBe(false)
  })

  it('allows each message to be claimed once across real concurrent Node processes', async () => {
    const fixture = join(dir, 'context.json')
    fs.writeFileSync(fixture, JSON.stringify(ctx))
    const runner = join(dir, 'reader.cjs')
    fs.writeFileSync(
      runner,
      `
const fs = require('fs')
const mcp = require(process.argv[2])
const ctx = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const selected = mcp.unread(ctx)
process.send({ ready: true, count: selected.length })
process.once('message', () => {
  process.send({ claimed: mcp.markRead(ctx, selected).map(m => m.id) }, () => process.disconnect())
})
`
    )
    const children = []
    const readers = Array.from({ length: 2 }, () => {
      const child = spawn(process.execPath, [runner, server, fixture], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      })
      children.push(child)
      let stderr = ''
      child.stderr.on('data', (d) => {
        stderr += d
      })
      let selected, claimed
      const ready = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('message', (m) => {
          if (m.ready) {
            selected = m.count
            resolve()
          }
        })
        child.on('exit', (code) => {
          if (selected === undefined) reject(new Error(`Reader exited ${code}: ${stderr}`))
        })
      })
      const done = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('message', (m) => {
          if (m.claimed) claimed = m.claimed
        })
        child.on('exit', (code) =>
          code === 0 && claimed
            ? resolve(claimed)
            : reject(new Error(`Reader exited ${code}: ${stderr}`))
        )
      })
      return { ready, done, start: () => child.send('claim') }
    })
    try {
      await Promise.all(readers.map((r) => r.ready))
      for (const r of readers) r.start()
      const claims = (await Promise.all(readers.map((r) => r.done))).flat()
      expect(claims).toHaveLength(2)
      expect(new Set(claims).size).toBe(2)
      for (const file of fs.readdirSync(join(root, 'acks'))) {
        expect(file.endsWith('.json')).toBe(true)
        expect(JSON.parse(fs.readFileSync(join(root, 'acks', file), 'utf8')).toId).toBe('pane-b')
      }
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill()
    }
  }, 15000)
})
