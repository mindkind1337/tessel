// NativeChatApprovalCard (after Orca's NativeChatApprovalCard.test.tsx, MIT,
// Copyright (c) 2026 Lovecast Inc.): the reference's cases, then every case
// of Tessel's chatApprovalCard.spec.js and the approval cases of
// chatPane.spec.js, on the journal item the adapter makes. The security
// checks are the same: Allow waits for the whole input, Codex's unknown
// changes need an explicit yes, keys wait KEY_GRACE_MS, no focus theft,
// "Allow for this session" only when offered.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import NativeChatApprovalCard from '../NativeChatApprovalCard.vue'
import { approvalAnswerSent, approvalRowFromItem, createApprovalInputFetcher, isFocusApprovalKey } from '../native-chat-approval-card.js'
import { createJournalAdapter } from '../../../../chat/orca/adapter/journalAdapter.js'
import { useStructuredAgentSession } from '../../../../chat/orca/composables/useStructuredAgentSession.js'
import { KEY_GRACE_MS } from '../../../../chat/chatModel.js'

// Lot 3's markdown (when it is there); a stand-in that shows headings as headings.
const hasMarkdown = Object.keys(import.meta.glob('../ChatMarkdown.vue')).length > 0
vi.mock('../ChatMarkdown.vue', () => ({
  default: {
    name: 'ChatMarkdown',
    props: { content: { type: String, default: '' } },
    setup(props) {
      return () =>
        h(
          'div',
          { 'data-test': 'markdown' },
          props.content.split('\n').filter(Boolean).map((line) => (line.startsWith('# ') ? h('h1', line.slice(2)) : h('p', line)))
        )
    }
  }
}))

// The journal item the adapter makes for an approval event (and its later status).
function approvalItem(ev = {}) {
  const adapter = createJournalAdapter({ now: () => 1000 })
  const out = adapter.apply({ type: 'approval', requestId: 'r1', toolName: 'Bash', displayName: 'Bash', input: { command: 'npm test' }, detail: 'npm test', hidden: 0, status: 'pending', ...ev })
  const item = out.batch.items[0]
  item.withStatus = (status) => {
    const next = adapter.apply({ type: 'approvalStatus', requestId: ev.requestId || 'r1', status })
    return next.batch.items[0]
  }
  return item
}

