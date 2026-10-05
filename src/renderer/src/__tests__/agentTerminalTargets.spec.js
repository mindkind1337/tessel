import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive } from 'vue'
import { createAgentTerminalTargets } from '../agentTerminal/agentTerminalTargets'
import { fakeTerminal } from './fakeTerminal'

function forEachLeaf(node, fn) {
  if (!node) return
  if (node.type === 'leaf') return fn(node)
  node.children.forEach((c) => forEachLeaf(c, fn))
}

function setup({ typing = false, quality = 'none', respond = true } = {}) {
  const leaf = (id, kind, extra = {}) => ({ type: 'leaf', id, kind, paneName: extra.paneName || id, num: extra.num, shellId: 'pwsh', ...extra })
  const agent = leaf('pane-ada', 'agent', { paneName: 'Ada', num: 1, agentId: 'claude' })
  const shell = leaf('pane-srv', 'shell', { paneName: 'fivem-afterlife', num: 2, remoteHostId: 'ssh-res', shellId: 'pwsh' })
  const peer = leaf('pane-codex', 'agent', { paneName: 'Codex', num: 3, agentId: 'codex' })
  const chat = leaf('pane-chat', 'chat', { paneName: 'Chat', num: 4 })
  const browser = leaf('pane-web', 'browser', { paneName: 'Web' })
  const ws = { id: 'w1', name: 'proj', cwd: 'C:\\proj', tree: { type: 'split', children: [agent, shell, peer, chat, browser] } }
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
    sleep: (ms) => new Promise((r) => setTimeout(r, ms))
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
    // async: a new one.
    const p3 = await settle(ask(targets, { op: 'prepare', mode: 'async' }))
    expect(p3).toMatchObject({ id: 'pane-own-2', isNew: true })
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
