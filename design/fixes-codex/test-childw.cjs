// Does a winpty resize() actually propagate the new column count to the child
// process? (This is what a TUI like Claude Code reads to redraw.)
const pty = require('node-pty')
const fs = require('fs')
const path = require('path')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const p = pty.spawn('powershell.exe', ['-NoLogo'], { cols: 80, rows: 24, useConpty: false, env: process.env })
  let buf = ''
  p.onData((d) => (buf += d))
  await wait(1500)

  buf = ''
  p.write('[Console]::WindowWidth\r')
  await wait(1200)
  const w1 = (buf.match(/\b(\d{2,3})\b/g) || []).map(Number)

  p.resize(50, 24)
  await wait(600)
  buf = ''
  p.write('[Console]::WindowWidth\r')
  await wait(1200)
  const w2 = (buf.match(/\b(\d{2,3})\b/g) || []).map(Number)

  fs.writeFileSync(path.join(__dirname, 'test-result.txt'),
    `width_at_80=${JSON.stringify(w1)}\nwidth_after_resize_to_50=${JSON.stringify(w2)}\n` +
    `child_saw_resize=${w2.includes(50)}\n`)
  p.kill()
  await wait(300)
  process.exit(0)
})()
