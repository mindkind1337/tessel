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
// cygpath, without the drive (the same disk as its working folder), and its
// realpath answers the same way: the paths it sees are plain absolute POSIX
// ones, as on a host.
const nodeKey = (p) => (WIN ? p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/') : p)
const STRIP_JS = `const fs=require("fs");const o=fs.realpathSync;const s=(r)=>typeof r==="string"&&/^[A-Za-z]:/.test(r)?r.slice(2).replace(/\\\\/g,"/"):r;fs.realpathSync=function(...a){return s(o.apply(this,a))};fs.realpathSync.native=fs.realpathSync\n`
const STRIP_PY = `import os as _o, re as _r\n_rp = _o.path.realpath\n_o.path.realpath = lambda p, *a, **k: (lambda r: r[2:].replace(chr(92), "/") if _r.match("^[A-Za-z]:", r) else r)(_rp(p, *a, **k))\n`
function wrapper(dir, name, exe) {
  const file = join(dir, name)
  let body
  if (!WIN) body = `#!/bin/sh\nexec ${shellQuote(exe)} "$@"\n`
  else {
    const conv = `for v in TT_FILE TT_FOLDER TT_HOME; do\n  eval "x=\\$$v"\n  case $x in /) ;; /*) x=$(cygpath -m "$x" | sed 's/^[A-Za-z]://') ;; esac\n  export $v="$x"\ndone\nexport MSYS2_ENV_CONV_EXCL=TT_ MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'\n`
    if (name === 'python3') {
      fs.writeFileSync(join(dir, 'strip.py'), STRIP_PY)
      body = `#!/bin/sh\n${conv}exec ${shellQuote(posixPath(exe))} -I -c "$(cat ${shellQuote(posixPath(join(dir, 'strip.py')))})\n$3"\n`
    } else {
      fs.writeFileSync(join(dir, 'strip.cjs'), STRIP_JS)
      body = `#!/bin/sh\n${conv}export NODE_OPTIONS=--require=${join(dir, 'strip.cjs').replace(/\\/g, '/')}\nexec ${shellQuote(posixPath(exe))} "$@"\n`
    }
  }
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}

let PYTHON = null
beforeAll(() => {
  const r = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 10000 })
  PYTHON = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null
})

// A fake host: its home, Tessel's helper folder (NODE names the node to use).
function host({ tool = 'node' } = {}) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-trust-'))
  dirs.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  fs.mkdirSync(home, { mode: 0o755 })
  fs.mkdirSync(bin)
  if (!WIN) fs.chmodSync(home, 0o755)
  if (tool === 'node') useNode({ home, bin }, wrapper(bin, 'node-w', process.execPath))
  else if (tool === 'python') wrapper(bin, 'python3', PYTHON)
  const project = join(home, 'work', 'app')
  fs.mkdirSync(project, { recursive: true })
  return { root, home, bin, project }
}
function useNode(h, file) {
  fs.mkdirSync(join(h.home, '.tessel-server', 'bin'), { recursive: true })
  fs.writeFileSync(join(h.home, '.tessel-server', 'bin', 'NODE'), `${posixPath(file)}\n`)
}
const soon = (s = 60) => String(Math.floor(Date.now() / 1000) + s)

function trust(h, config, folder, deadline = soon()) {
  const script = `${ACCOUNTS_SHELL}\nHOME=${shellQuote(posixPath(h.home))}\nPATH=${shellQuote(`${posixPath(h.bin)}:/usr/bin:/bin`)}\n__t_trust ${shellQuote(config)} ${shellQuote(folder)} ${shellQuote(deadline)}\n`
  const r = spawnSync(SH, ['-s'], { input: script, encoding: 'utf8', cwd: os.tmpdir(), timeout: 30000 })
  return r.stdout.trim()
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => /tessel-trust|\.lock$/.test(n))
// A link to a folder (a junction on Windows: no privilege needed).
const linkDir = (target, path) => fs.symlinkSync(target, path, WIN ? 'junction' : 'dir')

const toolOn = (name) => spawnSync(SH || 'sh', ['-c', `PATH=/usr/bin:/bin command -v ${name}`], { encoding: 'utf8' }).status === 0

