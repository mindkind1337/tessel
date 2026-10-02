const { app, BrowserWindow, ipcMain, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const pty = require('node-pty')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const ptys = new Map()
let win
const W = (t) => { try { fs.writeFileSync(path.join(__dirname, 'test-result.txt'), t) } catch {} }
process.on('uncaughtException', (e) => W('UNCAUGHT=' + e.message))
process.on('unhandledRejection', (e) => W('UNHANDLED=' + (e && e.message)))
const send = (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p) }

ipcMain.handle('shells:list', () => [{ id: 'powershell', name: 'Windows PowerShell' }])
ipcMain.handle('pty:create', (_e, { id, cols, rows }) => {
  try {
    const c = pty.spawn('powershell.exe', ['-NoLogo'], { cols: cols || 80, rows: rows || 24, useConpty: false, env: process.env })
    c.onData((d) => send('pty:data', { id, data: d }))
    c.onExit(({ exitCode }) => { ptys.delete(id); send('pty:exit', { id, exitCode }) })
    ptys.set(id, c)
    return { ok: true, shell: { id: 'powershell', name: 'Windows PowerShell' }, pid: c.pid }
  } catch (e) { return { ok: false, error: e.message } }
})
ipcMain.on('pty:write', (_e, { id, data }) => { const c = ptys.get(id); if (c) c.write(data) })
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => { const c = ptys.get(id); if (c) try { c.resize(cols, rows) } catch {} })
ipcMain.on('pty:kill', (_e, { id }) => { const c = ptys.get(id); if (c) { try { c.kill() } catch {} ptys.delete(id) } })
ipcMain.handle('clipboard:read', () => clipboard.readText())
ipcMain.on('clipboard:write', (_e, t) => { if (typeof t === 'string' && t.length) clipboard.writeText(t) })

// host = visible terminal area; screen = xterm's rendered grid width.
// overflow > 0 means xterm is wider than its pane → clipping.
const MEASURE = `JSON.stringify((()=>{const p=document.querySelectorAll('.pane')[0];const host=p.querySelector('.term-host');const scr=p.querySelector('.xterm-screen');const hw=Math.round(host.getBoundingClientRect().width);const sw=scr?Math.round(scr.getBoundingClientRect().width):-1;return {host:hw,screen:sw,overflow:sw-hw}})())`

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, width: 1600, height: 900, webPreferences: { preload: path.join(__dirname, 'out/preload/index.js'), contextIsolation: true, sandbox: false } })
  const errs = []
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) errs.push('con:' + msg) })
  await win.loadFile(path.join(__dirname, 'out/renderer/index.html'))
  const ev = (js) => win.webContents.executeJavaScript(js).catch((e) => { errs.push('ev:' + e.message); return null })
  try {
    await wait(4500)
    const initial = JSON.parse(await ev(MEASURE))

    // Shrink pane 0 by dragging the first vertical divider 200px LEFT.
    await ev(`(()=>{const d=document.querySelector('.divider.row');const r=d.getBoundingClientRect();const cx=r.x+r.width/2,cy=r.y+r.height/2;window.__cx=cx;window.__cy=cy;d.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:cx,clientY:cy}));})()`)
    for (let i = 1; i <= 30; i++) { await ev(`window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:window.__cx-${i * 6},clientY:window.__cy}))`); await wait(16) }
    await ev(`window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))`)
    await wait(500)
    const shrunk = JSON.parse(await ev(MEASURE))

    W(`initial: ${JSON.stringify(initial)}\nshrunk:  ${JSON.stringify(shrunk)}\n` +
      `clips_when_shrunk=${shrunk.overflow > 2}\nerrs=${errs.join('|')}\n`)
  } catch (e) {
    W('THREW=' + e.message + '\nerrs=' + errs.join('|'))
  }
  for (const c of ptys.values()) { try { c.kill() } catch {} }
  await wait(700)
  app.quit()
})
setTimeout(() => app.quit(), 22000)
