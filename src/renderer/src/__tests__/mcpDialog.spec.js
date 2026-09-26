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
})
