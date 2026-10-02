import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { mount } from '@vue/test-utils'
import { setMessages } from '../i18n'
import { countRunning, quitText, askQuitRunning } from '../quitConfirm'
import { DEFAULT_SETTINGS } from '../settings'
import ConfirmDialog from '../components/ConfirmDialog.vue'

const isAgent = (l) => l.kind === 'agent' || l.kind === 'chat'
const noTerminal = (l) => l.kind === 'editor' || l.kind === 'browser' || l.kind === 'chat'
const fr = JSON.parse(fs.readFileSync(join(__dirname, '..', 'i18n', 'locales', 'fr', 'app.json'), 'utf8'))

const LEAVES = [
  { id: 'a1', kind: 'agent' },
  { id: 'a2', kind: 'agent' },
  { id: 'c1', kind: 'chat' },
  { id: 'a3', kind: 'agent', sleeping: { at: 1 } },
  { id: 'c2', kind: 'chat' }, // asleep (its status)
  { id: 'a4', kind: 'agent', notConnected: { cwd: 'x' } },
  { id: 't1', kind: 'terminal' },
  { id: 't2' },
  { id: 'e1', kind: 'editor' },
  { id: 'b1', kind: 'browser' }
]
const asleep = (l) => l.id === 'c2'

describe('countRunning', () => {
  it('counts agents (terminal and chat) and terminals; not asleep, not connected, editors or browsers', () => {
    expect(countRunning(LEAVES, { isAgent, noTerminal, asleep })).toEqual({ agents: 3, terminals: 2 })
    expect(countRunning([], { isAgent, noTerminal })).toEqual({ agents: 0, terminals: 0 })
  })
})

describe('quitText', () => {
  afterEach(() => setMessages('en', {}))
  it('names what stops, in English', () => {
    expect(quitText({ agents: 3, terminals: 6 })).toBe('3 agents and 6 terminals are running. Quitting stops them. Agent conversations can be resumed later.')
    expect(quitText({ agents: 1, terminals: 0 })).toBe('1 agent is running. Quitting stops it. Agent conversations can be resumed later.')
    expect(quitText({ agents: 0, terminals: 1 })).toBe('1 terminal is running. Quitting stops it.')
    expect(quitText({ agents: 0, terminals: 4 })).toBe('4 terminals are running. Quitting stops them.')
  })
  it('and in French', () => {
    setMessages('fr', fr)
    expect(quitText({ agents: 3, terminals: 6 })).toBe('3 agents et 6 terminaux tournent encore. Quitter les arrête. Les conversations des agents pourront être reprises plus tard.')
    expect(quitText({ agents: 0, terminals: 1 })).toBe('1 terminal tourne encore. Quitter l’arrête.')
  })
})

describe('askQuitRunning', () => {
  function ask(answer, checked = false, settings = { confirmQuitRunning: true }, leaves = LEAVES) {
    const askConfirm = vi.fn(async (opts) => {
      opts.onCheck(checked)
      return answer
    })
    return { settings, askConfirm, run: askQuitRunning({ settings, leaves, isAgent, noTerminal, asleep, askConfirm }) }
  }

  it('the setting is on by default', () => {
    expect(DEFAULT_SETTINGS.confirmQuitRunning).toBe(true)
  })

  it('asks "Quit Tessel?" with Cancel / Quit and "Don\'t ask again"', async () => {
    const { askConfirm, run } = ask(true)
    expect(await run).toBe(true)
    const opts = askConfirm.mock.calls[0][0]
    expect(opts.title).toBe('Quit Tessel?')
    expect(opts.text).toBe('3 agents and 2 terminals are running. Quitting stops them. Agent conversations can be resumed later.')
    expect(opts.confirmLabel).toBe('Quit')
    expect(opts.checkLabel).toBe("Don't ask again")
    expect(opts.danger).toBe(true)
  })

  it('Cancel keeps Tessel open, and leaves the setting on even with the box checked', async () => {
    const { settings, run } = ask(false, true)
    expect(await run).toBe(false)
    expect(settings.confirmQuitRunning).toBe(true)
  })

  it('Quit with "Don\'t ask again" turns the setting off', async () => {
    const { settings, run } = ask(true, true)
    expect(await run).toBe(true)
    expect(settings.confirmQuitRunning).toBe(false)
  })

  it('answers at once when the setting is off or nothing runs', async () => {
    const off = ask(false, false, { confirmQuitRunning: false })
    expect(await off.run).toBe(true)
    expect(off.askConfirm).not.toHaveBeenCalled()
    const idle = ask(false, false, { confirmQuitRunning: true }, [{ id: 'e', kind: 'editor' }, { id: 's', kind: 'agent', sleeping: { at: 1 } }])
    expect(await idle.run).toBe(true)
    expect(idle.askConfirm).not.toHaveBeenCalled()
  })
})

describe('ConfirmDialog checkbox', () => {
  it('sends its state with the answer, and only when asked for', async () => {
    const w = mount(ConfirmDialog, { props: { title: 'Quit Tessel?', confirmLabel: 'Quit', checkLabel: "Don't ask again" } })
    await w.find('[data-test="confirm-check"]').setValue(true)
    await w.findAll('button').at(-1).trigger('click')
    expect(w.emitted('answer')[0]).toEqual([true, true])
    w.unmount()
    const plain = mount(ConfirmDialog, { props: { title: 'x' } })
    expect(plain.find('[data-test="confirm-check"]').exists()).toBe(false)
    await plain.findAll('button')[0].trigger('click')
    expect(plain.emitted('answer')[0]).toEqual([false])
    plain.unmount()
  })
})

describe('App wiring', () => {
  const app = fs.readFileSync(join(__dirname, '..', 'App.vue'), 'utf8')
  it('the close question: acknowledged, unsaved files first, then running agents and terminals', () => {
    const at = app.indexOf('window.shellApi.editor.onConfirmClose(')
    const body = app.slice(at, at + 1400)
    const ack = body.indexOf('ackClose()')
    const editor = body.indexOf('askEditorClose(dirty)')
    const quit = body.indexOf('askQuitRunning(')
    const close = body.indexOf('closeWindow()')
    expect(ack).toBeGreaterThan(0)
    expect(editor).toBeGreaterThan(ack)
    expect(quit).toBeGreaterThan(editor)
    expect(close).toBeGreaterThan(quit)
  })
})
