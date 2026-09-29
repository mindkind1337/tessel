import { describe, it, expect, vi } from 'vitest'
import { createAutomationRunner } from '../automationRunner'

const promptFile = 'C:\\Users\\me\\AppData\\Roaming\\tessel-dev\\automations\\runs\\run-abc123\\prompt.md'
const promptDir = 'C:\\Users\\me\\AppData\\Roaming\\tessel-dev\\automations\\runs\\run-abc123'

function setup(over = {}) {
  const leaves = new Set()
  const cards = {}
  const ws = { id: 'ws-1', cwd: 'C:\\code\\app' }
  const deps = {
    findWorkspace: vi.fn(() => ws),
    agentFor: vi.fn((id) => ({ id, name: 'Claude Code', command: 'claude' })),
    shellFor: () => 'powershell',
    createWorktree: vi.fn(async () => ({ worktree: { path: 'C:\\code\\app.worktrees\\nightly', branch: 'agent/nightly' } })),
    openPane: vi.fn(async () => {
      leaves.add('pane-9')
      return { id: 'pane-9' }
    }),
    createCard: vi.fn((c) => {
      cards['task-1'] = { ...c, column: 'doing' }
      return 'task-1'
    }),
    updateCard: vi.fn((id, patch) => Object.assign(cards[id], patch)),
    cardOf: (id) => cards[id] || null,
    findLeaf: (id) => (leaves.has(id) ? { id } : null),
    closePane: vi.fn((id) => leaves.delete(id)),
    report: vi.fn(async () => ({ ok: true })),
    notify: vi.fn(),
    automationById: () => null,
    ...over
  }
  return { runner: createAutomationRunner(deps), deps, leaves, cards }
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
  after: { notify: true, closePane: false },
  ...over
})
const run = { id: 'run-abc123', runNumber: 4 }

describe('automation runs in the window', () => {
  it('opens the pane the normal way, with its first prompt on the command line, and a card', async () => {
    const { runner, deps, cards } = setup()
    await runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(deps.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-1' }), 'Nightly')
    expect(deps.openPane).toHaveBeenCalledWith(
      expect.objectContaining({
        launchOptions: { model: 'opus', effort: 'high' },
        automationLaunch: { promptFile, promptDir },
        worktree: expect.objectContaining({ branch: 'agent/nightly' })
      })
    )
    expect(cards['task-1']).toMatchObject({ title: 'Nightly · run 4', brief: 'Check it', paneId: 'pane-9', automation: { id: 'auto-1', runId: run.id } })
    expect(deps.report).toHaveBeenCalledWith({ runId: run.id, status: 'dispatched', paneId: 'pane-9', wsId: 'ws-1', taskId: 'task-1', branch: 'agent/nightly' })
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

  it('fails with a reason when it cannot start', async () => {
    let s = setup({ findWorkspace: () => null })
    await s.runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(s.deps.report).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped_unavailable', errorCode: 'project-gone' }))

    s = setup({ agentFor: () => null })
    await s.runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(s.deps.report).toHaveBeenCalledWith(expect.objectContaining({ status: 'dispatch_failed', errorCode: 'agent-unavailable' }))

    s = setup()
    await s.runner.dispatch({ automation: automation(), run, promptFile: 'C:\\Users\\a$b\\p.md', promptDir: 'C:\\Users\\a$b' })
    expect(s.deps.report).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'unsafe-path' }))
    expect(s.deps.openPane).not.toHaveBeenCalled()

    s = setup({ createWorktree: async () => ({ error: 'not a git repository' }) })
    await s.runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    expect(s.deps.report).toHaveBeenCalledWith({ runId: run.id, status: 'dispatch_failed', errorCode: 'copy-failed', error: 'not a git repository' })

    s = setup({ openPane: async () => null })
    await s.runner.dispatch({ automation: automation({ isolation: 'project' }), run, promptFile, promptDir })
    expect(s.deps.report).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'pane-failed' }))
    expect(s.deps.createCard).not.toHaveBeenCalled()
  })

  it('a remote project gets its prompt inline', async () => {
    const { runner, deps } = setup()
    await runner.dispatch({ automation: automation({ isolation: 'project', remote: { hostId: 'h', path: '/srv' } }), run, promptFile: null, promptDir: null })
    expect(deps.openPane).toHaveBeenCalledWith(expect.objectContaining({ automationLaunch: { inlinePrompt: 'Check it' }, worktree: null }))
  })

  it('a pane closed before the agent finished: the run failed, the card back to To do', async () => {
    const { runner, deps, cards, leaves } = setup()
    await runner.dispatch({ automation: automation(), run, promptFile, promptDir })
    leaves.delete('pane-9')
    runner.check()
    expect(deps.report).toHaveBeenLastCalledWith({ runId: run.id, status: 'dispatch_failed', errorCode: 'pane-closed' })
    expect(cards['task-1'].column).toBe('todo')
  })

  it('an approval is said once; runs are followed again after a restart', async () => {
    const { runner, deps } = setup({ automationById: () => automation({ isolation: 'project' }) })
    runner.resume([{ id: 'run-old', automationId: 'auto-1', paneId: 'pane-2', taskId: null }])
    runner.approval('pane-2', true)
    runner.approval('pane-2', true)
    expect(deps.notify).toHaveBeenCalledTimes(1)
    expect(deps.notify.mock.calls[0][0]).toMatchObject({ kind: 'attention', paneId: 'pane-2' })
    expect(runner.turnDone('pane-2')).toBe(true)
    expect(deps.report).toHaveBeenLastCalledWith({ runId: 'run-old', status: 'completed' })
  })
})