let wrapper = null
afterEach(() => {
  if (wrapper) wrapper.unmount()
  wrapper = null
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// A plain (reference) approval: options as the structured session gives them.
function referenceItem(body) {
  return { itemId: 'approval:x', revision: 1, body: { kind: 'approval', resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }, ...body } }
}

describe('NativeChatApprovalCard (reference)', () => {
  it('exposes cancellation while it owns the composer region', async () => {
    const onCancel = vi.fn()
    wrapper = mount(NativeChatApprovalCard, {
      props: {
        item: referenceItem({ title: 'Allow command?', detail: 'pnpm test', options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }] }),
        onCancel
      },
      attachTo: document.body
    })
    await wrapper.find('button[aria-label="Cancel"]').trigger('click')
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('focuses once on appearance and routes Escape through cancellation', async () => {
    const onCancel = vi.fn()
    const item = referenceItem({ title: 'Allow command?', options: [{ id: 'allow', label: 'Allow' }] })
    wrapper = mount(NativeChatApprovalCard, { props: { item, onCancel, shouldFocus: true }, attachTo: document.body })
    const card = wrapper.find('[role="group"][aria-label="Allow command?"]')
    expect(document.activeElement).toBe(card.element)
    await card.trigger('keydown', { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    await wrapper.setProps({ item: { ...item }, onCancel, shouldFocus: true })
    expect(document.activeElement).toBe(outside)
  })

  it('keeps all oversized provider context in one bounded scroller above the actions', () => {
    const description = `Read access outside the workspace ${'description '.repeat(400)}`
    const decisionReason = `The path is outside the allowed root. ${'reason '.repeat(400)}`
    const blockedPath = `/repo/${'nested/'.repeat(400)}secrets.txt`
    const ruleContent = `/repo/${'**/'.repeat(400)}`
    wrapper = mount(NativeChatApprovalCard, {
      props: {
        item: referenceItem({
          title: 'Claude wants to read secrets.txt '.repeat(400),
          description,
          decisionReason,
          blockedPath,
          matchedAskRule: { source: 'project', toolName: 'Read', ruleContent },
          detail: 'x'.repeat(4000),
          options: [{ id: 'allow', label: 'Allow' }]
        })
      },
      attachTo: document.body
    })
    const card = document.querySelector('[data-native-chat-approval-card="true"]')
    const content = document.querySelector('[data-native-chat-approval-content="true"]')
    const detail = document.querySelector('[data-native-chat-approval-detail="true"]')
    const actions = document.querySelector('[data-native-chat-approval-actions="true"]')
    const allow = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Allow')
    // The classes carrying min-h-0 overflow-hidden / max-h-72 overflow-auto / shrink-0.
    expect(card.classList.contains('nc-approval-card')).toBe(true)
    expect(content.classList.contains('nc-approval-content')).toBe(true)
    expect(content.getAttribute('tabindex')).toBe('0')
    expect(content.textContent).toContain(description.trim())
    expect(content.textContent).toContain(decisionReason.trim())
    expect(content.textContent).toContain(blockedPath)
    expect(content.textContent).toContain(ruleContent)
    expect(content.contains(detail)).toBe(true)
    expect(content.contains(allow)).toBe(false)
    expect(actions.contains(allow)).toBe(true)
    expect(actions.classList.contains('nc-approval-actions')).toBe(true)
  })

  it('renders a plan as markdown inside the same bounded scroller', () => {
    wrapper = mount(NativeChatApprovalCard, {
      props: {
        item: referenceItem({
          title: 'Claude wants to present its plan',
          subject: { kind: 'plan', text: '# Release plan\n\n- Run the tests', filePath: '/repo/PLAN.md' },
          detail: '{"plan":"raw json that must not be shown"}',
          options: [
            { id: 'allow', label: 'Approve plan' },
            { id: 'deny', label: 'Keep planning' }
          ]
        })
      },
      attachTo: document.body
    })
    const content = document.querySelector('[data-native-chat-approval-content="true"]')
    const plan = document.querySelector('[data-native-chat-approval-plan="true"]')
    const actions = document.querySelector('[data-native-chat-approval-actions="true"]')
    const approve = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Approve plan')
    expect(content.contains(plan)).toBe(true)
    // A document, not a payload (lot 3's markdown; plain text until it lands).
    if (hasMarkdown) expect(plan.querySelector('h1').textContent).toBe('Release plan')
    else expect(plan.textContent).toContain('# Release plan')
    expect(content.textContent).toContain('/repo/PLAN.md')
    expect(document.querySelector('[data-native-chat-approval-detail="true"]')).toBeNull()
    expect(content.textContent).not.toContain('raw json that must not be shown')
    expect(actions.contains(approve)).toBe(true)
    expect(content.contains(approve)).toBe(false)
  })
})

describe('NativeChatApprovalCard (Tessel: ChatApprovalCard cases)', () => {
  function mountCard(props = {}) {
    wrapper = mount(NativeChatApprovalCard, {
      props: { item: approvalItem(), onRespond: vi.fn(async () => ({ ok: true })), ...props },
      attachTo: document.body
    })
    return wrapper
  }

  describe('Allow for this session (P1-1)', () => {
    it('Codex: says Codex stops asking, never "the same as Allow"', () => {
      mountCard({ agentId: 'codex' })
      const rules = wrapper.find('[data-test="chat-approval-rules"]')
      expect(rules.find('[data-test="chat-approval-codex-session"]').text()).toBe('Allow for this session: Codex stops asking to run this same command until the session ends.')
      expect(rules.text()).not.toContain('adds no rule')
      expect(rules.text()).not.toContain('same as Allow')
    })

    it('Codex file changes: about these files', () => {
      mountCard({ agentId: 'codex', item: approvalItem({ toolName: 'Edit', displayName: 'Edit', input: { file_path: 'a.js', changes: [{ path: 'a.js' }] } }) })
      expect(wrapper.find('[data-test="chat-approval-codex-session"]').text()).toContain('Codex stops asking to change these files')
    })

    it('without the agent, a Codex request id still gets the Codex text', () => {
      mountCard({ item: approvalItem({ requestId: 'codex_perm_3' }) })
      expect(wrapper.find('[data-test="chat-approval-codex-session"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="chat-approval-rules"]').text()).not.toContain('adds no rule')
    })

    it('OpenCode: explains what its always patterns allow, and lists them', () => {
      mountCard({ agentId: 'opencode', item: approvalItem({ choices: ['accept', 'acceptForSession', 'decline'], sessionRules: [{ kind: 'rule', tool: 'bash', content: 'echo *' }] }) })
      const rules = wrapper.find('[data-test="chat-approval-rules"]')
      expect(rules.find('[data-test="chat-approval-opencode-session"]').text()).toContain('for every agent including sub-agents')
      expect(rules.text()).toContain('* means everything of that kind')
      expect(wrapper.findAll('[data-test="chat-approval-rules"] li').map((li) => li.text())).toEqual(['bash(echo *)'])
      wrapper.unmount()
      // Not offered (no always patterns): no session text at all.
      mountCard({ agentId: 'opencode', item: approvalItem({ choices: ['accept', 'decline'] }) })
      expect(wrapper.find('[data-test="chat-approval-rules"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="chat-approve-session"]').exists()).toBe(false)
    })

    it('Claude: lists its rules, or says it adds none', () => {
      mountCard({ agentId: 'claude', item: approvalItem({ sessionRules: [{ kind: 'rule', tool: 'Bash', content: 'npm test:*' }] }) })
      expect(wrapper.findAll('[data-test="chat-approval-rules"] li').map((li) => li.text())).toEqual(['Bash(npm test:*)'])
      wrapper.unmount()
      mountCard({ agentId: 'claude' })
      expect(wrapper.find('[data-test="chat-approval-rules"]').text()).toContain('adds no rule')
      expect(wrapper.find('[data-test="chat-approval-codex-session"]').exists()).toBe(false)
    })

    it('not offered (the agent\'s choices leave it out): no button, no explanation, the A key does nothing', async () => {
      for (const agentId of ['codex', 'claude']) {
        const onRespond = vi.fn(async () => ({ ok: true }))
        mountCard({ agentId, onRespond, item: approvalItem({ choices: ['accept', 'decline'] }) })
        expect(wrapper.find('[data-test="chat-approve-session"]').exists()).toBe(false)
        expect(wrapper.find('[data-test="chat-approval-rules"]').exists()).toBe(false)
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)
        await wrapper.find('[data-test="chat-approval"]').trigger('keydown', { key: 'a' })
        await flushPromises()
        vi.restoreAllMocks()
        expect(onRespond).not.toHaveBeenCalled()
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
      mountCard({ fetchInput, item: approvalItem({ detail: 'npm t', hidden: 40 }) })
      await wrapper.find('[data-test="chat-approval-show-all"]').trigger('click')
      await flushPromises()
      await nextTick()
      const detail = wrapper.find('[data-test="chat-approval-detail"]')
      expect(detail.text()).toBe('FULL COMMAND')
      expect(document.activeElement).toBe(detail.element)
      expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(false)
    })

    it('a failed Show all keeps the button (and the focus) and says so', async () => {
      mountCard({ fetchInput: vi.fn(async () => null), item: approvalItem({ hidden: 40 }) })
      const btn = wrapper.find('[data-test="chat-approval-show-all"]')
      btn.element.focus()
      await btn.trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-test="chat-approval-hidden"]').text()).toContain('could not be read')
      expect(document.activeElement).toBe(wrapper.find('[data-test="chat-approval-show-all"]').element)
      expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(true)
    })
  })

  describe('Codex changes with no details (P2-7)', () => {
    const unknown = (input = {}) =>
      approvalItem({ requestId: 'codex_perm_1', toolName: 'Edit', displayName: 'Edit', input: { changesUnknown: true, file_path: '', changes: [], ...input }, detail: '{}', hidden: 1 })

    it('Show all neither clears the warning nor enables Allow; the explicit yes does', async () => {
      const fetchInput = vi.fn(async () => ({ changesUnknown: true, changes: [] }))
      const onRespond = vi.fn(async () => ({ ok: true }))
      const item = unknown()
      mountCard({ agentId: 'codex', cwd: 'C:\\proj', fetchInput, onRespond, item })
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
      // A click on the disabled button still answers nothing.
      await wrapper.find('[data-test="chat-approve-allow"]').trigger('click')
      await flushPromises()
      expect(onRespond).not.toHaveBeenCalled()

      await wrapper.find('[data-test="chat-approval-accept-unknown"]').setValue(true)
      expect(allow().disabled).toBe(false)
      expect(wrapper.find('[data-test="chat-approval-unknown"]').exists()).toBe(true)
      await wrapper.find('[data-test="chat-approval-accept-unknown"]').setValue(false)
      expect(allow().disabled).toBe(true)
      await wrapper.find('[data-test="chat-approval-accept-unknown"]').setValue(true)
      await wrapper.find('[data-test="chat-approve-allow"]').trigger('click')
      await flushPromises()
      expect(onRespond).toHaveBeenCalledWith(item, { kind: 'option', optionId: 'allow' }, { message: '' })
    })

    it('the explicit yes alone fetches the request (the main process wants it seen) and then enables Allow', async () => {
      const fetchInput = vi.fn(async () => ({ changesUnknown: true }))
      mountCard({ agentId: 'codex', fetchInput, item: unknown() })
      expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(true)
      await wrapper.find('[data-test="chat-approval-accept-unknown"]').setValue(true)
      await flushPromises()
      expect(fetchInput).toHaveBeenCalledWith({ requestId: 'codex_perm_1' })
      expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(false)
    })

    it('the explicit yes without the fetch (it failed) leaves Allow disabled', async () => {
      const fetchInput = vi.fn(async () => null)
      mountCard({ agentId: 'codex', fetchInput, item: unknown() })
      await wrapper.find('[data-test="chat-approval-accept-unknown"]').setValue(true)
      await flushPromises()
      expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(true)
      expect(wrapper.find('[data-test="chat-approval-hidden"]').text()).toContain('could not be read')
    })

    it('names the folder Codex asks to write in; keys never answer it', async () => {
      const onRespond = vi.fn(async () => ({ ok: true }))
      mountCard({ agentId: 'codex', onRespond, item: unknown({ grantRoot: 'D:\\out' }) })
      expect(wrapper.find('[data-test="chat-approval-scope"]').text()).toBe('Codex also asks to write anywhere in D:\\out for the rest of this session.')
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)
      await wrapper.find('[data-test="chat-approval"]').trigger('keydown', { key: 'y' })
      await flushPromises()
      expect(onRespond).not.toHaveBeenCalled()
    })

    it('without a folder: says only that it applies wherever Codex writes', () => {
      mountCard({ agentId: 'codex', item: unknown() })
      expect(wrapper.find('[data-test="chat-approval-scope"]').text()).toBe('Allow applies it wherever Codex writes.')
    })

    it('an ordinary truncated input is unchanged: Show all is enough', async () => {
      mountCard({ fetchInput: vi.fn(async () => ({ command: 'x' })), item: approvalItem({ hidden: 5 }) })
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
      const item = approvalItem()
      mountCard({ agentId: 'codex', item })
      expect(live().attributes('aria-live')).toBe('polite')
      expect(live().text()).toBe('')
      vi.advanceTimersByTime(200)
      await nextTick()
      expect(live().text()).toBe('Codex asks to run Bash')
      // Answered: nothing left to announce.
      await wrapper.setProps({ item: item.withStatus('allowed') })
      expect(live().text()).toBe('')
    })

    it('an unknown agent is "the agent"; a decided card is not announced', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      mountCard({ item: approvalItem({ displayName: 'Read', toolName: 'Read' }) })
      vi.advanceTimersByTime(200)
      await nextTick()
      expect(live().text()).toBe('The agent asks to run Read')
      wrapper.unmount()
      mountCard({ agentId: 'claude', item: approvalItem({ status: 'denied' }) })
      vi.advanceTimersByTime(200)
      await nextTick()
      expect(live().text()).toBe('')
    })

    it('a card that took the focus is not announced on top of it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      mountCard({ agentId: 'claude', shouldFocus: true })
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
      mountCard({ agentId: 'claude', shouldFocus: true })
      expect(document.activeElement).toBe(composer)
      vi.advanceTimersByTime(200)
      await nextTick()
      expect(live().text()).toBe('Claude asks to run Bash')
    })

    it('the TipTap composer (contenteditable) keeps the focus too, even when shouldFocus turns on later', async () => {
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      editor.tabIndex = 0
      document.body.appendChild(editor)
      editor.focus()
      mountCard({ agentId: 'claude', shouldFocus: false })
      await wrapper.setProps({ shouldFocus: true })
      expect(document.activeElement).toBe(editor)
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
      const onRespond = vi.fn(async () => ({ ok: true }))
      mountCard({ onRespond })
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)
      await wrapper.find('[data-test="chat-approval"]').trigger('keydown', { key: 'a', altKey: true })
      await flushPromises()
      expect(onRespond).not.toHaveBeenCalled()
    })
  })

  describe('answering', () => {
    it('keys wait KEY_GRACE_MS after the card appears', async () => {
      const onRespond = vi.fn(async () => ({ ok: true }))
      const start = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(start)
      mountCard({ onRespond })
      const card = wrapper.find('[data-test="chat-approval"]')
      Date.now.mockReturnValue(start + KEY_GRACE_MS - 1)
      await card.trigger('keydown', { key: 'y' })
      await flushPromises()
      expect(onRespond).not.toHaveBeenCalled()
      Date.now.mockReturnValue(start + KEY_GRACE_MS)
      await card.trigger('keydown', { key: 'y' })
      await flushPromises()
      expect(onRespond).toHaveBeenCalledWith(expect.anything(), { kind: 'option', optionId: 'allow' }, { message: '' })
    })

    it('an answer not taken ({ ok: false }, nothing, a throw) brings the buttons back; a taken one keeps them disabled', async () => {
      const THROW = Symbol('throw')
      for (const result of [{ ok: false, error: 'x' }, null, undefined, false, THROW]) {
        const onRespond = vi.fn(async () => {
          if (result === THROW) throw new Error('pipe')
          return result
        })
        mountCard({ onRespond })
        await wrapper.find('[data-test="chat-approve-allow"]').trigger('click')
        await flushPromises()
        expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(false)
        wrapper.unmount()
        wrapper = null
      }
      mountCard()
      await wrapper.find('[data-test="chat-approve-allow"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(true)
      expect(wrapper.find('[data-test="chat-approve-deny"]').element.disabled).toBe(true)
    })

    it('a new request in the same card starts over: its hidden input is unseen again', async () => {
      const fetchInput = vi.fn(async () => ({ command: 'FULL' }))
      mountCard({ fetchInput, item: approvalItem({ hidden: 40 }) })
      await wrapper.find('[data-test="chat-approval-show-all"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(false)
      await wrapper.setProps({ item: approvalItem({ requestId: 'r2', hidden: 40, detail: 'other' }) })
      expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(true)
      expect(wrapper.find('[data-test="chat-approval-detail"]').text()).toBe('other')
    })

    it('an input fetched for an earlier request never shows on the next one', async () => {
      let resolve
      const fetchInput = vi.fn(() => new Promise((r) => (resolve = r)))
      mountCard({ fetchInput, item: approvalItem({ hidden: 40 }) })
      await wrapper.find('[data-test="chat-approval-show-all"]').trigger('click')
      await wrapper.setProps({ item: approvalItem({ requestId: 'r2', hidden: 40, detail: 'second' }) })
      resolve({ command: 'FIRST FULL' })
      await flushPromises()
      expect(wrapper.find('[data-test="chat-approval-detail"]').text()).toBe('second')
      expect(wrapper.find('[data-test="chat-approve-allow"]').element.disabled).toBe(true)
    })

    it('Escape without a cancel handler does nothing; from the reason field it never cancels', async () => {
      const onCancel = vi.fn()
      mountCard({ onCancel })
      await wrapper.find('[data-test="chat-approve-add-reason"]').trigger('click')
      await wrapper.find('[data-test="chat-approve-reason"]').trigger('keydown', { key: 'Escape' })
      expect(onCancel).not.toHaveBeenCalled()
      await wrapper.find('[data-test="chat-approval"]').trigger('keydown', { key: 'Escape' })
      expect(onCancel).toHaveBeenCalledOnce()
    })
  })

  it('helpers: the row from an item, the answer taken, the input fetcher', async () => {
    const row = approvalRowFromItem(approvalItem({ hidden: 3, sessionRules: [{ kind: 'rule', tool: 'Bash', content: 'x' }, { kind: 'bogus' }] }))
    expect(row).toMatchObject({ requestId: 'r1', toolName: 'Bash', hidden: 3, sessionAllowed: true, status: 'pending' })
    expect(row.sessionRules).toEqual([{ kind: 'rule', tool: 'Bash', content: 'x' }])
    expect(approvalRowFromItem(approvalItem().withStatus('allowedSession')).status).toBe('allowedSession')
    expect(approvalRowFromItem(approvalItem().withStatus('cancelled')).status).toBe('cancelled')
    expect(approvalAnswerSent({ ok: true })).toBe(true)
    expect(approvalAnswerSent(true)).toBe(true)
    for (const r of [null, undefined, false, {}, { ok: false }, { ok: 'yes' }]) expect(approvalAnswerSent(r)).toBe(false)
    const api = { approvalInput: vi.fn(async () => ({ ok: true, input: { command: 'x' } })) }
    expect(await createApprovalInputFetcher('c1', api)({ requestId: 'r1' })).toEqual({ command: 'x' })
    expect(api.approvalInput).toHaveBeenCalledWith({ paneId: 'c1', requestId: 'r1' })
    api.approvalInput.mockResolvedValueOnce({ ok: false })
    expect(await createApprovalInputFetcher('c1', api)({ requestId: 'r1' })).toBe(null)
    api.approvalInput.mockRejectedValueOnce(new Error('x'))
    expect(await createApprovalInputFetcher('c1', api)({ requestId: 'r1' })).toBe(null)
    expect(await createApprovalInputFetcher('c1', null)({ requestId: 'r1' })).toBe(null)
  })
})

