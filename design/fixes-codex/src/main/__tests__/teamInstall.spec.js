// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import { installClaudeHooks, installCodexServer } from '../teamInstall'

describe('team setup preserves existing agent configuration', () => {
  let fixtureHome
  const script = 'C:\\Users\\Example\\AppData\\Roaming\\tessel\\tessel-team-mcp.cjs'
  const accepted = async () => ({ ok: true })
  const configFile = () => join(fixtureHome, '.codex', 'config.toml')
  const settingsFile = () => join(fixtureHome, '.claude', 'settings.json')
  beforeEach(() => {
    fixtureHome = fs.mkdtempSync(join(os.tmpdir(), 'tessel-install-regression-'))
    fs.mkdirSync(join(fixtureHome, '.codex'))
    fs.mkdirSync(join(fixtureHome, '.claude'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    const target = resolve(fixtureHome)
    if (
      !target.startsWith(resolve(os.tmpdir()) + sep) ||
      !target.includes('tessel-install-regression-')
    )
      throw new Error('Unexpected test cleanup path')
    fs.rmSync(target, { recursive: true, force: true })
  })

  it('keeps unrelated hooks and group settings when replacing a stale Tessel hook', () => {
    const ownOld = { type: 'command', command: 'node "C:\\old\\tessel-team-mcp.cjs" --hook' }
    const other = { type: 'command', command: 'my-existing-hook.cmd', timeout: 37 }
    const group = { matcher: 'Write|Edit', hooks: [ownOld, other], custom: 'keep' }
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ model: 'chosen', hooks: { PostToolUse: [group] } })
    )
    expect(installClaudeHooks(script, fixtureHome).error).toBeUndefined()
    const cfg = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    expect(cfg.model).toBe('chosen')
    expect(cfg.hooks.PostToolUse).toContainEqual({ ...group, hooks: [other] })
    expect(
      cfg.hooks.PostToolUse.flatMap((g) => g.hooks).filter((h) =>
        h.command.includes('tessel-team-mcp.cjs')
      )
    ).toHaveLength(1)
  })

  it('reports unreadable settings without changing them', () => {
    fs.writeFileSync(settingsFile(), '{ invalid JSON')
    const result = installClaudeHooks(script, fixtureHome)
    expect(result.error).toBeTruthy()
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{ invalid JSON')
  })

  it.each(['[mcp_servers."tessel-team"]', "[mcp_servers.'tessel-team']"])(
    'updates the existing server spelled %s without retaining the old definition',
    async (header) => {
      const unrelated =
        '# Keep the user preference\nmodel = "chosen-model"\n\n[mcp_servers.other]\ncommand = "other-tool"\n'
      fs.writeFileSync(
        configFile(),
        unrelated + '\n' + header + '\ncommand = "old-node"\nargs = ["old.cjs"]\n'
      )
      const result = await installCodexServer(script, accepted, fixtureHome)
      expect(result.error).toBeUndefined()
      expect(result.changed).toBe(true)
      const next = fs.readFileSync(configFile(), 'utf8')
      expect(next).toContain(unrelated)
      expect(next).not.toContain('old-node')
      expect(next).not.toContain('old.cjs')
      expect(next).toContain('TESSEL_PANE_ID')
      expect(next).toContain('TESSEL_PROJECT_DIR')
    }
  )

  it('does not write a candidate rejected by the Codex validator', async () => {
    const original = 'model = "chosen-model"\n'
    fs.writeFileSync(configFile(), original)
    const validate = vi.fn(async () => ({ ok: false, error: 'invalid TOML' }))
    const result = await installCodexServer(script, validate, fixtureHome)
    expect(validate).toHaveBeenCalledOnce()
    expect(result.error).toMatch(/invalid TOML/)
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(original)
  })

  it('migrates the old Tessel env subtable without affecting another server', async () => {
    const other =
      '[mcp_servers.other]\ncommand = "other-tool"\n[mcp_servers.other.env]\nKEEP = "untouched"\n'
    fs.writeFileSync(
      configFile(),
      '[mcp_servers."tessel-team"]\ncommand = "old-node"\n[mcp_servers."tessel-team".env]\nTESSEL_PANE_ID = "stale-pane"\n' +
        other
    )
    const result = await installCodexServer(script, accepted, fixtureHome)
    expect(result).toEqual({ changed: true })
    const next = fs.readFileSync(configFile(), 'utf8')
    expect(next).toContain(other)
    expect(next).not.toContain('stale-pane')
    expect(next).toContain('env_vars = ["TESSEL_PANE_ID", "TESSEL_PROJECT_DIR"]')
  })

  it('backs up the original configuration once and leaves an up-to-date setup untouched', async () => {
    const original = 'model = "chosen-model"\n'
    fs.writeFileSync(configFile(), original)
    expect(await installCodexServer(script, accepted, fixtureHome)).toEqual({ changed: true })
    const installed = fs.readFileSync(configFile(), 'utf8')
    const validate = vi.fn(accepted)
    expect(await installCodexServer(script, validate, fixtureHome)).toEqual({ changed: false })
    expect(validate).not.toHaveBeenCalled()
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(installed)
    expect(fs.readFileSync(configFile() + '.before-tessel', 'utf8')).toBe(original)
    expect(
      await installCodexServer('C:\\updated\\tessel-team-mcp.cjs', accepted, fixtureHome)
    ).toEqual({ changed: true })
    expect(fs.readFileSync(configFile() + '.before-tessel', 'utf8')).toBe(original)
    expect(fs.readFileSync(configFile(), 'utf8')).toContain('updated')
  })

  it('does not rewrite an unchanged hook setup or replace its original backup', () => {
    const original = JSON.stringify({
      model: 'chosen',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.cmd' }] }] }
    })
    fs.writeFileSync(settingsFile(), original)
    expect(installClaudeHooks(script, fixtureHome)).toEqual({ changed: true })
    const installed = fs.readFileSync(settingsFile(), 'utf8')
    expect(installClaudeHooks(script, fixtureHome)).toEqual({ changed: false })
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(installed)
    expect(fs.readFileSync(settingsFile() + '.before-tessel', 'utf8')).toBe(original)
    expect(installClaudeHooks('C:\\updated\\tessel-team-mcp.cjs', fixtureHome)).toEqual({
      changed: true
    })
    expect(fs.readFileSync(settingsFile() + '.before-tessel', 'utf8')).toBe(original)
    expect(fs.readFileSync(settingsFile(), 'utf8')).toContain('mine.cmd')
  })

  it('leaves the config intact if the validator itself fails', async () => {
    const original = 'model = "chosen-model"\n'
    fs.writeFileSync(configFile(), original)
    await expect(
      installCodexServer(
        script,
        async () => {
          throw new Error('Codex unavailable')
        },
        fixtureHome
      )
    ).rejects.toThrow('Codex unavailable')
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(original)
  })
})
