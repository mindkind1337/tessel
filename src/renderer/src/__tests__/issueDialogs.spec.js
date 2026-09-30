import { setSelectValue, selectOptions } from './selectTestUtils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import GitHubDialog from '../components/GitHubDialog.vue'
import LinearDialog from '../components/LinearDialog.vue'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const ghItem = (number = 1, kind = 'issues') => ({
  kind,
  number,
  title: `Item ${number}`,
  url: `https://github.com/example/project/${kind === 'prs' ? 'pull' : 'issues'}/${number}`,
  state: 'OPEN',
  author: { login: 'person' },
  labels: [{ name: 'bug' }],
  body: 'Plain issue description',
  comments: [],
  files: [],
  checks: []
})
const linearItem = (id = 'one') => ({
  id,
  identifier: `APP-${id}`,
  title: `Linear ${id}`,
  url: `https://linear.app/example/issue/${id}`,
  description: 'Plain Linear description',
  team: { id: 'team-1', name: 'Product' },
  state: { id: 'todo', name: 'Todo' },
  assignee: { name: 'Person' }
})
let wrapper, previousApi
beforeEach(() => {
  previousApi = window.shellApi
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  window.shellApi = previousApi
})
const props = { cwd: 'C:/Project', agents: [{ id: 'codex', name: 'Codex' }], defaultAgent: 'codex' }
const button = (text) => wrapper.findAll('button').find((entry) => entry.text() === text)

