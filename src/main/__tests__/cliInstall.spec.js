import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SHIM_MARK,
  addPathEntry,
  cliBinDir,
  cliCommandName,
  cliScriptPath,
  createCliInstaller,
  createUserPathRegistry,
  hasPathEntry,
  removePathEntry,
  samePathEntry,
  shimText
} from '../cliInstall'

// Never the real user PATH: a registry double with the same contract.
function fakeRegistry(initial = { exists: true, value: '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\tools', kind: 'ExpandString' }) {
  const reg = { state: { ...initial }, writes: [] }
  reg.read = vi.fn(async () => ({ ...reg.state }))
  reg.write = vi.fn(async (change) => {
    reg.writes.push(change)
    if (change.expected.value !== reg.state.value || change.expected.exists !== reg.state.exists) throw new Error('changed')
    reg.state = { exists: change.value !== '', value: change.value, kind: change.kind }
  })
  return reg
}

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-cli-inst-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const env = { USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }

describe('names and paths', () => {
  it('the dev build has its own command', () => {
    expect(cliCommandName(true)).toBe('tessel')
    expect(cliCommandName(false)).toBe('tessel-dev')
  })

  it('the command lives in the user’s local app data', () => {
    expect(cliBinDir(env)).toBe(path.join('C:\\Users\\me\\AppData\\Local', 'Tessel', 'bin'))
  })

  it('the script is taken outside the app archive', () => {
    expect(cliScriptPath('C:\\Tessel\\resources\\app.asar\\out\\main')).toBe(path.join('C:\\Tessel\\resources\\app.asar.unpacked\\out\\main', 'cli.js'))
    expect(cliScriptPath('C:\\dev\\out\\main')).toBe(path.join('C:\\dev\\out\\main', 'cli.js'))
  })
})

describe('shimText', () => {
  it('runs Tessel’s executable as Node with the script and its data folder', () => {
    const text = shimText({ execPath: 'C:\\P\\Tessel.exe', scriptPath: 'C:\\P\\cli.js', userData: 'C:\\U\\tessel', appPath: 'C:\\P\\Tessel.exe' })
    expect(text).toContain(SHIM_MARK)
    expect(text).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    expect(text).toContain('set "TESSEL_CLI_USER_DATA=C:\\U\\tessel"')
    expect(text).toContain('"C:\\P\\Tessel.exe" "C:\\P\\cli.js" %*')
    expect(text.startsWith('@echo off\r\n')).toBe(true)
  })

  it('keeps a % in a folder name literal', () => {
    expect(shimText({ execPath: 'C:\\100%\\T.exe', scriptPath: 'c', userData: 'u' })).toContain('"C:\\100%%\\T.exe"')
  })

  it('refuses characters a batch file cannot hold', () => {
    expect(() => shimText({ execPath: 'C:\\a"b', scriptPath: 'c', userData: 'u' })).toThrow()
    expect(() => shimText({ execPath: 'C:\\a', scriptPath: 'c\nx', userData: 'u' })).toThrow()
  })
})

describe('PATH values', () => {
  it('compares entries without case, quotes, slashes or a trailing backslash', () => {
    expect(samePathEntry('"c:/users/me/appdata/local/tessel/bin\\"', 'C:\\Users\\me\\AppData\\Local\\Tessel\\bin', env)).toBe(true)
    expect(samePathEntry('%LOCALAPPDATA%\\Tessel\\bin', 'C:\\Users\\me\\AppData\\Local\\Tessel\\bin', env)).toBe(true)
    expect(samePathEntry('C:\\Tessel\\bin2', 'C:\\Tessel\\bin', env)).toBe(false)
  })

  it('adds at the end once, and removes only that entry', () => {
    const before = '%USERPROFILE%\\x;;C:\\tools;'
    const added = addPathEntry(before, 'C:\\T\\bin', env)
    expect(added).toBe('%USERPROFILE%\\x;;C:\\tools;C:\\T\\bin')
    expect(addPathEntry(added, 'c:\\t\\bin\\', env)).toBe(added)
    expect(removePathEntry(added, 'C:\\T\\bin', env)).toBe('%USERPROFILE%\\x;;C:\\tools')
    expect(addPathEntry('', 'C:\\T\\bin', env)).toBe('C:\\T\\bin')
    expect(removePathEntry('C:\\T\\bin', 'C:\\T\\bin', env)).toBe('')
    expect(hasPathEntry('a;C:\\T\\bin', 'C:\\T\\bin', env)).toBe(true)
  })
})

