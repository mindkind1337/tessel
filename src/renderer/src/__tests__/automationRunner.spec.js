import { describe, it, expect, vi } from 'vitest'
import { createAutomationRunner, probeRunAgent } from '../automationRunner'

const B = '\\'
const promptDir = ['C:', 'Users', 'me', 'AppData', 'Roaming', 'tessel-dev', 'automations', 'runs', 'run-abc123'].join(B)
const promptFile = `${promptDir}${B}prompt.md`
const SIG = 'p1:0badf00d:42'

function setup(over = {}) {
  const leaves = new Set()
  const cards = {}
  const ws = { id: 'ws-1', cwd: 'C:\\code\\app' }
  let clock = 1_000_000
  const deps = {
    now: () => clock,
    findWorkspace: vi.fn(() => ws),
    agentFor: vi.fn((id) => ({ id, name: 'Claude Code', command: 'claude' })),
    shellFor: () => 'powershell',
    permissionSig: vi.fn(() => SIG),
    openPanesOf: vi.fn(() => 0),
    copiesOf: vi.fn(() => 0),
    createWorktree: vi.fn(async () => ({ worktree: { path: 'C:\\code\\app.worktrees\\nightly', branch: 'agent/nightly' } })),
    removeCopy: vi.fn(async () => {}),
    runStatus: vi.fn(async () => 'dispatching'),
    openPane: vi.fn(async () => {
      leaves.add('pane-9')
      return { id: 'pane-9' }
    }),
    createCard: vi.fn((c) => {
      cards['task-1'] = { ...c, column: 'doing' }
      return 'task-1'
    }),
    updateCard: vi.fn((id, patch) => Object.assign(cards[id], patch)),
    removeCard: vi.fn((id) => delete cards[id]),
    cardOf: (id) => cards[id] || null,
    findLeaf: (id) => (leaves.has(id) ? { id } : null),
    closePane: vi.fn((id) => leaves.delete(id)),
    agentProbe: vi.fn(async () => ({ started: false, exited: false })),
    report: vi.fn(async (r) => ({ ok: true, run: { id: r.runId, status: r.status === 'ack' ? 'dispatching' : r.status } })),
    notify: vi.fn(),
    automationById: () => null,
    ...over
  }
  return { runner: createAutomationRunner(deps), deps, leaves, cards, tick: (ms) => (clock += ms) }
}

const automation = (over = {}) => ({
  id: 'auto-1',
  name: 'Nightly',
  prompt: 'Check it',
  agentId: 'claude',
  model: 'opus',
  effort: 'high',
  isolation: 'worktree',
  remote: null,
  confirmedSig: SIG,
  after: { notify: true, closePane: false },
  ...over
})
const run = { id: 'run-abc123', runNumber: 4 }
const statuses = (deps) => deps.report.mock.calls.map((c) => c[0].status)

