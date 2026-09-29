// A stand-in for ssh.exe in tests: it never connects anywhere. It takes
// ssh's argv, keeps only the remote command (the last argument), and runs it
// with Git for Windows' POSIX sh on this machine, stdin / stdout / stderr
// passed through, so the session's protocol runs against a local temporary
// folder. FAKE_SSH_HOME becomes $HOME there; FAKE_SSH_ARGV (a file) records
// the argv; FAKE_SSH_EXIT makes it fail like ssh does (exit 255, a message).
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
if (process.env.FAKE_SSH_ARGV) fs.writeFileSync(process.env.FAKE_SSH_ARGV, JSON.stringify({ argv, askpass: !!process.env.SSH_ASKPASS }))
if (process.env.FAKE_SSH_EXIT) {
  process.stderr.write('user@example: Permission denied (publickey,password).\n')
  process.exit(255)
}
const command = argv[argv.length - 1]
const env = { ...process.env }
if (process.env.FAKE_SSH_HOME) env.HOME = process.env.FAKE_SSH_HOME
// The host's tools (a real host has coreutils and git on its PATH).
if (process.platform === 'win32') {
  const root = path.resolve(path.dirname(process.env.FAKE_SSH_SH), '..', '..')
  const tools = [path.join(root, 'usr', 'bin'), path.join(root, 'mingw64', 'bin')]
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'
  env[key] = [...tools, env[key] || ''].join(';')
}
delete env.TMPDIR
const child = spawn(process.env.FAKE_SSH_SH, ['-c', command], { stdio: 'inherit', env, windowsHide: true })
child.on('exit', (code) => process.exit(code === null ? 255 : code))
