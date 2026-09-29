// The approval card on its own (components/chat/ChatApprovalCard.vue): what
// "Allow for this session" says for Claude and Codex, the focus after "Add a
// reason" and "Show all", Codex changes with no details (the warning stays,
// Allow waits for an explicit yes), the screen-reader announcement of a new
// request and the Alt+A focus shortcut.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ChatApprovalCard, { isFocusApprovalKey } from '../components/chat/ChatApprovalCard.vue'

describe('ChatApprovalCard.vue', () => {
  let wrapper

  function row(extra = {}) {
    return { requestId: 'r1', toolName: 'Bash', displayName: 'Bash', input: { command: 'npm test' }, description: '', detail: 'npm test', hidden: 0, sessionRules: [], sessionAllowed: true, status: 'pending', ...extra }
  }

  function mountCard(props = {}) {
    wrapper = mount(ChatApprovalCard, {
      props: { row: row(), answer: vi.fn(async () => true), ...props },
      attachTo: document.body
    })
    return wrapper
  }

  afterEach(() => {
    if (wrapper) wrapper.unmount()
    wrapper = null
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  describe('Allow for this session (P1-1)', () => {
    it('Codex: says Codex stops asking, never "the same as Allow"', () => {
      mountCard({ agentId: 'codex' })
      const rules = wrapper.find('[data-test="chat-approval-rules"]')
      expect(rules.find('[data-test="chat-approval-codex-session"]').text()).toBe('Allow for this session: Codex stops asking to run this same command until the session ends.')
      expect(rules.text()).not.toContain('adds no rule')
      expect(rules.text()).not.toContain('same as Allow')
    })

    it('Codex file changes: about these files', () => {
      mountCard({ agentId: 'codex', row: row({ toolName: 'Edit', displayName: 'Edit', input: { file_path: 'a.js', changes: [{ path: 'a.js' }] } }) })
      expect(wrapper.find('[data-test="chat-approval-codex-session"]').text()).toContain('Codex stops asking to change these files')
    })

    it('without the agent, a Codex request id still gets the Codex text', () => {
      mountCard({ row: row({ requestId: 'codex_perm_3' }) })
      expect(wrapper.find('[data-test="chat-approval-codex-session"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="chat-approval-rules"]').text()).not.toContain('adds no rule')
    })

    it('Claude: lists its rules, or says it adds none', () => {
      mountCard({ agentId: 'claude', row: row({ sessionRules: [{ kind: 'rule', tool: 'Bash', content: 'npm test:*' }] }) })
      expect(wrapper.findAll('[data-test="chat-approval-rules"] li').map((li) => li.text())).toEqual(['Bash(npm test:*)'])
      wrapper.unmount()
      mountCard({ agentId: 'claude' })
      expect(wrapper.find('[data-test="chat-approval-rules"]').text()).toContain('adds no rule')
      expect(wrapper.find('[data-test="chat-approval-codex-session"]').exists()).toBe(false)
    })

    it('not offered (sessionAllowed false): no button and no explanation at all', () => {
      for (const agentId of ['codex', 'claude']) {
        mountCard({ agentId, row: row({ sessionAllowed: false }) })
        expect(wrapper.find('[data-test="chat-approve-session"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="chat-approval-rules"]').exists()).toBe(false)
        wrapper.unmount()
        wrapper = null
      }
    })
  })

  describe('focus after Add a reason and Show all (P2-5)', () => {
    it('Add a reason puts the focus in the reason field', async () => {
      mountCard()
      await wrapper.find('[data-test="chat-approve-add-reason"]').trigger('click')
      await nextTick()
      expect(document.activeElement).toBe(wrapper.find('[data-test="chat-approve-reason"]').element)
    })

    it('Show all puts the focus on the detail, which shows the whole input', async () => {
      const fetchInput = vi.fn(async () => ({ command: 'FULL COMMAND' }))
      mountCard({ fetchInput, row: row({ detail: 'npm t', hidden: 40 }) })
      await wrapper.find('[data-test="chat-approval-show-all"]').trigger('click')
      await flushPromises()
      await nextTick()
      const detail = wrapper.find('[data-test="chat-approval-detail"]')
      expect(detail.text()).toBe('FULL COMMAND')
      expect(document.activeElement).toBe(detail.element)
      expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(false)
    })

    it('a failed Show all keeps the button (and the focus) and says so', async () => {
      mountCard({ fetchInput: vi.fn(async () => null), row: row({ hidden: 40 }) })
      const btn = wrapper.find('[data-test="chat-approval-show-all"]')
      btn.element.focus()
      await btn.trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-test="chat-approval-hidden"]').text()).toContain('could not be read')
      expect(document.activeElement).toBe(wrapper.find('[data-test="chat-approval-show-all"]').element)
    })
  })

  describe('Codex changes with no details (P2-7)', () => {
    const unknown = (input = {}) => row({ requestId: 'codex_perm_1', toolName: 'Edit', displayName: 'Edit', input: { changesUnknown: true, file_path: '', changes: [], ...input }, detail: '{}', hidden: 1 })

    it('Show all neither clears the warning nor enables Allow; the explicit yes does', async () => {
      const fetchInput = vi.fn(async () => ({ changesUnknown: true, changes: [] }))
      const answer = vi.fn(async () => true)
      mountCard({ agentId: 'codex', cwd: 'C:\\proj', fetchInput, answer, row: unknown() })
      const allow = () => wrapper.find('[data-test="chat-approve-allow"]').element
      expect(wrapper.find('[data-test="chat-approval-unknown"]').text()).toContain('Codex did not say which files')
      expect(wrapper.find('[data-test="chat-approval-scope"]').text()).toBe('Allow applies it wherever Codex writes, possibly outside C:\\proj.')
      expect(wrapper.find('[data-test="chat-approval-hidden"]').text()).not.toContain('characters hidden')
      expect(allow().disabled).toBe(true)

      await wrapper.find('[data-test="chat-approval-show-all"]').trigger('click')
      await flushPromises()
      expect(fetchInput).toHaveBeenCalledTimes(1)
      expect(wrapper.find('[data-test="chat-approval-show-all"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="chat-approval-unknown"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="chat-approval-scope"]').exists()).toBe(true)
      expect(allow().disabled).toBe(true)
      expect(wrapper.find('[data-test="chat-approve-session"]').element.disabled).toBe(true)

      await wrapper.find('[data-test="chat-approval-accept-unknown"]').setValue(true)
      expect(allow().disabled).toBe(false)
      expect(wrapper.find('[data-test="chat-approval-unknown"]').exists()).toBe(true)
      await wrapper.find('[data-test="chat-approval-accept-unknown"]').setValue(false)
      expect(allow().disabled).toBe(true)
      await wrapper.find('[data-test="chat-approval-accept-unknown"]').setValue(true)
      await wrapper.find('[data-test="chat-approve-allow"]').trigger('click')
      await flushPromises()
      expect(answer).toHaveBeenCalledWith({ requestId: 'codex_perm_1', decision: 'allow', message: '' })
    })

    it('the explicit yes alone fetches the request (the main process wants it seen) and then enables Allow', async () => {
      const fetchInput = vi.fn(async () => ({ changesUnknown: true }))
      mountCard({ agentId: 'codex', fetchInput, row: unknown() })
      expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(true)
      await wrapper.find('[data-test="chat-approval-accept-unknown"]').setValue(true)
      await flushPromises()
      expect(fetchInput).toHaveBeenCalledWith({ requestId: 'codex_perm_1' })
      expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(false)
    })

    it('names the folder Codex asks to write in; keys never answer it', async () => {
      const answer = vi.fn(async () => true)
      mountCard({ agentId: 'codex', answer, row: unknown({ grantRoot: 'D:\\out' }) })
      expect(wrapper.find('[data-test="chat-approval-scope"]').text()).toBe('Codex also asks to write anywhere in D:\\out for the rest of this session.')
      const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)
      try {
        await wrapper.find('[data-test="chat-approval"]').trigger('keydown', { key: 'y' })
        await flushPromises()
      } finally {
        spy.mockRestore()
      }
      expect(answer).not.toHaveBeenCalled()
    })

    it('without a folder: says only that it applies wherever Codex writes', () => {
      mountCard({ agentId: 'codex', row: unknown() })
      expect(wrapper.find('[data-test="chat-approval-scope"]').text()).toBe('Allow applies it wherever Codex writes.')
    })

    it('an ordinary truncated input is unchanged: Show all is enough', async () => {
      mountCard({ fetchInput: vi.fn(async () => ({ command: 'x' })), row: row({ hidden: 5 }) })
      expect(wrapper.find('[data-test="chat-approval-accept-unknown"]').exists()).toBe(false)
      await wrapper.find('[data-test="chat-approval-show-all"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-test="chat-approval-hidden"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(false)
    })
  })

  describe('announcement and the focus shortcut (P2-4)', () => {
    const live = () => wrapper.find('[data-test="chat-approval-live"]')

    it('a new request is announced once, politely, after the region is in the page', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      mountCard({ agentId: 'codex' })
      expect(live().attributes('aria-live')).toBe('polite')
      expect(live().text()).toBe('')
      vi.advanceTimersByTime(200)
      await nextTick()
      expect(live().text()).toBe('Codex asks to run Bash')
      // Answered: nothing left to announce.
      await wrapper.setProps({ row: row({ status: 'allowed' }) })
      expect(live().text()).toBe('')
    })

    it('an unknown agent is "the agent"; a decided card is not announced', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      mountCard({ row: row({ displayName: 'Read', toolName: 'Read' }) })
      vi.advanceTimersByTime(200)
      await nextTick()
      expect(live().text()).toBe('The agent asks to run Read')
      wrapper.unmount()
      mountCard({ agentId: 'claude', row: row({ status: 'denied' }) })
      vi.advanceTimersByTime(200)
      await nextTick()
      expect(live().text()).toBe('')
    })

    it('a card that took the focus is not announced on top of it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      mountCard({ agentId: 'claude', autoFocus: true })
      expect(document.activeElement).toBe(wrapper.find('[data-test="chat-approval"]').element)
      vi.advanceTimersByTime(200)
      await nextTick()
      expect(live().text()).toBe('')
    })

    it('while typing in the composer: no focus taken, announced instead', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const composer = document.createElement('textarea')
      document.body.appendChild(composer)
      composer.focus()
      mountCard({ agentId: 'claude', autoFocus: true })
      expect(document.activeElement).toBe(composer)
      vi.advanceTimersByTime(200)
      await nextTick()
      expect(live().text()).toBe('Claude asks to run Bash')
    })

    it('focus() (the pane shortcut) takes the focus even from the composer', () => {
      const composer = document.createElement('textarea')
      document.body.appendChild(composer)
      composer.focus()
      mountCard({ agentId: 'claude' })
      expect(document.activeElement).toBe(composer)
      expect(wrapper.vm.focus()).toBe(true)
      expect(document.activeElement).toBe(wrapper.find('[data-test="chat-approval"]').element)
    })

    it('Alt+A is the shortcut; not with Ctrl (AltGr), Shift or another key', () => {
      expect(isFocusApprovalKey({ key: 'a', altKey: true })).toBe(true)
      expect(isFocusApprovalKey({ key: 'A', altKey: true })).toBe(true)
      expect(isFocusApprovalKey({ key: 'a', altKey: true, ctrlKey: true })).toBe(false)
      expect(isFocusApprovalKey({ key: 'A', altKey: true, shiftKey: true })).toBe(false)
      expect(isFocusApprovalKey({ key: 'a', altKey: false })).toBe(false)
      expect(isFocusApprovalKey({ key: 'q', altKey: true, code: 'KeyA' })).toBe(false)
      expect(isFocusApprovalKey(null)).toBe(false)
    })

    it('Alt+A on the card itself answers nothing', async () => {
      const answer = vi.fn(async () => true)
      mountCard({ answer })
      const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)
      try {
        await wrapper.find('[data-test="chat-approval"]').trigger('keydown', { key: 'a', altKey: true })
        await flushPromises()
      } finally {
        spy.mockRestore()
      }
      expect(answer).not.toHaveBeenCalled()
    })
  })
})
