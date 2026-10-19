import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { applyAgentStates, clearAgentStatus, agentStatus } from '../agentStatus'
import {
  createAgentState,
  reduceAgentState,
  publicAgentState
} from '../../../shared/agentStateModel'
import { settings, resetSettings } from '../settings'

const fixture = vi.hoisted(() => ({ terminals: [] }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = options
      this.rows = 24
      this.cols = 80
      this.lines = ['Answer', '❯ ']
      this.pending = []
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      this.buffer = {
        active: {
          baseY: 0,
          viewportY: 0,
          cursorY: 1,
          cursorX: 2,
          length: 24,
          // Rows in `greyed` are drawn dim from their third cell (a prompt's
          // suggestion); the others read as before.
          getNullCell: () => ({}),
          getLine: (index) => ({
            isWrapped: false,
            length: this.cols,
            translateToString: () => this.lines[index] || '',
            getCell: (x) =>
              this.greyed && this.greyed.includes(index)
                ? { getChars: () => (this.lines[index] || '')[x] || '', getWidth: () => 1, isDim: () => x >= 2, isInverse: () => false, isFgDefault: () => x < 2 }
                : { getChars: () => '', getWidth: () => 1, isDim: () => false, isInverse: () => false, isFgDefault: () => true }
          })
        }
      }
      fixture.terminals.push(this)
    }
    write(data, callback) {
      this.pending.push({ data, callback })
    }
    flush(lines) {
      this.lines = lines
      for (const pending of this.pending.splice(0)) pending.callback?.()
    }
    open(host) {
      this.textarea = document.createElement('textarea')
      host.append(this.textarea)
    }
    loadAddon() {}
    registerLinkProvider() {}
    onScroll() {}
    onWriteParsed() {}
    onData() {}
    onResize() {}
    onSelectionChange() {}
    attachCustomKeyEventHandler(fn) {
      this.keyHandler = fn
    }
    paste(data) {
      ;(this.pasted ||= []).push(data)
    }
    focus() {
      this.textarea?.focus()
    }
    dispose() {}
    scrollToBottom() {}
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 80, rows: 24 }
    }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    onDidChangeResults() {}
  }
}))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
import TerminalPane from '../components/TerminalPane.vue'

