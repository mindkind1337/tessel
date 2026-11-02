// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { otherConnectorsOff } from '../../shared/otherConnectors'
import { buildClaudeArgs } from '../chat/claudeChat'
import { buildCodexArgs } from '../chat/codexChat'

describe("another vendor's connector for what is connected through Tessel", () => {
  const GMAIL = 'connector_2128aebfecb84f64a069897515042a44'

  it('nothing connected: every tool stays', () => {
    expect(otherConnectorsOff('claude', [])).toEqual([])
    expect(otherConnectorsOff('codex', [])).toEqual([])
    expect(otherConnectorsOff('claude')).toEqual([])
  })

  it("Claude Code: only what is connected, each in its own option with =, so no later word is taken for a name", () => {
    const off = otherConnectorsOff('claude', ['google'])
    expect(off).toEqual(['--disallowedTools=mcp__claude_ai_Gmail', '--disallowedTools=mcp__claude_ai_Google_Calendar', '--disallowedTools=mcp__claude_ai_Google_Drive'])
    expect(off.join(' ')).not.toMatch(/[,"']/)
    expect(off.join(' ')).not.toMatch(/Dropbox|GitHub/)
    expect(otherConnectorsOff('claude', ['dropbox'])).toEqual(['--disallowedTools=mcp__claude_ai_Dropbox'])
  })

  it('Codex: its connectors by id, one at a time: never all of them', () => {
    const off = otherConnectorsOff('codex', ['google'])
    expect(off).toContain(`apps.${GMAIL}.enabled=false`)
    expect(off.filter((w) => w === '-c')).toHaveLength(3)
    expect(off.join(' ')).not.toContain('features.apps')
    expect(off.join(' ')).not.toContain('_default')
    expect(otherConnectorsOff('codex', ['github'])).toEqual(['-c', 'apps.connector_76869538009648d5b282a4bb21c3d157.enabled=false'])
  })

  it('a service Codex has no known id for: its connector stays, nothing is guessed', () => {
    expect(otherConnectorsOff('codex', ['dropbox'])).toEqual([])
  })

  it('other agents, unknown services and object keys: nothing', () => {
    for (const agent of ['gemini', 'openclaude', 'antigravity', undefined]) expect(otherConnectorsOff(agent, ['google'])).toEqual([])
    expect(otherConnectorsOff('claude', ['constructor', '__proto__', 'somewhere'])).toEqual([])
  })

  it('in a chat they come before what the agent is asked to do', () => {
    const claude = buildClaudeArgs({ exeArgs: ['cli.js', ...otherConnectorsOff('claude', ['google'])], sessionId: 'a' })
    expect(claude.indexOf('--disallowedTools=mcp__claude_ai_Gmail')).toBeLessThan(claude.indexOf('-p'))
    const codex = buildCodexArgs({ exeArgs: ['codex.js', ...otherConnectorsOff('codex', ['github'])] })
    expect(codex).toEqual(['codex.js', '-c', 'apps.connector_76869538009648d5b282a4bb21c3d157.enabled=false', 'app-server'])
  })
})
