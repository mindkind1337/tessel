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
  hklFromTip,
  shimTarget,
  run
} from '../agentTools'
import fs from 'fs'
import os from 'os'
import { join } from 'path'

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
      sse: false,
      url: 'https://x',
      headers: { H: 'v' },
      bearerEnvVar: null
    })
    expect(normalizeServerConfig({ type: 'sse', url: 'https://x/sse' }).sse).toBe(true)
  })
  it('normalizes Codex list entries', () => {
    expect(
      normalizeServerConfig({
        name: 'g',
        transport: { type: 'streamable_http', url: 'https://g', bearer_token_env_var: 'TOK' }
      })
    ).toEqual({ transport: 'http', sse: false, url: 'https://g', headers: {}, bearerEnvVar: 'TOK' })
    // Codex keeps custom headers too (http_headers).
    expect(normalizeServerConfig({ transport: { type: 'streamable_http', url: 'https://g', http_headers: { K: 'v' } } }).headers).toEqual({ K: 'v' })
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

describe('npm launchers where PowerShell scripts are blocked', () => {
  const codexCmd = [
    '@ECHO off',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
  ].join('\r\n')
  const claudeCmd = '@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
  const dir = 'C:\\npm'
  const has = (...files) => (p) => files.includes(p)

  it('finds the script a node launcher starts, run by node', () => {
    const js = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    expect(shimTarget(codexCmd, dir, 'C:\\node\\node.exe', has(js))).toEqual({ file: 'C:\\node\\node.exe', pre: [js] })
    // A node.exe next to the launcher is the one it uses.
    const local = join(dir, 'node.exe')
    expect(shimTarget(codexCmd, dir, 'C:\\node\\node.exe', has(js, local))).toEqual({ file: local, pre: [js] })
  })

  it('finds the program a launcher starts directly', () => {
    const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    expect(shimTarget(claudeCmd, dir, null, has(exe))).toEqual({ file: exe, pre: [] })
  })

  it('gives up on what it does not understand', () => {
    expect(shimTarget('@echo off\r\nsomething %*', dir, 'node', () => true)).toBe(null)
    expect(shimTarget(claudeCmd, dir, null, () => false)).toBe(null) // target missing
    const js = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    expect(shimTarget(codexCmd, dir, null, has(js))).toBe(null) // no node
  })

  it('arguments reach the program exactly (no shell in between)', async () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-shim-'))
    try {
      const script = join(tmp, 'echo.js')
      fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
      const target = shimTarget(`"%dp0%\\echo.js" %*`, tmp, process.execPath)
      const args = ['https://example.invalid/mcp?first=1&second=2', 'KEY=%PATH%', 'say "hi" & bye', 'with space', '^caret|pipe<>']
      const res = await run(target.file, [...target.pre, ...args])
      expect(JSON.parse(res.stdout)).toEqual(args)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('psQuote and the typographic quotes', () => {
  it('doubles every quote PowerShell ends a string at', () => {
    expect(psQuote("it's")).toBe("'it''s'")
    expect(psQuote('x\u2019; calc; \u2019')).toBe("'x\u2019\u2019; calc; \u2019\u2019'")
    expect(psQuote('\u2018a\u201Ab\u201B')).toBe("'\u2018\u2018a\u201A\u201Ab\u201B\u201B'")
  })
})

describe("Cursor's launcher (a .cmd that runs a PowerShell script beside it)", () => {
  it('is started as that script through PowerShell, never anything outside its folder', async () => {
    const { shimTarget } = await import('../agentTools')
    const cmd = [
      '@echo off',
      'set "SCRIPT_DIR=%~dp0"',
      String.raw`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\cursor-agent.ps1" %*`
    ].join('\r\n')
    const dir = String.raw`C:\Users\me\AppData\Local\cursor-agent`
    const script = join(dir, 'cursor-agent.ps1')
    const t = shimTarget(cmd, dir, null, (p) => p === script)
    expect(t.file).toMatch(/powershell\.exe$/i)
    expect(t.pre).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script])
    // The script must exist beside it; a path out of the folder is not read.
    expect(shimTarget(cmd, dir, null, () => false)).toBe(null)
    expect(shimTarget(cmd.replace('cursor-agent.ps1', String.raw`..\x.ps1`), dir, null, () => true)).toBe(null)
  })
})
