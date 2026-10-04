// @vitest-environment node
// The node Tessel's hooks run: an absolute path found on PATH at install time,
// never one planted in the project folder (the hooks' working directory).
// Everything happens in temporary folders; no real agent settings are read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import { spawnSync } from 'child_process'
import { findNode, commandWord, hookCommand, hookNode, unsafePath, cmdCommandWord, goCmdHookCommand } from '../nodePath'
import { installClaudeHooks, installCopilotHooks } from '../teamInstall'
import { installStatusHooks, STATUS_HOOKS } from '../agentStatusHooks'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-node-path-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  const target = resolve(dir)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-node-path-')) throw new Error('Unsafe fixture path')
  fs.rmSync(target, { recursive: true, force: true })
})
const plant = (folder, name = 'node.exe') => {
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(join(folder, name), 'planted')
  return join(folder, name)
}

describe('findNode', () => {
  it('never takes a node.exe in the current directory, whatever PATH says', () => {
    const project = join(dir, 'project')
    plant(project)
    plant(project, 'node.cmd')
    plant(project, 'node.bat')
    const real = plant(join(dir, 'nodejs'))
    // ".", a relative entry, and the project folder itself: all skipped.
    const env = { Path: `.;bin;${project};${project}\\;"${join(dir, 'nodejs')}"` }
    expect(findNode({ env, platform: 'win32', cwd: project })).toBe(real)
    expect(findNode({ env: { PATH: `.;bin;${project}` }, platform: 'win32', cwd: project })).toBe(null)
    // Its folder in another case (Windows paths are case-insensitive).
    expect(findNode({ env: { PATH: project.toUpperCase() }, platform: 'win32', cwd: project })).toBe(null)
  })

  it('takes only a real node.exe on Windows, never a .cmd or .bat', () => {
    const shims = join(dir, 'shims')
    plant(shims, 'node.cmd')
    plant(shims, 'node.bat')
    expect(findNode({ env: { PATH: shims }, platform: 'win32', cwd: dir })).toBe(null)
    const real = plant(join(dir, 'real'))
    expect(findNode({ env: { PATH: `${shims};${join(dir, 'real')}` }, platform: 'win32', cwd: dir })).toBe(real)
  })

  it('skips UNC folders, drive-relative ones and paths no shell quotes safely', () => {
    const isFile = vi.fn(() => true)
    expect(findNode({ env: { PATH: '\\\\server\\share;\\nodejs;C:nodejs;C:\\100%\\bin;C:\\ok' }, platform: 'win32', cwd: 'D:\\p', isFile })).toBe('C:\\ok\\node.exe')
    expect(isFile).toHaveBeenCalledTimes(1)
  })

  it('on POSIX: absolute PATH entries only', () => {
    const isFile = (f) => f === '/usr/local/bin/node' || f === '/home/me/project/node'
    expect(findNode({ env: { PATH: '.:bin:/home/me/project:/usr/local/bin' }, platform: 'linux', cwd: '/home/me/project', isFile })).toBe('/usr/local/bin/node')
  })

  it('no PATH at all: none', () => {
    expect(findNode({ env: {}, platform: 'win32', cwd: dir })).toBe(null)
  })
})