// The pane's wiring, as the lead does it: the session's approval items, each
// a card fed with respond() and the approvalInput fetcher, Alt+A on the pane.
describe('NativeChatApprovalCard in a pane (chatPane.spec approval cases)', () => {
  let api, listeners
  function emit(event, { paneId = 'c1', seq } = {}) {
    for (const cb of listeners) cb({ paneId, seq, event })
  }
  async function mountPane({ agentId = 'claude' } = {}) {
    listeners = []
    api = {
      history: vi.fn(async () => ({ ok: true, events: [], seq: 0, open: true })),
      onEvent: vi.fn((cb) => {
        listeners.push(cb)
        return () => (listeners = listeners.filter((l) => l !== cb))
      }),
      approve: vi.fn(async () => ({ ok: true })),
      approvalInput: vi.fn(async () => ({ ok: true, input: { command: 'FULL COMMAND' } }))
    }
    const Pane = defineComponent({
      setup() {
        const session = useStructuredAgentSession({ paneId: 'c1', api })
        session.load()
        const draft = ref('')
        const cards = new Map()
        const approvals = computed(() => session.journalItems.value.filter((i) => i.body.kind === 'approval'))
        const pending = computed(() => session.prompts.value.find((p) => p.body.kind === 'approval') || null)
        const fetchInput = createApprovalInputFetcher('c1', api)
        function onKeydown(e) {
          if (!isFocusApprovalKey(e) || !pending.value) return
          e.preventDefault()
          e.stopPropagation()
          const card = cards.get(pending.value.itemId)
          if (card) card.focus()
        }
        return () =>
          h('div', { onKeydown }, [
            h('textarea', { 'data-test': 'chat-input', value: draft.value, onInput: (e) => (draft.value = e.target.value) }),
            ...approvals.value.map((item) =>
              h(NativeChatApprovalCard, {
                key: item.itemId,
                ref: (el) => (el ? cards.set(item.itemId, el) : cards.delete(item.itemId)),
                item,
                agentId,
                cwd: 'C:\\proj',
                shouldFocus: !draft.value.trim(),
                fetchInput,
                onRespond: session.respond
              })
            )
          ])
      }
    })
    wrapper = mount(Pane, { attachTo: document.body })
    await flushPromises()
  }

  it('approval buttons and keys answer with the right decision; a decided card is disabled', async () => {
    await mountPane()
    const ask = (requestId) => ({ type: 'approval', requestId, toolName: 'Bash', displayName: 'Bash', input: { command: 'rm x' }, description: 'Remove x', status: 'pending' })
    emit({ type: 'status', state: 'approval' })
    emit(ask('r1'))
    await nextTick()
    let card = wrapper.find('[data-test="chat-approval"]')
    expect(card.text()).toContain('Allow Bash?')
    expect(card.find('[data-test="chat-approval-detail"]').text()).toBe('rm x')
    await card.find('[data-test="chat-approve-session"]').trigger('click')
    await flushPromises()
    expect(api.approve).toHaveBeenLastCalledWith({ paneId: 'c1', requestId: 'r1', decision: 'allowSession' })
    emit({ type: 'approvalStatus', requestId: 'r1', status: 'allowedSession' })
    await nextTick()
    card = wrapper.findAll('[data-test="chat-approval"]')[0]
    expect(card.find('[data-test="chat-approve-allow"]').exists()).toBe(false)
    expect(card.find('[data-test="chat-approval-decided"]').text()).toBe('Allowed for this session')

    emit(ask('r2'))
    await nextTick()
    card = wrapper.findAll('[data-test="chat-approval"]')[1]
    // Right after it appeared, a key is typing meant elsewhere: no answer.
    await card.trigger('keydown', { key: 'y' })
    await flushPromises()
    expect(api.approve).toHaveBeenCalledTimes(1)
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
    try {
      await card.trigger('keydown', { key: 'y' })
      await flushPromises()
    } finally {
      spy.mockRestore()
    }
    expect(api.approve).toHaveBeenLastCalledWith({ paneId: 'c1', requestId: 'r2', decision: 'allow' })

    emit(ask('r3'))
    await nextTick()
    card = wrapper.findAll('[data-test="chat-approval"]')[2]
    await card.find('[data-test="chat-approve-add-reason"]').trigger('click')
    await card.find('[data-test="chat-approve-reason"]').setValue('not now')
    // Typing in the reason is not an answer.
    await card.find('[data-test="chat-approve-reason"]').trigger('keydown', { key: 'n' })
    expect(api.approve).toHaveBeenCalledTimes(2)
    await card.find('[data-test="chat-approve-deny"]').trigger('click')
    await flushPromises()
    expect(api.approve).toHaveBeenLastCalledWith({ paneId: 'c1', requestId: 'r3', decision: 'deny', message: 'not now' })
  })

  it('a truncated input: hidden count shown, Allow and the keys wait until Show all fetched the whole input', async () => {
    await mountPane()
    emit({ type: 'status', state: 'approval' })
    emit({ type: 'approval', requestId: 'big', toolName: 'Bash', displayName: 'Bash', input: { command: 'x' }, detail: 'echo safe', hidden: 12345, status: 'pending' })
    await nextTick()
    const card = wrapper.find('[data-test="chat-approval"]')
    expect(card.find('[data-test="chat-approval-detail"]').text()).toBe('echo safe')
    expect(card.find('[data-test="chat-approval-hidden"]').text()).toContain('12345 characters hidden')
    expect(card.find('[data-test="chat-approve-allow"]').element.disabled).toBe(true)
    expect(card.find('[data-test="chat-approve-session"]').element.disabled).toBe(true)
    expect(card.find('[data-test="chat-approve-deny"]').element.disabled).toBe(false)
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)
    try {
      await card.trigger('keydown', { key: 'y' })
      await card.trigger('keydown', { key: 'n' })
      await flushPromises()
      expect(api.approve).not.toHaveBeenCalled()
      await card.find('[data-test="chat-approval-show-all"]').trigger('click')
      await flushPromises()
      expect(api.approvalInput).toHaveBeenCalledWith({ paneId: 'c1', requestId: 'big' })
      expect(card.find('[data-test="chat-approval-detail"]').text()).toBe('FULL COMMAND')
      expect(card.find('[data-test="chat-approval-hidden"]').exists()).toBe(false)
      expect(card.find('[data-test="chat-approve-allow"]').element.disabled).toBe(false)
      // Still no single-key answers on that card.
      await card.trigger('keydown', { key: 'y' })
      await flushPromises()
      expect(api.approve).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
    await card.find('[data-test="chat-approve-allow"]').trigger('click')
    await flushPromises()
    expect(api.approve).toHaveBeenLastCalledWith({ paneId: 'c1', requestId: 'big', decision: 'allow' })
  })

  it('Codex: changes unknown wait for Show all; an MCP card says it is not sandboxed', async () => {
    await mountPane({ agentId: 'codex' })
    emit({ type: 'approval', requestId: 'fu', toolName: 'Edit', input: { grantRoot: 'C:\\x', changesUnknown: true, file_path: '', changes: [] }, detail: '{ "grantRoot": "C:\\x" }', hidden: 1, status: 'pending' })
    emit({ type: 'approval', requestId: 'mc', toolName: 'MCP', displayName: 'MCP files', input: { server: 'files', message: 'Run delete_all?' }, detail: 'x', hidden: 0, choices: ['accept', 'decline'], status: 'pending' })
    await nextTick()
    const [fu, mc] = wrapper.findAll('[data-test="chat-approval"]')
    expect(fu.find('[data-test="chat-approval-hidden"]').text()).toContain('Changes unknown')
    expect(fu.find('[data-test="chat-approval-hidden"]').text()).not.toContain('characters hidden')
    expect(fu.find('[data-test="chat-approve-allow"]').element.disabled).toBe(true)
    expect(fu.find('[data-test="chat-approval-mcp"]').exists()).toBe(false)
    expect(mc.find('[data-test="chat-approval-mcp"]').text()).toContain('outside the sandbox')
    expect(mc.find('[data-test="chat-approve-allow"]').element.disabled).toBe(false)
    // Codex's choices leave "for this session" out on the MCP card.
    expect(mc.find('[data-test="chat-approve-session"]').exists()).toBe(false)
  })

  it('no MCP warning on a card that is not an MCP tool (Claude)', async () => {
    await mountPane()
    emit({ type: 'approval', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, status: 'pending' })
    await nextTick()
    expect(wrapper.find('[data-test="chat-approval-mcp"]').exists()).toBe(false)
  })

  it('the card lists what Allow for this session adds', async () => {
    await mountPane()
    emit({
      type: 'approval',
      requestId: 'r1',
      toolName: 'Bash',
      input: { command: 'npm test' },
      sessionRules: [{ kind: 'rule', tool: 'Bash', content: 'npm test:*' }, { kind: 'mode', mode: 'acceptEdits' }, { kind: 'directories', directories: ['C:\\other'] }],
      status: 'pending'
    })
    emit({ type: 'approval', requestId: 'r2', toolName: 'Read', input: { file_path: 'a' }, status: 'pending' })
    await nextTick()
    const [one, two] = wrapper.findAll('[data-test="chat-approval-rules"]')
    const items = one.findAll('li').map((li) => li.text())
    expect(items).toEqual(['Bash(npm test:*)', 'Switch this session to the acceptEdits mode', 'Give access to C:\\other'])
    expect(two.text()).toContain('adds no rule')
  })

  it('a new approval never takes the focus from the composer', async () => {
    await mountPane()
    const input = wrapper.find('[data-test="chat-input"]').element
    input.focus()
    expect(document.activeElement).toBe(input)
    emit({ type: 'approval', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, status: 'pending' })
    await nextTick()
    await flushPromises()
    expect(document.activeElement).toBe(input)
  })

  it('Alt+A goes to the pending request, even from the composer; nothing happens by itself while typing', async () => {
    await mountPane()
    const input = wrapper.find('[data-test="chat-input"]')
    input.element.focus()
    await input.setValue('typing')
    // No request: the key is left alone.
    const idle = new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true, cancelable: true })
    input.element.dispatchEvent(idle)
    expect(idle.defaultPrevented).toBe(false)

    emit({ type: 'status', state: 'approval' })
    emit({ type: 'approval', requestId: 'r1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' }, status: 'pending' })
    await flushPromises()
    expect(document.activeElement).toBe(input.element)
    const ev = new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true, cancelable: true })
    input.element.dispatchEvent(ev)
    await flushPromises()
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(wrapper.find('[data-test="chat-approval"]').element)
    expect(api.approve).not.toHaveBeenCalled()
    emit({ type: 'approvalStatus', requestId: 'r1', status: 'allowed' })
    await nextTick()
    const after = new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true, cancelable: true })
    input.element.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })
})
