import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    // node-pty is a native module: keep it external so it is required at
    // runtime from node_modules instead of being bundled.
    plugins: [externalizeDepsPlugin()],
    build: {
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
          ptyHost: 'src/main/ptyHost.js'
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
    plugins: [vue()]
  }
})
