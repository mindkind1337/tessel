// The chat pane (components/chat/ChatPane.vue) with a fake
// window.shellApi.chat: the history redrawn, events for this pane only,
// sending (a refused message stays as "Not sent"), Send waiting while the
// agent starts, a history that could not be read, interrupting, answering
// approvals (Alt+A goes to the request), the live region, the model menu,
// and the signed-out / untrusted / stopped states with "Start again".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import ChatPane from '../components/chat/ChatPane.vue'

describe('ChatPane.vue', () => {
  let wrapper, ctx, api, node, listeners, prevApi, history

  function emit(event, { paneId = 'c1', seq } = {}) {
    for (const cb of listeners) cb({ paneId, seq, event })
  }

  async function mountPane(extraNode = {}, extraCtx = {}) {
    node = reactive({
      type: 'leaf',
      kind: 'chat',
      id: 'c1',
      title: 'Claude',
      num: 3,
      agentId: 'claude',
      cwd: 'C:\\proj',
      projectDir: 'C:\\proj',
      sessionId: null,
      model: null,
      effort: null,
      team: null,
      ...extraNode
    })
    Object.assign(ctx, extraCtx)
    wrapper = mount(ChatPane, {
      props: { node },
      attachTo: document.body,
      global: { provide: { panelCtx: ctx } }
    })
    await flushPromises()
    await nextTick()
  }

  beforeEach(() => {
    listeners = []
    history = { ok: true, events: [], seq: 0, open: true, live: { status: 'idle' } }
    api = {
      history: vi.fn(async () => history),
      onEvent: vi.fn((cb) => {
        listeners.push(cb)
        return () => {
          listeners = listeners.filter((l) => l !== cb)
        }
      }),
      send: vi.fn(async () => ({ ok: true, id: 'u9' })),
      interrupt: vi.fn(async () => ({ ok: true })),
      approve: vi.fn(async () => ({ ok: true })),
      approvalInput: vi.fn(async () => ({ ok: true, input: { command: 'FULL COMMAND' } })),
      setOption: vi.fn(async () => ({ ok: true }))
    }
    prevApi = window.shellApi
    window.shellApi = { chat: api, openExternal: vi.fn() }
    ctx = {
      activeId: ref('c1'),
      maximizedId: ref(null),
      highlightId: ref(null),
      setActive: vi.fn(),
      closeLeaf: vi.fn(),
      toggleMaximize: vi.fn(),
      beginPaneDrag: vi.fn(),
      toast: vi.fn(),
      copied: vi.fn(),
      chatOpen: vi.fn(async () => ({ ok: true, sessionId: 's-new' })),
      chatPermissions: () => 'manual'
    }
  })

  afterEach(() => {
    if (wrapper) wrapper.unmount()
    wrapper = null
    window.shellApi = prevApi
  })

  it('redraws the history on mount and does not reopen a running session', async () => {
    history = {
      ok: true,
      open: true,
      seq: 5,
      events: [
        { seq: 1, event: { type: 'status', state: 'idle', model: 'claude-sonnet-4-6', sessionId: 's1' } },
        { seq: 2, event: { type: 'user', id: 'u1', text: 'hello', origin: 'user', status: 'accepted' } },
        { seq: 3, event: { type: 'assistant', messageId: 'm1', text: 'Hi **there**' } },
        { seq: 4, event: { type: 'tool', id: 't1', name: 'Read', input: { file_path: 'C:\\proj\\src\\x.js' }, status: 'done' } },
        { seq: 5, event: { type: 'turnEnd', status: 'completed', durationMs: 2000 } }
      ]
    }
    await mountPane()
    expect(api.history).toHaveBeenCalledWith({ paneId: 'c1' })
    expect(ctx.chatOpen).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="chat-user"]').text()).toContain('hello')
    expect(wrapper.find('[data-test="chat-assistant"]').html()).toContain('<strong>there</strong>')
    expect(wrapper.find('[data-test="chat-tool"]').text()).toContain('Read')
    expect(wrapper.find('[data-test="chat-tool"]').text()).toContain('src/x.js')
    expect(wrapper.find('[data-test="chat-status"]').text()).toBe('Idle')
    expect(node.sessionId).toBe('s1')
    expect(node.model).toBe('claude-sonnet-4-6')
    // An event the history already had (seq <= 5) is dropped.
    emit({ type: 'notice', kind: 'info', text: 'old' }, { seq: 5 })
    await nextTick()
    expect(wrapper.find('[data-test="chat-notice"]').exists()).toBe(false)
  })

  it('opens the session through the app when it is not running', async () => {
    history = { ok: true, events: [], seq: 0 }
    await mountPane()
    expect(ctx.chatOpen).toHaveBeenCalledWith(node)
    expect(node.sessionId).toBe('s-new')
    expect(wrapper.find('[data-test="chat-status"]').text()).toBe('Idle')
  })

  it('shows only the events of its own pane; streams and tool output as text', async () => {
    await mountPane()
    emit({ type: 'status', state: 'working' })
    emit({ type: 'assistantDelta', messageId: 'm1', text: 'Work' }, { paneId: 'other' })
    emit({ type: 'assistantDelta', messageId: 'm1', text: 'ing on it' })
    emit({ type: 'tool', id: 't1', name: 'Bash', input: { command: 'npm test' }, status: 'running' })
    emit({ type: 'toolResult', id: 't1', isError: false, text: '<b>not html</b>' })
    await nextTick()
    expect(wrapper.findAll('[data-test="chat-assistant"]')).toHaveLength(1)
    expect(wrapper.find('[data-test="chat-assistant"]').text()).toBe('ing on it')
    expect(wrapper.find('[data-test="chat-status"]').text()).toBe('Working')
    const tool = wrapper.find('[data-test="chat-tool"]')
    expect(tool.text()).toContain('npm test')
    await tool.find('button').trigger('click')
    const out = wrapper.find('[data-test="chat-tool-output"]')
    expect(out.text()).toBe('<b>not html</b>')
    expect(out.find('b').exists()).toBe(false)
  })

  it('Enter sends, Shift+Enter does not', async () => {
    await mountPane()
    const input = wrapper.find('[data-test="chat-input"]')
    await input.setValue('run the tests')
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(api.send).not.toHaveBeenCalled()
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(api.send).toHaveBeenCalledWith({ paneId: 'c1', text: 'run the tests' })
    expect(input.element.value).toBe('')
    expect(wrapper.find('[data-test="chat-unsent"]').exists()).toBe(false)
  })

  it('a refused message stays as "Not sent" (copy, retry, discard); what was typed since is kept', async () => {
    await mountPane()
    window.shellApi.writeClipboard = vi.fn()
    const input = wrapper.find('[data-test="chat-input"]')
    let resolveA
    api.send.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveA = r
        })
    )
    await input.setValue('message A')
    await input.trigger('keydown', { key: 'Enter' })
    expect(input.element.value).toBe('')
    // B is typed while A is on its way; A is refused.
    await input.setValue('draft B')
    resolveA({ ok: false, error: 'no session' })
    await flushPromises()
    expect(input.element.value).toBe('draft B')
    let entries = wrapper.findAll('[data-test="chat-unsent"]')
    expect(entries).toHaveLength(1)
    expect(entries[0].text()).toContain('Not sent')
    expect(entries[0].find('[data-test="chat-unsent-text"]').text()).toBe('message A')
    expect(entries[0].find('[data-test="chat-unsent-error"]').text()).toBe('no session')
    expect(ctx.toast).toHaveBeenCalledWith('Message not sent: no session', expect.any(Object))

    await entries[0].find('[data-test="chat-unsent-copy"]').trigger('click')
    await flushPromises()
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith('message A')
    expect(ctx.copied).toHaveBeenCalledWith('Message')

    // Retry takes the same path; refused again (a throw), it stays once.
    api.send.mockRejectedValueOnce(new Error('pipe closed'))
    await entries[0].find('[data-test="chat-unsent-retry"]').trigger('click')
    await flushPromises()
    entries = wrapper.findAll('[data-test="chat-unsent"]')
    expect(entries).toHaveLength(1)
    expect(entries[0].find('[data-test="chat-unsent-error"]').text()).toBe('pipe closed')
    await entries[0].find('[data-test="chat-unsent-retry"]').trigger('click')
    await flushPromises()
    expect(api.send).toHaveBeenLastCalledWith({ paneId: 'c1', text: 'message A' })
    expect(wrapper.find('[data-test="chat-unsent"]').exists()).toBe(false)
    expect(input.element.value).toBe('draft B')

    // Discard drops it without sending.
    api.send.mockResolvedValueOnce({ ok: false })
    await input.setValue('message C')
    await wrapper.find('[data-test="chat-send"]').trigger('click')
    await flushPromises()
    entries = wrapper.findAll('[data-test="chat-unsent"]')
    expect(entries[0].find('[data-test="chat-unsent-error"]').text()).toBe('unknown error')
    const calls = api.send.mock.calls.length
    entries[0].find('[data-test="chat-unsent-discard"]').element.focus()
    await entries[0].find('[data-test="chat-unsent-discard"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="chat-unsent"]').exists()).toBe(false)
    expect(api.send.mock.calls.length).toBe(calls)
    // The focus went back to typing.
    expect(document.activeElement).toBe(input.element)
  })

  it('Send waits while the agent starts (typing works); not while asleep or waking from sleep', async () => {
    history = { ok: true, events: [], seq: 0 }
    let opened
    ctx.chatOpen = vi.fn(
      () =>
        new Promise((r) => {
          opened = r
        })
    )
    await mountPane()
    expect(wrapper.find('[data-test="chat-status"]').text()).toBe('Starting')
    const input = wrapper.find('[data-test="chat-input"]')
    expect(input.element.disabled).toBe(false)
    await input.setValue('early')
    const sendBtn = wrapper.find('[data-test="chat-send"]')
    expect(sendBtn.element.disabled).toBe(true)
    expect(sendBtn.attributes('title')).toBe('Wait until Claude has started')
    expect(wrapper.find('[data-test="chat-send-blocked"]').text()).toBe('Wait until Claude has started')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(api.send).not.toHaveBeenCalled()
    expect(input.element.value).toBe('early')
    opened({ ok: true })
    await flushPromises()
    expect(sendBtn.element.disabled).toBe(false)
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(api.send).toHaveBeenCalledWith({ paneId: 'c1', text: 'early' })

    // Asleep, then waking up: the message waits in the main process.
    emit({ type: 'status', state: 'asleep' })
    await nextTick()
    await input.setValue('wake up')
    expect(sendBtn.element.disabled).toBe(false)
    emit({ type: 'status', state: 'starting' })
    await nextTick()
    expect(sendBtn.element.disabled).toBe(false)
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(api.send).toHaveBeenLastCalledWith({ paneId: 'c1', text: 'wake up' })
  })

  it('a history that could not be read: an explicit state with Retry, no empty chat, no start', async () => {
    api.history.mockRejectedValueOnce(new Error('journal locked'))
    await mountPane()
    const box = wrapper.find('[data-test="chat-history-error"]')
    expect(box.text()).toContain('Could not load the conversation')
    expect(box.text()).toContain('journal locked')
    expect(wrapper.find('[data-test="chat-empty"]').text()).not.toContain('Send a message to start.')
    expect(wrapper.find('[data-test="chat-empty"]').text()).not.toContain('Starting')
    expect(ctx.chatOpen).not.toHaveBeenCalled()
    await wrapper.find('[data-test="chat-input"]').setValue('hi')
    expect(wrapper.find('[data-test="chat-send"]').element.disabled).toBe(true)
    // Live events wait for the history.
    emit({ type: 'notice', kind: 'info', text: 'later' }, { seq: 3 })
    await nextTick()
    expect(wrapper.find('[data-test="chat-notice"]').exists()).toBe(false)

    history = { ok: true, seq: 2, events: [{ seq: 2, event: { type: 'user', id: 'u1', text: 'before', origin: 'user', status: 'accepted' } }] }
    await wrapper.find('[data-test="chat-history-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="chat-history-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="chat-user"]').text()).toContain('before')
    expect(wrapper.find('[data-test="chat-notice"]').text()).toContain('later')
    // Not running: opened once the history is drawn.
    expect(ctx.chatOpen).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-test="chat-send"]').element.disabled).toBe(false)
  })

  it('a history refused by the main process ({ ok: false }) says so too', async () => {
    api.history.mockResolvedValueOnce({ ok: false, error: 'invalid pane' })
    await mountPane()
    expect(wrapper.find('[data-test="chat-history-error"]').text()).toContain('invalid pane')
    expect(ctx.chatOpen).not.toHaveBeenCalled()
  })

  it('a queued message shows its chip; team messages are set apart', async () => {
    await mountPane()
    emit({ type: 'user', id: 'u1', text: 'next', origin: 'user', status: 'queued' })
    emit({ type: 'user', id: 'x1', text: 'build done', origin: 'team', from: '3', status: 'queued' })
    await nextTick()
    const rows = wrapper.findAll('[data-test="chat-user"]')
    expect(rows[0].find('[data-test="chat-user-status"]').text()).toBe('Queued: will send when the turn ends')
    expect(rows[1].classes()).toContain('origin-team')
    expect(rows[1].find('[data-test="chat-team-from"]').text()).toBe('From #3 (teammate)')
    emit({ type: 'teamAccepted', ids: ['x1'] })
    await nextTick()
    expect(wrapper.findAll('[data-test="chat-user"]')[1].find('[data-test="chat-user-status"]').exists()).toBe(false)
  })

  it('Esc interrupts while working, not when idle', async () => {
    await mountPane()
    const input = wrapper.find('[data-test="chat-input"]')
    await input.trigger('keydown', { key: 'Escape' })
    expect(api.interrupt).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="chat-interrupt"]').exists()).toBe(false)
    emit({ type: 'status', state: 'working' })
    await nextTick()
    await input.trigger('keydown', { key: 'Escape' })
    expect(api.interrupt).toHaveBeenCalledWith({ paneId: 'c1' })
    await wrapper.find('[data-test="chat-interrupt"]').trigger('click')
    expect(api.interrupt).toHaveBeenCalledTimes(2)
  })

  it('approval buttons and keys answer with the right decision; a decided card is disabled', async () => {
    await mountPane()
    const ask = (requestId) => ({ type: 'approval', requestId, toolName: 'Bash', displayName: 'Bash', input: { command: 'rm x' }, description: 'Remove x', status: 'pending' })
    emit({ type: 'status', state: 'approval' })
    emit(ask('r1'))
    await nextTick()
    expect(wrapper.find('[data-test="chat-status"]').text()).toBe('Needs approval')
    let card = wrapper.find('[data-test="chat-approval"]')
    expect(card.text()).toContain('Allow Bash?')
    expect(card.find('pre').text()).toBe('rm x')
    await card.find('[data-test="chat-approve-session"]').trigger('click')
    await flushPromises()
    expect(api.approve).toHaveBeenLastCalledWith({ paneId: 'c1', requestId: 'r1', decision: 'allowSession', message: '' })
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
    const later = Date.now() + 1000
    const spy = vi.spyOn(Date, 'now').mockReturnValue(later)
    try {
      await card.trigger('keydown', { key: 'y' })
      await flushPromises()
    } finally {
      spy.mockRestore()
    }
    expect(api.approve).toHaveBeenLastCalledWith({ paneId: 'c1', requestId: 'r2', decision: 'allow', message: '' })

    emit(ask('r3'))
    await nextTick()
    card = wrapper.findAll('[data-test="chat-approval"]')[2]
    await card.find('.chat-link').trigger('click')
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
    expect(card.find('pre').text()).toBe('echo safe')
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
      expect(card.find('pre').text()).toBe('FULL COMMAND')
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
    expect(api.approve).toHaveBeenLastCalledWith({ paneId: 'c1', requestId: 'big', decision: 'allow', message: '' })
  })

  it('Codex: changes unknown wait for Show all; an MCP card says it is not sandboxed; the Manual header says so too', async () => {
    await mountPane({ agentId: 'codex', title: 'Codex' })
    expect(wrapper.find('[data-test="chat-mcp-unsandboxed"]').text()).toBe('MCP not sandboxed')
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
  })

  it('no MCP badge for Claude or in Yolo', async () => {
    await mountPane()
    expect(wrapper.find('[data-test="chat-mcp-unsandboxed"]').exists()).toBe(false)
    wrapper.unmount()
    await mountPane({ agentId: 'codex' }, { chatPermissions: () => 'yolo' })
    expect(wrapper.find('[data-test="chat-mcp-unsandboxed"]').exists()).toBe(false)
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

  it('not signed in: the message, the composer disabled, Start again opens again', async () => {
    history = { ok: true, events: [] }
    ctx.chatOpen = vi.fn(async () => ({ ok: false, code: 'signin', error: 'Not logged in' }))
    await mountPane()
    expect(wrapper.find('[data-test="chat-state"]').text()).toContain('Claude is not signed in. Open a Claude terminal pane and run /login, then start again.')
    expect(wrapper.find('[data-test="chat-input"]').element.disabled).toBe(true)
    expect(wrapper.find('[data-test="chat-status"]').text()).toBe('Not signed in')
    ctx.chatOpen.mockResolvedValueOnce({ ok: true })
    await wrapper.find('[data-test="chat-start-again"]').trigger('click')
    await flushPromises()
    expect(ctx.chatOpen).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-test="chat-state"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="chat-input"]').element.disabled).toBe(false)
  })

  it('untrusted folder: the button asks through ctx.chatOpen', async () => {
    history = { ok: true, events: [] }
    ctx.chatOpen = vi.fn(async () => ({ ok: false, code: 'untrusted' }))
    await mountPane()
    expect(wrapper.find('[data-test="chat-state"]').text()).toContain('This folder is not trusted yet.')
    await wrapper.find('[data-test="chat-trust"]').trigger('click')
    await flushPromises()
    expect(ctx.chatOpen).toHaveBeenCalledTimes(2)
  })

  it('the agent stopped: its error and Start again', async () => {
    await mountPane()
    emit({ type: 'status', state: 'crashed', error: 'exit code 3' })
    await nextTick()
    expect(wrapper.find('[data-test="chat-state"]').text()).toContain('The agent stopped')
    expect(wrapper.find('[data-test="chat-state-error"]').text()).toBe('exit code 3')
    await wrapper.find('[data-test="chat-start-again"]').trigger('click')
    await flushPromises()
    expect(ctx.chatOpen).toHaveBeenCalledWith(node)
  })

  it('header: rate limits, Yolo badge, maximize and close', async () => {
    await mountPane({}, { chatPermissions: () => 'yolo' })
    emit({ type: 'rateLimit', fiveHour: { utilization: 0.42 }, sevenDay: { utilization: 0.1 } })
    await nextTick()
    expect(wrapper.find('[data-test="chat-rate"]').text()).toBe('5 h: 42% · 7 d: 10%')
    expect(wrapper.find('[data-test="chat-permissions"]').text()).toBe('Yolo')
    const [maxBtn, closeBtn] = wrapper.findAll('.pane-nav-btn')
    await maxBtn.trigger('click')
    await closeBtn.trigger('click')
    expect(ctx.toggleMaximize).toHaveBeenCalledWith('c1')
    expect(ctx.closeLeaf).toHaveBeenCalledWith('c1')
  })

  it('long chats show the last rows and "Show earlier"', async () => {
    history = {
      ok: true,
      open: true,
      events: Array.from({ length: 320 }, (_, i) => ({ type: 'notice', kind: 'info', text: `n${i}` })) // i18n-ignore
    }
    await mountPane()
    expect(wrapper.findAll('[data-test="chat-notice"]')).toHaveLength(300)
    expect(wrapper.find('[data-test="chat-earlier"]').text()).toBe('Show earlier (20)')
    await wrapper.find('[data-test="chat-earlier"]').trigger('click')
    expect(wrapper.findAll('[data-test="chat-notice"]')).toHaveLength(320)
  })

  it('works without window.shellApi.chat', async () => {
    window.shellApi = {}
    await mountPane({}, { chatOpen: undefined })
    expect(wrapper.find('[data-test="chat-composer"]').exists()).toBe(true)
  })

  it('stops listening when unmounted', async () => {
    await mountPane()
    expect(listeners).toHaveLength(1)
    wrapper.unmount()
    wrapper = null
    expect(listeners).toHaveLength(0)
  })

  it('interrupt: says it is the current turn and that the queue goes on; a failure is shown', async () => {
    await mountPane()
    emit({ type: 'status', state: 'working' })
    await nextTick()
    const btn = wrapper.find('[data-test="chat-interrupt"]')
    expect(btn.attributes('title')).toBe('Interrupt the current turn (Esc). Queued messages are still sent afterwards.')
    expect(btn.attributes('aria-label')).toBe('Interrupt the current turn')
    api.interrupt.mockResolvedValueOnce({ ok: false })
    await btn.trigger('click')
    await flushPromises()
    expect(ctx.toast).toHaveBeenLastCalledWith('Could not interrupt the turn: unknown error', expect.any(Object))
    api.interrupt.mockRejectedValueOnce(new Error('not running'))
    await wrapper.find('[data-test="chat-input"]').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(ctx.toast).toHaveBeenLastCalledWith('Could not interrupt the turn: not running', expect.any(Object))
    ctx.toast.mockClear()
    await btn.trigger('click')
    await flushPromises()
    expect(ctx.toast).not.toHaveBeenCalled()
  })

  it('the live region says when a turn ends or fails and when sign-in is needed, not what the history replays', async () => {
    history = {
      ok: true,
      open: true,
      events: [
        { type: 'status', state: 'idle' },
        { type: 'turnEnd', status: 'failed', error: 'old' }
      ]
    }
    await mountPane()
    const live = () => wrapper.find('[data-test="chat-live"]')
    expect(live().attributes('aria-live')).toBe('polite')
    expect(live().text()).toBe('')
    emit({ type: 'status', state: 'working' })
    emit({ type: 'turnEnd', status: 'completed' })
    await flushPromises()
    expect(live().text()).toBe('Claude finished the turn')
    emit({ type: 'turnEnd', status: 'failed', error: 'boom' })
    await flushPromises()
    expect(live().text()).toBe('The turn failed')
    emit({ type: 'turnEnd', status: 'interrupted' })
    await flushPromises()
    expect(live().text()).toBe('Turn interrupted')
    // A new request: its card says it, not the pane.
    emit({ type: 'approval', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, status: 'pending' })
    await flushPromises()
    expect(live().text()).toBe('Turn interrupted')
    emit({ type: 'status', state: 'signin' })
    await flushPromises()
    expect(live().text()).toBe('Claude is not signed in')
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
    expect(wrapper.find('[data-test="chat-goto-approval"]').exists()).toBe(false)

    emit({ type: 'status', state: 'approval' })
    emit({ type: 'approval', requestId: 'r1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' }, status: 'pending' })
    await flushPromises()
    expect(document.activeElement).toBe(input.element)
    const hint = wrapper.find('[data-test="chat-goto-approval"]')
    expect(hint.text()).toBe('Bash waits for your answer (Alt+A)')
    expect(hint.attributes('aria-keyshortcuts')).toBe('Alt+A')
    const ev = new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true, cancelable: true })
    input.element.dispatchEvent(ev)
    await flushPromises()
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(wrapper.find('[data-test="chat-approval"]').element)
    expect(api.approve).not.toHaveBeenCalled()
    // The hint button does the same.
    input.element.focus()
    await hint.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.find('[data-test="chat-approval"]').element)
    emit({ type: 'approvalStatus', requestId: 'r1', status: 'allowed' })
    await nextTick()
    expect(wrapper.find('[data-test="chat-goto-approval"]').exists()).toBe(false)
  })

  it('model menu: aria-expanded and aria-controls, the focus goes in, Esc closes it back to the chip without interrupting', async () => {
    await mountPane({ model: 'claude-sonnet-4-6' })
    const chip = wrapper.find('[data-test="chat-model"]')
    expect(chip.attributes('aria-expanded')).toBe('false')
    await chip.trigger('click')
    await flushPromises()
    let menu = wrapper.find('[data-test="chat-model-menu"]')
    expect(chip.attributes('aria-expanded')).toBe('true')
    expect(chip.attributes('aria-controls')).toBe(menu.attributes('id'))
    expect(menu.element.contains(document.activeElement)).toBe(true)
    expect(document.activeElement.tagName).toBe('BUTTON')
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    try {
      document.activeElement.dispatchEvent(esc)
      await flushPromises()
    } finally {
      window.removeEventListener('keydown', seen)
    }
    expect(seen).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="chat-model-menu"]').exists()).toBe(false)
    expect(chip.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(chip.element)

    // While a turn runs: its choices are disabled, the menu itself takes the focus; Esc is not an interrupt.
    emit({ type: 'status', state: 'working' })
    await nextTick()
    await chip.trigger('click')
    await flushPromises()
    menu = wrapper.find('[data-test="chat-model-menu"]')
    expect(document.activeElement).toBe(menu.element)
    await menu.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(api.interrupt).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="chat-model-menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(chip.element)
  })

  it('model menu: a choice closes it back to the chip; Tab away closes it and leaves the focus there', async () => {
    await mountPane({ model: 'claude-sonnet-4-6' })
    const chip = wrapper.find('[data-test="chat-model"]')
    await chip.trigger('click')
    await flushPromises()
    const other = wrapper.findAll('[data-test="sop-model"]').find((b) => b.attributes('data-model') !== 'claude-sonnet-4-6')
    await other.trigger('click')
    await flushPromises()
    expect(api.setOption).toHaveBeenCalled()
    expect(wrapper.find('[data-test="chat-model-menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(chip.element)

    await chip.trigger('click')
    await flushPromises()
    const input = wrapper.find('[data-test="chat-input"]').element
    const menu = wrapper.find('[data-test="chat-model-menu"]')
    await menu.trigger('focusout', { relatedTarget: input })
    input.focus()
    await flushPromises()
    expect(wrapper.find('[data-test="chat-model-menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(input)
  })

  describe('permission mode (header)', () => {
    const options = () => wrapper.findAll('[data-test="chat-mode"] option').map((o) => ({ id: o.element.value, disabled: o.element.disabled }))

    it('Claude: its modes; Yolo only for a chat started in Yolo', async () => {
      await mountPane({ chatPermissionMode: 'default', chatLaunchYolo: false }, { chatSetOption: vi.fn(async () => ({ ok: true })) })
      expect(options()).toEqual([
        { id: 'default', disabled: false },
        { id: 'acceptEdits', disabled: false },
        { id: 'plan', disabled: false },
        { id: 'auto', disabled: false },
        { id: 'bypassPermissions', disabled: true }
      ])
      expect(wrapper.find('[data-test="chat-mode"]').attributes('aria-label')).toMatch(/Manual/)
    })

    it('a choice goes through ctx.chatSetOption (so the worker cap follows); shown only once confirmed', async () => {
      const chatSetOption = vi.fn(async (leaf, p) => {
        leaf.chatPermissionMode = p.permissionMode
        return { ok: true, permissionMode: p.permissionMode, permissions: 'manual' }
      })
      await mountPane({ chatPermissionMode: 'default', chatLaunchYolo: true }, { chatSetOption })
      const sel = wrapper.find('[data-test="chat-mode"]')
      await sel.setValue('plan')
      await flushPromises()
      expect(chatSetOption).toHaveBeenCalledWith(node, { permissionMode: 'plan' })
      expect(sel.element.value).toBe('plan')
    })

    it('refused: stays as it was, and says so', async () => {
      const chatSetOption = vi.fn(async () => ({ ok: false, error: 'no' }))
      await mountPane({ chatPermissionMode: 'default', chatLaunchYolo: true }, { chatSetOption })
      await wrapper.find('[data-test="chat-mode"]').setValue('acceptEdits')
      await flushPromises()
      expect(wrapper.find('[data-test="chat-mode"]').element.value).toBe('default')
      expect(ctx.toast).toHaveBeenCalled()
    })

    it('a capped worker: no Yolo and no Auto, even started in Yolo', async () => {
      await mountPane({ chatPermissionMode: 'default', chatLaunchYolo: true, maxPermissions: 'manual' }, { chatSetOption: vi.fn() })
      const o = options()
      expect(o.find((x) => x.id === 'bypassPermissions').disabled).toBe(true)
      expect(o.find((x) => x.id === 'auto').disabled).toBe(true)
    })

    it('Codex: Manual and Yolo; never Yolo during a turn (it would stop the turn)', async () => {
      const chatSetOption = vi.fn(async () => ({ ok: true }))
      await mountPane({ agentId: 'codex', chatPermissionMode: 'default', chatLaunchYolo: true }, { chatSetOption })
      expect(options()).toEqual([
        { id: 'default', disabled: false },
        { id: 'bypassPermissions', disabled: false }
      ])
      emit({ type: 'status', state: 'working' })
      await nextTick()
      expect(options().find((x) => x.id === 'bypassPermissions').disabled).toBe(true)
      await wrapper.find('[data-test="chat-mode"]').setValue('bypassPermissions')
      await flushPromises()
      expect(chatSetOption).not.toHaveBeenCalled()
    })
  })
})
