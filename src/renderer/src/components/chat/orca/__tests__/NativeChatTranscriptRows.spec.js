// The list's leaf rows: NativeChatWorkingStatus, NativeChatTurnActivityLine,
// NativeChatOlderHistoryRow, NativeChatTranscriptRow, NativeChatTypingIndicatorRow
// (after Orca's components of the same names, MIT, Copyright (c) 2026 Lovecast Inc.;
// the reference covers them only through NativeChatMessageList's suites).
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setMessages, setUiLanguage } from '../../../../i18n'
import NativeChatWorkingStatus, { formatNativeChatDuration } from '../NativeChatWorkingStatus.vue'
import NativeChatTurnActivityLine from '../NativeChatTurnActivityLine.vue'
import NativeChatOlderHistoryRow from '../NativeChatOlderHistoryRow.vue'
import NativeChatTranscriptRow from '../NativeChatTranscriptRow.vue'
import NativeChatTypingIndicatorRow from '../NativeChatTypingIndicatorRow.vue'

vi.mock('../NativeChatMessageRow.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).MessageRowStub
}))
vi.mock('../NativeChatResolutionReceipt.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).ResolutionReceiptStub
}))
vi.mock('../NativeChatTurnDiffRollup.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).TurnDiffRollupStub
}))

afterEach(async () => {
  vi.useRealTimers()
  await setUiLanguage('en')
})