describe.skipIf(!SH)('__t_trust on the host (node)', { timeout: 60000 }, () => {
  it('is one of the functions the host session may run', () => {
    expect(ACCOUNT_FUNCTIONS).toContain('__t_trust')
    expect(FUNCTIONS.has('__t_trust')).toBe(true)
    expect(ACCOUNTS_SHELL).toContain('__t_trust() {')
  })

  it('creates a missing ~/.claude.json with the entry only, private', () => {
    const h = host()
    expect(trust(h, '-', posixPath(h.project))).toBe('granted')
    const file = join(h.home, '.claude.json')
    expect(readJson(file)).toEqual({ projects: { [nodeKey(h.project)]: { hasTrustDialogAccepted: true } } })
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
    expect(readJson(file)).toEqual({ ...before, projects: { ...before.projects, [nodeKey(h.project)]: { allowedTools: ['Bash'], history: [], hasTrustDialogAccepted: true } } })
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
    expect(trust(h, '-', posixPath(h.project), 'soon')).toBe('refused')
    expect(fs.existsSync(join(h.home, '.claude.json'))).toBe(false)
  })

  it('never trusts the place a link names: a linked project folder, or a link inside one', () => {
    const h = host()
    const elsewhere = join(h.root, 'elsewhere')
    fs.mkdirSync(elsewhere)
    const linkedRoot = join(h.home, 'work', 'linked')
    linkDir(elsewhere, linkedRoot)
    const linkedSub = join(h.project, 'docs')
    linkDir(elsewhere, linkedSub)
    expect(trust(h, '-', posixPath(linkedRoot))).toBe('refused')
    expect(trust(h, '-', posixPath(linkedSub))).toBe('refused')
    expect(trust(h, '-', '~/work/linked')).toBe('refused')
    expect(fs.existsSync(join(h.home, '.claude.json'))).toBe(false)
  })

  it('follows a home folder that is itself a link, and trusts both names of the project', () => {
    const h = host()
    const realHome = join(h.root, 'realhome')
    fs.renameSync(h.home, realHome)
    linkDir(realHome, h.home)
    expect(trust(h, '-', '~/work/app')).toBe('granted')
    const projects = readJson(join(realHome, '.claude.json')).projects
    expect(projects[nodeKey(h.project)]).toEqual({ hasTrustDialogAccepted: true })
    expect(projects[nodeKey(join(realHome, 'work', 'app'))]).toEqual({ hasTrustDialogAccepted: true })
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

  it('writes nothing once its deadline has passed', () => {
    const h = host()
    expect(trust(h, '-', posixPath(h.project), String(Math.floor(Date.now() / 1000) - 1))).toBe('late')
    expect(fs.existsSync(join(h.home, '.claude.json'))).toBe(false)
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

  it('ends a write that runs out of time and removes the lock and temporary file it left', () => {
    const h = host({ tool: 'none' })
    // A "node" that takes the lock, starts its temporary file, then hangs.
    const hang = join(h.bin, 'hang')
    fs.writeFileSync(hang, '#!/bin/sh\nmkdir "$TT_FILE.lock"\necho @lock\n: > "${TT_FILE%/*}/.${TT_FILE##*/}.tessel-trust"\nsleep 20\necho granted\n', { mode: 0o755 })
    useNode(h, hang)
    const t0 = Date.now()
    expect(trust(h, '-', posixPath(h.project), soon(2))).toBe('failed')
    expect(Date.now() - t0).toBeLessThan(15000)
    expect(leftovers(h.home)).toEqual([])
    expect(fs.existsSync(join(h.home, '.claude.json'))).toBe(false)
  })

  it.skipIf(WIN)('refuses a config folder others may write to (unless sticky)', () => {
    const h = host()
    fs.chmodSync(h.home, 0o775)
    if ((fs.statSync(h.home).mode & 0o777) !== 0o775) return
    expect(trust(h, '-', posixPath(h.project))).toBe('refused')
    fs.chmodSync(h.home, 0o777)
    expect(trust(h, '-', posixPath(h.project))).toBe('refused')
    expect(fs.existsSync(join(h.home, '.claude.json'))).toBe(false)
    fs.chmodSync(h.home, 0o1777)
    expect(trust(h, '-', posixPath(h.project))).toBe('granted')
    fs.chmodSync(h.home, 0o755)
    // A linked ~/.claude.json whose real folder others may write to.
    const h2 = host()
    const shared = join(h2.root, 'shared')
    fs.mkdirSync(shared)
    fs.chmodSync(shared, 0o777)
    fs.writeFileSync(join(shared, 'c.json'), '{}')
    fs.symlinkSync(join(shared, 'c.json'), join(h2.home, '.claude.json'))
    expect(trust(h2, '-', posixPath(h2.project))).toBe('refused')
    expect(fs.readFileSync(join(shared, 'c.json'), 'utf8')).toBe('{}')
  })

  it('writes an account folder Tessel made (marker checked), never another', () => {
    const h = host()
    const acct = join(h.home, '.tessel-server', 'accounts', 'claude', 'abc123')
    fs.mkdirSync(acct, { recursive: true, mode: 0o700 })
    if (!WIN) fs.chmodSync(acct, 0o700)
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
    if (!WIN) fs.chmodSync(dir, 0o755)
    expect(trust(h, posixPath(dir), posixPath(h.project))).toBe('granted')
    expect(readJson(join(dir, '.claude.json')).projects[nodeKey(h.project)]).toEqual({ hasTrustDialogAccepted: true })
    expect(trust(h, posixPath(join(h.root, 'nope')), posixPath(h.project))).toBe('refused')
    const h2 = host()
    fs.mkdirSync(join(h2.home, '.claude'))
    if (!WIN) fs.chmodSync(join(h2.home, '.claude'), 0o700)
    fs.writeFileSync(join(h2.home, '.claude', '.config.json'), '{"a":1}')
    expect(trust(h2, '-', posixPath(h2.project))).toBe('granted')
    expect(readJson(join(h2.home, '.claude', '.config.json'))).toEqual({ a: 1, projects: { [nodeKey(h2.project)]: { hasTrustDialogAccepted: true } } })
    expect(fs.existsSync(join(h2.home, '.claude.json'))).toBe(false)
  })

  it.skipIf(toolOn('node') || toolOn('python3'))('says no-tool (and changes nothing) without node or python3', () => {
    const h = host({ tool: 'none' })
    expect(trust(h, '-', posixPath(h.project))).toBe('no-tool')
    expect(fs.existsSync(join(h.home, '.claude.json'))).toBe(false)
  })
})

describe.skipIf(!SH)('__t_trust on the host (python3)', { timeout: 60000 }, () => {
  it('does the same with python3 when there is no node', (ctx) => {
    if (!PYTHON || toolOn('node')) return ctx.skip()
    const h = host({ tool: 'python' })
    const file = join(h.home, '.claude.json')
    expect(trust(h, '-', posixPath(h.project))).toBe('granted')
    expect(readJson(file)).toEqual({ projects: { [nodeKey(h.project)]: { hasTrustDialogAccepted: true } } })
    fs.writeFileSync(file, JSON.stringify({ keep: { deep: [1, 'é'] }, projects: {} }))
    const odd = join(h.home, "it's here")
    fs.mkdirSync(odd)
    expect(trust(h, '-', posixPath(odd))).toBe('granted')
    const cfg = readJson(file)
    expect(cfg.keep).toEqual({ deep: [1, 'é'] })
    expect(cfg.projects[nodeKey(odd)]).toEqual({ hasTrustDialogAccepted: true })
    expect(trust(h, '-', posixPath(odd))).toBe('unchanged')
    const elsewhere = join(h.root, 'elsewhere')
    fs.mkdirSync(elsewhere)
    linkDir(elsewhere, join(h.project, 'docs'))
    expect(trust(h, '-', posixPath(join(h.project, 'docs')))).toBe('refused')
    fs.writeFileSync(file, '{"a": NaN}')
    expect(trust(h, '-', posixPath(h.project))).toBe('unparseable')
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a": NaN}')
    expect(trust(h, '-', '~')).toBe('refused')
    expect(trust(h, '-', posixPath(h.project), String(Math.floor(Date.now() / 1000) - 1))).toBe('late')
    expect(leftovers(h.home)).toEqual([])
  })
})

describe('remote folder trust in main', () => {
  const HOST = 'ssh-box1'
  function service(over = {}) {
    const calls = []
    const learned = []
    const svc = createRemoteAgentFolderTrust({
      run: async (hostId, fn, args, opts) => {
        calls.push({ hostId, fn, args, opts })
        return { rc: 0, out: 'granted\n' }
      },
      connected: () => true,
      loginDir: () => null,
      learnLoginDir: (h) => learned.push(h),
      isSavedHost: (id) => id === HOST || id === 'ssh-other',
      connectWaitMs: 50,
      pollMs: 10,
      ...over
    })
    svc.setRoots(['ssh://ssh-box1/srv/app', 'ssh://ssh-box1/~/proj', 'ssh://ssh-other/data/x'])
    return { svc, calls, learned }
  }
  const go = (svc, more) => svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app', enabled: true, ...more })

  it('trusts exactly a saved remote project of that host', async () => {
    const { svc, calls } = service()
    expect(await go(svc)).toBe('granted')
    expect(await go(svc, { remotePath: '/srv/app/' })).toBe('granted')
    expect(await go(svc, { remotePath: '~/proj' })).toBe('granted')
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([['-', '/srv/app'], ['-', '/srv/app'], ['-', '~/proj']])
    expect(calls.every((c) => c.fn === '__t_trust' && c.hostId === HOST && !c.opts.user)).toBe(true)
  })

  it('never a folder below a project (Claude Code inherits its trust), outside one, of another host, or one the window only names', async () => {
    const { svc, calls } = service()
    for (const remotePath of ['/srv/app/sub', '/srv/app/docs', '~/proj/x', '/srv/app2', '/srv', '/', '~', '/data/x', '/srv/app/../etc', 'srv/app', null, 42]) {
      expect(await go(svc, { remotePath }), String(remotePath)).toBe('not-eligible')
    }
    expect(await go(svc, { hostId: 'ssh-unsaved' })).toBe('not-eligible')
    expect(await go(svc, { hostId: 'wsl-Ubuntu' })).toBe('not-eligible')
    svc.setRoots([])
    expect(await go(svc)).toBe('not-eligible')
    expect(calls).toEqual([])
  })

  it('never the folder of a conversation resumed from the host\'s transcripts, unless it is exactly a saved project', async () => {
    const { svc, calls } = service()
    // The cwd a host transcript reports (sessions:listRemote rows): never consent by itself.
    for (const cwd of ['/tmp/x', '/srv/app/worktree-1', '/home/me', '/srv/app/./sub']) expect(await go(svc, { remotePath: cwd }), cwd).toBe('not-eligible')
    expect(calls).toEqual([])
    expect(await go(svc, { remotePath: '/srv/app' })).toBe('granted')
  })

  it('only with the setting on, and only for Claude Code', async () => {
    const { svc, calls } = service()
    expect(await go(svc, { enabled: false })).toBe('off')
    expect(await svc.apply({ agentId: 'claude', hostId: HOST, remotePath: '/srv/app' })).toBe('off')
    expect(await go(svc, { agentId: 'codex' })).toBe('no-preset')
    expect(await go(svc, { agentId: 'gemini' })).toBe('no-preset')
    expect(calls).toEqual([])
  })

  it('answers at once when the host is not signed in and no pane of it is connecting', async () => {
    const { svc, calls } = service({ connected: () => false, connectWaitMs: 2000 })
    const t0 = Date.now()
    expect(await go(svc)).toBe('not-connected')
    expect(Date.now() - t0).toBeLessThan(150)
    expect(calls).toEqual([])
  })

  it('waits briefly for a pane of the host that is connecting, never past that', async () => {
    let up = false
    setTimeout(() => (up = true), 20)
    const late = service({ connected: () => up, connecting: () => true })
    expect(await go(late.svc)).toBe('granted')
    const never = service({ connected: () => false, connecting: () => true })
    const t0 = Date.now()
    expect(await go(never.svc)).toBe('not-connected')
    expect(Date.now() - t0).toBeLessThan(500)
    const gone = service({ run: async () => ({ notConnected: true, error: 'x' }) })
    expect(await go(gone.svc)).toBe('not-connected')
  })

  it('writes the config the agent reads: its account folder, the login shell\'s folder, or its own', async () => {
    const { svc, calls } = service({ loginDir: (h, a) => (h === HOST && a === 'claude' ? '/opt/claude-cfg' : undefined) })
    await go(svc, { hostAccount: 'abc123' })
    await go(svc)
    expect(await go(svc, { hostAccount: '../x' })).toBe('invalid')
    expect(calls.map((c) => c.args[0])).toEqual(['acct:abc123', '/opt/claude-cfg'])
    const plain = service({ loginDir: () => null })
    await go(plain.svc)
    expect(plain.calls[0].args[0]).toBe('-')
  })

  it('writes nothing while the login shell\'s CLAUDE_CONFIG_DIR is not known, and has it read for the next start', async () => {
    const { svc, calls, learned } = service({ loginDir: () => undefined })
    expect(await go(svc)).toBe('not-known')
    expect(calls).toEqual([])
    expect(learned).toEqual([HOST])
    // An account folder names its own config: no need to know the login shell's.
    expect(await go(svc, { hostAccount: 'abc123' })).toBe('granted')
    expect(calls[0].args[0]).toBe('acct:abc123')
  })

  it('gives the host a deadline it writes nothing past, and no more time than is left', async () => {
    const { svc, calls } = service({ deadlineMs: 4000 })
    const before = Math.floor(Date.now() / 1000)
    await go(svc)
    const [, , deadline] = calls[0].args
    expect(deadline).toMatch(/^\d+$/)
    expect(Number(deadline)).toBeGreaterThanOrEqual(before + 3)
    expect(Number(deadline)).toBeLessThanOrEqual(before + 5)
    expect(calls[0].opts.timeoutMs).toBeLessThanOrEqual(4000)
    expect(calls[0].opts.timeoutMs).toBeGreaterThan(3000)
  })

  it('matches ~/... and the full path through the host\'s home, exactly', async () => {
    const { svc, calls } = service({ homeOf: async () => ({ ok: true, home: '/home/me' }) })
    expect(await go(svc, { remotePath: '/home/me/proj' })).toBe('granted')
    expect(calls[0].args.slice(0, 2)).toEqual(['-', '/home/me/proj'])
    expect(await go(svc, { remotePath: '/home/me/proj/a' })).toBe('not-eligible')
    expect(await go(svc, { remotePath: '/home/me/projx' })).toBe('not-eligible')
  })

  it('never throws and never waits past its deadline', async () => {
    const stuck = createRemoteAgentFolderTrust({ run: () => new Promise(() => {}), connected: () => true, loginDir: () => null, isSavedHost: () => true, deadlineMs: 1500 })
    stuck.setRoots(['ssh://ssh-box1/srv/app'])
    const t0 = Date.now()
    expect(await go(stuck)).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(2500)
    const broken = service({ run: async () => { throw new Error('boom') } })
    expect(await go(broken.svc)).toBe('failed')
    const odd = service({ run: async () => ({ rc: 0, out: 'something else' }) })
    expect(await go(odd.svc)).toBe('failed')
  })

  it('reads only the words the host may answer', () => {
    expect(parseTrustAnswer({ rc: 0, out: Buffer.from('unchanged\n') })).toBe('unchanged')
    expect(parseTrustAnswer({ rc: 0, out: 'late' })).toBe('late')
    expect(parseTrustAnswer({ rc: 0, out: 'no-tool' })).toBe('no-tool')
    expect(parseTrustAnswer({ rc: 1, out: 'granted' })).toBe('failed')
    expect(parseTrustAnswer({ rc: 0, out: 'granted; rm -rf' })).toBe('failed')
    expect(parseTrustAnswer({ error: 'x' })).toBe('failed')
    expect(parseTrustAnswer(null)).toBe('failed')
  })
})
