// @vitest-environment node
// Muse Code 1.4.10's session log as it really writes it (record shapes taken
// from a real install, contents made up): the chat view (prompts with
// images, thinking, tool calls and results with their images, a failed turn),
// the context ring (its latest call's tokens in its catalog's window), the
// usage report (each model call's tokens, its sub-agents' too), deleting a
// conversation, and its footer read as the model and effort.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { museViewEvents, contextUsageEvent } from '../chat/transcriptView'
import { parseMuseCatalog, createMuseCatalog } from '../museCatalog'
import { createMuseUsageReport, museUsageBucket } from '../museUsageReport'
import { deleteTargets } from '../sessionDetails'
import { hasPendingAttachments } from '../chat/historyAttachments'
import { museFooterModel, modelInLine } from '../../shared/screenModel'
import { refusedModelSwitch } from '../../shared/liveShareAgents'

const SID = '01a153a8-4f9d-7502-a036-aba8fd32aded'
const at = (iso) => Date.parse(iso) * 1000
let seq = 0
// One record as Muse writes it: { schema_version, id, stream, sequence,
// recorded_at (µs), record_type, durability, payload_type, payload }.
const rec = (payload_type, payload, iso) =>
  JSON.stringify({ schema_version: 1, id: `r-${++seq}`, stream: { kind: 'session', id: SID }, sequence: seq, recorded_at: at(iso), record_type: 'event', durability: 'durable', causation_id: null, payload_type, payload_schema_version: 1, payload })
const run = (event, iso) => rec('runtime.session', { kind: 'run', run_id: 'run-1', event, source_run_record_id: 'x', source_run_record_sequence: 1 }, iso)
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const usage = (input, cached, output, reasoning) => ({ input_tokens: input, output_tokens: output, cached_tokens: cached, cache_write_tokens: 0, cache_read_tokens: cached, reasoning_tokens: reasoning })

function sessionLog() {
  return [
    rec('runtime.session.metadata', { kind: 'metadata', record: { workspace_root: 'C:\\TRADING', provider_id: 'meta', model_id: 'muse-wonder-1.0', web_search_mode: 'cached', build: { sha: 'abc', semver: '1.4.10' }, tool_surface_version: '1' } }, '2026-10-19T10:15:01Z'),
    rec('runtime.user_intent.accepted', { intent_id: 'i1', source_session_id: SID, surface: 'chat', semantic_kind: { kind: 'chat' }, refill_blocks: [{ kind: 'text', text: 'What is in this chart?' }, { kind: 'image', media_type: 'image/png', base64_data: PNG, width: 1, height: 1, source_path: 'C:\\TRADING\\chart.png' }], model_messages: [], bindings: [], delivery_policy: 'x', wake_policy: 'y' }, '2026-10-19T10:15:05Z'),
    run({ kind: 'started', prompt: 'What is in this chart?' }, '2026-10-19T10:15:05.100Z'),
    rec('run.model.configured', { kind: 'run_model', record: { command_id: 'c', run_stream: { kind: 'run', id: 'run-1' }, provider_id: 'meta', profile_id: 'tbh', model_id: 'muse-wonder-1.0', display_label: 'muse-wonder-1.0', source: 'startup' } }, '2026-10-19T10:15:05.200Z'),
    run({ kind: 'reasoning_committed', message_id: 'm0', response_id: 'r', text: '', provider_item_id: 'p', encrypted_content: 'xxxx' }, '2026-10-19T10:15:07Z'),
    run({ kind: 'reasoning_summary_committed', message_id: 'm1', response_id: 'r', text: 'Looking at the file first.', provider_item_id: 'p' }, '2026-10-19T10:15:07.100Z'),
    run({ kind: 'assistant_tool_calls_committed', message_id: 'm2', response_id: 'r', tool_calls: [{ id: 'fc_1', call_id: 'call_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', name: 'read_file', args: '{"path":"C:\\\\TRADING\\\\chart.png"}' }, { id: 'fc_2', call_id: 'call_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2', name: 'mcp__tessel_team__team_inbox', args: '{}' }] }, '2026-10-19T10:15:08Z'),
    run({ kind: 'tool_result_model_visible_content', call_id: 'call_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', content: [{ kind: 'image', source_tool_name: 'read_file', path: 'C:\\TRADING\\chart.png', media_type: 'image/png', base64_data: PNG, width: 1, height: 1 }] }, '2026-10-19T10:15:08.500Z'),
    run({ kind: 'tool_result_batch_committed', batch_id: 'b1', results: [{ tool_call_index: 0, tool_call_id: 'call_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', text: 'image read' }, { tool_call_index: 1, tool_call_id: 'call_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2', text: 'No messages.' }] }, '2026-10-19T10:15:09Z'),
    run({ kind: 'model_completed', usage: usage(35642, 0, 68, 3), duration_ms: 900, model: 'muse-wonder-1.0' }, '2026-10-19T10:15:10Z'),
    run({ kind: 'assistant_message_committed', message_id: 'm3', response_id: 'r', text: 'A rising price line.', provider_item_id: 'p' }, '2026-10-19T10:15:11Z'),
    run({ kind: 'model_completed', usage: usage(36772, 35572, 160, 13), duration_ms: 900, model: 'muse-wonder-1.0' }, '2026-10-19T10:15:11.500Z'),
    run({ kind: 'terminal', terminal: 'completed', reason: null, turn_duration_ms: 6000 }, '2026-10-19T10:15:12Z'),
    rec('runtime.user_intent.accepted', { intent_id: 'i2', refill_blocks: [{ kind: 'text', text: 'And now?' }] }, '2026-10-19T10:16:00Z'),
    run({ kind: 'started', prompt: 'And now?' }, '2026-10-19T10:16:00.100Z'),
    run({ kind: 'model_failure_terminal_intent', reason: 'API error 402: Billing verification failed.' }, '2026-10-19T10:16:01Z'),
    run({ kind: 'terminal', terminal: 'failed', reason: 'API error 402: Billing verification failed.', turn_duration_ms: 500, failure_retryable: false }, '2026-10-19T10:16:01.100Z')
  ]
}

