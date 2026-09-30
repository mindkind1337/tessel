// @vitest-environment node
// The OpenCode normalizer and posture checks against the frames recorded from
// opencode 1.18.33 (fixtures/opencode-real-frames.jsonl: 3 turns) and the
// provider-error turn (fixtures/opencode-error-turn.jsonl). No OpenCode runs.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createOpencodeState,
  normalizeOpencodeEvent,
  permissionFromOpencode,
  opencodeReply,
  opencodeConfig,
  sessionRuleset,
  rulesFromConfig,
  lastMatch,
  wildcardMatch,
  opencodePostureProblem,
  unknownAgents,
  opencodeErrorMessage,
  isOpencodeAuthError,
  toolName,
  toolInput,
  endsWithRules,
  guardedProblem,
  taskAgents,
  opencodeConfigProblem,
  versionAtLeast
} from '../opencodeFrames'

const ROOT = 'ses_f106568edffeX593nuABwvaO1O'
const CHILD = 'ses_f10653fd7ffeMgYqwu9LT2ywkK'
const lines = readFileSync(join(__dirname, 'fixtures', 'opencode-real-frames.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const turns = [[], [], [], []]
let n = 0
for (const l of lines) {
  if (l.kind === 'turn') n = l.n
  else if (n && l.kind === 'sse') turns[n].push(l.event)
}
const AGENTS = lines.find((l) => l.kind === 'http' && l.path === '/agent').response
const errorTurn = readFileSync(join(__dirname, 'fixtures', 'opencode-error-turn.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((l) => l.event)
  .map((l) => l.event)

function run(state, events, uuid) {
  if (uuid) state.pending.push(uuid)
  const out = []
  for (const e of events) out.push(...normalizeOpencodeEvent(e, state))
  return out
}
const of = (out, type) => out.filter((e) => e.type === type)

describe('OpenCode frames: a plain turn (recorded)', () => {
  it('streams the text, keeps the reasoning whole, and ends the turn exactly once', () => {
    const state = createOpencodeState({ sessionId: ROOT })
    const out = run(state, turns[1], 'u1')
    expect(of(out, 'accepted')).toEqual([{ type: 'accepted', uuid: 'u1' }])
    expect(of(out, 'state').map((e) => e.state)).toEqual(['running', 'idle'])
    const deltas = of(out, 'textDelta')
    expect(deltas.map((d) => d.text).join('')).toBe('OK')
    const texts = of(out, 'assistant').filter((e) => e.blocks[0].type === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0].blocks[0].text).toBe('OK')
    // The deltas and the final text share the part id (one row).
    expect(texts[0].messageId).toBe(deltas[0].messageId)
    const thinking = of(out, 'assistant').filter((e) => e.blocks[0].type === 'thinking')
    expect(thinking).toHaveLength(1)
    expect(thinking[0].blocks[0].text).toMatch(/reply with exactly/)
    // The user's own text part is never an assistant row.
    expect(of(out, 'assistant').some((e) => e.blocks[0].text === 'Reply with exactly: OK')).toBe(false)
    const ends = of(out, 'turnEnd')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ status: 'completed', result: 'OK', userMessageUuids: ['u1'], isError: false })
    expect(ends[0].usage).toMatchObject({ input_tokens: 15090, output_tokens: 0, reasoning_output_tokens: 36, total_tokens: 15125 })
    expect(of(out, 'init')[0]).toMatchObject({ sessionId: ROOT })
  })

  it('context usage: each step says what the context holds, in the model window; a compaction says so', () => {
    const state = createOpencodeState({ sessionId: ROOT })
    state.contextWindow = 200000
    const out = run(state, turns[1], 'u1')
    const usage = of(out, 'contextUsage')
    expect(usage.length).toBeGreaterThan(0)
    // input + output + reasoning + cache (15090 + 0 + 36 + cache) for the recorded step.
    expect(usage.at(-1).usedTokens).toBeGreaterThanOrEqual(15126)
    expect(usage.at(-1).windowTokens).toBe(200000)
    expect(normalizeOpencodeEvent({ type: 'session.compacted', properties: { sessionID: ROOT } }, state)).toEqual([{ type: 'compacted' }])
    // Another session's compaction is not ours.
    expect(normalizeOpencodeEvent({ type: 'session.compacted', properties: { sessionID: 'ses_other' } }, state)).toEqual([])
  })

  it('the window follows the model the session runs', () => {
    const state = createOpencodeState({ sessionId: ROOT })
    state.contextWindows.set('prov/big', 400000)
    run(state, [{ type: 'message.updated', properties: { info: { id: 'msg_a', sessionID: ROOT, role: 'assistant', providerID: 'prov', modelID: 'big', time: {} } } }])
    expect(state.contextWindow).toBe(400000)
  })

  it('ignores duplicate final updates and the user message sent again', () => {
    const state = createOpencodeState({ sessionId: ROOT })
    const events = turns[1]
    const doubled = events.flatMap((e) => (e.type === 'message.updated' || e.type === 'message.part.updated' ? [e, e] : [e]))
    const out = run(state, doubled, 'u1')
    expect(of(out, 'turnEnd')).toHaveLength(1)
    expect(of(out, 'accepted')).toHaveLength(1)
    expect(of(out, 'assistant').filter((e) => e.blocks[0].type === 'text')).toHaveLength(1)
    // Its messages and parts seen again add no row and no delivery.
    const again = run(state, events)
    expect(of(again, 'accepted')).toEqual([])
    expect(of(again, 'assistant')).toEqual([])
  })
})

describe('OpenCode frames: a bash call with a permission ask (recorded)', () => {
  it('announces the tool when its input is known, reports its output, sums the steps', () => {
    const state = createOpencodeState({ sessionId: ROOT })
    const out = run(state, turns[2], 'u2')
    const uses = of(out, 'assistant').filter((e) => e.blocks[0].type === 'tool_use')
    expect(uses).toHaveLength(1)
    expect(uses[0].blocks[0]).toMatchObject({ id: 'call-586cd5ed-3dfd-43d4-b45a-ec41f9dce85a', name: 'Bash', input: { command: 'echo tessel' } })
    const results = of(out, 'toolResult')
    expect(results).toEqual([{ type: 'toolResult', toolUseId: 'call-586cd5ed-3dfd-43d4-b45a-ec41f9dce85a', isError: false, text: 'tessel\n', parentToolUseId: null }])
    const end = of(out, 'turnEnd')
    expect(end).toHaveLength(1)
    expect(end[0].result).toBe('tessel')
    // Two steps (tool-calls, then stop): their tokens summed.
    expect(end[0].usage).toMatchObject({ input_tokens: 2068 + 2152, output_tokens: 23 + 4, reasoning_output_tokens: 42 + 27, cache_read_input_tokens: 13056 * 2 })
  })

  it('turns the recorded ask into a card with its always patterns', () => {
    const ask = turns[2].find((e) => e.type === 'permission.asked').properties
    const perm = permissionFromOpencode('oc_perm_1', ask)
    expect(perm).toMatchObject({
      requestId: 'oc_perm_1',
      toolName: 'Bash',
      displayName: 'Bash',
      input: { command: 'echo tessel', patterns: ['echo tessel'] },
      sessionRules: [{ kind: 'rule', tool: 'bash', content: 'echo *' }],
      choices: ['accept', 'acceptForSession', 'decline'],
      toolUseId: 'call-586cd5ed-3dfd-43d4-b45a-ec41f9dce85a',
      always: ['echo *']
    })
    // No always patterns: "for this session" is not offered.
    expect(permissionFromOpencode('x', { ...ask, always: [] }).choices).toEqual(['accept', 'decline'])
    // Nor when they cannot all be shown whole.
    for (const always of [['echo *', ''], ['echo *', 3], Array(51).fill('a'), ['x'.repeat(301)], 'echo *', null])
      expect(permissionFromOpencode('x', { ...ask, always })).toMatchObject({ choices: ['accept', 'decline'], sessionRules: [], always: [] })
    expect(permissionFromOpencode('x', { ...ask, always: ['x'.repeat(300)] }).choices).toContain('acceptForSession')
  })

  it('maps the answers to OpenCode replies', () => {
    expect(opencodeReply({ behavior: 'allow' }, ['echo *'])).toEqual({ reply: 'once' })
    expect(opencodeReply({ behavior: 'allow', session: true }, ['echo *'])).toEqual({ reply: 'always' })
    expect(opencodeReply({ behavior: 'allow', session: true }, [])).toEqual({ reply: 'once' })
    expect(opencodeReply({ behavior: 'deny', message: 'no' })).toEqual({ reply: 'reject', message: 'no' })
    expect(opencodeReply({ behavior: 'maybe' })).toBe(null)
  })
})

describe('OpenCode frames: a task sub-agent (recorded)', () => {
  it('tracks the child session and namespaces its content', () => {
    const state = createOpencodeState({ sessionId: ROOT })
    const out = run(state, turns[3], 'u3')
    const starts = of(out, 'subagent').filter((e) => e.phase === 'start')
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ id: CHILD, status: 'working' })
    const ends = of(out, 'subagent').filter((e) => e.phase === 'end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ id: CHILD, status: 'completed', parentToolUseId: 'call-54164a95-7959-4bb5-9f12-10693ed72be1', description: 'Reply with OK', subagentType: 'general' })
    const childText = of(out, 'assistant').filter((e) => e.agentId === CHILD && e.blocks[0].type === 'text')
    expect(childText).toHaveLength(1)
    expect(childText[0]).toMatchObject({ parentToolUseId: 'call-54164a95-7959-4bb5-9f12-10693ed72be1', blocks: [{ type: 'text', text: 'OK' }] })
    expect(childText[0].messageId.startsWith(`${CHILD}:`)).toBe(true)
    expect(of(out, 'textDelta').filter((e) => e.agentId === CHILD).every((e) => e.messageId.startsWith(`${CHILD}:`))).toBe(true)
    // The parent's task call stays a regular tool row.
    const task = of(out, 'assistant').find((e) => !e.agentId && e.blocks[0].type === 'tool_use')
    expect(task.blocks[0]).toMatchObject({ name: 'Agent', input: { description: 'Reply with OK', subagent_type: 'general' } })
    // Only the parent's end ends the turn (the child's idle does not).
    const turnEnds = of(out, 'turnEnd')
    expect(turnEnds).toHaveLength(1)
    expect(turnEnds[0]).toMatchObject({ status: 'completed', result: 'OK' })
    const snapshot = of(out, 'subagents').at(-1)
    expect(snapshot.agents[0]).toMatchObject({ id: CHILD, state: 'completed', tokens: 14225 })
  })

  it('ignores the events of a session that is not ours', () => {
    const state = createOpencodeState({ sessionId: 'ses_someoneelse00000000000000' })
    const out = run(state, turns[3])
    expect(out.filter((e) => e.type !== 'init')).toEqual([])
  })
})

