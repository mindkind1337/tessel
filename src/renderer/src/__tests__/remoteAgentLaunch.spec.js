// Starting an agent on an SSH host (remoteAgentLaunch.js): which id it
// starts with (never one in use: "Session ID ... is already in use"), the
// command typed (or none: its install offered; remoteAgentInstalls.spec.js)
// and the "+" menu's agents.
import { describe, expect, it } from 'vitest'
import { claudeStartChoice, codexResumes, hostMenuAgents, hostRunsAsRoot, needsRemoteAgentCheck, remoteAgentLine, hostCodexNoDaemon, remoteCodexNoDaemon, withoutNoDaemon, codexNoDaemonRefusalWatcher } from '../remoteAgentLaunch'

const newId = () => 'new-uuid'

describe('Claude Code: --resume or --session-id', () => {
  it('resuming: the conversation there (or can not tell) is resumed; never written to: same id, fresh', () => {
    expect(claudeStartChoice({ sessionId: 'old', resume: true, exists: true, newId })).toEqual({ resume: true, id: 'old' })
    expect(claudeStartChoice({ sessionId: 'old', resume: true, exists: null, newId })).toEqual({ resume: true, id: 'old' })
    expect(claudeStartChoice({ sessionId: 'old', resume: true, exists: false, newId })).toEqual({ resume: false, id: 'old' })
  })

  it('not resuming ("Resume agents" off): a conversation that exists, or one that can not be checked, gets a new id', () => {
    expect(claudeStartChoice({ sessionId: 'old', resume: false, exists: true, newId })).toEqual({ resume: false, id: 'new-uuid' })
    // The bug: a host pane's transcript is never on this computer; an
    // unchecked host must never get the old id back with --session-id.
    expect(claudeStartChoice({ sessionId: 'old', resume: false, exists: null, newId })).toEqual({ resume: false, id: 'new-uuid' })
    expect(claudeStartChoice({ sessionId: 'old', resume: false, exists: false, newId })).toEqual({ resume: false, id: 'old' })
  })

  it('no id yet: a new one', () => {
    expect(claudeStartChoice({ sessionId: null, resume: true, exists: false, newId })).toEqual({ resume: false, id: 'new-uuid' })
  })
})

describe('Codex: resume <id> unless the host says it is gone', () => {
  it('resumes when it exists or can not be told; a fresh Codex when gone or not resuming', () => {
    expect(codexResumes({ sessionId: 's', resume: true, exists: true })).toBe(true)
    expect(codexResumes({ sessionId: 's', resume: true, exists: null })).toBe(true)
    expect(codexResumes({ sessionId: 's', resume: true, exists: false })).toBe(false)
    expect(codexResumes({ sessionId: 's', resume: false, exists: true })).toBe(false)
    expect(codexResumes({ sessionId: null, resume: true, exists: true })).toBe(false)
  })
})

