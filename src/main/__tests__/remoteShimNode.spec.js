// @vitest-environment node
// The node that runs Tessel's shim on an SSH host (__t_findnode, __t_ragent
// in remoteShell.js): a host with no Node.js of its own but VS Code
// Remote-SSH's copy (a PHP web server used through VS Code) still gets the
// shim and its tools registered, and Claude Code known only as VS Code's copy
// is set up too (its ~/.claude made). A POSIX sh plays the host (fake ssh).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRemoteSession, sessionArgs } from '../remoteShell'
import { gitSh, fakeSshLaunch, posixPath } from './fixtures/fakeSsh'

// A fake node: answers the version check, prints how the install was run.
const FAKE_NODE = '#!/bin/sh\nif [ "$1" = -p ]; then echo 20; exit 0; fi\necho "{\\"ran\\":\\"$*\\"}"\n'

describe.skipIf(!gitSh())('the shim on a host with only VS Code\'s node (fake ssh)', () => {
  let dir
  let session
  afterEach(() => {
    if (session) session.close('done')
    session = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })
  const exe = (p, text) => {
    fs.mkdirSync(join(p, '..'), { recursive: true })
    fs.writeFileSync(p, text)
    fs.chmodSync(p, 0o755)
  }
  async function ragent(home) {
    const launch = fakeSshLaunch({ home })
    session = createRemoteSession({
      file: launch.file,
      args: sessionArgs(launch.args),
      // No node on this PATH, and the login shell finds none.
      env: { SystemRoot: process.env.SystemRoot || '', PATH: process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin', SHELL: '/usr/bin/false' },
      spawnImpl: launch.spawnImpl
    })
    await session.start()
    return session.run('__t_ragent', ['9.9.9'], { cap: 64 * 1024, timeoutMs: 30000, upload: Buffer.from("const VERSION = '9.9.9'\n") })
  }

  it('uses the newest VS Code server node, and makes ~/.claude for VS Code\'s Claude Code', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-shimnode-'))
    const home = posixPath(dir)
    exe(join(dir, '.vscode-server', 'cli', 'servers', 'Stable-abc', 'server', 'node'), FAKE_NODE)
    exe(join(dir, '.vscode-server', 'extensions', 'anthropic.claude-code-2.1.288-linux-x64', 'resources', 'native-binary', 'claude'), '#!/bin/sh\n')
    const res = await ragent(dir)
    expect(res.rc).toBe(0)
    const node = `${home}/.vscode-server/cli/servers/Stable-abc/server/node`
    expect(res.out.toString('utf8')).toContain(`install --node ${node}`)
    expect(fs.readFileSync(join(dir, '.tessel-server', 'bin', 'NODE'), 'utf8').trim()).toBe(node)
    expect(fs.statSync(join(dir, '.claude')).isDirectory()).toBe(true)
  }, 60000)

  it('no node anywhere: 81 (no-node), and no ~/.claude made', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-shimnode-'))
    const res = await ragent(dir)
    expect(res.rc).toBe(81)
    expect(fs.existsSync(join(dir, '.claude'))).toBe(false)
  }, 60000)

  it('Claude Code\'s own settings there already: left as they are', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-shimnode-'))
    exe(join(dir, '.vscode-server', 'bin', 'abc', 'node'), FAKE_NODE)
    fs.writeFileSync(join(dir, '.claude.json'), '{}\n')
    exe(join(dir, '.vscode-server', 'extensions', 'anthropic.claude-code-2.1.288-linux-x64', 'resources', 'native-binary', 'claude'), '#!/bin/sh\n')
    const res = await ragent(dir)
    expect(res.rc).toBe(0)
    expect(res.out.toString('utf8')).toContain(`install --node ${posixPath(dir)}/.vscode-server/bin/abc/node`)
    expect(fs.existsSync(join(dir, '.claude'))).toBe(false)
  }, 60000)
})
