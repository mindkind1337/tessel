import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { execFileSync } from 'node:child_process'
import { askpassPlugin } from './scripts/build-askpass.mjs'
import { DEV_HOST, DEV_PORT, freeDevPort } from './scripts/devPort.mjs'

const config = {
  main: {
    // node-pty is a native module: keep it external so it is required at
    // runtime from node_modules instead of being bundled.
    // askpassPlugin: Tessel's SSH_ASKPASS helper (src/main/askpass), built
    // next to index.js as tessel-askpass.exe.
    plugins: [externalizeDepsPlugin(), askpassPlugin()],
    build: {
      // In dev (npm run dev), out/main is not emptied before a rebuild: the
      // running app's helper (tessel-askpass.exe --serve) is open there and
      // Windows refuses to delete it (EPERM), which failed every main
      // rebuild. A packaged build (npm run build) still starts clean.
      emptyOutDir: process.env.npm_lifecycle_event !== 'dev',
      rollupOptions: {
        // Never bundle Electron or native modules: they must be required at
        // runtime. (Setting rollupOptions replaces electron-vite's defaults,
        // and a bundled copy of the \`electron\` npm package tries to
        // "install" Electron by relaunching the app, in an endless loop.)
        // ssh2 (the SSH client of the terminal host, src/main/ssh): loaded
        // from node_modules at runtime (its optional native parts are tried
        // and skipped there), packaged by electron-builder as a dependency.
        // ws (Live Share's share server and guest connection,
        // src/main/liveShare): the same, its optional native helpers
        // (bufferutil, utf-8-validate) tried and skipped at runtime.
        external: ['electron', /^electron\/.+/, 'node-pty', 'electron-updater', 'ssh2', /^ssh2\/.+/, 'ws', /^ws\/.+/, /^node:/],
        // Two entry points: the app's main process, and the terminal host it
        // starts as a separate background process.
        input: {
          index: 'src/main/index.js',
          ptyHost: 'src/main/ptyHost.js',
          // Session search's own process (its index and indexing; started
          // only while the search is turned on).
          sessionSearchWorker: 'src/main/sessionSearch/worker.js',
          // The past conversations list's own process (sessionListClient.js:
          // started when the list is asked for, stopped when unused).
          sessionListWorker: 'src/main/sessionListWorker.js',
          // Settings > Context's token counting (contextCost/workerClient.js:
          // started when a count is asked for, stopped when unused).
          contextCostWorker: 'src/main/contextCost/worker.js',
          // The tessel command (Settings > General > Tessel CLI), run by
          // Tessel's executable as Node; self-contained, unpacked from the
          // app archive (package.json asarUnpack).
          cli: 'src/cli/main.js'
        },
        // Stay CommonJS (index.js / ptyHost.js), as with a single entry.
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Tessel's window, and the themed dialog's own window
        // (src/main/themedDialog.js: sandboxed, so one self-contained file).
        input: {
          index: 'src/preload/index.js',
          themedDialog: 'src/preload/themedDialog.js'
        },
        // As with a single entry: Electron required at runtime (never
        // bundled), CommonJS files named after their entry.
        external: ['electron', /^electron\/.+/],
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js'
        }
      }
    }
  },
  renderer: {
    plugins: [vue()],
    // Monaco's language workers (src/renderer/src/editor/monacoSetup.js) are
    // ES modules that import other chunks: bundled as ES workers.
    worker: {
      format: 'es'
    },
    // Dev: the app's modules are compiled when the server starts, not while
    // the window waits on a black page (a cold start took over 30 s). Paths
    // from the renderer's root (src/renderer): written from the project's
    // root they pointed nowhere and the warm-up never ran.
    server: {
      warmup: {
        clientFiles: ['./src/main.js', './src/App.vue', './src/components/**/*.vue']
      },
      // Its own address and port, checked free (scripts/devPort.mjs): another
      // dev server on "localhost:5173" never answers Tessel's window.
      host: DEV_HOST,
      port: DEV_PORT,
      strictPort: true
    }
  }
}

// The sub id an installed build carries (src/main/buildId.js): the commits it
// was made after, and the last one. A development Tessel asks git itself.
function bakedBuild() {
  try {
    const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim()
    const count = Number(git(['rev-list', '--count', 'HEAD']))
    const hash = git(['rev-parse', '--short=7', 'HEAD'])
    return Number.isInteger(count) && /^[0-9a-f]{7,40}$/.test(hash) ? { count, hash } : null
  } catch {
    return null
  }
}

export default defineConfig(async ({ command }) => {
  if (command === 'serve') config.renderer.server.port = await freeDevPort()
  config.main.define = { __TESSEL_BUILD__: JSON.stringify(command === 'build' ? bakedBuild() : null) }
  return config
})
