// Notes and Design Mode feedback typed into an agent's terminal: several
// lines into a terminal whose program did not ask for bracketed paste would
// run line by line as shell commands, so App.vue's notes delivery refuses
// them. Runs App.vue's own send() (as appSettingsBehavior.spec.js does).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { t } from '../i18n'
import { unsafeMultilinePaste } from '../pasteSafety'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

describe('unsafeMultilinePaste', () => {
  const pane = (mode) => ({ bracketedPaste: () => mode })
  it('refuses several lines only when the terminal said no bracketed paste', () => {
    expect(unsafeMultilinePaste('a\nb', pane(false))).toBe(true)
    expect(unsafeMultilinePaste('a\rb', pane(false))).toBe(true)
    expect(unsafeMultilinePaste('a\nb', pane(true))).toBe(false)
    expect(unsafeMultilinePaste('one line', pane(false))).toBe(false)
    // Unknown: no terminal yet, or an older pane without the getter.
    expect(unsafeMultilinePaste('a\nb', pane(null))).toBe(false)
    expect(unsafeMultilinePaste('a\nb', {})).toBe(false)
    expect(unsafeMultilinePaste('a\nb', null)).toBe(false)
    expect(unsafeMultilinePaste(null, pane(false))).toBe(false)
  })
})

describe("App.vue's notes delivery", () => {
  let ctx, delivery, panes
  beforeEach(() => {
    panes = {}
    delivery = null
    ctx = {
      t,
      unsafeMultilinePaste,
      setNotesDelivery: (d) => (delivery = d),
      findLeaf: (id) => (id === 'a1' ? { id: 'a1', title: 'Claude' } : null),
      getPane: (id) => panes[id],
      showToast: vi.fn(),
      deliverToAgent: vi.fn(),
      taskOfPane: () => null,
      updateTask: vi.fn(),
      currentWs: { value: null },
      wsAgents: () => [],
      paneState: () => 'ready',
      noteTargetState: () => ''
    }
    vm.runInNewContext(slice('setNotesDelivery({', '// The agents (not plain shells) of a workspace.'), ctx)
  })

  it('refuses a multi-line message to a terminal without bracketed paste', () => {
    panes.a1 = { bracketedPaste: () => false }
    const onFailed = vi.fn()
    const onDelivered = vi.fn()
    delivery.send('a1', 'line 1\nrm -rf ~', { onDelivered, onFailed })
    expect(ctx.deliverToAgent).not.toHaveBeenCalled()
    expect(onFailed).toHaveBeenCalledTimes(1)
    expect(onDelivered).not.toHaveBeenCalled()
    expect(ctx.showToast).toHaveBeenCalledWith(
      'This terminal would run each line as a command: the agent is not ready for a multi-line message.',
      { kind: 'error', timeout: 8000 }
    )
  })

  it('delivers as before otherwise', () => {
    panes.a1 = { bracketedPaste: () => false }
    delivery.send('a1', 'one line only')
    expect(ctx.deliverToAgent).toHaveBeenCalledWith('a1', 'one line only', expect.objectContaining({ scope: 'notes', waitIdle: true }))

    panes.a1 = { bracketedPaste: () => true }
    delivery.send('a1', 'line 1\nline 2', {})
    expect(ctx.deliverToAgent).toHaveBeenLastCalledWith('a1', 'line 1\nline 2', expect.objectContaining({ scope: 'notes' }))

    delete panes.a1 // no terminal shown: unknown, the queue decides
    delivery.send('a1', 'line 1\nline 2')
    expect(ctx.deliverToAgent).toHaveBeenCalledTimes(3)
  })

  it("the terminal pane tells its bracketed paste mode (xterm's own flag)", () => {
    const terminal = fs.readFileSync(join(process.cwd(), 'src/renderer/src/components/TerminalPane.vue'), 'utf8')
    const api = terminal.slice(terminal.indexOf('paneApi = {'), terminal.indexOf('registerPane(props.node.id, paneApi)'))
    expect(api).toContain('bracketedPaste: () => (term && term.modes ? !!term.modes.bracketedPasteMode : null)')
  })

  it('a pane that is gone: the same toast as before', () => {
    delivery.send('zz', 'x\ny')
    expect(ctx.deliverToAgent).not.toHaveBeenCalled()
    expect(ctx.showToast).toHaveBeenCalledWith('Terminal is no longer available', { kind: 'error' })
  })
})

describe("App.vue's message queue: notes checked again when typed", () => {
  it('notes that waited are dropped (failed) if the terminal lost bracketed paste meanwhile; other messages go on', async () => {
    const pasted = []
    const failed = vi.fn()
    let bracketed = false
    const ctx = {
      unsafeMultilinePaste,
      pendingMessages: {},
      restartingLeaves: new Set(),
      switchingLeaves: new Set(),
      getPane: () => ({ bracketedPaste: () => bracketed }),
      findLeaf: () => ({ id: 'a1' }),
      awaitingApproval: () => false,
      agentStatus: {},
      delivering: new Set(),
      teamPointer: { inFlight: () => false },
      unsent: {},
      userIsTyping: () => false,
      pasteAndConfirm: (id, text) => {
        pasted.push(text)
        return Promise.resolve('confirmed')
      },
      logMessage: () => {},
      requeueDelivery: () => {},
      pendingTimer: 0,
      setTimeout,
      clearTimeout,
      Promise,
      Date,
      Object
    }
    vm.runInNewContext(slice('function flushPending() {', '\nfunction failDelivery(item)') + '\n' + slice('function failDelivery(item)', '\nfunction requeueDelivery'), ctx)
    ctx.pendingMessages.a1 = [
      { text: 'note 1\nnote 2', meta: { multilineSafe: true, onFailed: failed } },
      { text: 'team message\nline 2', meta: {} }
    ]
    ctx.flushPending()
    await new Promise((r) => setTimeout(r, 0))
    expect(failed).toHaveBeenCalledTimes(1)
    expect(pasted).toEqual([])
    ctx.flushPending() // the next one, on the queue's next pass
    await new Promise((r) => setTimeout(r, 0))
    expect(pasted).toEqual(['team message\nline 2'])
    bracketed = true
    ctx.pendingMessages.a1 = [{ text: 'note 1\nnote 2', meta: { multilineSafe: true, onFailed: failed } }]
    ctx.flushPending()
    await new Promise((r) => setTimeout(r, 0))
    expect(pasted).toContain('note 1\nnote 2')
  })
})
