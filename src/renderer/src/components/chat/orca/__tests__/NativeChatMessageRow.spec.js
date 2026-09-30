// After Orca's NativeChatMessageRow.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.),
// plus Tessel's row protections (src/renderer/src/__tests__/chatMessage.spec.js).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('../NativeChatToolRun.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'ToolRunStub',
      props: ['blocks', 'onRevealDiff', 'disclosureId', 'trailing', 'expandSignal'],
      setup: (props) => () =>
        h('div', { 'data-stub': 'tool-run' }, String(props.blocks?.length ?? 0))
    })
  }
})

import NativeChatMessageRow from '../NativeChatMessageRow.vue'

let prevApi, writeClipboard, wrapper
beforeEach(() => {
  prevApi = window.shellApi
  writeClipboard = vi.fn()
  window.shellApi = { writeClipboard }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  window.shellApi = prevApi
})

function mountRow(props) {
  wrapper = mount(NativeChatMessageRow, {
    props: { expandSignal: false, onScrollMessageToTop: vi.fn(), ...props },
    attachTo: document.body,
    global: { stubs: { transition: false } }
  })
  return wrapper
}

function renderMessage(role, timestamp = 0) {
  return mountRow({
    message: {
      id: 'message',
      role,
      timestamp,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Message text' }]
    }
  })
}

const buttons = () => wrapper.findAll('button')

