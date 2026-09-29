import { describe, it, expect } from 'vitest'
import {
  parseWorkerRequest,
  decideWorkerStart,
  workersToStart,
  coordinatorPhase,
  workerLaunchArgs,
  workerPreamble,
  outputTail,
  resolveMaxConcurrent,
  resolveMaxDepth,
  depthExceededMessage,
  WORKER_START_PROMPT,
  WAKE_LAUNCH_PROMPT,
  wakeLaunchArgs,
  START_RATE,
  TOTAL_WORKERS_LIMIT
} from '../orchestration'

describe('orchestration requests', () => {
  it('worker-start: agent, title, brief, isolation, model/effort, after', () => {
    expect(
      parseWorkerRequest({ action: 'worker-start', rid: 'r-abc-123456', agent: 'Codex', title: ' Fix  the cart ', brief: 'Do it. Run npm test.', model: 'gpt-5.5', effort: 'high', deps: ['task-1-1', 'task-1-1'] })
    ).toEqual({
      action: 'worker-start',
      rid: 'r-abc-123456',
      agent: 'codex',
      title: 'Fix the cart',
      brief: 'Do it. Run npm test.',
      isolation: 'worktree',
      model: 'gpt-5.5',
      effort: 'high',
      deps: ['task-1-1']
    })
    expect(parseWorkerRequest({ action: 'worker-start', agent: 'cline', title: 'x', brief: 'y' }).error).toMatch(/agent/)
    expect(parseWorkerRequest({ action: 'worker-start', agent: 'claude', title: '', brief: 'y' }).error).toMatch(/title/)
    expect(parseWorkerRequest({ action: 'worker-start', agent: 'claude', title: 'x', brief: '' }).error).toMatch(/brief/)
    expect(parseWorkerRequest({ action: 'worker-start', agent: 'claude', title: 'x', brief: 'y', isolation: 'vm' }).error).toMatch(/isolation/)
    expect(parseWorkerRequest({ action: 'worker-start', agent: 'claude', title: 'x', brief: 'y', model: 'a b; rm -rf' }).error).toMatch(/model/)
    expect(parseWorkerRequest({ action: 'worker-start', agent: 'claude', title: 'x', brief: 'y', deps: ['../x'] }).error).toMatch(/after/)
    // A bad request id is dropped, never used as a file name.
    expect(parseWorkerRequest({ action: 'worker-start', rid: '../x', agent: 'claude', title: 'x', brief: 'y' }).rid).toBeUndefined()
  })

  it('stop / release / read / done / heartbeat', () => {
    expect(parseWorkerRequest({ action: 'worker-stop', worker: '5', reason: 'enough' })).toEqual({ action: 'worker-stop', worker: '#5', reason: 'enough' })
    expect(parseWorkerRequest({ action: 'worker-stop', worker: 'ALL' }).worker).toBe('all')
    expect(parseWorkerRequest({ action: 'worker-release', worker: 'all' }).error).toMatch(/worker/)
    expect(parseWorkerRequest({ action: 'worker-read', worker: '#5', lines: 999 }).lines).toBe(200)
    expect(parseWorkerRequest({ action: 'worker-read', worker: '#5' }).lines).toBe(60)
    expect(parseWorkerRequest({ action: 'worker-done', summary: 'Did it.', files: ['a.js', 5] })).toEqual({ action: 'worker-done', outcome: 'succeeded', summary: 'Did it.', files: ['a.js'] })
    expect(parseWorkerRequest({ action: 'worker-done', outcome: 'maybe', summary: 'x' }).error).toMatch(/outcome/)
    expect(parseWorkerRequest({ action: 'worker-done', summary: '' }).error).toMatch(/summary/)
    expect(parseWorkerRequest({ action: 'heartbeat', phase: 'implementing' })).toEqual({ action: 'heartbeat', phase: 'implementing', note: '' })
    expect(parseWorkerRequest({ action: 'heartbeat', phase: 'sleeping' }).error).toMatch(/phase/)
    expect(parseWorkerRequest({ action: 'move', id: 'x', column: 'done' })).toBeNull()
  })
})

