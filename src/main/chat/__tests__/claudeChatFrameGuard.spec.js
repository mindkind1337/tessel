// @vitest-environment node
// One frame the normalizer throws on is logged and skipped; the stream goes
// on. Against the fake claude (fixtures/fake-claude.cjs); no real CLI runs.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

vi.mock('../claudeFrames', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    normalizeFrame: (m, state) => {
      if (m && m.type === 'system' && m.subtype === 'init') throw new Error('fixture: unreadable frame')
      return actual.normalizeFrame(m, state)
    }
  }
})
const { createClaudeChat } = await import('../claudeChat')

const FAKE = join(__dirname, 'fixtures', 'fake-claude.cjs')
const open = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => {})))
})

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('claudeChat: frame guard', () => {
  it('logs a frame the normalizer cannot read and still ends the turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tessel-fake-claude-'))
    const lines = []
    const log = { warn: (area, msg) => lines.push([area, msg]), info: () => {}, error: () => {} }
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FAKE_CLAUDE_LOG: join(dir, 'log.jsonl') }
    const chat = createClaudeChat({ exe: process.execPath, exeArgs: [FAKE], cwd: dir, env, sessionId: randomUUID(), log })
    open.push(chat)
    const ends = []
    chat.on('turnEnd', (e) => ends.push(e))
    expect((await chat.start()).ok).toBe(true)
    await chat.send({ uuid: randomUUID(), text: 'hello' })
    await waitFor(() => ends.length)
    expect(lines.some(([area, msg]) => area === 'chat' && /not normalized: fixture: unreadable frame/.test(msg))).toBe(true)
  })
})
