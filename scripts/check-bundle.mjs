// Build guard: fail if the main-process bundle contains things that must stay
// external. A bundled copy of the `electron` npm package relaunches the app
// forever trying to "install" Electron (it crashed the machine once).
import fs from 'fs'
import path from 'path'

const dir = path.join('out', 'main')
const files = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (p.endsWith('.js')) files.push(p)
  }
}
walk(dir)

const forbidden = [
  ['install-electron', 'the electron npm package (its installer) was bundled'],
  ['Electron failed to install correctly', 'the electron npm package was bundled'],
  ['node-pty.node', 'node-pty (a native module) was bundled'],
  ['sshcrypto.node', 'ssh2 was bundled (it must stay external, loaded from node_modules)']
]
let failed = false
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  for (const [needle, why] of forbidden) {
    if (text.includes(needle)) {
      console.error(`check-bundle: ${f}: ${why}`)
      failed = true
    }
  }
}
if (!files.some((f) => f.endsWith('ptyHost.js'))) {
  console.error('check-bundle: out/main/ptyHost.js is missing')
  failed = true
} else {
  // The SSH client of the terminal host: required at runtime (not bundled),
  // and present in node_modules (electron-builder packages dependencies).
  const hostText = [path.join(dir, 'ptyHost.js'), ...files.filter((f) => f.includes(path.join('main', 'chunks')))]
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')
  if (!/require\(["']ssh2["']\)/.test(hostText)) {
    console.error('check-bundle: the terminal host does not require ssh2 at runtime')
    failed = true
  }
  if (!fs.existsSync(path.join('node_modules', 'ssh2', 'package.json'))) {
    console.error('check-bundle: node_modules/ssh2 is missing (npm install)')
    failed = true
  }
}
// The tessel command (src/cli): one file, unpacked from the archive, so it
// must not load a shared chunk (which stays inside app.asar).
const cliFile = path.join(dir, 'cli.js')
if (!fs.existsSync(cliFile)) {
  console.error('check-bundle: out/main/cli.js is missing (the tessel command)')
  failed = true
} else {
  const cli = fs.readFileSync(cliFile, 'utf8')
  if (/require\(["']\.\.?\//.test(cli)) {
    console.error('check-bundle: out/main/cli.js loads another bundle file; it must be self-contained')
    failed = true
  }
  if (/require\(["']electron["']\)/.test(cli)) {
    console.error('check-bundle: out/main/cli.js loads electron; it runs as plain Node')
    failed = true
  }
}
// The SSH askpass helper (scripts/build-askpass.mjs): without it, SSH
// passwords fall back to the terminal; a release must carry it.
if (process.platform === 'win32' && !fs.existsSync(path.join(dir, 'tessel-askpass.exe'))) {
  console.error('check-bundle: out/main/tessel-askpass.exe is missing (SSH askpass helper)')
  failed = true
}
// The tessel command's launcher (copied to the user's bin folder by Register).
if (process.platform === 'win32' && !fs.existsSync(path.join(dir, 'tessel-cli.exe'))) {
  console.error('check-bundle: out/main/tessel-cli.exe is missing (the tessel command launcher)')
  failed = true
}
if (failed) process.exit(1)
console.log(`check-bundle: ok (${files.length} files)`)