describe('limits', () => {
  it('settings fall back to the defaults, never to "no limit"', () => {
    expect(resolveMaxConcurrent(undefined)).toBe(4)
    expect(resolveMaxConcurrent(0)).toBe(4)
    expect(resolveMaxConcurrent(99)).toBe(8)
    expect(resolveMaxConcurrent(2)).toBe(2)
    expect(resolveMaxDepth('3')).toBe(1)
    expect(resolveMaxDepth(2)).toBe(2)
    expect(resolveMaxDepth(50)).toBe(3)
  })

  it('who may start workers: the lead (depth 0), a worker below the depth limit', () => {
    const base = { maxDepth: 1, running: 0, total: 0, maxConcurrent: 4 }
    expect(decideWorkerStart({ ...base, depth: null }).error).toMatch(/Only the team lead/)
    expect(decideWorkerStart({ ...base, depth: 0 })).toEqual({ ok: true, queue: false, depth: 1 })
    expect(decideWorkerStart({ ...base, depth: 1 }).error).toBe(depthExceededMessage(2, 1))
    expect(decideWorkerStart({ ...base, depth: 1, maxDepth: 2 })).toMatchObject({ ok: true, depth: 2 })
    expect(depthExceededMessage(2, 1)).toMatch(/Complete this task yourself/)
  })

  it('concurrency queues; a burst of starts is refused', () => {
    const base = { depth: 0, maxDepth: 1, total: 0, maxConcurrent: 2 }
    expect(decideWorkerStart({ ...base, running: 2 })).toMatchObject({ ok: true, queue: true })
    expect(decideWorkerStart({ ...base, running: 0, total: TOTAL_WORKERS_LIMIT })).toMatchObject({ ok: true, queue: true })
    const now = 10_000_000
    const recent = Array.from({ length: START_RATE.max }, (_, i) => now - i * 1000)
    expect(decideWorkerStart({ ...base, running: 0, recent, now }).error).toMatch(/Too many workers/)
    expect(decideWorkerStart({ ...base, running: 0, recent: recent.map((x) => x - START_RATE.perMs), now })).toMatchObject({ ok: true })
  })

  it('the queue: order kept, per coordinator, after their cards', () => {
    const recs = [
      { id: 'a', by: 'L', status: 'running' },
      { id: 'b', by: 'L', status: 'queued' },
      { id: 'c', by: 'L', status: 'queued', deps: ['t1'] },
      { id: 'd', by: 'L', status: 'queued' },
      { id: 'e', by: 'M', status: 'queued' }
    ]
    const done = new Set()
    expect(workersToStart(recs, { maxConcurrent: 2, isDone: (x) => done.has(x) }).map((r) => r.id)).toEqual(['b', 'e'])
    done.add('t1')
    expect(workersToStart(recs, { maxConcurrent: 3, isDone: (x) => done.has(x) }).map((r) => r.id)).toEqual(['b', 'c', 'e'])
    expect(workersToStart(recs, { maxConcurrent: 4, total: TOTAL_WORKERS_LIMIT - 1 }).map((r) => r.id)).toEqual(['b'])
  })

  it("the coordinator's phase, like Orca's", () => {
    expect(coordinatorPhase([])).toBe('decomposing')
    expect(coordinatorPhase([{ status: 'confirming' }, { status: 'running' }])).toBe('dispatching')
    expect(coordinatorPhase([{ status: 'running' }, { status: 'done' }])).toBe('monitoring')
    const col = { t1: 'review', t2: 'done' }
    expect(coordinatorPhase([{ status: 'done', taskId: 't1' }, { status: 'done', taskId: 't2' }], (c) => col[c])).toBe('merging')
    expect(coordinatorPhase([{ status: 'done', taskId: 't2' }, { status: 'refused' }], (c) => col[c])).toBe('done')
  })
})

