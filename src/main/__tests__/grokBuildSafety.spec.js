// @vitest-environment node
// Grok Build, the review's findings: its config.toml is read as TOML before
// and after Tessel's edit (never left invalid), a server you turned off stays
// off, a path with a line break is never written, the Stats reader passes
// over an endless line and never blocks, and a tier read for one sign-in is
// never shown for another.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseToml, tomlValue } from '../tomlLite'
import { installGrokServer, installCodexServer, unsafePath } from '../teamInstall'
import { scanGrokLines, createGrokUsageReport } from '../grokUsageReport'
import { grokModelTimeline } from '../chat/transcriptView'
import { createExtraProviderUsage, USAGE_URLS } from '../extraProviderUsage'

let home, script
const node = process.execPath
const cfg = () => path.join(home, '.grok', 'config.toml')
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-grok-safe-'))
  fs.mkdirSync(path.join(home, '.grok'), { recursive: true })
  script = path.join(home, 'tessel-team-mcp.cjs')
  fs.writeFileSync(script, '')
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe('tomlLite', () => {
  it('reads the whole syntax', () => {
    const r = parseToml(
      [
        '# c',
        'title = "a \\"b\\" \\u00e9"',
        "path = 'C:\\Users\\x'",
        'n = 1_000',
        'f = -1.5e3',
        'h = 0xff',
        'ok = true',
        'when = 2026-10-19T05:07:53Z',
        'arr = [ 1, 2, # c',
        '  3, ]',
        'multi = """',
        'one \\',
        '   two"""',
        'lit = \'\'\'',
        'x\'\'\'',
        'inline = { a = 1, b.c = "d" }',
        'site."google.com" = true',
        '[a.b]',
        'k = 1',
        '[a]',
        'j = 2',
        '[[items]]',
        'name = "one"',
        '[[items]]',
        'name = "two"',
        '[items.sub]',
        'z = 0'
      ].join('\n')
    )
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ title: 'a "b" é', path: 'C:\\Users\\x', n: 1000, f: -1500, h: 255, ok: true, when: '2026-10-19T05:07:53Z', arr: [1, 2, 3], multi: 'one two', lit: 'x', inline: { a: 1, b: { c: 'd' } }, site: { 'google.com': true }, a: { b: { k: 1 }, j: 2 }, items: [{ name: 'one' }, { name: 'two', sub: { z: 0 } }] })
  })
  it.each([
    ['a = 1\na = 2', 'defined twice'],
    ['[t]\n[t]', 'defined twice'],
    ['[mcp_servers]\ntessel-team = { command = "x" }\n[mcp_servers.tessel-team]\ncommand = "y"', 'defined twice'],
    ['[f]\napple.color = "red"\n[f.apple]', 'defined twice'],
    ['a = "open', 'unclosed'],
    ['a = [1, 2', 'unclosed'],
    ['= 1', 'missing'],
    ['a = 1 b', 'unexpected'],
    ['a = nope', 'not valid']
  ])('refuses %j', (text, why) => {
    const r = parseToml(text)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(why)
  })
  it('writes values it can read back', () => {
    const v = { s: 'C:\\x "y"', n: 3, b: false, a: ['p'], t: { k: 'v' } }
    const text = Object.entries(v).map(([k, x]) => `${k} = ${tomlValue(x)}`).join('\n')
    expect(parseToml(text).data).toEqual(v)
  })
})

