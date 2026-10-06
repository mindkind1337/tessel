// The empty project's launcher, its logic (projectLauncher.js): what it
// offers, what "When a project opens" starts by itself, what a choice is
// remembered as, what a project whose last pane closed gets, and when a pane
// on an SSH host waits for its host again after a dropped connection.
import { describe, expect, it } from 'vitest'
import {
  allowDropRetry,
  DROP_RETRIES,
  DROP_RETRY_WINDOW_MS,
  droppedRemotePane,
  emptiedWorkspaceChoice,
  launcherAgents,
  launcherShells,
  projectOpenChoice,
  recentProjectSessions,
  rememberedValue,
  remoteAgentFound,
  validProjectOpen
} from '../projectLauncher'
import { DEFAULT_SETTINGS, loadSettings, settings } from '../settings'

const AGENTS = [
  { id: 'claude', name: 'Claude Code', available: true, accent: '#d97757' },
  { id: 'codex', name: 'Codex', available: true },
  { id: 'gemini', name: 'Gemini', available: false },
  { id: 'cursor', name: 'Cursor', available: true }
]
const SHELLS = [
  { id: 'powershell', name: 'PowerShell' },
  { id: 'cmd', name: 'Command Prompt' },
  { id: 'gitbash', name: 'Git Bash' }
]

describe('the setting', () => {
  it('asks by default; only known forms are kept', () => {
    expect(DEFAULT_SETTINGS.projectOpen).toBe('ask')
    for (const v of ['ask', 'terminal', 'terminal:cmd', 'agent:claude']) expect(validProjectOpen(v)).toBe(true)
    for (const v of ['', 'agent:', 'terminal:a b', 'run:x', 3, null, 'agent:' + 'x'.repeat(61)]) expect(validProjectOpen(v)).toBe(false)
    loadSettings({ projectOpen: 'agent:codex' })
    expect(settings.projectOpen).toBe('agent:codex')
    loadSettings({ projectOpen: 'agent:rm -rf' })
    expect(settings.projectOpen).toBe('agent:codex')
    settings.projectOpen = 'ask'
  })
})

describe('what the launcher offers', () => {
  it('here: the installed, enabled agents', () => {
    const list = launcherAgents({ agents: AGENTS, enabled: (id) => id !== 'cursor' })
    expect(list.map((a) => a.id)).toEqual(['claude', 'codex'])
    expect(list[0]).toMatchObject({ name: 'Claude Code', accent: '#d97757', unchecked: false })
  })

  it('on an SSH host: the agents found there (team 4 detection), both unchecked before the host was checked', () => {
    expect(launcherAgents({ agents: AGENTS, remote: true, remoteStatus: null }).map((a) => [a.id, a.unchecked])).toEqual([
      ['claude', true],
      ['codex', true]
    ])
    expect(launcherAgents({ agents: AGENTS, remote: true, remoteStatus: { claude: '/home/me/.local/bin/claude', codex: null } }).map((a) => a.id)).toEqual(['claude'])
    // VS Code's copy of Claude counts.
    expect(remoteAgentFound('claude', { claude: null, vscodeClaude: '/x/claude' })).toBe(true)
    expect(remoteAgentFound('gemini', { claude: 'x' })).toBe(false)
    expect(remoteAgentFound('claude', { error: 'failed' })).toBe(null)
  })

  it('the shells here, the default first; none to choose on a host', () => {
    expect(launcherShells({ shells: SHELLS, selectedShell: 'cmd' }).map((s) => s.id)).toEqual(['cmd', 'powershell', 'gitbash'])
    expect(launcherShells({ shells: SHELLS, selectedShell: 'cmd', remote: true })).toEqual([])
  })

  it("the project's 5 most recent conversations, in its folder and below", () => {
    const rows = [
      { id: 'a', agent: 'claude', cwd: 'C:\\proj', updated: 1 },
      { id: 'b', agent: 'codex', cwd: 'C:\\proj\\sub', updated: 7 },
      { id: 'c', agent: 'claude', cwd: 'C:\\other', updated: 9 },
      ...[2, 3, 4, 5, 6].map((n) => ({ id: `n${n}`, agent: 'claude', cwd: 'c:/proj/', updated: n }))
    ]
    expect(recentProjectSessions(rows, 'C:\\proj').map((s) => s.id)).toEqual(['b', 'n6', 'n5', 'n4', 'n3'])
    expect(recentProjectSessions(rows, null)).toEqual([])
    expect(recentProjectSessions([{ id: 'r', agent: 'claude', cwd: '/srv/app', updated: 1 }], '/srv/app').map((s) => s.id)).toEqual(['r'])
  })
})

