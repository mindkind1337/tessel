// @vitest-environment node
// Agents found on a remote host: __t_agents (remoteShell.js prelude) on a
// POSIX sh playing the host, its output read by parseAgentTools, and the
// once-per-host check run when a terminal opens there (createRemoteAgentCheck).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRemoteSession, sessionArgs } from '../../remoteShell'
import { parseAgentTools, createRemoteAgentCheck } from '../remoteAgentSetup'
import { gitSh, fakeSshLaunch, posixPath } from '../../__tests__/fixtures/fakeSsh'

describe('parseAgentTools', () => {
  it('reads one absolute path per tool, "-" or anything else as missing', () => {
    expect(parseAgentTools('claude /home/me/.local/bin/claude\ncodex -\nvscode-claude /home/me/.vscode-server/extensions/anthropic.claude-code-2.0.10-linux-x64/resources/native-binary/claude\n')).toEqual({
      claude: '/home/me/.local/bin/claude',
      codex: null,
      vscodeClaude: '/home/me/.vscode-server/extensions/anthropic.claude-code-2.0.10-linux-x64/resources/native-binary/claude'
    })
    expect(parseAgentTools('claude relative/claude\r\ncodex /usr/bin/codex\r\nother /x\n')).toEqual({ claude: null, codex: '/usr/bin/codex', vscodeClaude: null })
    expect(parseAgentTools('claude /a\u0007b\nclaude /usr/bin/claude\n')).toEqual({ claude: '/usr/bin/claude', codex: null, vscodeClaude: null })
    expect(parseAgentTools('')).toEqual({ claude: null, codex: null, vscodeClaude: null })
    expect(parseAgentTools('claude /a b/claude')).toMatchObject({ claude: '/a b/claude' })
  })
})

describe('createRemoteAgentCheck', () => {
  const tools = { claude: '/usr/bin/claude', codex: null, vscodeClaude: null }
  function make({ shim = { ok: true }, agentTools } = {}) {
    const calls = { shim: 0, tools: 0 }
    const sent = []
    const check = createRemoteAgentCheck({
      ensureShim: async () => {
        calls.shim++
        return typeof shim === 'function' ? shim() : shim
      },
      agentTools: async (hostId) => {
        calls.tools++
        return agentTools ? agentTools(hostId) : tools
      },
      label: (hostId) => `Label ${hostId}`,
      send: (s) => sent.push(s)
    })
    return { check, calls, sent }
  }

  it('once per host and app run; the window hears the status', async () => {
    const { check, calls, sent } = make()
    const a = check.hostStarted('h1')
    const b = check.hostStarted('h1')
    expect(a).toBe(b)
    await a
    await check.hostStarted('h1')
    expect(calls).toEqual({ shim: 1, tools: 1 })
    expect(sent).toEqual([{ hostId: 'h1', label: 'Label h1', claude: '/usr/bin/claude', codex: null, vscodeClaude: null, shim: 'ok' }])
    await check.hostStarted('h2')
    expect(sent.map((s) => s.hostId)).toEqual(['h1', 'h2'])
  })

  it('a shim that could not go there: its reason, the agents still looked for', async () => {
    const { check, sent } = make({ shim: { ok: false, reason: 'no-node' } })
    await check.hostStarted('h1')
    expect(sent[0]).toMatchObject({ shim: 'no-node', claude: '/usr/bin/claude' })
  })

  it('a host that could not be reached: told, and tried again at the next terminal', async () => {
    let fail = true
    const { check, calls, sent } = make({ agentTools: () => (fail ? { error: 'not connected' } : tools) })
    await check.hostStarted('h1')
    expect(sent[0]).toMatchObject({ hostId: 'h1', claude: null, codex: null, vscodeClaude: null, error: 'not connected' })
    fail = false
    await check.hostStarted('h1')
    await check.hostStarted('h1')
    expect(calls.tools).toBe(2)
    expect(sent[1]).toEqual({ hostId: 'h1', label: 'Label h1', ...tools, shim: 'ok' })
  })

  it('throwing helpers end as a status, never a rejection', async () => {
    const { check, sent } = make({
      shim: () => {
        throw new Error('boom')
      },
      agentTools: () => {
        throw new Error('gone')
      }
    })
    await expect(check.hostStarted('h1')).resolves.toMatchObject({ shim: 'failed', error: 'gone' })
    expect(sent).toHaveLength(1)
  })

  it('a pane still signing in waits for it; a pane that exits first starts nothing', async () => {
    const { check, calls, sent } = make()
    check.waitConnected('p1', 'h1')
    check.waitConnected('p2', 'h2')
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.tools).toBe(0)
    check.paneExited('p2')
    check.paneConnected('p2')
    check.paneConnected('p1')
    await check.hostStarted('h1')
    expect(sent.map((s) => s.hostId)).toEqual(['h1'])
    // Connected again later (a new question, then through): nothing more.
    check.paneConnected('p1')
    expect(calls.tools).toBe(1)
  })

  it('check() asks again and answers, without sending', async () => {
    const { check, calls, sent } = make()
    await check.hostStarted('h1')
    const res = await check.check('h1')
    expect(res).toEqual({ hostId: 'h1', label: 'Label h1', ...tools, shim: 'ok' })
    expect(calls.tools).toBe(2)
    expect(sent).toHaveLength(1)
  })
})