describe('automation runs in the window', () => {
  it('takes the run at once, opens the pane the normal way with its first prompt on the command line, and a card', async () => {
    const { runner, deps, cards } = setup()
    await runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(deps.report.mock.calls[0][0]).toEqual({ runId: run.id, status: 'ack' })
    expect(deps.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-1' }), 'Nightly')
    expect(deps.runStatus).toHaveBeenCalledWith(run.id)
    expect(deps.openPane).toHaveBeenCalledWith(
      expect.objectContaining({
        launchOptions: { model: 'opus', effort: 'high' },
        automationLaunch: { promptFile, promptDir },
        worktree: expect.objectContaining({ branch: 'agent/nightly' })
      })
    )
    expect(cards['task-1']).toMatchObject({ title: 'Nightly · run 4', brief: 'Check it', paneId: 'pane-9', automation: { id: 'auto-1', runId: run.id } })
    expect(deps.report).toHaveBeenLastCalledWith({ runId: run.id, status: 'dispatched', paneId: 'pane-9', wsId: 'ws-1', taskId: 'task-1', branch: 'agent/nightly' })
  })

  // Review 1: the run timed out while its copy was made: no pane is opened.
  it('a run no longer wanted when its copy is ready opens no pane, and its copy is removed', async () => {
    const { runner, deps } = setup({ runStatus: vi.fn(async () => 'dispatch_failed') })
    await runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(deps.openPane).not.toHaveBeenCalled()
    expect(deps.removeCopy).toHaveBeenCalledWith(expect.objectContaining({ branch: 'agent/nightly' }))
    expect(statuses(deps)).toEqual(['ack'])
  })

  it('a pane that opened for a run already ended is closed, its card and copy removed', async () => {
    const { runner, deps, cards, leaves } = setup({
      report: vi.fn(async (r) => ({ ok: true, run: { id: r.runId, status: r.status === 'ack' ? 'dispatching' : 'dispatch_failed' } }))
    })
    await runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(leaves.has('pane-9')).toBe(false)
    expect(cards['task-1']).toBeUndefined()
    expect(deps.removeCopy).toHaveBeenCalled()
    expect(runner.runOfPane('pane-9')).toBe(null)
  })

  it('its turn ending completes the run: card to Review, you are told', async () => {
    const { runner, deps, cards } = setup()
    await runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(runner.turnDone('pane-9')).toBe(true)
    expect(deps.report).toHaveBeenLastCalledWith({ runId: run.id, status: 'completed' })
    expect(cards['task-1'].column).toBe('review')
    expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'done', title: 'Automation "Nightly" finished', paneId: 'pane-9' }))
    expect(runner.turnDone('pane-9')).toBe(false) // once
  })

  it('in the project folder: Done; closes its pane when asked; no notice when off', async () => {
    const { runner, deps, cards } = setup()
    await runner.dispatch({ automation: automation({ isolation: 'project', after: { notify: false, closePane: true } }), run, promptFile, promptDir })
    expect(deps.createWorktree).not.toHaveBeenCalled()
    runner.turnDone('pane-9')
    expect(cards['task-1'].column).toBe('done')
    expect(deps.closePane).toHaveBeenCalledWith('pane-9')
    expect(deps.notify).not.toHaveBeenCalled()
  })

  it('fails with a reason when it cannot start, and removes a copy it made', async () => {
    let s = setup({ findWorkspace: () => null })
    await s.runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(s.deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'skipped_unavailable', errorCode: 'project-gone' }))

    s = setup({ agentFor: () => null })
    await s.runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(s.deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'dispatch_failed', errorCode: 'agent-unavailable' }))

    s = setup()
    await s.runner.dispatch({ automation: automation(), run, promptFile: 'C:\\Users\\a$b\\p.md', promptDir: 'C:\\Users\\a$b' })
    expect(s.deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ errorCode: 'unsafe-path' }))
    expect(s.deps.openPane).not.toHaveBeenCalled()

    s = setup({ createWorktree: async () => ({ error: 'not a git repository' }) })
    await s.runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(s.deps.report).toHaveBeenLastCalledWith({ runId: run.id, status: 'dispatch_failed', errorCode: 'copy-failed', error: 'not a git repository' })

    s = setup({ openPane: async () => null })
    await s.runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(s.deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ errorCode: 'pane-failed' }))
    expect(s.deps.createCard).not.toHaveBeenCalled()
    expect(s.deps.removeCopy).toHaveBeenCalled()
  })

  // Review 6: Yolo turned on (or other arguments) after you confirmed it.
  it('runs only with the permissions you confirmed; told once', async () => {
    const { runner, deps } = setup({ permissionSig: vi.fn(() => 'p1:ffffffff:99') })
    await runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    await runner.dispatch({ automation: automation(), run: { ...run, id: 'run-2' }, promptFile, promptDir })
    expect(deps.openPane).not.toHaveBeenCalled()
    expect(deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'skipped_unavailable', errorCode: 'permissions-changed' }))
    expect(deps.notify).toHaveBeenCalledTimes(1)
    const old = setup()
    await old.runner.dispatch({ automation: automation({ confirmedSig: null }), run, promptFile, promptDir })
    expect(old.deps.openPane).not.toHaveBeenCalled()
  })

  // Review 7: a schedule never piles up panes and copies.
  it('waits while too many panes or copies of its previous runs are left', async () => {
    let s = setup({ openPanesOf: () => 3 })
    await s.runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(s.deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'skipped_unavailable', errorCode: 'too-many-panes' }))
    s = setup({ copiesOf: () => 3 })
    await s.runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(s.deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ errorCode: 'too-many-copies' }))
    expect(s.deps.createWorktree).not.toHaveBeenCalled()
    // In the project folder no copy is made: copies do not count.
    s = setup({ copiesOf: () => 3 })
    await s.runner.dispatch({ automation: automation({ isolation: 'project' }), run, promptFile, promptDir })
    expect(s.deps.openPane).toHaveBeenCalled()
  })

  // Review 3: a remote run's command line names only the prompt file.
  it('a remote project gets the prompt file written on its host', async () => {
    const { runner, deps } = setup()
    const remoteFile = '.tessel/automations/auto-1.md'
    await runner.dispatch({ automation: automation({ isolation: 'project', remote: { hostId: 'h', path: '/srv' } }), run, remoteFile })
    expect(deps.openPane).toHaveBeenCalledWith(expect.objectContaining({ automationLaunch: { remoteFile }, worktree: null }))
  })

  it('a pane closed before the agent finished: the run failed, the card back to To do', async () => {
    const { runner, deps, cards, leaves } = setup()
    await runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    leaves.delete('pane-9')
    await runner.check()
    expect(deps.report).toHaveBeenLastCalledWith({ runId: run.id, status: 'dispatch_failed', errorCode: 'pane-closed' })
    expect(cards['task-1'].column).toBe('todo')
  })

  // Review 2: an agent that never starts, or exits, frees the run.
  it('an agent that never shows up fails the run after 5 minutes; one that exits fails it at once', async () => {
    let s = setup()
    await s.runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    s.tick(4 * 60_000)
    await s.runner.check()
    expect(statuses(s.deps)).not.toContain('dispatch_failed')
    s.tick(2 * 60_000)
    await s.runner.check()
    expect(s.deps.report).toHaveBeenLastCalledWith({ runId: run.id, status: 'dispatch_failed', errorCode: 'agent-no-start' })
    expect(s.leaves.has('pane-9')).toBe(true) // left for you to look at

    s = setup({ agentProbe: vi.fn(async () => ({ started: true, exited: false })) })
    await s.runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    s.tick(60 * 60_000)
    await s.runner.check()
    expect(statuses(s.deps)).not.toContain('dispatch_failed') // working a long time is fine
    s.deps.agentProbe.mockResolvedValue({ started: true, exited: true })
    await s.runner.check()
    expect(s.deps.report).toHaveBeenLastCalledWith({ runId: run.id, status: 'dispatch_failed', errorCode: 'agent-exited' })
  })

  // Recheck A: a remote agent sends no hooks: never failed as "not started".
  it('when nothing can tell (a remote agent), the run is never failed for not starting', async () => {
    const s = setup({ agentProbe: vi.fn(async () => ({ started: null, exited: false })) })
    await s.runner.dispatch({ automation: automation({ isolation: 'project', remote: { hostId: 'h', path: '/srv' } }), run, remoteFile: '.tessel/automations/auto-1.md' })
    s.tick(10 * 60 * 60_000)
    await s.runner.check()
    expect(statuses(s.deps)).not.toContain('dispatch_failed')
    expect(s.runner.runOfPane('pane-9')).not.toBe(null)
  })

  it('an approval is said once; runs are followed again after a restart', async () => {
    const { runner, deps } = setup({ automationById: () => automation({ isolation: 'project' }) })
    runner.resume([{ id: 'run-old', automationId: 'auto-1', paneId: 'pane-2', taskId: null, dispatchedAt: 1 }])
    runner.approval('pane-2', true)
    runner.approval('pane-2', true)
    expect(deps.notify).toHaveBeenCalledTimes(1)
    expect(deps.notify.mock.calls[0][0]).toMatchObject({ kind: 'attention', paneId: 'pane-2' })
    expect(runner.turnDone('pane-2')).toBe(true)
    expect(deps.report).toHaveBeenLastCalledWith({ runId: 'run-old', status: 'completed' })
  })
})

