// @vitest-environment node
// Grok Build (xAI's official CLI, `grok`): its session files read for the chat
// view, Conversations, Past conversations and Stats; its model and effort for
// the pane header; its subscription tier; its team tools, rules and skills
// folders. Fixtures are shaped like the files Grok Build 1.0.62 writes
// (~/.grok/sessions/<encoded folder>/<id>/updates.jsonl, summary.json,
// chat_history.jsonl; auth.json, settings_cache.json, models_cache.json,
// config.toml), with made-up values and no secrets.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  contextUsageEvent,
  findTranscriptViewFile,
  grokModelTimeline,
  grokUpdateViewEvents,
  grokViewEvents,
  transcriptViewRoots
} from '../chat/transcriptView'
import { conversationItems } from '../chat/terminalConversations'
import { resolveHistoryAttachments } from '../chat/historyAttachments'
import { agentModel } from '../agentModel'
import { _clearModelSourceCachesForTest, grokCatalogEntry, grokConfigModel, grokSummaryModel } from '../agentModelSources'
import { grokPlanAttention, grokSignInKind, grokTier, grokUserPlan, readGrokPlanLocal } from '../grokAccount'
import { createGrokUsageReport, grokUsageEvents } from '../grokUsageReport'
import { grokTable, installGrokServer } from '../teamInstall'
import { memoryFile } from '../agentMemory'
import { skillRoots, SKILL_AGENTS } from '../skillsManager'
import { findSessionFile, latestModel } from '../sessionDetails'
import { rowsFromLines } from '../sessionSearch/indexer'
import { createExtraProviderUsage, USAGE_URLS } from '../extraProviderUsage'
import { parseGrokModelList } from '../../shared/agentModelProbe'

const SID = '01a1528f-1df9-7b12-a61e-74c0ee13bbbf'
const T0 = Date.parse('2026-10-19T05:08:56Z')
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='

const upd = (ms, update, meta = {}) =>
  JSON.stringify({ timestamp: Math.floor(ms / 1000), method: update.sessionUpdate === 'hook_execution' || update.sessionUpdate === 'turn_completed' ? '_x.ai/session/update' : 'session/update', params: { sessionId: SID, update, _meta: { eventId: `${SID}-1`, agentTimestampMs: ms, ...meta } } })
const usage = { inputTokens: 117564, outputTokens: 1426, totalTokens: 118990, cachedReadTokens: 69632, cacheCreationTokens: 0, reasoningTokens: 932, modelCalls: 3, apiDurationMs: 18649, costUsdTicks: 1392360000 }
const UPDATES = [
  upd(T0 - 60000, { sessionUpdate: 'hook_execution', event_name: 'session_start', runs: [{ name: 'tessel', status: { status: 'success', elapsed_ms: 40 } }] }),
  upd(T0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Fix the login bug please' }, _meta: { modelId: 'grok-4.7', promptIndex: 0 } }),
  upd(T0 + 1, { sessionUpdate: 'user_message_chunk', content: { type: 'image', data: PNG, mimeType: 'image/png' }, _meta: { modelId: 'grok-4.7', promptIndex: 0 } }),
  upd(T0 + 2000, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Looking at the auth code.' } }, { totalTokens: 2750, promptId: 'p1' }),
  upd(T0 + 2500, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me search ' } }, { totalTokens: 2750 }),
  upd(T0 + 2600, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first.' } }, { totalTokens: 2750 }),
  upd(T0 + 3000, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'search_tool', rawInput: { query: 'login', limit: 5 }, _meta: { 'x.ai/tool': { name: 'search_tool', label: 'Searching tools', read_only: true } } }, { totalTokens: 19950 }),
  upd(T0 + 3100, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', kind: 'other', title: 'Searching tools' }, { totalTokens: 19950 }),
  upd(T0 + 4000, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '3 results' } }, { type: 'content', content: { type: 'image', data: PNG, mimeType: 'image/png' } }], rawOutput: { type: 'SearchTool', result_count: 3, content: '3 results' } }, { totalTokens: 39476 }),
  upd(T0 + 4001, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' }),
  upd(T0 + 9000, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixed: the token check was inverted.' } }, { totalTokens: 51659 }),
  upd(T0 + 11000, { sessionUpdate: 'turn_completed', prompt_id: 'p1', stop_reason: 'end_turn', usage: { ...usage, modelUsage: { 'grok-4.7-build': usage }, numTurns: 3 }, elapsed_ms: 11000 }),
  upd(T0 + 60000, { sessionUpdate: 'config_option_update', configOptions: [{ id: 'thought_level', category: 'thought_level', currentValue: 'xhigh' }] }),
  upd(T0 + 61000, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'thanks' }, _meta: { modelId: 'grok-4.6', promptIndex: 1 } }),
  upd(T0 + 64000, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'You are welcome.' } }, { totalTokens: 52000 }),
  upd(T0 + 65000, { sessionUpdate: 'turn_completed', prompt_id: 'p2', stop_reason: 'cancelled', usage: { inputTokens: 1000, outputTokens: 10, cachedReadTokens: 0, reasoningTokens: 0, costUsdTicks: 20000000, modelUsage: { 'grok-4.6': { inputTokens: 1000, outputTokens: 10, costUsdTicks: 20000000 } } } })
]
// An older session's raw model messages (no times).
const CHAT_HISTORY = [
  JSON.stringify({ type: 'system', content: 'You are Grok.' }),
  JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_info>os: windows</user_info>' }] }),
  JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\nhello\n</user_query>' }] }),
  JSON.stringify({ type: 'assistant', content: 'Hi there.', model_id: 'grok-4.7-build', reasoning_effort: 'high' })
]

