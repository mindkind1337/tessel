// Starting an agent on an SSH host (remoteAgentLaunch.js): which id it
// starts with (never one in use: "Session ID ... is already in use"), the
// command typed (or none: its install offered), the install commands and the
// "+" menu's agents.
import { describe, expect, it } from 'vitest'
import { claudeStartChoice, codexResumes, hostMenuAgents, needsRemoteAgentCheck, remoteAgentLine, remoteInstallCommand } from '../remoteAgentLaunch'

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
    expect(remoteAgentLine('codex', { codex: '/home/u/.nvm/versions/node/v20/bin/codex' }, 'codex')).toBe("'/home/u/.nvm/versions/node/v20/bin/codex'")
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

  it('asks the host again when missing, or unknown while connected; never when found', () => {
    expect(needsRemoteAgentCheck('codex', { codex: null })).toBe(true)
    expect(needsRemoteAgentCheck('codex', null, { connected: true })).toBe(true)
    expect(needsRemoteAgentCheck('codex', null, { connected: false })).toBe(false)
    expect(needsRemoteAgentCheck('codex', { codex: '/usr/bin/codex' }, { connected: true })).toBe(false)
  })
})

describe('installs', () => {
  it('the official commands: Claude installer; Codex by npm when there, else OpenAI standalone installer', () => {
    expect(remoteInstallCommand('claude')).toBe('curl -fsSL https://claude.ai/install.sh | bash && ~/.local/bin/claude')
    const codex = remoteInstallCommand('codex')
    expect(codex).toContain('command -v npm')
    expect(codex).toContain('npm install -g @openai/codex')
    expect(codex).toContain('curl -fsSL https://chatgpt.com/codex/install.sh | sh')
    expect(remoteInstallCommand('gemini')).toBe(null)
    expect(remoteInstallCommand('constructor')).toBe(null)
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
})
