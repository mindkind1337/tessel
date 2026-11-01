// The site's demo: Tessel's real renderer (src/renderer/src/main.js, unchanged) built
// for a browser, with a simulated window.shellApi in place of the Electron preload.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { agentPresetsFrom } from './presets.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

// What Tessel's header shows: the same version and build as the app built from this
// commit (electron.vite.config.mjs does this for the desktop build).
function bakedBuild() {
  try {
    const git = (args) =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10000
      }).trim()
    const count = Number(git(['rev-list', '--count', 'HEAD']))
    const hash = git(['rev-parse', '--short=7', 'HEAD'])
    return Number.isInteger(count) && /^[0-9a-f]{7,40}$/.test(hash) ? { count, hash } : null
  } catch {
    return null
  }
}
const version = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')).version

// Tessel's own list of agents (src/main/index.js): one added there shows in the demo's
// launcher by itself.
function tesselAgents() {
  const id = 'virtual:tessel-agents'
  const resolved = `\0${id}`
  return {
    name: 'tessel-agents',
    resolveId: (source) => (source === id ? resolved : null),
    load(source) {
      if (source !== resolved) return null
      const list = agentPresetsFrom(readFileSync(resolve(repo, 'src/main/index.js'), 'utf8'))
      return `export default ${JSON.stringify(list)}`
    }
  }
}

export default defineConfig(async ({ command }) => {
  // Always a production build, whatever the shell says: a NODE_ENV of "development"
  // (a terminal opened from a development Tessel has one) gives a bigger build of Vue
  // that carries each component's absolute file path and the templates' comments. Set
  // before Vue's compiler is loaded: it chooses its own build when it is imported.
  if (command === 'build') process.env.NODE_ENV = 'production'
  const { default: vue } = await import('@vitejs/plugin-vue')
  return {
    root: here,
    // Relative, so the built folder works wherever it is served from (/demo/).
    base: './',
    plugins: [vue(), tesselAgents()],
    // Never Vite's default node_modules/.vite: node_modules can be shared with a running
    // copy of the app.
    cacheDir: process.env.TESSEL_DEMO_CACHE || resolve(here, '.vite'),
    define: {
      __DEMO_VERSION__: JSON.stringify(version),
      __DEMO_BUILD__: JSON.stringify(bakedBuild())
    },
    // Monaco's language workers are ES modules, as in the desktop build.
    worker: { format: 'es' },
    build: {
      outDir: resolve(repo, 'site/public/demo'),
      emptyOutDir: true,
      // No source maps: the demo ships nothing the page does not need.
      sourcemap: false,
      // Tessel's own code is one big chunk, as in the desktop build.
      chunkSizeWarningLimit: 12000,
      reportCompressedSize: false
    },
    server: {
      host: '127.0.0.1',
      port: 5318,
      strictPort: true,
      fs: { allow: [repo] }
    }
  }
})