describe('launch', () => {
  it('a relaunched Codex with team messages waiting gets a first prompt about them; none when nothing waits', () => {
    expect(wakeLaunchArgs('codex', 2)).toBe(` "${WAKE_LAUNCH_PROMPT}"`)
    expect(wakeLaunchArgs('codex', 0)).toBe('')
    expect(wakeLaunchArgs('codex', undefined)).toBe('')
    // Plain words only: safe between double quotes in every shell.
    expect(WAKE_LAUNCH_PROMPT).toMatch(/^[A-Za-z0-9 .,:_-]{1,300}$/)
    // Claude Code has its own inbox; the others are not known to take one when resumed.
    for (const id of ['claude', 'gemini', 'qwen', 'opencode', 'cline', 'copilot', 'kimi']) expect(wakeLaunchArgs(id, 3)).toBe('')
  })

  it('the first prompt goes on the command line, nothing is typed later', () => {
    const o = { initialPrompt: WORKER_START_PROMPT }
    expect(workerLaunchArgs('claude', o)).toBe(` "${WORKER_START_PROMPT}"`)
    expect(workerLaunchArgs('codex', o)).toBe(` "${WORKER_START_PROMPT}"`)
    expect(workerLaunchArgs('gemini', o)).toBe(` -i "${WORKER_START_PROMPT}"`)
    expect(workerLaunchArgs('qwen', o)).toBe(` -i "${WORKER_START_PROMPT}"`)
    expect(workerLaunchArgs('cline', o)).toBe('')
    // Anything a shell could read differently is refused, never quoted.
    expect(workerLaunchArgs('claude', { initialPrompt: 'hi "there" $(x)' })).toBe('')
    expect(workerLaunchArgs('claude', null)).toBe('')
  })

  it("model and effort become the agent's own flags (its model catalog), before the first prompt", () => {
    expect(workerLaunchArgs('claude', { model: 'opus', effort: 'high' })).toBe(' --model opus --effort high')
    expect(workerLaunchArgs('codex', { model: 'gpt-5.5', effort: 'xhigh', initialPrompt: WORKER_START_PROMPT })).toBe(
      ` -m gpt-5.5 -c model_reasoning_effort=xhigh "${WORKER_START_PROMPT}"`
    )
    expect(workerLaunchArgs('claude', { model: 'sonnet' })).toBe(' --model sonnet')
    // The user's own --model (Settings > Agents) wins; an own --effort drops only that flag.
    expect(workerLaunchArgs('claude', { model: 'opus', effort: 'high' }, { ownArgs: '--model haiku' })).toBe('')
    expect(workerLaunchArgs('claude', { model: 'opus', effort: 'high' }, { ownArgs: '--effort low' })).toBe(' --model opus')
    // No catalog, an effort alone, or an id a shell could misread: nothing.
    expect(workerLaunchArgs('aider', { model: 'gpt-4o' })).toBe('')
    expect(workerLaunchArgs('claude', { effort: 'high' })).toBe('')
    expect(workerLaunchArgs('claude', { model: 'opus && calc' })).toBe('')
  })

  it("Orca's preamble, adapted: handles, card, dispatch id, how to report", () => {
    const text = workerPreamble({
      workerHandle: '#5 Codex CLI',
      coordinatorHandle: '#2 Claude Code',
      taskId: 'task-9-9',
      dispatchId: 'w-1-abc',
      title: 'Fix the cart',
      brief: 'Make the cart total right. Run npm test.',
      teamName: 'Team 1',
      where: { path: 'C:\\repo.worktrees\\fix-the-cart', branch: 'agent/fix-the-cart', baseBranch: 'main' },
      projectDir: 'C:\\repo',
      canDispatch: false
    })
    expect(text).toMatch(/You are #5 Codex CLI\. Your coordinator is #2 Claude Code, in team "Team 1"\./)
    expect(text).toMatch(/Your task card is task-9-9\. Your dispatch id is w-1-abc\./)
    expect(text).toMatch(/team_worker_done .*exactly once/)
    expect(text).toMatch(/team_heartbeat .*every 5 minutes/)
    expect(text).toMatch(/team_ask \{"to":"#2"/)
    expect(text).toMatch(/team_task_gate \{"id":"task-9-9"/)
    expect(text).toMatch(/git branch agent\/fix-the-cart/)
    expect(text).toMatch(/return to an idle prompt/)
    expect(text).toMatch(/=== TASK: Fix the cart ===\nMake the cart total right\./)
    expect(text).not.toMatch(/SUB-WORKERS/)
    expect(workerPreamble({ workerHandle: '#5', coordinatorHandle: '#2', taskId: 't', dispatchId: 'w', title: 'x', brief: 'y', where: null, projectDir: 'C:\\repo', canDispatch: true })).toMatch(
      /SUB-WORKERS[\s\S]*team_worker_start/
    )
  })

  it("a worker's output: last lines, no control codes", () => {
    expect(outputTail('\x1b[31mred\x1b[0m\none\ntwo  \n\n\n', 2)).toBe('one\ntwo')
    expect(outputTail('a\nb\nc', 60)).toBe('a\nb\nc')
  })
})
