// @vitest-environment node
// Settings > "Remove Tessel hooks", and how Tessel writes the agents' files
// (their mode and symbolic links kept). Temporary fake homes only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { dirname, join, resolve, sep } from 'path'
import {
  installClaudeHooks,
  installCodexHooks,
  installGeminiHooks,
  installCopilotHooks,
  installOpencodePlugin,
  installKimiHooks,
  removeTeamHooks
} from '../teamInstall'
import { kimiConfigFile } from '../kimiHooks'
import { writeFileAtomic } from '../safeJson'

const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const script = 'C:\\Tessel data\\tessel-team-mcp.cjs'
let dir, home
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-hook-removal-'))
  home = join(dir, 'home')
  fs.mkdirSync(home)
})
afterEach(() => {
  const target = resolve(dir)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-hook-removal-')) throw new Error('Unsafe fixture path')
  fs.rmSync(target, { recursive: true, force: true })
})
const put = (file, value) => {
  fs.mkdirSync(dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

describe('removing Tessel hooks', () => {
  it("takes out only Tessel's entries and files, and the copies it kept", async () => {
    const mine = { matcher: '', hooks: [{ type: 'command', command: 'mine.cmd' }] }
    const claude = join(home, '.claude', 'settings.json')
    const codex = join(home, '.codex', 'hooks.json')
    const gemini = join(home, '.gemini', 'settings.json')
    put(claude, { model: 'x', hooks: { Stop: [mine] } })
    put(codex, { hooks: { Stop: [mine] } })
    put(gemini, { mcpServers: { a: { command: 'b' } } })
    const kimi = kimiConfigFile(home, '')
    put(kimi, 'default_model = "mine"\n')
    expect(installClaudeHooks(script, home, { node: NODE })).toEqual({ changed: true })
    expect(installCodexHooks(script, home, { node: NODE })).toEqual({ changed: true })
    expect(installGeminiHooks(script, home, { node: NODE })).toEqual({ changed: true })
    expect(installCopilotHooks(script, home, { node: NODE })).toEqual({ changed: true })
    expect(installOpencodePlugin(script, home, { node: NODE })).toEqual({ changed: true })
    expect(await installKimiHooks(script, home, { kimiHome: '', node: NODE, validate: async () => ({ ok: true }) })).toEqual({ changed: true })
    for (const f of [claude, codex, gemini, kimi]) expect(fs.existsSync(`${f}.before-tessel`)).toBe(true)
    const r = await removeTeamHooks(home, { kimiHome: '' })
    expect(r.errors).toEqual([])
    expect(r.changed).toHaveLength(6)
    expect(read(claude)).toEqual({ model: 'x', hooks: { Stop: [mine] } })
    expect(read(codex)).toEqual({ hooks: { Stop: [mine] } })
    expect(read(gemini)).toEqual({ mcpServers: { a: { command: 'b' } }, hooks: {} })
    expect(fs.readFileSync(kimi, 'utf8')).toBe('default_model = "mine"\n')
    expect(fs.existsSync(join(home, '.copilot', 'hooks', 'tessel-team.json'))).toBe(false)
    expect(fs.existsSync(join(home, '.config', 'opencode', 'plugins', 'tessel-team.js'))).toBe(false)
    for (const f of [claude, codex, gemini, kimi]) expect(fs.existsSync(`${f}.before-tessel`)).toBe(false)
    // Nothing left: nothing changes.
    expect(await removeTeamHooks(home, { kimiHome: '' })).toEqual({ changed: [], errors: [] })
  })

  it('leaves a file it cannot read, and files that are not Tessel’s', async () => {
    const claude = join(home, '.claude', 'settings.json')
    put(claude, '{broken')
    put(`${claude}.before-tessel`, '{"model":"x"}')
    const opencode = join(home, '.config', 'opencode', 'plugins', 'tessel-team.js')
    put(opencode, 'export const Mine = 1\n')
    const r = await removeTeamHooks(home, { kimiHome: '' })
    expect(r.errors.join(' ')).toMatch(/could not be read/)
    expect(fs.readFileSync(claude, 'utf8')).toBe('{broken')
    // Its hooks may still be there: the copy stays.
    expect(fs.existsSync(`${claude}.before-tessel`)).toBe(true)
    expect(fs.readFileSync(opencode, 'utf8')).toBe('export const Mine = 1\n')
  })
})

describe('writing an agent file', () => {
  it.runIf(process.platform !== 'win32')('keeps its mode', () => {
    const file = join(dir, 'settings.json')
    fs.writeFileSync(file, '{}')
    fs.chmodSync(file, 0o600)
    writeFileAtomic(file, '{"a":1}')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps it writable and replaces its content (Windows: its read-only bit is the only mode)', () => {
    const file = join(dir, 'settings.json')
    fs.writeFileSync(file, '{}')
    const before = fs.statSync(file).mode & 0o777
    writeFileAtomic(file, '{"a":1}')
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}')
    expect(fs.statSync(file).mode & 0o777).toBe(before)
  })

  it('writes through a symbolic link to its target, never replacing the link', (ctx) => {
    const target = join(dir, 'dotfiles', 'settings.json')
    put(target, '{}')
    const link = join(dir, 'settings.json')
    try {
      fs.symlinkSync(target, link, 'file')
    } catch (err) {
      // Windows without Developer Mode cannot make symbolic links.
      if (err.code === 'EPERM') return ctx.skip()
      throw err
    }
    writeFileAtomic(link, '{"a":1}')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}')
    // A link whose target is gone: refused, nothing written.
    fs.rmSync(target)
    expect(() => writeFileAtomic(link, '{"b":2}')).toThrow()
    expect(fs.existsSync(target)).toBe(false)
  })
})
