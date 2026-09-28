import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createClaudeUsageReport, parseClaudeLine } from '../claudeUsageReport'
import { turnCostUsd, pricingModel } from '../../shared/claudePricing'

let dir
afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }))

const row = (o) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: o.session || 's1',
    requestId: o.req,
    timestamp: o.at || new Date().toISOString(),
    cwd: o.cwd || 'C:\\Proj',
    gitBranch: 'main',
    message: {
      id: o.id,
      model: o.model || 'claude-opus-5-5',
      usage: {
        input_tokens: o.input || 0,
        output_tokens: o.output || 0,
        cache_read_input_tokens: o.cacheRead || 0,
        cache_creation_input_tokens: o.cacheWrite || 0,
        cache_creation: { ephemeral_1h_input_tokens: o.cacheWrite1h || 0 }
      }
    }
  })

describe('Claude pricing (from Orca)', () => {
  it('maps model ids and prices a turn', () => {
    expect(pricingModel('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(pricingModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
    expect(pricingModel('claude-3-5-haiku-20241022')).toBe('claude-haiku-3-5')
    expect(pricingModel('gpt-5')).toBe(null)
    // Opus 5.5: $4 in, $20 out, $0.2 cache read, $5 cache write, $8 1-hour write, per million.
    expect(turnCostUsd('claude-opus-5-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 2e6, cacheWrite1h: 1e6 })).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 6)
    expect(turnCostUsd('unknown-model', { input: 1 })).toBe(null)
  })
})

describe('Claude usage report', () => {
  it('one turn per message and request (largest counts), by day, model, project and conversation', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-claude-usage-'))
    fs.mkdirSync(join(dir, 'C--Proj'))
    fs.writeFileSync(
      join(dir, 'C--Proj', 'a.jsonl'),
      [
        row({ id: 'm1', req: 'r1', input: 10, output: 5 }),
        row({ id: 'm1', req: 'r1', input: 10, output: 500 }), // same reply, fuller
        row({ id: 'm2', req: 'r2', input: 1000, cacheRead: 2000, model: 'claude-sonnet-5', cwd: 'C:\\Other' }),
        '{"type":"user","message":{"content":"hi"}}',
        'not json'
      ].join('\n')
    )
    // A resumed conversation copies an earlier turn into a new file: counted once.
    fs.writeFileSync(join(dir, 'C--Proj', 'b.jsonl'), row({ id: 'm1', req: 'r1', input: 10, output: 500, session: 's2' }))
    const report = createClaudeUsageReport({ dir })
    const r = await report()
    expect(r.totals).toMatchObject({ turns: 2, input: 1010, output: 500, cacheRead: 2000, unpriced: 0 })
    expect(r.byModel.map((m) => m.model).sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5'])
    expect(r.byProject.map((p) => p.label).sort()).toEqual(['Other', 'Proj'])
    expect(r.byDay).toHaveLength(1)
    expect(r.totals.cost).toBeCloseTo((10 * 4 + 500 * 20) / 1e6 + (1000 * 2 + 2000 * 0.2) / 1e6, 9)
    // Parsed again only when a file changes.
    fs.appendFileSync(join(dir, 'C--Proj', 'a.jsonl'), '\n' + row({ id: 'm3', req: 'r3', output: 7 }))
    expect((await report()).totals.turns).toBe(3)
  })

  it('ignores lines without usage', () => {
    expect(parseClaudeLine('{"type":"user"}')).toBe(null)
  })
})