let home
const grokDir = () => path.join(home, '.grok')
const sessionDir = (id = SID) => path.join(grokDir(), 'sessions', 'C%3A%5CWORK', id)
function writeSession({ id = SID, updates = UPDATES, chat = CHAT_HISTORY, summary = {} } = {}) {
  const dir = sessionDir(id)
  fs.mkdirSync(dir, { recursive: true })
  if (updates) fs.writeFileSync(path.join(dir, 'updates.jsonl'), updates.join('\n') + '\n')
  if (chat) fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), chat.join('\n') + '\n')
  fs.writeFileSync(
    path.join(dir, 'summary.json'),
    JSON.stringify({ info: { id, cwd: 'C:\\WORK' }, created_at: '2026-10-19T05:07:53Z', updated_at: '2026-10-19T05:09:17Z', current_model_id: 'grok-4.7', reasoning_effort: 'high', generated_title: 'Fix the login bug', agent_name: 'grok-build-plan', ...summary })
  )
  return dir
}
const modelsCache = () =>
  JSON.stringify({
    fetched_at: '2026-10-19T05:07:53Z',
    auth_method: 'session',
    models: {
      'grok-4.7': { info: { id: 'grok-4.7', name: 'Grok 4.7', reasoning_effort: 'high', supports_reasoning_effort: true, reasoning_efforts: [{ id: 'x', value: 'xhigh' }, { id: 'h', value: 'high', default: true }, { id: 'm', value: 'medium' }], context_window: 256000 } },
      'grok-4.6': { info: { id: 'grok-4.6', name: 'Grok 4.6', reasoning_efforts: [{ value: 'medium', default: true }] } }
    }
  })
