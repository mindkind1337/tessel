// The chat pane (components/chat/ChatPane.vue: Tessel's header over the
// native chat view, components/chat/orca) with a fake window.shellApi.chat:
// the history redrawn, events for this pane only, sending (a refused message
// stays as "Not sent"), Send waiting while the agent starts, a history that
// could not be read, interrupting, answering approvals (Alt+A goes to the
// request), the live region, the composer's options pill, the signed-out /
// untrusted / stopped states with "Start again", the right-click menu and a
// dropped path.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { config, mount, flushPromises } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import ChatPane from '../components/chat/ChatPane.vue'
import { changePrompt, promptValue } from '../components/chat/orca/__tests__/native-chat-prompt-editor.test-support.js'
import { installElementScrollTo, stubLayout, stubResizeObserver, deliverResizes, flush } from '../components/chat/orca/__tests__/native-chat-windowing-test-harness.js'
import { installNativeChatMessageListTestViewport } from '../chat/orca/native-chat-message-list-test-viewport.js'
import { clearNativeChatDraftCacheForTests } from '../chat/orca/native-chat-draft-cache.js'
import { clearNativeChatAttachmentCacheForTests } from '../chat/orca/composables/use-native-chat-composer-attachments.js'
import { modelsFor, modelLists, resetModelListsForTests } from '../agentModels.js'

// Real <Transition> for the menus (the stub would wrap their teleported content).
config.global.stubs.transition = false

// PointerEvent is not in every jsdom: a MouseEvent with its fields.
if (typeof globalThis.PointerEvent === 'undefined') {
  globalThis.PointerEvent = class extends MouseEvent {}
}

