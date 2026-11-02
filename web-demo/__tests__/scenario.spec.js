// @vitest-environment node
// The demo feeds Tessel through the same calls and events as the real main process:
// each one it simulates must exist in the preload, or the demo would be showing a
// channel Tessel no longer has. And the scenario itself must hold together.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSimulator } from '../src/simulator'
import { AVAILABLE_AGENTS, FILES, MODELS, PANES, createScript, savedLayout } from '../src/scenario'
import { agentPresetsFrom } from '../presets.mjs'
import { at, heard, leaves, loadPreloadApi } from './preloadApi'

const repo = join(__dirname, '..', '..')
const src = (p) => readFileSync(join(repo, p), 'utf8')
const agents = agentPresetsFrom(src('src/main/index.js'))
const make = (lang = 'en') => createSimulator({ lang, uiLanguage: lang, agents, notAvailable: 'Not here.', version: '1.0.0', build: { count: 1, hash: 'abcdef0' } })

function leavesOf(tree) {
  return leaves(tree)
}
function leafIds(node, out = []) {
  if (node.type === 'leaf') out.push(node)
  else for (const child of node.children) leafIds(child, out)
  return out
}

describe('the channels the scenario uses', () => {
  it('each simulated call is in src/preload/index.js, as the same kind of thing', async () => {
    const real = await loadPreloadApi()
    const simulated = leavesOf(make().api)
    expect(simulated.length).toBeGreaterThan(40)
    const missing = []
    for (const { path, kind } of simulated) {
      let there
      try {
        there = at(real, path)
      } catch {
        there = undefined
      }
      if (typeof there !== kind) missing.push(`${path}: ${typeof there}`)
    }
    expect(missing).toEqual([])
  })

  it('the output, states and events reach Tessel on the channels main sends them on', async () => {
    const real = await loadPreloadApi()
    const channelOf = (call) => {
      heard.length = 0
      call()
      return heard[0]
    }
    const none = () => {}
    expect(channelOf(() => real.onData(none))).toBe('pty:data')
    expect(channelOf(() => real.onExit(none))).toBe('pty:exit')
    expect(channelOf(() => real.attachPty('pane-x'))).toBe('pty:attach')
    expect(channelOf(() => real.onAgentState(none))).toBe('agents:state')
    expect(channelOf(() => real.loadLayout())).toBe('layout:load')
    expect(channelOf(() => real.taskBoard.load())).toBe('taskboard:load')
    expect(channelOf(() => real.team.requests({}))).toBe('team:requests')
    expect(channelOf(() => real.chat.onEvent(none))).toBe('chat:event')
    expect(channelOf(() => real.chat.approve({}))).toBe('chat:approve')
    // ...and main answers on them.
    const main = src('src/main/index.js')
    for (const channel of ['pty:attach', 'layout:load', 'taskboard:load']) expect(main, channel).toContain(`'${channel}'`)
    expect(src('src/main/chat/sessions.js')).toContain("'chat:event'")
  })
})