const settingsCache = (settings) => JSON.stringify({ payload: JSON.stringify({ fetched_at: '2026-10-19T05:07:53Z', client: 'grok-shell', settings }), signature: [1, 2, 3] })
const authJson = (row = {}) =>
  JSON.stringify({ 'https://auth.x.ai::b1a00492-0000-0000-0000-000000000000': { key: 'fixture-session-token', auth_mode: 'oidc', user_id: 'u-1', email: 'ada@example.com', principal_type: 'User', team_id: 't-1', refresh_token: 'fixture-refresh', expires_at: '2099-01-01T00:00:00Z', oidc_issuer: 'https://auth.x.ai', ...row } })

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-grok-'))
  vi.stubEnv('GROK_HOME', '')
  vi.stubEnv('XAI_API_KEY', '')
  _clearModelSourceCachesForTest()
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('Grok Build session files: chat view, Conversations, Past conversations', () => {
  it('the update stream: prompts with their images, thinking, answers, tools with their results, turns, each timed', () => {
    const limits = { bytes: 4 << 20, events: 2000, text: 64 * 1024, attachments: { images: 4, imageBytes: 2 << 20, pageImages: 40, pageBytes: 12 << 20, files: 8, name: 120 } }
    const events = grokUpdateViewEvents(UPDATES, limits)
    resolveHistoryAttachments(events, limits.attachments, { local: false })
    const users = events.filter((e) => e.type === 'user')
    expect(users.map((u) => u.text)).toEqual(['Fix the login bug please', 'thanks'])
    expect(users[0].at).toBe(T0)
    expect(users[0].images).toHaveLength(1)
    expect(events.find((e) => e.type === 'toolResult').images).toHaveLength(1)
    expect(events.find((e) => e.type === 'thinking').text).toBe('Looking at the auth code.')
    const answers = events.filter((e) => e.type === 'assistant').map((e) => e.text)
    // Chunks of one message joined; the text after the tool call is a message of its own.
    expect(answers).toEqual(['Let me search first.', 'Fixed: the token check was inverted.', 'You are welcome.'])
    const tool = events.find((e) => e.type === 'tool' && e.name)
    expect(tool).toMatchObject({ id: 'call_1', name: 'search_tool', input: { query: 'login', limit: 5 } })
    const results = events.filter((e) => e.type === 'toolResult')
    expect(results).toHaveLength(1) // the repeated "completed" is not a second result
    expect(results[0]).toMatchObject({ id: 'call_1', isError: false, text: '3 results' })
    const ends = events.filter((e) => e.type === 'turnEnd')
    expect(ends.map((e) => e.status)).toEqual(['completed', 'interrupted'])
    expect(ends[0].at).toBe(T0 + 11000)
    // Hook runs and settings changes are not the conversation.
    expect(events.some((e) => /hook|thought_level/.test(JSON.stringify(e.text || '')))).toBe(false)
  })

  it('an older session (chat_history.jsonl only) still reads, through the same entry point', () => {
    const events = grokViewEvents(CHAT_HISTORY)
    expect(events.filter((e) => e.type === 'user').map((e) => e.text)).toEqual(['hello'])
    expect(events.find((e) => e.type === 'assistant').text).toBe('Hi there.')
    // The update stream wins when the lines are its own.
    expect(grokViewEvents(UPDATES).filter((e) => e.type === 'user')).toHaveLength(2)
  })

  it("finds the session's update stream first, else its chat_history.jsonl", () => {
    writeSession()
    const roots = transcriptViewRoots(home, {})
    expect(findTranscriptViewFile('grok', SID, roots)).toBe(path.join(sessionDir(), 'updates.jsonl'))
    fs.rmSync(path.join(sessionDir(), 'updates.jsonl'))
    expect(findTranscriptViewFile('grok', SID, roots)).toBe(path.join(sessionDir(), 'chat_history.jsonl'))
    expect(findTranscriptViewFile('grok', '../escape', roots)).toBeNull()
  })

  it('Conversations: your prompts and its final answers, timed, with the model each ran with', () => {
    const items = conversationItems('grok', UPDATES, SID)
    expect(items.map((i) => [i.role, i.text])).toEqual([
      // Its image goes with the line (Conversations' image caps), not as text.
      ['user', 'Fix the login bug please'],
      ['agent', 'Fixed: the token check was inverted.'],
      ['user', 'thanks'],
      ['agent', 'You are welcome.']
    ])
    expect(items[0].t).toBe(T0)
    expect(items[0].model).toBe('grok-4.7')
    expect(items[1].model).toBe('grok-4.7')
    expect(items[2]).toMatchObject({ model: 'grok-4.6', effort: 'xhigh' })
  })

  it('the model timeline and the context the latest request used', () => {
    expect(grokModelTimeline(UPDATES)).toEqual([
      { t: T0, model: 'grok-4.7', effort: null },
      { t: T0 + 60000, model: 'grok-4.7', effort: 'xhigh' },
      { t: T0 + 61000, model: 'grok-4.6', effort: 'xhigh' }
    ])
    expect(contextUsageEvent('grok', UPDATES)).toEqual({ type: 'contextUsage', usedTokens: 52000, windowTokens: null })
  })

  it('Past conversations: the session file, its latest model, and search rows with times', () => {
    writeSession()
    const found = findSessionFile({ agent: 'grok', id: SID }, home)
    expect(found.file).toBe(path.join(sessionDir(), 'updates.jsonl'))
    expect(latestModel('grok', UPDATES)).toEqual({ model: 'grok-4.6', effort: 'xhigh' })
    const rows = rowsFromLines('grok', UPDATES, SID)
    expect(rows.find((r) => r.role === 'user')).toMatchObject({ text: 'Fix the login bug please\n[image]', ts: T0 })
  })
})

