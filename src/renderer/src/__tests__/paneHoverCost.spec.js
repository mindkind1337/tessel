// The pane header's hover card (PaneHoverDetails.vue): what the pane's
// current session used, asked while the card is open (jobCost.js).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import PaneHoverDetails from '../components/PaneHoverDetails.vue'
import { resetJobCost } from '../jobCost'
import { setMessages } from '../i18n'
import fr from '../i18n/locales/fr/jobCost.json'

enableAutoUnmount(afterEach)

const ENTRY = {
  inputTokens: 10000,
  outputTokens: 2400,
  cacheReadTokens: 1_200_000,
  cacheWriteTokens: 30000,
  durationMs: 360000,
  usd: 0.31,
  known: true,
  model: 'claude-opus-5-5',
  provider: 'anthropic',
  estimated: true
}
const info = (extra = {}) => ({ heading: 'Ada', agentName: 'Claude Code', iconKind: 'claude', state: null, team: null, session: 's1', id: 'p1', ...extra })

function install(byPane) {
  const api = {
    forCards: vi.fn(async () => ({})),
    forPanes: vi.fn(async (ids) => Object.fromEntries(ids.filter((id) => byPane[id]).map((id) => [id, byPane[id]]))),
    onChanged: vi.fn(() => () => {})
  }
  window.shellApi = { jobCost: api }
  return api
}

beforeEach(() => {
  resetJobCost()
  setMessages('en', {})
})
afterEach(() => {
  delete window.shellApi
  setMessages('en', {})
})

describe('pane hover card: session usage', () => {
  it('shows the line and each kind of token, the model and what the estimate means', async () => {
    const api = install({ p1: ENTRY })
    const wrapper = mount(PaneHoverDetails, { props: { info: info() } })
    await vi.waitFor(() => expect(wrapper.find('[data-hover-cost]').exists()).toBe(true))
    expect(api.forPanes).toHaveBeenCalledWith(['p1'])
    const section = wrapper.get('[data-hover-cost]')
    expect(section.text()).toContain('This session')
    expect(wrapper.get('[data-hover-cost-line]').text()).toBe('12.4k tokens · 6 min · ~$0.31')
    for (const want of ['Input: 10k tokens', 'Output: 2.4k tokens', 'Cache read: 1.2M tokens', 'Cache write: 30k tokens', 'Model: Opus 5.5', 'API-equivalent estimate (subscriptions are not billed per token)'])
      expect(section.text()).toContain(want)
    // Time and cost only once (in the line).
    expect(section.text()).not.toContain('Cost:')
  })

  it('unknown price: tokens and time, "cost unknown"', async () => {
    install({ p1: { ...ENTRY, usd: null, known: false } })
    const wrapper = mount(PaneHoverDetails, { props: { info: info() } })
    await vi.waitFor(() => expect(wrapper.find('[data-hover-cost-line]').exists()).toBe(true))
    expect(wrapper.get('[data-hover-cost-line]').text()).toBe('12.4k tokens · 6 min · cost unknown')
  })

  it('French', async () => {
    install({ p1: ENTRY })
    setMessages('fr', fr)
    const wrapper = mount(PaneHoverDetails, { props: { info: info() } })
    await vi.waitFor(() => expect(wrapper.find('[data-hover-cost]').exists()).toBe(true))
    expect(wrapper.get('[data-hover-cost]').text()).toContain('Cette session')
    expect(wrapper.get('[data-hover-cost-line]').text().replace(/\s/g, ' ')).toMatch(/^12,4k tokens · 6 min · ~0,31 \$$/)
  })

  it('a shell pane (no id), no usage or no API: no section', async () => {
    install({})
    const shell = mount(PaneHoverDetails, { props: { info: info({ id: '' }) } })
    const fresh = mount(PaneHoverDetails, { props: { info: info({ id: 'p2' }) } })
    await flushPromises()
    expect(shell.find('[data-hover-cost]').exists()).toBe(false)
    expect(fresh.find('[data-hover-cost]').exists()).toBe(false)
    delete window.shellApi
    resetJobCost()
    const none = mount(PaneHoverDetails, { props: { info: info() } })
    await flushPromises()
    expect(none.find('[data-hover-cost]').exists()).toBe(false)
  })
})
