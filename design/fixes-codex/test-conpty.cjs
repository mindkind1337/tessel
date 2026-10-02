const pty = require('node-pty')
const fs = require('fs')
const path = require('path')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

;(async () => {
  let output = ''
  let result
  let child

  try {
    child = pty.spawn('powershell.exe', ['-NoLogo'], {
      cols: 80,
      rows: 24,
      useConpty: true,
      useConptyDll: process.env.CONPTY_DLL === '1',
      env: process.env
    })
    child.onData((data) => {
      output += data
      output = output.slice(-4000)
    })

    await wait(1200)
    child.write('[Console]::WindowWidth\r')
    await wait(800)
    const before = (output.match(/\b(\d{2,3})\b/g) || []).map(Number)

    child.resize(50, 20)
    await wait(500)
    output = ''
    child.write('[Console]::WindowWidth\r')
    await wait(800)
    const after = (output.match(/\b(\d{2,3})\b/g) || []).map(Number)

    child.kill()
    await wait(500)
    result = [
      `conpty_spawned=true`,
      `useConptyDll=${process.env.CONPTY_DLL === '1'}`,
      `width_at_80=${JSON.stringify(before)}`,
      `width_after_resize_to_50=${JSON.stringify(after)}`,
      `child_saw_resize=${after.includes(50)}`
    ].join('\n')
  } catch (error) {
    result = `conpty_spawned=false\nerror=${error.message}`
    if (child) {
      try {
        child.kill()
      } catch {}
    }
  }

  fs.writeFileSync(path.join(__dirname, 'test-result.txt'), result)
})()
