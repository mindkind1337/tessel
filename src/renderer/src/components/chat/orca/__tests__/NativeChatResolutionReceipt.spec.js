// NativeChatResolutionReceipt (after Orca's NativeChatResolutionReceipt.test.tsx,
// MIT, Copyright (c) 2026 Lovecast Inc.), plus Tessel's approval ids worded
// at display time.
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import NativeChatResolutionReceipt from '../NativeChatResolutionReceipt.vue'
import { nativeChatReceiptAnswers } from '../../../../chat/orca/native-chat-resolution-receipt.js'
import { encodeAgentSessionQuestionAnswers } from '../../../../chat/orca/shared/agent-session-question-answer.js'
import { provideNativeChatDisclosures } from '../../../../chat/orca/composables/native-chat-disclosure-store.js'
import { intlLocale, setMessages } from '../../../../i18n'

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  setMessages('en', {})
  document.body.innerHTML = ''
})

const approval = {
  kind: 'approval',
  title: 'Run command?',
  detail: 'pnpm test',
  options: [
    { id: 'yes', label: 'Allow once' },
    { id: 'no', label: 'Deny' }
  ],
  resolution: { state: 'resolved', selectedOptionId: 'yes', resolvedBy: 'phone-client', resolvedAt: 1000 }
}

function render(body, props = {}) {
  wrapper = mount(NativeChatResolutionReceipt, { props: { body, ...props }, attachTo: document.body })
  return wrapper
}
const text = () => (wrapper.element.textContent ?? '').replace(/\s+/g, ' ')
const byText = (s) => [...wrapper.element.querySelectorAll ? wrapper.element.querySelectorAll('*') : []].filter((el) => el.children.length === 0 && el.textContent.trim() === s)