describe('is the run\'s agent there?', () => {
  const now = 100_000
  const work = (w) => vi.fn(async () => w)
  it('remote and WSL panes: not from Windows (the screen decides)', async () => {
    const running = work({ running: false })
    expect(await probeRunAgent({ leaf: { remoteHostId: 'h', launchedAt: 0 }, managed: true, now, runningWork: running })).toEqual({ started: null, exited: false, screen: true })
    expect(await probeRunAgent({ leaf: { shellId: 'wsl', launchedAt: 0 }, now, runningWork: running })).toEqual({ started: null, exited: false, screen: false })
    expect(running).not.toHaveBeenCalled()
  })
  it('an agent whose hooks report: their signs; closed = exited; they tell its turn end', async () => {
    const running = work({ running: false })
    expect(await probeRunAgent({ leaf: { launchedAt: 0 }, managed: true, state: { hookSeen: true, state: 'idle' }, now, runningWork: running })).toEqual({ started: true, exited: false, screen: false })
    expect(await probeRunAgent({ leaf: { launchedAt: 0 }, managed: true, state: { hookSeen: true, state: 'closed' }, now, runningWork: running })).toEqual({ started: true, exited: true, screen: false })
    // No word from its hooks: its program decides, the screen tells its turn end.
    expect(await probeRunAgent({ leaf: { launchedAt: 0 }, managed: true, now, runningWork: work({ running: true }) })).toEqual({ started: true, exited: false, screen: true })
    // A remote host's hooks never count (a stale state from elsewhere).
    expect(await probeRunAgent({ leaf: { remoteHostId: 'h', launchedAt: 0 }, managed: true, state: { hookSeen: true, state: 'closed' }, now, runningWork: running })).toEqual({ started: null, exited: false, screen: true })
  })
  it('without hooks: the program under the shell, not the screen; nothing in the first 2 seconds', async () => {
    const running = work({ running: true })
    expect(await probeRunAgent({ leaf: { launchedAt: now - 500 }, busy: true, now, runningWork: running })).toEqual({ started: false, exited: false, screen: false })
    expect(running).not.toHaveBeenCalled()
    // Output on screen (the echoed line, a prompt) is not an agent: the shell runs nothing.
    expect(await probeRunAgent({ leaf: { launchedAt: 0 }, busy: true, now, runningWork: work({ running: false }) })).toEqual({ started: false, exited: true, screen: false })
    expect(await probeRunAgent({ leaf: { launchedAt: 0 }, now, runningWork: work({ running: true }) })).toEqual({ started: true, exited: false, screen: false })
    expect(await probeRunAgent({ leaf: { launchedAt: 0 }, now, runningWork: work({ unknown: true }) })).toEqual({ started: null, exited: false, screen: false })
  })
})