describe('NativeChatWorkingStatus', () => {
  it('re-exports the duration format', () => {
    expect(formatNativeChatDuration(197)).toBe('3m 17s')
  })

  it('is a disclosure button once settled with a toggle', async () => {
    const toggle = vi.fn()
    const wrapper = mount(NativeChatWorkingStatus, {
      props: { startedAt: 1, thinking: false, workedSeconds: 3, expanded: false, onToggleExpanded: toggle }
    })
    const button = wrapper.get('button')
    expect(button.text()).toBe('Worked for 3s')
    expect(button.attributes('aria-label')).toBe('Toggle turn details')
    expect(button.attributes('aria-expanded')).toBe('false')
    expect(button.attributes('data-native-chat-turn-status')).toBe('settled')
    await button.trigger('click')
    expect(toggle).toHaveBeenCalledTimes(1)
    await wrapper.setProps({ expanded: true })
    expect(button.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.nc-working-status__caret--open').exists()).toBe(true)
  })

  it('is a polite status line without a toggle, pulsing while thinking', () => {
    const settled = mount(NativeChatWorkingStatus, { props: { startedAt: 1, thinking: false, workedSeconds: 3 } })
    expect(settled.find('button').exists()).toBe(false)
    expect(settled.get('[data-native-chat-turn-status]').attributes('data-native-chat-turn-status')).toBe('settled')
    expect(settled.get('[aria-live="polite"]').attributes('aria-label')).toBe('Agent is responding')

    const thinking = mount(NativeChatWorkingStatus, { props: { startedAt: Date.now(), thinking: true } })
    expect(thinking.text()).toBe('Thinking')
    expect(thinking.get('span').classes()).toContain('nc-animate-pulse')
    expect(thinking.get('div').classes()).not.toContain('nc-working-status--ruled')
    expect(thinking.get('div').attributes('data-native-chat-turn-status')).toBe('active')
  })

  it('counts the live turn every second', async () => {
    vi.useFakeTimers()
    const wrapper = mount(NativeChatWorkingStatus, { props: { startedAt: Date.now(), thinking: false } })
    expect(wrapper.text()).toBe('Working for 0s')
    vi.advanceTimersByTime(2000)
    await nextTick()
    expect(wrapper.text()).toBe('Working for 2s')
  })

  it('speaks French', async () => {
    setMessages('fr', { 'chat.orca.status.workedFor': 'A travaillé pendant {{value0}}' })
    const wrapper = mount(NativeChatWorkingStatus, { props: { startedAt: 1, thinking: false, workedSeconds: 5 } })
    expect(wrapper.text()).toBe('A travaillé pendant 5s')
  })
})

describe('NativeChatTurnActivityLine', () => {
  it('says "Working…" before the turn has a status, with a spinner', () => {
    const wrapper = mount(NativeChatTurnActivityLine, { props: { activity: null, status: null } })
    expect(wrapper.text()).toBe('Working…')
    expect(wrapper.get('svg').classes()).toContain('nc-animate-spin')
    expect(wrapper.get('svg').attributes('aria-hidden')).toBe('true')
    expect(wrapper.attributes('aria-atomic')).toBe('true')
  })

  it('prefers the provider activity, then Thinking, then the clock', async () => {
    const status = { startedAt: Date.now() - 4000, thinking: false, workedSeconds: null }
    const wrapper = mount(NativeChatTurnActivityLine, {
      props: { activity: { kind: 'description', text: 'Reading files' }, status: { ...status, thinking: true } }
    })
    expect(wrapper.text()).toBe('Reading files')
    await wrapper.setProps({ activity: null })
    expect(wrapper.text()).toBe('Thinking')
    await wrapper.setProps({ status })
    // useNow's clock is shared per interval and may still hold an earlier
    // case's (faked) time, so allow its one-second step.
    expect(wrapper.text()).toMatch(/^Working for [45]s$/)
  })
})

describe('NativeChatOlderHistoryRow', () => {
  const olderHistory = (overrides = {}) => ({
    sentinelRef: vi.fn(),
    isAutoLoadEnabled: true,
    loadEarlierManually: vi.fn(),
    ...overrides
  })

  it('hands its element to the sentinel and shows an empty status while auto-loading', () => {
    const history = olderHistory()
    const wrapper = mount(NativeChatOlderHistoryRow, { props: { olderHistory: history, loadingEarlier: false } })
    expect(history.sentinelRef).toHaveBeenCalledWith(wrapper.element)
    expect(wrapper.get('[role="status"]').text()).toBe('')
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('offers a manual load once auto-load has stopped, disabled while a page loads', async () => {
    const history = olderHistory({ isAutoLoadEnabled: false })
    const wrapper = mount(NativeChatOlderHistoryRow, { props: { olderHistory: history, loadingEarlier: false } })
    const button = wrapper.get('button')
    expect(button.text()).toBe('Load earlier messages')
    await button.trigger('click')
    expect(history.loadEarlierManually).toHaveBeenCalledTimes(1)
    await wrapper.setProps({ loadingEarlier: true })
    expect(button.text()).toBe('Loading…')
    expect(button.attributes('disabled')).toBeDefined()
  })
})

describe('NativeChatTranscriptRow', () => {
  const message = { id: 'm1', role: 'assistant', blocks: [{ type: 'text', text: 'Hello' }], timestamp: 1, source: 'transcript' }
  const context = (overrides = {}) => ({
    expandSignal: true,
    showTurnStatus: true,
    revealedDiff: null,
    taskListPredecessors: new Map(),
    expandedTurnIds: new Set(),
    failedDeliveryMessageIds: new Set(['m1']),
    allowFileUriLinks: true,
    runtimeContext: null,
    onLinkClick: undefined,
    onToggleExpandedTurn: vi.fn(),
    onScrollMessageToTop: vi.fn(),
    onRevealDiff: vi.fn(),
    ...overrides
  })

  it('hands the message row its slot and the shared context', () => {
    const wrapper = mount(NativeChatTranscriptRow, {
      props: { slot: { message, turnKey: 'u1', activeTurnIsWorking: true, trailingRun: true, folded: false }, context: context() }
    })
    const row = wrapper.get('[data-stub="message-row"]').element.dataset
    expect(row.deliveryFailed).toBe('true')
    expect(row.expandSignal).toBe('true')
    expect(row.allowFileUriLinks).toBe('true')
    expect(row.activeTurnIsWorking).toBe('true')
    expect(row.trailingRun).toBe('true')
    expect(row.structuredActivityUi).toBe('true')
  })

  it('draws the receipt instead of the message, and hands a revealed diff only to its own message', () => {
    const receipt = mount(NativeChatTranscriptRow, {
      props: { slot: { message, receipt: { kind: 'approval', title: 'Run?', resolution: { state: 'resolved' } } }, context: context() }
    })
    expect(receipt.find('[data-native-chat-receipt]').exists()).toBe(true)
    expect(receipt.find('[data-stub="message-row"]').exists()).toBe(false)

    const other = mount(NativeChatTranscriptRow, {
      props: { slot: { message }, context: context({ revealedDiff: { messageId: 'other', requestId: 1 } }) }
    })
    expect(other.text()).not.toContain('Edited file')
    const own = mount(NativeChatTranscriptRow, {
      props: { slot: { message }, context: context({ revealedDiff: { messageId: 'm1', requestId: 1 } }) }
    })
    expect(own.text()).toContain('Edited file')
  })

  it('toggles its turn from the settled status only when the turn folds', async () => {
    const ctx = context()
    const status = { startedAt: 1, thinking: false, workedSeconds: 3 }
    const folding = mount(NativeChatTranscriptRow, {
      props: { slot: { message: { ...message, role: 'user' }, turnKey: 'm1', status, turnFolds: true }, context: ctx }
    })
    await folding.get('button[aria-label="Toggle turn details"]').trigger('click')
    expect(ctx.onToggleExpandedTurn).toHaveBeenCalledWith('m1')
    const plain = mount(NativeChatTranscriptRow, {
      props: { slot: { message: { ...message, role: 'user' }, turnKey: 'm1', status, turnFolds: false }, context: ctx }
    })
    expect(plain.find('button[aria-label="Toggle turn details"]').exists()).toBe(false)
  })
})

describe('NativeChatTypingIndicatorRow', () => {
  it('bounces three dots, staggered', () => {
    const wrapper = mount(NativeChatTypingIndicatorRow)
    const dots = wrapper.findAll('.nc-animate-bounce')
    expect(dots).toHaveLength(3)
    expect(dots.map((dot) => dot.element.style.animationDelay)).toEqual(['0ms', '160ms', '320ms'])
    expect(wrapper.attributes('aria-label')).toBe('Agent is responding')
  })
})
