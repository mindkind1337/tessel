import { describe, expect, it } from 'vitest'
import { prAgentTargets } from '../prAgentTargets'

const leaf = (id, extra = {}) => ({ id, label: id.toUpperCase(), ...extra })
const base = {
  cwd: 'C:\\Project',
  mainBranch: 'main',
  worktrees: [
    { path: 'C:/Project', branch: 'main', isMain: true },
    { path: 'C:/Project-wt/other', branch: 'other' }
  ],
  number: 7,
  head: 'feature',
  label: (l) => l.label,
  taskOf: () => null
}

describe('prAgentTargets', () => {
  it('lists the agents on the PR first, then the project\'s other agents with their branch as a hint', () => {
    const agents = [
      leaf('plain', { startDir: 'C:\\Project' }),
      leaf('onhead', { worktree: { path: 'C:/Project-wt/feature', branch: 'feature' } }),
      leaf('wt', { startDir: 'C:\\Project-wt\\other' }),
      leaf('task', { worktree: { path: 'C:/Project-wt/x', branch: 'x' } }),
      leaf('elsewhere', { startDir: 'D:\\Other' })
    ]
    const taskOf = (id) => (id === 'task' ? { title: '#7 Feature', worktree: {} } : null)
    const list = prAgentTargets({ ...base, agents, taskOf })
    expect(list.map((a) => a.id)).toEqual(['onhead', 'task', 'plain', 'wt'])
    expect(list.map((a) => a.match)).toEqual([true, true, false, false])
    expect(list.find((a) => a.id === 'onhead')).toMatchObject({ path: 'C:/Project-wt/feature', branch: 'feature', hint: '' })
    expect(list.find((a) => a.id === 'task')).toMatchObject({ path: 'C:/Project-wt/x', branch: 'x', hint: 'x' })
    expect(list.find((a) => a.id === 'plain')).toMatchObject({ label: 'PLAIN', path: 'C:\\Project', branch: 'main', hint: 'main' })
    expect(list.find((a) => a.id === 'wt')).toMatchObject({ path: 'C:\\Project-wt\\other', hint: 'other' })
  })

  it('treats a pane with no folder of its own as in the main folder, and a subfolder as in the repo', () => {
    const agents = [leaf('nofolder'), leaf('sub', { startDir: 'c:/project/src' })]
    const list = prAgentTargets({ ...base, agents })
    expect(list.map((a) => [a.id, a.path, a.hint])).toEqual([
      ['nofolder', 'C:\\Project', 'main'],
      ['sub', 'c:/project/src', 'main']
    ])
  })

  it('a main folder on the PR branch is a best match without a hint; an unknown branch has no hint', () => {
    const agents = [leaf('plain', { startDir: 'C:/Project' })]
    expect(prAgentTargets({ ...base, agents, mainBranch: 'feature' })[0]).toMatchObject({ match: true, hint: '' })
    expect(prAgentTargets({ ...base, agents, mainBranch: '' })[0]).toMatchObject({ match: false, hint: '' })
  })

  it('returns nothing without a valid PR number or project folder', () => {
    const agents = [leaf('plain')]
    expect(prAgentTargets({ ...base, agents, number: 0 })).toEqual([])
    expect(prAgentTargets({ ...base, agents, cwd: '' })).toEqual([])
  })
})