describe('the scenario', () => {
  for (const lang of ['en', 'fr']) {
    it(`holds together in ${lang}`, () => {
      const { tasks, agents: scripted, chat } = createScript(lang)
      const cards = new Set(tasks.map((t) => t.id))
      const layout = savedLayout({ uiLanguage: lang })
      const panes = new Set(layout.workspaces.flatMap((w) => leafIds(w.tree)).map((l) => l.id))
      for (const id of Object.values(PANES)) expect(panes, id).toContain(id)
      // Tessel only keeps a saved pane whose id has this shape.
      for (const id of panes) expect(id).toMatch(/^pane-[\w-]+$/)
      for (const task of tasks) if (task.paneId) expect(panes, task.id).toContain(task.paneId)
      expect(cards).toContain(chat.card)
      for (const def of Object.values(scripted)) {
        for (const step of def.steps) {
          if (step.move) expect(cards, step.move[0]).toContain(step.move[0])
          if (step.claim) for (const c of step.claim) expect(cards, c).toContain(c)
        }
      }
    })
  }

  it('is written in both languages: no scripted sentence is left in English in French', () => {
    const en = createScript('en')
    const fr = createScript('fr')
    expect(fr.tasks.map((t) => t.title)).not.toEqual(en.tasks.map((t) => t.title))
    expect(fr.tasks.every((t, i) => t.title !== en.tasks[i].title)).toBe(true)
    expect(fr.chat.reply).not.toBe(en.chat.reply)
    expect(fr.words.agentReply).not.toBe(en.words.agentReply)
  })

  it('names nothing real: only the invented project, none of the names that must not show', () => {
    const text = JSON.stringify([savedLayout({ uiLanguage: 'en' }), createScript('en'), createScript('fr'), FILES])
    expect(text).not.toMatch(/\b(orca|fivem|fivemlab|fiveshield)\b/i)
    expect(text).not.toMatch(/C:\\\\Users/i)
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
  })

  it('its agents are Tessel\'s own, read from the main process', () => {
    expect(agents.length).toBeGreaterThan(20)
    expect((src('src/main/index.js').match(/\n {4}id: '/g) || []).length).toBeGreaterThanOrEqual(agents.length)
    for (const id of AVAILABLE_AGENTS) expect(agents.find((a) => a.id === id).available, id).toBe(true)
    for (const id of Object.keys(MODELS)) expect(agents.some((a) => a.id === id), id).toBe(true)
    expect(agents.find((a) => a.id === 'aider').available).toBe(false)
  })

  it('never leaves the launcher empty if that list changes its shape', () => {
    const fallback = agentPresetsFrom('nothing like the source')
    expect(fallback.map((a) => a.id)).toEqual(AVAILABLE_AGENTS)
  })
})

describe('the simulator', () => {
  it('re-attaches its scripted panes, and starts a new terminal with its prompt', async () => {
    const { api } = make()
    const attached = await api.attachPty(PANES.term)
    expect(attached.ok).toBe(true)
    expect(attached.buffer).toContain('C:\\Projects\\sample-shop')
    expect((await api.attachPty('pane-nobody')).ok).toBe(false)
    const made = await api.createPty({ id: 'pane-new', shellId: 'cmd', cwd: 'C:\\Projects\\sample-shop' })
    expect(made.ok).toBe(true)
    expect(made.shell.id).toBe('cmd')
  })

  it('answers what is typed in a shell, runs nothing', async () => {
    const { api } = make()
    const output = []
    api.onData(({ id, data }) => id === PANES.term && output.push(data))
    api.writePty(PANES.term, 'rm -rf /\r')
    expect(output.join('')).toMatch(/not run/)
  })

  it('moves a card with the request a real agent would leave', async () => {
    const sim = make()
    sim.boardRequests.push({ file: 'x.json', action: 'move', id: 'task-demo-vat', column: 'review', fromId: PANES.ada })
    const res = await sim.api.team.requests({ dir: 'C:\\Projects\\sample-shop', teamId: 'team-demo' })
    expect(res.requests).toHaveLength(1)
    expect((await sim.api.team.requests({ dir: 'C:\\Projects\\sample-shop', teamId: 'team-demo' })).requests).toHaveLength(0)
  })

  it('answers the approval card: the turn goes on and the card moves', async () => {
    const sim = make()
    const events = []
    sim.api.chat.onEvent((m) => events.push(m.event))
    const before = await sim.api.chat.history({ paneId: PANES.dirac })
    const asked = before.events.map((e) => e.event).find((e) => e.type === 'approval')
    expect(asked.status).toBe('pending')
    await sim.api.chat.approve({ paneId: PANES.dirac, requestId: asked.requestId, decision: 'allow' })
    expect(events[0]).toMatchObject({ type: 'approvalStatus', status: 'allowed' })
    sim.stop()
  })

  it('a chat the visitor opens answers too, and forgets when closed', async () => {
    const sim = make()
    const events = []
    sim.api.chat.onEvent((m) => m.paneId === 'pane-new-chat' && events.push(m.event))
    const opened = await sim.api.chat.open({ paneId: 'pane-new-chat', agent: 'codex' })
    expect(opened).toMatchObject({ ok: true, agent: 'codex' })
    expect(events[0]).toMatchObject({ type: 'status', state: 'idle', agent: 'codex' })
    await sim.api.chat.send({ paneId: 'pane-new-chat', text: 'hello' })
    expect(events.some((e) => e.type === 'user' && e.text === 'hello')).toBe(true)
    await sim.api.chat.close({ paneId: 'pane-new-chat', forget: true })
    expect((await sim.api.chat.history({ paneId: 'pane-new-chat' })).events).toEqual([])
    sim.stop()
  })

  it('restarting a scripted pane ends its script: nothing writes to the new terminal', async () => {
    const sim = make()
    sim.api.killPty(PANES.ada)
    const made = await sim.api.createPty({ id: PANES.ada, agentId: 'claude' })
    expect(made.ok).toBe(true)
    expect(sim.terminals.get(PANES.ada).kind).toBe('shell')
    sim.start()
    sim.stop()
  })

  it('keeps the clipboard to itself: nothing here reads the real one', () => {
    const code = src('web-demo/src/simulator.js') + src('web-demo/src/guards.js') + src('web-demo/src/install.js')
    expect(code).not.toMatch(/navigator\.clipboard/)
    expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/)
  })

  it('the page says no network, and the same in the site\'s headers', () => {
    const page = /Content-Security-Policy"\s+content="([^"]+)"/.exec(src('web-demo/index.html'))[1]
    expect(page).toMatch(/connect-src 'none'/)
    const headers = /Content-Security-Policy: ([^\r\n]+)/.exec(src('web-demo/public/_headers'))[1].replace(/; frame-ancestors [^;]*$/, '')
    const norm = (s) => s.replace(/;\s*$/, '').trim()
    expect(norm(headers)).toBe(norm(page))
  })
})
