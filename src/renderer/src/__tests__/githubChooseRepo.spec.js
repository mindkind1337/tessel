// The GitHub dialog for a project whose folder is no Git clone with a GitHub
// remote: it asks which repository to show instead of failing the list, and a
// chosen repository can be changed from the header.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import GitHubDialog from '../components/GitHubDialog.vue'

const chosenRepo = { nameWithOwner: 'owner/project', defaultBranch: 'main', url: 'https://github.com/owner/project', chosen: true }
let wrapper, previousApi, api, stored
beforeEach(() => {
  previousApi = window.shellApi
  stored = null
  api = {
    status: vi.fn(async () => ({ ok: true, available: true, authenticated: true, ...(stored ? { repo: stored } : {}) })),
    chooseRepo: vi.fn(async ({ repo }) => {
      stored = repo ? chosenRepo : null
      return { ok: true, ...(stored ? { repo: stored } : {}) }
    }),
    list: vi.fn(async () => ({ ok: true, items: [] }))
  }
  window.shellApi = { github: api, writeClipboard: vi.fn(), openExternal: vi.fn() }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  window.shellApi = previousApi
})
const render = async () => {
  wrapper = mount(GitHubDialog, { props: { cwd: 'C:/Programs/App' } })
  await flushPromises()
}

describe('GitHub dialog: a folder without a GitHub repository', () => {
  it('asks for the repository instead of loading a list that cannot work', async () => {
    await render()
    expect(api.list).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="github-repo-choice"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('not a Git clone')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('uses the typed repository, then loads its list', async () => {
    await render()
    await wrapper.get('[data-test="github-repo-choice"]').setValue('  owner/project ')
    await wrapper.get('.issue-choose-repo').trigger('submit')
    await flushPromises()
    expect(api.chooseRepo).toHaveBeenCalledWith({ cwd: 'C:/Programs/App', repo: 'owner/project' })
    expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ cwd: 'C:/Programs/App', kind: 'issues' }))
    expect(wrapper.get('.issue-dialog-head').text()).toContain('owner/project')
    expect(wrapper.find('[data-test="github-repo-choice"]').exists()).toBe(false)
  })

  it('shows why a repository was refused, and stays on the choice', async () => {
    api.chooseRepo.mockResolvedValueOnce({ ok: false, error: 'Enter a GitHub repository as owner/name or its URL.' })
    await render()
    await wrapper.get('[data-test="github-repo-choice"]').setValue('nope')
    await wrapper.get('.issue-choose-repo').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('owner/name')
    expect(wrapper.find('[data-test="github-repo-choice"]').exists()).toBe(true)
  })

  it('changes a chosen repository from the header', async () => {
    stored = chosenRepo
    await render()
    expect(api.list).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-test="github-change-repo"]').trigger('click')
    await flushPromises()
    expect(api.chooseRepo).toHaveBeenCalledWith({ cwd: 'C:/Programs/App', repo: '' })
    expect(wrapper.find('[data-test="github-repo-choice"]').exists()).toBe(true)
  })

  it('without the new main process (before a restart), says GitHub could not be loaded', async () => {
    delete api.chooseRepo
    await render()
    expect(api.list).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="github-repo-choice"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('GitHub could not be loaded for this project.')
  })
})