describe('the command typed on the host', () => {
  it('by the path found there; VS Code Claude as a fallback; missing: none', () => {
    expect(remoteAgentLine('claude', { claude: '/home/u/.local/bin/claude' }, 'claude')).toBe("'/home/u/.local/bin/claude'")
    // In an nvm folder: with the node next to it first on PATH.
    expect(remoteAgentLine('codex', { codex: '/home/u/.nvm/versions/node/v20/bin/codex' }, 'codex')).toBe(`PATH='/home/u/.nvm/versions/node/v20/bin':"$PATH" '/home/u/.nvm/versions/node/v20/bin/codex'`)
    expect(remoteAgentLine('claude', { claude: null, vscodeClaude: '/home/u/.vscode-server/x/claude' }, 'claude')).toBe("'/home/u/.vscode-server/x/claude'")
    expect(remoteAgentLine('codex', { claude: '/c', codex: null, vscodeClaude: '/v' }, 'codex')).toBe(null)
    expect(remoteAgentLine('claude', { claude: null, codex: null, vscodeClaude: null }, 'claude')).toBe(null)
  })

  it('never checked or a failed check: the command as is; a path that is not safe to quote: the command', () => {
    expect(remoteAgentLine('codex', null, 'codex')).toBe('codex')
    expect(remoteAgentLine('codex', { error: 'timeout' }, 'codex')).toBe('codex')
    expect(remoteAgentLine('codex', { codex: "/x/it's/codex" }, 'codex')).toBe('codex')
    expect(remoteAgentLine('gemini', { claude: '/c' }, 'gemini')).toBe('gemini')
  })

  // Found on a server: Antigravity picked in an SSH project, `agy
  // --dangerously-skip-permissions` typed, and the shell said "Command 'agy'
  // not found, but can be installed with: snap install antigravity-cli".
  it('every agent the check looked for: by its path there, its own words kept; missing: none (its card)', () => {
    const status = { claude: null, codex: null, vscodeClaude: null, agents: { antigravity: null, kiro: '/home/u/.local/bin/kiro-cli', grok: '/home/u/.grok/bin/grok', gemini: '/home/u/.nvm/versions/node/v22.11.0/bin/gemini' } }
    expect(remoteAgentLine('antigravity', status, 'agy')).toBe(null)
    expect(remoteAgentLine('kiro', status, 'kiro-cli chat --tui')).toBe("'/home/u/.local/bin/kiro-cli' chat --tui")
    expect(remoteAgentLine('grok', status, 'grok')).toBe("'/home/u/.grok/bin/grok'")
    // In an nvm folder: run with the node next to it, whatever this shell loaded.
    expect(remoteAgentLine('gemini', status, 'gemini')).toBe(`PATH='/home/u/.nvm/versions/node/v22.11.0/bin':"$PATH" '/home/u/.nvm/versions/node/v22.11.0/bin/gemini'`)
    // Not looked for (your own agent): typed as is.
    expect(remoteAgentLine('mine', status, 'mine --x')).toBe('mine --x')
    // Claude Code: VS Code's copy still counts.
    expect(remoteAgentLine('claude', { ...status, agents: { ...status.agents, claude: null }, vscodeClaude: '/home/u/.vscode-server/x/claude' }, 'claude')).toBe("'/home/u/.vscode-server/x/claude'")
  })

  // The login shell (or npm) ran out of time on the host: an agent not found
  // may be in a folder it would have named. Unknown, never "missing".
  it('a partial check: what it found by its path; what it did not, unknown (typed as is, asked again), never its card', () => {
    const status = { partial: true, claude: null, codex: null, agents: { antigravity: null, kiro: '/home/u/.local/bin/kiro-cli' } }
    expect(remoteAgentLine('antigravity', status, 'agy')).toBe('agy')
    expect(remoteAgentLine('kiro', status, 'kiro-cli chat --tui')).toBe("'/home/u/.local/bin/kiro-cli' chat --tui")
    expect(needsRemoteAgentCheck('antigravity', status, { connected: true })).toBe(true)
    expect(hostMenuAgents([{ id: 'antigravity', name: 'Antigravity', available: false }, { id: 'claude', name: 'Claude Code', available: false }], { remote: true, status }).map((a) => [a.id, a.available, !!a.installOnHost])).toEqual([
      ['antigravity', false, false],
      ['claude', true, false]
    ])
  })

  it('root: its saved user, the uid the check reports, or an agent found in /root (an nvm one too)', () => {
    expect(hostRunsAsRoot({ status: { uid: 0 } })).toBe(true)
    expect(hostRunsAsRoot({ status: { uid: 1000 } })).toBe(false)
    expect(hostRunsAsRoot({ command: "PATH='/root/.nvm/versions/node/v22/bin':\"$PATH\" '/root/.nvm/versions/node/v22/bin/claude'" })).toBe(true)
    expect(hostRunsAsRoot({ command: "'/home/u/.local/bin/claude'" })).toBe(false)
  })

  it('asks the host again when missing, or unknown while connected; never when found', () => {
    expect(needsRemoteAgentCheck('antigravity', { agents: { antigravity: null } })).toBe(true)
    expect(needsRemoteAgentCheck('antigravity', { agents: { antigravity: '/home/u/.local/bin/agy' } }, { connected: true })).toBe(false)
    expect(needsRemoteAgentCheck('codex', { codex: null })).toBe(true)
    expect(needsRemoteAgentCheck('codex', null, { connected: true })).toBe(true)
    expect(needsRemoteAgentCheck('codex', null, { connected: false })).toBe(false)
    expect(needsRemoteAgentCheck('codex', { codex: '/usr/bin/codex' }, { connected: true })).toBe(false)
  })
})

