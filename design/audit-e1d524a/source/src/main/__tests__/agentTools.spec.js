import { describe, it, expect } from 'vitest'
import {
  isValidServerName,
  splitCommandLine,
  windowsSafeCommand,
  parseKeyValueLines,
  psQuote,
  claudeServersFromConfig,
  codexServersFromList,
  slugify,
  normalizeServerConfig,
  parseRpcBody,
  hklFromTip
} from '../agentTools'

describe('isValidServerName', () => {
  it('accepts simple names', () => {
    expect(isValidServerName('github')).toBe(true)
    expect(isValidServerName('my_server-2')).toBe(true)
  })
  it('rejects spaces, dots, quotes and empty', () => {
    for (const bad of ['', 'my server', 'a.b', 'x"y', "x'y", 'a;b', null, 'x'.repeat(65)]) {
      expect(isValidServerName(bad)).toBe(false)
    }
  })
})

describe('splitCommandLine', () => {
  it('splits on whitespace', () => {
    expect(splitCommandLine('npx -y  @playwright/mcp@latest')).toEqual([
      'npx',
      '-y',
      '@playwright/mcp@latest'
    ])
  })
  it('keeps quoted parts together, including Windows paths', () => {
    expect(splitCommandLine('node "C:\\My Folder\\server.js" --port 3000')).toEqual([
      'node',
      'C:\\My Folder\\server.js',
      '--port',
      '3000'
    ])
    expect(splitCommandLine("run 'a b' c")).toEqual(['run', 'a b', 'c'])
  })
  it('keeps an explicitly empty quoted argument', () => {
    expect(splitCommandLine('cmd "" x')).toEqual(['cmd', '', 'x'])
  })
  it('handles empty input', () => {
    expect(splitCommandLine('')).toEqual([])
    expect(splitCommandLine(undefined)).toEqual([])
  })
})

describe('windowsSafeCommand', () => {
  it('wraps npx and friends in cmd /c on Windows', () => {
    expect(windowsSafeCommand(['npx', '-y', 'pkg'], 'win32')).toEqual([
      'cmd',
      '/c',
      'npx',
      '-y',
      'pkg'
    ])
    expect(windowsSafeCommand(['npm.cmd', 'x'], 'win32')).toEqual(['cmd', '/c', 'npm.cmd', 'x'])
  })
  it('leaves real executables and other platforms alone', () => {
    expect(windowsSafeCommand(['node', 'a.js'], 'win32')).toEqual(['node', 'a.js'])
    expect(windowsSafeCommand(['npx', 'pkg'], 'linux')).toEqual(['npx', 'pkg'])
  })
})

describe('parseKeyValueLines', () => {
  it('parses KEY=value lines, skipping blanks and comments', () => {
    expect(parseKeyValueLines('A=1\n\n# note\nB = two=2 ')).toEqual({ A: '1', B: 'two=2' })
  })
  it('parses headers with a colon separator', () => {
    expect(parseKeyValueLines('Authorization: Bearer abc', ':')).toEqual({
      Authorization: 'Bearer abc'
    })
  })
  it('throws on a malformed line', () => {
    expect(() => parseKeyValueLines('JUSTAKEY')).toThrow(/KEY=value/)
  })
})

describe('psQuote', () => {
  it('single-quotes and doubles embedded single quotes', () => {
    expect(psQuote("it's")).toBe("'it''s'")
    expect(psQuote('$env:X; rm -r')).toBe("'$env:X; rm -r'")
  })
})