describe('GitHub issue and pull request dialog', () => {
  let api
  beforeEach(() => {
    api = {
      status: vi.fn(async () => ({
        ok: true,
        available: true,
        authenticated: true,
        repo: { nameWithOwner: 'example/project', defaultBranch: 'main' }
      })),
      list: vi.fn(async ({ kind }) => ({ ok: true, items: [ghItem(1, kind), ghItem(2, kind)] })),
      detail: vi.fn(async ({ number, kind }) => ({ ok: true, item: ghItem(number, kind) })),
      checks: vi.fn(async () => ({ ok: true, checks: [] })),
      action: vi.fn(async () => ({ ok: true })),
      createIssue: vi.fn(async () => ({ ok: true, url: ghItem().url })),
      createPr: vi.fn(async () => ({ ok: true, url: ghItem(3, 'prs').url }))
    }
    window.shellApi = {
      github: api,
      writeClipboard: vi.fn(),
      openExternal: vi.fn(async () => ({ ok: true }))
    }
  })
  async function render(extra = {}) {
    wrapper = mount(GitHubDialog, { props: { ...props, ...extra } })
    await flushPromises()
  }
  async function openItem(index = 0) {
    await wrapper.findAll('[data-test="github-item"]')[index].trigger('click')
    await flushPromises()
  }

  it('loads read-only lists without triggering any mutation or task start', async () => {
    const startIssue = vi.fn()
    await render({ startIssue })
    expect(api.status).toHaveBeenCalledWith({ cwd: 'C:/Project' })
    expect(wrapper.findAll('[data-test="github-item"]')).toHaveLength(2)
    expect(api.action).not.toHaveBeenCalled()
    expect(api.createIssue).not.toHaveBeenCalled()
    expect(api.createPr).not.toHaveBeenCalled()
    expect(startIssue).not.toHaveBeenCalled()
    expect(wrapper.get('[role="dialog"]').attributes('aria-modal')).toBe('true')
  })

  it('retains the latest filter response when requests complete out of order', async () => {
    await render()
    const older = deferred(),
      newer = deferred()
    api.list.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    await setSelectValue(wrapper.get('[aria-label="GitHub issue filter"]'), 'mine')
    await setSelectValue(wrapper.get('[aria-label="GitHub issue filter"]'), 'all')
    newer.resolve({ ok: true, items: [ghItem(22)] })
    await flushPromises()
    older.resolve({ ok: true, items: [ghItem(11)] })
    await flushPromises()
    expect(wrapper.text()).toContain('Item 22')
    expect(wrapper.text()).not.toContain('Item 11')
  })

  it('ignores a stale detail response after navigating to a different issue', async () => {
    await render()
    const old = deferred()
    api.detail.mockReturnValueOnce(old.promise)
    await wrapper.findAll('[data-test="github-item"]')[0].trigger('click')
    await button('← Issues').trigger('click')
    await openItem(1)
    old.resolve({ ok: true, item: ghItem(1) })
    await flushPromises()
    expect(wrapper.get('.issue-item-title').text()).toContain('Item 2')
  })

  it('does not restore the previous project after a late status response', async () => {
    const previous = deferred()
    api.status.mockReturnValueOnce(previous.promise).mockResolvedValue({
      ok: true,
      available: true,
      authenticated: true,
      repo: { nameWithOwner: 'example/new-project', defaultBranch: 'main' }
    })
    wrapper = mount(GitHubDialog, { props })
    await wrapper.setProps({ cwd: 'C:/NewProject' })
    await flushPromises()
    previous.resolve({
      ok: true,
      available: true,
      authenticated: true,
      repo: { nameWithOwner: 'example/old-project', defaultBranch: 'main' }
    })
    await flushPromises()
    expect(wrapper.get('.issue-dialog-head').text()).toContain('example/new-project')
    expect(wrapper.get('.issue-dialog-head').text()).not.toContain('example/old-project')
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: 'C:/NewProject' }))
  })

  it('keeps the newer list loading when the original connection load finishes first', async () => {
    const older = deferred(),
      newer = deferred()
    api.list.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    wrapper = mount(GitHubDialog, { props })
    await flushPromises()
    await setSelectValue(wrapper.get('[aria-label="GitHub issue filter"]'), 'mine')
    older.resolve({ ok: true, items: [ghItem(1)] })
    await flushPromises()
    expect(wrapper.text()).toContain('Reading issues')
    newer.resolve({ ok: true, items: [ghItem(2)] })
    await flushPromises()
    expect(wrapper.text()).not.toContain('Reading issues')
    expect(wrapper.text()).toContain('Item 2')
  })

  it('renders remote text safely and copies a complete issue', async () => {
    api.detail.mockResolvedValue({
      ok: true,
      item: {
        ...ghItem(),
        body: '<img src=x onerror=alert(1)>',
        comments: [{ author: { login: 'reviewer' }, body: '<script>bad()</script>' }]
      }
    })
    await render()
    await openItem()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>')
    await button('Copy issue').trigger('click')
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith(
      expect.stringContaining(ghItem().url)
    )
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith(
      expect.stringContaining('<img src=x onerror=alert(1)>')
    )
  })

  it('requires an explicit confirmation before closing an issue', async () => {
    await render()
    await openItem()
    await button('Close issue').trigger('click')
    expect(api.action).not.toHaveBeenCalled()
    await wrapper.get('[data-test="github-confirm-action"]').trigger('click')
    await flushPromises()
    expect(api.action).toHaveBeenCalledWith({
      cwd: 'C:/Project',
      kind: 'issues',
      number: 1,
      action: 'close'
    })
  })

  it('submits comments only when Post comment is clicked', async () => {
    await render()
    await openItem()
    await wrapper.get('textarea').setValue('Please handle the edge case.')
    expect(api.action).not.toHaveBeenCalled()
    await wrapper.get('[data-test="github-comment"]').trigger('click')
    await flushPromises()
    expect(api.action).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'comment', body: 'Please handle the edge case.' })
    )
  })

  it('supports PR files/checks and confirms auto-merge can happen immediately', async () => {
    api.detail.mockImplementation(async ({ number }) => ({
      ok: true,
      item: {
        ...ghItem(number, 'prs'),
        files: [{ path: 'src/file.js', additions: 4, deletions: 2 }],
        checks: [
          {
            name: 'Build',
            state: 'FAILURE',
            url: 'https://github.com/example/project/actions/runs/1'
          }
        ]
      }
    }))
    await render()
    await wrapper.get('[data-test="github-prs"]').trigger('click')
    await flushPromises()
    await openItem()
    await button('Files (1)').trigger('click')
    expect(wrapper.text()).toContain('src/file.js')
    await button('Checks (1)').trigger('click')
    expect(wrapper.text()).toContain('FAILURE')
    await button('Rerun failed').trigger('click')
    expect(api.action).not.toHaveBeenCalled()
    await button('Cancel').trigger('click')
    await button('Enable auto-merge').trigger('click')
    expect(wrapper.get('.issue-confirm').text()).toContain('merge immediately')
    await wrapper.get('[data-test="github-confirm-action"]').trigger('click')
    await flushPromises()
    expect(api.action).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'prs', action: 'autoMerge', method: 'squash' })
    )
  })

  it('opens task-copy PR composition directly and creates a draft without pushing', async () => {
    await render({ initialMode: 'createPr', prCwd: 'C:/Copies/task-one', prBase: 'develop' })
    expect(wrapper.text()).toContain('C:/Copies/task-one')
    expect(wrapper.text()).toContain('Push this branch')
    expect(api.createPr).not.toHaveBeenCalled()
    await wrapper.get('[data-test="github-title"]').setValue('Fix issue 1')
    await wrapper.get('[data-test="github-body"]').setValue('Details')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(api.createPr).toHaveBeenCalledWith({
      cwd: 'C:/Copies/task-one',
      title: 'Fix issue 1',
      body: 'Details',
      base: 'develop',
      draft: true
    })
  })

  it('keeps the issue open and shows a start error until the parent confirms success', async () => {
    const first = deferred(),
      startIssue = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ ok: true })
    await render({ startIssue })
    await openItem()
    await wrapper.get('[data-test="github-start"]').trigger('click')
    expect(wrapper.get('[data-test="github-start"]').element.disabled).toBe(true)
    expect(wrapper.emitted('busy')).toEqual([[true]])
    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toBeUndefined()
    first.resolve({ ok: false, error: 'No Git worktree could be prepared.' })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('No Git worktree')
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.get('[data-test="github-start"]').trigger('click')
    await flushPromises()
    expect(startIssue).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'github', agentId: 'codex', worktree: true })
    )
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('forces an isolated Git copy when starting from a pull request', async () => {
    const startIssue = vi.fn(async () => ({ ok: true }))
    await render({ startIssue })
    await wrapper.get('[data-test="github-prs"]').trigger('click')
    await flushPromises()
    await openItem()
    expect(wrapper.get('.issue-start input[type="checkbox"]').element.disabled).toBe(true)
    await wrapper.get('[data-test="github-start"]').trigger('click')
    await flushPromises()
    expect(startIssue).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: true, item: expect.objectContaining({ kind: 'prs' }) })
    )
  })

  it('shows auth guidance without launching login and supports Escape', async () => {
    api.status.mockResolvedValue({ ok: true, available: true, authenticated: false })
    await render()
    expect(wrapper.text()).toContain('gh auth login')
    expect(api.list).not.toHaveBeenCalled()
    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('Linear issue dialog', () => {
  let api
  beforeEach(() => {
    api = {
      status: vi.fn(async () => ({
        ok: true,
        configured: true,
        viewer: { name: 'Person' },
        organization: { name: 'Studio' }
      })),
      connect: vi.fn(async () => ({
        ok: true,
        configured: true,
        viewer: { name: 'Person' },
        organization: { name: 'Studio' }
      })),
      disconnect: vi.fn(async () => ({ ok: true, configured: false })),
      issues: vi.fn(async () => ({ ok: true, items: [linearItem()], hasNextPage: false })),
      teams: vi.fn(async () => ({
        ok: true,
        teams: [
          { id: 'team-1', name: 'Product' },
          { id: 'team-2', name: 'Infra' }
        ]
      })),
      states: vi.fn(async () => ({ ok: true, states: [{ id: 'doing', name: 'In progress' }] })),
      setState: vi.fn(async () => ({ ok: true }))
    }
    window.shellApi = { linear: api, openExternal: vi.fn(), writeClipboard: vi.fn() }
  })
  async function render(extra = {}) {
    wrapper = mount(LinearDialog, { props: { ...props, ...extra } })
    await flushPromises()
  }
  async function openItem() {
    await wrapper.get('[data-test="linear-item"]').trigger('click')
    await flushPromises()
  }

  it('starts with Assigned and uses read-only methods until explicit user action', async () => {
    await render()
    expect(api.issues).toHaveBeenCalledWith({ filter: 'assigned', refresh: false })
    expect(api.connect).not.toHaveBeenCalled()
    expect(api.disconnect).not.toHaveBeenCalled()
    expect(api.setState).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Studio')
  })

  it('tests a personal key only on Test and save and clears it after successful connection', async () => {
    api.status.mockResolvedValue({ ok: true, configured: false })
    await render()
    const secret = 'lin_api_test-secret-value'
    expect(wrapper.get('[data-test="linear-key"]').attributes('type')).toBe('password')
    await wrapper.get('[data-test="linear-key"]').setValue(secret)
    expect(api.connect).not.toHaveBeenCalled()
    expect(api.issues).not.toHaveBeenCalled()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(api.connect).toHaveBeenCalledWith({ key: secret })
    expect(wrapper.text()).not.toContain(secret)
    await wrapper.get('[data-test="linear-disconnect"]').trigger('click')
    expect(api.disconnect).not.toHaveBeenCalled()
    await wrapper.get('[data-test="linear-disconnect-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="linear-key"]').element.value).toBe('')
  })

  it('redacts a key even if an unexpected rejected promise echoes it', async () => {
    api.status.mockResolvedValue({ ok: true, configured: false })
    const secret = 'lin_api_test-secret-value'
    api.connect.mockRejectedValue(new Error(`Invalid ${secret}`))
    await render()
    await wrapper.get('[data-test="linear-key"]').setValue(secret)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Invalid [redacted]')
    expect(wrapper.get('[role="alert"]').text()).not.toContain(secret)
  })

  it('keeps the latest issue filter result when older requests finish later', async () => {
    await render()
    const older = deferred(),
      newer = deferred()
    api.issues.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    await setSelectValue(wrapper.get('[data-test="linear-filter"]'), 'created')
    await setSelectValue(wrapper.get('[data-test="linear-filter"]'), 'completed')
    newer.resolve({ ok: true, items: [linearItem('new')], hasNextPage: true })
    await flushPromises()
    older.resolve({ ok: true, items: [linearItem('old')] })
    await flushPromises()
    expect(wrapper.text()).toContain('Linear new')
    expect(wrapper.text()).not.toContain('Linear old')
    expect(wrapper.text()).toContain('first 100')
  })

  it('keeps workflow states scoped to the latest selected team', async () => {
    await render()
    const older = deferred(),
      newer = deferred()
    api.states.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    await setSelectValue(wrapper.get('[data-test="linear-team"]'), 'team-1')
    await setSelectValue(wrapper.get('[data-test="linear-team"]'), 'team-2')
    newer.resolve({ ok: true, states: [{ id: 'infra-doing', name: 'Infra state' }] })
    await flushPromises()
    older.resolve({ ok: true, states: [{ id: 'product-doing', name: 'Product state' }] })
    await flushPromises()
    const stateOptions = (await selectOptions(wrapper.get('[data-test="linear-state"]'))).map(o => o.text()).join(' ')
    expect(stateOptions).toContain('Infra state')
    expect(stateOptions).not.toContain('Product state')
  })

  it('delegates the optional workflow change only with explicit Start and never mutates before preparation', async () => {
    const first = deferred(),
      startIssue = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ ok: true })
    await render({ startIssue })
    await openItem()
    expect(wrapper.get('[data-test="linear-start-state"]').element.value).toBe('')
    await setSelectValue(wrapper.get('[data-test="linear-start-state"]'), 'doing')
    expect(startIssue).not.toHaveBeenCalled()
    expect(api.setState).not.toHaveBeenCalled()
    await wrapper.get('[data-test="linear-start"]').trigger('click')
    expect(startIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'linear',
        stateId: 'doing',
        worktree: true,
        agentId: 'codex'
      })
    )
    expect(wrapper.emitted('close')).toBeUndefined()
    first.resolve({ ok: false, error: 'Task could not be prepared.' })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Task could not be prepared')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(api.setState).not.toHaveBeenCalled()
    await wrapper.get('[data-test="linear-start"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('copies plain issue details and labels controls for keyboard users', async () => {
    await render()
    await openItem()
    for (const control of wrapper.findAll('input,select,textarea'))
      expect(control.element.labels.length).toBeGreaterThan(0)
    await button('Copy issue').trigger('click')
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith(
      expect.stringContaining('APP-one Linear one')
    )
    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
