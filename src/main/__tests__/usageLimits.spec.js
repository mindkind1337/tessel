// @vitest-environment node
// An agent at its usage limit never leaves its team waiting: Claude Code's
// rate_limit StopFailure and Muse's quota failure read by the hook script, the
// store taking them in, and the team tools telling a sender at once.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import { createRequire } from 'module'
import { createAgentStateStore } from '../agentStateStore'
import { ensureTeamChannel } from '../teamChannel'
import { writeCurrentTeams } from '../teamNotices'
import { writeRoster } from '../teamTasks'

delete process.env.TESSEL_TEAM_SECRET
delete process.env.TESSEL_PANE_ID
delete process.env.TESSEL_AGENT_PROVIDER

const require = createRequire(import.meta.url)
const mcp = require(join(__dirname, '..', 'teamMcp', 'server.cjs'))

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-limits-'))
})
afterEach(() => {
  delete process.env.TESSEL_PANE_ID
  delete process.env.TESSEL_PROJECT_DIR
  const target = resolve(dir)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-limits-')) throw new Error('Unsafe fixture path')
  fs.rmSync(target, { recursive: true, force: true })
})

describe('usageLimitOf (the hook script)', () => {
  it("reads Claude Code's rate_limit failures, their reset time and zone", () => {
    expect(mcp.usageLimitOf('claude', { error: 'rate_limit', last_assistant_message: "You've hit your limit · resets 3pm" })).toEqual({ limit: true, reset: '3pm' })
    expect(mcp.usageLimitOf('claude', { error: 'rate_limit', last_assistant_message: '5-hour limit reached ∙ resets 3pm (America/Toronto)' })).toEqual({ limit: true, reset: '3pm (America/Toronto)' })
    expect(mcp.usageLimitOf('openclaude', { error: { type: 'rate_limit' }, last_assistant_message: 'Claude AI usage limit reached|1792440000' })).toEqual({ limit: true, resetAt: 1792440000 * 1000 })
    // Its own error text is read first.
    expect(mcp.usageLimitOf('claude', { error: 'rate_limit', error_details: "You've hit your limit · resets 5pm", last_assistant_message: 'It resets 3pm' })).toEqual({ limit: true, reset: '5pm' })
  })

  it('a rate_limit without a usage-limit phrase (a short burst of 429s) is no usage limit', () => {
    expect(mcp.usageLimitOf('claude', { error: 'rate_limit' })).toBeNull()
    expect(mcp.usageLimitOf('claude', { error: 'rate_limit', error_details: 'API Error: 429 Too Many Requests. Retrying.' })).toBeNull()
  })

  it("reads Muse Code's subscription quota failure (its real wording, anonymised)", () => {
    const reason = 'API error 429 [request_id=00000000-0000-0000-0000-000000000000]: Subscription quota exhausted. Your usage window resets at 2026-10-19T15:13:21Z. (rate_limit_error)'
    expect(mcp.usageLimitOf('muse', { reason })).toEqual({ limit: true, reset: '2026-10-19T15:13:21Z' })
  })

  it('anything else is no usage limit', () => {
    expect(mcp.usageLimitOf('claude', { error: 'server_error', last_assistant_message: 'API Error: 529 Overloaded.' })).toBeNull()
    expect(mcp.usageLimitOf('claude', { error: 'invalid_request', last_assistant_message: 'Prompt is too long' })).toBeNull()
    expect(mcp.usageLimitOf('muse', { reason: 'API error 500: internal' })).toBeNull()
    expect(mcp.usageLimitOf('codex', { error: 'rate_limit' })).toBeNull()
  })
})