describe('MessageRow control visibility', () => {
  it('renders and copies a fenced code block through the markdown path', async () => {
    mountRow({
      message: {
        id: 'message',
        role: 'assistant',
        timestamp: 0,
        source: 'transcript',
        blocks: [{ type: 'text', text: '```ts\nconst answer = 42\n```' }]
      }
    })
    expect(wrapper.find('[data-code-language="ts"]').text()).toBe('ts')
    await wrapper.find('button[aria-label="Copy code"]').trigger('click')
    await flushPromises()
    expect(writeClipboard).toHaveBeenCalledWith('const answer = 42\n')
  })

  it('appends time to the existing agent controls and inherits their reveal', () => {
    renderMessage('assistant')
    const copy = wrapper.find('button[aria-label="Copy message"]').element
    const scroll = wrapper.find('button[aria-label="Scroll this message to top"]').element
    const time = wrapper.find('time').element
    expect(Array.from(copy.parentElement.children)).toEqual([copy, scroll, time])
    // The reveal-on-hover class (hidden only where something hovers).
    expect(copy.parentElement.classList.contains('nc-row-controls')).toBe(true)
    expect(copy.parentElement.closest('.nc-row')).not.toBeNull()
    expect(time.hasAttribute('tabindex')).toBe(false)
    copy.focus()
    expect(document.activeElement).toBe(copy)
  })

  it('scrolls this message to the top with its own element', async () => {
    const onScrollMessageToTop = vi.fn()
    mountRow({
      message: { id: 'm', role: 'assistant', timestamp: 0, blocks: [{ type: 'text', text: 'Hi' }] },
      onScrollMessageToTop
    })
    await wrapper.find('button[aria-label="Scroll this message to top"]').trigger('click')
    expect(onScrollMessageToTop).toHaveBeenCalledWith(wrapper.find('.nc-row-agent').element)
  })

  it('gives user bubbles a copy button and timestamp that only hide on hover-capable devices', () => {
    renderMessage('user')
    const copy = wrapper.find('button[aria-label="Copy message"]').element
    const time = wrapper.find('time').element
    expect(Array.from(copy.parentElement.children)).toEqual([copy, time])
    expect(copy.parentElement.classList.contains('nc-row-controls')).toBe(true)
    expect(copy.parentElement.parentElement.classList.contains('nc-row')).toBe(true)
    time.focus()
    expect(document.activeElement).toBe(time)
  })

  it('copies the sent message text from a user bubble', async () => {
    renderMessage('user')
    await wrapper.find('button[aria-label="Copy message"]').trigger('click')
    await flushPromises()
    expect(writeClipboard).toHaveBeenCalledWith('Message text')
  })

  it('omits the copy button on image-only user messages', () => {
    mountRow({
      message: {
        id: 'message',
        role: 'user',
        timestamp: 0,
        source: 'transcript',
        blocks: [{ type: 'image-ref', path: '/tmp/screenshot.png', alt: 'Screenshot' }]
      }
    })
    expect(wrapper.find('button[aria-label="Copy message"]').exists()).toBe(false)
    expect(wrapper.find('time').exists()).toBe(true)
    expect(wrapper.text()).toContain('screenshot.png')
  })

  it.each(['assistant', 'user'])('omits unknown timestamps on %s rows', (role) => {
    renderMessage(role, null)
    expect(wrapper.find('time').exists()).toBe(false)
    expect(wrapper.text()).toContain('Message text')
    expect(buttons()).toHaveLength(role === 'assistant' ? 2 : 1)
  })

  it.each(['reasoning', 'system'])('preserves chrome-free %s rows', (role) => {
    renderMessage(role)
    expect(wrapper.find('time').exists()).toBe(false)
    expect(buttons()).toHaveLength(0)
  })

  it('renders nothing for an empty message or behind a folded turn', () => {
    mountRow({
      message: { id: 'e', role: 'assistant', timestamp: 0, blocks: [{ type: 'text', text: '' }] }
    })
    expect(wrapper.find('.nc-row').exists()).toBe(false)
    wrapper.unmount()
    mountRow({
      message: { id: 'f', role: 'assistant', timestamp: 0, blocks: [{ type: 'text', text: 'x' }] },
      folded: true
    })
    expect(wrapper.find('.nc-row').exists()).toBe(false)
  })

  it('hands the turn tool activity to the tool run', () => {
    mountRow({
      message: {
        id: 'tools',
        role: 'assistant',
        timestamp: 0,
        blocks: [
          { type: 'text', text: 'Looking' },
          { type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' }, callId: 'c1' }
        ]
      }
    })
    const run = wrapper.findComponent({ name: 'ToolRunStub' })
    expect(run.exists()).toBe(true)
    expect(run.props('disclosureId')).toBe('tools')
    expect(run.props('blocks')).toHaveLength(1)
  })
})

describe('MessageRow send mode', () => {
  function renderUser(sentAs) {
    return mountRow({
      message: {
        id: 'message',
        role: 'user',
        timestamp: 0,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Ship the parser' }],
        ...(sentAs ? { sentAs } : {})
      }
    })
  }

  it('marks a user message that was sent as a goal', () => {
    renderUser('goal')
    expect(wrapper.text()).toContain('Ship the parser')
    expect(wrapper.text()).toContain('Sent as goal')
  })

  it('leaves an ordinary user message unmarked', () => {
    renderUser()
    expect(wrapper.text()).not.toContain('Sent as goal')
  })
})

describe('MessageRow (Tessel protections)', () => {
  const user = (extra = {}) => ({
    id: 'u1',
    role: 'user',
    timestamp: 0,
    blocks: [{ type: 'text', text: 'build ok' }],
    ...extra
  })

  it('a team message is set apart with its sender', () => {
    mountRow({ message: user({ sentAs: 'team', from: '3' }) })
    expect(wrapper.find('.nc-row-user').classes()).toContain('is-team')
    expect(wrapper.find('[data-test="nc-team-from"]').text()).toBe('From a teammate')
    wrapper.unmount()
    mountRow({ message: user({ sentAs: 'team', from: '#2 Codex' }) })
    expect(wrapper.find('[data-test="nc-team-from"]').text()).toBe('From Codex (teammate)')
    wrapper.unmount()
    mountRow({ message: user({ sentAs: 'team' }) })
    expect(wrapper.find('[data-test="nc-team-from"]').text()).toBe('From a teammate')
    wrapper.unmount()
    mountRow({ message: user() })
    expect(wrapper.find('[data-test="nc-team-from"]').exists()).toBe(false)
  })

  it('a team message not delivered: not an error, it will be sent again; a user message: "Not sent"', () => {
    mountRow({ message: user({ sentAs: 'team', from: '3' }), deliveryFailed: true })
    const chip = wrapper.find('[data-test="nc-user-delivery"]')
    expect(chip.text()).toBe('Not delivered yet: will be sent again')
    expect(chip.classes()).not.toContain('is-error')
    wrapper.unmount()
    mountRow({
      message: user({ id: 'u2', blocks: [{ type: 'text', text: 'mine' }] }),
      deliveryFailed: true
    })
    expect(wrapper.find('[data-test="nc-user-delivery"]').text()).toBe('Not sent')
    expect(wrapper.find('[data-test="nc-user-delivery"]').classes()).toContain('is-error')
    wrapper.unmount()
    mountRow({ message: user() })
    expect(wrapper.find('[data-test="nc-user-delivery"]').exists()).toBe(false)
  })

  it('agent text is Markdown through ChatMarkdown, never raw HTML', () => {
    mountRow({
      message: {
        id: 'a',
        role: 'assistant',
        timestamp: 0,
        blocks: [
          {
            type: 'text',
            text: '**bold** <img src=x onerror="window.__ncRow=1"><script>window.__ncRow=2</script>'
          }
        ]
      }
    })
    expect(wrapper.find('.chat-md strong').text()).toBe('bold')
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('[onerror]').exists()).toBe(false)
    expect(window.__ncRow).toBeUndefined()
  })

  it('a user message is text as Markdown too: its HTML never runs', () => {
    mountRow({
      message: user({ blocks: [{ type: 'text', text: '<b onclick="window.__ncRow=3">hi</b>' }] })
    })
    expect(wrapper.find('[onclick]').exists()).toBe(false)
    expect(wrapper.find('.nc-user-bubble').text()).toBe('hi')
  })
})