const LIMITS = { events: 5000, text: 100000, attachments: { maxImages: 20, maxBytes: 1024 * 1024, pageBytes: 1024 * 1024 } }

describe('Muse Code 1.4.10: the chat view', () => {
  it('prompts with their images, thinking, tool calls and results (and their images), each turn ending as it did', () => {
    const events = museViewEvents(sessionLog(), LIMITS)
    const kinds = events.map((e) => e.type)
    expect(kinds.filter((k) => k === 'user')).toHaveLength(2) // "started" repeats the prompt: shown once
    const users = events.filter((e) => e.type === 'user')
    expect(users.map((e) => e.text)).toEqual(['What is in this chart?', 'And now?'])
    expect(hasPendingAttachments(users[0])).toBe(true)
    expect(hasPendingAttachments(users[1])).toBe(false)
    expect(events.find((e) => e.type === 'thinking')).toMatchObject({ text: 'Looking at the file first.' })
    const tools = events.filter((e) => e.type === 'tool' && e.name)
    expect(tools.map((e) => [e.name, e.input])).toEqual([
      ['read_file', { path: 'C:\\TRADING\\chart.png' }],
      ['mcp__tessel_team__team_inbox', {}]
    ])
    const results = events.filter((e) => e.type === 'toolResult')
    expect(results.map((e) => e.text)).toEqual(['image read', 'No messages.'])
    expect(hasPendingAttachments(results[0])).toBe(true)
    expect(events.find((e) => e.type === 'assistant')).toMatchObject({ text: 'A rising price line.' })
    const ends = events.filter((e) => e.type === 'turnEnd')
    expect(ends.map((e) => e.status)).toEqual(['completed', 'failed'])
    expect(ends[1].error).toMatch(/Billing verification failed/)
  })

  it('the context ring: the latest call (input with its cached part, and the answer) in the window its catalog gives', () => {
    expect(contextUsageEvent('muse', sessionLog(), { museWindow: (m) => (m === 'muse-wonder-1.0' ? 1007997 : null) })).toEqual({ type: 'contextUsage', usedTokens: 36772 + 160, windowTokens: 1007997 })
    expect(contextUsageEvent('muse', sessionLog(), { museWindow: () => null })).toMatchObject({ windowTokens: null })
    expect(contextUsageEvent('muse', sessionLog().slice(0, 3), { museWindow: () => 1 })).toBe(null)
  })
})