describe('createCliInstaller', () => {
  const make = (reg, over = {}) =>
    createCliInstaller({
      binDir: path.join(dir, 'bin'),
      name: 'tessel',
      shim: () => shimText({ execPath: 'C:\\P\\Tessel.exe', scriptPath: 'C:\\P\\cli.js', userData: 'C:\\U' }),
      registry: reg,
      env,
      platform: 'win32',
      ...over
    })

  it('Register writes the command and adds its folder to the user PATH, keeping the value’s kind', async () => {
    const reg = fakeRegistry()
    const inst = make(reg)
    expect((await inst.status()).state).toBe('not_installed')
    const st = await inst.install()
    expect(st).toMatchObject({ state: 'installed', onPath: true, shim: true, current: true, commandPath: path.join(dir, 'bin', 'tessel.cmd') })
    expect(reg.state.value).toBe(`%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\tools;${path.join(dir, 'bin')}`)
    expect(reg.state.kind).toBe('ExpandString')
    expect(reg.writes[0].expected.value).toBe('%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\tools')
    // Again: nothing more is written to the PATH.
    await inst.install()
    expect(reg.writes).toHaveLength(1)
  })

  it('Remove undoes both and leaves the other entries as they were', async () => {
    const reg = fakeRegistry({ exists: true, value: 'C:\\a;C:\\b', kind: 'String' })
    const inst = make(reg)
    await inst.install()
    const st = await inst.uninstall()
    expect(st.state).toBe('not_installed')
    expect(reg.state.value).toBe('C:\\a;C:\\b')
    expect(reg.state.kind).toBe('String')
    expect(fs.existsSync(path.join(dir, 'bin'))).toBe(false)
  })

  it('a user without a PATH value gets an expandable one', async () => {
    const reg = fakeRegistry({ exists: false, value: '', kind: 'ExpandString' })
    await make(reg).install()
    expect(reg.state).toEqual({ exists: true, value: path.join(dir, 'bin'), kind: 'ExpandString' })
  })

  it('keeps the folder on the PATH while the other build’s command is in it', async () => {
    const reg = fakeRegistry()
    await make(reg).install()
    const dev = make(reg, { name: 'tessel-dev' })
    await dev.install()
    await dev.uninstall()
    expect(hasPathEntry(reg.state.value, path.join(dir, 'bin'), env)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'bin', 'tessel.cmd'))).toBe(true)
  })

  it('never overwrites a tessel.cmd it did not write', async () => {
    const reg = fakeRegistry()
    fs.mkdirSync(path.join(dir, 'bin'))
    fs.writeFileSync(path.join(dir, 'bin', 'tessel.cmd'), '@echo mine')
    await expect(make(reg).install()).rejects.toThrow(/not written by Tessel/)
    expect(fs.readFileSync(path.join(dir, 'bin', 'tessel.cmd'), 'utf8')).toBe('@echo mine')
    expect(reg.writes).toHaveLength(0)
    await make(reg).uninstall()
    expect(fs.readFileSync(path.join(dir, 'bin', 'tessel.cmd'), 'utf8')).toBe('@echo mine')
  })

  it('an access-denied PATH names the folder to add by hand', async () => {
    const reg = fakeRegistry()
    reg.write = vi.fn(async () => {
      throw Object.assign(new Error('x'), { code: 'EDENIED' })
    })
    await expect(make(reg).install()).rejects.toThrow(path.join(dir, 'bin'))
  })

  it('refresh points a registered command at this Tessel, and nothing else', async () => {
    const reg = fakeRegistry()
    let exe = 'C:\\Old\\Tessel.exe'
    const inst = make(reg, { shim: () => shimText({ execPath: exe, scriptPath: 'c', userData: 'u' }) })
    expect(inst.refresh()).toBe(false) // not registered: not written
    expect(fs.existsSync(path.join(dir, 'bin', 'tessel.cmd'))).toBe(false)
    await inst.install()
    expect(inst.refresh()).toBe(false)
    exe = 'C:\\New\\Tessel.exe'
    expect((await inst.status()).current).toBe(false)
    expect(inst.refresh()).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'bin', 'tessel.cmd'), 'utf8')).toContain('C:\\New\\Tessel.exe')
    expect(reg.writes).toHaveLength(1)
  })

  it('other systems: unsupported, nothing written', async () => {
    const reg = fakeRegistry()
    const inst = make(reg, { platform: 'linux' })
    expect((await inst.status()).state).toBe('unsupported')
    await expect(inst.install()).rejects.toThrow(/Windows only/)
    expect(reg.read).not.toHaveBeenCalled()
  })
})