describe('hook commands', () => {
  it('put the absolute node first, in a form cmd.exe, PowerShell and bash all run', () => {
    expect(commandWord('C:\\Program Files\\nodejs\\node.exe')).toBe('C:/"Program Files/nodejs/node.exe"')
    expect(commandWord('/usr/local/bin/node')).toBe('"/usr/local/bin/node"')
    expect(hookCommand('C:\\n\\node.exe', 'C:\\s\\x.cjs', '--hook')).toBe('C:/"n/node.exe" "C:\\s\\x.cjs" --hook')
  })

  it('for an agent that runs hooks as Go\'s exec.Command("cmd", "/c", command) (Antigravity): no quote that cmd.exe would get as \\"', () => {
    expect(cmdCommandWord('C:\\Program Files\\nodejs\\node.exe')).toBe('C:\\"Program Files\\nodejs"\\node.exe')
    expect(cmdCommandWord('C:/n/node.exe')).toBe('C:\\n\\node.exe')
    expect(cmdCommandWord('C:\\my node.exe')).toBe(null)
    expect(cmdCommandWord('C:\\n\\my node.exe')).toBe(null)
    expect(goCmdHookCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\s\\x.cjs', '--hook')).toBe('C:\\"Program Files\\nodejs"\\node.exe C:\\s\\x.cjs --hook')
    // A script path with a space cannot go through that quoting.
    expect(goCmdHookCommand('C:\\n\\node.exe', 'C:\\Tessel data\\x.cjs', '--hook')).toBe(null)
  })

  it('refuse unsafe or relative node paths, and a missing node', () => {
    expect(hookNode('C:\\s\\x.cjs', 'node').error).toBeTruthy()
    expect(hookNode('C:\\s\\x.cjs', 'C:\\a%b\\node.exe').error).toBeTruthy()
    expect(hookNode('C:\\s\\x".cjs', 'C:\\n\\node.exe').error).toBeTruthy()
    expect(hookNode('C:\\s\\x.cjs', undefined, { PATH: '.' }).error).toMatch(/Node\.js/)
    expect(hookNode('C:\\s\\x.cjs', 'C:\\n\\node.exe')).toEqual({ node: 'C:\\n\\node.exe' })
    for (const c of ['"', '`', '$', '%', '!', '\r', '\n']) expect(unsafePath(`C:\\a${c}b`)).toBe(true)
  })

  it('installers find node on PATH, never the one planted in the current directory', () => {
    const project = join(dir, 'project')
    plant(project)
    const real = plant(join(dir, 'nodejs'))
    vi.spyOn(process, 'cwd').mockReturnValue(project)
    vi.stubEnv('PATH', `.;${project};${join(dir, 'nodejs')}`)
    const home = join(dir, 'home')
    const script = 'C:\\Tessel data\\tessel-team-mcp.cjs'
    expect(installClaudeHooks(script, home)).toEqual({ changed: true })
    const claude = fs.readFileSync(join(home, '.claude', 'settings.json'), 'utf8')
    expect(claude).toContain(JSON.stringify(commandWord(real)).slice(1, -1))
    expect(claude).not.toContain(JSON.stringify(commandWord(join(project, 'node.exe'))).slice(1, -1))
    expect(claude).not.toMatch(/"node /)
    expect(installCopilotHooks(script, home)).toEqual({ changed: true })
    expect(fs.readFileSync(join(home, '.copilot', 'hooks', 'tessel-team.json'), 'utf8')).not.toMatch(/"node /)
    const env = { PATH: `.;${project};${join(dir, 'nodejs')}` }
    expect(installStatusHooks('droid', script, { home, env })).toEqual({ changed: true })
    expect(fs.readFileSync(STATUS_HOOKS.droid.file(home, env), 'utf8')).toContain(JSON.stringify(commandWord(real)).slice(1, -1))
    // Only the planted one on PATH: nothing is installed.
    expect(installStatusHooks('openclaude', script, { home, env: { PATH: `.;${project}` } }).error).toMatch(/Node\.js/)
    expect(fs.existsSync(STATUS_HOOKS.openclaude.file(home, {}))).toBe(false)
  })
})

// On Windows: the command as the agents' shells run it, from a project folder
// holding a planted node.bat / node.cmd. The bare "node" runs the planted one
// (what this fixes); Tessel's command runs the real node.
describe.runIf(process.platform === 'win32')('run from a folder with a planted node', () => {
  it('cmd.exe and PowerShell run the absolute node, never the planted one', () => {
    const project = join(dir, 'project')
    fs.mkdirSync(project)
    const marker = join(dir, 'planted-ran.txt')
    for (const name of ['node.bat', 'node.cmd']) fs.writeFileSync(join(project, name), `@echo planted> "${marker}"\r\n`)
    const script = join(dir, 'hook.cjs')
    fs.writeFileSync(script, "process.stdout.write('real:' + process.argv.slice(2).join(','))")
    const command = hookCommand(process.execPath, script, '--hook --agent=droid')
    // Without the opt-out some shells set (it keeps cmd.exe out of the
    // current directory): agents do not all run with it.
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete env[key]
    const viaCmd = spawnSync(command, { cwd: project, env, shell: true, encoding: 'utf8', windowsHide: true })
    expect(viaCmd.stdout).toBe('real:--hook,--agent=droid')
    const viaPs = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: project, env, encoding: 'utf8', windowsHide: true })
    expect(viaPs.stdout).toBe('real:--hook,--agent=droid')
    expect(fs.existsSync(marker)).toBe(false)
    // The old bare command, for comparison: cmd.exe runs the planted file.
    spawnSync(`node "${script}"`, { cwd: project, env, shell: true, encoding: 'utf8', windowsHide: true })
    expect(fs.existsSync(marker)).toBe(true)
  }, 60000)
})

// Antigravity CLI (a Go program) runs a hook as exec.Command("cmd", "/c",
// command); node's spawn quotes that argument the same way (the C runtime's
// rules: every " reaches cmd.exe as \").
describe.runIf(process.platform === 'win32')('a hook run the way Antigravity CLI runs it', () => {
  it('the common form fails there; the cmd form runs the real node, Go-quoted, raw and in PowerShell', () => {
    const nodeDir = join(dir, 'Program Files', 'nodejs')
    fs.mkdirSync(nodeDir, { recursive: true })
    const node = join(nodeDir, 'node.exe')
    fs.copyFileSync(process.execPath, node)
    const script = join(dir, 'hook.cjs')
    fs.writeFileSync(script, "process.stdout.write('real:' + process.argv.slice(2).join(','))")
    const viaGo = (command) => spawnSync('cmd.exe', ['/c', command], { cwd: dir, encoding: 'utf8', windowsHide: true })
    expect(viaGo(hookCommand(node, script, '--hook --agent=antigravity')).stdout).not.toBe('real:--hook,--agent=antigravity')
    const command = goCmdHookCommand(node, script, '--hook --agent=antigravity')
    expect(command).not.toBe(null)
    expect(viaGo(command).stdout).toBe('real:--hook,--agent=antigravity')
    const raw = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd: dir, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true })
    expect(raw.stdout).toBe('real:--hook,--agent=antigravity')
    const viaPs = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: dir, encoding: 'utf8', windowsHide: true })
    expect(viaPs.stdout).toBe('real:--hook,--agent=antigravity')
  }, 60000)
})