describe('Grok Build model and effort (pane header, sender identity, Conversations)', () => {
  it('its session summary: current model, effort, and the name its catalog gives', () => {
    writeSession()
    fs.writeFileSync(path.join(grokDir(), 'models_cache.json'), modelsCache())
    expect(agentModel({ agentId: 'grok', sessionId: SID, command: 'grok', cwd: 'C:\\WORK' }, home)).toMatchObject({ model: 'grok-4.7', effort: 'high', name: 'Grok 4.7', source: 'session' })
  })

  it('no session yet: -m / --reasoning-effort, then config.toml [models], then the default its settings fetch named', () => {
    fs.mkdirSync(grokDir(), { recursive: true })
    expect(agentModel({ agentId: 'grok', command: 'grok -m grok-4.6 --reasoning-effort low' }, home)).toMatchObject({ model: 'grok-4.6', effort: 'low', source: 'command' })
    fs.writeFileSync(path.join(grokDir(), 'models_cache.json'), modelsCache())
    fs.writeFileSync(path.join(grokDir(), 'settings_cache.json'), settingsCache({ default_model: 'grok-4.7', subscription_tier_display: 'SuperGrok' }))
    expect(agentModel({ agentId: 'grok', command: 'grok' }, home)).toMatchObject({ model: 'grok-4.7', effort: 'high', name: 'Grok 4.7', source: 'settings' })
    fs.writeFileSync(path.join(grokDir(), 'config.toml'), '[cli]\ninstaller = "internal"\n\n[models]\ndefault = "grok-4.6"\ndefault_reasoning_effort = "xhigh"\n')
    expect(agentModel({ agentId: 'grok', command: 'grok' }, home)).toMatchObject({ model: 'grok-4.6', effort: 'xhigh', name: 'Grok 4.6', source: 'settings' })
  })

  it('pure readers', () => {
    expect(grokSummaryModel({ current_model_id: 'grok-4.7', reasoning_effort: 'HIGH', updated_at: '2026-10-19T05:09:17Z' })).toEqual({ model: 'grok-4.7', effort: 'high', at: Date.parse('2026-10-19T05:09:17Z') })
    expect(grokSummaryModel({})).toBeNull()
    expect(grokConfigModel('[models]\ndefault = "grok-4.5"\n')).toEqual({ model: 'grok-4.5', effort: null })
    expect(grokCatalogEntry(JSON.parse(modelsCache()), 'grok-4.6')).toEqual({ name: 'Grok 4.6', effort: 'medium' })
  })

  it('`grok models` as Grok Build 1.0.62 prints it', () => {
    const out = 'You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - grok-4.5\n'
    const list = parseGrokModelList(out)
    expect(list.map((m) => m.id)).toEqual(['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'])
    expect(list[0].isDefault).toBe(true)
  })
})