describe('OpenCode frames: the provider-error turn (recorded)', () => {
  const ERR = 'ses_f112fbbbaffelPpnXTdcB6LETB'
  it('reports retries, ends the turn once as failed, and never journals the response headers', () => {
    const state = createOpencodeState({ sessionId: ERR })
    const out = run(state, errorTurn, 'u9')
    expect(of(out, 'retry')).toHaveLength(5)
    const ends = of(out, 'turnEnd')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ status: 'failed', isError: true, userMessageUuids: ['u9'] })
    expect(ends[0].result).toMatch(/Upstream request failed/)
    expect(JSON.stringify(out)).not.toMatch(/cf-ray|responseHeaders|responseBody/)
    expect(of(out, 'authError')).toEqual([])
  })

  it('a new send waiting for its echo is not ended by the duplicate idle', () => {
    const state = createOpencodeState({ sessionId: ERR })
    const i = errorTurn.findIndex((e) => e.type === 'session.idle')
    run(state, errorTurn.slice(0, i + 1), 'u1')
    state.pending.push('u2') // sent right after the first idle
    const out = run(state, errorTurn.slice(i + 1))
    expect(of(out, 'turnEnd')).toEqual([])
    expect(state.pending).toEqual(['u2'])
  })

  it('an abort ends the turn as interrupted', () => {
    const state = createOpencodeState({ sessionId: ROOT })
    const start = turns[1].slice(0, 6)
    run(state, start, 'u1')
    state.interruptRequested = true
    const out = run(state, [
      { type: 'session.error', properties: { sessionID: ROOT, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } } },
      { type: 'session.status', properties: { sessionID: ROOT, status: { type: 'idle' } } },
      { type: 'session.idle', properties: { sessionID: ROOT } }
    ])
    expect(of(out, 'turnEnd')).toHaveLength(1)
    expect(of(out, 'turnEnd')[0].status).toBe('interrupted')
  })

  it('recognizes sign-in errors and keeps only the message', () => {
    expect(isOpencodeAuthError({ name: 'ProviderAuthError', data: { providerID: 'x', message: 'no key' } })).toBe(true)
    expect(isOpencodeAuthError({ name: 'APIError', data: { message: 'x', statusCode: 401 } })).toBe(true)
    expect(isOpencodeAuthError({ name: 'APIError', data: { message: 'x', statusCode: 400 } })).toBe(false)
    expect(opencodeErrorMessage({ name: 'APIError', data: { message: 'boom', responseHeaders: { a: 1 }, responseBody: 'secret' } })).toBe('boom')
  })
})

