// The banners around the composer (after Orca's NativeChatStructuredSessionStatus
// .test.tsx, MIT, Copyright (c) 2026 Lovecast Inc.; the reference has no
// tests for NativeChatDeliveryRetry, NativeChatLaunchRetry or
// NativeChatEmptyState): the startup line, and Tessel's "Not sent" and
// "Start again" parts of chatPane.spec.js at the component level.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import NativeChatStructuredSessionStatus from '../NativeChatStructuredSessionStatus.vue'
import NativeChatDeliveryRetry from '../NativeChatDeliveryRetry.vue'
import NativeChatLaunchRetry from '../NativeChatLaunchRetry.vue'
import NativeChatEmptyState from '../NativeChatEmptyState.vue'
import { setMessages } from '../../../../i18n'

let wrapper = null
let prevApi
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  setMessages('en', {})
  if (prevApi !== undefined) window.shellApi = prevApi
  prevApi = undefined
  document.body.innerHTML = ''
})

const NO_TASKS = { show: false, isMonitoring: false, tasks: [], settledTasks: [], supportsStop: false, supportsStopAll: false }

describe('NativeChatStructuredSessionStatus', () => {
  function renderStatus(startupPhase, extra = {}) {
    wrapper = mount(NativeChatStructuredSessionStatus, {
      props: { sessionId: 'session-1', agentLabel: 'Claude', startupPhase, error: null, composerError: null, isVisible: true, backgroundTasks: NO_TASKS, stopBackgroundTask: vi.fn(async () => undefined), ...extra },
      attachTo: document.body
    })
  }

  it('says the agent is still starting while the host reports a starting child', () => {
    renderStatus('starting')
    expect(document.body.textContent).toMatch(/Claude is still starting/)
    expect(document.body.textContent).toMatch(/close this chat/)
  })

  it('shows nothing about startup once the child is ready or the host has no word', () => {
    renderStatus('ready')
    expect(document.body.textContent).not.toMatch(/still starting/)
    wrapper.unmount()
    renderStatus(null)
    expect(document.body.textContent).not.toMatch(/still starting/)
  })

  it('shows the session error, else the composer error', async () => {
    renderStatus(null, { error: 'journal locked', composerError: 'not sent' })
    expect(wrapper.find('[data-test="chat-session-error"]').text()).toBe('journal locked')
    await wrapper.setProps({ error: null })
    expect(wrapper.find('[data-test="chat-session-error"]').text()).toBe('not sent')
  })

  // The chat's own zoom (Ctrl+= / Ctrl+-) is set on these lines as on the
  // composer: the sub-agents dock keeps the composer's width and size.
  it("the chat's zoom reaches every line, the background-task dock included", () => {
    wrapper = mount(NativeChatStructuredSessionStatus, {
      props: {
        sessionId: 'session-1',
        agentLabel: 'Claude',
        startupPhase: 'starting',
        error: 'journal locked',
        isVisible: true,
        backgroundTasks: { ...NO_TASKS, show: true, tasks: [{ id: 'a1', kind: 'agent', description: 'count_a' }] }
      },
      attrs: { style: { zoom: 1.3 } },
      attachTo: document.body
    })
    expect(wrapper.find('[data-test="chat-session-starting"]').attributes('style')).toContain('zoom: 1.3')
    expect(wrapper.find('[data-test="chat-session-error"]').attributes('style')).toContain('zoom: 1.3')
    expect(wrapper.find('[data-native-chat-background-tasks]').attributes('style')).toContain('zoom: 1.3')
  })
})

describe('NativeChatDeliveryRetry', () => {
  // Several lines, no single root: the chat's zoom goes on each "Not sent" line.
  it("the chat's zoom reaches every not-sent line", () => {
    wrapper = mount(NativeChatDeliveryRetry, {
      props: { unsent: [{ key: 1, text: 'a', error: 'x' }, { key: 2, text: 'b', error: 'y' }] },
      attrs: { style: { zoom: 0.8 } }
    })
    const lines = wrapper.findAll('[data-test="chat-unsent"]')
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line.attributes('style')).toContain('zoom: 0.8')
  })

  it('the reference outbox: Retry names the entry the queue stopped on', async () => {
    const retry = vi.fn()
    wrapper = mount(NativeChatDeliveryRetry, {
      props: {
        outbox: [
          { clientMessageId: 'b', state: 'unconfirmed' },
          { clientMessageId: 'a', state: 'queued' }
        ],
        blockedClientMessageId: null,
        retry
      }
    })
    expect(wrapper.text()).toContain('Message delivery is unconfirmed.')
    await wrapper.find('[data-test="chat-delivery-retry"] button').trigger('click')
    expect(retry).toHaveBeenCalledWith('b')
    await wrapper.setProps({ outbox: [{ clientMessageId: 'a', state: 'queued' }] })
    expect(wrapper.find('[data-test="chat-delivery-retry"]').exists()).toBe(false)
    await wrapper.setProps({ blockedClientMessageId: 'a' })
    expect(wrapper.text()).toContain('Message was not sent.')
  })

  it('Tessel\'s "Not sent": the text and its error; retry, copy through the bridge, discard', async () => {
    prevApi = window.shellApi
    window.shellApi = { writeClipboard: vi.fn() }
    const entry = { key: 1, text: 'message A', error: 'no session', sending: false }
    wrapper = mount(NativeChatDeliveryRetry, { props: { unsent: [entry] } })
    const box = wrapper.find('[data-test="chat-unsent"]')
    expect(box.attributes('role')).toBe('group')
    expect(box.attributes('aria-label')).toBe('Not sent')
    expect(box.text()).toContain('Not sent')
    expect(box.find('[data-test="chat-unsent-text"]').text()).toBe('message A')
    expect(box.find('[data-test="chat-unsent-error"]').text()).toBe('no session')

    await box.find('[data-test="chat-unsent-copy"]').trigger('click')
    await flushPromises()
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith('message A')
    expect(wrapper.emitted('copied')[0][0]).toEqual({ entry, ok: true })

    await box.find('[data-test="chat-unsent-retry"]').trigger('click')
    expect(wrapper.emitted('retry-unsent')[0][0]).toStrictEqual(entry)
    await box.find('[data-test="chat-unsent-discard"]').trigger('click')
    expect(wrapper.emitted('discard')[0][0]).toStrictEqual(entry)
  })

  it('while sending: "Sending…", no error, Retry and Discard wait; Retry waits for the reason too', async () => {
    wrapper = mount(NativeChatDeliveryRetry, { props: { unsent: [{ key: 1, text: 'x', error: 'old', sending: true }] } })
    expect(wrapper.text()).toContain('Sending…')
    expect(wrapper.find('[data-test="chat-unsent-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="chat-unsent-retry"]').element.disabled).toBe(true)
    expect(wrapper.find('[data-test="chat-unsent-discard"]').element.disabled).toBe(true)
    await wrapper.setProps({ unsent: [{ key: 1, text: 'x', error: 'old', sending: false }], retryDisabledReason: 'Wait until Claude has started' })
    const retry = wrapper.find('[data-test="chat-unsent-retry"]')
    expect(retry.element.disabled).toBe(true)
    expect(retry.attributes('title')).toBe('Wait until Claude has started')
  })

  it('no clipboard at all: says the copy failed', async () => {
    prevApi = window.shellApi
    window.shellApi = {}
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    try {
      wrapper = mount(NativeChatDeliveryRetry, { props: { unsent: [{ key: 1, text: 'x', error: '', sending: false }] } })
      await wrapper.find('[data-test="chat-unsent-copy"]').trigger('click')
      await flushPromises()
      expect(wrapper.emitted('copied')[0][0].ok).toBe(false)
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
      else delete navigator.clipboard
    }
  })
})

