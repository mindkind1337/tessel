import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { buildRequest, parseArgs, formatStatus, formatUsage, clean, launchEnv } from '../tessel'
import { buildAskpass, buildCliLauncher, findCsc } from '../../../scripts/build-askpass.mjs'
import { iniText } from '../../main/cliInstall'
import { sessionOptionLaunchText, validPaneSessionOptions, validSessionOptionSettings } from '../../shared/agentSessionOptions'

const cwd = 'C:\\work\\proj'
const all = () => true

describe('network paths (NTLM)', () => {
  it('need --allow-unc; a network folder you are in is left out', () => {
    expect(() => buildRequest(parseArgs(['open', '\\\\attacker\\share']), cwd, all)).toThrow(/--allow-unc/)
    expect(() => buildRequest(parseArgs(['open', '//attacker/share']), cwd, all)).toThrow(/--allow-unc/)
    expect(() => buildRequest(parseArgs(['.']), '\\\\srv\\share\\p', all)).toThrow(/--allow-unc/)
    expect(buildRequest(parseArgs(['open', '\\\\srv\\share\\p', '--allow-unc']), cwd, all).params).toEqual({ path: '\\\\srv\\share\\p', allowUnc: true })
    expect(buildRequest(parseArgs(['new']), '\\\\srv\\share\\p', all).params).toEqual({})
    expect(buildRequest(parseArgs(['task', 'add', 'x']), '\\\\srv\\share', all).params).toEqual({ title: 'x' })
  })
})

describe('terminal output', () => {
  it('carries no control characters from Tessel', () => {
    const text = formatStatus({
      projects: [{ name: 'p\u001b]0;pwn\u0007', path: 'C:\\x\u202e', panes: [{ num: 1, kind: 'agent', title: 'a\u001b[2Jb', state: 'working\r' }] }]
    })
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u202e]/)
    expect(text).toContain('p]0;pwn')
    expect(formatUsage({ agents: [{ id: 'x\u001b', windows: [], error: 'e\u0007' }] })).toBe('x: e')
    expect(clean('ok\u0000\u009b')).toBe('ok')
  })
})

describe('starting Tessel', () => {
  it('gives it no terminal variables', () => {
    expect(launchEnv({ PATH: 'p', NODE_OPTIONS: 'x', ELECTRON_RUN_AS_NODE: '1', APPDATA: 'a' })).toEqual({ APPDATA: 'a', TESSEL_STARTED_BY_CLI: '1' })
  })
})

describe('model and effort values are never flags', () => {
  it('pane choices and saved defaults refuse a leading dash', () => {
    for (const bad of ['--yolo', '-y', '--dangerously-skip-permissions']) {
      expect(validPaneSessionOptions({ model: bad })).toBeNull()
      expect(validPaneSessionOptions({ model: 'opus', effort: bad })).toEqual({ model: 'opus' })
      expect(sessionOptionLaunchText('gemini', { model: bad })).toBe('')
      expect(sessionOptionLaunchText('claude', { model: 'opus', effort: bad })).toBe('')
    }
    expect(validSessionOptionSettings({ gemini: { model: '--yolo', valuesByModel: {} } }).gemini?.model).toBeUndefined()
    expect(sessionOptionLaunchText('gemini', { model: 'gemini-2.5-pro' })).toBe('-m gemini-2.5-pro')
    expect(sessionOptionLaunchText('codex', { model: 'gpt-5.5', effort: 'high' })).toBe('-m gpt-5.5 -c model_reasoning_effort=high')
  })
})

