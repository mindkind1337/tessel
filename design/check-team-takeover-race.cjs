// Deterministic scheduling of three real processes during stale-lock recovery.
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const pause = ms => new Promise(r => setTimeout(r, ms))
async function main() {
  const root = process.argv[2] || path.join(__dirname, 'review-674520b')
  const dir = fs.mkdtempSync(path.join(__dirname, 'takeover-race-'))
  const base = path.join(dir, '.tessel/team-channel')
  fs.mkdirSync(base, { recursive: true })
  const current = path.join(base, 'current.json')
  fs.writeFileSync(current, JSON.stringify({ version: 1, panes: {}, owners: {}, teams: {} }))
  fs.writeFileSync(path.join(dir, 'channel.mjs'), fs.readFileSync(path.join(root, 'src/main/teamChannel.js')))
  fs.writeFileSync(path.join(dir, 'notices.mjs'), fs.readFileSync(path.join(root, 'src/main/teamNotices.js'), 'utf8').replace("'./teamChannel'", "'./channel.mjs'"))
  const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true })
  await new Promise((resolve, reject) => { gone.on('exit', resolve); gone.on('error', reject) })
  fs.writeFileSync(path.join(base, 'current.lock'), `${gone.pid}:dead-holder`)
  fs.writeFileSync(path.join(dir, 'writer.mjs'), `
import fs from 'fs'
import path from 'path'
import { writeCurrentTeams } from './notices.mjs'
const dir = ${JSON.stringify(dir)}
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
`)
  const children = []
  function child(owner) {
    const p = spawn(process.execPath, [path.join(dir, 'writer.mjs'), owner], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const done = new Promise((resolve, reject) => {
      let output = ''
      p.stdout.on('data', d => { output += d })
      p.stderr.on('data', d => { output += d })
      p.on('error', reject)
      p.on('close', code => resolve({ owner, code, output }))
    })
    const entry = { p, done }; children.push(entry); return entry
  }
  async function wait(name) {
    for (let i = 0; !fs.existsSync(path.join(dir, name)); i++) {
      if (i > 120) throw new Error('Missing marker: ' + name)
      await pause(30)
    }
  }
  const allow = name => fs.writeFileSync(path.join(dir, name), '')
  try {
    const a = child('a')
    await wait('a-saw-dead-lock')
    const b = child('b')
    await wait('b-in-critical-section')
    allow('allow-a-rename')
    await wait('a-moved-b-lock')
    const c = await child('c').done
    const duringB = JSON.parse(fs.readFileSync(current, 'utf8'))
    allow('allow-a-return')
    allow('allow-b-write')
    const writers = await Promise.all([a.done, b.done])
    const final = JSON.parse(fs.readFileSync(current, 'utf8'))
    const result = { dir, c, duringB, writers, final }
    fs.writeFileSync(path.join(__dirname, 'team-takeover-race-results.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
  } finally {
    for (const name of ['allow-a-rename', 'allow-a-return', 'allow-b-write']) allow(name)
    await Promise.allSettled(children.map(c => c.done))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
