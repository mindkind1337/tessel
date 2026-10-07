// @vitest-environment node
// Why an agent on an SSH host has no Tessel tools, said in its pane.
import { describe, it, expect } from 'vitest'
import { remoteToolsReason, remoteInstallErrorFor, REMOTE_TOOLS_CODES } from '../remoteToolsReason'

const t = (_k, en, vars) => String(en).replace(/\{\{(\w+)\}\}/g, (_m, n) => (vars && n in vars ? String(vars[n]) : ''))
const why = (reason, detail) => remoteToolsReason(t, reason, detail, { noNodeError: () => 'no node here' })

describe('remoteToolsReason', () => {
  it('names each cause, never an empty text', () => {
    expect(why('no-node')).toMatch(/Node\.js 18 or newer was not found on the host.*VS Code/)
    expect(why('old-node')).toMatch(/older than 18/)
    expect(why('local-node')).toBe('no node here')
    expect(why('system-ssh')).toMatch(/system ssh/)
    expect(why('skipped', 'codex')).toMatch(/^Codex has no settings/)
    expect(why('skipped', 'claude')).toMatch(/^Claude Code has no settings/)
    expect(why('bind')).toMatch(/AllowStreamLocalForwarding/)
    expect(why('config', '/root/.claude.json: not a JSON object')).toMatch(/\/root\/\.claude\.json: not a JSON object/)
    expect(why('failed', 'boom\u0007\nnext')).toBe('they could not be set up on the host (boom next).')
    expect(why('failed')).toBe('they could not be set up on the host.')
    for (const code of [...REMOTE_TOOLS_CODES, 'timeout', 'old-host', 'whatever']) expect(why(code).length).toBeGreaterThan(10)
  })
})

describe('remoteInstallErrorFor', () => {
  it('only the file that registers that agent\'s MCP server', () => {
    const result = { ok: false, errors: ['/root/.claude/settings.json: not a JSON object, left as it is', '/root/.codex/config.toml: bad'] }
    expect(remoteInstallErrorFor(result, 'claude')).toBe('')
    expect(remoteInstallErrorFor(result, 'codex')).toBe('/root/.codex/config.toml: bad')
    expect(remoteInstallErrorFor({ errors: ['/root/.claude.json: not a JSON object, left as it is'] }, 'claude')).toMatch(/claude\.json/)
    expect(remoteInstallErrorFor(null, 'claude')).toBe('')
  })
})