describe('resolution receipts', () => {
  it('localizes the resolved time when the UI language changes', async () => {
    render(approval)
    setMessages('fr', {})
    await nextTick()
    const time = document.querySelector('time')
    expect(time.textContent).toBe(new Intl.DateTimeFormat(intlLocale(), { hour: 'numeric', minute: '2-digit' }).format(1000))
    expect(time.getAttribute('aria-label')).toBe(new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'full', timeStyle: 'long' }).format(1000))
  })

  it.each([
    ['yes', 'Allow once'],
    ['no', 'Deny']
  ])('shows the exact selected approval label for %s', (id, label) => {
    render({ ...approval, resolution: { ...approval.resolution, selectedOptionId: id } })
    expect(byText('Run command?')).toHaveLength(1)
    expect(byText('pnpm test')).toHaveLength(1)
    expect(byText(label)).toHaveLength(1)
    expect(byText('Answered on phone-client')).toHaveLength(1)
    expect(document.querySelector('time').getAttribute('datetime')).toBe(new Date(1000).toISOString())
    expect(document.querySelector('button')).toBeNull()
  })

  it('uses the SDK display name in the compact resolved receipt', () => {
    render({ ...approval, title: 'Claude wants to present its implementation plan', displayName: 'Present plan' })
    expect(byText('Present plan')).toHaveLength(1)
    expect(text()).not.toContain('Claude wants to present its implementation plan')
  })

  it('renders cancellation quietly without inventing a choice or resolver', () => {
    render({ ...approval, resolution: { state: 'cancelled', selectedOptionId: null, resolvedBy: null, resolvedAt: null } })
    expect(byText('Cancelled')).toHaveLength(1)
    expect(text()).not.toContain('Allow once')
    expect(text()).not.toContain('Selected answer unavailable')
    expect(document.querySelector('time')).toBeNull()
  })

  it.each([null, 'unknown'])('handles absent or unknown selections (%s)', (selectedOptionId) => {
    render({ ...approval, resolution: { ...approval.resolution, selectedOptionId } })
    expect(byText('Selected answer unavailable')).toHaveLength(1)
    expect(text()).not.toContain('Allow once')
  })

  it('excludes pending prompts', () => {
    render({ ...approval, resolution: { ...approval.resolution, state: 'pending' } })
    expect(wrapper.element.textContent ?? '').toBe('')
    expect(document.querySelector('[data-native-chat-receipt]')).toBeNull()
  })

  it('reads grouped options from each question despite an empty flat options list', () => {
    const body = {
      kind: 'question',
      question: 'Choose settings',
      options: [],
      questions: [
        { id: 'q1', question: 'Features?', multiSelect: true, options: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }] },
        { id: 'q2', question: 'Name?', multiSelect: false, options: [], freeTextQuestionId: 'q2' }
      ],
      resolution: {
        ...approval.resolution,
        selectedOptionId: encodeAgentSessionQuestionAnswers([
          { questionId: 'q1', optionIds: ['a', 'b'] },
          { questionId: 'q2', optionIds: [], other: 'Custom 100% name' }
        ])
      }
    }
    render(body)
    expect(byText('Features?')).toHaveLength(1)
    expect(byText('First · Second')).toHaveLength(1)
    expect(byText('Custom 100% name')).toHaveLength(1)
    expect(text()).not.toContain('Selected answer unavailable')
    expect(nativeChatReceiptAnswers({ ...body, resolution: { ...body.resolution, selectedOptionId: 'question-group:invalid' } })).toEqual([
      { question: 'Features?', answer: null },
      { question: 'Name?', answer: null }
    ])
  })

  it('keeps a single grouped question heading distinct from its answer line', () => {
    render({
      kind: 'question',
      question: '1 grouped question from Claude',
      options: [],
      questions: [{ id: 'q1', question: 'Libraries?', multiSelect: true, options: [] }],
      resolution: { ...approval.resolution, selectedOptionId: encodeAgentSessionQuestionAnswers([{ questionId: 'q1', optionIds: [], other: 'TypeScript' }]) }
    })
    expect(text()).toContain('1 grouped question from Claude')
    expect(byText('Libraries?')).toHaveLength(1)
    expect(byText('TypeScript')).toHaveLength(1)
  })

  it('does not repeat a single question above its answer', () => {
    render({
      kind: 'question',
      question: 'Libraries?',
      options: [],
      questions: [{ id: 'q1', question: 'Libraries?', multiSelect: false, options: [] }],
      resolution: { ...approval.resolution, selectedOptionId: encodeAgentSessionQuestionAnswers([{ questionId: 'q1', optionIds: [], other: 'TypeScript' }]) }
    })
    expect(byText('Libraries?')).toHaveLength(1)
    expect(byText('TypeScript')).toHaveLength(1)
  })

  it('names the actual question while a single grouped prompt is pending', () => {
    render({
      kind: 'question',
      question: '1 grouped question from Claude',
      options: [],
      questions: [{ id: 'q1', question: 'Libraries?', multiSelect: true, options: [] }],
      resolution: { ...approval.resolution, state: 'pending', selectedOptionId: null }
    })
    expect(text()).toContain('Libraries?')
    expect(text()).not.toContain('1 grouped question from Claude')
  })

  it('keeps an opened question open once it is answered', async () => {
    const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 400 })
    const pendingBody = {
      kind: 'question',
      question: 'Which of the three migration strategies should I use?',
      options: [{ id: 'a', label: 'Strategy A' }],
      resolution: { ...approval.resolution, state: 'pending', selectedOptionId: null }
    }
    const Harness = defineComponent({
      props: { body: Object },
      setup(props) {
        provideNativeChatDisclosures()
        return () => h(NativeChatResolutionReceipt, { body: props.body, disclosureId: 'message-1' })
      }
    })
    try {
      wrapper = mount(Harness, { props: { body: pendingBody }, attachTo: document.body })
      // The row measures its line once mounted, then turns into a toggle.
      await nextTick()
      const awaiting = [...document.querySelectorAll('button')].find((b) => /Awaiting user input:/.test(b.textContent))
      awaiting.click()
      await nextTick()
      await wrapper.setProps({ body: { ...pendingBody, resolution: { ...approval.resolution, selectedOptionId: 'a' } } })
      const asked = [...document.querySelectorAll('button')].find((b) => /Asked:/.test(b.textContent))
      expect(asked.getAttribute('aria-expanded')).toBe('true')
    } finally {
      if (scrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollWidth)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth')
    }
  })

  it('decodes single free-text answers only for the declared question', () => {
    const body = {
      kind: 'question',
      question: 'Name?',
      options: [],
      freeTextQuestionId: 'name/id',
      resolution: { ...approval.resolution, selectedOptionId: 'name%2Fid:hello%20world' }
    }
    expect(nativeChatReceiptAnswers(body)).toEqual([{ question: null, answer: 'hello world' }])
    for (const selectedOptionId of ['other:hello', 'name%2Fid:%invalid']) {
      expect(nativeChatReceiptAnswers({ ...body, resolution: { ...body.resolution, selectedOptionId } })).toEqual([{ question: null, answer: null }])
    }
  })

  it('reads the recorded structured answers before the packed form', () => {
    const typed = 'Wait for the capture to finish. '.repeat(50).trim()
    const body = {
      kind: 'question',
      question: 'Name?',
      options: [{ id: 'q1:choice-1', label: 'Default' }],
      freeTextQuestionId: 'q1',
      resolution: { ...approval.resolution, selectedOptionId: 'q1:choice-1', answers: [{ questionId: 'q1', optionIds: [], other: typed }] }
    }
    expect(nativeChatReceiptAnswers(body)).toEqual([{ question: null, answer: typed }])
  })

  // Tessel: its approval ids are worded (translated) at display time, and
  // an answer given here ('local') names no device.
  it('Tessel approvals: the choice worded through t(), no "Answered on local"', () => {
    const tessel = {
      kind: 'approval',
      title: 'Bash',
      displayName: 'Bash',
      detail: 'npm test',
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'allowSession', label: 'Allow for this session' },
        { id: 'deny', label: 'Deny' }
      ],
      resolution: { state: 'resolved', selectedOptionId: 'allowSession', resolvedBy: 'local', resolvedAt: 1000 },
      tessel: { requestId: 'r1', toolName: 'Bash' }
    }
    setMessages('fr', { chat: { approval: { allowSessionButton: 'Autoriser pour cette session' } } })
    render(tessel)
    expect(byText('Autoriser pour cette session')).toHaveLength(1)
    expect(text()).not.toContain('local')
  })
})
