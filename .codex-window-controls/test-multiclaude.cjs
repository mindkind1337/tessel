const { app, BrowserWindow, ipcMain, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const pty = require('node-pty')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ptys = new Map()
const output = new Map()
const resizeEvents = []
const exits = []
const errors = []
const ansiEscapePattern = new RegExp(String.raw`\x1b\[[0-9;?]*[A-Za-z]`, 'g')
const useConpty = process.env.TESSEL_USE_WINPTY !== '1'
let win

const resultPath = path.join(__dirname, 'test-result.txt')
const claudeCommand = process.env.CLAUDE_TEST_COMMAND || 'claude'

function writeResult(text) {
  try {
    fs.writeFileSync(resultPath, text)
  } catch {}
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function noteOutput(id, data) {
  const prev = output.get(id) || ''
  const next = (prev + data).slice(-6000)
  output.set(id, next)
}

function cleanupPtys() {
  for (const child of ptys.values()) {
    try {
      child.write('\x03')
      child.write('exit\r')
    } catch {}
    if (useConpty) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('error', () => {})
    } else {
      try {
        child.kill()
      } catch {}
    }
  }
  ptys.clear()
}

process.on('uncaughtException', (error) => {
  writeResult(`UNCAUGHT=${error.message}\n${error.stack || ''}`)
})
process.on('unhandledRejection', (error) => {
  writeResult(`UNHANDLED=${error && error.message}\n${(error && error.stack) || ''}`)
})

ipcMain.handle('shells:list', () => [{ id: 'powershell', name: 'Windows PowerShell' }])
ipcMain.handle('pty:create', (_event, { id, cols, rows, cwd }) => {
  try {
    const child = pty.spawn('powershell.exe', ['-NoLogo'], {
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd || __dirname,
      useConpty,
      env: process.env
    })
    child.onData((data) => {
      noteOutput(id, data)
      send('pty:data', { id, data })
    })
    child.onExit(({ exitCode, signal }) => {
      exits.push({ id, exitCode, signal })
      ptys.delete(id)
      send('pty:exit', { id, exitCode, signal })
    })
    ptys.set(id, child)
    return {
      ok: true,
      shell: { id: 'powershell', name: 'Windows PowerShell' },
      backend: useConpty ? 'conpty' : 'winpty',
      windowsBuild: Number(require('os').release().split('.')[2]),
      pid: child.pid
    }
  } catch (error) {
    return { ok: false, error: error.message }
  }
})
ipcMain.on('pty:write', (_event, { id, data }) => {
  const child = ptys.get(id)
  if (child) child.write(data)
})
ipcMain.on('pty:resize', (_event, { id, cols, rows }) => {
  resizeEvents.push({ id, cols, rows })
  const child = ptys.get(id)
  if (child) {
    try {
      child.resize(cols, rows)
    } catch (error) {
      errors.push(`resize:${id}:${error.message}`)
    }
  }
})
ipcMain.on('pty:kill', (_event, { id }) => {
  const child = ptys.get(id)
  if (child) {
    try {
      child.kill()
    } catch {}
    ptys.delete(id)
  }
})
ipcMain.handle('clipboard:read', () => clipboard.readText())
ipcMain.on('clipboard:write', (_event, text) => {
  if (typeof text === 'string' && text.length) clipboard.writeText(text)
})

const measureScript = `JSON.stringify((() => {
  return [...document.querySelectorAll('.pane')].map((pane, index) => {
    const host = pane.querySelector('.term-host')
    const screen = pane.querySelector('.xterm-screen')
    const viewport = pane.querySelector('.xterm-viewport')
    const hostRect = host.getBoundingClientRect()
    const screenRect = screen ? screen.getBoundingClientRect() : { width: -1, height: -1 }
    const viewportRect = viewport ? viewport.getBoundingClientRect() : { width: -1, height: -1 }
    return {
      index,
      hostW: Math.round(hostRect.width),
      hostH: Math.round(hostRect.height),
      screenW: Math.round(screenRect.width),
      screenH: Math.round(screenRect.height),
      viewportW: Math.round(viewportRect.width),
      overflowX: Math.round(screenRect.width - hostRect.width),
      overflowY: Math.round(screenRect.height - hostRect.height)
    }
  })
})())`

async function evaluate(js) {
  return win.webContents.executeJavaScript(js).catch((error) => {
    errors.push(`eval:${error.message}`)
    return null
  })
}

async function measure(label, measurements) {
  const raw = await evaluate(measureScript)
  measurements.push({ label, panes: raw ? JSON.parse(raw) : [] })
}

async function drag(selector, axis, pixels, steps = 24) {
  const ok = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const rect = el.getBoundingClientRect()
    window.__dragX = rect.x + rect.width / 2
    window.__dragY = rect.y + rect.height / 2
    el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: window.__dragX,
      clientY: window.__dragY
    }))
    return true
  })()`)
  if (!ok) return false

  for (let i = 1; i <= steps; i += 1) {
    const xDelta = axis === 'x' ? (pixels * i) / steps : 0
    const yDelta = axis === 'y' ? (pixels * i) / steps : 0
    await evaluate(`window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: window.__dragX + ${xDelta},
      clientY: window.__dragY + ${yDelta}
    }))`)
    await wait(20)
  }
  await evaluate("window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))")
  await wait(350)
  return true
}

function summarizeOutput() {
  return [...output.entries()].map(([id, text]) => ({
    id,
    sawClaude:
      /Claude Code|claude|Anthropic|login|permission|cwd|Do you trust|Welcome/i.test(text),
    sample: text.replace(ansiEscapePattern, '').replace(/\s+/g, ' ').slice(-240)
  }))
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    show: true,
    width: 1500,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'out/preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(`console:${message}`)
  })

  const measurements = []

  try {
    await win.loadFile(path.join(__dirname, 'out/renderer/index.html'))
    await wait(4500)
    await measure('initial-grid', measurements)

    for (const child of ptys.values()) child.write(`${claudeCommand}\r`)
    await wait(9000)
    await measure('claude-open', measurements)

    await win.setSize(980, 680)
    await wait(800)
    await measure('window-small', measurements)

    await drag('.divider.row', 'x', -220)
    await measure('drag-row-shrink', measurements)

    await drag('.divider.col', 'y', 160)
    await measure('drag-col-grow', measurements)

    await win.setSize(1700, 960)
    await wait(800)
    await measure('window-large', measurements)

    await drag('.divider.row', 'x', 260)
    await measure('drag-row-grow', measurements)

    const panes = measurements.flatMap((m) => m.panes.map((pane) => ({ ...pane, label: m.label })))
    const badPanes = panes.filter((pane) => pane.overflowX > 2 || pane.hostW < 40 || pane.hostH < 40)
    const resizeCounts = [...ptys.keys()].map((id) => ({
      id,
      count: resizeEvents.filter((event) => event.id === id).length,
      last: resizeEvents.filter((event) => event.id === id).slice(-1)[0] || null
    }))
    const tinyTerminals = resizeEvents.filter((event) => event.cols < 40 || event.rows < 10)

    writeResult(
      [
        `claude_command=${claudeCommand}`,
        `pane_count=${measurements[0] ? measurements[0].panes.length : 0}`,
        `pty_count=${ptys.size}`,
        `measurements=${JSON.stringify(measurements, null, 2)}`,
        `bad_panes=${JSON.stringify(badPanes, null, 2)}`,
        `tiny_terminals=${JSON.stringify(tinyTerminals, null, 2)}`,
        `resize_counts=${JSON.stringify(resizeCounts, null, 2)}`,
        `claude_outputs=${JSON.stringify(summarizeOutput(), null, 2)}`,
        `exits=${JSON.stringify(exits, null, 2)}`,
        `errors=${errors.join('|')}`,
        `pass=${
          badPanes.length === 0 &&
          tinyTerminals.length === 0 &&
          errors.length === 0 &&
          measurements.some((m) => m.panes.length >= 6)
        }`
      ].join('\n')
    )
  } catch (error) {
    writeResult(`THREW=${error.message}\n${error.stack || ''}\nerrors=${errors.join('|')}`)
  } finally {
    cleanupPtys()
    await wait(900)
    app.quit()
  }
})

setTimeout(() => {
  writeResult(`TIMEOUT\nerrors=${errors.join('|')}\noutputs=${JSON.stringify(summarizeOutput(), null, 2)}`)
  cleanupPtys()
  app.quit()
}, 45000)
