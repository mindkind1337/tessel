// A project on a remote host: its terminals run ssh with "-t" and one remote
// command that opens a login shell in the project's folder. The path must
// never be run: it is single-quoted for the remote POSIX shell.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { validateRemotePath, shellQuote, remoteCdCommand, remoteProjectLaunch } from '../remoteProject'
import { sshArgsFor } from '../remoteHosts'

const configHost = { id: 'ssh-a', label: 'box', configHost: 'box', host: 'box.example', port: 22, username: '', source: 'ssh-config' }
const manualHost = { id: 'ssh-b', label: 'dev', configHost: '10.0.0.5', host: '10.0.0.5', port: 2222, username: 'deploy', source: 'manual' }
const launchOf = (target) => ({ ok: true, file: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', args: sshArgsFor(target), name: target.label, target })

// Git for Windows' bash, when there (never WSL's bash.exe): what a POSIX
// shell really reads.
const GIT_BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((p) => existsSync(p))
function bashPrintf(quoted) {
  if (!GIT_BASH) return null
  try {
    return execFileSync(GIT_BASH, ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  } catch {
    return null
  }
}

describe('remote folder path', () => {
  it('takes absolute POSIX paths, ~ and ~/...', () => {
    expect(validateRemotePath('/home/admin/app')).toEqual({ path: '/home/admin/app' })
    expect(validateRemotePath('  ~/src/app  ')).toEqual({ path: '~/src/app' })
    expect(validateRemotePath('~')).toEqual({ path: '~' })
  })
  it('refuses empty, relative, Windows and control-character paths', () => {
    expect(validateRemotePath('').error).toBe('path-required')
    expect(validateRemotePath('app').error).toBe('path-not-absolute')
    expect(validateRemotePath('C:\\work').error).toBe('path-not-absolute')
    expect(validateRemotePath('-oProxyCommand=calc').error).toBe('path-not-absolute')
    expect(validateRemotePath('~user/x').error).toBe('path-not-absolute')
    expect(validateRemotePath('/tmp/a\nrm -rf ~').error).toBe('path-invalid')
    expect(validateRemotePath('/tmp/\u0000x').error).toBe('path-invalid')
    expect(validateRemotePath('/' + 'a'.repeat(1100)).error).toBe('path-invalid')
    expect(validateRemotePath(42).error).toBe('path-required')
  })
})

describe('the remote command', () => {
  it('cd into the quoted folder, then a login shell', () => {
    expect(remoteCdCommand('/home/admin/my app')).toBe(`cd -- '/home/admin/my app' && exec "$SHELL" -l`)
    expect(remoteCdCommand('~')).toBe(`cd -- ~ && exec "$SHELL" -l`)
    expect(remoteCdCommand('~/work/app')).toBe(`cd -- ~/'work/app' && exec "$SHELL" -l`)
  })

  it('a quote in the path is escaped, never closes the quoting', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(remoteCdCommand("/tmp/x'; rm -rf ~; echo '")).toBe(`cd -- '/tmp/x'\\''; rm -rf ~; echo '\\''' && exec "$SHELL" -l`)
  })

  it('injection attempts stay literal text for a POSIX shell', () => {
    const tricky = [
      "/tmp/x'; touch /tmp/pwned; '",
      '/tmp/$(touch /tmp/pwned)',
      '/tmp/`touch /tmp/pwned`',
      '/tmp/a && touch /tmp/pwned',
      '/tmp/a | tee /tmp/pwned',
      '/tmp/$HOME/${PATH}',
      '/tmp/"double" \\back',
      '/tmp/*?[a]',
      "/tmp/''''"
    ]
    const bash = bashPrintf("'probe'") === 'probe'
    for (const p of tricky) {
      const q = shellQuote(p)
      expect(q.startsWith("'") && q.endsWith("'")).toBe(true)
      if (bash) expect(bashPrintf(q)).toBe(p)
    }
    // The ~ form: the rest is quoted too.
    const home = "~/it's $(x)"
    expect(remoteCdCommand(home)).toBe(`cd -- ~/'it'\\''s $(x)' && exec "$SHELL" -l`)
  })

  it('throws on a path it would not take', () => {
    expect(() => remoteCdCommand('relative')).toThrow()
    expect(() => remoteCdCommand('/a\rb')).toThrow()
  })
})

describe('the ssh argv of a remote project terminal', () => {
  it('an ssh config host: -t, its alias, then the one remote command', () => {
    const res = remoteProjectLaunch(launchOf(configHost), '/srv/app')
    expect(res.ok).toBe(true)
    expect(res.args).toEqual(['-t', 'box', `cd -- '/srv/app' && exec "$SHELL" -l`])
    expect(res.remotePath).toBe('/srv/app')
  })

  it('a host added by hand keeps its options before the destination', () => {
    const res = remoteProjectLaunch(launchOf(manualHost), '~/code')
    expect(res.args).toEqual(['-t', '-p', '2222', '-l', 'deploy', '10.0.0.5', `cd -- ~/'code' && exec "$SHELL" -l`])
    // The path is one argument after the destination: never an ssh option.
    expect(res.args.indexOf('10.0.0.5')).toBe(res.args.length - 2)
  })

  it('an invalid path or launch is refused, nothing is run', () => {
    expect(remoteProjectLaunch(launchOf(configHost), 'relative/path')).toEqual({ ok: false, error: 'path-not-absolute' })
    expect(remoteProjectLaunch(launchOf(configHost), '/x\n; reboot')).toEqual({ ok: false, error: 'path-invalid' })
    expect(remoteProjectLaunch({ ok: false, error: 'gone' }, '/srv').ok).toBe(false)
    expect(remoteProjectLaunch(null, '/srv').ok).toBe(false)
  })
})
