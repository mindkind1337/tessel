// Test helpers for the fake ssh.exe (fake-ssh.cjs): Git for Windows' sh plays
// the remote host's /bin/sh on a local temporary folder. Nothing connects to
// any host and nothing reads ~/.ssh.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { spawn } from 'child_process'

const SCRIPT = join(__dirname, 'fake-ssh.cjs')

export function gitSh() {
  if (process.platform !== 'win32') return fs.existsSync('/bin/sh') ? '/bin/sh' : null
  for (const p of ['C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\sh.exe']) if (fs.existsSync(p)) return p
  return null
}

// A local path as the fake host's sh sees it (C:\x -> /c/x). Git for
// Windows mounts the Temp folder as /tmp and names it so once resolved
// (git's own paths come back that way): that name is used for it.
export function posixPath(p) {
  if (process.platform !== 'win32') return p
  const tmp = os.tmpdir().replace(/[\\/]+$/, '')
  if (p.toLowerCase() === tmp.toLowerCase() || p.toLowerCase().startsWith(tmp.toLowerCase() + '\\'))
    return '/tmp' + p.slice(tmp.length).replace(/\\/g, '/')
  return p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/')
}

// spawnImpl for a session: ssh.exe replaced by node + fake-ssh.cjs.
export function fakeSpawn({ home, argvFile, exit = false } = {}) {
  return (_file, args, opts = {}) =>
    spawn(process.execPath, [SCRIPT, ...args], {
      ...opts,
      env: {
        ...(opts.env || process.env),
        FAKE_SSH_SH: gitSh(),
        ...(home ? { FAKE_SSH_HOME: posixPath(home) } : {}),
        ...(argvFile ? { FAKE_SSH_ARGV: argvFile } : {}),
        ...(exit ? { FAKE_SSH_EXIT: '1' } : {})
      }
    })
}

export function fakeSshLaunch({ home } = {}) {
  return { file: 'ssh.exe', args: ['box'], spawnImpl: fakeSpawn({ home }) }
}