describe('the store takes a hook limit in', () => {
  const paneId = 'pane-7'
  const token = 'execution-token-0123456789'
  it('a rate_limit StopFailure limits the pane until its reset; bad fields are refused', async () => {
    // The store runs since before these hooks (live evidence, not recovered).
    let tick = Date.UTC(2026, 9, 19, 18, 39)
    const store = createAgentStateStore({ dir: join(dir, 'status'), now: () => tick })
    try {
      await store.register({ paneId, provider: 'claude', launchToken: token, startedAt: tick - 60000 })
      tick = Date.UTC(2026, 9, 19, 18, 40)
      const put = (name, at, extra = {}) => {
        fs.mkdirSync(join(dir, 'status', 'events'), { recursive: true })
        const event = { v: 1, id: `e-${name}-${at}`, paneId, provider: 'claude', launchToken: token, sessionId: 'session-1', event: name, at, source: 'hook', ...extra }
        fs.writeFileSync(join(dir, 'status', 'events', `${at}-${name}.json`), JSON.stringify(event))
      }
      put('UserPromptSubmit', tick - 1000)
      // A limit field on another event, or a reset with control characters: refused.
      put('Stop', tick - 900, { limit: true })
      tick += 1
      await store.scan()
      expect(store.snapshot()[paneId].state).toBe('working')
      put('StopFailure', tick - 500, { limit: true, reset: '3pm (America/Toronto)' })
      tick += 1
      await store.scan()
      expect(store.snapshot()[paneId]).toMatchObject({ state: 'limited', reason: 'quota', resetAt: Date.UTC(2026, 9, 19, 19, 0) })
      tick = Date.UTC(2026, 9, 19, 19, 0, 1)
      await store.scan()
      expect(store.snapshot()[paneId].state).toBe('idle')
      // A reset moment further than 40 days: the event is refused.
      put('UserPromptSubmit', tick)
      put('StopFailure', tick, { limit: true, resetAt: tick + 90 * 86400000 })
      tick += 1
      await store.scan()
      expect(store.snapshot()[paneId].state).toBe('working')
    } finally {
      await store.dispose()
    }
  })
})

describe('team tools: a teammate at its usage limit', () => {
  const teamId = 'team-1'
  const A = { id: 'pane-1-aaaaaa', num: 1, title: 'Codex CLI' }
  const B = { id: 'pane-4-bbbbbb', num: 4, title: 'Claude Code' }
  const as = (pane) => {
    process.env.TESSEL_PANE_ID = pane.id
    process.env.TESSEL_PROJECT_DIR = dir
    return mcp.locate()
  }
  const roster = (until) =>
    writeRoster({
      dir,
      teamId,
      members: {
        [A.id]: { agent: 'codex', model: null, state: 'idle' },
        [B.id]: { agent: 'claude', model: null, state: 'limited', until }
      }
    })
  beforeEach(() => {
    expect(ensureTeamChannel({ dir, teamId, members: [A, B] }).ok).toBe(true)
    writeCurrentTeams({ dir, panes: { [A.id]: { team: teamId, num: 1 }, [B.id]: { team: teamId, num: 4 } } })
  })

  it('the roster keeps until when only for a member at its limit, plain text only', () => {
    roster({ at: Date.now() + 3600000, text: 'until 15:00\u0007' })
    const file = JSON.parse(fs.readFileSync(join(dir, '.tessel', 'team-channel', teamId, 'roster.json'), 'utf8'))
    expect(file.members[B.id].until).toEqual({ at: expect.any(Number), text: 'until 15:00' })
    expect(file.members[A.id].until).toBeUndefined()
  })

  it('team_send keeps the message and tells the sender at once', async () => {
    roster({ at: Date.now() + 3600000, text: 'until 15:00' })
    const r = mcp.send(as(A), '#4', 'Please review T3')
    expect(r).toMatchObject({ ok: true, limited: [{ name: 'Claude Code', until: 'until 15:00' }] })
    as(A)
    const shown = await mcp.handle({ id: 1, method: 'tools/call', params: { name: 'team_send', arguments: { to: '#4', text: 'Another one' } } })
    expect(shown.content[0].text).toMatch(/Claude Code is at its usage limit until 15:00: your message waits/)
    // A group send says it for each member at its limit.
    expect(mcp.send(as(A), '@claude', 'hello').limited).toHaveLength(1)
  })

  it('team_ask answers at once instead of waiting for its timeout', async () => {
    roster({ at: Date.now() + 3600000, text: 'until 15:00' })
    const started = Date.now()
    const r = await mcp.ask(as(A), { to: '#4', question: 'Is the API done?', wait_seconds: 30 })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/at its usage limit until 15:00: it cannot answer before then/)
    expect(r.text).toMatch(/team_ask \{"resume":"q-/)
  })

  it('team_members says until when; a reset time passed counts as free', () => {
    roster({ at: Date.now() + 3600000, text: 'until 15:00' })
    expect(mcp.members(as(A))).toMatch(/Claude Code \(Claude Code\) \[claude, limited by its usage limit until 15:00, messages wait\]/)
    roster({ at: Date.now() - 1000, text: 'until 09:00' })
    expect(mcp.send(as(A), '#4', 'now?').limited).toEqual([])
    expect(mcp.members(as(A))).not.toMatch(/limited/)
  })
})
