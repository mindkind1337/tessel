// The card a person really sees goes through App.vue's approve(c), which copies a fixed list of
// fields. A field left out of it vanished in the real window while every spec of the card passed:
// these run that code, on what the component really reads.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'

const app = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const component = fs.readFileSync(join(process.cwd(), 'src/renderer/src/components/AgentCommandApproval.vue'), 'utf8')

// The approve() function as App.vue has it, up to the moment it asks.
const start = app.indexOf('async approve(c) {')
const stop = app.indexOf('const answer = await askAgentApproval(card, c.agentLeaf.id)', start)
const CODE = `async function approve(c) {${app.slice(start + 'async approve(c) {'.length, stop)}return card }`

async function cardFor(c) {
  const ctx = {
    t: (key, text) => text,
    remoteHostLabel: () => 'host',
    String
  }
  vm.runInNewContext(`${CODE}\nthis.approve = approve`, ctx)
  return ctx.approve({ agentLeaf: { id: 'a' }, leaf: { id: 'l', cwd: '/p' }, ...c })
}

// What the component reads of its card, from its own text. hostName is the one field of a card made
// elsewhere: a command for a Live Share guest's computer (liveShareCommands.js), never through approve.
// (top and bottom: a local variable named card, the dialog's rectangle.)
const NOT_THROUGH_APPROVE = new Set(['hostName', 'top', 'bottom'])
const read = [...new Set([...component.matchAll(/\bcard\.([a-zA-Z]+)/g)].map((m) => m[1]))].filter((f) => !NOT_THROUGH_APPROVE.has(f))

describe('the card in the real window', () => {
  it('finds the fields the component reads', () => {
    expect(read).toEqual(expect.arrayContaining(['kind', 'command', 'explanation', 'project', 'guests', 'fromGuest']))
  })

  it('every field the component reads gets there', async () => {
    const given = Object.fromEntries(read.map((f) => [f, `value of ${f}`]))
    const card = await cardFor(given)
    const computedHere = new Set(['where', 'folder', 'send', 'pc', 'host', 'open', 'relay'])
    for (const f of read) {
      if (computedHere.has(f)) expect(Object.keys(card), f).toContain(f)
      else expect(card[f], f).toBe(given[f])
    }
  })

  it('it says where it comes from, in Live Share too', async () => {
    const card = await cardFor({ project: 'Shared', guests: ['Alex'], fromGuest: 'Alex' })
    expect(card).toMatchObject({ project: 'Shared', guests: ['Alex'], fromGuest: 'Alex' })
  })

  it('its id comes along: the main process giving up ends the card on screen', async () => {
    expect((await cardFor({ cardId: 'c1' })).cardId).toBe('c1')
  })
})