describe('what a new project starts by itself', () => {
  const ctx = { agents: AGENTS, shells: SHELLS }
  it('ask: nothing (the launcher)', () => {
    expect(projectOpenChoice('ask', ctx)).toBe(null)
    expect(projectOpenChoice(undefined, ctx)).toBe(null)
  })
  it('a terminal, in the shell remembered (a shell gone since: the default one)', () => {
    expect(projectOpenChoice('terminal', ctx)).toEqual({ kind: 'terminal', shellId: null })
    expect(projectOpenChoice('terminal:gitbash', ctx)).toEqual({ kind: 'terminal', shellId: 'gitbash' })
    expect(projectOpenChoice('terminal:wsl', ctx)).toEqual({ kind: 'terminal', shellId: null })
    expect(projectOpenChoice('terminal:gitbash', { ...ctx, remote: true })).toEqual({ kind: 'terminal', shellId: null })
  })
  it('an agent, when it is here (or on the host); else the launcher', () => {
    expect(projectOpenChoice('agent:claude', ctx)).toEqual({ kind: 'agent', id: 'claude' })
    expect(projectOpenChoice('agent:gemini', ctx)).toBe(null)
    expect(projectOpenChoice('agent:cursor', { ...ctx, remote: true })).toBe(null)
    expect(projectOpenChoice('agent:codex', { ...ctx, remote: true, remoteStatus: { claude: 'x', codex: null } })).toBe(null)
    expect(projectOpenChoice('agent:codex', { ...ctx, remote: true })).toEqual({ kind: 'agent', id: 'codex' })
  })
})

describe('Remember for new projects', () => {
  it('an agent or a terminal (its shell here); not a page or a conversation', () => {
    expect(rememberedValue({ kind: 'agent', id: 'claude' })).toBe('agent:claude')
    expect(rememberedValue({ kind: 'terminal', shellId: 'cmd' })).toBe('terminal:cmd')
    expect(rememberedValue({ kind: 'terminal', shellId: 'cmd' }, { remote: true })).toBe('terminal')
    expect(rememberedValue({ kind: 'terminal', shellId: null })).toBe('terminal')
    expect(rememberedValue({ kind: 'browser' })).toBe(null)
    expect(rememberedValue({ kind: 'session', session: {} })).toBe(null)
  })
})

describe('a project whose last pane closed', () => {
  it('the launcher, unless a terminal is what projects open with', () => {
    expect(emptiedWorkspaceChoice('ask', { shells: SHELLS })).toBe(null)
    expect(emptiedWorkspaceChoice('agent:claude', { shells: SHELLS })).toBe(null)
    expect(emptiedWorkspaceChoice('terminal', { shells: SHELLS })).toEqual({ kind: 'terminal', shellId: null })
    expect(emptiedWorkspaceChoice('terminal:cmd', { shells: SHELLS })).toEqual({ kind: 'terminal', shellId: 'cmd' })
  })
})

describe('a pane on an SSH host after a dropped connection', () => {
  const leaf = { type: 'leaf', id: 'p1', kind: 'agent', remoteHostId: 'ssh-box', pid: 42 }
  it("waits for the host again when ssh ended with 255 (the connection's end)", () => {
    expect(droppedRemotePane(leaf, { exitCode: 255, pid: 42 })).toBe(true)
    expect(droppedRemotePane({ ...leaf, kind: 'shell' }, { exitCode: 255 })).toBe(true)
  })
  it('not a normal end, a local pane, a disconnect on purpose, a late notice, or a pane not running', () => {
    expect(droppedRemotePane(leaf, { exitCode: 0 })).toBe(false)
    expect(droppedRemotePane(leaf, { exitCode: 1 })).toBe(false)
    expect(droppedRemotePane({ ...leaf, remoteHostId: null }, { exitCode: 255 })).toBe(false)
    expect(droppedRemotePane(leaf, { exitCode: 255, userDisconnected: true })).toBe(false)
    expect(droppedRemotePane(leaf, { exitCode: 255, pid: 7 })).toBe(false)
    for (const extra of [{ notConnected: {} }, { sleeping: { at: 1 } }, { failed: 'x' }, { kind: 'chat' }]) expect(droppedRemotePane({ ...leaf, ...extra }, { exitCode: 255 })).toBe(false)
  })
  it(`reopens by itself at most ${DROP_RETRIES} times in a few minutes`, () => {
    let times = []
    for (let i = 0; i < DROP_RETRIES; i++) {
      const r = allowDropRetry(times, 1000 + i)
      expect(r.ok).toBe(true)
      times = r.times
    }
    expect(allowDropRetry(times, 2000).ok).toBe(false)
    expect(allowDropRetry(times, 1000 + DROP_RETRY_WINDOW_MS + 10).ok).toBe(true)
  })
})
