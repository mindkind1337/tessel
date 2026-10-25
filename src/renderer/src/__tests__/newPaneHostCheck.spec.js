// A pane on an SSH host and the host agent check (App.vue): a new pane waits
// a few seconds at most, a restored pane that must know waits longer, and a
// pane started again in place (restartInPlace) gets one budget for all of it,
// its checks asked beside the terminal's creation, and says what it is doing.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { reactive } from 'vue'

const src = fs.readFileSync(path.resolve(__dirname, '../App.vue'), 'utf8').replace(/\r\n/g, '\n')
const fnSource = (head) => {
  const a = src.indexOf(head)
  const b = src.indexOf('\n}\n', a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${head}`)
  return src.slice(a, b + 3)
}
const constOf = (name) => Number(new RegExp(`const ${name} = (\\d+)`).exec(src)[1])
const REMOTE_LAUNCH = constOf('REMOTE_LAUNCH_CHECK_MS')
const REMOTE_LONG = constOf('REMOTE_CHECK_MS')
const BUDGET = constOf('REMOTE_START_BUDGET_MS')

// askHostAgents + remoteAgentCommand, run: the check never answers, so each
// waits its whole time; -> the time it waited.
async function waited(opts, { now = 1000 } = {}) {
  const waits = []
  const ctx = {
    performance: { now: () => now },
    setTimeout: (fn, ms) => {
      waits.push(ms)
      fn()
      return 1
    },
    clearTimeout: () => {},
    Promise,
    Math,
    window: { shellApi: { remoteAgents: { check: () => new Promise(() => {}) } } },
    remoteAgentTools: {},
    REMOTE_CHECK_MS: REMOTE_LONG,
    REMOTE_LAUNCH_CHECK_MS: REMOTE_LAUNCH,
    needsRemoteAgentCheck: () => true,
    hostShared: () => true,
    remoteAgentFound: () => null,
    remoteAgentLine: (_id, _st, command) => command
  }
  vm.runInNewContext(`${fnSource('async function askHostAgents(')}\n${fnSource('async function remoteAgentCommand(')}\nthis.go = (o) => remoteAgentCommand('ssh-h', 'codex', 'codex', o)`, ctx)
  const line = await ctx.go(opts)
  return { line, ms: waits[0] }
}

describe('the host agent check a pane waits for', () => {
  it('a new pane: a few seconds; a restored pane, or one that must know: the long wait', async () => {
    expect(REMOTE_LAUNCH < REMOTE_LONG).toBe(true)
    expect((await waited({})).ms).toBe(REMOTE_LAUNCH)
    expect((await waited({ restore: true })).ms).toBe(REMOTE_LONG)
    expect((await waited({ strict: true })).ms).toBe(REMOTE_LONG)
    // Not known in time: the agent is started anyway (its command as is).
    expect((await waited({})).line).toBe('codex')
  })

  it('a pane started again: only what is left of its budget, and a strict one keeps the long wait', async () => {
    expect(BUDGET).toBe(10000)
    expect((await waited({ restore: true, deadline: 1000 + BUDGET }, { now: 1000 })).ms).toBe(BUDGET)
    expect((await waited({ restore: true, deadline: 1000 + BUDGET }, { now: 8000 })).ms).toBe(3000)
    // Past it: a moment still (an answer on its way).
    expect((await waited({ restore: true, deadline: 1000 }, { now: 9000 })).ms).toBe(1000)
    expect((await waited({ restore: true, strict: true, deadline: 2000 })).ms).toBe(REMOTE_LONG)
  })

  it('a pane started again asks its checks beside the terminal\'s creation, within the budget from its start', () => {
    const leaf = fnSource('async function createLeaf(')
    const early = leaf.indexOf('earlyCommand = remoteAgentCommand(')
    expect(early).toBeGreaterThan(0)
    expect(early).toBeLessThan(leaf.indexOf('window.shellApi.createPty('))
    expect(leaf).toMatch(/opts\.restart === true && [^\n]*hostShared\(opts\.remoteHostId\)/)
    expect(leaf).toMatch(/deadline: paneT0 \+ REMOTE_START_BUDGET_MS/)
    // Whether its conversation is on the host: asked then too (main answers
    // the start line's question from it).
    expect(leaf.indexOf('remoteAgentSessionExists(opts.remoteHostId, kind, opts.sessionId)')).toBeLessThan(leaf.indexOf('window.shellApi.createPty('))
    expect(leaf).toMatch(/await \(earlyCommand \|\| remoteAgentCommand\(/)
    expect(fnSource('async function restartInPlaceNow(')).toMatch(/restart: true,\s*onStartStep: opts\.onStartStep/)
  })
})

describe('a pane started again on its host says what it is doing', () => {
  function run(old, { fail = false } = {}) {
    const seen = []
    const restarting = new Set()
    const ctx = {
      restartingLeaves: restarting,
      findLeaf: (id) => (id === old.id ? old : null),
      remoteHostLabel: () => 'Box',
      t: (_k, english, vars) => String(english).replace(/\{\{(\w+)\}\}/g, (_m, n) => vars[n]),
      restartInPlaceNow: async (_id, opts) => {
        seen.push(old.startNote)
        if (opts.onStartStep) {
          opts.onStartStep('check')
          seen.push(old.startNote)
          opts.onStartStep('agent')
          seen.push(old.startNote)
        }
        if (fail) throw new Error('x')
        return true
      }
    }
    vm.runInNewContext(`${fnSource('async function restartInPlace(')}\nthis.go = (o) => restartInPlace('${old.id}', o)`, ctx)
    return { go: ctx.go, seen }
  }

  it('setting up its tools, checking the agent, starting it; gone once started', async () => {
    const old = reactive({ id: 'p1', kind: 'agent', title: 'Codex', agentId: 'codex', remoteHostId: 'ssh-h' })
    const r = run(old)
    expect(await r.go({})).toBe(true)
    expect(r.seen).toEqual(['Starting on Box… setting up tools', 'Starting on Box… checking Codex there', 'Starting on Box… starting Codex'])
    expect('startNote' in old).toBe(false)
  })

  it('gone after a failure too; nothing for a pane on this computer or one waiting for Connect', async () => {
    const old = reactive({ id: 'p2', kind: 'agent', title: 'Codex', remoteHostId: 'ssh-h' })
    await expect(run(old, { fail: true }).go({})).rejects.toThrow()
    expect('startNote' in old).toBe(false)
    const local = reactive({ id: 'p3', kind: 'agent', title: 'Codex' })
    const r = run(local)
    await r.go({})
    expect(r.seen).toEqual([undefined])
    const waiting = reactive({ id: 'p4', kind: 'agent', title: 'Codex', remoteHostId: 'ssh-h', notConnected: { cwd: '/x' } })
    const w = run(waiting)
    await w.go({})
    expect(w.seen).toEqual([undefined])
  })
})
