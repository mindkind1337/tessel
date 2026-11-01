// Claude Code's folder trust on an SSH host: the host's own function
// (__t_trust in remoteAccounts.sh, run for real under a POSIX sh against
// temporary files) and main's side (remoteAgentFolderTrust.js: which pane,
// which folder, which config, never without a signed-in connection).
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { ACCOUNTS_SHELL, ACCOUNT_FUNCTIONS, shellQuote } from '../remoteAccounts'
import { FUNCTIONS } from '../../remoteShell'
import { createRemoteAgentFolderTrust, parseTrustAnswer } from '../remoteAgentFolderTrust'
import { gitSh, posixPath } from '../../__tests__/fixtures/fakeSsh'

const SH = gitSh()
const WIN = process.platform === 'win32'
const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

// A Windows node or python run from Git's sh gets its paths through
// cygpath, without the drive (the same disk as its working folder): the
// paths it then sees are plain absolute POSIX ones, as on a host.
const nodeKey = (p) => (WIN ? p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/') : p)
function wrapper(dir, name, exe) {
  const file = join(dir, name)
  const body = WIN
    ? `#!/bin/sh\nfor v in TT_FILE TT_FOLDER TT_HOME; do\n  eval "x=\\$$v"\n  case $x in /) ;; /*) x=$(cygpath -m "$x" | sed 's/^[A-Za-z]://') ;; esac\n  export $v="$x"\ndone\nexport MSYS2_ENV_CONV_EXCL=TT_ MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'\nexec ${shellQuote(posixPath(exe))} "$@"\n`
    : `#!/bin/sh\nexec ${shellQuote(exe)} "$@"\n`
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}

let PYTHON = null
beforeAll(() => {
  const r = spawnSync(WIN ? 'python3' : 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 10000 })
  PYTHON = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null
})

// A fake host: its home, Tessel's helper folder (NODE names the node to use).
function host({ tool = 'node' } = {}) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-trust-'))
  dirs.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  fs.mkdirSync(home)
  fs.mkdirSync(bin)
  if (tool === 'node') {
    fs.mkdirSync(join(home, '.tessel-server', 'bin'), { recursive: true })
    fs.writeFileSync(join(home, '.tessel-server', 'bin', 'NODE'), `${posixPath(wrapper(bin, 'node-w', process.execPath))}\n`)
  } else if (tool === 'python') wrapper(bin, 'python3', PYTHON)
  const project = join(home, 'work', 'app')
  fs.mkdirSync(project, { recursive: true })
  return { root, home, bin, project }
}

function trust(h, config, folder) {
  const script = `${ACCOUNTS_SHELL}\nHOME=${shellQuote(posixPath(h.home))}\nPATH=${shellQuote(`${posixPath(h.bin)}:/usr/bin:/bin`)}\n__t_trust ${shellQuote(config)} ${shellQuote(folder)}\n`
  const r = spawnSync(SH, ['-s'], { input: script, encoding: 'utf8', cwd: os.tmpdir(), timeout: 30000 })
  return r.stdout.trim()
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => /tessel-trust|\.lock$/.test(n))

const toolOn = (name) => spawnSync(SH || 'sh', ['-c', `PATH=/usr/bin:/bin command -v ${name}`], { encoding: 'utf8' }).status === 0

