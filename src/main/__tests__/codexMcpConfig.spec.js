// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { setCodexHttpServer, removeServerTables, codexHttpTable, codexHome } from '../codexMcpConfig'
import { addMcp } from '../agentTools'

let home
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-codex-mcp-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})
const config = () => fs.readFileSync(join(home, 'config.toml'), 'utf8')

describe('Codex HTTP MCP servers in config.toml', () => {
  it('Codex home: CODEX_HOME, else ~/.codex', () => {
    expect(codexHome({ CODEX_HOME: 'D:\\cx' }, 'C:\\Users\\u')).toBe('D:\\cx')
    expect(codexHome({}, 'C:\\Users\\u')).toBe(join('C:\\Users\\u', '.codex'))
  })

  it('writes the streamable HTTP table Codex reads (url, bearer, headers), quoted safely', () => {
    expect(codexHttpTable('context7', { url: 'https://mcp.context7.com/mcp' })).toBe(
      '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n'
    )
    expect(codexHttpTable('gh', { url: 'https://x/mcp?a="b"', bearerEnvVar: 'TOKEN', headers: { 'X-Key': 'v\\1' } })).toBe(
      '[mcp_servers.gh]\nurl = "https://x/mcp?a=\\"b\\""\nbearer_token_env_var = "TOKEN"\nhttp_headers = { "X-Key" = "v\\\\1" }\n'
    )
  })

  it('adds to a new file, then replaces only its own tables, keeping the rest', async () => {
    expect(await setCodexHttpServer('context7', { url: 'https://mcp.context7.com/mcp' }, { home })).toEqual({ ok: true, changed: true })
    expect(config()).toBe('[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n')
    fs.writeFileSync(
      join(home, 'config.toml'),
      'model = "gpt-5" # mine\n\n[mcp_servers.context7]\nurl = "https://old"\n\n[mcp_servers.context7.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "x"\n'
    )
    expect((await setCodexHttpServer('context7', { url: 'https://mcp.context7.com/mcp' }, { home })).changed).toBe(true)
    expect(config()).toBe(
      'model = "gpt-5" # mine\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n'
    )
    expect(fs.existsSync(join(home, 'config.toml.tessel-bak'))).toBe(true)
    // The same again: nothing written.
    expect(await setCodexHttpServer('context7', { url: 'https://mcp.context7.com/mcp' }, { home })).toEqual({ ok: true, changed: false })
  })

  it('keeps Windows line endings', async () => {
    fs.writeFileSync(join(home, 'config.toml'), 'model = "x"\r\n')
    await setCodexHttpServer('docs', { url: 'https://d/mcp' }, { home })
    expect(config()).toBe('model = "x"\r\n\r\n[mcp_servers.docs]\r\nurl = "https://d/mcp"\r\n')
  })

  it('never rewrites a server written another way', async () => {
    expect(removeServerTables('[mcp_servers]\ncontext7 = { url = "x" }\n', 'context7').error).toBeTruthy()
    expect(removeServerTables('mcp_servers.context7.url = "x"\n', 'context7').error).toBeTruthy()
    expect(removeServerTables('[mcp_servers]\nother = { url = "x" }\n', 'context7').error).toBeUndefined()
    const text = '[mcp_servers]\ncontext7 = { url = "x" }\n'
    fs.writeFileSync(join(home, 'config.toml'), text)
    expect((await setCodexHttpServer('context7', { url: 'https://y' }, { home })).ok).toBe(false)
    expect(config()).toBe(text)
  })

  it('puts the previous file back when Codex cannot read the new one', async () => {
    fs.writeFileSync(join(home, 'config.toml'), 'model = "x"\n')
    const r = await setCodexHttpServer('docs', { url: 'https://d/mcp' }, { home, verify: async () => ({ ok: false, error: 'bad toml' }) })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('bad toml')
    expect(config()).toBe('model = "x"\n')
  })
})

describe('addMcp for Codex over HTTP', () => {
  it('writes config.toml (no `codex mcp add`, so no OAuth sign-in in a hidden process)', async () => {
    let verified = 0
    const res = await addMcp(
      { agent: 'codex', name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp', headers: 'CONTEXT7_API_KEY: k1' },
      { codexHome: home, verifyCodex: async () => (verified++, { ok: true }) }
    )
    expect(res).toEqual({ ok: true, changed: true })
    expect(verified).toBe(1)
    expect(config()).toBe('[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\nhttp_headers = { "CONTEXT7_API_KEY" = "k1" }\n')
  })

  it('refuses SSE servers and odd variable names, without touching the file', async () => {
    const deps = { codexHome: home, verifyCodex: async () => ({ ok: true }) }
    expect((await addMcp({ agent: 'codex', name: 's', transport: 'http', url: 'https://x/sse', sse: true }, deps)).ok).toBe(false)
    expect((await addMcp({ agent: 'codex', name: 's', transport: 'http', url: 'https://x/mcp', bearerEnvVar: 'A B' }, deps)).ok).toBe(false)
    expect(fs.existsSync(join(home, 'config.toml'))).toBe(false)
  })
})