describe('the "+" menu on an SSH project', () => {
  const AGENTS = [
    { id: 'claude', name: 'Claude Code', available: true },
    { id: 'codex', name: 'Codex', available: false },
    { id: 'gemini', name: 'Gemini', available: true }
  ]
  it('missing on the host: Install…, not ready; found or not checked: ready there; others as here', () => {
    const list = hostMenuAgents(AGENTS, { remote: true, status: { claude: null, codex: '/usr/bin/codex', vscodeClaude: null } })
    expect(list.map((a) => [a.id, a.available, !!a.installOnHost])).toEqual([
      ['claude', false, true],
      ['codex', true, false],
      ['gemini', true, false]
    ])
    expect(hostMenuAgents(AGENTS, { remote: true, status: null }).map((a) => a.available)).toEqual([true, true, true])
    expect(hostMenuAgents(AGENTS, { remote: false, status: { claude: null } })).toBe(AGENTS)
  })

  it('every agent as the host has it: found there ready (installed here or not); missing: Install… for those you use here, others left out; your own agents as here', () => {
    const agents = [
      { id: 'claude', name: 'Claude Code', available: true },
      { id: 'antigravity', name: 'Antigravity', available: true },
      { id: 'kiro', name: 'Kiro', available: false },
      { id: 'grok', name: 'Grok Build', available: false },
      { id: 'mine', name: 'Mine', available: true, custom: true }
    ]
    const status = { claude: '/usr/bin/claude', agents: { claude: '/usr/bin/claude', antigravity: null, kiro: '/home/u/.local/bin/kiro-cli', grok: null } }
    expect(hostMenuAgents(agents, { remote: true, status }).map((a) => [a.id, a.available, !!a.installOnHost])).toEqual([
      ['claude', true, false],
      ['antigravity', false, true],
      ['kiro', true, false],
      ['grok', false, false],
      ['mine', true, false]
    ])
  })
})

describe("Codex's daemon on a host: --no-daemon from the host's own Codex", () => {
  it('what the host check says: true, false, or null (not checked, failed, its Codex too slow)', () => {
    expect(hostCodexNoDaemon({ host: { codexNoDaemon: true } })).toBe(true)
    expect(hostCodexNoDaemon({ host: { codexNoDaemon: false } })).toBe(false)
    expect(hostCodexNoDaemon({ host: { codexNoDaemon: null } })).toBe(null)
    expect(hostCodexNoDaemon({ host: {} })).toBe(null)
    expect(hostCodexNoDaemon({ error: 'x', host: { codexNoDaemon: true } })).toBe(null)
    expect(hostCodexNoDaemon(null)).toBe(null)
  })
  it("the flag unless the host's Codex is known to refuse it", () => {
    expect(remoteCodexNoDaemon(true)).toBe(true)
    expect(remoteCodexNoDaemon(null)).toBe(true)
    expect(remoteCodexNoDaemon(false)).toBe(false)
  })
  it('the line again without it', () => {
    expect(withoutNoDaemon("'/u/codex' resume abc --no-daemon -c check_for_update_on_startup=false")).toBe("'/u/codex' resume abc -c check_for_update_on_startup=false")
    expect(withoutNoDaemon('codex --no-daemon')).toBe('codex')
    expect(withoutNoDaemon('codex --no-daemonx')).toBe('codex --no-daemonx')
  })
  it("sees an older Codex refusing it (clap's words, colours and a cut chunk), once; nothing else", () => {
    const w = codexNoDaemonRefusalWatcher()
    expect(w("\x1b[1m\x1b[31merror:\x1b[0m unexpected argument '\x1b[33m--no-")).toBe(false)
    expect(w("daemon\x1b[0m' found\r\n")).toBe(true)
    expect(w("error: unexpected argument '--no-daemon' found")).toBe(false)
    const other = codexNoDaemonRefusalWatcher()
    expect(other("error: unexpected argument '--yolo' found\r\nno-daemon in the docs")).toBe(false)
  })
})
