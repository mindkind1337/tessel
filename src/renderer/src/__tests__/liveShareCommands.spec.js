import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Live Share, on a guest's computer: the card, then what ran stays in sight.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createHostCommands } from '../liveShareCommands'
import HostCommandsPanel from '../components/HostCommandsPanel.vue'

const ask = { id: 'c1', host: 'Sam', agent: 'Ada', project: 'Site', command: 'Get-Date', why: 'To read the log', goal: 'Crash' }

function setup({ answer = { allow: true }, allowed = true, taken = true, running = null } = {}) {
  const api = { commandAnswer: vi.fn(async () => taken), commandStop: vi.fn(), commandRunning: vi.fn(async () => running) }
  const approve = vi.fn(async () => answer)
  const expire = vi.fn()
  const h = createHostCommands({ api: () => api, approve, expire, allowed: () => allowed })
  return { h, api, approve, expire }
}

describe('a command of the host\'s agent, on the guest\'s side', () => {
  it('asks on a card with the whole command, the reason and who asks', async () => {
    const { h, approve } = setup()
    await h.onAsk(ask)
    expect(approve.mock.calls[0][0]).toMatchObject({ kind: 'hostRun', cardId: 'c1', agentLabel: 'Ada', hostName: 'Sam', project: 'Site', command: 'Get-Date', explanation: 'To read the log', goal: 'Crash', own: false })
  })

  it('allowed: said to main, and shown as running', async () => {
    const { h, api } = setup()
    await h.onAsk(ask)
    expect(api.commandAnswer).toHaveBeenCalledWith({ id: 'c1', allow: true, block: false, timedOut: false })
    expect(h.runs[0]).toMatchObject({ id: 'c1', state: 'running', command: 'Get-Date' })
  })

  it('denied, out of time, or not to be asked again: said to main, nothing shown as running', async () => {
    for (const [answer, sent] of [
      [{ allow: false }, { allow: false, block: false, timedOut: false }],
      [{ allow: false, timedOut: true }, { allow: false, block: false, timedOut: true }],
      [{ allow: false, block: true }, { allow: false, block: true, timedOut: false }],
      [null, { allow: false, block: false, timedOut: false }]
    ]) {
      const { h, api } = setup({ answer })
      await h.onAsk(ask)
      expect(api.commandAnswer).toHaveBeenCalledWith({ id: 'c1', ...sent })
      expect(h.runs).toHaveLength(0)
    }
  })

  it('the setting off: no card at all', async () => {
    const { h, api, approve } = setup({ allowed: false })
    await h.onAsk(ask)
    expect(approve).not.toHaveBeenCalled()
    expect(api.commandAnswer).toHaveBeenCalledWith({ id: 'c1', allow: false, off: true })
  })

  it('too late for main (the session ended behind the card): not shown as running', async () => {
    const { h } = setup({ taken: false })
    await h.onAsk(ask)
    expect(h.runs).toHaveLength(0)
  })

  it('what it printed comes when it ends; the end of the session closes the card', async () => {
    const { h, expire } = setup()
    await h.onAsk(ask)
    h.onRun({ id: 'c1', state: 'completed', exitCode: 3, output: 'done' })
    expect(h.runs[0]).toMatchObject({ state: 'completed', exitCode: 3, output: 'done' })
    h.onRun({ id: 'other', state: 'gone' })
    expect(expire).toHaveBeenCalledWith('other')
    h.onRun({ id: 'unknown', state: 'completed' })
    expect(h.runs).toHaveLength(1)
  })

  it('a window that reloaded keeps a way to stop what runs', async () => {
    const { h, api } = setup({ running: { id: 'c7', host: 'Sam', agent: 'Ada', command: 'Get-Date' } })
    await h.restore()
    expect(h.runs[0]).toMatchObject({ id: 'c7', state: 'running', command: 'Get-Date' })
    h.stop('c7')
    expect(api.commandStop).toHaveBeenCalledWith('c7')
    await h.restore()
    expect(h.runs).toHaveLength(1)
  })

  it('keeps a few, never dropping one still running', async () => {
    const { h } = setup()
    for (let i = 0; i < 8; i++) {
      await h.onAsk({ ...ask, id: `c${i}` })
      if (i > 0) h.onRun({ id: `c${i}`, state: 'completed', exitCode: 0, output: '' })
    }
    expect(h.runs).toHaveLength(5)
    expect(h.runs[0].id).toBe('c0')
    expect(h.runs[0].state).toBe('running')
  })
})

describe('the panel', () => {
  const run = (extra = {}) => ({ id: 'c1', hostName: 'Sam', agent: 'Ada', command: 'Get-Date', state: 'running', exitCode: null, output: '', ...extra })

  it('running: the command, and Stop', async () => {
    const w = mount(HostCommandsPanel, { props: { runs: [run()] } })
    expect(w.text()).toContain('Get-Date')
    expect(w.text()).toContain('Ada')
    expect(w.text()).toContain('Sam')
    await w.find('[data-test="host-command-stop"]').trigger('click')
    expect(w.emitted('stop')[0]).toEqual(['c1'])
    expect(w.find('[data-test="host-command-dismiss"]').exists()).toBe(false)
  })

  it('over: what it printed and that it went back to the agent, and Close', async () => {
    const w = mount(HostCommandsPanel, { props: { runs: [run({ state: 'completed', exitCode: 3, output: 'done' })] } })
    expect(w.find('[data-test="host-command-output"]').text()).toBe('done')
    expect(w.find('[data-test="host-command-state"]').text()).toContain('3')
    expect(w.text()).toContain('sent back')
    await w.find('[data-test="host-command-dismiss"]').trigger('click')
    expect(w.emitted('dismiss')[0]).toEqual(['c1'])
  })
})

// Who is asked in a Live Share session: the person whose computer would run it. These read the
// wiring in App.vue, where a mistake would hand one person's answer to another.
describe('who gets the request', () => {
  const app = readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

  it("a command for a guest's computer is asked in that guest's own window, in the queue of their own cards", () => {
    expect(app).toMatch(/createHostCommands\(\{[\s\S]{0,120}approve: \(card\) => askAgentApproval\(card\)/)
  })

  it("what counts as writing is this window's own keys: a guest's typing on the host goes through the main process, not here", () => {
    const pane = readFileSync(join(process.cwd(), 'src/renderer/src/components/TerminalPane.vue'), 'utf8')
    expect((app.match(/noteUserInput\(/g) || []).length).toBe(3) // its definition and two calls in routeInput
    const route = app.slice(app.indexOf('function routeInput('), app.indexOf('function routeInput(') + 1600)
    expect((route.match(/noteUserInput\(/g) || []).length).toBe(2)
    expect((app.match(/\brouteInput\(/g) || []).length).toBe(1)
    expect(pane).toContain('ctx.routeInput(props.node.id, data)')
    expect(app).not.toMatch(/liveShare[^\n]*routeInput/)
  })
})
