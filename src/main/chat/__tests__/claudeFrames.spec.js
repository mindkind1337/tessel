// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createFrameState,
  normalizeFrame,
  clipText,
  toolResultText,
  permissionFromRequest,
  sessionPermissions,
  sessionRuleItems,
  rateLimitFrom,
  initializeAuthProblem,
  isAuthErrorText,
  contextWindowFromResult,
  contextTokensOf
} from '../claudeFrames'

// Frames recorded from the real Claude Code 2.1.284 (redacted).
const REAL = new Map(
  readFileSync(join(__dirname, 'fixtures', 'claude-real-frames.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((r) => [r.label, r.frame])
)
const frame = (label) => {
  const f = REAL.get(label)
  if (!f) throw new Error('missing fixture ' + label)
  return structuredClone(f)
}
const run = (label, state = createFrameState()) => normalizeFrame(frame(label), state)

describe('claudeFrames against real frames', () => {
  it('system/init -> init', () => {
    const [ev] = run('system-init')
    expect(ev).toMatchObject({
      type: 'init',
      sessionId: 'fa171f27-b38d-4e90-a445-d3c0a8078d88',
      model: 'claude-haiku-4-5-20251001',
      permissionMode: 'default',
      mcpServers: [],
      version: '2.1.284'
    })
    expect(ev.capabilities).toContain('interrupt_receipt_v1')
    expect(ev.tools).toContain('Bash')
  })

  it('session_state_changed -> state', () => {
    expect(run('state-running')).toEqual([{ type: 'state', state: 'running' }])
    expect(run('state-requires-action')).toEqual([{ type: 'state', state: 'requires_action' }])
    expect(run('state-idle')).toEqual([{ type: 'state', state: 'idle' }])
  })

  it('command_lifecycle queued / started and the replay echo: accepted once', () => {
    const uuid = 'ddecf604-66bc-40c5-83f2-c0e644727fa4'
    const ours = () => {
      const s = createFrameState()
      s.sent.add(uuid)
      return s
    }
    const s = ours()
    expect(run('lifecycle-queued', s).filter((e) => e.type !== 'lifecycle')).toEqual([{ type: 'queued', uuid }])
    expect(run('lifecycle-started', s).filter((e) => e.type !== 'lifecycle')).toEqual([{ type: 'accepted', uuid }])
    expect(run('replay-echo', s)).toEqual([]) // already accepted
    // The echo alone also proves it.
    expect(run('replay-echo', ours())).toEqual([{ type: 'accepted', uuid }])
    // Not our message: nothing (only the raw lifecycle).
    expect(run('replay-echo')).toEqual([])
    expect(run('lifecycle-started').map((e) => e.type)).toEqual(['lifecycle'])
    expect(run('lifecycle-cancelled').find((e) => e.type === 'lifecycle').state).toBe('cancelled')
  })

  it('text deltas carry the streamed message id; thinking deltas are skipped', () => {
    const s = createFrameState()
    expect(run('message-start', s)).toEqual([])
    expect(run('thinking-delta', s)).toEqual([])
    expect(run('text-delta', s)).toEqual([{ type: 'textDelta', messageId: 'msg_011CfXWCXD7GpQFv3m9tyPmv', index: 1, text: 'OK', parentToolUseId: null }])
  })

  it('assistant frames -> blocks (empty thinking dropped, tool_use kept)', () => {
    expect(run('assistant-thinking-empty')).toEqual([])
    expect(run('assistant-text')).toEqual([{ type: 'assistant', messageId: 'msg_011CfXWCXD7GpQFv3m9tyPmv', blocks: [{ type: 'text', text: 'OK' }], parentToolUseId: null }])
    const [tool] = run('assistant-tool-use')
    expect(tool.blocks[0]).toMatchObject({ type: 'tool_use', id: 'toolu_01Gk7C5nVG2hHQ1kPsyGk8fk', name: 'Read' })
    expect(tool.blocks[0].input.file_path).toMatch(/notes\.txt$/)
  })

  it('tool results (string content, is_error flag)', () => {
    expect(run('tool-result-string')).toEqual([{ type: 'toolResult', toolUseId: 'toolu_01Gk7C5nVG2hHQ1kPsyGk8fk', isError: false, text: '1\tthe secret fruit is KIWI\n2\t', parentToolUseId: null }])
    expect(run('tool-result-bash')[0]).toMatchObject({ toolUseId: 'toolu_015fbvz2WN4AHR5u6EP8ooY5', isError: false, text: '42' })
    expect(run('tool-result-flag')[0]).toMatchObject({ text: 'second-cmd', isError: false })
  })

  it('user frames that are not tool results or echoes give nothing', () => {
    expect(run('local-command-stdout')).toEqual([])
    expect(run('interrupted-user-text')).toEqual([])
  })

  it('result -> turnEnd completed with usage', () => {
    const [ev] = run('result-success')
    expect(ev).toMatchObject({
      type: 'turnEnd',
      status: 'completed',
      result: 'OK',
      isError: false,
      costUsd: 0.0178657,
      durationMs: 1985,
      userMessageUuids: ['ddecf604-66bc-40c5-83f2-c0e644727fa4'],
      terminalReason: 'completed'
    })
    expect(ev.usage.input_tokens).toBe(10)
    expect(Object.keys(ev.modelUsage)).toEqual(['claude-haiku-4-5-20251001'])
  })

  it('context usage: the last main-thread response in the window the result reports, after turnEnd', () => {
    const s = createFrameState()
    run('system-init', s)
    run('assistant-text', s)
    const out = run('result-success', s)
    expect(out.map((e) => e.type)).toEqual(['turnEnd', 'contextUsage'])
    // 10 input + 7881 cache writes + 18737 cache reads, in haiku's 200k.
    expect(out[1]).toEqual({ type: 'contextUsage', usedTokens: 26628, windowTokens: 200000 })
  })

  it('context window: the model that answered, not a sub-agent or side call', () => {
    const modelUsage = { 'claude-haiku-4-5-20251001': { contextWindow: 200000, canonicalModel: 'claude-haiku-4-5' }, 'claude-sonnet-5-5': { contextWindow: 1000000 } }
    expect(contextWindowFromResult(modelUsage, { initModel: 'claude-sonnet-5-5', responseModel: 'claude-sonnet-5-5' })).toBe(1000000)
    expect(contextWindowFromResult(modelUsage, { initModel: null, responseModel: 'claude-haiku-4-5' })).toBe(200000)
    expect(contextWindowFromResult(modelUsage, {})).toBe(1000000)
    expect(contextWindowFromResult(null)).toBeNull()
    expect(contextTokensOf({ input_tokens: 0, output_tokens: 3 })).toBeNull()
  })

  it('compact_boundary -> compacted; the context is unknown until the next response', () => {
    const s = createFrameState()
    run('assistant-text', s)
    expect(normalizeFrame({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 26628 } }, s)).toEqual([
      { type: 'compacted', trigger: 'manual', preTokens: 26628 }
    ])
    const out = normalizeFrame({ type: 'result', subtype: 'success', is_error: false, result: '', modelUsage: { x: { contextWindow: 200000 } } }, s)
    expect(out.at(-1)).toEqual({ type: 'contextUsage', usedTokens: null, windowTokens: 200000 })
  })

  it('interrupted result -> turnEnd interrupted', () => {
    const [ev] = run('result-interrupted')
    expect(ev).toMatchObject({ type: 'turnEnd', status: 'interrupted', isError: true, result: '', terminalReason: 'aborted_streaming' })
  })

  it('an error result after our interrupt is interrupted even without terminal_reason', () => {
    const s = createFrameState()
    s.interruptRequested = true
    const f = frame('result-interrupted')
    delete f.terminal_reason
    expect(normalizeFrame(f, s)[0].status).toBe('interrupted')
    expect(s.interruptRequested).toBe(false)
    expect(normalizeFrame(f, s)[0].status).toBe('failed')
  })

  it('rate_limit_event -> rateLimit', () => {
    expect(run('rate-limit')).toEqual([
      { type: 'rateLimit', status: 'allowed', fiveHour: { utilization: 0.25, resetsAt: 1790685600 }, sevenDay: { utilization: 0.38, resetsAt: 1791082800 } }
    ])
  })

  it('frames the chat does not show give nothing', () => {
    for (const l of ['hook-started', 'thinking-tokens']) expect(run(l)).toEqual([])
    expect(normalizeFrame({ type: 'keep_alive' }, createFrameState())).toEqual([])
    expect(normalizeFrame(null, createFrameState())).toEqual([])
  })

  it('can_use_tool -> permission payload', () => {
    const f = frame('can-use-tool')
    const p = permissionFromRequest(f.request_id, f.request)
    expect(p).toEqual({
      requestId: '8a75eb38-46f9-48e4-8111-d800af401989',
      toolName: 'Bash',
      displayName: 'Bash',
      input: { command: 'node -e "console.log(6*7)"', description: 'Run Node.js command to output 6*7' },
      description: 'Run Node.js command to output 6*7',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'node -e "console.log(6*7)"' }], behavior: 'allow', destination: 'localSettings' }],
      sessionRules: [{ kind: 'rule', tool: 'Bash', content: 'node -e "console.log(6*7)"' }],
      toolUseId: 'toolu_015fbvz2WN4AHR5u6EP8ooY5',
      reason: 'This command requires approval'
    })
  })

  it('session permissions never keep localSettings', () => {
    const f = frame('can-use-tool')
    const out = sessionPermissions(f.request.permission_suggestions)
    expect(out).toEqual([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'node -e "console.log(6*7)"' }], behavior: 'allow', destination: 'session' }])
    expect(sessionPermissions([{ type: 'setMode', mode: 'acceptEdits', destination: 'projectSettings' }, null, 'x'])).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
    expect(sessionPermissions(undefined)).toEqual([])
  })

  it('session permissions keep only what the card shows: allow rules, a mode (never bypass), folders', () => {
    const long = 'x'.repeat(2001)
    const out = sessionPermissions([
      { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Read' }, { toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Bash', ruleContent: long }, { ruleContent: 'no tool' }], destination: 'userSettings' },
      { type: 'addRules', behavior: 'deny', rules: [{ toolName: 'Bash' }] },
      { type: 'replaceRules', behavior: 'allow', rules: [{ toolName: 'Bash' }] },
      { type: 'removeRules', behavior: 'allow', rules: [{ toolName: 'Bash' }] },
      { type: 'setMode', mode: 'bypassPermissions' },
      { type: 'setMode', mode: 'acceptEdits' },
      { type: 'addDirectories', directories: ['C:\\other', 5] },
      { type: 'removeDirectories', directories: ['C:\\x'] },
      { type: 'addRules', behavior: 'allow', rules: [], destination: 'session' }
    ])
    expect(out).toEqual([
      { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Read' }, { toolName: 'Bash', ruleContent: 'npm test:*' }], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { type: 'addDirectories', directories: ['C:\\other'], destination: 'session' }
    ])
    expect(sessionRuleItems(out)).toEqual([
      { kind: 'rule', tool: 'Read', content: '' },
      { kind: 'rule', tool: 'Bash', content: 'npm test:*' },
      { kind: 'mode', mode: 'acceptEdits' },
      { kind: 'directories', directories: ['C:\\other'] }
    ])
    // What the card is told is what the answer adds.
    const p = permissionFromRequest('r', { tool_name: 'Bash', input: {}, permission_suggestions: [{ type: 'setMode', mode: 'bypassPermissions' }, { type: 'addDirectories', directories: ['D:\\x'] }] })
    expect(p.sessionRules).toEqual(sessionRuleItems(sessionPermissions(p.suggestions)))
    expect(p.sessionRules).toEqual([{ kind: 'directories', directories: ['D:\\x'] }])
  })

  it('initialize response: signed in (real, account redacted) vs tokenSource none', () => {
    const resp = frame('initialize-response').response.response
    expect(resp.pid).toBeTypeOf('number')
    expect(initializeAuthProblem(resp)).toBe(false)
    expect(initializeAuthProblem({ account: { apiProvider: 'firstParty', tokenSource: 'none' } })).toBe(true)
    expect(initializeAuthProblem({ account: { tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY' } })).toBe(false)
    expect(initializeAuthProblem({ account: { tokenSource: 'claude.ai' } })).toBe(false)
  })
})

describe('claudeFrames helpers', () => {
  it('clipText keeps 8 KB and says how much is left', () => {
    expect(clipText('short')).toBe('short')
    const long = 'a'.repeat(10000)
    expect(clipText(long)).toBe('a'.repeat(8192) + ' … (1808 more bytes)')
    // Never cuts a multi-byte character in half.
    const multi = 'é'.repeat(5000) // 10000 bytes
    const clipped = clipText(multi)
    expect(clipped.startsWith('é'.repeat(4096) + ' … (')).toBe(true)
    expect(clipped).not.toContain('�')
    expect(clipped.endsWith(`(${10000 - 8192} more bytes)`)).toBe(true)
  })

  it('toolResultText flattens blocks', () => {
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }])).toBe('a\n[image]\nb')
    expect(toolResultText(undefined)).toBe('')
  })

  it('rateLimitFrom tolerates a single-window frame', () => {
    expect(rateLimitFrom({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 5, utilization: 0.1 })).toEqual({ status: 'allowed', fiveHour: { utilization: 0.1, resetsAt: 5 }, sevenDay: null })
    expect(rateLimitFrom(undefined)).toEqual({ status: null, fiveHour: null, sevenDay: null })
  })

  it('auth wording', () => {
    expect(isAuthErrorText('Not logged in · Please run /login')).toBe(true)
    expect(isAuthErrorText('Invalid API key · Please run /login')).toBe(true)
    expect(isAuthErrorText('The command output is 42.')).toBe(false)
  })

  it('api_retry authentication_failed and assistant error -> authError', () => {
    const s = createFrameState()
    expect(normalizeFrame({ type: 'system', subtype: 'api_retry', error: 'authentication_failed', error_status: 401 }, s)).toEqual([{ type: 'authError', message: 'authentication_failed' }])
    expect(normalizeFrame({ type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429 }, s)).toEqual([])
    const evs = normalizeFrame({ type: 'assistant', error: 'authentication_failed', message: { id: 'm', content: [{ type: 'text', text: 'x' }] } }, s)
    expect(evs.map((e) => e.type)).toEqual(['authError', 'assistant'])
  })

  it('subagent frames keep their parent tool use id and do not steal the stream id', () => {
    const s = createFrameState()
    normalizeFrame({ type: 'stream_event', event: { type: 'message_start', message: { id: 'main' } }, parent_tool_use_id: null }, s)
    normalizeFrame({ type: 'stream_event', event: { type: 'message_start', message: { id: 'sub' } }, parent_tool_use_id: 'toolu_task' }, s)
    const [d] = normalizeFrame({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }, parent_tool_use_id: null }, s)
    expect(d.messageId).toBe('main')
  })
})
