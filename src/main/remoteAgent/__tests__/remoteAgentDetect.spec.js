// @vitest-environment node
// Agents found on a remote host: __t_agents (remoteShell.js prelude) on a
// POSIX sh playing the host, its output read by parseAgentTools, and the
// once-per-host check run when a terminal opens there (createRemoteAgentCheck).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRemoteSession, prelude, sessionArgs } from '../../remoteShell'
import { parseAgentTools, createRemoteAgentCheck, emptyHost } from '../remoteAgentSetup'
import { gitSh, fakeSshLaunch, posixPath } from '../../__tests__/fixtures/fakeSsh'

const tops = (r) => ({ claude: r.claude, codex: r.codex, vscodeClaude: r.vscodeClaude })

describe('parseAgentTools', () => {
  it('reads one absolute path per tool, "-" or anything else as missing', () => {
    expect(tops(parseAgentTools('claude /home/me/.local/bin/claude\ncodex -\nvscode-claude /home/me/.vscode-server/extensions/anthropic.claude-code-2.0.10-linux-x64/resources/native-binary/claude\n'))).toEqual({
      claude: '/home/me/.local/bin/claude',
      codex: null,
      vscodeClaude: '/home/me/.vscode-server/extensions/anthropic.claude-code-2.0.10-linux-x64/resources/native-binary/claude'
    })
    expect(tops(parseAgentTools('claude relative/claude\r\ncodex /usr/bin/codex\r\nother /x\n'))).toEqual({ claude: null, codex: '/usr/bin/codex', vscodeClaude: null })
    expect(tops(parseAgentTools('claude /a\u0007b\nclaude /usr/bin/claude\n'))).toEqual({ claude: '/usr/bin/claude', codex: null, vscodeClaude: null })
    expect(parseAgentTools('')).toMatchObject({ claude: null, codex: null, vscodeClaude: null, bins: {}, uid: null })
    expect(parseAgentTools('claude /a b/claude')).toMatchObject({ claude: '/a b/claude' })
  })

  it('every command looked for: its path, or null; names that are not commands are left out', () => {
    const r = parseAgentTools('agy /home/me/.local/bin/agy\nkiro-cli -\ngemini relative\nconstructor -\n../x /etc/x\n-rf /x\nvscode-claude -\nagy -\n')
    expect(r.bins).toEqual({ agy: '/home/me/.local/bin/agy', 'kiro-cli': null, gemini: null, constructor: null })
    // The first path found counts; a later "-" does not undo it.
    expect(parseAgentTools('agy -\nagy /snap/bin/agy\n').bins.agy).toBe('/snap/bin/agy')
  })

  it('what an install there needs: node and its version, npm, its folder and whether it is the user\'s, snap, curl, wget, uid, system', () => {
    const r = parseAgentTools(
      ['claude -', '@node /home/me/.nvm/versions/node/v22.11.0/bin/node', '@nodev 22.11.0', '@npm /home/me/.nvm/versions/node/v22.11.0/bin/npm', '@prefix /home/me/.nvm/versions/node/v22.11.0', '@prefixw 1', '@snap /usr/bin/snap', '@curl /usr/bin/curl', '@wget -', '@uid 1001', '@os Linux', '@bogus x'].join('\n')
    )
    expect(r.host).toEqual({
      node: '/home/me/.nvm/versions/node/v22.11.0/bin/node',
      nodeMajor: 22,
      npm: '/home/me/.nvm/versions/node/v22.11.0/bin/npm',
      npmPrefix: '/home/me/.nvm/versions/node/v22.11.0',
      npmWritable: true,
      snap: '/usr/bin/snap',
      curl: '/usr/bin/curl',
      wget: null,
      os: 'Linux',
      codexVersion: null,
      codexNoDaemon: null
    })
    expect(r.uid).toBe(1001)
    // Nothing said, or something odd: not known.
    const odd = parseAgentTools('@nodev banana\n@prefixw yes\n@uid -1\n@os $(rm)\n@npm -\n')
    expect(odd.host).toMatchObject({ nodeMajor: null, npmWritable: null, os: null, npm: null })
    expect(odd.uid).toBe(null)
    expect(parseAgentTools('@prefixw 0\n').host.npmWritable).toBe(false)
  })

  it('a probe that ran out of time (login shell, npm): partial', () => {
    expect(parseAgentTools('agy -\n@partial login npm\n').partial).toBe(true)
    expect(parseAgentTools('agy -\n').partial).toBe(false)
  })
})