describe('TerminalPane status integration', () => {
  let wrapper, ctx, state, onData, sequence, previousApi
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(100000)
    previousApi = window.shellApi
    sequence = 0
    fixture.terminals.length = 0
    clearAgentStatus('test-pane')
    resetSettings()
    settings.gpuAcceleration = 'off'
    settings.promptCacheTimer = true
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    state = createAgentState({
      paneId: 'test-pane',
      provider: 'claude',
      launchToken: 'launch',
      startedAt: Date.now()
    })
    const apply = (source, event, extra = {}) => {
      state = reduceAgentState(
        state,
        {
          v: 1,
          id: `e-${++sequence}`,
          paneId: 'test-pane',
          provider: 'claude',
          launchToken: 'launch',
          sessionId: 'session',
          source,
          event,
          at: Date.now(),
          ...extra
        },
        Date.now()
      )
      applyAgentStates({ 'test-pane': publicAgentState(state, Date.now()) })
    }
    window.shellApi = {
      resizePty: vi.fn(),
      onData: (callback) => {
        onData = callback
        return () => {}
      },
      onExit: () => () => {},
      reportAgentScreen: vi.fn((event) => apply('screen', event.event, event))
    }
    ctx = {
      activeId: ref('elsewhere'),
      broadcast: ref(false),
      maximizedId: ref(null),
      highlightId: ref(null),
      voiceName: ref('English'),
      voiceLabel: ref(''),
      voiceLanguages: ref([]),
      notifyAgentDone: vi.fn(),
      notifyAgentLimit: vi.fn(),
      agentReportedDone: vi.fn(),
      teamById: () => null,
      trackOf: () => null,
      setActive: vi.fn()
    }
    wrapper = mount(TerminalPane, {
      props: {
        node: {
          id: 'test-pane',
          kind: 'agent',
          type: 'leaf',
          title: 'Claude',
          agentId: 'claude',
          agentLaunchToken: 'launch'
        }
      },
      global: { provide: { panelCtx: ctx } }
    })
    ctx.hook = (event, extra) => apply('hook', event, extra)
  })
  afterEach(() => {
    wrapper?.unmount()
    clearAgentStatus('test-pane')
    resetSettings()
    window.shellApi = previousApi
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('does not confirm a stale prompt while xterm still has unparsed output', async () => {
    ctx.hook('UserPromptSubmit')
    ctx.hook('Stop')
    onData({ id: 'test-pane', data: 'A continuation is still being rendered' })
    await vi.advanceTimersByTimeAsync(1500)
    expect(
      window.shellApi.reportAgentScreen.mock.calls.some(([event]) => event.event === 'ScreenReady')
    ).toBe(false)
    expect(ctx.notifyAgentDone).not.toHaveBeenCalled()
    fixture.terminals[0].flush(['Working… esc to interrupt', '❯ '])
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStatus['test-pane']).toBe('busy')
    expect(ctx.notifyAgentDone).not.toHaveBeenCalled()
    onData({ id: 'test-pane', data: 'Now the prompt is genuinely ready' })
    fixture.terminals[0].flush(['TASK_COMPLETE', '❯ '])
    await vi.advanceTimersByTimeAsync(1400)
    await nextTick()
    expect(agentStatus['test-pane']).toBe('idle')
    expect(ctx.notifyAgentDone).toHaveBeenCalledTimes(1)
    expect(ctx.agentReportedDone).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.pane-cache').exists()).toBe(true)
    onData({ id: 'test-pane', data: 'A repaint' })
    fixture.terminals[0].flush(['TASK_COMPLETE', '❯ '])
    await vi.advanceTimersByTimeAsync(1400)
    expect(ctx.notifyAgentDone).toHaveBeenCalledTimes(1)
    expect(ctx.agentReportedDone).toHaveBeenCalledTimes(1)
  })

  // A paste that seems to do nothing: Tessel's log says what it was (kind,
  // size, outcome, never the content), and "Confirm paste" keeps the
  // keyboard while it is open, even when the pane is selected meanwhile.
  it('a paste during a turn: logged without its content; Confirm paste keeps the focus', async () => {
    wrapper.unmount()
    window.shellApi.log = vi.fn()
    window.shellApi.saveClipboardImage = vi.fn(async () => 'C:\\Temp\\tessel-paste\\image-1.png')
    window.shellApi.writePty = vi.fn()
    wrapper = mount(TerminalPane, {
      props: { node: { id: 'test-pane', kind: 'agent', type: 'leaf', title: 'Claude', agentId: 'claude', agentLaunchToken: 'launch' } },
      global: { provide: { panelCtx: ctx } },
      attachTo: document.body
    })
    await nextTick()
    const term = fixture.terminals.at(-1)
    term.textarea.classList.add('xterm-helper-textarea')
    ctx.hook('UserPromptSubmit')
    onData({ id: 'test-pane', data: 'Working' })
    term.flush(['Working… esc to interrupt', '❯ '])
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStatus['test-pane']).toBe('busy')
    const paste = (clipboardData) => {
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: clipboardData })
      term.textarea.dispatchEvent(event)
    }
    const logged = () => window.shellApi.log.mock.calls.map((c) => c[1])
    // An image: saved, its path pasted.
    paste({ types: ['Files'], items: [{ kind: 'file', type: 'image/png' }], getData: () => '' })
    await vi.advanceTimersByTimeAsync(0)
    expect(term.pasted).toEqual(['C:\\Temp\\tessel-paste\\image-1.png'])
    expect(logged().at(-1)).toBe('paste in test-pane (agent working): Ctrl+V: image saved, its path pasted')
    // Files copied in the Explorer: nothing to paste, said so.
    paste({ types: ['Files'], items: [{ kind: 'file', type: '' }], getData: () => '' })
    expect(logged().at(-1)).toBe('paste in test-pane (agent working): Ctrl+V: no text or image on the clipboard (Files)')
    // Several lines: asked first, the box has the focus and keeps it.
    paste({ types: ['text/plain'], items: [], getData: () => 'secret one\nsecret two' })
    await nextTick()
    expect(logged().at(-1)).toBe('paste in test-pane (agent working): Ctrl+V: text, 2 lines, 21 chars, confirmation asked')
    const box = document.querySelector('.paste-ask')
    expect(document.activeElement).toBe(box)
    ctx.activeId.value = 'test-pane'
    await nextTick()
    expect(document.activeElement).toBe(box)
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(term.pasted.at(-1)).toBe('secret one\nsecret two')
    expect(logged().at(-1)).toBe('paste in test-pane (agent working): confirmed: text, 2 lines, 21 chars pasted')
    expect(logged().join('\n')).not.toContain('secret')
  })

  // Ctrl+V reads the clipboard itself (the browser's paste event did not
  // always come for an image-only clipboard): an image is saved and its path pasted.
  it('Ctrl+V with only an image on the clipboard: saved, its path pasted, the key never reaches the terminal', async () => {
    wrapper.unmount()
    window.shellApi.log = vi.fn()
    window.shellApi.readClipboard = vi.fn(async () => '')
    window.shellApi.clipboardHasImage = vi.fn(async () => true)
    window.shellApi.saveClipboardImage = vi.fn(async () => 'C:\\Temp\\tessel-paste\\image-2.png')
    window.shellApi.writePty = vi.fn()
    wrapper = mount(TerminalPane, {
      props: { node: { id: 'test-pane', kind: 'agent', type: 'leaf', title: 'Claude', agentId: 'claude', agentLaunchToken: 'launch' } },
      global: { provide: { panelCtx: ctx } },
      attachTo: document.body
    })
    await nextTick()
    const term = fixture.terminals.at(-1)
    const key = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true })
    expect(term.keyHandler(key)).toBe(false)
    expect(key.defaultPrevented).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(term.pasted).toEqual(['C:\\Temp\\tessel-paste\\image-2.png'])
    expect(window.shellApi.log.mock.calls.map((c) => c[1]).at(-1)).toBe('paste in test-pane: Ctrl+V: image saved, its path pasted')
    expect(window.shellApi.writePty).not.toHaveBeenCalledWith('test-pane', '\x16')
  })

  // An agent on an SSH host would read the server's clipboard (a server has
  // none): the image is sent to the host and its path there pasted.
  it('an image pasted in a Codex pane on an SSH host: sent to the host, its path there pasted', async () => {
    wrapper.unmount()
    window.shellApi.log = vi.fn()
    window.shellApi.readClipboard = vi.fn(async () => '')
    window.shellApi.clipboardHasImage = vi.fn(async () => true)
    window.shellApi.saveClipboardImage = vi.fn(async () => 'C:\\Temp\\tessel-paste\\image-3.png')
    window.shellApi.sendClipboardImageToHost = vi.fn(async () => ({ ok: true, path: '/home/deploy/.tessel-server/paste/image-1-abc123.png' }))
    window.shellApi.writePty = vi.fn()
    wrapper = mount(TerminalPane, {
      props: { node: { id: 'test-pane', kind: 'agent', type: 'leaf', title: 'Codex', agentId: 'codex', remoteHostId: 'ssh-1', agentLaunchToken: 'launch' } },
      global: { provide: { panelCtx: ctx } },
      attachTo: document.body
    })
    await nextTick()
    const term = fixture.terminals.at(-1)
    const key = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true })
    expect(term.keyHandler(key)).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(window.shellApi.sendClipboardImageToHost).toHaveBeenCalledWith('ssh-1')
    expect(term.pasted).toEqual(['/home/deploy/.tessel-server/paste/image-1-abc123.png'])
    expect(window.shellApi.saveClipboardImage).not.toHaveBeenCalled()
    expect(window.shellApi.writePty).not.toHaveBeenCalledWith('test-pane', '\x16')
    expect(window.shellApi.log.mock.calls.map((c) => c[1]).at(-1)).toBe('paste in test-pane: Ctrl+V: image sent to the host, its path pasted')
    // Not sent: said, nothing pasted.
    window.shellApi.sendClipboardImageToHost = vi.fn(async () => ({ ok: false, error: 'The image is too large to send (over 20 MB).' }))
    ctx.toast = vi.fn()
    term.keyHandler(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(term.pasted).toHaveLength(1)
    expect(ctx.toast).toHaveBeenCalledWith('The image could not be sent to the host: The image is too large to send (over 20 MB).', expect.objectContaining({ kind: 'error' }))
  })

  // A pane on an SSH host that is not an agent pane (codex typed at a shell
  // prompt there): the image goes to the host too, never the Ctrl+V key
  // that makes the agent read the server's clipboard ("X11 ... unreachable").
  const mountPane = async (node) => {
    wrapper.unmount()
    window.shellApi.log = vi.fn()
    window.shellApi.writePty = vi.fn()
    ctx.toast = vi.fn()
    wrapper = mount(TerminalPane, { props: { node: { type: 'leaf', title: 'Pane', agentLaunchToken: 'launch', ...node } }, global: { provide: { panelCtx: ctx } }, attachTo: document.body })
    await nextTick()
    return fixture.terminals.at(-1)
  }
  const drop = (files) => {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { getData: () => '', types: ['Files'], files } })
    wrapper.find('[data-pane-id]').element.dispatchEvent(event)
  }
  const ctrlV = async (term) => {
    term.keyHandler(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true }))
    await vi.advanceTimersByTimeAsync(0)
  }

  it('an image pasted in a shell pane on an SSH host: sent to the host, its path there pasted; not sent: said, nothing typed', async () => {
    window.shellApi.readClipboard = vi.fn(async () => '')
    window.shellApi.clipboardHasImage = vi.fn(async () => true)
    window.shellApi.sendClipboardImageToHost = vi.fn(async () => ({ ok: true, path: '/home/deploy/.tessel-server/paste/image-2-abc123.png' }))
    const term = await mountPane({ id: 'test-pane', kind: 'shell', remoteHostId: 'ssh-1' })
    await ctrlV(term)
    expect(window.shellApi.sendClipboardImageToHost).toHaveBeenCalledWith('ssh-1')
    expect(term.pasted).toEqual(['/home/deploy/.tessel-server/paste/image-2-abc123.png'])
    expect(window.shellApi.writePty).not.toHaveBeenCalledWith('test-pane', '\x16')
    window.shellApi.sendClipboardImageToHost = vi.fn(async () => ({ ok: false, error: 'not connected' }))
    await ctrlV(term)
    expect(term.pasted).toHaveLength(1)
    expect(window.shellApi.writePty).not.toHaveBeenCalled()
    expect(ctx.toast).toHaveBeenCalledWith('The image could not be sent to the host: not connected', expect.objectContaining({ kind: 'error' }))
  })

  it('an image file dropped on a pane on an SSH host: sent there, its path there pasted with the other files\u2019; not sent: said', async () => {
    window.shellApi.pathForFile = (f) => f.path
    window.shellApi.sendImageFileToHost = vi.fn(async () => ({ ok: true, path: '/home/deploy/.tessel-server/paste/image-3-def456.png' }))
    const term = await mountPane({ id: 'test-pane', kind: 'agent', agentId: 'codex', remoteHostId: 'ssh-1' })
    drop([{ path: 'C:\\Users\\me\\shot.png' }, { path: 'C:\\Users\\me\\notes.txt' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(window.shellApi.sendImageFileToHost).toHaveBeenCalledWith('ssh-1', 'C:\\Users\\me\\shot.png')
    expect(window.shellApi.sendImageFileToHost).toHaveBeenCalledTimes(1)
    expect(term.pasted).toEqual(['/home/deploy/.tessel-server/paste/image-3-def456.png C:\\Users\\me\\notes.txt '])
    window.shellApi.sendImageFileToHost = vi.fn(async () => ({ ok: false, error: 'not connected' }))
    drop([{ path: 'C:\\Users\\me\\shot.png' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(term.pasted).toHaveLength(1)
    expect(window.shellApi.writePty).not.toHaveBeenCalled()
    expect(ctx.toast).toHaveBeenCalledWith('The image could not be sent to the host: not connected', expect.objectContaining({ kind: 'error' }))
  })

  // Live Share: a host's pane in a guest's window. The guest's path would
  // be meaningless on the host: the image goes to the host (main), which
  // pastes its own copy's path.
  const guestNode = (canType = true) => ({ id: 'test-pane', kind: 'agent', agentId: 'claude', backend: 'liveshare', liveShare: { session: 1, project: 'ws-1', cols: 80, rows: 24, kind: 'agent', agentId: 'claude', canType, host: 'Cedric', terminal: true, view: 'terminal', textSize: 'fit' } })

  it('a guest pastes an image in a host\u2019s pane: sent to the host, nothing saved or pasted here; refused: said', async () => {
    window.shellApi.readClipboard = vi.fn(async () => '')
    window.shellApi.clipboardHasImage = vi.fn(async () => true)
    window.shellApi.saveClipboardImage = vi.fn(async () => 'C:\\Temp\\tessel-paste\\image-9.png')
    window.shellApi.liveShare = { pasteImage: vi.fn(async () => ({ ok: true })) }
    const term = await mountPane(guestNode())
    await ctrlV(term)
    expect(window.shellApi.liveShare.pasteImage).toHaveBeenCalledWith('test-pane', {})
    expect(window.shellApi.saveClipboardImage).not.toHaveBeenCalled()
    expect(term.pasted || []).toEqual([])
    expect(window.shellApi.writePty).not.toHaveBeenCalled()
    expect(window.shellApi.log.mock.calls.map((c) => c[1]).at(-1)).toBe('paste in test-pane: Ctrl+V: image sent to the Live Share host, its path pasted there')
    window.shellApi.liveShare.pasteImage = vi.fn(async () => ({ ok: false, code: 'forbidden' }))
    await ctrlV(term)
    expect(ctx.toast).toHaveBeenCalledWith('Cedric has not let you type in this pane: the image was not pasted.', expect.objectContaining({ kind: 'error' }))
    window.shellApi.liveShare.pasteImage = vi.fn(async () => ({ ok: false, code: 'too-large' }))
    await ctrlV(term)
    expect(ctx.toast).toHaveBeenLastCalledWith('The image is too large to send (10 MB and 8000 × 8000 pixels at most).', expect.objectContaining({ kind: 'error' }))
  })

  it('a guest without the right to type: nothing sent, said why', async () => {
    window.shellApi.readClipboard = vi.fn(async () => '')
    window.shellApi.clipboardHasImage = vi.fn(async () => true)
    window.shellApi.liveShare = { pasteImage: vi.fn(async () => ({ ok: true })) }
    const term = await mountPane(guestNode(false))
    await ctrlV(term)
    expect(window.shellApi.liveShare.pasteImage).not.toHaveBeenCalled()
    expect(ctx.toast).toHaveBeenCalledWith('Cedric has not let you type in this pane: the image was not pasted.', expect.objectContaining({ kind: 'error' }))
  })

  it('a guest drops files on a host\u2019s pane: images sent like a pasted one, no path of this computer typed there', async () => {
    window.shellApi.pathForFile = (f) => f.path
    window.shellApi.liveShare = { pasteImage: vi.fn(async () => ({ ok: true })) }
    await mountPane(guestNode())
    drop([{ path: 'C:\\Users\\me\\shot.png' }, { path: 'C:\\Users\\me\\secret.txt' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(window.shellApi.liveShare.pasteImage).toHaveBeenCalledTimes(1)
    expect(window.shellApi.liveShare.pasteImage).toHaveBeenCalledWith('test-pane', { file: 'C:\\Users\\me\\shot.png' })
    expect(window.shellApi.writePty).not.toHaveBeenCalled()
    expect(ctx.toast).toHaveBeenCalledWith('Only images can be dropped on a host’s pane.', expect.anything())
  })

  it('host: a guest\u2019s image saved here is pasted as a local one (Claude Code\u2019s path; an SSH host\u2019s own copy)', async () => {
    const { getPane } = await import('../paneRegistry')
    let term = await mountPane({ id: 'test-pane', kind: 'agent', agentId: 'claude' })
    await expect(getPane('test-pane').pasteImageFile('C:\\Temp\\tessel-paste\\guest-image-1-ab12cd34.png')).resolves.toEqual({ ok: true })
    expect(term.pasted).toEqual(['C:\\Temp\\tessel-paste\\guest-image-1-ab12cd34.png'])
    window.shellApi.sendImageFileToHost = vi.fn(async () => ({ ok: true, path: '/home/deploy/.tessel-server/paste/image-4-aa11bb.png' }))
    term = await mountPane({ id: 'test-pane', kind: 'agent', agentId: 'codex', remoteHostId: 'ssh-1' })
    await expect(getPane('test-pane').pasteImageFile('C:\\Temp\\tessel-paste\\guest-image-2-ab12cd34.png')).resolves.toEqual({ ok: true })
    expect(window.shellApi.sendImageFileToHost).toHaveBeenCalledWith('ssh-1', 'C:\\Temp\\tessel-paste\\guest-image-2-ab12cd34.png')
    expect(term.pasted).toEqual(['/home/deploy/.tessel-server/paste/image-4-aa11bb.png'])
    window.shellApi.sendImageFileToHost = vi.fn(async () => ({ ok: false, error: 'not connected' }))
    await expect(getPane('test-pane').pasteImageFile('C:\\Temp\\tessel-paste\\guest-image-3-ab12cd34.png')).resolves.toEqual({ ok: false, code: 'failed' })
    expect(term.pasted).toHaveLength(1)
  })

  // The suggestion is read again 3 s after a turn ends; a new turn started
  // meanwhile cancels that read (else it reads the screen mid-turn).
  it("a turn started within 3 s of the last one's end cancels the suggestion's late read", async () => {
    ctx.hook('UserPromptSubmit')
    ctx.hook('Stop')
    onData({ id: 'test-pane', data: 'Done' })
    fixture.terminals[0].flush(['Answer', '❯ '])
    await vi.advanceTimersByTimeAsync(1400)
    await nextTick()
    expect(agentStatus['test-pane']).toBe('idle')
    // A new turn at once; its screen shows a greyed prompt row meanwhile.
    ctx.hook('UserPromptSubmit')
    const term = fixture.terminals[0]
    term.greyed = [23]
    onData({ id: 'test-pane', data: 'Working' })
    term.flush([...Array(22).fill(''), 'Working… esc to interrupt', '> push the release'])
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStatus['test-pane']).toBe('busy')
    await vi.advanceTimersByTimeAsync(3000)
    expect(wrapper.vm.promptSuggestion).toBe('')
  })

  it('renders missing managed state honestly and does not turn a silent tool into a completed answer', async () => {
    expect(wrapper.text()).toContain('unknown')
    ctx.hook('UserPromptSubmit')
    onData({ id: 'test-pane', data: 'Running a silent tool' })
    fixture.terminals[0].flush(['Running a silent tool', ''])
    await vi.advanceTimersByTimeAsync(15000)
    await nextTick()
    expect(wrapper.get('.pane-working').text()).toBe('working')
    expect(ctx.notifyAgentDone).not.toHaveBeenCalled()
    expect(wrapper.find('.pane-cache').exists()).toBe(false)
  })

  it('labels the actual approval state in the status description (the hover card shows it)', async () => {
    ctx.hook('UserPromptSubmit')
    ctx.hook('Notification', { notificationType: 'permission_prompt' })
    await nextTick()
    expect(wrapper.get('.pane-icon').attributes('aria-description')).toContain('Main agent state: approval.')
    expect(wrapper.text()).toContain('approve?')
  })

  it('the header stops showing working once the Stop settled, with no new event', async () => {
    ctx.hook('UserPromptSubmit')
    ctx.hook('Stop')
    await nextTick()
    expect(wrapper.find('.pane-working').exists()).toBe(true)
    // Main publishes a snapshot on each scan; only the clock moves.
    for (let i = 0; i < 44; i++) {
      await vi.advanceTimersByTimeAsync(500)
      applyAgentStates({ 'test-pane': publicAgentState(state, Date.now()) })
    }
    await nextTick()
    expect(agentStatus['test-pane']).toBe('idle')
    expect(wrapper.find('.pane-working').exists()).toBe(false)
    expect(wrapper.get('.pane-icon').attributes('aria-description')).toContain('Main agent state: idle.')
  })

  it('does not use a restored terminal prompt as fresh completion evidence', async () => {
    ctx.hook('UserPromptSubmit')
    ctx.hook('Stop')
    // The mock starts with an old visible empty prompt, like a history replay.
    // No live PTY write has been parsed for this component yet.
    await vi.advanceTimersByTimeAsync(2000)
    expect(window.shellApi.reportAgentScreen).not.toHaveBeenCalled()
    expect(ctx.notifyAgentDone).not.toHaveBeenCalled()
    expect(agentStatus['test-pane']).toBe('busy')
  })
})