describe('createUserPathRegistry (PowerShell, faked)', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')

  it('reads the raw value and its kind', async () => {
    const execFileImpl = vi.fn((file, args, opts, cb) => cb(null, b64({ exists: true, value: '%USERPROFILE%\\x;C:\\é', kind: 'ExpandString' })))
    const reg = createUserPathRegistry({ execFileImpl, env: { SystemRoot: 'C:\\Windows' } })
    expect(await reg.read()).toEqual({ exists: true, value: '%USERPROFILE%\\x;C:\\é', kind: 'ExpandString' })
    const [file, args] = execFileImpl.mock.calls[0]
    expect(file).toBe(path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    expect(args).toContain('-EncodedCommand')
    const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le')
    expect(script).toContain("OpenSubKey('Environment')")
    expect(script).toContain('DoNotExpandEnvironmentNames')
    expect(script).not.toMatch(/HKLM|LocalMachine/)
  })

  it('writes through variables (compare-and-swap), never in the script text', async () => {
    const execFileImpl = vi.fn((file, args, opts, cb) => cb(null, 'OK'))
    const reg = createUserPathRegistry({ execFileImpl, env: {} })
    await reg.write({ expected: { exists: true, value: 'C:\\a' }, value: 'C:\\a;C:\\b & x', kind: 'ExpandString' })
    const [, args, opts] = execFileImpl.mock.calls[0]
    const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le')
    expect(script).not.toContain('C:\\a;C:\\b')
    expect(script).toContain("CreateSubKey('Environment')")
    expect(script).not.toMatch(/HKLM|LocalMachine|'Machine'/)
    expect(Buffer.from(opts.env.TESSEL_PATH_NEW, 'base64').toString('utf8')).toBe('C:\\a;C:\\b & x')
    expect(Buffer.from(opts.env.TESSEL_PATH_OLD, 'base64').toString('utf8')).toBe('C:\\a')
    expect(opts.env.TESSEL_PATH_OLD_EXISTS).toBe('1')
    expect(opts.env.TESSEL_PATH_KIND).toBe('ExpandString')
  })

  it('reports a PATH changed meanwhile, an access denied, and a failed read', async () => {
    const changed = createUserPathRegistry({ execFileImpl: (f, a, o, cb) => cb(null, 'CHANGED'), env: {} })
    await expect(changed.write({ expected: { exists: true, value: '' }, value: 'x' })).rejects.toThrow(/changed meanwhile/)
    const denied = createUserPathRegistry({ execFileImpl: (f, a, o, cb) => cb(new Error('Access is denied')), env: {} })
    await expect(denied.write({ expected: { exists: true, value: '' }, value: 'x' })).rejects.toMatchObject({ code: 'EDENIED' })
    const broken = createUserPathRegistry({ execFileImpl: (f, a, o, cb) => cb(null, 'garbage'), env: {} })
    await expect(broken.read()).rejects.toThrow(/could not read/)
  })
})
