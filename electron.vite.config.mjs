import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { askpassPlugin } from './scripts/build-askpass.mjs'

export default defineConfig({
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
        external: ['electron', /^electron\/.+/, 'node-pty', 'electron-updater', /^node:/],
        // Two entry points: the app's main process, and the terminal host it
        // starts as a separate background process.
        input: {
          index: 'src/main/index.js',
          ptyHost: 'src/main/ptyHost.js',
          // Session search's own process (its index and indexing; started
          // only while the search is turned on).
          sessionSearchWorker: 'src/main/sessionSearch/worker.js',
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
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [vue()],
    // Monaco's language workers (src/renderer/src/editor/monacoSetup.js) are
    // ES modules that import other chunks: bundled as ES workers.
    worker: {
      format: 'es'
    },
    // Dev: the app's modules are compiled when the server starts, not while
    // the window waits on a black page (a cold start took over 30 s).
    server: {
      warmup: {
        clientFiles: ['./src/renderer/src/main.js', './src/renderer/src/App.vue', './src/renderer/src/components/**/*.vue']
      }
    }
  }
})
