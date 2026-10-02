
import fs from 'fs'
import path from 'path'
import { writeCurrentTeams } from './notices.mjs'
const dir = "C:\\Tessel\\design\\takeover-race-G1QPB0"
const owner = process.argv[2]
const lock = path.join(dir, '.tessel/team-channel/current.lock')
const current = path.join(dir, '.tessel/team-channel/current.json')
const signal = name => fs.writeFileSync(path.join(dir, name), '')
function wait(name) {
  const deadline = Date.now() + 15000
  while (!fs.existsSync(path.join(dir, name))) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + name)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}
if (owner === 'a') {
  const rename = fs.renameSync
  let once = false
  fs.renameSync = function(from, to, ...args) {
    if (!once && path.resolve(from) === lock) {
      once = true
      signal('a-saw-dead-lock')
      wait('allow-a-rename')
      const result = rename.call(this, from, to, ...args)
      signal('a-moved-b-lock')
      wait('allow-a-return')
      return result
    }
    return rename.call(this, from, to, ...args)
  }
}
if (owner === 'b') {
  const read = fs.readFileSync
  let once = false
  fs.readFileSync = function(file, ...args) {
    const data = read.call(this, file, ...args)
    if (!once && path.resolve(file) === current) {
      once = true
      signal('b-in-critical-section')
      wait('allow-b-write')
    }
    return data
  }
}
try {
  console.log(JSON.stringify(writeCurrentTeams({ dir, owner, panes: { ['pane-' + owner]: { team: 'team-' + owner, num: 1 } } })))
} catch (e) { console.log(JSON.stringify({ error: e.message })); process.exitCode = 2 }