describe('Grok subscription tier and sign-in kind', () => {
  it('tier names in every spelling, and the ones needing attention', () => {
    expect(grokTier('SuperGrok')).toEqual({ tier: 'supergrok', label: 'SuperGrok', paid: true })
    expect(grokTier('SUBSCRIPTION_TIER_SUPERGROK_HEAVY')).toMatchObject({ label: 'SuperGrok Heavy', paid: true })
    expect(grokTier('x_premium_plus')).toMatchObject({ label: 'X Premium+' })
    expect(grokTier('free')).toMatchObject({ label: 'Free', paid: false })
    expect(grokTier('Grok Ultra')).toEqual({ tier: 'grokultra', label: 'Grok Ultra', paid: null })
    expect(grokTier('')).toBeNull()
    expect(grokPlanAttention({ kind: 'subscription', paid: false })).toBe(true)
    expect(grokPlanAttention({ kind: 'subscription', paid: true })).toBe(false)
    expect(grokPlanAttention({ kind: 'api-key', paid: false })).toBe(false)
  })

  it("the plan Grok Build cached, and the sign-in kind, never a token", () => {
    fs.mkdirSync(grokDir(), { recursive: true })
    expect(readGrokPlanLocal(home, {})).toBeNull()
    fs.writeFileSync(path.join(grokDir(), 'auth.json'), authJson())
    fs.writeFileSync(path.join(grokDir(), 'settings_cache.json'), settingsCache({ subscription_tier: null, subscription_tier_display: 'SuperGrok' }))
    const plan = readGrokPlanLocal(home, {})
    expect(plan).toEqual({ label: 'SuperGrok', tier: 'supergrok', paid: true, kind: 'subscription', team: null, source: 'cli', checkedAt: Date.parse('2026-10-19T05:07:53Z') })
    expect(JSON.stringify(plan)).not.toMatch(/fixture-session-token|fixture-refresh/)
    expect(grokSignInKind(JSON.parse(authJson({ principal_type: 'ServiceAccount', team_name: 'Acme' })))).toEqual({ kind: 'team', team: 'Acme' })
    expect(grokSignInKind({}, { XAI_API_KEY: 'xai-fixture' })).toEqual({ kind: 'api-key', team: null })
  })

  it("the profile call's answer", () => {
    expect(grokUserPlan({ userId: 'u', subscriptionTier: 'SUPERGROK_HEAVY', teamName: 'Personal', principalType: 'User' })).toMatchObject({ label: 'SuperGrok Heavy', kind: 'subscription', team: 'Personal' })
    expect(grokUserPlan({})).toBeNull()
  })

  it('the usage read asks the profile call (fixed host) and shows the tier; Settings gets it too', async () => {
    const now = Date.parse('2026-10-19T12:00:00Z')
    const request = vi.fn(async (url, init) => {
      expect(init.redirect).toBe('error')
      if (url === USAGE_URLS.grok) return new Response(JSON.stringify({ config: { creditUsagePercent: 12, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: now - 86400000, end: now + 86400000 } } }))
      if (url === USAGE_URLS.grokUser) return new Response(JSON.stringify({ userId: 'u', subscriptionTier: 'SuperGrok Heavy', teamName: 'Personal' }))
      throw new Error(`unexpected ${url}`)
    })
    const sources = {
      present: vi.fn(async () => true),
      auth: vi.fn(async () => ({ headers: { Authorization: 'Bearer fixture-only', 'X-XAI-Token-Auth': 'xai-grok-cli' }, fingerprint: 'one' })),
      signIn: vi.fn(async () => ({ signedIn: true, email: 'ada@example.com', tokenFresh: true, planType: 'SuperGrok', plan: { label: 'SuperGrok', tier: 'supergrok', paid: true, kind: 'subscription', team: null, source: 'cli', checkedAt: 1 } }))
    }
    const service = createExtraProviderUsage({ sources, request, listAgents: async () => [{ id: 'grok', available: true }], clock: () => now, antigravityCli: { present: () => false, read: async () => ({ ok: false }) }, antigravityPlan: { read: () => null }, museUsage: { present: () => false, read: async () => ({ ok: false }) } })
    const res = await service.read({ provider: 'grok', accountId: null })
    expect(res).toMatchObject({ ok: true, plan: 'SuperGrok Heavy', windows: [{ label: 'Weekly', usedPct: 12 }] })
    expect(request.mock.calls.map(([u]) => u)).toEqual([USAGE_URLS.grok, USAGE_URLS.grokUser])
    expect(USAGE_URLS.grokUser).toBe('https://cli-chat-proxy.grok.com/v1/user')
    const s = await service.signIn('grok')
    expect(s).toMatchObject({ planType: 'SuperGrok Heavy', plan: { label: 'SuperGrok Heavy', source: 'live', checkedAt: now, attention: false, team: 'Personal' } })
    expect(JSON.stringify(res)).not.toMatch(/fixture-only/)
  })

  it('a refused profile call leaves the usage and falls back to the cached tier', async () => {
    const request = vi.fn(async (url) =>
      url === USAGE_URLS.grokUser ? new Response('nope', { status: 403 }) : new Response(JSON.stringify({ config: { creditUsagePercent: 40, billingPeriodEnd: Date.now() + 1000 } }))
    )
    const sources = { present: async () => true, auth: async () => ({ headers: { Authorization: 'Bearer fixture-only' }, fingerprint: 'one' }), signIn: async () => ({ signedIn: true, planType: 'SuperGrok' }) }
    const service = createExtraProviderUsage({ sources, request, listAgents: async () => [{ id: 'grok', available: true }], antigravityCli: { present: () => false, read: async () => ({ ok: false }) }, antigravityPlan: { read: () => null }, museUsage: { present: () => false, read: async () => ({ ok: false }) } })
    expect(await service.read({ provider: 'grok', accountId: null })).toMatchObject({ ok: true, plan: 'SuperGrok', windows: [{ usedPct: 40 }] })
  })
})

