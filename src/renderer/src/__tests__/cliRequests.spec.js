import { describe, it, expect, vi } from 'vitest'
import { createCliRequests, insideFolder, folderName } from '../cliRequests'

function setup(over = {}) {
  const leafA = { id: 'a', name: 'Ada', paneName: 'Ada', kind: 'agent', title: 'Claude Code', agentId: 'claude' }
  const leafB = { id: 'b', num: 2, kind: 'terminal', title: 'PowerShell' }
  const wsList = [
    { id: 'w1', name: 'app', cwd: 'C:\\work\\app', tree: { type: 'split', children: [leafA, leafB] }, activeId: 'b' },
    { id: 'w2', name: 'lib', cwd: 'C:\\work\\app\\lib', tree: null, activeId: null },
    { id: 'w3', name: 'box', cwd: null, remote: { hostId: 'h', path: '/srv' }, tree: null }
  ]
  let current = wsList[0]
  const deps = {
    workspaces: () => wsList,
    currentWs: () => current,
    selectWorkspace: vi.fn((id) => (current = wsList.find((w) => w.id === id))),
    addProjects: vi.fn(async ({ projects }) => {
      wsList.push({ id: 'w9', name: projects[0].name, cwd: projects[0].cwd, tree: null })
    }),
    openInEditor: vi.fn(() => ({ id: 'ed' })),
    viewFile: vi.fn(),
    agentFor: (id) => (id === 'claude' ? { id: 'claude', name: 'Claude Code' } : null),
    agentIds: () => ['claude'],
    shellFor: (id) => (id === 'pwsh' ? 'pwsh' : null),
    openPane: vi.fn(async () => ({ id: 'n', num: 3, title: 'Claude Code' })),
    focusPane: vi.fn(),
    paneLabel: (l) => `#${l.num} ${l.title}`,
    forEachLeaf: (node, fn) => {
      if (!node) return
      if (node.type === 'split') node.children.forEach((c) => deps.forEachLeaf(c, fn))
      else fn(node)
    },
    agentState: (id) => (id === 'a' ? 'working' : null),
    addCard: vi.fn(({ title }) => ({ id: 't1', title })),
    notify: vi.fn(),
    ...over
  }
  return { deps, wsList, r: createCliRequests(deps) }
}

describe('paths', () => {
  it('insideFolder', () => {
    expect(insideFolder('C:\\Work\\App\\src', 'c:/work/app/')).toBe(true)
    expect(insideFolder('C:\\work\\apple', 'C:\\work\\app')).toBe(false)
    expect(folderName('C:\\x\\proj\\')).toBe('proj')
  })
})