describe('ChatPane.vue', () => {
  let wrapper, ctx, api, node, listeners, prevApi, history
  let restoreViewport = () => {}
  let restoreScrollTo = () => {}

  // jsdom has no layout: ProseMirror asks a Range for its rectangles when it
  // scrolls the caret into view.
  const hadRangeRects = typeof Range.prototype.getClientRects === 'function'
  beforeAll(() => {
    restoreScrollTo = installElementScrollTo()
    if (!hadRangeRects) {
      Range.prototype.getClientRects = () => []
      Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
    }
  })
  afterAll(() => {
    restoreScrollTo()
    if (!hadRangeRects) {
      delete Range.prototype.getClientRects
      delete Range.prototype.getBoundingClientRect
    }
  })

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
    await settle()
  }

  // Vue renders on the next tick; the list's virtualizer re-renders after that.
  async function settle() {
    await flushPromises()
    await flush()
  }

  // The composer is a TipTap editor (contenteditable): typed through its editor.
  const input = () => document.querySelector('[data-test="chat-input"]')
  const draft = () => promptValue(input())
  const sendBtn = () => document.querySelector('[data-test="chat-send"]')
  const status = () => wrapper.find('[data-test="chat-status"]').text()
  const card = () => document.querySelector('[data-test="chat-approval"]')
  const inCard = (sel) => card().querySelector(sel)
  const unsent = () => [...document.querySelectorAll('[data-test="chat-unsent"]')]
  async function type(text) {
    changePrompt(input(), text)
    await settle()
  }
  async function key(target, init) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    if ('keyCode' in init) Object.defineProperty(event, 'keyCode', { value: init.keyCode })
    target.dispatchEvent(event)
    await settle()
    return event
  }
  const enter = (init = {}) => key(input(), { key: 'Enter', keyCode: 13, ...init })
  async function click(el) {
    el.click()
    await settle()
  }
  // A key on the card some time after it appeared (single keys wait KEY_GRACE_MS).
  async function lateKey(el, init, ms = 1000) {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ms)
    try {
      await key(el, init)
    } finally {
      spy.mockRestore()
    }
  }

  beforeEach(() => {
    clearNativeChatDraftCacheForTests()
    clearNativeChatAttachmentCacheForTests()
    restoreViewport = installNativeChatMessageListTestViewport()
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
      splitLeaf: vi.fn(),
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
    restoreViewport()
    vi.restoreAllMocks()
    document.body.replaceChildren()
    document.body.style.pointerEvents = ''
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
    expect(document.querySelector('[data-test="nc-user-row"]').textContent).toContain('hello')
    // Agent text is markdown (through ChatMarkdown).
    const answer = [...document.querySelectorAll('[data-test="nc-agent-row"]')].find((row) => row.textContent.includes('there'))
    expect(answer.querySelector('strong').textContent).toBe('there')
    // The settled turn folds its work under "Worked for…"; opened, the tool is there.
    const turn = document.querySelector('[data-native-chat-turn-status="settled"]')
    expect(turn.textContent).toMatch(/Worked for/)
    await click(turn)
    const run = document.querySelector('.nc-tool-run__header')
    expect(run.textContent).toContain('Read 1 file')
    await click(run)
    const line = document.querySelector('.nc-tool-line')
    expect(line.textContent).toContain('Read')
    expect(line.textContent).toContain('x.js')
    expect(status()).toBe('Idle')
    expect(node.sessionId).toBe('s1')
    expect(node.model).toBe('claude-sonnet-4-6')
    // An event the history already had (seq <= 5) is dropped.
    emit({ type: 'notice', kind: 'info', text: 'old' }, { seq: 5 })
    await settle()
    expect(document.querySelector('[data-test="nc-notice"]')).toBeNull()
  })

  it('opens the session through the app when it is not running', async () => {
    history = { ok: true, events: [], seq: 0 }
    await mountPane()
    expect(ctx.chatOpen).toHaveBeenCalledWith(node)
    expect(node.sessionId).toBe('s-new')
    expect(status()).toBe('Idle')
    // An empty conversation says so.
    expect(document.querySelector('[data-native-chat-empty-state="empty"]').textContent).toContain('Start a chat with Claude')
  })

  it('shows only the events of its own pane; streams and tool output as text', async () => {
    await mountPane()
    emit({ type: 'user', id: 'u1', text: 'go', origin: 'user', status: 'accepted' })
    emit({ type: 'status', state: 'working' })
    emit({ type: 'assistantDelta', messageId: 'm1', text: 'Work' }, { paneId: 'other' })
    emit({ type: 'assistantDelta', messageId: 'm1', text: 'ing on it' })
    emit({ type: 'tool', id: 't1', name: 'Bash', input: { command: 'npm test' }, status: 'running' })
    emit({ type: 'toolResult', id: 't1', isError: false, text: '<b>not html</b>' })
    await settle()
    const answers = [...document.querySelectorAll('[data-test="nc-agent-row"] .nc-row-markdown')]
    expect(answers).toHaveLength(1)
    expect(answers[0].textContent.trim()).toBe('ing on it')
    expect(status()).toBe('Working')
    expect(document.querySelector('[data-native-chat-root]').getAttribute('data-native-chat-working')).toBe('true')
    const run = document.querySelector('.nc-tool-run__header')
    expect(run.textContent).toContain('npm test')
    await click(run)
    // The open run shows its lines expanded: the command's output is plain text.
    const pres = [...document.querySelectorAll('.nc-tool-line__pre')]
    const out = pres.find((pre) => pre.textContent.includes('not html'))
    expect(out.textContent).toBe('<b>not html</b>')
    expect(out.querySelector('b')).toBeNull()
  })

  it('Enter sends, Shift+Enter does not', async () => {
    await mountPane()
    await type('run the tests')
    await enter({ shiftKey: true })
    expect(api.send).not.toHaveBeenCalled()
    await type('run the tests')
    await enter()
    expect(api.send).toHaveBeenCalledWith({ paneId: 'c1', text: 'run the tests' })
    expect(draft()).toBe('')
    expect(unsent()).toHaveLength(0)
  })

  it('a refused message stays as "Not sent" (copy, retry, discard); what was typed since is kept', async () => {
    await mountPane()
    window.shellApi.writeClipboard = vi.fn()
    let resolveA
    api.send.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveA = r
        })
    )
    await type('message A')
    await enter()
    expect(api.send).toHaveBeenCalledWith({ paneId: 'c1', text: 'message A' })
    // The draft stays until the pane has the message (sent or kept as "Not sent").
    expect(draft()).toBe('message A')
    // B is typed over it while A is on its way; A is refused: B stays.
    await type('draft B')
    resolveA({ ok: false, error: 'no session' })
    await settle()
    expect(draft()).toBe('draft B')
    let entries = unsent()
    expect(entries).toHaveLength(1)
    expect(entries[0].textContent).toContain('Not sent')
    expect(entries[0].querySelector('[data-test="chat-unsent-text"]').textContent).toBe('message A')
    expect(entries[0].querySelector('[data-test="chat-unsent-error"]').textContent).toBe('no session')
    expect(ctx.toast).toHaveBeenCalledWith('Message not sent: no session', expect.any(Object))

    await click(entries[0].querySelector('[data-test="chat-unsent-copy"]'))
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith('message A')
    expect(ctx.copied).toHaveBeenCalledWith('Message')

    // Retry takes the same path; refused again (a throw), it stays once.
    api.send.mockRejectedValueOnce(new Error('pipe closed'))
    await click(entries[0].querySelector('[data-test="chat-unsent-retry"]'))
    entries = unsent()
    expect(entries).toHaveLength(1)
    expect(entries[0].querySelector('[data-test="chat-unsent-error"]').textContent).toBe('pipe closed')
    await click(entries[0].querySelector('[data-test="chat-unsent-retry"]'))
    expect(api.send).toHaveBeenLastCalledWith({ paneId: 'c1', text: 'message A' })
    expect(unsent()).toHaveLength(0)
    expect(draft()).toBe('draft B')

    // Discard drops it without sending.
    api.send.mockResolvedValueOnce({ ok: false })
    await type('message C')
    await click(sendBtn())
    entries = unsent()
    expect(entries[0].querySelector('[data-test="chat-unsent-error"]').textContent).toBe('unknown error')
    const calls = api.send.mock.calls.length
    const discard = entries[0].querySelector('[data-test="chat-unsent-discard"]')
    discard.focus()
    await click(discard)
    expect(unsent()).toHaveLength(0)
    expect(api.send.mock.calls.length).toBe(calls)
    // The focus went back to typing.
    expect(document.activeElement).toBe(input())
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
    expect(status()).toBe('Starting')
    expect(input().getAttribute('contenteditable')).toBe('true')
    await type('early')
    expect(sendBtn().disabled).toBe(true)
    expect(sendBtn().getAttribute('title')).toBe('Wait until Claude has started')
    expect(document.querySelector('[data-test="chat-send-blocked"]').textContent.trim()).toBe('Wait until Claude has started')
    await enter()
    expect(api.send).not.toHaveBeenCalled()
    expect(draft()).toBe('early')
    opened({ ok: true })
    await settle()
    expect(sendBtn().disabled).toBe(false)
    await enter()
    expect(api.send).toHaveBeenCalledWith({ paneId: 'c1', text: 'early' })

    // Asleep, then waking up: the message waits in the main process.
    emit({ type: 'status', state: 'asleep' })
    await settle()
    await type('wake up')
    expect(sendBtn().disabled).toBe(false)
    emit({ type: 'status', state: 'starting' })
    await settle()
    expect(sendBtn().disabled).toBe(false)
    await enter()
    expect(api.send).toHaveBeenLastCalledWith({ paneId: 'c1', text: 'wake up' })
  })

  it('a history that could not be read: an explicit state with Retry, no empty chat, no start', async () => {
    api.history.mockRejectedValueOnce(new Error('journal locked'))
    await mountPane()
    const box = document.querySelector('[data-test="chat-history-error"]')
    expect(box.textContent).toContain('Could not load conversation')
    expect(box.textContent).toContain('journal locked')
    expect(document.querySelector('[data-native-chat-empty-state="empty"]')).toBeNull()
    expect(document.querySelector('[data-native-chat-empty-state="loading"]')).toBeNull()
    expect(ctx.chatOpen).not.toHaveBeenCalled()
    await type('hi')
    expect(sendBtn().disabled).toBe(true)
    // Live events wait for the history.
    emit({ type: 'notice', kind: 'info', text: 'later' }, { seq: 3 })
    await settle()
    expect(document.querySelector('[data-test="nc-notice"]')).toBeNull()

    history = { ok: true, seq: 2, events: [{ seq: 2, event: { type: 'user', id: 'u1', text: 'before', origin: 'user', status: 'accepted' } }] }
    await click(document.querySelector('[data-test="chat-history-retry"]'))
    expect(document.querySelector('[data-test="chat-history-error"]')).toBeNull()
    expect(document.querySelector('[data-test="nc-user-row"]').textContent).toContain('before')
    // The event that came meanwhile is drawn too (in the turn the journal
    // left open, closed now: nothing runs it any more).
    await click(document.querySelector('[data-native-chat-turn-status="settled"]'))
    expect(document.querySelector('[data-test="nc-notice"]').textContent).toContain('later')
    // Not running: opened once the history is drawn.
    expect(ctx.chatOpen).toHaveBeenCalledTimes(1)
    expect(sendBtn().disabled).toBe(false)
  })

  it('a history refused by the main process ({ ok: false }) says so too', async () => {
    api.history.mockResolvedValueOnce({ ok: false, error: 'invalid pane' })
    await mountPane()
    expect(document.querySelector('[data-test="chat-history-error"]').textContent).toContain('invalid pane')
    expect(ctx.chatOpen).not.toHaveBeenCalled()
  })

  it('a queued message shows its chip; team messages are set apart with their sender', async () => {
    await mountPane()
    emit({ type: 'user', id: 'u1', text: 'next', origin: 'user', status: 'queued' })
    emit({ type: 'user', id: 'x1', text: 'build done', origin: 'team', from: '3', status: 'queued' })
    await settle()
    const rows = [...document.querySelectorAll('[data-test="nc-user-row"]')]
    const mine = rows.find((row) => row.textContent.includes('next'))
    const team = rows.find((row) => row.textContent.includes('build done'))
    expect(mine.classList.contains('is-team')).toBe(false)
    expect(mine.querySelector('[data-test="nc-team-from"]')).toBeNull()
    expect(team.classList.contains('is-team')).toBe(true)
    expect(team.querySelector('[data-test="nc-team-from"]').textContent.trim()).toBe('From #3 (teammate)')
    expect(mine.querySelector('[data-test="nc-user-queued"]').textContent.trim()).toBe('Queued: will send when the turn ends')
    expect(team.querySelector('[data-test="nc-user-queued"]').textContent.trim()).toBe('Waiting: delivered when the turn ends')
    emit({ type: 'teamAccepted', ids: ['x1'] })
    emit({ type: 'userStatus', id: 'u1', status: 'accepted' })
    await settle()
    expect(document.querySelectorAll('[data-test="nc-user-row"]')).toHaveLength(2)
    expect(document.querySelector('[data-test="nc-user-queued"]')).toBeNull()
  })

  it('Esc interrupts while working, not when idle; so does Stop', async () => {
    await mountPane()
    await key(input(), { key: 'Escape' })
    expect(api.interrupt).not.toHaveBeenCalled()
    expect(document.querySelector('[data-test="chat-interrupt"]')).toBeNull()
    emit({ type: 'status', state: 'working' })
    await settle()
    await key(input(), { key: 'Escape' })
    expect(api.interrupt).toHaveBeenCalledWith({ paneId: 'c1' })
    await click(document.querySelector('[data-test="chat-interrupt"]'))
    expect(api.interrupt).toHaveBeenCalledTimes(2)
  })

  it('approval buttons and keys answer with the right decision; an answered request leaves its card', async () => {
    await mountPane()
    const ask = (requestId) => ({ type: 'approval', requestId, toolName: 'Bash', displayName: 'Bash', input: { command: 'rm x' }, description: 'Remove x', status: 'pending' })
    emit({ type: 'status', state: 'approval' })
    emit(ask('r1'))
    await settle()
    expect(status()).toBe('Needs approval')
    expect(card().textContent).toContain('Allow Bash?')
    expect(inCard('[data-test="chat-approval-detail"]').textContent).toBe('rm x')
    // The composer stays under the card.
    expect(input()).not.toBeNull()
    await click(inCard('[data-test="chat-approve-session"]'))
    expect(api.approve).toHaveBeenLastCalledWith({ paneId: 'c1', requestId: 'r1', decision: 'allowSession' })
    emit({ type: 'approvalStatus', requestId: 'r1', status: 'allowedSession' })
    await settle()
    // Decided: no card any more, a receipt in the chat says what was chosen.
    expect(card()).toBeNull()
    expect(document.querySelector('[data-native-chat-receipt="approval"]').textContent).toContain('Allow for this session')

    emit(ask('r2'))
    await settle()
    // Right after it appeared, a key is typing meant elsewhere: no answer.
    await key(card(), { key: 'y' })
    expect(api.approve).toHaveBeenCalledTimes(1)
    await lateKey(card(), { key: 'y' })
    expect(api.approve).toHaveBeenLastCalledWith({ paneId: 'c1', requestId: 'r2', decision: 'allow' })
    emit({ type: 'approvalStatus', requestId: 'r2', status: 'allowed' })
    await settle()

    emit(ask('r3'))
    await settle()
    await click(inCard('[data-test="chat-approve-add-reason"]'))
    const reason = inCard('[data-test="chat-approve-reason"]')
    reason.value = 'not now'
    reason.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    // Typing in the reason is not an answer.
    await lateKey(reason, { key: 'n' })
    expect(api.approve).toHaveBeenCalledTimes(2)
    await click(inCard('[data-test="chat-approve-deny"]'))
    expect(api.approve).toHaveBeenLastCalledWith({ paneId: 'c1', requestId: 'r3', decision: 'deny', message: 'not now' })
  })

  it('a truncated input: hidden count shown, Allow and the keys wait until Show all fetched the whole input', async () => {
    await mountPane()
    emit({ type: 'status', state: 'approval' })
    emit({ type: 'approval', requestId: 'big', toolName: 'Bash', displayName: 'Bash', input: { command: 'x' }, detail: 'echo safe', hidden: 12345, status: 'pending' })
    await settle()
    expect(inCard('[data-test="chat-approval-detail"]').textContent).toBe('echo safe')
    expect(inCard('[data-test="chat-approval-hidden"]').textContent).toContain('12345 characters hidden')
    expect(inCard('[data-test="chat-approve-allow"]').disabled).toBe(true)
    expect(inCard('[data-test="chat-approve-session"]').disabled).toBe(true)
    expect(inCard('[data-test="chat-approve-deny"]').disabled).toBe(false)
    await lateKey(card(), { key: 'y' }, 5000)
    await lateKey(card(), { key: 'n' }, 5000)
    expect(api.approve).not.toHaveBeenCalled()
    await click(inCard('[data-test="chat-approval-show-all"]'))
    expect(api.approvalInput).toHaveBeenCalledWith({ paneId: 'c1', requestId: 'big' })
    expect(inCard('[data-test="chat-approval-detail"]').textContent).toBe('FULL COMMAND')
    expect(inCard('[data-test="chat-approval-hidden"]')).toBeNull()
    expect(inCard('[data-test="chat-approve-allow"]').disabled).toBe(false)
    // Still no single-key answers on that card.
    await lateKey(card(), { key: 'y' }, 5000)
    expect(api.approve).not.toHaveBeenCalled()
    await click(inCard('[data-test="chat-approve-allow"]'))
    expect(api.approve).toHaveBeenLastCalledWith({ paneId: 'c1', requestId: 'big', decision: 'allow' })
  })

  it('Codex: changes unknown wait for Show all; an MCP card says it is not sandboxed; the Manual header says so too', async () => {
    await mountPane({ agentId: 'codex', title: 'Codex' })
    expect(wrapper.find('[data-test="chat-mcp-unsandboxed"]').text()).toBe('MCP not sandboxed')
    emit({ type: 'approval', requestId: 'fu', toolName: 'Edit', input: { grantRoot: 'C:\\x', changesUnknown: true, file_path: '', changes: [] }, detail: '{ "grantRoot": "C:\\x" }', hidden: 1, status: 'pending' })
    emit({ type: 'approval', requestId: 'mc', toolName: 'MCP', displayName: 'MCP files', input: { server: 'files', message: 'Run delete_all?' }, detail: 'x', hidden: 0, choices: ['accept', 'decline'], status: 'pending' })
    await settle()
    // One request at a time: the oldest first.
    expect(document.querySelectorAll('[data-test="chat-approval"]')).toHaveLength(1)
    expect(inCard('[data-test="chat-approval-hidden"]').textContent).toContain('Changes unknown')
    expect(inCard('[data-test="chat-approval-hidden"]').textContent).not.toContain('characters hidden')
    expect(inCard('[data-test="chat-approve-allow"]').disabled).toBe(true)
    expect(inCard('[data-test="chat-approval-mcp"]')).toBeNull()
    await click(inCard('[data-test="chat-approve-deny"]'))
    expect(api.approve).toHaveBeenLastCalledWith({ paneId: 'c1', requestId: 'fu', decision: 'deny' })
    emit({ type: 'approvalStatus', requestId: 'fu', status: 'denied' })
    await settle()
    expect(inCard('[data-test="chat-approval-mcp"]').textContent).toContain('outside the sandbox')
    expect(inCard('[data-test="chat-approve-allow"]').disabled).toBe(false)
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
    await settle()
    const items = [...inCard('[data-test="chat-approval-rules"]').querySelectorAll('li')].map((li) => li.textContent.trim())
    expect(items).toEqual(['Bash(npm test:*)', 'Switch this session to the acceptEdits mode', 'Give access to C:\\other'])
    emit({ type: 'approvalStatus', requestId: 'r1', status: 'allowed' })
    await settle()
    expect(inCard('[data-test="chat-approval-rules"]').textContent).toContain('adds no rule')
  })

  it('a new approval never takes the focus from the composer', async () => {
    await mountPane()
    input().focus()
    expect(document.activeElement).toBe(input())
    emit({ type: 'approval', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, status: 'pending' })
    await settle()
    expect(card()).not.toBeNull()
    expect(document.activeElement).toBe(input())
  })

  it('not signed in: the message, the composer disabled, Start again opens again', async () => {
    history = { ok: true, events: [] }
    ctx.chatOpen = vi.fn(async () => ({ ok: false, code: 'signin', error: 'Not logged in' }))
    await mountPane()
    expect(document.querySelector('[data-test="chat-state"]').textContent).toContain('Claude is not signed in. Open a Claude terminal pane and run /login, then start again.')
    expect(input().getAttribute('contenteditable')).toBe('false')
    expect(status()).toBe('Not signed in')
    ctx.chatOpen.mockResolvedValueOnce({ ok: true })
    await click(document.querySelector('[data-test="chat-start-again"]'))
    expect(ctx.chatOpen).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-test="chat-state"]')).toBeNull()
    expect(input().getAttribute('contenteditable')).toBe('true')
  })

  it('untrusted folder: the button asks through ctx.chatOpen', async () => {
    history = { ok: true, events: [] }
    ctx.chatOpen = vi.fn(async () => ({ ok: false, code: 'untrusted' }))
    await mountPane()
    expect(document.querySelector('[data-test="chat-state"]').textContent).toContain('This folder is not trusted yet.')
    await click(document.querySelector('[data-test="chat-trust"]'))
    expect(ctx.chatOpen).toHaveBeenCalledTimes(2)
  })

  it('the agent stopped: its error and Start again', async () => {
    await mountPane()
    emit({ type: 'status', state: 'crashed', error: 'exit code 3' })
    await settle()
    expect(document.querySelector('[data-test="chat-state"]').textContent).toContain('The agent stopped')
    expect(document.querySelector('[data-test="chat-state-error"]').textContent).toBe('exit code 3')
    await click(document.querySelector('[data-test="chat-start-again"]'))
    expect(ctx.chatOpen).toHaveBeenCalledWith(node)
  })

  it('header: a model chosen by its alias shows the name its list gives it (opus -> Opus 5.5)', async () => {
    modelLists.claude = { models: [{ id: 'opus', label: 'Opus 5.5', effortLevels: ['high'] }], fetchedAt: Date.now() }
    try {
      await mountPane({ model: 'opus' })
      expect(wrapper.get('[data-test="chat-model"]').text()).toBe('Opus 5.5')
    } finally {
      resetModelListsForTests()
    }
  })

  it("header: the effort from the agent's own settings when the pane chose none; the sidebar gets the same text", async () => {
    modelLists.claude = { models: [{ id: 'opus', label: 'Opus 5.5', effortLevels: ['xhigh'] }], fetchedAt: Date.now() }
    const prev = window.shellApi.agentModel
    window.shellApi.agentModel = vi.fn(async () => ({ model: 'claude-opus-5-5', effort: 'xhigh', source: 'settings' }))
    try {
      await mountPane({ model: 'opus', sessionId: 's1' })
      emit({ type: 'status', state: 'idle', model: 'opus' })
      await settle()
      expect(wrapper.get('[data-test="chat-model"]').text()).toBe('Opus 5.5 · xhigh')
      expect(node.headerModel).toBe('Opus 5.5 · xhigh')
      // The composer's effort picker reads the same effort.
      expect(node.shownEffort).toBe('xhigh')
    } finally {
      window.shellApi.agentModel = prev
      resetModelListsForTests()
    }
  })

  it('Codex chat: its effort (from its conversation) shows in the header and feeds the effort picker, without any new event', async () => {
    modelLists.codex = { models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', effortLevels: ['low', 'medium', 'high'] }], fetchedAt: Date.now() }
    const prev = window.shellApi.agentModel
    window.shellApi.agentModel = vi.fn(async () => ({ model: 'gpt-6-astra', effort: 'medium', source: 'session' }))
    try {
      await mountPane({ agentId: 'codex', title: 'Codex', model: 'gpt-6-astra', sessionId: '01a0ec6d-21fa-7941-a0c6-4f0cc5d59814' })
      await settle()
      expect(window.shellApi.agentModel).toHaveBeenCalled()
      expect(node.shownEffort).toBe('medium')
      expect(wrapper.get('[data-test="chat-model"]').text()).toContain('medium')
    } finally {
      window.shellApi.agentModel = prev
      resetModelListsForTests()
    }
  })

  it('header: rate limits, Yolo on the icon ring only (no badge), maximize and close', async () => {
    await mountPane({}, { chatPermissions: () => 'yolo' })
    emit({ type: 'rateLimit', fiveHour: { utilization: 0.42 }, sevenDay: { utilization: 0.1 } })
    await settle()
    expect(wrapper.find('[data-test="chat-rate"]').text()).toBe('5 h: 42% · 7 d: 10%')
    expect(wrapper.find('[data-test="chat-permissions"]').exists()).toBe(false)
    const icon = wrapper.get('[data-test="chat-icon"]')
    expect(icon.classes()).toContain('yolo')
    expect(icon.attributes('title')).toBe('Tools run without asking (Settings)')
    const [maxBtn, closeBtn] = wrapper.findAll('.pane-nav-btn')
    await maxBtn.trigger('click')
    await closeBtn.trigger('click')
    expect(ctx.toggleMaximize).toHaveBeenCalledWith('c1')
    expect(ctx.closeLeaf).toHaveBeenCalledWith('c1')
  })

  it('long chats render only a window of their rows', async () => {
    // A real viewport (600 px) instead of the endless one: the list windows.
    restoreViewport()
    restoreViewport = stubLayout()
    const restoreObserver = stubResizeObserver()
    try {
      history = {
        ok: true,
        open: true,
        events: Array.from({ length: 320 }, (_, i) => ({ type: 'notice', kind: 'info', text: `n${i}` })) // i18n-ignore
      }
      await mountPane()
      deliverResizes()
      await settle()
      const drawn = document.querySelectorAll('[data-test="nc-notice"]').length
      expect(drawn).toBeGreaterThan(0)
      expect(drawn).toBeLessThan(100)
    } finally {
      restoreObserver()
    }
  })

  it('works without window.shellApi.chat', async () => {
    window.shellApi = {}
    await mountPane({}, { chatOpen: undefined })
    expect(wrapper.find('[data-test="chat-composer"]').exists()).toBe(true)
    expect(input()).not.toBeNull()
  })

  it('stops listening when unmounted', async () => {
    await mountPane()
    expect(listeners).toHaveLength(1)
    wrapper.unmount()
    wrapper = null
    expect(listeners).toHaveLength(0)
  })

  it('interrupt: Stop names what it does; a failure is shown', async () => {
    await mountPane()
    emit({ type: 'status', state: 'working' })
    await settle()
    const btn = () => document.querySelector('[data-test="chat-interrupt"]')
    expect(btn().getAttribute('aria-label')).toBe('Stop the agent')
    expect(btn().getAttribute('title')).toBe('Interrupt the current turn (Esc). Queued messages are still sent afterwards.')
    api.interrupt.mockResolvedValueOnce({ ok: false })
    await click(btn())
    expect(ctx.toast).toHaveBeenLastCalledWith('Could not interrupt the turn: unknown error', expect.any(Object))
    api.interrupt.mockRejectedValueOnce(new Error('not running'))
    await key(input(), { key: 'Escape' })
    expect(ctx.toast).toHaveBeenLastCalledWith('Could not interrupt the turn: not running', expect.any(Object))
    ctx.toast.mockClear()
    await click(btn())
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
    await settle()
    expect(live().text()).toBe('Claude finished the turn')
    emit({ type: 'turnEnd', status: 'failed', error: 'boom' })
    await settle()
    expect(live().text()).toBe('The turn failed')
    emit({ type: 'turnEnd', status: 'interrupted' })
    await settle()
    expect(live().text()).toBe('Turn interrupted')
    // A new request: its card says it, not the pane.
    emit({ type: 'approval', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, status: 'pending' })
    await settle()
    expect(live().text()).toBe('Turn interrupted')
    emit({ type: 'status', state: 'signin' })
    await settle()
    expect(live().text()).toBe('Claude is not signed in')
  })

  it('Alt+A goes to the pending request, even from the composer; nothing happens without one', async () => {
    await mountPane()
    input().focus()
    await type('typing')
    // No request: the key is left alone.
    const idle = await key(input(), { key: 'a', altKey: true })
    expect(idle.defaultPrevented).toBe(false)

    emit({ type: 'status', state: 'approval' })
    emit({ type: 'approval', requestId: 'r1', toolName: 'Bash', displayName: 'Bash', input: { command: 'ls' }, status: 'pending' })
    await settle()
    expect(document.activeElement).toBe(input())
    const ev = await key(input(), { key: 'a', altKey: true })
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(card())
    expect(api.approve).not.toHaveBeenCalled()
    // What was typed is still there.
    expect(draft()).toBe('typing')
    emit({ type: 'approvalStatus', requestId: 'r1', status: 'allowed' })
    await settle()
    input().focus()
    const after = await key(input(), { key: 'a', altKey: true })
    expect(after.defaultPrevented).toBe(false)
  })

  describe('the composer options (permission mode, model)', () => {
    const trigger = (which) => document.querySelector(`[data-native-chat-picker="${which}"]`)
    async function openMenu(which) {
      trigger(which).dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
      await settle()
    }
    const menu = () => document.querySelector('[role="menu"]:not(.nc-ui-leave-active)')
    const modeGroup = () => menu() && [...menu().querySelectorAll('[role="group"]')].find((g) => g.getAttribute('aria-label') === 'Permission mode')
    const modes = () =>
      [...modeGroup().querySelectorAll('[role="menuitemradio"]')].map((o) => ({ id: o.getAttribute('data-choice'), disabled: o.getAttribute('aria-disabled') === 'true' }))
    const modeItem = (id) => modeGroup().querySelector(`[data-choice="${id}"]`)

    it('no pickers when the app cannot set options', async () => {
      await mountPane()
      expect(trigger('options')).toBeNull()
    })

    it('Claude: its modes; Yolo only for a chat started in Yolo', async () => {
      await mountPane({ chatPermissionMode: 'default', chatLaunchYolo: false }, { chatSetOption: vi.fn(async () => ({ ok: true })) })
      await openMenu('options')
      expect(modes()).toEqual([
        { id: 'default', disabled: false },
        { id: 'acceptEdits', disabled: false },
        { id: 'plan', disabled: false },
        { id: 'auto', disabled: false },
        { id: 'bypassPermissions', disabled: true }
      ])
      expect(trigger('options').getAttribute('aria-label')).toMatch(/Manual/)
    })

    it('a choice goes through ctx.chatSetOption (so the worker cap follows); shown only once confirmed', async () => {
      let confirm
      const chatSetOption = vi.fn(
        (leaf, p) =>
          new Promise((r) => {
            confirm = () => {
              leaf.chatPermissionMode = p.permissionMode
              r({ ok: true, permissionMode: p.permissionMode, permissions: 'manual' })
            }
          })
      )
      await mountPane({ chatPermissionMode: 'default', chatLaunchYolo: true }, { chatSetOption })
      await openMenu('options')
      await click(modeItem('plan'))
      expect(chatSetOption).toHaveBeenCalledWith(node, { permissionMode: 'plan' })
      expect(trigger('options').textContent).toContain('Manual')
      confirm()
      await settle()
      expect(trigger('options').textContent).toContain('Plan')
    })

    it('refused: stays as it was, and says so', async () => {
      const chatSetOption = vi.fn(async () => ({ ok: false, error: 'no' }))
      await mountPane({ chatPermissionMode: 'default', chatLaunchYolo: true }, { chatSetOption })
      await openMenu('options')
      await click(modeItem('acceptEdits'))
      expect(chatSetOption).toHaveBeenCalledWith(node, { permissionMode: 'acceptEdits' })
      expect(ctx.toast).toHaveBeenCalled()
      await openMenu('options')
      expect(modeItem('default').getAttribute('aria-checked')).toBe('true')
      expect(modeItem('acceptEdits').getAttribute('aria-checked')).toBe('false')
    })

    it('a capped worker: no Yolo and no Auto, even started in Yolo', async () => {
      const chatSetOption = vi.fn(async () => ({ ok: true }))
      await mountPane({ chatPermissionMode: 'default', chatLaunchYolo: true, maxPermissions: 'manual' }, { chatSetOption })
      await openMenu('options')
      const o = modes()
      expect(o.find((x) => x.id === 'bypassPermissions').disabled).toBe(true)
      expect(o.find((x) => x.id === 'auto').disabled).toBe(true)
    })

    it('Codex: Manual and Yolo; never Yolo during a turn (it would stop the turn)', async () => {
      const chatSetOption = vi.fn(async () => ({ ok: true }))
      await mountPane({ agentId: 'codex', chatPermissionMode: 'default', chatLaunchYolo: true }, { chatSetOption })
      await openMenu('options')
      expect(modes()).toEqual([
        { id: 'default', disabled: false },
        { id: 'bypassPermissions', disabled: false }
      ])
      emit({ type: 'status', state: 'working' })
      await settle()
      expect(modes().find((x) => x.id === 'bypassPermissions').disabled).toBe(true)
      await click(modeItem('bypassPermissions'))
      expect(chatSetOption).not.toHaveBeenCalled()
    })

    it('a model goes through ctx.chatSetOption with the leaf, and the leaf follows', async () => {
      const claude = modelsFor('claude')
      const chatSetOption = vi.fn(async () => ({ ok: true }))
      await mountPane({ model: claude[0].id }, { chatSetOption })
      await openMenu('model')
      const other = [...menu().querySelectorAll('[role="menuitemradio"]')].find((b) => b.getAttribute('data-choice') !== claude[0].id)
      const id = other.getAttribute('data-choice')
      await click(other)
      expect(chatSetOption).toHaveBeenCalledWith(node, { model: id })
      expect(node.model).toBe(id)
      expect(trigger('model').textContent).toContain(claude.find((m) => m.id === id).label)
    })
  })

  it('the right-click menu: Copy the selection, Paste into the composer, Split and Close the pane', async () => {
    history = { ok: true, open: true, events: [{ type: 'assistant', messageId: 'm1', text: 'copy me' }] }
    await mountPane()
    window.shellApi.writeClipboard = vi.fn()
    window.shellApi.readClipboard = vi.fn(async () => 'pasted')
    const root = document.querySelector('[data-native-chat-root]')
    const openMenu = async () => {
      root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }))
      await settle()
      return document.querySelector('[data-test="chat-context-menu"]')
    }
    const item = (menu, label) => [...menu.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes(label))

    // A mouse selection, as a user makes it: pointerdown (the composer's
    // frame-late focus claim stands down once the user interacts, so it cannot
    // move the selection), the range, then mouseup (the chat remembers the
    // selection there).
    const text = [...document.querySelectorAll('.nc-row-markdown p')].find((p) => p.textContent === 'copy me')
    text.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    const range = document.createRange()
    range.selectNodeContents(text)
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(range)
    text.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    let menu = await openMenu()
    expect(menu).not.toBeNull()
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.replace(/Ctrl\+\S+/, '').trim())).toEqual([
      'Copy',
      'Paste',
      'Split Right',
      'Split Down',
      'Maximize Pane',
      'Close Pane'
    ])
    await click(item(menu, 'Copy'))
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith('copy me')
    window.getSelection().removeAllRanges()

    menu = await openMenu()
    await click(item(menu, 'Paste'))
    expect(draft()).toBe('pasted')
    menu = await openMenu()
    await click(item(menu, 'Split Right'))
    expect(ctx.splitLeaf).toHaveBeenLastCalledWith('c1', 'row')
    menu = await openMenu()
    await click(item(menu, 'Split Down'))
    expect(ctx.splitLeaf).toHaveBeenLastCalledWith('c1', 'col')
    menu = await openMenu()
    await click(item(menu, 'Close Pane'))
    expect(ctx.closeLeaf).toHaveBeenCalledWith('c1')
  })

  it('a Tessel path dropped anywhere on the chat lands in the draft as text', async () => {
    await mountPane()
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        types: ['text/x-tessel-path'],
        effectAllowed: 'copy',
        dropEffect: 'none',
        files: [],
        getData: (type) => (type === 'text/x-tessel-path' ? 'C:\\repo\\my file.txt' : '')
      }
    })
    document.querySelector('[data-native-chat-empty-state]').dispatchEvent(drop)
    await settle()
    expect(drop.defaultPrevented).toBe(true)
    expect(draft()).toBe('"C:\\\\repo\\\\my file.txt" ')
    expect(api.send).not.toHaveBeenCalled()
  })
})
