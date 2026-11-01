// Launcher that guarantees a GUI: some environments set ELECTRON_RUN_AS_NODE=1
// globally, which makes Electron boot as plain Node (no window). We strip it
// before spawning electron-vite so the app always launches as a desktop app.
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const mode = process.argv[2] || 'dev'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// --hidden: run in the background with no window at all (the dev server's
// messages go to a log file), and give the console back at once. It stops by
// itself when Tessel is closed.
if (process.argv.includes('--hidden')) {
  const logDir = path.join(process.env.APPDATA || process.env.HOME || '.', 'tessel-dev', 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  const logFile = path.join(logDir, 'dev-server.log')
  const out = fs.openSync(logFile, 'a')
  const self = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, [self, mode], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env,
    cwd: path.dirname(self)
  })
  child.unref()
  console.log(`Tessel ${mode} started in the background (no window). Its messages: ${logFile}`)
  process.exit(0)
}

// In dev the app does NOT restart by itself when its background code changes
// (src/main, src/preload, this file): a restart closes the window, cuts what an
// agent was doing and can cut SSH sessions, and every agent that merges into this
// folder would do it to you. The window reloads by itself for the renderer;
// for the rest a banner says "restart to apply" and you restart when it suits
// you. TESSEL_WATCH=1 brings electron-vite's --watch back (restart on every change).
const watch = mode === 'dev' && process.env.TESSEL_WATCH === '1'
const args = watch ? [mode, '--watch'] : [mode]
if (mode === 'dev' && !watch) console.log('Tessel dev: changes to the background code (src/main, src/preload) wait for you to restart; a banner says when. TESSEL_WATCH=1 restarts on every change.')

// Electron's program is downloaded by its own install step during
// `npm install`, which is sometimes skipped (a network hiccup, a proxy,
// --ignore-scripts): then electron-vite stops with "Electron uninstall".
// Fetch it here instead.
function ensureElectron() {
  let dir
  try {
    dir = path.dirname(createRequire(import.meta.url).resolve('electron/package.json'))
  } catch {
    return // not installed at all: npm install first
  }
  let ok = false
  try {
    const name = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim()
    ok = !!name && fs.existsSync(path.join(dir, 'dist', name))
  } catch {
    ok = false
  }
  if (ok) return
  console.log('Electron is missing (its download was skipped during npm install): downloading it now...')
  const r = spawnSync(process.execPath, [path.join(dir, 'install.js')], { stdio: 'inherit', env })
  if (r.status !== 0) {
    console.error('Could not download Electron. Check the internet connection, then run: node node_modules/electron/install.js')
    process.exit(1)
  }
}
ensureElectron()

// One command line for the shell (the arguments are fixed words): passing
// them separately with shell: true is deprecated in Node (DEP0190).
// The project's own programs (electron-vite) even when not run through npm
// (the background mode starts this file directly).
const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules', '.bin')
for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') env[k] = bin + path.delimiter + env[k]
const child = spawn(['electron-vite', ...args].join(' '), {
  stdio: 'inherit',
  env,
  shell: true,
  // No console window of its own (in the background mode there is none to share).
  windowsHide: true
})
child.on('exit', (code) => process.exit(code ?? 0))