describe('NativeChatLaunchRetry', () => {
  it('the reference lifecycle: failed (with its reason) or unconfirmed, and Retry', async () => {
    wrapper = mount(NativeChatLaunchRetry, { props: { lifecycle: 'failed', failureReason: 'spawn EACCES' } })
    expect(wrapper.text()).toContain('Chat could not be started. spawn EACCES')
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    await wrapper.setProps({ lifecycle: 'visibility-unknown' })
    expect(wrapper.text()).toContain('Chat connection could not be confirmed.')
    expect(wrapper.text()).not.toContain('spawn EACCES')
    await wrapper.setProps({ lifecycle: 'ready' })
    expect(wrapper.html()).not.toContain('nc-launch')
  })

  it('not signed in: how to sign in (per agent), Start again waits while opening', async () => {
    wrapper = mount(NativeChatLaunchRetry, { props: { status: 'signin', agentId: 'claude' } })
    expect(wrapper.find('[data-test="chat-state"]').text()).toContain('Claude is not signed in. Open a Claude terminal pane and run /login, then start again.')
    await wrapper.find('[data-test="chat-start-again"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    await wrapper.setProps({ agentId: 'codex', opening: true })
    expect(wrapper.text()).toContain('codex login')
    expect(wrapper.find('[data-test="chat-start-again"]').element.disabled).toBe(true)
  })

  it('untrusted folder: the button asks (through the pane\'s callback)', async () => {
    wrapper = mount(NativeChatLaunchRetry, { props: { status: 'untrusted' } })
    expect(wrapper.find('[data-test="chat-state"]').text()).toContain('This folder is not trusted yet.')
    await wrapper.find('[data-test="chat-trust"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('the agent stopped: its error and Start again', async () => {
    wrapper = mount(NativeChatLaunchRetry, { props: { status: 'crashed', error: 'exit code 3' } })
    expect(wrapper.find('[data-test="chat-state"]').text()).toContain('The agent stopped')
    expect(wrapper.find('[data-test="chat-state-error"]').text()).toBe('exit code 3')
    await wrapper.find('[data-test="chat-start-again"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('nothing while running', () => {
    wrapper = mount(NativeChatLaunchRetry, { props: { status: 'idle' } })
    expect(wrapper.find('[data-test="chat-state"]').exists()).toBe(false)
  })
})

describe('NativeChatEmptyState', () => {
  it('names the agent in the empty state, "the agent" without one', async () => {
    wrapper = mount(NativeChatEmptyState, { props: { kind: 'empty', agent: 'codex' } })
    expect(wrapper.text()).toContain('Start a chat with Codex')
    expect(wrapper.text()).toContain('Ask Codex to inspect code')
    await wrapper.setProps({ agent: undefined })
    expect(wrapper.text()).toContain('Start a chat with the agent')
  })

  it('an error shows its own message; loading and not-agent their copy', async () => {
    wrapper = mount(NativeChatEmptyState, { props: { kind: 'error', message: 'journal locked' } })
    expect(wrapper.text()).toContain('Could not load conversation')
    expect(wrapper.text()).toContain('journal locked')
    await wrapper.setProps({ kind: 'loading', message: undefined })
    expect(wrapper.text()).toContain('Loading conversation…')
    await wrapper.setProps({ kind: 'not-agent' })
    expect(wrapper.text()).toContain('No conversation here')
  })

  it('translated through chat.orca.state.*', () => {
    setMessages('fr', { chat: { orca: { state: { empty: { title: 'Démarrer une discussion avec {{value0}}' } } } } })
    wrapper = mount(NativeChatEmptyState, { props: { kind: 'empty', agent: 'claude' } })
    expect(wrapper.text()).toContain('Démarrer une discussion avec Claude')
  })
})