describe('OpenCode posture', () => {
  it('builds strict rules for every known agent, with the .env read asks kept', () => {
    const c = opencodeConfig({ extraAgents: ['reviewer', '-bad', 'build'] })
    expect(c.share).toBe('disabled')
    expect(c.autoupdate).toBe(false)
    expect(Object.keys(c.agent)).toEqual(['build', 'plan', 'general', 'explore', 'reviewer'])
    expect(Object.keys(c.permission)[0]).toBe('*')
    expect(c.agent.plan.permission.edit).toBe('deny')
    const rules = rulesFromConfig(c.permission)
    expect(lastMatch(rules, 'read', 'src/a.js')).toBe('allow')
    expect(lastMatch(rules, 'read', '.env')).toBe('ask')
    expect(lastMatch(rules, 'bash')).toBe('ask')
    expect(lastMatch(rules, 'some_mcp_tool')).toBe('ask')
  })

  it('session rulesets: Manual asks, Plan refuses edits, Yolo allows', () => {
    expect(lastMatch(sessionRuleset('manual'), 'edit')).toBe('ask')
    expect(lastMatch(sessionRuleset('manual'), 'task', 'general')).toBe('ask')
    expect(lastMatch(sessionRuleset('manual', ['general']), 'task', 'general')).toBe('allow')
    expect(lastMatch(sessionRuleset('manual', ['general']), 'task', 'reviewer')).toBe('ask')
    expect(sessionRuleset('manual', ['bad*name']).some((r) => r.pattern === 'bad*name')).toBe(false)
    expect(lastMatch(sessionRuleset('plan'), 'edit')).toBe('deny')
    expect(lastMatch(sessionRuleset('yolo'), 'bash')).toBe('allow')
  })

  it('wildcards match like OpenCode (whole string)', () => {
    expect(wildcardMatch('*', 'anything')).toBe(true)
    expect(wildcardMatch('git *', '*')).toBe(false)
    expect(wildcardMatch('*.env', 'a/.env')).toBe(true)
    expect(wildcardMatch('a.b', 'aXb')).toBe(false)
  })

  it('accepts the recorded agents under a Manual session, refuses a permissive one', () => {
    // The capture deliberately allowed bash for build at agent level: the
    // Manual session rules (applied after) still make it ask.
    expect(opencodePostureProblem(AGENTS, { sessionRules: sessionRuleset('manual') })).toBe(null)
    expect(opencodePostureProblem(AGENTS, { sessionRules: [] })).toMatch(/agent build: bash allow/)
    const general = AGENTS.find((a) => a.name === 'general')
    const loose = [...AGENTS.filter((a) => a.name !== 'general'), { ...general, permission: [...general.permission, { permission: 'edit', pattern: '*', action: 'allow' }] }]
    expect(opencodePostureProblem(loose, { sessionRules: sessionRuleset('manual') })).toMatch(/agent general: edit allow/)
    // ANY allow after the last catch-all fails, whatever its pattern.
    const specific = [...AGENTS.filter((a) => a.name !== 'general'), { ...general, permission: [...general.permission, { permission: 'bash', pattern: 'git *', action: 'allow' }] }]
    expect(opencodePostureProblem(specific, { sessionRules: sessionRuleset('manual') })).toMatch(/agent general: bash allow git \*/)
    // Before our catch-all, it is overridden: fine.
    const before = [...AGENTS.filter((a) => a.name !== 'general'), { ...general, permission: [{ permission: 'bash', pattern: 'git *', action: 'allow' }, ...general.permission] }]
    expect(opencodePostureProblem(before, { sessionRules: sessionRuleset('manual') })).toBe(null)
    // Hidden and primary agents are checked too; OpenCode's all-deny ones pass.
    const deny = [{ permission: '*', pattern: '*', action: 'deny' }, { permission: 'external_directory', pattern: 'C:\\tool-output\\*', action: 'allow' }]
    expect(opencodePostureProblem([...AGENTS, { name: 'title', mode: 'primary', hidden: true, permission: deny }], { sessionRules: sessionRuleset('manual') })).toBe(null)
    expect(opencodePostureProblem([...AGENTS, { name: 'helper', mode: 'primary', hidden: true, permission: [{ permission: '*', pattern: '*', action: 'allow' }] }], { sessionRules: sessionRuleset('manual') })).toMatch(/agent helper/)
    expect(opencodePostureProblem([], {})).toMatch(/no agents/)
  })

  it('a PATCH appends (opencode 1.18.33): the session holds our posture when its rules end with ours', () => {
    const manual = sessionRuleset('manual')
    const yolo = sessionRuleset('yolo')
    expect(endsWithRules(manual, manual)).toBe(true)
    expect(endsWithRules([...yolo, ...manual], manual)).toBe(true)
    expect(lastMatch([...yolo, ...manual], 'bash')).toBe('ask')
    expect(lastMatch([...sessionRuleset('plan'), ...manual], 'edit')).toBe('ask')
    expect(endsWithRules([...manual, ...yolo], manual)).toBe(false)
    expect(endsWithRules([...manual, { permission: 'bash', pattern: '*', action: 'allow' }], manual)).toBe(false)
    expect(endsWithRules(manual.slice(1), manual.slice(1))).toBe(false) // no catch-all first: not sound
    expect(endsWithRules(null, manual)).toBe(false)
  })

  it('names the agents the strict config does not cover yet', () => {
    const allow = [{ permission: '*', pattern: '*', action: 'allow' }]
    const deny = [{ permission: '*', pattern: '*', action: 'deny' }]
    expect(unknownAgents([{ name: 'build', permission: allow }, { name: 'reviewer', mode: 'subagent', permission: allow }, { name: 'helper', hidden: true, permission: allow }, { name: 'title', hidden: true, permission: deny }])).toEqual(['reviewer', 'helper'])
    expect(taskAgents([{ name: 'build', mode: 'primary' }, { name: 'general', mode: 'subagent' }, { name: 'x', mode: 'all' }, { name: 'h', mode: 'subagent', hidden: true }])).toEqual(['general', 'x'])
  })

  it('guarded permissions: the last catch-all must ask or deny, and no allow after it', () => {
    const r = (permission, pattern, action) => ({ permission, pattern, action })
    expect(guardedProblem([r('*', '*', 'ask')], 'bash')).toBe(null)
    expect(guardedProblem([r('*', '*', 'allow')], 'bash')).toBe('bash allow')
    expect(guardedProblem([r('*', '*', 'ask'), r('bash', 'rm *', 'allow')], 'bash')).toBe('bash allow rm *')
    expect(guardedProblem([r('bash', 'rm *', 'allow'), r('*', '*', 'ask')], 'bash')).toBe(null)
    expect(guardedProblem([r('*', '*', 'ask'), r('b*', 'x', 'allow')], 'bash')).toBe('bash allow x')
    expect(guardedProblem([r('bash', 'x', 'allow')], 'bash')).toBe('bash allow x') // no catch-all: default ask, the allow wins
    // OpenCode's own folders after the config: external_directory only.
    expect(guardedProblem([r('*', '*', 'ask'), r('external_directory', 'C:/o/*', 'allow')], 'external_directory')).toBe(null)
    expect(guardedProblem([r('*', '*', 'ask'), r('external_directory', '*', 'allow')], 'external_directory')).toBe('external_directory allow')
  })

  it('checks the merged config (GET /config)', () => {
    const c = opencodeConfig({ extraAgents: [] })
    expect(opencodeConfigProblem(c)).toBe(null)
    expect(opencodeConfigProblem({ ...c, share: 'auto' })).toMatch(/share/)
    const loose = JSON.parse(JSON.stringify(c))
    loose.agent.general.permission.webfetch = { '*': 'ask', 'https://*': 'allow' }
    expect(opencodeConfigProblem(loose)).toMatch(/config agent general: webfetch allow/)
    // A user's map merged key by key: ours replaces the value in place.
    expect(opencodeConfigProblem({ permission: { '*': 'ask', bash: 'allow' } })).toMatch(/config permission: bash allow/)
  })

  it('versions: at least the tested one', () => {
    expect(versionAtLeast('1.18.33')).toBe(true)
    expect(versionAtLeast('1.19.0')).toBe(true)
    expect(versionAtLeast('2.0.0-beta')).toBe(true)
    expect(versionAtLeast('1.18.32')).toBe(false)
    expect(versionAtLeast('0.9.99')).toBe(false)
    expect(versionAtLeast(null)).toBe(false)
    expect(versionAtLeast('dev')).toBe(false)
  })
})

describe('OpenCode tool names', () => {
  it('maps tools and camelCase paths', () => {
    expect(toolName('bash')).toBe('Bash')
    expect(toolName('write')).toBe('Write')
    expect(toolName('mcp_thing')).toBe('tool:mcp_thing')
    expect(toolInput('edit', { filePath: 'C:/a.js', oldString: 'a', newString: 'b' })).toMatchObject({ file_path: 'C:/a.js', oldString: 'a' })
  })
})
