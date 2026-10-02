// Launcher that guarantees a GUI: some environments set ELECTRON_RUN_AS_NODE=1
// globally, which makes Electron boot as plain Node (no window). We strip it
// before spawning electron-vite so the app always launches as a desktop app.
import { spawn } from 'child_process'

const mode = process.argv[2] || 'dev'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// In dev, --watch restarts the app when its background code changes. That is
// safe: terminals live in the terminal host (src/main/ptyHost.js), so shells
// and agents keep running and the window re-attaches to them.
const args = mode === 'dev' ? [mode, '--watch'] : [mode]

const child = spawn('electron-vite', args, {
  stdio: 'inherit',
  env,
  shell: true
})
child.on('exit', (code) => process.exit(code ?? 0))