describe('claudeServersFromConfig', () => {
  const claudeJson = {
    mcpServers: {
      ctx7: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { A: 'secret' } },
      fs: { command: 'cmd', args: ['/c', 'npx', 'fs'], env: { TOKEN: 'secret' } }
    },
    projects: {
      'C:/Work/app': { mcpServers: { local1: { command: 'node', args: ['x.js'] } } },
      'C:/Other': { mcpServers: { nope: { command: 'x' } } }
    }
  }
  it('collects user, matching local and project servers', () => {
    const list = claudeServersFromConfig(claudeJson, 'c:\\work\\app\\', {
      mcpServers: { shared: { type: 'http', url: 'https://x' } }
    })
    expect(list.map((s) => `${s.scope}:${s.name}`)).toEqual([
      'user:ctx7',
      'user:fs',
      'local:local1',
      'project:shared'
    ])
    expect(list[1]).toEqual({ name: 'fs', scope: 'user', type: 'stdio', target: 'cmd /c npx fs' })
  })
  it('never exposes env values or headers', () => {
    const text = JSON.stringify(claudeServersFromConfig(claudeJson, null, null))
    expect(text).not.toContain('secret')
  })
  it('copes with missing config', () => {
    expect(claudeServersFromConfig(null, null, null)).toEqual([])
  })
})

describe('codexServersFromList', () => {
  it('maps stdio and http servers and hides env', () => {
    const list = codexServersFromList([
      {
        name: 'a',
        enabled: true,
        transport: { type: 'stdio', command: 'node', args: ['s.js'], env: { K: 'secret' } }
      },
      { name: 'b', enabled: false, transport: { type: 'streamable_http', url: 'https://b' } }
    ])
    expect(list).toEqual([
      { name: 'a', scope: 'user', type: 'stdio', target: 'node s.js', enabled: true },
      { name: 'b', scope: 'user', type: 'http', target: 'https://b', enabled: false }
    ])
    expect(JSON.stringify(list)).not.toContain('secret')
  })
})

describe('slugify', () => {
  it('makes a branch-safe slug', () => {
    expect(slugify('Codex CLI')).toBe('codex-cli')
    expect(slugify('  ')).toBe('agent')
  })
})

describe('normalizeServerConfig', () => {
  it('normalizes Claude stdio and http entries', () => {
    expect(
      normalizeServerConfig({ command: 'cmd', args: ['/c', 'npx', 'x'], env: { A: '1' } })
    ).toEqual({
      transport: 'stdio',
      command: 'cmd',
      args: ['/c', 'npx', 'x'],
      env: { A: '1' }
    })
    expect(normalizeServerConfig({ type: 'http', url: 'https://x', headers: { H: 'v' } })).toEqual({
      transport: 'http',
      url: 'https://x',
      headers: { H: 'v' },
      bearerEnvVar: null
    })
  })
  it('normalizes Codex list entries', () => {
    expect(
      normalizeServerConfig({
        name: 'g',
        transport: { type: 'streamable_http', url: 'https://g', bearer_token_env_var: 'TOK' }
      })
    ).toEqual({ transport: 'http', url: 'https://g', headers: {}, bearerEnvVar: 'TOK' })
  })
})

describe('parseRpcBody', () => {
  it('reads a plain JSON response', () => {
    expect(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', 1)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true }
    })
  })
  it('reads an SSE response and picks the matching id', () => {
    const body = [
      'event: message',
      'data: {"jsonrpc":"2.0","method":"note"}',
      '',
      'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}',
      ''
    ].join('\n')
    expect(parseRpcBody(body, 2).result).toEqual({ tools: [] })
  })
  it('returns null for non-MCP bodies', () => {
    expect(parseRpcBody('<html>nope</html>', 1)).toBe(null)
  })
})

describe('hklFromTip', () => {
  it('builds the keyboard layout handle from a Windows input tip', () => {
    // French (Canada) with the Canadian French layout.
    expect(hklFromTip('0C0C:00001009')).toBe(0x10090c0c)
    // English (Canada), same layout.
    expect(hklFromTip('1009:00001009')).toBe(0x10091009)
    expect(hklFromTip('0409:00000409')).toBe(0x04090409)
  })
  it('rejects variant layouts and junk', () => {
    expect(hklFromTip('0409:00010409')).toBe(null)
    expect(hklFromTip('')).toBe(null)
    expect(hklFromTip('abc')).toBe(null)
  })
})
