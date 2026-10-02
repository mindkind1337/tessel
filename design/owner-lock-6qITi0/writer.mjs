
import fs from 'fs'
import path from 'path'
import { writeCurrentTeams } from './notices.mjs'
const dir = "C:\\Tessel\\design\\owner-lock-6qITi0"
const owner = process.argv[2]
const current = path.join(dir, '.tessel/team-channel/current.json')
if (owner === 'a') {
  const read = fs.readFileSync
  let entered = false
  fs.readFileSync = function(file, ...args) {
    const data = read.call(this, file, ...args)
    if (!entered && path.resolve(file) === current) {
      entered = true
      fs.writeFileSync(path.join(dir, 'a-holds-lock'), '')
      const deadline = Date.now() + 15000
      while (!fs.existsSync(path.join(dir, 'release-a'))) {
        if (Date.now() > deadline) throw new Error('Parent did not release A')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    return data
  }
}
try {
  console.log(JSON.stringify(writeCurrentTeams({ dir, owner, panes: { ['pane-' + owner]: { team: 'team-' + owner, num: owner === 'a' ? 1 : 2 } } })))
} catch (e) { console.log(JSON.stringify({ error: e.message })); process.exitCode = 2 }