describe("Grok Build's config.toml: validated edits", () => {
  it('a file that is not valid TOML is left as it was, with the reason', () => {
    const bad = '[cli]\ninstaller = "internal"\n[cli]\n'
    fs.writeFileSync(cfg(), bad)
    const r = installGrokServer(script, home, { node, env: {} })
    expect(r.error).toMatch(/not valid TOML \(line 3/)
    expect(fs.readFileSync(cfg(), 'utf8')).toBe(bad)
  })

  it('a tessel-team server defined another way (an inline table) is never doubled', () => {
    const text = '[mcp_servers]\ntessel-team = { command = "old", args = [] }\n'
    fs.writeFileSync(cfg(), text)
    const r = installGrokServer(script, home, { node, env: {} })
    expect(r.error).toMatch(/without breaking it/)
    expect(fs.readFileSync(cfg(), 'utf8')).toBe(text)
  })

  it('one table, readable, the rest kept; a hand-split table (with its env sub-table) is replaced', () => {
    fs.writeFileSync(cfg(), '[cli]\ninstaller = "internal"\n\n[mcp_servers.tessel-team]\ncommand = "old"\n[mcp_servers.tessel-team.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "x"\n')
    expect(installGrokServer(script, home, { node, env: {} })).toEqual({ changed: true })
    const r = parseToml(fs.readFileSync(cfg(), 'utf8'))
    expect(r.ok).toBe(true)
    expect(r.data.cli.installer).toBe('internal')
    expect(r.data.mcp_servers.other.command).toBe('x')
    expect(r.data.mcp_servers['tessel-team']).toEqual({ command: node, args: [script], env: { TESSEL_PANE_ID: '${TESSEL_PANE_ID:-}', TESSEL_PROJECT_DIR: '${TESSEL_PROJECT_DIR:-}', TESSEL_TEAM_SECRET: '${TESSEL_TEAM_SECRET:-}' }, tool_timeout_sec: 1200 })
    expect(fs.existsSync(`${cfg()}.before-tessel`)).toBe(true)
  })

  it('a server you turned off stays off, and your timeouts stay', () => {
    expect(installGrokServer(script, home, { node, env: {} })).toEqual({ changed: true })
    // You turn it off and lengthen its timeout: nothing to rewrite.
    const off = fs.readFileSync(cfg(), 'utf8').replace('tool_timeout_sec = 1200', 'enabled = false\ntool_timeout_sec = 3000')
    fs.writeFileSync(cfg(), off)
    expect(installGrokServer(script, home, { node, env: {} })).toEqual({ changed: false })
    expect(fs.readFileSync(cfg(), 'utf8')).toBe(off)
    // The script moved: rewritten, still off, your timeout kept.
    const moved = path.join(home, 'other', 'tessel-team-mcp.cjs')
    fs.mkdirSync(path.dirname(moved))
    fs.writeFileSync(moved, '')
    expect(installGrokServer(moved, home, { node, env: {} })).toEqual({ changed: true })
    const t = parseToml(fs.readFileSync(cfg(), 'utf8')).data.mcp_servers['tessel-team']
    expect(t).toMatchObject({ args: [moved], enabled: false, tool_timeout_sec: 3000 })
  })

  it('a path with a line break or NUL is never written (Grok, Codex)', () => {
    expect(unsafePath('C:\\a\nb')).toBe(true)
    expect(unsafePath('C:\\a\0b')).toBe(true)
    expect(unsafePath('C:\\a b')).toBe(false)
    const evil = path.join(home, 'x\r\n[evil]')
    expect(installGrokServer(evil, home, { node, env: {} }).error).toBeTruthy()
    expect(fs.existsSync(cfg())).toBe(false)
  })

  it('Codex refuses one too', async () => {
    fs.mkdirSync(path.join(home, '.codex'))
    const r = await installCodexServer(path.join(home, 'a\nb.cjs'), null, home, { node })
    expect(r.error).toBeTruthy()
  })
})

describe('Grok Build Stats reader: async, endless lines passed over', () => {
  it('passes over a line longer than the cap and goes on after it, across reads', async () => {
    const file = path.join(home, 'u.jsonl')
    const long = 'x'.repeat(300)
    fs.writeFileSync(file, `one\n${long}\ntwo\n${long}`)
    const lines = []
    const size = fs.statSync(file).size
    const first = await scanGrokLines(file, { offset: 0, skipping: false }, size, (l) => lines.push(l), { chunk: 64, maxLine: 100 })
    expect(lines).toEqual(['one', 'two'])
    // Inside the second long line at the end: past it, still passing over.
    expect(first).toMatchObject({ offset: size, skipping: true })
    fs.appendFileSync(file, `${long}\nthree\npart`)
    const size2 = fs.statSync(file).size
    const second = await scanGrokLines(file, first, size2, (l) => lines.push(l), { chunk: 64, maxLine: 100 })
    expect(lines).toEqual(['one', 'two', 'three'])
    // The unfinished last line is read again next time.
    expect(second).toMatchObject({ offset: size2 - 4, skipping: false })
  })

  it('a file that shrank is read again from its start', async () => {
    const file = path.join(home, 'u.jsonl')
    fs.writeFileSync(file, 'a\n')
    const lines = []
    const r = await scanGrokLines(file, { offset: 999, skipping: true }, 2, (l) => lines.push(l))
    expect(r).toMatchObject({ reset: true, offset: 2 })
    expect(lines).toEqual(['a'])
  })

  it('the report survives an endless line', async () => {
    const dir = path.join(home, '.grok', 'sessions', 'C%3A%5CW', 'sess-000001')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ info: { cwd: 'C:\\W' } }))
    const turn = JSON.stringify({ params: { update: { sessionUpdate: 'turn_completed', usage: { inputTokens: 10, outputTokens: 2, modelUsage: { 'grok-4.7': { inputTokens: 10, outputTokens: 2 } } } }, _meta: { agentTimestampMs: Date.parse('2026-10-19T05:00:00Z') } } })
    fs.writeFileSync(path.join(dir, 'updates.jsonl'), `${'y'.repeat(2 * 1024 * 1024)}\n${turn}\n`)
    const r = await createGrokUsageReport({ home, env: {}, timezone: 'UTC', now: () => Date.parse('2026-10-20T00:00:00Z') })({ from: null, to: null })
    expect(r.totals.turns).toBe(1)
  })
})