describe("the host's Codex and its daemon", () => {
  it('its version and whether its --help has --no-daemon; anything odd is not known', () => {
    const r = parseAgentTools('codex /home/me/.local/bin/codex\n@codexv 0.164.0\n@codexnd 1\n')
    expect(r.host).toMatchObject({ codexVersion: '0.164.0', codexNoDaemon: true })
    expect(parseAgentTools('@codexv 0.150.0\n@codexnd 0\n').host).toMatchObject({ codexVersion: '0.150.0', codexNoDaemon: false })
    expect(parseAgentTools('@codexv 0.165.0-alpha.1\n').host.codexVersion).toBe('0.165.0-alpha.1')
    expect(parseAgentTools('@codexv $(rm -rf)\n@codexnd yes\n').host).toMatchObject({ codexVersion: null, codexNoDaemon: null })
    // Not said (an older Tessel, its Codex too slow): not known.
    expect(parseAgentTools('codex /usr/bin/codex\n').host).toMatchObject({ codexVersion: null, codexNoDaemon: null })
  })
  it('kept per host for its path and version: a check where its Codex did not answer says it again; another version asks anew', async () => {
    let answer = { codex: '/u/bin/codex', claude: null, vscodeClaude: null, bins: {}, host: { codexVersion: '0.164.0', codexNoDaemon: true } }
    const check = createRemoteAgentCheck({ ensureShim: async () => ({ ok: true }), agentTools: async () => answer, agentBins: [] })
    expect((await check.check('h1', { fresh: true })).host.codexNoDaemon).toBe(true)
    answer = { ...answer, host: { codexVersion: '0.164.0', codexNoDaemon: null } }
    expect((await check.check('h1', { fresh: true })).host.codexNoDaemon).toBe(true)
    // Updated there: its new version is asked anew.
    answer = { ...answer, host: { codexVersion: '0.165.0', codexNoDaemon: null } }
    expect((await check.check('h1', { fresh: true })).host.codexNoDaemon).toBe(null)
    // Another Codex (another path): the same.
    answer = { ...answer, codex: '/opt/codex', host: { codexVersion: '0.164.0', codexNoDaemon: null } }
    expect((await check.check('h1', { fresh: true })).host.codexNoDaemon).toBe(null)
    // Each host its own.
    expect((await check.check('h2', { fresh: true })).host.codexNoDaemon).toBe(null)
  })
})