describe('createCliRequests', () => {
  it('the deepest local project holds the folder', () => {
    const { r } = setup()
    expect(r.projectFor('C:\\work\\app\\lib\\src').name).toBe('lib')
    expect(r.projectFor('C:\\work\\app\\src').name).toBe('app')
    expect(r.projectFor('D:\\elsewhere')).toBeNull()
  })

  it('openProject selects a known project, or adds it', async () => {
    const { r, deps } = setup()
    expect(await r.handle({ method: 'openProject', params: { path: 'c:\\work\\app\\lib\\' } })).toEqual({ kind: 'folder', project: 'lib', created: false })
    expect(deps.addProjects).not.toHaveBeenCalled()
    expect(await r.handle({ method: 'openProject', params: { path: 'D:\\new\\thing' } })).toEqual({ kind: 'folder', project: 'thing', created: true })
    expect(deps.addProjects).toHaveBeenCalledWith({ projects: [{ cwd: 'D:\\new\\thing', name: 'thing' }], source: 'cli' })
  })

  it('openFile opens in the project’s editor, or the viewer without a project', async () => {
    const { r, deps } = setup()
    await r.handle({ method: 'openFile', params: { path: 'C:\\work\\app\\lib\\x.js', line: 4 } })
    expect(deps.selectWorkspace).toHaveBeenCalledWith('w2')
    expect(deps.openInEditor).toHaveBeenCalledWith(expect.objectContaining({ file: 'C:\\work\\app\\lib\\x.js', line: 4, ws: expect.objectContaining({ id: 'w2' }) }))
    const none = setup({ currentWs: () => null, workspaces: () => [] })
    await none.r.handle({ method: 'openFile', params: { path: 'D:\\x.txt' } })
    expect(none.deps.viewFile).toHaveBeenCalledWith({ file: 'D:\\x.txt', line: null })
  })

  it('newPane opens an ordinary agent pane with the pane’s own model choice', async () => {
    const { r, deps } = setup()
    const res = await r.handle({ method: 'newPane', params: { cwd: 'C:\\work\\app\\src', agent: 'claude', model: 'opus', effort: 'high' } })
    expect(deps.openPane).toHaveBeenCalledWith({
      ws: expect.objectContaining({ id: 'w1' }),
      agent: { id: 'claude', name: 'Claude Code' },
      shellId: null,
      sessionOptions: { model: 'opus', effort: 'high' }
    })
    expect(deps.focusPane).toHaveBeenCalledWith('n')
    expect(deps.notify).toHaveBeenCalled()
    expect(res).toEqual({ project: 'app', pane: '#3 Claude Code', id: 'n', kind: 'agent', agent: 'claude' })
  })

  it('newPane: unknown agent or shell, no project', async () => {
    const { r, deps } = setup()
    await expect(r.handle({ method: 'newPane', params: { agent: 'nope' } })).rejects.toMatchObject({ code: 'unknown_agent' })
    await expect(r.handle({ method: 'newPane', params: { shell: 'zsh' } })).rejects.toMatchObject({ code: 'unknown_shell' })
    expect(deps.openPane).not.toHaveBeenCalled()
    const none = setup({ currentWs: () => null })
    await expect(none.r.handle({ method: 'newPane', params: { cwd: 'Z:\\' } })).rejects.toMatchObject({ code: 'no_project' })
  })

  it('status lists projects, panes and agent states', async () => {
    const { r } = setup()
    const s = await r.handle({ method: 'status' })
    expect(s.projects[0]).toEqual({
      name: 'app',
      path: 'C:\\work\\app',
      active: true,
      panes: [
        { id: 'a', name: 'Ada', kind: 'agent', title: 'Claude Code', agentId: 'claude', state: 'working', active: false },
        { id: 'b', name: null, kind: 'terminal', title: 'PowerShell', active: true }
      ]
    })
    expect(s.projects[2].path).toBe('ssh:h:/srv')
  })

  it('addTask adds a card to the project’s board', async () => {
    const { r, deps } = setup()
    expect(await r.handle({ method: 'addTask', params: { title: 'Docs', note: 'n', cwd: 'C:\\work\\app\\lib' } })).toEqual({ id: 't1', title: 'Docs', project: 'lib' })
    expect(deps.addCard).toHaveBeenCalledWith({ title: 'Docs', note: 'n', ws: expect.objectContaining({ id: 'w2' }) })
  })

  it('unknown requests are refused', async () => {
    const { r } = setup()
    await expect(r.handle({ method: 'writePty', params: {} })).rejects.toMatchObject({ code: 'unknown_method' })
  })
})

describe('sessionChoiceError (model and effort from the command line)', () => {
  it('only a listed model, and an effort among its choices', async () => {
    const { sessionChoiceError } = await import('../cliRequests')
    expect(sessionChoiceError('claude', 'opus', 'high', null)).toBeNull()
    expect(sessionChoiceError('claude', 'opus', null, null)).toBeNull()
    expect(sessionChoiceError('gemini', '--yolo', null, null)).toMatch(/Unknown model/)
    expect(sessionChoiceError('claude', 'made-up', null, null)).toMatch(/Unknown model/)
    expect(sessionChoiceError('claude', 'opus', '--x', null)).toMatch(/Unknown effort/)
    expect(sessionChoiceError('claude', 'haiku', 'high', null)).toMatch(/no effort/)
    expect(sessionChoiceError('codex', 'gpt-5.5', 'ultra', null)).toMatch(/Unknown effort/)
    expect(sessionChoiceError('codex', 'gpt-5.5', 'xhigh', null)).toBeNull()
    expect(sessionChoiceError('aider', 'k2', null, null)).toMatch(/cannot choose/)
    expect(sessionChoiceError('kimi', 'k2', null, null)).toMatch(/Unknown model/)
    expect(sessionChoiceError('kimi', 'kimi-code/kimi-for-coding', null, null)).toBeNull()
    // The agent's own listed models (probed) count.
    expect(sessionChoiceError('claude', 'claude-opus-9', null, [{ id: 'claude-opus-9', options: [] }])).toBeNull()
  })

  it('newPane refuses an unlisted model before opening anything', async () => {
    const { r, deps } = setup()
    await expect(r.handle({ method: 'newPane', params: { agent: 'claude', model: '--dangerously-skip-permissions' } })).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(deps.openPane).not.toHaveBeenCalled()
  })
})
