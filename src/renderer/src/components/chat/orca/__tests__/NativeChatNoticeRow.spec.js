// After Orca's NativeChatNoticeRow.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.),
// plus Tessel's error protections (src/renderer/src/__tests__/chatMessage.spec.js),
// from Tessel's own chat events through the journal adapter.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('../NativeChatToolRun.vue', () => ({
  default: { name: 'ToolRunStub', render: () => null }
}))

import { AgentJournalItemBodySchema } from '../../../../chat/orca/shared/agent-session-journal-schemas.js'
import { projectStructuredItemsToNativeChat } from '../../../../chat/orca/shared/structured-agent-session-projection.js'
import { createJournalAdapter } from '../../../../chat/orca/adapter/journalAdapter.js'
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
  vi.useRealTimers()
})

function mountMessage(message) {
  wrapper = mount(NativeChatMessageRow, {
    props: { message, expandSignal: false, onScrollMessageToTop: vi.fn() },
    attachTo: document.body
  })
  return wrapper
}

function renderStatus(body) {
  const [message] = projectStructuredItemsToNativeChat([
    { itemId: 'notice', sequence: 1, revision: 1, observedAt: 1, body }
  ])
  return mountMessage(message)
}

// The paragraph holding exactly this text.
function textElement(text) {
  return wrapper
    .findAll('p, span, div')
    .find((w) => w.element.childElementCount === 0 && w.text() === text)?.element
}

describe('notice rows', () => {
  it('renders compaction as a centered separator', () => {
    renderStatus({ kind: 'status', text: 'Context compacted', presentation: 'compaction' })
    const separator = wrapper.find('[role="separator"]')
    expect(separator.attributes('aria-label')).toBe('Context compacted')
    expect(separator.classes()).toContain('nc-notice-separator')
    expect(separator.findAll('.nc-notice-rule')).toHaveLength(2)
  })

  it.each([
    ['warning', 'nc-tone-warning'],
    ['error', 'nc-tone-error'],
    ['notice', 'nc-tone-notice']
  ])('renders %s using its existing color treatment', (tone, className) => {
    renderStatus({ kind: 'status', text: 'Readable notice', tone })
    expect(
      textElement('Readable notice').parentElement.parentElement.classList.contains(className)
    ).toBe(true)
    expect(textElement('Readable notice').parentElement.querySelector('svg')).not.toBeNull()
  })

  it('renders a plan as readable markdown in the card primitive', () => {
    renderStatus({
      kind: 'status',
      text: '# Steps\n\nA **readable** document.',
      presentation: 'plan-document'
    })
    const card = wrapper.find('[data-slot="card"]')
    expect(card.text()).toContain('Plan')
    expect(card.find('h1').text()).toBe('Steps')
    const strong = card.find('strong')
    expect(strong.text()).toBe('readable')
    expect(
      strong.element
        .closest('[data-slot="card-content"]')
        .classList.contains('nc-notice-plan-content')
    ).toBe(true)
  })

  it('shows provider notice text once while retaining its diagnostic disclosure', () => {
    renderStatus({
      kind: 'status',
      text: 'Check the configuration',
      tone: 'warning',
      providerFrame: {
        provider: 'codex',
        kind: 'notification:warning',
        payload: {
          head: '{"message":"Check the configuration"}',
          byteLength: 37,
          digest: 'digest',
          truncated: false
        }
      }
    })
    expect(wrapper.find('.nc-notice-text').text()).toBe('Check the configuration')
    const disclosure = wrapper.find('details')
    expect(disclosure.find('summary').text()).toContain('Details')
    expect(disclosure.find('summary').text()).not.toContain('Check the configuration')
    expect(disclosure.find('pre').text()).toContain('Check the configuration')
  })

  it('renders future presentation and tone values as untinted text', () => {
    renderStatus({
      kind: 'status',
      text: 'Future readable text',
      tone: 'future-tone',
      presentation: 'future-presentation'
    })
    const text = textElement('Future readable text')
    expect(text.parentElement.parentElement.classList.contains('nc-notice')).toBe(true)
    expect(text.parentElement.parentElement.classList.contains('nc-notice-boxed')).toBe(false)
    expect(text.parentElement.querySelector('svg')).toBeNull()
  })
})