describe('Grok model names in Conversations are capped', () => {
  it('80 characters at most, never a control character', () => {
    const at = 1792386537485
    const line = (modelId) => JSON.stringify({ params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' }, _meta: { modelId } }, _meta: { agentTimestampMs: at } } })
    expect(grokModelTimeline([line('g'.repeat(500))])[0].model).toHaveLength(80)
    expect(grokModelTimeline([line('bad\u0007model')])).toEqual([])
  })
})

describe("a tier read for one sign-in is never shown for another", () => {
  const now = Date.parse('2026-10-19T12:00:00Z')
  const setup = (fingerprints) => {
    const auth = vi.fn(async () => ({ headers: { Authorization: 'Bearer fixture-only' }, fingerprint: fingerprints.shift() ?? 'later' }))
    const request = vi.fn(async (url, init) => {
      if (url === USAGE_URLS.grokUser) {
        expect(init.signal).toBeTruthy()
        return new Response(JSON.stringify({ subscriptionTier: 'SuperGrok Heavy' }))
      }
      return new Response(JSON.stringify({ config: { creditUsagePercent: 5, billingPeriodEnd: now + 1000 } }))
    })
    const sources = { present: async () => true, auth, signIn: async () => ({ signedIn: true, planType: 'SuperGrok', plan: { label: 'SuperGrok', kind: 'subscription', source: 'cli' } }) }
    const service = createExtraProviderUsage({ sources, request, clock: () => now, listAgents: async () => [{ id: 'grok', available: true }], antigravityCli: { present: () => false, read: async () => ({ ok: false }) }, antigravityPlan: { read: () => null }, museUsage: { present: () => false, read: async () => ({ ok: false }) } })
    return { service, auth }
  }

  it('a login switched during the read: stale, and the tier read is dropped', async () => {
    const { service } = setup(['one', 'two', 'two'])
    expect(await service.read({ provider: 'grok', accountId: null })).toMatchObject({ ok: false, code: 'stale' })
    expect((await service.signIn('grok')).planType).toBe('SuperGrok')
  })

  it('kept for its own login only: another sign-in since shows its cached tier', async () => {
    const { service } = setup(['one', 'one', 'one', 'two'])
    expect(await service.read({ provider: 'grok', accountId: null })).toMatchObject({ ok: true, plan: 'SuperGrok Heavy' })
    expect((await service.signIn('grok')).planType).toBe('SuperGrok Heavy')
    expect((await service.signIn('grok')).planType).toBe('SuperGrok')
  })
})
