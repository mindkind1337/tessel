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
  ['node-pty.node', 'node-pty (a native module) was bundled']
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
}
if (failed) process.exit(1)
console.log(`check-bundle: ok (${files.length} files)`)