describe('Grok Build usage report (Stats), from its own session files', () => {
  it('one event per model of each completed turn, cached input and reasoning taken out, cost from ticks', () => {
    const [e] = grokUsageEvents(UPDATES[11], { sessionId: SID, cwd: 'C:\\WORK', title: 'Fix' })
    expect(e).toEqual({ sessionId: SID, time: T0 + 11000, cwd: 'C:\\WORK', title: 'Fix', model: 'grok-4.7-build', input: 117564 - 69632, output: 1426 - 932, reasoning: 932, cacheRead: 69632, cacheWrite: 0, cost: 0.139236 })
    expect(grokUsageEvents(UPDATES[1], { sessionId: SID })).toEqual([])
  })

  it('the report, read again only from where it stopped', async () => {
    writeSession()
    const report = createGrokUsageReport({ home, env: {}, now: () => T0 + 86400000, timezone: 'UTC' })
    const r = await report({ from: null, to: null })
    expect(r).toMatchObject({ ok: true, provider: 'grok', source: 'grok-local' })
    expect(r.totals.turns).toBe(2)
    expect(r.byModel.map((m) => m.model).sort()).toEqual(['grok-4.6', 'grok-4.7-build'])
    expect(r.sessions[0]).toMatchObject({ id: SID, title: 'Fix the login bug', cwd: 'C:\\WORK' })
    fs.appendFileSync(path.join(sessionDir(), 'updates.jsonl'), upd(T0 + 90000, { sessionUpdate: 'turn_completed', usage: { inputTokens: 10, outputTokens: 5, modelUsage: { 'grok-4.7': { inputTokens: 10, outputTokens: 5 } } } }) + '\n')
    expect((await report({ from: null, to: null })).totals.turns).toBe(3)
  })
})

describe('Grok Build: team tools, task board rule, skills', () => {
  it('[mcp_servers.tessel-team] in its config.toml, the rest kept, written once', () => {
    fs.mkdirSync(grokDir(), { recursive: true })
    const file = path.join(grokDir(), 'config.toml')
    fs.writeFileSync(file, '[cli]\ninstaller = "internal"\n\n[mcp_servers.other]\ncommand = "x"\n')
    const node = process.execPath
    const script = path.join(home, 'tessel-team-mcp.cjs')
    fs.writeFileSync(script, '')
    expect(installGrokServer(script, home, { node, env: {} })).toEqual({ changed: true })
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('[cli]\ninstaller = "internal"')
    expect(text).toContain('[mcp_servers.other]')
    expect(text).toContain(grokTable(script, node).trim())
    expect(text).toContain('TESSEL_PANE_ID = "${TESSEL_PANE_ID:-}"')
    expect(installGrokServer(script, home, { node, env: {} })).toEqual({ changed: false })
    // Not set up for a computer without Grok Build.
    fs.rmSync(grokDir(), { recursive: true, force: true })
    expect(installGrokServer(script, home, { node, env: {} })).toEqual({ changed: false })
    expect(fs.existsSync(grokDir())).toBe(false)
  })

  it('the board rule in its home rules folder; its skills folders', () => {
    expect(memoryFile('grok', home, {})).toBe(path.join(home, '.grok', 'rules', 'tessel-task-board.md'))
    expect(SKILL_AGENTS).toContain('grok')
    const roots = skillRoots({ home, env: {}, cwd: path.join(home, 'proj') })
    expect(roots.find((r) => r.installFor.includes('grok') && r.scope === 'user').path).toBe(path.resolve(home, '.grok', 'skills'))
    expect(roots.find((r) => r.installFor.includes('grok') && r.scope === 'project').path).toBe(path.resolve(home, 'proj', '.grok', 'skills'))
    expect(roots.find((r) => r.path === path.resolve(home, '.claude', 'skills')).seenBy).toContain('grok')
  })
})
