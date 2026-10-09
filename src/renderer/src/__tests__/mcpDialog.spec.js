import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import McpDialog from '../components/McpDialog.vue'

describe('MCP servers dialog', () => {
  let previousApi
  afterEach(() => {
    window.shellApi = previousApi
  })

  it('opens with every agent installed before its server lists arrive, then shows them', async () => {
    previousApi = window.shellApi
    let answer
    window.shellApi = {
      mcpList: () => new Promise((r) => (answer = r)),
      checkTools: async () => ({})
    }
    const agents = ['claude', 'codex', 'gemini', 'qwen', 'copilot', 'opencode', 'cline'].map((id) => ({ id, available: true }))
    // Drawn while the lists are still being read: must not throw.
    const wrapper = mount(McpDialog, { props: { agents }, attachTo: document.body })
    expect(wrapper.text()).toContain('Loading')
    answer({
      claude: [],
      codex: [],
      others: { cline: { servers: [{ name: 'tessel-team', type: 'stdio', target: 'node s.cjs' }] } }
    })
    await flushPromises()
    expect(wrapper.text()).toContain('tessel-team')
    wrapper.unmount()
  })

  it('adds to every chosen agent even when one fails, and shows Needs sign-in with Sign in instead of Added', async () => {
    previousApi = window.shellApi
    const have = { claude: [], codex: [], gemini: [] }
    const added = []
    window.shellApi = {
      mcpList: async () => ({ claude: have.claude, codex: have.codex, others: { gemini: { servers: have.gemini } } }),
      checkTools: async () => ({}),
      mcpAdd: async (spec) => {
        added.push(spec.agent)
        if (spec.agent === 'claude') return { ok: false, error: 'boom' }
        have[spec.agent].push({ name: spec.name, scope: 'user', type: 'http', target: spec.url })
        return { ok: true }
      },
      mcpTest: async ({ agent }) =>
        agent === 'codex' ? { ok: false, status: 'auth', error: 'needs you to sign in' } : { ok: true, status: 'connected', tools: ['a'] }
    }
    const agents = ['claude', 'codex', 'gemini'].map((id) => ({ id, available: true }))
    const wrapper = mount(McpDialog, { props: { agents, initialTab: 'installed' }, attachTo: document.body })
    await flushPromises()
    await wrapper.findAll('.launch-seg-btn').find((b) => b.text() === 'Catalog').trigger('click')
    const card = () => wrapper.findAll('.mcp-entry').find((e) => e.text().includes('Context7'))
    await card().find('.mcp-entry-head .exit-btn').trigger('click')
    await card().find('form').trigger('submit')
    await flushPromises()
    await flushPromises()
    expect(added).toEqual(['claude', 'codex', 'gemini'])
    const text = card().text()
    expect(text).toContain('Claude Code: boom')
    expect(text).toContain('Needs sign-in')
    // Not "Added" while Claude Code lacks it.
    expect(card().find('.tool-status.ok').exists()).toBe(false)
    const rows = card().findAll('.mcp-add-results .mcp-agent')
    expect(rows.map((r) => r.find('.mcp-status').text())).toEqual(['Failed', 'Needs sign-in', 'Added'])
    await rows[1].find('button').trigger('click')
    expect(wrapper.emitted('run')[0][0].command).toBe('codex mcp login context7')
    wrapper.unmount()
  })
})