describe.skipIf(!SH)('__t_trust on the host (node)', () => {
  it('is one of the functions the host session may run', () => {
    expect(ACCOUNT_FUNCTIONS).toContain('__t_trust')
    expect(FUNCTIONS.has('__t_trust')).toBe(true)
    expect(ACCOUNTS_SHELL).toContain('__t_trust() {')
  })

  it('creates a missing ~/.claude.json with the entry only, private', () => {
    const h = host()
    expect(trust(h, '-', posixPath(h.project))).toBe('granted')
    const file = join(h.home, '.claude.json')
    const cfg = readJson(file)
    expect(cfg.projects[nodeKey(h.project)]).toEqual({ hasTrustDialogAccepted: true })
    expect(Object.keys(cfg)).toEqual(['projects'])
    if (!WIN) expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(leftovers(h.home)).toEqual([])
  })

  it('keeps every other key and the project entry\'s own fields', () => {
    const h = host()
    const file = join(h.home, '.claude.json')
    const before = { numStartups: 12, oauthAccount: { emailAddress: 'a@b.cd' }, mcpServers: { x: { type: 'stdio', command: 'x' } }, projects: { '/elsewhere': { hasTrustDialogAccepted: true }, [nodeKey(h.project)]: { allowedTools: ['Bash'], history: [] } } }
    fs.writeFileSync(file, JSON.stringify(before, null, 2))
    if (!WIN) fs.chmodSync(file, 0o640)
    expect(trust(h, '-', posixPath(h.project))).toBe('granted')
    const cfg = readJson(file)
    expect(cfg.numStartups).toBe(12)
    expect(cfg.oauthAccount).toEqual(before.oauthAccount)
    expect(cfg.mcpServers).toEqual(before.mcpServers)
    expect(cfg.projects['/elsewhere']).toEqual({ hasTrustDialogAccepted: true })
    expect(cfg.projects[nodeKey(h.project)]).toEqual({ allowedTools: ['Bash'], history: [], hasTrustDialogAccepted: true })
    if (!WIN) expect(fs.statSync(file).mode & 0o777).toBe(0o640)
    expect(leftovers(h.home)).toEqual([])
  })

  it('leaves a folder already trusted untouched', () => {
    const h = host()
    const file = join(h.home, '.claude.json')
    const text = JSON.stringify({ projects: { [nodeKey(h.project)]: { hasTrustDialogAccepted: true } } })
    fs.writeFileSync(file, text)
    const t = new Date(2020, 0, 1)
    fs.utimesSync(file, t, t)
    expect(trust(h, '-', posixPath(h.project))).toBe('unchanged')
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
    expect(fs.statSync(file).mtimeMs).toBe(t.getTime())
  })

  it('never rewrites a file it cannot parse, or one that is not an object', () => {
    for (const text of ['{ "projects": ', '[]', '"x"', '', '{"projects": []}']) {
      const h = host()
      const file = join(h.home, '.claude.json')
      fs.writeFileSync(file, text)
      expect(trust(h, '-', posixPath(h.project))).toBe('unparseable')
      expect(fs.readFileSync(file, 'utf8')).toBe(text)
      expect(leftovers(h.home)).toEqual([])
    }
  })

  it('refuses /, the home folder, a folder above it, a relative path, a missing folder or a line break', () => {
    const h = host()
    const home = posixPath(h.home)
    for (const folder of ['/', '~', '~/', home, `${home}/`, posixPath(h.root), 'work/app', './app', `${home}/missing`, `${posixPath(h.project)}\nx`, '']) {
      expect(trust(h, '-', folder), folder).toBe('refused')
    }
    expect(fs.existsSync(join(h.home, '.claude.json'))).toBe(false)
  })

  it('takes ~/... from the home folder', () => {
    const h = host()
    expect(trust(h, '-', '~/work/app')).toBe('granted')
    expect(readJson(join(h.home, '.claude.json')).projects[nodeKey(h.project)]).toEqual({ hasTrustDialogAccepted: true })
  })

  it('takes a folder with spaces and a quote as it is', () => {
    const h = host()
    const odd = join(h.home, "it's my app")
    fs.mkdirSync(odd)
    expect(trust(h, '-', posixPath(odd))).toBe('granted')
    expect(readJson(join(h.home, '.claude.json')).projects[nodeKey(odd)]).toEqual({ hasTrustDialogAccepted: true })
  })

  it('waits for Claude Code\'s lock and never breaks it', () => {
    const h = host()
    const file = join(h.home, '.claude.json')
    fs.writeFileSync(file, '{}')
    fs.mkdirSync(`${file}.lock`)
    expect(trust(h, '-', posixPath(h.project))).toBe('locked')
    expect(fs.readFileSync(file, 'utf8')).toBe('{}')
    expect(fs.existsSync(`${file}.lock`)).toBe(true)
  })

  it('writes an account folder Tessel made (marker checked), never another', () => {
    const h = host()
    const acct = join(h.home, '.tessel-server', 'accounts', 'claude', 'abc123')
    fs.mkdirSync(acct, { recursive: true, mode: 0o700 })
    expect(trust(h, 'acct:abc123', posixPath(h.project))).toBe('refused')
    fs.writeFileSync(join(acct, '.tessel-account'), 'tessel-account claude abc123\n')
    fs.writeFileSync(join(acct, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x@y.zz' } }))
    expect(trust(h, 'acct:abc123', posixPath(h.project))).toBe('granted')
    const cfg = readJson(join(acct, '.claude.json'))
    expect(cfg.oauthAccount).toEqual({ emailAddress: 'x@y.zz' })
    expect(cfg.projects[nodeKey(h.project)]).toEqual({ hasTrustDialogAccepted: true })
    expect(fs.existsSync(join(h.home, '.claude.json'))).toBe(false)
    expect(trust(h, 'acct:../x', posixPath(h.project))).toBe('refused')
    expect(trust(h, 'acct:ABC', posixPath(h.project))).toBe('refused')
    expect(trust(h, 'relative/dir', posixPath(h.project))).toBe('refused')
  })

  it('writes the login shell\'s CLAUDE_CONFIG_DIR, and the older .config.json when it is there', () => {
    const h = host()
    const dir = join(h.root, 'cfg')
    fs.mkdirSync(dir)
    expect(trust(h, posixPath(dir), posixPath(h.project))).toBe('granted')
    expect(readJson(join(dir, '.claude.json')).projects[nodeKey(h.project)]).toEqual({ hasTrustDialogAccepted: true })
    expect(trust(h, posixPath(join(h.root, 'nope')), posixPath(h.project))).toBe('refused')
    const h2 = host()
    fs.mkdirSync(join(h2.home, '.claude'))
    fs.writeFileSync(join(h2.home, '.claude', '.config.json'), '{"a":1}')
    expect(trust(h2, '-', posixPath(h2.project))).toBe('granted')
    const legacy = readJson(join(h2.home, '.claude', '.config.json'))
    expect(legacy.a).toBe(1)
    expect(legacy.projects[nodeKey(h2.project)]).toEqual({ hasTrustDialogAccepted: true })
    expect(fs.existsSync(join(h2.home, '.claude.json'))).toBe(false)
  })

  it.skipIf(toolOn('node') || toolOn('python3'))('says no-tool (and changes nothing) without node or python3', () => {
    const h = host({ tool: 'none' })
    expect(trust(h, '-', posixPath(h.project))).toBe('no-tool')
    expect(fs.existsSync(join(h.home, '.claude.json'))).toBe(false)
  })
})

describe.skipIf(!SH)('__t_trust on the host (python3)', () => {
  it('does the same with python3 when there is no node', (ctx) => {
    if (!PYTHON || toolOn('node')) return ctx.skip()
    const h = host({ tool: 'python' })
    const file = join(h.home, '.claude.json')
    expect(trust(h, '-', posixPath(h.project))).toBe('granted')
    expect(readJson(file).projects[nodeKey(h.project)]).toEqual({ hasTrustDialogAccepted: true })
    fs.writeFileSync(file, JSON.stringify({ keep: { deep: [1, 'é'] }, projects: {} }))
    const odd = join(h.home, "it's here")
    fs.mkdirSync(odd)
    expect(trust(h, '-', posixPath(odd))).toBe('granted')
    const cfg = readJson(file)
    expect(cfg.keep).toEqual({ deep: [1, 'é'] })
    expect(cfg.projects[nodeKey(odd)]).toEqual({ hasTrustDialogAccepted: true })
    expect(trust(h, '-', posixPath(odd))).toBe('unchanged')
    fs.writeFileSync(file, '{"a": NaN}')
    expect(trust(h, '-', posixPath(h.project))).toBe('unparseable')
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a": NaN}')
    expect(trust(h, '-', '~')).toBe('refused')
    expect(leftovers(h.home)).toEqual([])
  })
})

describe('remote folder trust in main', () => {
  const HOST = 'ssh-box1'
  function service(over = {}) {
    const calls = []
    const svc = createRemoteAgentFolderTrust({
      run: async (hostId, fn, args, opts) => {
        calls.push({ hostId, fn, args, opts })
        return { rc: 0, out: 'granted\n' }
      },
      connected: () => true,
      isSavedHost: (id) => id === HOST || id === 'ssh-other',
      connectWaitMs: 50,
      pollMs: 10,
      ...over
    })
    svc.setRoots(['ssh://ssh-box1/srv/app', 'ssh://ssh-box1/~/proj', 'ssh://ssh-other/data/x'])
    return { svc, calls }
  }

  it('trusts a saved remote project of that host, or a folder below it', async () => {
    const { svc, calls } = service()
    expect(await svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', enabled: true })).toBe('granted')
    expect(await svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app/sub/', enabled: true })).toBe('granted')
    expect(await svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '~/proj', enabled: true })).toBe('granted')
    expect(calls.map((c) => c.args)).toEqual([['-', '/srv/app'], ['-', '/srv/app/sub'], ['-', '~/proj']])
    expect(calls.every((c) => c.fn === '__t_trust' && c.hostId === HOST && !c.opts.user)).toBe(true)
  })

  it('never a folder outside the saved projects, of another host, or one the window only names', async () => {
    const { svc, calls } = service()
    for (const remotePath of ['/srv/app2', '/srv', '/', '~', '/data/x', '/srv/app/../etc', 'srv/app', null, 42]) {
      expect(await svc.apply({ agentId: 'claude', hostId: HOST, remotePath, enabled: true }), String(remotePath)).toBe('not-eligible')
    }
    expect(await svc.apply({ agentId: 'claude', hostId: 'ssh-unsaved', remotePath: '/srv/app', enabled: true })).toBe('not-eligible')
    expect(await svc.apply({ agentId: 'claude', hostId: 'wsl-Ubuntu', remotePath: '/srv/app', enabled: true })).toBe('not-eligible')
    svc.setRoots([])
    expect(await svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', enabled: true })).toBe('not-eligible')
    expect(calls).toEqual([])
  })

  it('only with the setting on, and only for Claude Code', async () => {
    const { svc, calls } = service()
    expect(await svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', enabled: false })).toBe('off')
    expect(await svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app' })).toBe('off')
    expect(await svc.apply({ agentId: 'codex', hostId: HOST, remotePath: '/srv/app', enabled: true })).toBe('no-preset')
    expect(await svc.apply({ agentId: 'gemini', hostId: HOST, remotePath: '/srv/app', enabled: true })).toBe('no-preset')
    expect(calls).toEqual([])
  })

  it('never without a signed-in connection (no sign-in of its own)', async () => {
    const { svc, calls } = service({ connected: () => false })
    expect(await svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', enabled: true })).toBe('not-connected')
    expect(calls).toEqual([])
    let up = false
    setTimeout(() => (up = true), 20)
    const late = service({ connected: () => up })
    expect(await late.svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', enabled: true })).toBe('granted')
    const gone = service({ run: async () => ({ notConnected: true, error: 'x' }) })
    expect(await gone.svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', enabled: true })).toBe('not-connected')
  })

  it('writes the config the agent reads: its account folder, the login shell\'s folder, or its own', async () => {
    const { svc, calls } = service({ loginDir: (h, a) => (h === HOST && a === 'claude' ? '/opt/claude-cfg' : undefined) })
    await svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', hostAccount: 'abc123', enabled: true })
    await svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', enabled: true })
    expect(await svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', hostAccount: '../x', enabled: true })).toBe('invalid')
    expect(calls.map((c) => c.args[0])).toEqual(['acct:abc123', '/opt/claude-cfg'])
    const plain = service({ loginDir: () => null })
    await plain.svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', enabled: true })
    expect(plain.calls[0].args[0]).toBe('-')
  })

  it('matches ~/... and the full path through the host\'s home', async () => {
    const { svc, calls } = service({ homeOf: async () => ({ ok: true, home: '/home/me' }) })
    expect(await svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/home/me/proj/a', enabled: true })).toBe('granted')
    expect(calls[0].args).toEqual(['-', '/home/me/proj/a'])
    expect(await svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/home/me/projx', enabled: true })).toBe('not-eligible')
  })

  it('never throws and never waits past its deadline', async () => {
    const stuck = createRemoteAgentFolderTrust({ run: () => new Promise(() => {}), connected: () => true, isSavedHost: () => true, deadlineMs: 60 })
    stuck.setRoots(['ssh://ssh-box1/srv/app'])
    const t0 = Date.now()
    expect(await stuck.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', enabled: true })).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(1000)
    const broken = service({ run: async () => { throw new Error('boom') } })
    expect(await broken.svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', enabled: true })).toBe('failed')
    const odd = service({ run: async () => ({ rc: 0, out: 'something else' }) })
    expect(await odd.svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', enabled: true })).toBe('failed')
  })

  it('reads only the words the host may answer', () => {
    expect(parseTrustAnswer({ rc: 0, out: Buffer.from('unchanged\n') })).toBe('unchanged')
    expect(parseTrustAnswer({ rc: 0, out: 'no-tool' })).toBe('no-tool')
    expect(parseTrustAnswer({ rc: 1, out: 'granted' })).toBe('failed')
    expect(parseTrustAnswer({ rc: 0, out: 'granted; rm -rf' })).toBe('failed')
    expect(parseTrustAnswer({ error: 'x' })).toBe('failed')
    expect(parseTrustAnswer(null)).toBe('failed')
  })
})