describe('createRemoteAgentCheck', () => {
  const tools = { claude: '/usr/bin/claude', codex: null, vscodeClaude: null }
  function make({ shim = { ok: true }, agentTools, agentBins, now, ttlMs } = {}) {
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
      ...(agentBins ? { agentBins } : {}),
      ...(now ? { now } : {}),
      ...(ttlMs != null ? { ttlMs } : {}),
      label: (hostId) => `Label ${hostId}`,
      send: (s) => sent.push(s)
    })
    return { check, calls, sent }
  }
  const status = (extra = {}) => ({ hostId: 'h1', label: 'Label h1', ...tools, agents: {}, host: emptyHost(), shim: 'ok', ...extra })

  it('once per host and app run; the window hears the status', async () => {
    const { check, calls, sent } = make()
    const a = check.hostStarted('h1')
    const b = check.hostStarted('h1')
    expect(a).toBe(b)
    await a
    await check.hostStarted('h1')
    expect(calls).toEqual({ shim: 1, tools: 1 })
    expect(sent).toEqual([status()])
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
    expect(sent[1]).toEqual(status())
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

  it('check() answers without sending: from a check of a few seconds ago, else the host again; fresh: always the host', async () => {
    let t = 1000
    const { check, calls, sent } = make({ now: () => t, ttlMs: 10_000 })
    await check.hostStarted('h1')
    expect(await check.check('h1')).toEqual(status())
    expect(calls.tools).toBe(1)
    expect(await check.check('h1', { fresh: true })).toEqual(status())
    expect(calls.tools).toBe(2)
    t += 10_001
    await check.check('h1')
    expect(calls.tools).toBe(3)
    expect(sent).toHaveLength(1)
  })

  it('several panes asking at once: one check of the host', async () => {
    let release
    const gate = new Promise((r) => (release = r))
    const { check, calls } = make({ agentTools: async () => (await gate, tools) })
    const a = check.check('h1')
    const b = check.check('h1')
    release()
    expect(await a).toBe(await b)
    expect(calls.tools).toBe(1)
  })

  it('a partial answer (the login shell ran out of time): sent, never reused, and the next terminal asks again', async () => {
    let partial = true
    const { check, calls, sent } = make({ agentBins: [{ id: 'antigravity', bin: 'agy' }], agentTools: () => ({ ...tools, bins: { agy: null }, partial }) })
    await check.hostStarted('h1')
    expect(sent[0]).toMatchObject({ partial: true, agents: { antigravity: null } })
    expect(await check.check('h1')).toMatchObject({ partial: true })
    expect(calls.tools).toBe(2)
    partial = false
    await check.hostStarted('h1')
    expect(calls.tools).toBe(3)
    expect(sent[1]).not.toHaveProperty('partial')
  })

  it('a check that failed is never reused', async () => {
    let fail = true
    const { check, calls } = make({ agentTools: () => (fail ? { error: 'timeout' } : tools) })
    expect(await check.check('h1')).toMatchObject({ error: 'timeout' })
    fail = false
    expect(await check.check('h1')).not.toHaveProperty('error')
    expect(calls.tools).toBe(2)
  })

  it('each agent by its command: its path there, null when missing, left out when not reported', async () => {
    const agentBins = [
      { id: 'claude', bin: 'claude' },
      { id: 'antigravity', bin: 'agy' },
      { id: 'kiro', bin: 'kiro-cli' },
      { id: 'grok', bin: 'grok' },
      { id: 'bad', bin: '../x' }
    ]
    const found = { ...tools, bins: { claude: '/usr/bin/claude', agy: null, 'kiro-cli': '/home/u/.local/bin/kiro-cli' }, host: { npm: '/usr/bin/npm', npmWritable: false }, uid: 0 }
    const { check } = make({ agentBins, agentTools: () => found })
    const res = await check.check('h1')
    expect(res.agents).toEqual({ claude: '/usr/bin/claude', antigravity: null, kiro: '/home/u/.local/bin/kiro-cli' })
    expect(res.host).toEqual({ ...emptyHost(), npm: '/usr/bin/npm', npmWritable: false })
    expect(res.uid).toBe(0)
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

  async function agentsIn(home, extraEnv = {}, names = []) {
    const launch = fakeSshLaunch({ home })
    // No agent on the PATH of this computer is seen; the login shell finds none.
    session = createRemoteSession({
      file: launch.file,
      args: sessionArgs(launch.args),
      env: { SystemRoot: process.env.SystemRoot || '', PATH: process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin', SHELL: '/usr/bin/false', ...extraEnv },
      spawnImpl: launch.spawnImpl
    })
    await session.start()
    const res = await session.run('__t_agents', names, { cap: 64 * 1024, timeoutMs: 30000 })
    expect(res.rc).toBe(0)
    return res.out.toString('utf8')
  }
  // A program for the host's sh that prints `text` (its arguments in $*).
  const script = (p, body) => {
    fs.mkdirSync(join(p, '..'), { recursive: true })
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`)
    fs.chmodSync(p, 0o755)
  }

  it('nothing installed: three dashes, then what the host has for an install', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agents-'))
    const out = await agentsIn(dir)
    expect(out.startsWith('claude -\ncodex -\nvscode-claude -\n@node ')).toBe(true)
    const r = parseAgentTools(out)
    expect(r.bins).toEqual({ claude: null, codex: null })
    expect(out).toMatch(/^@uid \d+$/m)
    expect(out).toMatch(/^@os \S+$/m)
  }, 60000)

  it('every command asked for, in the usual folders and the login shell\'s PATH; names that are not commands skipped', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agents-'))
    const home = posixPath(dir)
    tool(join(dir, '.local', 'bin', 'agy'))
    tool(join(dir, '.grok', 'bin', 'grok'))
    tool(join(dir, '.bun', 'bin', 'opencode'))
    tool(join(dir, 'loginbin', 'kiro-cli'))
    // The login shell (its .profile) adds a folder this session lacks, and
    // prints around it (a welcome line before, a goodbye after).
    script(join(dir, 'fakesh'), `echo 'Welcome to box'\nPATH='${home}/loginbin:/usr/bin:/bin'; export PATH\n[ "$1" = -lc ] && eval "$2"\necho 'bye from .bash_logout'`)
    const out = await agentsIn(dir, { SHELL: `${home}/fakesh` }, ['agy', 'grok', 'opencode', 'kiro-cli', 'gemini', '../etc', '-rf'])
    const r = parseAgentTools(out)
    expect(r.bins).toEqual({
      agy: `${home}/.local/bin/agy`,
      grok: `${home}/.grok/bin/grok`,
      opencode: `${home}/.bun/bin/opencode`,
      'kiro-cli': `${home}/loginbin/kiro-cli`,
      gemini: null
    })
    expect(out).not.toMatch(/^\.\.\/etc |^-rf /m)
  }, 60000)

  it('codex there: its --version and whether its --help has --no-daemon (Codex 0.156+), asked of that codex', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agents-'))
    const once = async () => {
      const out = await agentsIn(dir, {}, ['codex'])
      session.close('done')
      session = null
      return out
    }
    script(join(dir, '.local', 'bin', 'codex'), 'case "$1" in --version) echo "codex-cli 0.164.0" ;; --help) printf "Usage: codex\n      --no-daemon\n          Run without the shared background server\n" ;; esac')
    const r = parseAgentTools(await once())
    expect(r.codex).toBe(`${posixPath(dir)}/.local/bin/codex`)
    expect(r.host).toMatchObject({ codexVersion: '0.164.0', codexNoDaemon: true })
    // An older one: no such option.
    script(join(dir, '.local', 'bin', 'codex'), 'case "$1" in --version) echo "codex-cli 0.150.0" ;; --help) echo "Usage: codex [OPTIONS]" ;; esac')
    expect(parseAgentTools(await once()).host).toMatchObject({ codexVersion: '0.150.0', codexNoDaemon: false })
    // No codex there: nothing said.
    fs.rmSync(join(dir, '.local', 'bin', 'codex'))
    expect(await once()).not.toMatch(/^@codex/m)
  }, 60000)

  it('npm: its folder (where its agents are) and whether it is the user\'s; node and its version', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agents-'))
    const home = posixPath(dir)
    const prefix = join(dir, 'npmprefix')
    fs.mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true })
    tool(join(prefix, 'bin', 'gemini'))
    script(join(dir, '.local', 'bin', 'npm'), `case "$*" in *"config get prefix"*) echo '${posixPath(prefix)}' ;; esac`)
    script(join(dir, '.nvm', 'versions', 'node', 'v20.1.0', 'bin', 'node'), 'echo v20.1.0')
    script(join(dir, '.nvm', 'versions', 'node', 'v22.3.0', 'bin', 'node'), 'echo v22.3.0')
    const r = parseAgentTools(await agentsIn(dir, {}, ['gemini']))
    expect(r.bins.gemini).toBe(`${posixPath(prefix)}/bin/gemini`)
    expect(r.host).toMatchObject({ npm: `${home}/.local/bin/npm`, npmPrefix: posixPath(prefix), npmWritable: true })
    // The newest nvm Node.js first.
    expect(r.host).toMatchObject({ node: `${home}/.nvm/versions/node/v22.3.0/bin/node`, nodeMajor: 22 })
  }, 60000)

  // fish keeps $PATH as a list: a plain "$PATH" prints it with spaces (or
  // one per line), which read as one folder named "a b" (or the last folder).
  it('fish: its PATH asked its own way (string join), read between the markers', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agents-'))
    const home = posixPath(dir)
    tool(join(dir, 'fishpath', 'agy'))
    script(
      join(dir, 'fishbin', 'fish'),
      [
        "echo 'Welcome to fish, the friendly interactive shell'",
        '[ "$1" = -lc ] || exit 2',
        'case "$2" in',
        `  *'(string join : $PATH)'*) printf '@@TPATH@@%s@@TEND@@\\n' '${home}/fishpath:/usr/bin' ;;`,
        `  *) printf '@@TPATH@@%s@@TEND@@\\n' '${home}/fishpath /usr/bin' ;;`,
        'esac',
        `printf '%s\\n' '${home}/fishpath' /usr/bin`
      ].join('\n')
    )
    const r = parseAgentTools(await agentsIn(dir, { SHELL: `${home}/fishbin/fish` }, ['agy']))
    expect(r.bins.agy).toBe(`${home}/fishpath/agy`)
    expect(r.partial).toBe(false)
  }, 60000)

  // Stock macOS and BusyBox have no `timeout` command: the time limits are
  // the shell's own (a watchdog that ends the probe and what it started).
  it('a login shell that never ends (its .profile hangs), with no timeout command: given up after a few seconds, the rest still found, the answer partial', async () => {
    expect(prelude('0'.repeat(32))).not.toMatch(/(?<![-\w])timeout\s+["$\d]/) // the command, not curl's --connect-timeout
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agents-'))
    const home = posixPath(dir)
    tool(join(dir, '.local', 'bin', 'agy'))
    script(join(dir, 'hangsh'), 'echo half a line\nsleep 40')
    const t0 = Date.now()
    const out = await agentsIn(dir, { SHELL: `${home}/hangsh` }, ['agy', 'gemini'])
    const r = parseAgentTools(out)
    expect(r.bins).toEqual({ agy: `${home}/.local/bin/agy`, gemini: null })
    expect(out).toMatch(/^@partial login$/m)
    expect(r.partial).toBe(true)
    expect(Date.now() - t0).toBeLessThan(25000)
  }, 60000)

  it('npm that never answers: given up too, partial; a quick login shell alone is not', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agents-'))
    const home = posixPath(dir)
    tool(join(dir, '.local', 'bin', 'agy'))
    script(join(dir, 'quicksh'), `[ "$1" = -lc ] && eval "$2"`)
    const quick = await agentsIn(dir, { SHELL: `${home}/quicksh` }, ['agy'])
    expect(quick).not.toMatch(/^@partial/m)
    session.close('done')
    script(join(dir, '.local', 'bin', 'npm'), 'sleep 40')
    const t0 = Date.now()
    const out = await agentsIn(dir, { SHELL: `${home}/quicksh` }, ['agy'])
    expect(out).toMatch(/^@partial npm$/m)
    expect(parseAgentTools(out)).toMatchObject({ partial: true, bins: { agy: `${home}/.local/bin/agy` }, host: { npm: `${home}/.local/bin/npm`, npmPrefix: null } })
    expect(Date.now() - t0).toBeLessThan(25000)
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