// The native pieces, built as the app builds them.
describe.runIf(process.platform === 'win32' && !!findCsc())('native helpers', () => {
  let dir
  let launcher
  let helper
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-cli-native-'))
    const l = buildCliLauncher(path.join(dir, 'tessel-cli.exe'))
    const h = buildAskpass(path.join(dir, 'tessel-askpass.exe'))
    launcher = l.ok ? l.file : null
    helper = h.ok ? h.file : null
  }, 120_000)
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }))

  it('the launcher passes the command line through untouched (no cmd.exe parsing)', async () => {
    expect(launcher).toBeTruthy()
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.copyFileSync(launcher, path.join(bin, 'tessel.exe'))
    const script = path.join(dir, 'echo.js')
    fs.writeFileSync(script, 'console.log(JSON.stringify({ argv: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE, ud: process.env.TESSEL_CLI_USER_DATA, lang: process.env.TESSEL_CLI_LANG })); process.exitCode = 7\n')
    fs.writeFileSync(path.join(bin, 'tessel.ini'), iniText({ execPath: process.execPath, scriptPath: script, userData: 'C:\\Users\\é\\données', lang: 'fr' }))
    const res = await new Promise((resolve) => {
      // The exact command line a shell would build: nothing may run.
      const child = execFile(path.join(bin, 'tessel.exe'), ['task add "a|whoami" "b>pwned.txt" "x&calc" "%PATH%" "café ☕"'], { windowsVerbatimArguments: true, cwd: dir, encoding: 'utf8' }, (err, stdout) =>
        resolve({ code: err ? err.code : 0, stdout })
      )
      child.on('error', () => {})
    })
    expect(res.code).toBe(7)
    expect(JSON.parse(res.stdout)).toEqual({ argv: ['task', 'add', 'a|whoami', 'b>pwned.txt', 'x&calc', '%PATH%', 'café ☕'], node: '1', ud: 'C:\\Users\\é\\données', lang: 'fr' })
    expect(fs.existsSync(path.join(dir, 'pwned.txt'))).toBe(false)
  }, 60_000)

  it('the launcher refuses to run without its settings', () => {
    const lone = path.join(dir, 'lone')
    fs.mkdirSync(lone, { recursive: true })
    fs.copyFileSync(launcher, path.join(lone, 'tessel.exe'))
    let code = 0
    let err = ''
    try {
      execFileSync(path.join(lone, 'tessel.exe'), ['status'], { stdio: 'pipe' })
    } catch (e) {
      code = e.status
      err = String(e.stderr)
    }
    expect(code).toBe(1)
    expect(err).toMatch(/not set up/)
  })

  it('--protect: this user only, and a Medium label refusing low-integrity reads', () => {
    expect(helper).toBeTruthy()
    const file = path.join(dir, 'cli.token')
    fs.writeFileSync(file, 'a'.repeat(64))
    execFileSync(helper, ['--protect', file], { env: { SystemRoot: process.env.SystemRoot } })
    const acl = execFileSync(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'), [file], { encoding: 'latin1' })
    expect(acl).toMatch(/\(NW,NR,NX\)/)
    expect(acl).not.toMatch(/\(I\)/) // nothing inherited from the folder
    expect(fs.readFileSync(file, 'utf8')).toBe('a'.repeat(64)) // still readable by its owner
  })

  it('the pipe server refuses connections beyond its limit, and serves again afterwards', async () => {
    const name = `tessel-cli-${'ab'.repeat(16)}`
    const { spawn } = await import('node:child_process')
    const srv = spawn(helper, ['--serve', name], { stdio: ['pipe', 'pipe', 'ignore'], env: { SystemRoot: process.env.SystemRoot } })
    try {
      await new Promise((resolve) => srv.stdout.once('data', resolve)) // READY
      const pipe = `\\\\.\\pipe\\${name}`
      const socks = []
      let closedEarly = 0
      for (let i = 0; i < 80; i++) {
        const s = net.createConnection(pipe)
        s.on('error', () => {})
        s.on('close', () => closedEarly++)
        socks.push(s)
      }
      await new Promise((r) => setTimeout(r, 1500))
      // At most 64 are held; the rest were closed at once (before the 5 s first-line limit).
      expect(closedEarly).toBeGreaterThanOrEqual(80 - 64)
      for (const s of socks) s.destroy()
      await new Promise((r) => setTimeout(r, 500))
      // A normal question still reaches Tessel's side (the helper's stdout).
      const got = new Promise((resolve) => {
        srv.stdout.on('data', (d) => {
          if (/^Q \d+ hello/m.test(String(d))) resolve(true)
        })
      })
      const c = net.createConnection(pipe, () => c.write('hello\n'))
      c.on('error', () => {})
      expect(await Promise.race([got, new Promise((r) => setTimeout(() => r(false), 5000))])).toBe(true)
      c.destroy()
    } finally {
      srv.stdin.end()
      srv.kill()
    }
  }, 60_000)
})
