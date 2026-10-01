// Claude Code 2.1.286 in a Tessel pane, from a real run: a 200 s Bash loop
// was shown idle ("interrupted", from the screen) while the terminal kept
// counting. Its working line no longer says "esc to interrupt", its empty
// input counted as ready, and an "Interrupted" line from an earlier Deny was
// still in view.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  agentStatus,
  agentStates,
  applyAgentStates,
  clearAgentStatus,
  createAgentActivityMonitor,
  agentScreenObservation,
  agentTookMessage,
  getAgentState,
  setAgentStatus,
  setApproval,
  setLimit
} from '../agentStatus'
import { createAgentState, publicAgentState, reduceAgentState } from '../../../shared/agentStateModel'

const RULE_ROW = '─'.repeat(50)
const STATUS = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'

// rows on a real terminal, the cursor in Claude's input (the row starting ">").
async function observe(rows) {
  const term = new Terminal({ cols: 70, rows: rows.length + 2, allowProposedApi: true })
  const at = rows.lastIndexOf('> ')
  await new Promise((resolve) => term.write(`${rows.join('\r\n')}\x1b[${at + 1};3H`, resolve))
  const buffer = term.buffer.active
  const text = []
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(y).translateToString(true)
    if (line.trim()) text.push(line)
  }
  return agentScreenObservation(term, 'claude', text.slice(-12).join('\n'))
}
const box = (...above) => [...above, '', RULE_ROW, '> ', RULE_ROW, '', STATUS]

describe("Claude Code's current working line", () => {
  it('the bug: a running Bash under an old "Interrupted" line is busy, not ready nor interrupted', async () => {
    const observed = await observe(
      box(
        '  ⎿  Interrupted · What should Claude do instead?',
        '',
        '> run the counting loop',
        '',
        '● Bash(for i in $(seq 200); do echo $i; sleep 1; done)',
        '  ⎿  Running…',
        '',
        '✻ Gusting… (23s · ↓ 1.2k tokens)'
      )
    )
    expect(observed).toMatchObject({ busy: true, running: true, ready: false, waiting: false, interrupted: false })
  })

  it.each([
    ['✻ Gusting…'],
    ['✶ Gusting… (23s · ↓ 1.2k tokens)'],
    ['* Pondering… (2m 5s · ↑ 340 tokens · thinking)'],
    ['✢ Compacting conversation… (1m 3s)'],
    ['· Gusting… (12s · esc to interrupt)'],
    ['✽ Gusting… (4s · thought for 2s)'],
    ['✳ Gusting… (23s ·']
  ])('recognises %s as working', async (line) => {
    expect(await observe(box('● Sure.', '', line))).toMatchObject({ busy: true, ready: false })
  })

  it('the spinner over a todo list is still seen', async () => {
    const observed = await observe(
      box('✻ Gusting… (40s · ↓ 3k tokens)', '  ⎿  ☒ Read the file', '     ☐ Fix the loop', '     ☐ Run the tests', '     ☐ Commit', '     ☐ Report')
    )
    expect(observed).toMatchObject({ busy: true, ready: false })
  })

  it.each([['✻ Worked for 23s'], ['✻ Churned for 1m 2s'], ['> Do it…'], ['● Loading the page…'], ['Done.']])(
    'a finished turn or plain text (%s) is not working',
    async (line) => {
      expect(await observe(box(line))).toMatchObject({ busy: false, ready: true })
    }
  )

  it('an "Interrupted" line counts only when nothing came after it', async () => {
    expect(
      await observe(box('> fix it', '  ⎿  Interrupted · What should Claude do instead?'))
    ).toMatchObject({ ready: true, interrupted: true })
    // A later prompt answered since: that old line says nothing now.
    expect(
      await observe(box('  ⎿  Interrupted · What should Claude do instead?', '', '> next one', '', '● Done.'))
    ).toMatchObject({ ready: true, interrupted: false })
  })

  it('tells what its input holds, whatever the agent does (delivery evidence)', async () => {
    expect((await observe(box('✻ Gusting… (3s)'))).input).toBe('empty')
    const term = new Terminal({ cols: 60, rows: 8, allowProposedApi: true })
    await new Promise((r) => term.write(`● Done.\r\n\r\n${RULE_ROW}\r\n> [Pasted text #1 +3 lines]\r\n${RULE_ROW}`, r))
    await new Promise((r) => term.write('\x1b[4;28H', r))
    expect(agentScreenObservation(term, 'claude', '').input).toBe('draft')
    expect(agentScreenObservation(null, 'claude', '').input).toBe(null)
  })
})