describe.skipIf(!gitSh())('__t_agents on a POSIX sh (fake ssh)', () => {
  let dir
  let session
  afterEach(() => {
    if (session) session.close('done')
    session = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })
  // An executable for the host's sh (Git for Windows: a #! line makes it one).
  const tool = (p, exec = true) => {
    fs.mkdirSync(join(p, '..'), { recursive: true })
    fs.writeFileSync(p, exec ? '#!/bin/sh\necho hi\n' : 'not a program\n')
    if (exec) fs.chmodSync(p, 0o755)
  }

  async function agentsIn(home, extraEnv = {}) {
    const launch = fakeSshLaunch({ home })
    // No agent on the PATH of this computer is seen; the login shell finds none.
    session = createRemoteSession({
      file: launch.file,
      args: sessionArgs(launch.args),
      env: { SystemRoot: process.env.SystemRoot || '', PATH: process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin', SHELL: '/usr/bin/false', ...extraEnv },
      spawnImpl: launch.spawnImpl
    })
    await session.start()
    const res = await session.run('__t_agents', [], { cap: 16 * 1024, timeoutMs: 30000 })
    expect(res.rc).toBe(0)
    return res.out.toString('utf8')
  }

  it('nothing installed: three dashes', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agents-'))
    const out = await agentsIn(dir)
    expect(out).toBe('claude -\ncodex -\nvscode-claude -\n')
  }, 60000)

  it('finds ~/.local/bin, ~/.nvm and the newest executable VS Code extension binary', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agents-'))
    const home = posixPath(dir)
    tool(join(dir, '.local', 'bin', 'claude'))
    tool(join(dir, '.nvm', 'versions', 'node', 'v20.1.0', 'bin', 'codex'))
    const ext = (v) => join(dir, '.vscode-server', 'extensions', `anthropic.claude-code-${v}-linux-x64`, 'resources', 'native-binary', 'claude')
    tool(ext('2.0.9'))
    tool(ext('2.0.10'))
    // Newer but not executable: not taken.
    tool(ext('2.1.0'), false)
    const out = await agentsIn(dir)
    const found = parseAgentTools(out)
    expect(found.claude).toBe(`${home}/.local/bin/claude`)
    expect(found.codex).toBe(`${home}/.nvm/versions/node/v20.1.0/bin/codex`)
    expect(found.vscodeClaude).toBe(`${home}/.vscode-server/extensions/anthropic.claude-code-2.0.10-linux-x64/resources/native-binary/claude`)
  }, 60000)

  it('a tool on the PATH comes first', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agents-'))
    tool(join(dir, 'pathbin', 'codex'))
    tool(join(dir, '.local', 'bin', 'codex'))
    const sysPath = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin'
    const out = await agentsIn(dir, { PATH: `${join(dir, 'pathbin')}${process.platform === 'win32' ? ';' : ':'}${sysPath}` })
    expect(parseAgentTools(out).codex).toBe(`${posixPath(dir)}/pathbin/codex`)
  }, 60000)
})