describe('old-reader compatibility', () => {
  // Derive the prior status shape without its new optional hints.
  const statusSchema = AgentJournalItemBodySchema.options.find(
    (schema) => schema.shape.kind.value === 'status'
  )
  const oldStatusSchema = statusSchema.omit({ tone: true, presentation: true })
  it.each([
    { presentation: 'compaction' },
    { presentation: 'plan-document' },
    { tone: 'warning' },
    { tone: 'error' },
    { tone: 'notice' },
    { tone: 'future-tone', presentation: 'future-presentation' }
  ])('accepts new metadata and still renders text with an old reader: %j', (metadata) => {
    const body = { kind: 'status', text: 'Text survives version skew', ...metadata }
    expect(AgentJournalItemBodySchema.safeParse(body).success).toBe(true)
    const oldBody = oldStatusSchema.parse(body)
    expect(oldBody).toEqual({ kind: 'status', text: body.text })
    renderStatus(oldBody)
    expect(wrapper.text()).toContain(body.text)
  })
})

describe('error notices (Tessel protections)', () => {
  // Tessel's chat events -> journal items -> the row, as the view will do it.
  function renderEvents(events) {
    const adapter = createJournalAdapter({ now: () => 1000 })
    adapter.replay(events)
    const messages = projectStructuredItemsToNativeChat(adapter.items())
    const notice = messages.find((m) => m.role === 'system')
    return mountMessage(notice)
  }

  it("a failed turn's error is shown whole (new lines kept) and copied with a button", async () => {
    vi.useFakeTimers()
    const error = `API Error: 400 ${'x'.repeat(300)}\nsecond line of the error`
    renderEvents([
      { type: 'user', id: 'u1', text: 'go', status: 'accepted' },
      { type: 'turnEnd', status: 'failed', error }
    ])
    const box = wrapper.find('[data-test="nc-notice"]')
    expect(box.classes()).toContain('nc-tone-error')
    expect(box.find('.nc-notice-text').element.textContent).toBe(error)
    const button = box.find('[data-test="nc-copy-error"]')
    expect(button.element.tagName).toBe('BUTTON')
    expect(button.attributes('type')).toBe('button')
    expect(button.attributes('aria-label')).toBe('Copy the error text')
    const status = button.find('[role="status"]')
    expect(status.text()).toBe('')
    await button.trigger('click')
    await flushPromises()
    expect(writeClipboard).toHaveBeenCalledWith(error)
    expect(status.text()).toBe('Copied')
    vi.advanceTimersByTime(2100)
    await flushPromises()
    expect(status.text()).toBe('')
  })

  it('an interrupted turn with an error shows it too', () => {
    renderEvents([
      { type: 'user', id: 'u1', text: 'go', status: 'accepted' },
      { type: 'turnEnd', status: 'interrupted', error: 'Cancelled by the server' }
    ])
    expect(wrapper.find('.nc-notice-text').text()).toBe('Cancelled by the server')
  })

  it('an error notice can be copied; an info notice has no button', async () => {
    renderEvents([{ type: 'notice', kind: 'error', text: 'The turn failed:\nusage limit' }])
    expect(wrapper.find('.nc-notice-text').element.textContent).toBe(
      'The turn failed:\nusage limit'
    )
    await wrapper.find('[data-test="nc-copy-error"]').trigger('click')
    await flushPromises()
    expect(writeClipboard).toHaveBeenCalledWith('The turn failed:\nusage limit')
    wrapper.unmount()
    renderEvents([{ type: 'notice', kind: 'info', text: 'Model changed' }])
    expect(wrapper.find('.nc-notice-text').text()).toBe('Model changed')
    expect(wrapper.find('[data-test="nc-copy-error"]').exists()).toBe(false)
  })

  it('without the clipboard bridge: the error is shown, no Copy button', () => {
    window.shellApi = {}
    renderEvents([
      { type: 'user', id: 'u1', text: 'go', status: 'accepted' },
      { type: 'turnEnd', status: 'failed', error: 'boom' }
    ])
    expect(wrapper.find('[data-test="nc-notice"]').text()).toBe('boom')
    expect(wrapper.find('[data-test="nc-copy-error"]').exists()).toBe(false)
  })

  it('notice text is text: HTML in it is shown, never rendered', () => {
    renderStatus({
      kind: 'status',
      text: '<img src=x onerror="window.__ncNotice=1">',
      tone: 'error'
    })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.nc-notice-text').text()).toBe('<img src=x onerror="window.__ncNotice=1">')
    expect(window.__ncNotice).toBeUndefined()
  })
})