describe('hooks win over a stale screen while their turn is open', () => {
  let monitor, node, state, screen, sequence
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(100000)
    for (const id of Object.keys(agentStates)) clearAgentStatus(id)
    node = { id: 'pane-b', agentId: 'claude', agentLaunchToken: 'launch-b' }
    state = createAgentState({ paneId: node.id, provider: 'claude', launchToken: 'launch-b', startedAt: Date.now() })
    sequence = 0
    screen = { screen: '', ready: false, busy: false, approval: false, limit: null }
    monitor = createAgentActivityMonitor({
      getNode: () => node,
      readScreen: () => screen,
      report: (event) => apply('screen', event.event),
      onStatus: (value) => setAgentStatus(node.id, value, node.agentLaunchToken),
      onWorking: () => {},
      onCompleted: () => {},
      onApproval: (value) => setApproval(node.id, value),
      onLimit: (value) => setLimit(node.id, value)
    })
    publish()
  })
  afterEach(() => {
    monitor.dispose()
    for (const id of Object.keys(agentStatus)) clearAgentStatus(id)
    vi.useRealTimers()
  })
  function publish() {
    applyAgentStates({ [node.id]: publicAgentState(state, Date.now()) })
    monitor.stateChanged(getAgentState(node.id, node.agentLaunchToken))
  }
  function apply(source, event, extra = {}) {
    state = reduceAgentState(
      state,
      { v: 1, id: `e-${++sequence}`, paneId: node.id, provider: 'claude', launchToken: 'launch-b', sessionId: 's-1', source, event, at: Date.now(), ...extra },
      Date.now()
    )
    publish()
  }
  async function look(next) {
    screen = { screen: '', busy: false, approval: false, limit: null, ...next }
    monitor.output()
    await vi.advanceTimersByTimeAsync(1400)
  }
  const OLD = '> fix it\n⎿  Interrupted · What should Claude do instead?'

  it("a message's Enter: its hooks tell whether it was taken (agentTookMessage)", async () => {
    apply('hook', 'SessionStart')
    await look({ ready: true, waiting: true })
    const enter = Date.now() + 10
    vi.advanceTimersByTime(20)
    expect(agentTookMessage(node.id, 'launch-b', enter)).toBe(false)
    // A fast turn: opened, then ended and its prompt back, in about a second.
    apply('hook', 'UserPromptSubmit')
    expect(agentTookMessage(node.id, 'launch-b', enter)).toBe(true)
    apply('hook', 'Stop')
    await look({ ready: true, waiting: true })
    expect(agentStates[node.id]).toMatchObject({ state: 'idle' })
    expect(agentTookMessage(node.id, 'launch-b', enter)).toBe(true)
    expect(agentTookMessage(node.id, 'other-launch', enter)).toBe(false)
    // Its next message, answered by a question at once.
    const next = Date.now() + 10
    vi.advanceTimersByTime(20)
    expect(agentTookMessage(node.id, 'launch-b', next)).toBe(false)
    apply('hook', 'UserPromptSubmit')
    apply('hook', 'PreToolUse', { toolId: 'q-1', toolName: 'AskUserQuestion' })
    expect(agentStates[node.id]).toMatchObject({ state: 'approval' })
    expect(agentTookMessage(node.id, 'launch-b', next)).toBe(true)
  })

  it('an interruption seen before the new turn does not end it; a new one does', async () => {
    apply('hook', 'UserPromptSubmit')
    apply('hook', 'PreToolUse', { toolId: 't-1' })
    await look({ ready: true, waiting: true, interrupted: true, interruption: OLD })
    expect(agentStates[node.id]).toMatchObject({ state: 'idle', reason: 'interrupted' })
    await vi.advanceTimersByTimeAsync(1000)
    // The next prompt: its hooks say it runs; the screen still shows the old line.
    apply('hook', 'UserPromptSubmit')
    apply('hook', 'PreToolUse', { toolId: 't-2' })
    await look({ ready: true, waiting: true, interrupted: true, interruption: OLD })
    await vi.advanceTimersByTimeAsync(5000)
    await look({ ready: true, waiting: true, interrupted: true, interruption: OLD })
    expect(agentStates[node.id]).toMatchObject({ state: 'working' })
    expect(agentStatus[node.id]).toBe('busy')
    // Esc on this turn: a new "Interrupted" line, right above the input.
    await look({ ready: true, waiting: true, interrupted: true, interruption: '● Bash(loop)\n⎿  Interrupted · What should Claude do instead?' })
    expect(agentStates[node.id]).toMatchObject({ state: 'idle', reason: 'interrupted' })
  })
})
