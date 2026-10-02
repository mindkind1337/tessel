// Actual two Node processes using the reviewed modules, only disposable files.
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const pause = ms => new Promise(r => setTimeout(r, ms))
async function main() {
  const root = process.argv[2] || 'C:/Tessel-claude'
  const dir = fs.mkdtempSync(path.join(__dirname, 'owner-lock-'))
  const b = path.join(dir, '.tessel/team-channel')
  fs.mkdirSync(b, { recursive: true })
  const current = path.join(b, 'current.json')
  fs.writeFileSync(current, JSON.stringify({ version: 1, panes: {}, owners: {}, teams: {} }))
  fs.writeFileSync(path.join(dir, 'channel.mjs'), fs.readFileSync(path.join(root, 'src/main/teamChannel.js')))
  fs.writeFileSync(path.join(dir, 'notices.mjs'), fs.readFileSync(path.join(root, 'src/main/teamNotices.js'), 'utf8').replace("'./teamChannel'", "'./channel.mjs'"))
  fs.writeFileSync(path.join(dir, 'writer.mjs'), `
import fs from 'fs'
import path from 'path'
import { writeCurrentTeams } from './notices.mjs'
const dir = ${JSON.stringify(dir)}
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
`)
  function child(owner) {
    const p = spawn(process.execPath, [path.join(dir, 'writer.mjs'), owner], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const done = new Promise((resolve, reject) => {
      let output = ''
      p.stdout.on('data', d => { output += d })
      p.stderr.on('data', d => { output += d })
      p.on('error', reject)
      p.on('close', code => resolve({ code, output }))
    })
    return { p, done }
  }
  const a = child('a')
  try {
    for (let n = 0; !fs.existsSync(path.join(dir, 'a-holds-lock')); n++) {
      if (n > 100) throw new Error('A never acquired lock')
      await Promise.race([pause(50), a.done.then(() => { throw new Error('A exited before the test') })])
    }
    // Simulate a live holder paused across a sleep/debugger/slow disk >10 s.
    const old = new Date(Date.now() - 60000)
    fs.utimesSync(path.join(b, 'current.lock'), old, old)
    const bResult = await child('b').done
    const whileAHolds = JSON.parse(fs.readFileSync(current, 'utf8'))
    fs.writeFileSync(path.join(dir, 'release-a'), '')
    const aResult = await a.done
    const final = JSON.parse(fs.readFileSync(current, 'utf8'))
    const result = { dir, aPid: a.p.pid, bResult, whileAHolds, aResult, final }
    fs.writeFileSync(path.join(__dirname, 'team-owner-lock-results.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
  } finally {
    fs.writeFileSync(path.join(dir, 'release-a'), '')
    await a.done.catch(() => {})
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