describe("Muse Code's model catalog (its context windows)", () => {
  const CATALOG = JSON.stringify({ schema_version: 2, provider_id: 'meta', profile_id: 'tbh', source: 'provider_catalog', rows: [
    { model_id: 'muse-wonder-1.0', display_label: 'muse-wonder-1.0', visibility: 'visible', context_limit: 1007997, output_limit: 128000, reasoning_effort_variants: [{ tier: 'minimal' }, { tier: 'max' }], is_default: true },
    { model_id: 'muse-image-1.0', display_label: 'muse-image-1.0', visibility: 'hidden', context_limit: null, output_limit: null },
    { model_id: 'bad id; x', context_limit: 5 }
  ] })
  it('each model with its window, read from its file without blocking', async () => {
    const m = parseMuseCatalog(CATALOG)
    expect([...m.keys()]).toEqual(['muse-wonder-1.0', 'muse-image-1.0'])
    expect(m.get('muse-wonder-1.0')).toMatchObject({ contextLimit: 1007997, outputLimit: 128000 })
    expect(m.get('muse-image-1.0')).toMatchObject({ contextLimit: null, hidden: true })
    const home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-muse-cat-'))
    try {
      fs.mkdirSync(join(home, '.local', 'share', 'muse', 'model-catalog'), { recursive: true })
      fs.writeFileSync(join(home, '.local', 'share', 'muse', 'model-catalog', '6d657461__p746268.json'), CATALOG)
      const cat = createMuseCatalog({ home, env: {} })
      expect(cat.contextWindow('muse-wonder-1.0')).toBe(null) // not read yet: never a guess
      await cat.refresh()
      expect(cat.contextWindow('muse-wonder-1.0')).toBe(1007997)
      expect(cat.contextWindow('unknown')).toBe(null)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('Muse Code usage report (Stats)', () => {
  let home
  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-muse-report-'))
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it('cached input and reasoning taken out of input and output; no price', () => {
    expect(museUsageBucket(usage(36772, 35572, 160, 13))).toEqual({ input: 1200, output: 147, reasoning: 13, cacheRead: 35572, cacheWrite: 0, cost: null })
    expect(museUsageBucket({})).toBe(null)
  })

  it('every model call of each log, its sub-agents under its own session, read again only where it grew', async () => {
    const dir = join(home, '.local', 'share', 'muse', 'sessions', '2026', '10', '19', SID)
    fs.mkdirSync(join(dir, 'subagent', '01a153a6-ca17-7063-b357-4151e74178d6'), { recursive: true })
    fs.writeFileSync(join(dir, 'session.jsonl'), sessionLog().join('\n') + '\n')
    const child = [rec('runtime.session.metadata', { kind: 'metadata', record: { workspace_root: 'C:\\TRADING', model_id: 'muse-spark-1.3' } }, '2026-10-19T10:15:20Z'), run({ kind: 'model_completed', usage: usage(1000, 0, 10, 0), model: 'muse-spark-1.3' }, '2026-10-19T10:15:21Z')]
    fs.writeFileSync(join(dir, 'subagent', '01a153a6-ca17-7063-b357-4151e74178d6', 'session.jsonl'), child.join('\n') + '\n')
    const report = createMuseUsageReport({ home, env: {}, now: () => Date.parse('2026-10-19T12:00:00Z'), timezone: 'UTC' })
    const r = await report({})
    const models = Object.fromEntries((r.byModel || []).map((m) => [m.model, m]))
    expect(Object.keys(models).sort()).toEqual(['muse-spark-1.3', 'muse-wonder-1.0'])
    expect(models['muse-wonder-1.0']).toMatchObject({ input: 35642 + 1200, cacheRead: 35572, output: 65 + 147, reasoning: 16 })
    expect(models['muse-spark-1.3']).toMatchObject({ input: 1000, output: 10 })
    // One conversation, in its folder.
    expect((r.sessions || r.bySession || []).length).toBe(1)
    // It grew: only the new call is added.
    fs.appendFileSync(join(dir, 'session.jsonl'), run({ kind: 'model_completed', usage: usage(500, 0, 5, 0), model: 'muse-wonder-1.0' }, '2026-10-19T10:17:00Z') + '\n')
    const again = await report({})
    expect(Object.fromEntries(again.byModel.map((m) => [m.model, m]))['muse-wonder-1.0'].input).toBe(35642 + 1200 + 500)
  })
})

describe('Muse Code: deleting a conversation, its footer, a guest under a model rule', () => {
  it('its own session folder only, never a day folder', () => {
    const top = fs.mkdtempSync(join(os.tmpdir(), 'tessel-muse-del-'))
    try {
      const root = join(top, 'sessions')
      const dir = join(root, '2026', '10', '19', SID)
      fs.mkdirSync(dir, { recursive: true })
      fs.mkdirSync(join(top, 'elsewhere', SID), { recursive: true })
      const file = join(dir, 'session.jsonl')
      fs.writeFileSync(file, '')
      fs.writeFileSync(join(root, '2026', '10', '19', 'session.jsonl'), '')
      expect(deleteTargets('muse', { file, root })).toEqual([dir])
      expect(deleteTargets('muse', { file: join(root, '2026', '10', '19', 'session.jsonl'), root })).toEqual([])
      expect(deleteTargets('muse', { file: join(top, 'elsewhere', SID, 'session.jsonl'), root })).toEqual([])
    } finally {
      fs.rmSync(top, { recursive: true, force: true })
    }
  })

  it('its footer "model · effort · folder · mode" read as the model and effort', () => {
    expect(museFooterModel(['', '› ', 'muse-wonder-1.0 · medium · C:\\TRADING · YOLO', ''])).toEqual({ model: 'muse-wonder-1.0', effort: 'medium' })
    expect(museFooterModel(['muse-spark-1.3 · xhigh · /home/me/proj · default'])).toEqual({ model: 'muse-spark-1.3', effort: 'xhigh' })
    expect(museFooterModel(['I like muse-wonder-1.0 · turbo · a'])).toBe(null)
    expect(modelInLine('muse-wonder-1.0 · medium · C:\\TRADING · YOLO')).toBe('muse-wonder-1.0')
  })

  it("its /models picker and /settings panel are refused where a rule limits its models", () => {
    const rule = { deny: [], later: true, known: ['muse'], models: { muse: ['muse-wonder-1.0'] } }
    expect(refusedModelSwitch(rule, 'muse', '/models')).toBe(true)
    expect(refusedModelSwitch(rule, 'muse', '/settings')).toBe(true)
    expect(refusedModelSwitch(rule, 'muse', '/model muse-wonder-1.0')).toBe(false)
    expect(refusedModelSwitch(rule, 'muse', '/model muse-spark-1.3')).toBe(true)
    expect(refusedModelSwitch(rule, 'muse', '/effort high')).toBe(false)
  })
})