// Recheck A1/A2: a remote (or hook-less) Claude or Codex run, followed on its screen.
describe('runs followed on screen', () => {
  const remote = { isolation: 'project', remote: { hostId: 'h', path: '/srv' } }
  const start = async (over = {}, probe = { started: null, exited: false, screen: true }) => {
    const obs = { current: null }
    const s = setup({ agentProbe: vi.fn(async () => probe), screenProbe: vi.fn(() => obs.current), ...over })
    await s.runner.dispatch({ automation: automation(remote), run, remoteFile: '.tessel/automations/auto-1.md' })
    return { ...s, obs }
  }
  it('completes when its prompt is back after it worked (two checks in a row), freeing its slot', async () => {
    const s = await start()
    s.obs.current = { busy: true, ready: false }
    s.tick(10_000)
    await s.runner.check()
    s.obs.current = { busy: false, ready: true }
    s.tick(10_000)
    await s.runner.check()
    expect(statuses(s.deps)).not.toContain('completed') // once is not enough
    s.tick(10_000)
    await s.runner.check()
    expect(s.deps.report).toHaveBeenLastCalledWith({ runId: run.id, status: 'completed' })
    expect(s.runner.runOfPane('pane-9')).toBe(null)
  })
  it('a prompt back without any work seen counts only after a minute', async () => {
    const s = await start()
    s.obs.current = { busy: false, ready: true }
    for (let i = 0; i < 3; i++) {
      s.tick(10_000)
      await s.runner.check()
    }
    expect(statuses(s.deps)).not.toContain('completed')
    s.tick(40_000)
    await s.runner.check()
    expect(s.deps.report).toHaveBeenLastCalledWith({ runId: run.id, status: 'completed' })
  })
  it('an agent never seen (no work, no prompt) fails after 5 minutes', async () => {
    const s = await start()
    s.obs.current = { busy: false, ready: false } // a shell error, a password question
    s.tick(6 * 60_000)
    await s.runner.check()
    expect(s.deps.report).toHaveBeenLastCalledWith({ runId: run.id, status: 'dispatch_failed', errorCode: 'agent-no-start' })
  })
  it('a pane whose screen cannot be read is never failed for that', async () => {
    const s = await start()
    s.obs.current = null
    s.tick(6 * 60_000)
    await s.runner.check()
    expect(statuses(s.deps)).not.toContain('dispatch_failed')
  })
  it('a local agent whose hooks are not set up: its program says it started, its screen that it is done', async () => {
    const obs = { current: { busy: true, ready: false } }
    const s = setup({ agentProbe: vi.fn(async () => ({ started: true, exited: false, screen: true })), screenProbe: () => obs.current })
    await s.runner.dispatch({ automation: automation({ isolation: 'project' }), run, promptFile, promptDir })
    s.tick(10_000)
    await s.runner.check()
    obs.current = { busy: false, ready: true }
    s.tick(10_000)
    await s.runner.check()
    s.tick(10_000)
    await s.runner.check()
    expect(s.deps.report).toHaveBeenLastCalledWith({ runId: run.id, status: 'completed' })
  })
})
