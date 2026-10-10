import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive } from 'vue'
import { createAgentTerminalTargets, paneRunsYolo, placeNear, ownTerminalOf, AUTO_CLOSE_MS, CLOSED_KEEP_MS } from '../agentTerminal/agentTerminalTargets'
import { fakeTerminal } from './fakeTerminal'

function forEachLeaf(node, fn) {
  if (!node) return
  if (node.type === 'leaf') return fn(node)
  node.children.forEach((c) => forEachLeaf(c, fn))
}

function setup({ typing = false, quality = 'none', respond = true, mode = undefined, remote = null } = {}) {
  const leaf = (id, kind, extra = {}) => ({ type: 'leaf', id, kind, paneName: extra.paneName || id, num: extra.num, shellId: 'pwsh', ...extra })
  const agent = leaf('pane-ada', 'agent', { paneName: 'Ada', num: 1, agentId: 'claude' })
  const shell = leaf('pane-srv', 'shell', { paneName: 'fivem-afterlife', num: 2, remoteHostId: 'ssh-res', shellId: 'pwsh' })
  const peer = leaf('pane-codex', 'agent', { paneName: 'Codex', num: 3, agentId: 'codex' })
  const chat = leaf('pane-chat', 'chat', { paneName: 'Chat', num: 4 })
  const browser = leaf('pane-web', 'browser', { paneName: 'Web' })
  const ws = { id: 'w1', name: 'proj', cwd: 'C:\\proj', remote, tree: { type: 'split', children: [agent, shell, peer, chat, browser] } }
  const other = { id: 'w2', name: 'other', cwd: 'C:\\other', tree: { type: 'split', children: [leaf('pane-x', 'shell', { paneName: 'build', num: 1 })] } }
  const terms = new Map()
  const termOf = (id) => {
    if (!terms.has(id)) {
      const t = fakeTerminal({ quality })
      // The shell answers each command: its echo, an output line, the prompt.
      if (respond)
        t.onSend = (text) =>
          setTimeout(() => {
            if (/^\s*\$env:|^\s*export /.test(text)) {
              t.osc('D')
              t.osc('A')
              t.print('\nPS C:\\p> ')
              t.osc('B')
              return
            }
            t.print(`${text}\nresult line\n`)
            if (quality !== 'none') t.osc('D;0')
            if (quality !== 'none') t.osc('A')
            t.print('PS C:\\p> ')
          }, 30)
      terms.set(id, t)
    }
    return terms.get(id)
  }
  const deps = {
    enabled: vi.fn(() => true),
    workspaces: () => [ws, other],
    forEachLeaf,
    getPane: (id) => ({ agentAdapter: () => termOf(id), readText: (n) => `screen of ${id} (${n})`, getSelection: () => 'selected text' }),
    paneLabel: (l) => l.paneName,
    hostLabel: (id) => (id === 'ssh-res' ? 'resources' : id),
    agentName: (l) => (l.agentId === 'codex' ? 'Codex CLI' : 'Claude Code'),
    userTyping: vi.fn(() => typing),
    hosts: () => [{ id: 'ssh-res', label: 'resources', connected: true }, { id: 'ssh-off', label: 'offline', connected: false }],
    createTerminal: vi.fn(async ({ agentLeaf, hostId, number }) => {
      const l = leaf(`pane-own-${number}`, 'shell', { paneName: `Ada · terminal ${number}`, remoteHostId: hostId || null, openedBy: agentLeaf.id })
      ws.tree.children.push(l)
      return l
    }),
    closeTerminal: vi.fn((id) => (ws.tree.children = ws.tree.children.filter((l) => l.id !== id))),
    activeTerminal: () => shell,
    approve: vi.fn(async () => ({ allow: true })),
    dismissApprovals: vi.fn(),
    notifyAgent: vi.fn(),
    toast: vi.fn(),
    stoppedNotice: vi.fn(),
    writePty: vi.fn(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...(mode ? { backgroundMode: () => mode } : {})
  }
  const targets = createAgentTerminalTargets(deps)
  return { targets, deps, ws, terms, termOf, agent, shell, peer }
}

const ask = (targets, req) => targets.handle({ agent: 'pane-ada', ...req })
async function settle(p, ms = 30000) {
  await vi.advanceTimersByTimeAsync(ms)
  return p
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('agent terminals: which terminal', () => {
  it('lists the project\'s terminals: not its own pane, not chats or browsers; others\' on request', async () => {
    const { targets } = setup()
    const r = await ask(targets, { op: 'list' })
    expect(r.terminals.map((t) => t.id)).toEqual(['pane-srv', 'pane-codex'])
    expect(r.terminals[0]).toMatchObject({ kind: 'shell', host: 'resources', name: 'fivem-afterlife' })
    expect(r.terminals[1]).toMatchObject({ kind: 'agent', agentName: 'Codex CLI' })
    const all = await ask(targets, { op: 'list', all: true })
    expect(all.terminals.map((t) => t.id)).toContain('pane-x')
  })

  it('finds a terminal by id, number or name; refuses its own pane and non-terminals', async () => {
    const { targets } = setup()
    for (const ref of ['pane-srv', 2, '#2', 'FIVEM-AFTERLIFE']) expect((await ask(targets, { op: 'resolve', terminal: ref })).id).toBe('pane-srv')
    await expect(ask(targets, { op: 'resolve', terminal: 'pane-ada' })).rejects.toMatchObject({ code: 'own_pane' })
    await expect(ask(targets, { op: 'resolve', terminal: 'pane-chat' })).rejects.toMatchObject({ code: 'not_terminal' })
    await expect(ask(targets, { op: 'resolve', terminal: 'nope' })).rejects.toMatchObject({ code: 'terminal_not_found' })
  })

  it('only an agent pane may call, and only while the setting is on', async () => {
    const { targets, deps } = setup()
    await expect(targets.handle({ agent: 'pane-srv', op: 'list' })).rejects.toMatchObject({ code: 'not_agent' })
    deps.enabled.mockReturnValue(false)
    await expect(ask(targets, { op: 'list' })).rejects.toMatchObject({ code: 'disabled' })
  })
})

describe('agent terminals: writing', () => {
  it('never into another agent\'s pane', async () => {
    const { targets } = setup()
    await expect(ask(targets, { op: 'run', terminal: 'pane-codex', command: 'ls' })).rejects.toMatchObject({ code: 'read_only' })
    await expect(ask(targets, { op: 'send', terminal: 'pane-codex', mode: 'text', data: 'hi' })).rejects.toMatchObject({ code: 'read_only' })
  })

  it('never while the user types in their terminal', async () => {
    const { targets, termOf } = setup({ typing: true })
    await expect(ask(targets, { op: 'run', terminal: 'pane-srv', command: 'ls' })).rejects.toMatchObject({ code: 'user_typing' })
    await expect(ask(targets, { op: 'send', terminal: 'pane-srv', mode: 'text', data: 'y' })).rejects.toMatchObject({ code: 'user_typing' })
    expect(termOf('pane-srv').sent).toEqual([])
  })

  it('runs a command in the user\'s terminal and returns its output', async () => {
    const { targets, termOf } = setup()
    const r = await settle(ask(targets, { op: 'run', terminal: 'pane-srv', command: 'ls -la' }))
    expect(r).toMatchObject({ id: 'pane-srv', state: 'completed', output: 'result line' })
    // Not the agent's own terminal: no leading space.
    expect(termOf('pane-srv').sent).toEqual(['ls -la'])
  })
})

describe('agent terminals: its own', () => {
  it('opens one next to it with the init line, reuses it for sync commands', async () => {
    const { targets, deps, termOf } = setup({ quality: 'basic' })
    const p1 = await settle(ask(targets, { op: 'prepare', mode: 'sync' }))
    expect(p1).toMatchObject({ id: 'pane-own-1', own: true, isNew: true })
    expect(termOf('pane-own-1').sent[0]).toMatch(/^ \$env:AI_AGENT='tessel'/)
    const r = await settle(ask(targets, { op: 'run', terminal: 'pane-own-1', command: 'git status' }))
    expect(r).toMatchObject({ state: 'completed', exitCode: 0, output: 'result line' })
    // Its own terminal: a leading space keeps it out of the history.
    expect(termOf('pane-own-1').sent.at(-1)).toBe(' git status')
    const p2 = await settle(ask(targets, { op: 'prepare', mode: 'sync' }))
    expect(p2).toMatchObject({ id: 'pane-own-1', isNew: false })
    // One terminal per agent (the default): async too, while it is free.
    const p3 = await settle(ask(targets, { op: 'prepare', mode: 'async' }))
    expect(p3).toMatchObject({ id: 'pane-own-1', isNew: false })
    expect(deps.createTerminal).toHaveBeenCalledTimes(1)
  })

  it('a terminal each: an async command opens a new one', async () => {
    const { targets, deps } = setup({ quality: 'basic', mode: 'each' })
    await settle(ask(targets, { op: 'prepare', mode: 'sync' }))
    const p = await settle(ask(targets, { op: 'prepare', mode: 'async' }))
    expect(p).toMatchObject({ id: 'pane-own-2', isNew: true })
    expect(deps.createTerminal).toHaveBeenCalledTimes(2)
  })

  it('on an SSH host whose connection is signed in, not on one that is not', async () => {
    const { targets, deps } = setup({ quality: 'basic' })
    const p = await settle(ask(targets, { op: 'prepare', mode: 'sync', host: 'resources' }))
    expect(p).toMatchObject({ host: 'resources', own: true })
    expect(deps.createTerminal.mock.calls[0][0].hostId).toBe('ssh-res')
    await expect(ask(targets, { op: 'prepare', host: 'offline' })).rejects.toMatchObject({ code: 'host_not_connected' })
    await expect(ask(targets, { op: 'prepare', host: 'nowhere' })).rejects.toMatchObject({ code: 'host_not_found' })
  })

  it('a timed-out command keeps running; the agent is told when it ends', async () => {
    const { targets, deps, termOf } = setup({ quality: 'basic', respond: false })
    const prep = ask(targets, { op: 'prepare', mode: 'sync' })
    // The init line: the shell answers with its prompt.
    await vi.advanceTimersByTimeAsync(1000)
    const t = termOf('pane-own-1')
    t.osc('A')
    t.osc('B')
    await settle(prep, 5000)
    const run = ask(targets, { op: 'run', terminal: 'pane-own-1', command: 'npm run build', timeoutMs: 3000 })
    await vi.advanceTimersByTimeAsync(1500)
    t.print(' npm run build\n')
    t.osc('C')
    t.print('building...')
    const r = await settle(run, 5000)
    expect(r).toMatchObject({ state: 'timeout', id: 'pane-own-1' })
    expect(r.output).toContain('building...')
    expect(deps.notifyAgent).not.toHaveBeenCalled()
    // A sync command now gets another terminal (this one is busy).
    t.print('\ndone\n')
    t.osc('D;0')
    t.osc('A')
    t.print('PS C:\\p> ')
    await vi.advanceTimersByTimeAsync(10000)
    expect(deps.notifyAgent).toHaveBeenCalledTimes(1)
    expect(deps.notifyAgent.mock.calls[0][1]).toMatch(/^\[Terminal pane-own-1 .*notification: command completed with exit code 0\.\]/)
    // Only a short notice: never the output (it goes through the team channel's files).
    expect(deps.notifyAgent.mock.calls[0][1]).not.toContain('done')
    expect(deps.notifyAgent.mock.calls[0][1]).not.toContain('building')
    expect(deps.notifyAgent.mock.calls[0][1]).toContain('Command: npm run build')
    expect(deps.notifyAgent.mock.calls[0][1]).toContain('get_terminal_output with id="pane-own-1"')
    // Its reused sync terminal stays.
    await vi.advanceTimersByTimeAsync(AUTO_CLOSE_MS + 1000)
    expect(deps.closeTerminal).not.toHaveBeenCalled()
  })

  it('a password question: the user is told, nothing is sent', async () => {
    const { targets, deps, termOf } = setup({ respond: false })
    const t = termOf('pane-srv')
    const run = ask(targets, { op: 'run', terminal: 'pane-srv', command: 'sudo ls' })
    await vi.advanceTimersByTimeAsync(1500)
    t.print(' sudo ls\n[sudo] password for me: ')
    const r = await settle(run, 3000)
    expect(r.state).toBe('sensitive')
    expect(deps.toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sensitive', name: 'fivem-afterlife' }))
    expect(t.sent).toEqual(['sudo ls'])
  })

  it('kill_terminal: its own terminals only', async () => {
    const { targets, deps } = setup({ quality: 'basic' })
    await settle(ask(targets, { op: 'prepare', mode: 'sync' }))
    await expect(ask(targets, { op: 'kill', terminal: 'pane-srv' })).rejects.toMatchObject({ code: 'not_own' })
    await ask(targets, { op: 'kill', terminal: 'pane-own-1' })
    expect(deps.closeTerminal).toHaveBeenCalledWith('pane-own-1')
  })

  it('Stop lets the command go and interrupts it in its own terminal', async () => {
    const { targets, deps, termOf } = setup({ quality: 'basic', respond: false })
    const prep = ask(targets, { op: 'prepare', mode: 'sync' })
    await vi.advanceTimersByTimeAsync(1000)
    termOf('pane-own-1').osc('A')
    await settle(prep, 5000)
    const run = ask(targets, { op: 'run', terminal: 'pane-own-1', command: 'sleep 100' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(targets.cancelPane('pane-own-1')).toBe(true)
    const r = await settle(run, 100)
    expect(r.state).toBe('cancelled')
    expect(deps.writePty).toHaveBeenCalledWith('pane-own-1', '\x03')
    // Its next command gets a new terminal.
    const next = ask(targets, { op: 'prepare', mode: 'sync' })
    await vi.advanceTimersByTimeAsync(1000)
    termOf('pane-own-2').osc('A')
    expect(await settle(next, 5000)).toMatchObject({ id: 'pane-own-2', isNew: true })
  })
})

describe('agent terminals: the approval', () => {
  it('answers with plain objects (IPC cannot clone the card\'s reactive ones)', async () => {
    const { targets, deps } = setup()
    deps.approve.mockResolvedValue({ allow: true, action: reactive({ kind: 'prefix', keys: ['git'], scope: 'session' }) })
    const r = await ask(targets, { op: 'approve', terminal: 'pane-srv', card: { kind: 'command', command: 'git log' } })
    expect(() => structuredClone(r)).not.toThrow()
    expect(r).toEqual({ allow: true, command: null, action: { kind: 'prefix', keys: ['git'], scope: 'session' }, remember: 'once' })
  })
})

describe('agent terminals: reading', () => {
  it('the last lines of a terminal it did not run anything in; the active terminal\'s selection', async () => {
    const { targets } = setup()
    expect(await ask(targets, { op: 'output', terminal: 'pane-codex', lines: 30 })).toMatchObject({ output: 'screen of pane-codex (30)', command: null })
    expect(await ask(targets, { op: 'selection', terminal: 'pane-srv' })).toMatchObject({ name: 'fivem-afterlife', text: 'selected text' })
  })

  it('the output of the command it ran', async () => {
    const { targets } = setup()
    await settle(ask(targets, { op: 'run', terminal: 'pane-srv', command: 'uptime' }))
    const r = await ask(targets, { op: 'output', terminal: 'pane-srv' })
    expect(r).toMatchObject({ command: 'uptime', running: false })
    expect(r.output).toContain('result line')
  })
})

describe('security review: opening and abandoning', () => {
  it('past the limit, no new terminal is opened', async () => {
    const { targets, deps } = setup()
    await expect(ask(targets, { op: 'prepare', mode: 'async', mayOpen: false })).rejects.toMatchObject({ code: 'rate_limited' })
    expect(deps.createTerminal).not.toHaveBeenCalled()
  })

  it('an abandoned request lets the agent\'s command go and drops its approval cards', async () => {
    const { targets, deps } = setup({ respond: false })
    const run = ask(targets, { op: 'run', terminal: 'pane-srv', command: 'sleep 100' })
    await vi.advanceTimersByTimeAsync(2000)
    await ask(targets, { op: 'abort' })
    expect(deps.dismissApprovals).toHaveBeenCalledWith('pane-ada')
    expect((await settle(run, 100)).state).toBe('cancelled')
  })
})

describe('security review: reading another project', () => {
  it('get_terminal_output stays in the agent’s own project', async () => {
    const { targets } = setup()
    await expect(ask(targets, { op: 'output', terminal: 'pane-x' })).rejects.toMatchObject({ code: 'other_project' })
    await expect(ask(targets, { op: 'resolve', terminal: 'pane-x', read: true })).rejects.toMatchObject({ code: 'other_project' })
  })
  it('the active terminal is named so it can be approved', async () => {
    const { targets } = setup()
    expect(await ask(targets, { op: 'active' })).toMatchObject({ id: 'pane-srv', name: 'fivem-afterlife' })
    expect(await ask(targets, { op: 'selection', terminal: 'pane-srv' })).toMatchObject({ text: 'selected text' })
  })
})

describe('security review: which host', () => {
  it('says whether a host is the project’s own, without opening anything', async () => {
    const { targets, deps } = setup()
    expect(await ask(targets, { op: 'host', host: 'resources' })).toMatchObject({ hostId: 'ssh-res', label: 'resources', projectHost: false })
    expect(await ask(targets, { op: 'host' })).toMatchObject({ hostId: null, projectHost: true })
    expect(deps.createTerminal).not.toHaveBeenCalled()
    expect((await ask(targets, { op: 'resolve', terminal: 'pane-srv' })).projectHost).toBe(false)
  })
})

describe('security review: the shell of an SSH terminal', () => {
  it('is unknown until the shell says it is bash or zsh', async () => {
    const { targets, termOf } = setup()
    expect((await ask(targets, { op: 'resolve', terminal: 'pane-srv' })).lang).toBe('unknown')
    termOf('pane-srv').osc('P;Shell=bash')
    expect((await ask(targets, { op: 'resolve', terminal: 'pane-srv' })).lang).toBe('bash')
  })
})

describe('security review: the calling pane in Yolo', () => {
  it('says the calling pane\'s Yolo state, from the pane itself, never from the request', async () => {
    const { targets, deps, agent } = setup({ quality: 'basic' })
    deps.agentYolo = (l) => paneRunsYolo(l)
    expect((await settle(ask(targets, { op: 'prepare', mode: 'sync' }))).agentYolo).toBe(false)
    // What the agent sends does not count.
    expect((await settle(ask(targets, { op: 'prepare', mode: 'sync', agentYolo: true, yolo: true }))).agentYolo).toBe(false)
    agent.launchYolo = true
    expect(await settle(ask(targets, { op: 'prepare', mode: 'sync' }))).toMatchObject({ own: true, agentYolo: true, projectHost: true })
    // The user's terminal says it too, but main never skips its card (own: false).
    expect(await ask(targets, { op: 'resolve', terminal: 'pane-srv' })).toMatchObject({ own: false, agentYolo: true })
    // Claude Code as root on an SSH host fell back to Accept edits: not Yolo.
    agent.rootNoYolo = true
    expect((await settle(ask(targets, { op: 'prepare', mode: 'sync' }))).agentYolo).toBe(false)
  })

  it('paneRunsYolo: agent launch flags, root fallback, chat posture, worker cap', () => {
    expect(paneRunsYolo({ kind: 'agent', launchYolo: true })).toBe(true)
    expect(paneRunsYolo({ kind: 'agent', launchYolo: false })).toBe(false)
    expect(paneRunsYolo({ kind: 'agent' })).toBe(false)
    expect(paneRunsYolo({ kind: 'agent', launchYolo: true, rootNoYolo: true })).toBe(false)
    expect(paneRunsYolo({ kind: 'chat', chatPermissions: 'yolo' })).toBe(true)
    expect(paneRunsYolo({ kind: 'chat', chatPermissions: 'manual' })).toBe(false)
    expect(paneRunsYolo({ kind: 'chat', chatPermissions: 'yolo', maxPermissions: 'manual' })).toBe(false)
    expect(paneRunsYolo({ kind: 'shell', launchYolo: true })).toBe(false)
    expect(paneRunsYolo(null)).toBe(false)
  })
})

// The shell's prompt after the init line (respond: false).
async function prepared(targets, termOf, req, id) {
  const p = ask(targets, { op: 'prepare', ...req })
  await vi.advanceTimersByTimeAsync(1000)
  termOf(id).osc('A')
  termOf(id).osc('B')
  return settle(p, 5000)
}
// A command left running in `id` (async): its banner, then quiet.
async function leftRunning(targets, termOf, id, command) {
  const run = ask(targets, { op: 'run', terminal: id, command, mode: 'async', timeoutMs: 20000 })
  await vi.advanceTimersByTimeAsync(1500)
  const t = termOf(id)
  t.print(` ${command}\n`)
  t.osc('C')
  t.print('running...')
  return settle(run, 5000)
}
function finish(t) {
  t.print('\nall done\n')
  t.osc('D;0')
  t.osc('A')
  t.print('PS C:\\p> ')
}

describe('agent terminals: placed in the grid', () => {
  const makeSplit = (dir, children, sizes) => ({ type: 'split', id: `split-${dir}-${children.map((c) => c.id).join('+')}`, dir, sizes, children })
  const own = (id) => ({ type: 'leaf', id, kind: 'shell', openedBy: 'pane-ada' })
  it('the second terminal goes under the first, not splitting the agent again', () => {
    const agent = { type: 'leaf', id: 'pane-ada', kind: 'agent' }
    const other = { type: 'leaf', id: 'pane-x', kind: 'shell' }
    let tree = { type: 'split', id: 'root', dir: 'row', sizes: [50, 50], children: [other, agent] }
    const opts = { forEachLeaf, mine: ownTerminalOf('pane-ada'), makeSplit }
    const t1 = own('t1')
    tree = placeNear(tree, 'pane-ada', t1, opts)
    // The first one: beside the agent.
    expect(tree.children[1]).toMatchObject({ dir: 'row', sizes: [50, 50] })
    expect(tree.children[1].children.map((c) => c.id)).toEqual(['pane-ada', 't1'])
    const t2 = own('t2')
    tree = placeNear(tree, 'pane-ada', t2, opts)
    // The second: under the first, in the same area; the agent keeps its half.
    const pair = tree.children[1]
    expect(pair.sizes).toEqual([50, 50])
    expect(pair.children[0].id).toBe('pane-ada')
    expect(pair.children[1]).toMatchObject({ type: 'split', dir: 'col', sizes: [50, 50] })
    expect(pair.children[1].children.map((c) => c.id)).toEqual(['t1', 't2'])
    const t3 = own('t3')
    tree = placeNear(tree, 'pane-ada', t3, opts)
    // The third: one more equal row there.
    const rows = tree.children[1].children[1]
    expect(rows.children.map((c) => c.id)).toEqual(['t1', 't2', 't3'])
    expect(rows.sizes.map((x) => Math.round(x))).toEqual([33, 33, 33])
    expect(tree.children[1].children[0].id).toBe('pane-ada')
    expect(tree.children[0].id).toBe('pane-x')
  })

  it('the window places its terminals with it (App.vue)', async () => {
    const fs = await import('fs')
    const { join } = await import('path')
    const app = fs.readFileSync(join(__dirname, '..', 'App.vue'), 'utf8').replace(/\r\n/g, '\n')
    expect(app).toContain('ws.tree = placeNear(ws.tree, agentLeaf.id, leaf, { forEachLeaf, mine: ownTerminalOf(agentLeaf.id), makeSplit: makeAgentSplit })')
  })
})

describe('agent terminals: one per agent (the default) and background commands', () => {
  it('a dev server holding its terminal never blocks the next command: one more terminal, the agent told why', async () => {
    const { targets, deps, termOf } = setup({ quality: 'basic', respond: false })
    expect(await prepared(targets, termOf, { mode: 'sync' }, 'pane-own-1')).toMatchObject({ id: 'pane-own-1', isNew: true })
    // async: the same terminal, it is free.
    expect(await prepared(targets, termOf, { mode: 'async' }, 'pane-own-1')).toMatchObject({ id: 'pane-own-1', isNew: false })
    expect(await leftRunning(targets, termOf, 'pane-own-1', 'npm run dev')).toMatchObject({ state: 'background', id: 'pane-own-1' })
    // A sync command now: not queued behind the server.
    const p = await prepared(targets, termOf, { mode: 'sync' }, 'pane-own-2')
    expect(p).toMatchObject({ id: 'pane-own-2', isNew: true, busyWith: { id: 'pane-own-1', command: 'npm run dev' } })
    expect(deps.createTerminal).toHaveBeenCalledTimes(2)
    // That second one is reused for the next sync commands (it is free).
    expect(await prepared(targets, termOf, { mode: 'sync' }, 'pane-own-2')).toMatchObject({ id: 'pane-own-2', isNew: false })
    expect(deps.createTerminal).toHaveBeenCalledTimes(2)
  })

  it('its one terminal stays when its command ends', async () => {
    const { targets, deps, termOf } = setup({ quality: 'basic', respond: false })
    await prepared(targets, termOf, { mode: 'async' }, 'pane-own-1')
    await leftRunning(targets, termOf, 'pane-own-1', 'npm run build -- --watch')
    finish(termOf('pane-own-1'))
    await vi.advanceTimersByTimeAsync(10000 + AUTO_CLOSE_MS)
    expect(deps.notifyAgent).toHaveBeenCalledTimes(1)
    expect(deps.closeTerminal).not.toHaveBeenCalled()
  })
})

describe('agent terminals: a terminal opened for a background command closes when it ends', () => {
  async function background(opts = {}) {
    const env = setup({ quality: 'basic', respond: false, mode: 'each', ...opts })
    const { targets, termOf } = env
    await prepared(targets, termOf, { mode: 'async' }, 'pane-own-1')
    await leftRunning(targets, termOf, 'pane-own-1', 'npm test')
    return env
  }

  it('closes after its command ended, its output still readable with get_terminal_output', async () => {
    const { targets, deps, termOf } = await background()
    finish(termOf('pane-own-1'))
    await vi.advanceTimersByTimeAsync(10000)
    expect(deps.notifyAgent.mock.calls[0][1]).toContain('closes by itself')
    await vi.advanceTimersByTimeAsync(AUTO_CLOSE_MS)
    expect(deps.closeTerminal).toHaveBeenCalledWith('pane-own-1')
    // get_terminal_output: the main process resolves it, then reads it.
    expect(await ask(targets, { op: 'resolve', terminal: 'pane-own-1', read: true })).toMatchObject({ id: 'pane-own-1', own: true, closed: true })
    const out = await ask(targets, { op: 'output', terminal: 'pane-own-1' })
    expect(out).toMatchObject({ closed: true, command: 'npm test', running: false, exitCode: 0 })
    expect(out.output).toContain('all done')
    // Typing there: it is gone, and says so.
    await expect(ask(targets, { op: 'resolve', terminal: 'pane-own-1' })).rejects.toMatchObject({ code: 'terminal_closed' })
    // Kept for a while only.
    await vi.advanceTimersByTimeAsync(CLOSED_KEEP_MS)
    await expect(ask(targets, { op: 'output', terminal: 'pane-own-1' })).rejects.toMatchObject({ code: 'terminal_not_found' })
  })

  it('stays when the user typed in it', async () => {
    const { deps, termOf } = await background()
    termOf('pane-own-1').type()
    finish(termOf('pane-own-1'))
    await vi.advanceTimersByTimeAsync(10000 + AUTO_CLOSE_MS * 2)
    expect(deps.notifyAgent).toHaveBeenCalledTimes(1)
    expect(deps.closeTerminal).not.toHaveBeenCalled()
  })

  it('stays when the user clicked into it, resized or moved it (the window says so)', async () => {
    const { targets, deps, termOf } = await background()
    targets.touch('pane-own-1')
    finish(termOf('pane-own-1'))
    await vi.advanceTimersByTimeAsync(10000 + AUTO_CLOSE_MS * 2)
    expect(deps.closeTerminal).not.toHaveBeenCalled()
  })

  it('a touch during the short wait still keeps it', async () => {
    const { targets, deps, termOf } = await background()
    finish(termOf('pane-own-1'))
    for (let i = 0; i < 100 && !deps.notifyAgent.mock.calls.length; i++) await vi.advanceTimersByTimeAsync(100)
    expect(deps.notifyAgent).toHaveBeenCalledTimes(1)
    targets.touch('pane-own-1')
    await vi.advanceTimersByTimeAsync(AUTO_CLOSE_MS * 2)
    expect(deps.closeTerminal).not.toHaveBeenCalled()
  })

  it('without shell integration it never closes (quiet is not an end)', async () => {
    const { targets, deps, termOf } = setup({ quality: 'none', respond: false, mode: 'each' })
    await settle(ask(targets, { op: 'prepare', mode: 'async' }))
    const t = termOf('pane-own-1')
    const run = ask(targets, { op: 'run', terminal: 'pane-own-1', command: 'npm run dev', mode: 'async' })
    await vi.advanceTimersByTimeAsync(1500)
    t.print(' npm run dev\nready\nPS C:\\p> ')
    expect((await settle(run, 30000)).strategy).toBe('none')
    await vi.advanceTimersByTimeAsync(60000)
    expect(deps.closeTerminal).not.toHaveBeenCalled()
  })

  it('the window sends clicks, resizes and moves (App.vue, SplitNode.vue)', async () => {
    const fs = await import('fs')
    const { join } = await import('path')
    const app = fs.readFileSync(join(__dirname, '..', 'App.vue'), 'utf8').replace(/\r\n/g, '\n')
    expect(app).toContain('watch(activeId, (id) => id && agentTerminalTargets.touch(id))')
    expect(app).toContain("window.addEventListener('tessel-panes-resized', onResized)")
    expect(app).toContain('function movePane(srcId, target) {\n  agentTerminalTargets.touch(srcId)')
    const split = fs.readFileSync(join(__dirname, '..', 'components', 'SplitNode.vue'), 'utf8')
    expect(split).toContain("new CustomEvent('tessel-panes-resized'")
  })
})

describe('Settings > Agents > Terminals: background commands', () => {
  it('one terminal per agent by default, a terminal each on request', async () => {
    const { mount } = await import('@vue/test-utils')
    const { settings, DEFAULT_SETTINGS, loadSettings } = await import('../settings')
    expect(DEFAULT_SETTINGS.agentTerminalBackground).toBe('one')
    const { default: S } = await import('../components/AgentTerminalSettings.vue')
    const w = mount(S, { global: { provide: { askConfirm: async () => true } } })
    const row = w.find('[data-test="settings-terminal-background"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('Background commands')
    expect(w.find('[data-setting="agentTerminalBackground"]').exists()).toBe(true)
    w.unmount()
    {
      const before = settings.agentTerminalBackground
      loadSettings({ agentTerminalBackground: 'bogus' })
      expect(settings.agentTerminalBackground).toBe(before)
      loadSettings({ agentTerminalBackground: 'each' })
      expect(settings.agentTerminalBackground).toBe('each')
      settings.agentTerminalBackground = before
    }
    const fs = await import('fs')
    const { join } = await import('path')
    const app = fs.readFileSync(join(__dirname, '..', 'App.vue'), 'utf8').replace(/\r\n/g, '\n')
    expect(app).toContain("backgroundMode: () => (settings.agentTerminalBackground === 'each' ? 'each' : 'one'),")
    const fr = JSON.parse(fs.readFileSync(join(__dirname, '..', 'i18n', 'locales', 'fr', 'settings.json'), 'utf8').replace(/^\uFEFF/, ''))
    expect(fr.settings.agents.terminalBackgroundOne).toBe('Un terminal par agent')
  })
})
