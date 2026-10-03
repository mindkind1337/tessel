import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SessionsDialog from '../components/SessionsDialog.vue'

let wrapper
const previousApi = window.shellApi
afterEach(() => {
  wrapper?.unmount()
  window.shellApi = previousApi
})

describe('multi-agent conversation history', () => {
  it('filters the new agents, searches titles, and resumes the selected conversation in its saved folder', async () => {
    const rows = [
      {
        agent: 'gemini',
        id: 'gemini-session',
        cwd: 'C:/Project',
        title: 'Gemini login',
        updated: Date.now()
      },
      {
        agent: 'qwen',
        id: 'qwen-session',
        cwd: 'C:/Project',
        title: 'Qwen database',
        updated: Date.now()
      },
      {
        agent: 'opencode',
        id: 'ses_open',
        cwd: 'D:/Other',
        title: 'OpenCode layout',
        updated: Date.now()
      }
    ]
    window.shellApi = { listSessions: vi.fn().mockResolvedValue(rows), writeClipboard: vi.fn() }
    wrapper = mount(SessionsDialog)
    await flushPromises()
    expect(wrapper.findAll('.session-row')).toHaveLength(3)
    await wrapper
      .findAll('.mcp-cat')
      .find((b) => b.text() === 'OpenCode')
      .trigger('click')
    expect(wrapper.findAll('.session-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('OpenCode layout')
    await wrapper.find('.session-row .primary').trigger('click')
    expect(wrapper.emitted('resume')).toEqual([[rows[2]]])
    await wrapper
      .findAll('.mcp-cat')
      .find((b) => b.text() === 'All')
      .trigger('click')
    await wrapper.find('input').setValue('database')
    expect(wrapper.findAll('.session-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('Qwen database')
  })

  it('allows copying an unknown-folder session but never resumes it in the current workspace', async () => {
    const unknown = {
      agent: 'gemini',
      id: 'saved-id',
      cwd: '',
      title: 'Older conversation',
      updated: Date.now()
    }
    window.shellApi = {
      listSessions: vi.fn().mockResolvedValue([unknown]),
      writeClipboard: vi.fn()
    }
    wrapper = mount(SessionsDialog, { props: { cwd: 'C:/Current' } })
    await flushPromises()
    expect(wrapper.text()).toContain('Unknown folder')
    const resume = wrapper.find('.session-row .primary')
    expect(resume.attributes('disabled')).toBeDefined()
    await resume.trigger('click')
    expect(wrapper.emitted('resume')).toBeUndefined()
    await wrapper
      .findAll('.session-row button')
      .find((b) => b.text() === 'Copy ID')
      .trigger('click')
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith('saved-id')
    await wrapper
      .findAll('.mcp-cat')
      .find((b) => b.text().startsWith('Only '))
      .trigger('click')
    await flushPromises()
    expect(window.shellApi.listSessions).toHaveBeenLastCalledWith({ cwd: null, limit: 80 })
  })

  it('continues an Antigravity IDE conversation in the CLI even when its folder is unknown', async () => {
    const ide = { agent: 'antigravity', origin: 'ide', id: 'ide-id', cwd: '', title: 'From the IDE', updated: Date.now() }
    window.shellApi = { listSessions: vi.fn().mockResolvedValue([ide]), writeClipboard: vi.fn() }
    wrapper = mount(SessionsDialog, { props: { cwd: 'C:/Current' } })
    await flushPromises()
    const resume = wrapper.find('.session-row .primary')
    expect(resume.text()).toBe('Continue in CLI')
    expect(resume.attributes('disabled')).toBeUndefined()
    expect(resume.attributes('title')).toContain('folder is unknown')
    await resume.trigger('click')
    expect(wrapper.emitted('resume')).toEqual([[ide]])
  })

  it('shows a filter for each agent that has conversations', async () => {
    const rows = [{ agent: 'droid', id: 'droid-session', cwd: 'C:/P', title: 'Droid task', updated: Date.now() }]
    window.shellApi = { listSessions: vi.fn().mockResolvedValue(rows), writeClipboard: vi.fn() }
    wrapper = mount(SessionsDialog)
    await flushPromises()
    const chips = wrapper.findAll('.mcp-cat').map((b) => b.text())
    expect(chips).toContain('Droid')
    expect(chips).toContain('Claude Code')
    expect(chips).not.toContain('Grok')
  })
})

describe('search in what was said (opt-in)', () => {
  const rows = [{ agent: 'claude', id: 'c1', cwd: 'C:/P', title: 'Listed by title', updated: Date.now() }]
  function api(status, extra = {}) {
    let current = { available: true, enabled: false, phase: 'idle', filesIndexed: 0, filesDue: 0, sessions: 0, sizeBytes: 0, historyDays: 90, ...status }
    const sessionSearch = {
      status: vi.fn(async () => current),
      enable: vi.fn(async () => {
        current = { ...current, enabled: true, phase: 'current', sessions: 12, sizeBytes: 3 * 1048576 }
        return { ok: true }
      }),
      disable: vi.fn(async () => {
        current = { ...current, enabled: false }
        return { ok: true }
      }),
      clear: vi.fn(async () => ({ ok: true })),
      setHistoryDays: vi.fn(async () => ({ ok: true })),
      search: vi.fn(async () => ({ ok: true, hits: [] })),
      ...extra
    }
    window.shellApi = { listSessions: vi.fn().mockResolvedValue(rows), writeClipboard: vi.fn(), sessionSearch }
    return sessionSearch
  }

  it('off: the opt-in says what it does and where the index stays; the box still filters titles; nothing is searched', async () => {
    const s = api()
    wrapper = mount(SessionsDialog, { props: { cwd: 'C:/P' } })
    await flushPromises()
    const optin = wrapper.get('[data-test="sessions-optin"]')
    expect(optin.text()).toContain('Search every agent session')
    expect(optin.text()).toContain('nothing is sent anywhere')
    // What the index is, plainly: full text (pasted keys included), not encrypted, kept until cleared.
    expect(optin.text()).toContain('full text of the conversations, including what was pasted')
    expect(optin.text()).toContain('not encrypted')
    expect(optin.text()).toContain('until you clear it')
    expect(wrapper.find('[data-test="sessions-left"]').exists()).toBe(false)
    await wrapper.get('[data-test="sessions-query"]').setValue('listed')
    await flushPromises()
    expect(s.search).not.toHaveBeenCalled()
    expect(wrapper.findAll('.session-row')).toHaveLength(1)
    await wrapper.get('[data-test="sessions-enable"]').trigger('click')
    await flushPromises()
    expect(s.enable).toHaveBeenCalled()
    expect(wrapper.find('[data-test="sessions-optin"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="sessions-index"]').text()).toContain('Index up to date: 12 conversations (3 MB)')
  })

  it('on: results show the passage with its matches marked, secrets masked, and resume the conversation; scopes and agents go to the search', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const s = api(
        { enabled: true, phase: 'current', sessions: 3 },
        {
          search: vi.fn(async () => ({
            ok: true,
            hits: [
              {
                agent: 'codex',
                sessionId: 'x1',
                title: 'Deploy with token=abcdef0123456789abcdef0123456789',
                cwd: 'C:/P/sub',
                updatedAt: Date.now() - 3600000,
                messageCount: 14,
                evidence: { snippet: 'the release <b>notes</b> use Bearer abcdef0123456789abcdef0123456789abcd … [[not a mark]]', role: 'assistant', ts: 1 }
              }
            ]
          }))
        }
      )
      wrapper = mount(SessionsDialog, { props: { cwd: 'C:/P' } })
      await flushPromises()
      await wrapper.get('[data-test="sessions-query"]').setValue('release')
      await vi.advanceTimersByTimeAsync(200)
      await flushPromises()
      expect(s.search).toHaveBeenLastCalledWith({ query: 'release', scope: { kind: 'project', path: 'C:/P' }, agents: null, limit: 40 })
      const hit = wrapper.get('[data-test="sessions-hit"]')
      expect(hit.get('mark').text()).toBe('release')
      // Text only, and no secret in the title or the passage.
      expect(hit.find('b').exists()).toBe(false)
      expect(hit.text()).toContain('<b>notes</b>')
      expect(hit.text()).not.toContain('abcdef0123456789')
      expect(hit.text()).toContain('[[not a mark]]')
      expect(hit.findAll('mark')).toHaveLength(1)
      expect(hit.text()).toContain('Codex · 14 messages')
      await hit.get('.exit-btn.primary').trigger('click')
      expect(wrapper.emitted('resume')[0][0]).toMatchObject({ agent: 'codex', id: 'x1', cwd: 'C:/P/sub' })
      // Another scope, another agent: asked again.
      await wrapper.get('[data-test="sessions-scopes"]').findAll('button')[2].trigger('click')
      await vi.advanceTimersByTimeAsync(200)
      expect(s.search).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: 'all', path: 'C:/P' } }))
      await wrapper.get('[data-test="sessions-clear"]').trigger('click')
      await flushPromises()
      expect(s.clear).toHaveBeenCalled()
      await wrapper.get('[data-test="sessions-disable"]').trigger('click')
      await flushPromises()
      expect(s.disable).toHaveBeenCalled()
      expect(wrapper.find('[data-test="sessions-optin"]').exists()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('off with an index left on disk: its size is said on the opt-in, with a way to clear it', async () => {
    const s = api({ sizeBytes: 7 * 1048576 })
    wrapper = mount(SessionsDialog)
    await flushPromises()
    expect(wrapper.get('[data-test="sessions-left"]').text()).toBe('An index of 7 MB is still on this computer.')
    await wrapper.get('[data-test="sessions-clear-left"]').trigger('click')
    await flushPromises()
    expect(s.clear).toHaveBeenCalled()
  })

  it('no search bridge (an older main process): the dialog is as before', async () => {
    window.shellApi = { listSessions: vi.fn().mockResolvedValue(rows), writeClipboard: vi.fn() }
    wrapper = mount(SessionsDialog)
    await flushPromises()
    expect(wrapper.find('[data-test="sessions-optin"]').exists()).toBe(false)
    expect(wrapper.findAll('.session-row')).toHaveLength(1)
  })
})
